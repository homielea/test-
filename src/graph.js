// Business workflow runtime: an explicit, persisted state machine.
//
//   capture → validate → load_context → classify → draft → quality_review
//          → await_decision → save_result → create_handoff
//
// Quality failure loops back to draft (max MAX_REPAIRS repairs per attempt), then blocks with a
// pending decision. Step errors retry up to MAX_STEP_RETRIES, then the run fails.
// Every step result and transition is committed in ONE transaction, guarded by the worker's
// lease, so a crash between steps resumes at the right step and never completes twice.
import { randomUUID } from 'node:crypto';
import { ConflictError, ValidationError, nowIso } from './db.js';
import { reviewDraft } from './quality.js';
import { buildHandoffMarkdown } from './handoff.js';

export const GRAPH = [
  { id: 'capture', label: 'Capture' },
  { id: 'validate', label: 'Validate' },
  { id: 'load_context', label: 'Load business context' },
  { id: 'classify', label: 'Classify' },
  { id: 'draft', label: 'Draft brief & response' },
  { id: 'quality_review', label: 'Quality review' },
  { id: 'await_decision', label: 'Await Lea\'s decision' },
  { id: 'save_result', label: 'Save approved result' },
  { id: 'create_handoff', label: 'Create Maya handoff' },
];
export const MAX_REPAIRS = 2;
export const MAX_STEP_RETRIES = 2; // i.e. up to 3 tries per step execution
export const RUN_STATUSES = ['queued', 'running', 'needs_review', 'blocked', 'completed', 'failed'];

/** Errors that must not be retried: they need a human or a configuration change. */
export class BlockingError extends Error {
  constructor(code, msg) { super(msg); this.code = code; this.blocking = true; }
}
class LeaseLostError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- Step handlers ----------------
// Each handler: async (ctx) => { output, evidence, provenance, apply(scope, run) => runFields }
// `apply` runs inside the commit transaction and may write side-effect rows.

