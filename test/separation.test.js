import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, submitSample } from './helpers.js';
import { reviewRun, runDetail } from '../src/graph.js';
import { reviewDraft } from '../src/quality.js';
import { BUSINESSES } from '../src/businesses.js';

test('business scopes cannot read or modify each other\'s records', async () => {
  const ctx = setup();
  const nRun = submitSample(ctx, 'natea', 'natea-workers-8');
  const rRun = submitSample(ctx, 'rewire', 'rewire-diagnostic');
  await ctx.engine.runUntilIdle();

  const natea = ctx.store.forBusiness('natea');
  const rewire = ctx.store.forBusiness('rewire');

  // Listing only returns own runs.
  assert.deepEqual(natea.listRuns().map((r) => r.id), [nRun.id]);
  assert.deepEqual(rewire.listRuns().map((r) => r.id), [rRun.id]);

  // Direct id access across businesses behaves like "not found".
  assert.throws(() => natea.getRun(rRun.id), /not found in business natea/);
  assert.throws(() => natea.getRequest(rRun.request_id), /not found/);
  assert.throws(() => natea.listSteps(rRun.id), /not found/);
  const rDraft = rewire.latestDraft(rRun.id);
  assert.throws(() => natea.getDraft(rDraft.id), /not found/);
  assert.equal(natea.latestDraft(rRun.id), undefined);
  assert.equal(natea.getResult(rRun.id), null);
  assert.deepEqual(natea.listEvents(rRun.id), []);
  assert.deepEqual(natea.listDecisions({ runId: rRun.id }), []);

  // Cross-business writes are refused.
  assert.throws(() => natea.createRun(rRun.request_id, { adapter: 'mock' }), /not found/);
  assert.throws(() => reviewRun(ctx.store, 'natea', rRun.id, { action: 'approve' }), /not found/);
  assert.equal(natea.updateRun(rRun.id, { status: 'failed' }), false);
  assert.equal(rewire.getRun(rRun.id).status, 'needs_review');
  assert.throws(() => runDetail(ctx.store, 'natea', rRun.id), /not found/);

  // Denied attempts are logged in the attempting business only.
  const denied = ctx.store.db.prepare("SELECT business_id FROM events WHERE type = 'access.denied'").all();
  assert.ok(denied.length >= 5);
  assert.ok(denied.every((e) => e.business_id === 'natea'));

  // Unknown business is rejected outright.
  assert.throws(() => ctx.store.forBusiness('nope'), /Unknown business/);
});

test('each business uses its own context and categories', async () => {
  const ctx = setup();
  const r = submitSample(ctx, 'polypreneur', 'poly-podcast');
  await ctx.engine.runUntilIdle();
  const d = runDetail(ctx.store, 'polypreneur', r.id);
  const lc = d.steps.find((s) => s.step === 'load_context').output;
  assert.equal(lc.business_id, 'polypreneur');
  assert.ok(lc.categories.every((c) => ['collaboration', 'product_experiment'].includes(c.id)));
  assert.match(d.drafts[0].content.response_draft.body, /Polypreneur/);
  assert.doesNotMatch(d.drafts[0].content.response_draft.body, /NATEA|REWIRE/);
});

test('quality review rejects drafts that mention another business', () => {
  const natea = BUSINESSES.find((b) => b.id === 'natea');
  const draft = {
    brief: { missing_info: [], known_facts: [] },
    response_draft: { body: 'Dear Jo,\n\nOur sister company REWIRE could also run a diagnostic for you.\n\nKind regards,\nLea' },
  };
  const q = reviewDraft({ business: natea, otherBusinessNames: ['REWIRE', 'Polypreneur'], request: { body: 'We need help.' }, draft });
  assert.equal(q.passed, false);
  assert.ok(q.issues.some((i) => i.id === 'business_scope'));
});

test('quality review catches invented prices, availability, legal conclusions and ungrounded facts', () => {
  const natea = BUSINESSES.find((b) => b.id === 'natea');
  const draft = {
    brief: { missing_info: [{ label: 'Budget', question: 'What budget range are you considering?' }], known_facts: [{ label: 'Bedrooms', value: '4', evidence: '4 bedrooms' }] },
    response_draft: { body: 'Dear Sam,\n\nThe flat is available at €900 per month. Legally you are entitled to buy without a NIE.\n\nLea' },
  };
  const q = reviewDraft({ business: natea, otherBusinessNames: [], request: { body: 'We want a 3 bedroom house.' }, draft });
  const ids = q.issues.map((i) => i.id);
  for (const id of ['no_invented_prices', 'no_availability_claims', 'no_legal_conclusions', 'asks_missing_info', 'facts_grounded']) assert.ok(ids.includes(id), id);
});
