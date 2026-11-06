// Persistence for the business workflow runtime.
// Store: SQLite via Node's built-in `node:sqlite` (single local file, no server, no extra dependency).
//
// Business separation is enforced HERE, not in the UI: every business-owned table carries
// `business_id`, and the only way to read or write those rows is through `forBusiness(id)`,
// whose queries always filter on that id. A record id from another business behaves exactly
// like a missing record (and the attempt is logged as an event).
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class NotFoundError extends Error {
  constructor(msg) { super(msg); this.code = 'NOT_FOUND'; this.status = 404; }
}
export class ConflictError extends Error {
  constructor(msg) { super(msg); this.code = 'CONFLICT'; this.status = 409; }
}
export class ValidationError extends Error {
  constructor(msg) { super(msg); this.code = 'INVALID'; this.status = 400; }
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  contact_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'dashboard',
  is_sample INTEGER NOT NULL DEFAULT 0,
  sample_key TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  request_id TEXT NOT NULL REFERENCES requests(id),
  status TEXT NOT NULL CHECK (status IN ('queued','running','needs_review','blocked','completed','failed')),
  current_step TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  repair_count INTEGER NOT NULL DEFAULT 0,
  step_failures INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  error TEXT,
  feedback TEXT,
  approved_draft_id TEXT,
  adapter TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '{}',
  lease_owner TEXT,
  lease_expires_at INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_by_business ON runs(business_id, status);

CREATE TABLE IF NOT EXISTS step_results (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  step TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  repair INTEGER NOT NULL,
  try INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded','failed')),
  output_json TEXT,
  evidence_json TEXT,
  error TEXT,
  provenance TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  UNIQUE (run_id, step, attempt, repair, try)
);
-- At most one success per step execution key: this is what makes resume idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS one_success_per_step
  ON step_results(run_id, step, attempt, repair) WHERE status = 'succeeded';

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  attempt INTEGER NOT NULL,
  repair INTEGER NOT NULL,
  version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  quality_json TEXT,
  provenance TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, attempt, repair),
  UNIQUE (run_id, version)
);

CREATE TABLE IF NOT EXISTS review_decisions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  draft_id TEXT REFERENCES drafts(id),
  action TEXT NOT NULL CHECK (action IN ('approve','request_changes','hold')),
  notes TEXT,
  decided_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  run_id TEXT REFERENCES runs(id),
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','resolved')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  recommendation TEXT,
  alternatives_json TEXT NOT NULL DEFAULT '[]',
  resolution TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  draft_version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  markdown TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT,
  run_id TEXT,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_run ON events(run_id, seq);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  markdown TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export const nowIso = () => new Date().toISOString();
const j = (v) => JSON.stringify(v ?? null);
const pj = (s, d = null) => (s == null ? d : JSON.parse(s));

export function openDb(file = process.env.LAB_DB || 'data/lab.db') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return new LabStore(db, file);
}

function hydrateRun(r) {
  if (!r) return r;
  return { ...r, options: pj(r.options_json, {}) };
}
function hydrateStep(s) {
  return { ...s, output: pj(s.output_json), evidence: pj(s.evidence_json, []) };
}
function hydrateDraft(d) {
  if (!d) return d;
  return { ...d, content: pj(d.content_json), quality: pj(d.quality_json) };
}
function hydrateDecision(d) {
  return { ...d, alternatives: pj(d.alternatives_json, []) };
}

export class LabStore {
  constructor(db, file) {
    this.db = db;
    this.file = file;
  }

  close() { this.db.close(); }