const STEPS = {
  async capture({ request }) {
    return {
      output: { request_id: request.id, title: request.title, characters: request.body.length, is_sample: request.is_sample, source: request.source },
      evidence: [{ type: 'request', id: request.id, created_at: request.created_at }],
      provenance: 'system',
      apply: () => ({ current_step: 'validate' }),
    };
  },

  async validate({ request }) {
    const errors = [];
    if (!request.title?.trim()) errors.push('Title is empty.');
    if ((request.body || '').trim().length < 20) errors.push('Inquiry text is shorter than 20 characters.');
    if (request.body.length > 20000) errors.push('Inquiry text exceeds 20,000 characters.');
    const valid = errors.length === 0;
    return {
      output: { valid, errors },
      evidence: [{ type: 'rule', detail: 'title present; 20 ≤ body length ≤ 20,000' }],
      provenance: 'system',
      apply: (scope, run) => {
        if (valid) return { current_step: 'load_context' };
        scope.log(run.id, 'run.failed', { step: 'validate', errors });
        return { status: 'failed', error: `Validation failed: ${errors.join(' ')}`, lease_owner: null, lease_expires_at: null };
      },
    };
  },

  async load_context({ business, request, run }) {
    // Defence in depth: the request must belong to the run's business.
    if (request.business_id !== run.business_id) throw new BlockingError('SCOPE', 'Request does not belong to this business.');
    const c = business.config;
    return {
      output: {
        business_id: business.id, name: business.name, tagline: c.tagline, region: c.region,
        policies: c.policies, capabilities: c.capabilities,
        categories: c.categories.map((x) => ({ id: x.id, label: x.label, required_fields: x.required.map((r) => r.label) })),
      },
      evidence: [{ type: 'business_config', id: business.id, detail: 'Loaded via business-scoped store; request.business_id matches run.business_id' }],
      provenance: 'system',
      apply: () => ({ current_step: 'classify' }),
    };
  },

  async classify(ctx) {
    const out = await ctx.adapter.classify(ctx);
    return {
      output: out,
      evidence: [{ type: 'classification_rationale', detail: out.rationale }],
      provenance: ctx.adapter.provenance,
      apply: () => ({ current_step: 'draft' }),
    };
  },

  async draft(ctx) {
    const { scope, run } = ctx;
    const classification = scope.latestSuccess(run.id, 'classify').output;
    let qualityIssues = [];
    if (run.repair_count > 0) {
      const prev = scope.successfulStep(run.id, 'quality_review', run.attempt, run.repair_count - 1);
      qualityIssues = prev?.output?.issues || [];
    }
    const draftNumber = scope.listDrafts(run.id).length + 1;
    const content = await ctx.adapter.draft({
      ...ctx, classification, feedback: run.attempt > 1 ? run.feedback : null,
      attempt: run.attempt, repair: run.repair_count, qualityIssues, draftNumber,
    });
    content.provenance = ctx.adapter.provenance;
    return {
      output: null, // filled in apply (draft id/version)
      evidence: (content.brief.known_facts || []).map((f) => ({ type: 'quote', field: f.field, detail: f.evidence })),
      provenance: ctx.adapter.provenance,
      apply: (sc, r, rec) => {
        const d = sc.insertDraft(r.id, { attempt: r.attempt, repair: r.repair_count, content, provenance: ctx.adapter.provenance });
        rec.output = { draft_id: d.id, version: d.version, attempt: r.attempt, repair: r.repair_count, missing: content.brief.missing_info.length, known: content.brief.known_facts.length };
        return { current_step: 'quality_review' };
      },
    };
  },

  async quality_review(ctx) {
    const { scope, run, business, request, otherBusinessNames } = ctx;
    const draft = scope.draftFor(run.id, run.attempt, run.repair_count);
    const rules = reviewDraft({ business, otherBusinessNames, request, draft: draft.content });
    const model = await ctx.adapter.review({ ...ctx, draft: draft.content, rules });
    const quality = { ...rules, model_notes: model?.notes || [], model_provenance: model?.provenance || ctx.adapter.provenance, draft_id: draft.id, version: draft.version };
    return {
      output: quality,
      evidence: rules.checks.map((c) => ({ type: 'check', id: c.id, passed: c.passed, detail: c.detail })),
      provenance: 'system+' + ctx.adapter.provenance,
      apply: (sc, r) => {
        sc.setDraftQuality(draft.id, quality);
        if (quality.passed) return { current_step: 'await_decision' };
        if (r.repair_count < MAX_REPAIRS) {
          sc.log(r.id, 'quality.repair', { repair: r.repair_count + 1, issues: rules.issues });
          return { current_step: 'draft', repair_count: r.repair_count + 1 };
        }
        sc.log(r.id, 'quality.exhausted', { attempt: r.attempt, issues: rules.issues });
        sc.openDecision({
          runId: r.id, kind: 'quality_exhausted', dedupeKey: `${r.id}:quality:${r.attempt}`,
          title: `Draft failed quality review ${MAX_REPAIRS + 1} times`,
          summary: `Attempt ${r.attempt} still fails: ${rules.issues.map((i) => i.id).join(', ')}. Automatic repairs stopped.`,
          recommendation: 'Request changes with specific guidance (creates a new attempt; earlier drafts are kept).',
          alternatives: ['Hold the run until more information is available.', 'Leave it blocked and handle the reply manually.'],
        });
        return { status: 'blocked', blocked_reason: 'quality_failed_after_repairs', lease_owner: null, lease_expires_at: null };
      },
    };
  },

  async await_decision({ scope, run }) {
    const draft = scope.draftFor(run.id, run.attempt, run.repair_count);
    return {
      output: { draft_id: draft.id, version: draft.version, waiting_for: 'Lea' },
      evidence: [{ type: 'pending_decision', detail: 'Persisted in decisions table; survives restart. Silence is not approval.' }],
      provenance: 'system',
      apply: (sc, r) => {
        sc.openDecision({
          runId: r.id, kind: 'review', dedupeKey: `${r.id}:review:${r.attempt}`,
          title: `Review draft v${draft.version}`,
          summary: `Draft v${draft.version} passed quality review and awaits approve / request changes / hold.`,
          recommendation: 'Read the draft and approve if accurate (approval saves it for Maya; nothing is sent).',
          alternatives: ['Request changes with notes (new attempt, history kept).', 'Hold until more information arrives.'],
        });
        sc.log(r.id, 'run.needs_review', { draft_id: draft.id, version: draft.version });
        return { status: 'needs_review', lease_owner: null, lease_expires_at: null };
      },
    };
  },

  async save_result({ scope, run }) {
    const draft = scope.getDraft(run.approved_draft_id);
    return {
      output: { draft_id: draft.id, version: draft.version },
      evidence: [{ type: 'approval', detail: `Approved draft id ${draft.id} (v${draft.version})` }],
      provenance: 'system',
      apply: (sc, r, rec) => {
        const { result, created } = sc.saveResult(r.id, draft);
        rec.output.result_id = result.id;
        rec.output.created = created;
        return { current_step: 'create_handoff' };
      },
    };
  },

  async create_handoff({ scope, run, business, request }) {
    const result = scope.getResult(run.id);
    const classification = scope.latestSuccess(run.id, 'classify').output;
    const reviews = scope.listReviews(run.id);
    const quality = scope.getDraft(result.draft_id).quality;
    const markdown = buildHandoffMarkdown({ business, request, run, classification, result, reviews, quality });
    return {
      output: { characters: markdown.length },
      evidence: [{ type: 'result', id: result.id, detail: `Built from saved result v${result.draft_version}` }],
      provenance: 'system',
      apply: (sc, r, rec) => {
        const { handoff, created } = sc.saveHandoff(r.id, markdown);
        rec.output.handoff_id = handoff.id;
        rec.output.created = created;
        sc.resolveDecisions(r.id, 'completed');
        sc.log(r.id, 'run.completed', { result_id: result.id });
        return { status: 'completed', current_step: 'done', lease_owner: null, lease_expires_at: null };
      },
    };
  },
};

