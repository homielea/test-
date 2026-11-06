// Four-hour checkpoint for the business runtime: a portfolio-level summary built by reading each
// business through its own scope. Saved to the DB (checkpoints table) and to checkpoints/*.md.
// It never claims a notification was delivered: no notification channel is configured.
import fs from 'node:fs';
import path from 'node:path';

const PRIORITY = { quality_exhausted: 0, review: 1, blocked: 2 };

export function buildAppCheckpoint(store, { adapterStatus, realStatus, port = 4317 } = {}) {
  const businesses = store.listBusinesses();
  const perBusiness = [];
  const pending = [];
  for (const b of businesses) {
    const scope = store.forBusiness(b.id);
    const counts = scope.countRunsByStatus();
    const runs = scope.listRuns();
    const decisions = scope.listDecisions();
    perBusiness.push({ id: b.id, name: b.name, counts, total: runs.length });
    for (const d of decisions) {
      const run = runs.find((r) => r.id === d.run_id);
      pending.push({ ...d, business_name: b.name, request_title: run?.request_title, run_status: run?.status });
    }
  }
  pending.sort((a, b) => (PRIORITY[a.kind] ?? 9) - (PRIORITY[b.kind] ?? 9) || a.created_at.localeCompare(b.created_at));

  let decision;
  if (pending.length) {
    const top = pending[0];
    const cmd = top.kind === 'review' || top.kind === 'quality_exhausted';
    decision = {
      title: `${top.business_name}: ${top.title} — "${top.request_title}"`,
      why: top.summary,
      recommendation: top.recommendation,
      alternatives: top.alternatives,
      resume_instructions: cmd ? [
        `Dashboard: http://127.0.0.1:${port}/#/${top.business_id}/runs/${top.run_id} → choose Approve, Request changes or Hold.`,
        `CLI approve: npm run lab -- review ${top.business_id} ${top.run_id} approve`,
        `CLI request changes: npm run lab -- review ${top.business_id} ${top.run_id} request_changes "<your notes>"`,
        `CLI hold: npm run lab -- review ${top.business_id} ${top.run_id} hold "<reason>"`,
      ] : ['Inspect the run in the dashboard; requeueing requires fixing the blocking cause first.'],
      decision_id: top.id,
    };
  } else if (!realStatus?.available) {
    decision = {
      title: 'Authorise (or keep disabled) the real-model path for business drafts',
      why: `Real model is disabled: ${realStatus?.missing?.join('; ')}. All drafts are simulated by the mock adapter.`,
      recommendation: 'Keep mock mode until the three NATEA drafts read well; then set an explicit small budget.',
      alternatives: ['Set LAB_ADAPTER=anthropic, an existing ANTHROPIC_API_KEY and LAB_MAX_BUDGET_USD (e.g. 2) and restart.', 'Stay in mock mode indefinitely.'],
      resume_instructions: ['LAB_ADAPTER=anthropic LAB_MAX_BUDGET_USD=<amount> npm start   (ANTHROPIC_API_KEY must already be in your environment)'],
    };
  } else {
    decision = { title: 'No decision pending', why: 'Queue is clear.', recommendation: 'None.', alternatives: [], resume_instructions: [] };
  }

  const blocked = pending.filter((p) => p.kind !== 'review');
  const totalCompleted = perBusiness.reduce((s, b) => s + b.counts.completed, 0);
  const data = {
    generated_at: new Date().toISOString(),
    adapter: adapterStatus,
    real_model: realStatus,
    businesses: perBusiness,
    pending_decisions: pending.map((p) => ({ id: p.id, business: p.business_name, kind: p.kind, title: p.title, request: p.request_title, run_id: p.run_id, created_at: p.created_at })),
    recommended_decision: decision,
    works: [
      `Inquiry → validate → context → classify → draft → quality review → decision → save → handoff (${totalCompleted} run(s) completed).`,
      'Approve / request changes / hold with full draft history.',
      'Business-scoped data access; restart recovery; bounded repairs and retries.',
    ],
    blocked: blocked.map((p) => `${p.business_name}: ${p.title} — ${p.summary}`),
    can_proceed_without_answer: [
      'New inquiries can be submitted and drafted in every business (mock adapter).',
      'Runs not waiting on a decision continue automatically.',
      'Coding supervisor tasks that do not depend on these decisions.',
    ],
    notification: 'No notification channel is configured. This checkpoint was saved locally only; nobody was notified.',
  };
  return { data, markdown: renderMarkdown(data) };
}

export function renderMarkdown(d) {
  const L = [];
  L.push(`# Business runtime checkpoint — ${d.generated_at}`, '');
  L.push(`> ${d.notification}`, '');
  L.push(`**Adapter:** ${d.adapter?.label || d.adapter?.mode}  `);
  L.push(`**Real model:** ${d.real_model?.available ? `enabled (${d.real_model.model}, budget $${d.real_model.budget_usd})` : `disabled — ${(d.real_model?.missing || []).join('; ')}`}`, '');
  L.push('## Queue by business', '', '| Business | queued | running | needs review | blocked | completed | failed |', '|---|---|---|---|---|---|---|');
  for (const b of d.businesses) L.push(`| ${b.name} | ${b.counts.queued} | ${b.counts.running} | ${b.counts.needs_review} | ${b.counts.blocked} | ${b.counts.completed} | ${b.counts.failed} |`);
  L.push('', '## What works', '', ...d.works.map((w) => `- ${w}`));
  L.push('', '## Blocked', '', ...(d.blocked.length ? d.blocked.map((b) => `- ${b}`) : ['- Nothing blocked.']));
  const r = d.recommended_decision;
  L.push('', '## The one decision', '', `**${r.title}**`, '', r.why, '', `**Recommendation:** ${r.recommendation}`, '');
  if (r.alternatives.length) L.push('**Alternatives:**', ...r.alternatives.map((a) => `- ${a}`), '');
  if (r.resume_instructions.length) {
    const shell = r.resume_instructions.filter((x) => !x.startsWith('Dashboard:'));
    L.push('**To resume dependent work:**', '', ...r.resume_instructions.filter((x) => x.startsWith('Dashboard:')).map((x) => `- ${x}`));
    if (shell.length) L.push('', '```bash', ...shell.map((x) => x.replace(/^CLI [a-z ]+: /, '')), '```');
    L.push('');
  }
  L.push(`## Other pending decisions (${Math.max(0, d.pending_decisions.length - 1)})`, '');
  for (const p of d.pending_decisions.slice(1)) L.push(`- ${p.business} — ${p.title} (${p.request || 'n/a'})`);
  L.push('', '## Can proceed without an answer', '', ...d.can_proceed_without_answer.map((c) => `- ${c}`), '');
  return L.join('\n');
}

export function saveAppCheckpoint(store, opts, dir = 'checkpoints') {
  const { data, markdown } = buildAppCheckpoint(store, opts);
  const id = store.saveCheckpoint('app', markdown, data);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'app-checkpoint-latest.md');
  fs.writeFileSync(file, markdown);
  return { id, data, markdown, file };
}
