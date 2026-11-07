// Markdown handoff for Maya (Chief of Staff). Generated only from saved, approved state.

const PROV = {
  mock: 'SIMULATED — produced by the deterministic mock adapter, not a language model',
  model: 'MODEL OUTPUT — produced by a real language model',
};

export function buildHandoffMarkdown({ business, request, run, classification, result, reviews, quality }) {
  const c = result.content;
  const b = c.brief;
  const approval = [...reviews].reverse().find((r) => r.action === 'approve');
  const lines = [];
  lines.push(`# Maya handoff — ${business.name}: ${request.title}`);
  lines.push('');
  const labels = [];
  if (request.is_sample) labels.push('**SAMPLE DATA** — fictional client and inquiry');
  labels.push(`**${PROV[run.adapter === 'mock' ? 'mock' : 'model']}**`);
  labels.push('**NOT SENT** — approval saved this draft only; nothing was sent to the client');
  for (const l of labels) lines.push(`> ${l}`);
  lines.push('');
  lines.push('| | |', '|---|---|');
  lines.push(`| Business | ${business.name} |`);
  lines.push(`| Run | \`${run.id}\` |`);
  lines.push(`| Classification | ${classification.label} (${classification.category}, confidence ${classification.confidence}) |`);
  lines.push(`| Approved version | v${result.draft_version} (attempt ${run.attempt}) |`);
  lines.push(`| Approved by | ${approval?.decided_by || 'unknown'} at ${approval?.created_at || 'unknown'} |`);
  lines.push(`| Quality review | ${quality?.passed ? 'passed' : 'not passed'} (${quality ? Math.round(quality.score * 100) : '?'}%) |`);
  lines.push('');
  lines.push('## Client brief', '');
  lines.push(b.summary, '');
  const cl = b.client || {};
  lines.push(`- Contact: ${cl.name || '—'}${cl.company ? `, ${cl.company}` : ''}${cl.email ? ` <${cl.email}>` : ''}`);
  lines.push('');
  lines.push('### Known facts (quoted from the inquiry)', '');
  if (b.known_facts.length) for (const f of b.known_facts) lines.push(`- **${f.label}:** ${f.value}${f.evidence ? ` — _"${f.evidence}"_` : ''}`);
  else lines.push('- None extracted.');
  if (b.observations?.length) {
    lines.push('', '### Observations', '');
    for (const o of b.observations) lines.push(`- **${o.label}:** ${o.value}`);
  }
  lines.push('', '### Missing information (asked in the draft)', '');
  if (b.missing_info.length) for (const m of b.missing_info) lines.push(`- ${m.label}`);
  else lines.push('- Nothing outstanding.');
  lines.push('', '## Proposed next actions for Maya', '');
  lines.push('- [ ] Review the approved draft below and send it from the usual channel (manual — not automated).');
  for (const a of b.next_actions) lines.push(`- [ ] ${a}`);
  lines.push('', '## Approved response draft', '');
  lines.push(`**Subject:** ${c.response_draft.subject}`, '');
  lines.push('```text', c.response_draft.body, '```');
  const notes = reviews.filter((r) => r.notes);
  if (notes.length) {
    lines.push('', '## Review history', '');
    for (const r of reviews) lines.push(`- ${r.created_at} — **${r.action}** by ${r.decided_by}${r.notes ? `: ${r.notes}` : ''}`);
  }
  lines.push('', '## Guardrails', '');
  for (const p of b.policy_reminders) lines.push(`- ${p}`);
  lines.push('');
  return lines.join('\n');
}