// ---------------- Engine ----------------

export class WorkflowEngine {
  constructor({ store, adapter, owner, leaseMs = 15000, stepDelayMs = 0, retryDelayMs = 50 }) {
    this.store = store;
    this.adapter = adapter;
    this.owner = owner || `worker:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.leaseMs = leaseMs;
    this.stepDelayMs = stepDelayMs;
    this.retryDelayMs = retryDelayMs;
    this.stopping = false;
    this.loop = null;
  }

  /** Start-up reconciliation: requeue runs whose worker is gone (dead pid on this host, or expired lease). */
  reconcile() {
    const db = this.store.db;
    const orphans = db.prepare("SELECT id, business_id, lease_owner FROM runs WHERE status = 'running'").all();
    const requeued = [];
    for (const r of orphans) {
      const pid = Number((r.lease_owner || '').split(':')[1]);
      let alive = false;
      if (pid && pid !== process.pid) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
      if (r.lease_owner === this.owner) alive = true;
      if (!alive) {
        db.prepare("UPDATE runs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'running'").run(nowIso(), r.id);
        this.store.logEvent(r.business_id, r.id, 'run.recovered', { previous_owner: r.lease_owner });
        requeued.push(r.id);
      }
    }
    requeued.push(...this.store.recoverExpiredLeases().map((r) => r.id));
    return requeued;
  }

  /** Claim and execute one run until it leaves 'running'. Returns the run id or null. */
  async processOne() {
    if (this.stopping) return null;
    const claim = this.store.claimNextRun(this.owner, this.leaseMs);
    if (!claim) return null;
    await this.executeRun(claim.business_id, claim.id);
    return claim.id;
  }

  async runUntilIdle(max = 100) {
    let n = 0;
    while (n < max && (await this.processOne())) n++;
    return n;
  }

  start(pollMs = 300) {
    this.stopping = false;
    const tick = async () => {
      if (this.stopping) return;
      try { while (!this.stopping && (await this.processOne())); } catch (e) { console.error('[engine]', e); }
      if (!this.stopping) this.loop = setTimeout(tick, pollMs);
    };
    this.loop = setTimeout(tick, 0);
  }

  /** Stop cleanly: finish/abandon the current step, release leases so work resumes later. */
  async stop() {
    this.stopping = true;
    clearTimeout(this.loop);
    while (this.current) await sleep(20);
    return this.store.releaseLeases(this.owner);
  }

  async executeRun(businessId, runId) {
    const scope = this.store.forBusiness(businessId);
    const business = scope.business();
    const otherBusinessNames = this.store.listBusinesses().filter((b) => b.id !== businessId).map((b) => b.name);
    this.current = runId;
    try {
      for (;;) {
        const run = scope.getRun(runId);
        if (run.status !== 'running' || run.lease_owner !== this.owner) return;
        if (this.stopping) { this.store.releaseLeases(this.owner); return; }
        const handler = STEPS[run.current_step];
        if (!handler) throw new Error(`Unknown step ${run.current_step}`);
        const request = scope.getRequest(run.request_id);
        if (this.stepDelayMs) await sleep(this.stepDelayMs);
        const ctx = { scope, store: this.store, run, business: { id: business.id, name: business.name, ...business.config, config: business.config }, request, adapter: this.adapter, faults: run.options?.faults, otherBusinessNames, runId };
        const startedAt = nowIso();
        let rec;
        try {
          rec = await handler(ctx);
        } catch (err) {
          this.recordFailure(scope, run, err, startedAt);
          if (err.blocking) return;
          await sleep(this.retryDelayMs);
          continue;
        }
        this.commit(scope, run, rec, startedAt);
      }
    } catch (e) {
      if (!(e instanceof LeaseLostError)) throw e;
    } finally {
      this.current = null;
    }
  }

  commit(scope, run, rec, startedAt) {
    scope.tx(() => {
      const fresh = scope.getRun(run.id);
      if (fresh.lease_owner !== this.owner || fresh.status !== 'running' || fresh.current_step !== run.current_step) throw new LeaseLostError();
      rec.output = rec.output ?? {};
      const fields = rec.apply(scope, fresh, rec);
      scope.recordStep(run.id, { step: run.current_step, attempt: run.attempt, repair: run.repair_count, status: 'succeeded', output: rec.output, evidence: rec.evidence, provenance: rec.provenance, startedAt });
      const keepLease = (fields.status ?? 'running') === 'running';
      const ok = scope.updateRun(run.id, { step_failures: 0, ...(keepLease ? { lease_expires_at: Date.now() + this.leaseMs } : {}), ...fields }, { leaseOwner: this.owner, statusIn: ['running'] });
      if (!ok) throw new LeaseLostError();
      scope.log(run.id, 'step.succeeded', { step: run.current_step, attempt: run.attempt, repair: run.repair_count, next: fields.current_step || fields.status });
    });
  }

  recordFailure(scope, run, err, startedAt) {
    scope.tx(() => {
      const fresh = scope.getRun(run.id);
      if (fresh.lease_owner !== this.owner) throw new LeaseLostError();
      scope.recordStep(run.id, { step: run.current_step, attempt: run.attempt, repair: run.repair_count, status: 'failed', output: null, evidence: [{ type: 'error', detail: err.message }], error: err.message, provenance: this.adapter.provenance, startedAt });
      const failures = fresh.step_failures + 1;
      scope.log(run.id, 'step.failed', { step: run.current_step, error: err.message, failures, code: err.code });
      if (err.blocking) {
        scope.openDecision({
          runId: run.id, kind: 'blocked', dedupeKey: `${run.id}:blocked:${run.current_step}:${err.code}`,
          title: `Blocked at ${run.current_step}: ${err.code}`, summary: err.message,
          recommendation: err.code === 'CREDENTIALS' || err.code === 'BUDGET' ? 'Keep using the mock adapter until credentials and a budget are explicitly configured.' : 'Investigate and requeue.',
          alternatives: ['Leave blocked.'],
        });
        scope.updateRun(run.id, { status: 'blocked', blocked_reason: `${err.code}: ${err.message}`, step_failures: failures, lease_owner: null, lease_expires_at: null }, { leaseOwner: this.owner });
      } else if (failures > MAX_STEP_RETRIES) {
        scope.log(run.id, 'run.failed', { step: run.current_step, reason: 'retry limit reached', failures });
        scope.updateRun(run.id, { status: 'failed', error: `Step ${run.current_step} failed ${failures} times (retry limit ${MAX_STEP_RETRIES}): ${err.message}`, step_failures: failures, lease_owner: null, lease_expires_at: null }, { leaseOwner: this.owner });
      } else {
        scope.updateRun(run.id, { step_failures: failures, lease_expires_at: Date.now() + this.leaseMs }, { leaseOwner: this.owner });
      }
    });
  }
}

// ---------------- Intake & review (called by the API) ----------------

export function submitRequest(store, businessId, { title, body, contact, isSample, sampleKey, options }, adapter) {
  const scope = store.forBusiness(businessId);
  if (!title?.trim() || !body?.trim()) throw new ValidationError('Title and inquiry text are required.');
  return scope.tx(() => {
    const req = scope.createRequest({ title: title.trim(), body, contact, isSample, sampleKey });
    return scope.createRun(req.id, { adapter: adapter.name, options });
  });
}

const REVIEWABLE = ['needs_review', 'blocked'];

export function reviewRun(store, businessId, runId, { action, notes, decidedBy = 'Lea' }) {
  const scope = store.forBusiness(businessId);
  const run = scope.getRun(runId);
  if (!['approve', 'request_changes', 'hold'].includes(action)) throw new ValidationError(`Unknown action ${action}`);
  const reviewableBlock = run.status === 'blocked' && ['held_by_reviewer', 'quality_failed_after_repairs'].includes(run.blocked_reason);
  if (run.status !== 'needs_review' && !reviewableBlock) throw new ConflictError(`Run is ${run.status}${run.blocked_reason ? ` (${run.blocked_reason})` : ''}; no decision is pending.`);
  const draft = scope.latestDraft(runId);

  return scope.tx(() => {
    let ok;
    if (action === 'approve') {
      if (!draft?.quality?.passed) throw new ConflictError('This draft did not pass quality review. Request changes instead.');
      ok = scope.updateRun(runId, { status: 'queued', current_step: 'save_result', approved_draft_id: draft.id, blocked_reason: null }, { statusIn: REVIEWABLE });
    } else if (action === 'request_changes') {
      if (!notes?.trim()) throw new ValidationError('Please describe the changes you want.');
      ok = scope.updateRun(runId, { status: 'queued', current_step: 'draft', attempt: run.attempt + 1, repair_count: 0, feedback: notes.trim(), blocked_reason: null, step_failures: 0 }, { statusIn: REVIEWABLE });
    } else {
      if (run.status !== 'needs_review') throw new ConflictError('Only a run awaiting review can be put on hold.');
      ok = scope.updateRun(runId, { status: 'blocked', blocked_reason: 'held_by_reviewer' }, { statusIn: ['needs_review'] });
    }
    if (!ok) throw new ConflictError('The run changed while deciding; reload and try again.');
    scope.insertReview(runId, { draftId: draft?.id || null, action, notes, decidedBy });
    if (action !== 'hold') scope.resolveDecisions(runId, action);
    scope.log(runId, `review.${action}`, { draft_id: draft?.id, version: draft?.version, notes: notes || null, by: decidedBy });
    return scope.getRun(runId);
  });
}

/** Everything the run-detail view needs, read through the business scope. */
export function runDetail(store, businessId, runId) {
  const scope = store.forBusiness(businessId);
  const run = scope.getRun(runId);
  return {
    run,
    request: scope.getRequest(run.request_id),
    graph: GRAPH,
    steps: scope.listSteps(runId),
    drafts: scope.listDrafts(runId),
    reviews: scope.listReviews(runId),
    decisions: scope.listDecisions({ status: null, runId }),
    result: scope.getResult(runId),
    handoff: scope.getHandoff(runId),
    events: scope.listEvents(runId),
  };
}