  /** Run fn inside one write transaction (BEGIN IMMEDIATE). */
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  }

  // ---- System-level (portfolio) operations: no business data is returned except ids/status ----

  upsertBusiness(b) {
    this.db.prepare(`INSERT INTO businesses (id, name, config_json, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, config_json = excluded.config_json`)
      .run(b.id, b.name, j(b), nowIso());
  }

  listBusinesses() {
    return this.db.prepare('SELECT id, name, config_json FROM businesses ORDER BY created_at, id').all()
      .map((r) => ({ id: r.id, name: r.name, config: pj(r.config_json) }));
  }

  hasBusiness(id) {
    return !!this.db.prepare('SELECT 1 FROM businesses WHERE id = ?').get(id);
  }

  logEvent(businessId, runId, type, data = {}) {
    this.db.prepare('INSERT INTO events (business_id, run_id, type, data_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(businessId, runId, type, j(data), nowIso());
  }

  /**
   * Claim one runnable run for a worker. Returns only {id, business_id}; the worker must then
   * use forBusiness(business_id) for everything else. Expired leases on 'running' runs are
   * reclaimable — that is the crash-recovery path.
   */
  claimNextRun(owner, leaseMs) {
    const now = Date.now();
    const row = this.db.prepare(`UPDATE runs SET status = 'running', lease_owner = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = (
        SELECT id FROM runs
        WHERE status = 'queued' OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < ?))
        ORDER BY created_at LIMIT 1)
      RETURNING id, business_id`).get(owner, now + leaseMs, nowIso(), now);
    return row || null;
  }

  /** On startup: runs left 'running' with an expired lease go back to 'queued'. */
  recoverExpiredLeases() {
    const now = Date.now();
    const rows = this.db.prepare(`UPDATE runs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < ?)
      RETURNING id, business_id, current_step`).all(nowIso(), now);
    for (const r of rows) this.logEvent(r.business_id, r.id, 'run.recovered', { resumed_at_step: r.current_step });
    return rows;
  }

  /** Release all leases held by an owner (clean stop). Running runs return to queued. */
  releaseLeases(owner) {
    const rows = this.db.prepare(`UPDATE runs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE status = 'running' AND lease_owner = ? RETURNING id, business_id, current_step`).all(nowIso(), owner);
    for (const r of rows) this.logEvent(r.business_id, r.id, 'run.released', { at_step: r.current_step, owner });
    return rows;
  }

  countsByStatus() {
    return this.db.prepare('SELECT business_id, status, COUNT(*) n FROM runs GROUP BY business_id, status').all();
  }

  saveCheckpoint(kind, markdown, data) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO checkpoints (id, kind, markdown, data_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, kind, markdown, j(data), nowIso());
    return id;
  }

  latestCheckpoint(kind) {
    const r = this.db.prepare('SELECT * FROM checkpoints WHERE kind = ? ORDER BY created_at DESC LIMIT 1').get(kind);
    return r ? { ...r, data: pj(r.data_json) } : null;
  }

  // ---- Business-scoped access ----

  forBusiness(businessId) {
    if (!this.hasBusiness(businessId)) throw new NotFoundError(`Unknown business: ${businessId}`);
    return new BusinessScope(this, businessId);
  }
}

export class BusinessScope {
  constructor(store, businessId) {
    this.store = store;
    this.db = store.db;
    this.businessId = businessId;
  }

  tx(fn) { return this.store.tx(fn); }
  log(runId, type, data) { this.store.logEvent(this.businessId, runId, type, data); }

  business() {
    const r = this.db.prepare('SELECT id, name, config_json FROM businesses WHERE id = ?').get(this.businessId);
    return { id: r.id, name: r.name, config: pj(r.config_json) };
  }

  _denied(kind, id) {
    // Log cross-business or unknown-id access attempts without revealing the other record.
    this.store.logEvent(this.businessId, null, 'access.denied', { kind, id });
    return new NotFoundError(`${kind} ${id} not found in business ${this.businessId}`);
  }

  // Requests
  createRequest({ title, body, contact = {}, source = 'dashboard', isSample = false, sampleKey = null }) {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO requests (id, business_id, title, body, contact_json, source, is_sample, sample_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, this.businessId, title, body, j(contact), source, isSample ? 1 : 0, sampleKey, nowIso());
    return this.getRequest(id);
  }

  getRequest(id) {
    const r = this.db.prepare('SELECT * FROM requests WHERE id = ? AND business_id = ?').get(id, this.businessId);
    if (!r) throw this._denied('request', id);
    return { ...r, contact: pj(r.contact_json, {}), is_sample: !!r.is_sample };
  }

  // Runs
  createRun(requestId, { adapter, options = {} }) {
    this.getRequest(requestId); // enforces same-business request
    const id = randomUUID();
    const t = nowIso();
    this.db.prepare(`INSERT INTO runs (id, business_id, request_id, status, current_step, adapter, options_json, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', 'capture', ?, ?, ?, ?)`).run(id, this.businessId, requestId, adapter, j(options), t, t);
    this.log(id, 'run.created', { request_id: requestId, adapter });
    return this.getRun(id);
  }

