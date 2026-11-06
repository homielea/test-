import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, submitSample } from './helpers.js';
import { reviewRun, runDetail } from '../src/graph.js';

const SCENARIOS = [
  { key: 'natea-workers-8', category: 'worker_accommodation', known: ['headcount', 'duration', 'start_date', 'area'], missing: ['room_setup', 'budget', 'contact_role'] },
  { key: 'natea-buyer-home', category: 'property_purchase', known: ['buyer_origin', 'property_type', 'bedrooms', 'timeline'], missing: ['budget', 'financing'] },
  { key: 'natea-automation-admin', category: 'automation_services', known: ['process', 'volume', 'tools'], missing: ['people', 'goal', 'constraints'] },
];

for (const s of SCENARIOS) {
  test(`NATEA scenario ${s.key}: full output set and handoff after approval`, async () => {
    const ctx = setup();
    const run = submitSample(ctx, 'natea', s.key);
    await ctx.engine.runUntilIdle();
    let d = runDetail(ctx.store, 'natea', run.id);
    const cls = d.steps.find((x) => x.step === 'classify').output;
    assert.equal(cls.category, s.category);
    const c = d.drafts[0].content;
    const known = c.brief.known_facts.map((f) => f.field);
    for (const k of s.known) assert.ok(known.includes(k), `${s.key} should know ${k}; got ${known}`);
    const missing = c.brief.missing_info.map((m) => m.field);
    assert.deepEqual(missing.sort(), [...s.missing].sort());
    for (const f of c.brief.known_facts) for (const q of f.evidence.split(' … ')) assert.ok(d.request.body.includes(q), `evidence "${q}" not in inquiry`);
    assert.ok(c.brief.next_actions.length >= 2);
    const body = c.response_draft.body;
    for (const m of c.brief.missing_info) assert.ok(body.includes(m.question));
    assert.doesNotMatch(body, /€|\$|£|\bper month\b|\bavailable\b|\bguarantee/i, 'no prices or availability');
    assert.doesNotMatch(body, /\blegally\b|\bentitled\b|\bthe law\b/i, 'no legal conclusions');
    assert.equal(d.drafts[0].quality.passed, true);

    reviewRun(ctx.store, 'natea', run.id, { action: 'approve' });
    await ctx.engine.runUntilIdle();
    d = runDetail(ctx.store, 'natea', run.id);
    assert.equal(d.run.status, 'completed');
    const md = d.handoff.markdown;
    for (const h of ['## Client brief', '### Known facts', '### Missing information', '## Proposed next actions for Maya', '## Approved response draft']) assert.ok(md.includes(h), h);
    assert.ok(md.includes(body.split('\n')[0]));
  });
}

test('buyer scenario routes the legal question to a professional instead of answering it', async () => {
  const ctx = setup();
  const run = submitSample(ctx, 'natea', 'natea-buyer-home');
  await ctx.engine.runUntilIdle();
  const c = runDetail(ctx.store, 'natea', run.id).drafts[0].content;
  assert.ok(c.brief.observations.some((o) => o.label.startsWith('Legal')));
  assert.match(c.response_draft.body, /qualified local professional/);
  assert.match(c.response_draft.body, /do not give legal advice/);
});

test('automation scenario notes the Spanish greeting without assuming language', async () => {
  const ctx = setup();
  const run = submitSample(ctx, 'natea', 'natea-automation-admin');
  await ctx.engine.runUntilIdle();
  const c = runDetail(ctx.store, 'natea', run.id).drafts[0].content;
  assert.ok(c.brief.observations.some((o) => /Buenos días/.test(o.value) && /confirm/i.test(o.value)));
});