  getRun(id) {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ? AND business_id = ?').get(id, this.businessId);
    if (!r) throw this._denied('run', id);
    return hydrateRun(r);
  }

  listRuns({ status } = {}) {
    const sql = `SELECT r.*, q.title AS request_title, q.is_sample AS request_is_sample FROM runs r
      JOIN requests q ON q.id = r.request_id AND q.business_id = r.business_id
      WHERE r.business_id = ? ${status ? 'AND r.status = ?' : ''} ORDER BY r.created_at DESC`;
    const args = status ? [this.businessId, status] : [this.businessId];
    return this.db.prepare(sql).all(...args).map(hydrateRun);
  }

  /**
   * Conditional update of a run. `where` may require a status set and/or lease owner; returns
   * false when the condition no longer holds (lost lease, concurrent decision, etc.).
   */
  updateRun(id, fields, { statusIn, leaseOwner } = {}) {
    const keys = Object.keys(fields);
    const sets = keys.map((k) => `${k} = ?`).concat('updated_at = ?').join(', ');
    let sql = `UPDATE runs SET ${sets} WHERE id = ? AND business_id = ?`;
    const args = keys.map((k) => fields[k]).concat(nowIso(), id, this.businessId);
    if (statusIn) { sql += ` AND status IN (${statusIn.map(() => '?').join(',')})`; args.push(...statusIn); }
    if (leaseOwner) { sql += ' AND lease_owner = ?'; args.push(leaseOwner); }
    return this.db.prepare(sql).run(...args).changes === 1;
  }

  // Step results
  successfulStep(runId, step, attempt, repair) {
    const r = this.db.prepare(`SELECT * FROM step_results WHERE business_id = ? AND run_id = ? AND step = ? AND attempt = ? AND repair = ? AND status = 'succeeded'`)
      .get(this.businessId, runId, step, attempt, repair);
    return r ? hydrateStep(r) : null;
  }

  latestSuccess(runId, step) {
    const r = this.db.prepare(`SELECT * FROM step_results WHERE business_id = ? AND run_id = ? AND step = ? AND status = 'succeeded'
      ORDER BY attempt DESC, repair DESC LIMIT 1`).get(this.businessId, runId, step);
    return r ? hydrateStep(r) : null;
  }

  recordStep(runId, { step, attempt, repair, status, output, evidence, error, provenance, startedAt }) {
    const tries = this.db.prepare('SELECT COUNT(*) n FROM step_results WHERE business_id = ? AND run_id = ? AND step = ? AND attempt = ? AND repair = ?')
      .get(this.businessId, runId, step, attempt, repair).n;
    const id = randomUUID();
    this.db.prepare(`INSERT INTO step_results (id, business_id, run_id, step, attempt, repair, try, status, output_json, evidence_json, error, provenance, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, this.businessId, runId, step, attempt, repair, tries + 1, status,
      j(output), j(evidence || []), error || null, provenance, startedAt, nowIso());
    return id;
  }

  listSteps(runId) {
    this.getRun(runId);
    return this.db.prepare('SELECT * FROM step_results WHERE business_id = ? AND run_id = ? ORDER BY started_at, try')
      .all(this.businessId, runId).map(hydrateStep);
  }

  // Drafts
  insertDraft(runId, { attempt, repair, content, provenance }) {
    const existing = this.db.prepare('SELECT * FROM drafts WHERE business_id = ? AND run_id = ? AND attempt = ? AND repair = ?')
      .get(this.businessId, runId, attempt, repair);
    if (existing) return hydrateDraft(existing);
    const version = this.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 v FROM drafts WHERE run_id = ?').get(runId).v;
    const id = randomUUID();
    this.db.prepare(`INSERT INTO drafts (id, business_id, run_id, attempt, repair, version, content_json, provenance, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, this.businessId, runId, attempt, repair, version, j(content), provenance, nowIso());
    return this.getDraft(id);
  }

  setDraftQuality(draftId, quality) {
    this.db.prepare('UPDATE drafts SET quality_json = ? WHERE id = ? AND business_id = ?').run(j(quality), draftId, this.businessId);
  }

  getDraft(id) {
    const r = this.db.prepare('SELECT * FROM drafts WHERE id = ? AND business_id = ?').get(id, this.businessId);
    if (!r) throw this._denied('draft', id);
    return hydrateDraft(r);
  }

  draftFor(runId, attempt, repair) {
    return hydrateDraft(this.db.prepare('SELECT * FROM drafts WHERE business_id = ? AND run_id = ? AND attempt = ? AND repair = ?')
      .get(this.businessId, runId, attempt, repair));
  }

  latestDraft(runId) {
    return hydrateDraft(this.db.prepare('SELECT * FROM drafts WHERE business_id = ? AND run_id = ? ORDER BY version DESC LIMIT 1')
      .get(this.businessId, runId));
  }

  listDrafts(runId) {
    return this.db.prepare('SELECT * FROM drafts WHERE business_id = ? AND run_id = ? ORDER BY version')
      .all(this.businessId, runId).map(hydrateDraft);
  }

  // Reviews
  insertReview(runId, { draftId, action, notes, decidedBy }) {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO review_decisions (id, business_id, run_id, draft_id, action, notes, decided_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, this.businessId, runId, draftId, action, notes || null, decidedBy, nowIso());
    return id;
  }

  listReviews(runId) {
    return this.db.prepare('SELECT * FROM review_decisions WHERE business_id = ? AND run_id = ? ORDER BY created_at')
      .all(this.businessId, runId);
  }

  // Pending decisions (persisted, never inferred from silence)
  openDecision({ runId = null, kind, dedupeKey, title, summary, recommendation, alternatives = [] }) {
    this.db.prepare(`INSERT INTO decisions (id, business_id, run_id, kind, dedupe_key, status, title, summary, recommendation, alternatives_json, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`)
      .run(randomUUID(), this.businessId, runId, kind, dedupeKey, title, summary, recommendation || null, j(alternatives), nowIso());
  }

  resolveDecisions(runId, resolution) {
    this.db.prepare(`UPDATE decisions SET status = 'resolved', resolution = ?, resolved_at = ?
      WHERE business_id = ? AND run_id = ? AND status = 'pending'`).run(resolution, nowIso(), this.businessId, runId);
  }

  listDecisions({ status = 'pending', runId } = {}) {
    let sql = 'SELECT * FROM decisions WHERE business_id = ?';
    const args = [this.businessId];
    if (status) { sql += ' AND status = ?'; args.push(status); }
    if (runId) { sql += ' AND run_id = ?'; args.push(runId); }
    return this.db.prepare(sql + ' ORDER BY created_at').all(...args).map(hydrateDecision);
  }

  // Results + handoffs (UNIQUE run_id => duplicate completion is impossible)
  saveResult(runId, draft) {
    const existing = this.getResult(runId);
    if (existing) return { result: existing, created: false };
    this.db.prepare(`INSERT INTO results (id, business_id, run_id, draft_id, draft_version, content_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), this.businessId, runId, draft.id, draft.version, j(draft.content), nowIso());
    return { result: this.getResult(runId), created: true };
  }

  getResult(runId) {
    const r = this.db.prepare('SELECT * FROM results WHERE business_id = ? AND run_id = ?').get(this.businessId, runId);
    return r ? { ...r, content: pj(r.content_json) } : null;
  }

  saveHandoff(runId, markdown) {
    const existing = this.getHandoff(runId);
    if (existing) return { handoff: existing, created: false };
    this.db.prepare('INSERT INTO handoffs (id, business_id, run_id, markdown, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), this.businessId, runId, markdown, nowIso());
    return { handoff: this.getHandoff(runId), created: true };
  }

  getHandoff(runId) {
    return this.db.prepare('SELECT * FROM handoffs WHERE business_id = ? AND run_id = ?').get(this.businessId, runId) || null;
  }

  listEvents(runId) {
    return this.db.prepare('SELECT * FROM events WHERE business_id = ? AND run_id = ? ORDER BY seq')
      .all(this.businessId, runId).map((e) => ({ ...e, data: pj(e.data_json, {}) }));
  }

  countRunsByStatus() {
    const out = { queued: 0, running: 0, needs_review: 0, blocked: 0, completed: 0, failed: 0 };
    for (const r of this.db.prepare('SELECT status, COUNT(*) n FROM runs WHERE business_id = ? GROUP BY status').all(this.businessId)) out[r.status] = r.n;
    return out;
  }
}
