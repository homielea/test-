import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, submitSample } from './helpers.js';
import { reviewRun, runDetail, MAX_REPAIRS } from '../src/graph.js';

test('scenario 1: worker accommodation inquiry reaches a reviewable draft', async () => {
  const ctx = setup();
  const run = submitSample(ctx, 'natea', 'natea-workers-8');
  await ctx.engine.runUntilIdle();
  const d = runDetail(ctx.store, 'natea', run.id);
  assert.equal(d.run.status, 'needs_review');
  assert.deepEqual(d.steps.filter((s) => s.status === 'succeeded').map((s) => s.step),
    ['capture', 'validate', 'load_context', 'classify', 'draft', 'quality_review', 'await_decision']);
  const cls = d.steps.find((s) => s.step === 'classify').output;
  assert.equal(cls.category, 'worker_accommodation');
  const draft = d.drafts[0].content;
  const fields = draft.brief.known_facts.map((f) => f.field);
  assert.ok(fields.includes('headcount') && fields.includes('duration') && fields.includes('start_date'), `facts: ${fields}`);
  const missing = draft.brief.missing_info.map((m) => m.field);
  assert.ok(missing.includes('budget') && missing.includes('room_setup'), `missing: ${missing}`);
  assert.equal(d.drafts[0].quality.passed, true);
  assert.doesNotMatch(draft.response_draft.body, /€|\bavailable\b/);
  assert.equal(d.decisions.filter((x) => x.status === 'pending').length, 1);
});

test('approval saves the approved version and creates exactly one handoff', async () => {
  const ctx = setup();
  const run = submitSample(ctx, 'natea', 'natea-workers-8');
  await ctx.engine.runUntilIdle();
  reviewRun(ctx.store, 'natea', run.id, { action: 'approve' });
  await ctx.engine.runUntilIdle();
  const d = runDetail(ctx.store, 'natea', run.id);
  assert.equal(d.run.status, 'completed');
  assert.equal(d.result.draft_id, d.drafts.at(-1).id);
  assert.match(d.handoff.markdown, /Maya handoff/);
  assert.match(d.handoff.markdown, /SAMPLE DATA/);
  assert.match(d.handoff.markdown, /SIMULATED/);
  assert.match(d.handoff.markdown, /NOT SENT/);
  assert.equal(d.decisions.filter((x) => x.status === 'pending').length, 0);
  // Approving again is rejected: no duplicate decision or completion.
  assert.throws(() => reviewRun(ctx.store, 'natea', run.id, { action: 'approve' }), /no decision is pending/);
});

test('request changes creates a new attempt, preserves history, and approval saves v2', async () => {
  const ctx = setup();
  const run = submitSample(ctx, 'natea', 'natea-buyer-home');
  await ctx.engine.runUntilIdle();
  assert.throws(() => reviewRun(ctx.store, 'natea', run.id, { action: 'request_changes', notes: '' }), /describe the changes/);
  reviewRun(ctx.store, 'natea', run.id, { action: 'request_changes', notes: 'Make it shorter please.' });
  await ctx.engine.runUntilIdle();
  let d = runDetail(ctx.store, 'natea', run.id);
  assert.equal(d.run.status, 'needs_review');
  assert.equal(d.run.attempt, 2);
  assert.equal(d.drafts.length, 2);
  assert.equal(d.drafts[0].version, 1);
  assert.equal(d.drafts[1].version, 2);
  assert.notEqual(d.drafts[0].content.response_draft.body, d.drafts[1].content.response_draft.body);
  assert.ok(d.drafts[1].content.response_draft.body.length < d.drafts[0].content.response_draft.body.length);
  reviewRun(ctx.store, 'natea', run.id, { action: 'approve' });
  await ctx.engine.runUntilIdle();
  d = runDetail(ctx.store, 'natea', run.id);
  assert.equal(d.result.draft_version, 2);
  assert.equal(d.result.content.response_draft.body, d.drafts[1].content.response_draft.body);
  assert.deepEqual(d.reviews.map((r) => r.action), ['request_changes', 'approve']);
});

test('hold blocks the run; it can be approved later', async () => {
  const ctx = setup();
  const run = submitSample(ctx, 'natea', 'natea-automation-admin');
  await ctx.engine.runUntilIdle();
  reviewRun(ctx.store, 'natea', run.id, { action: 'hold', notes: 'Waiting for Marta to call.' });
  let d = runDetail(ctx.store, 'natea', run.id);
  assert.equal(d.run.status, 'blocked');
  assert.equal(d.run.blocked_reason, 'held_by_reviewer');
  assert.equal(d.decisions.filter((x) => x.status === 'pending').length, 1, 'decision stays pending while held');
  reviewRun(ctx.store, 'natea', run.id, { action: 'approve' });
  await ctx.engine.runUntilIdle();
  d = runDetail(ctx.store, 'natea', run.id);
  assert.equal(d.run.status, 'completed');
});

test('quality failure is repaired (one injected defect)', async () => {
  const ctx = setup();
  const run = submitSample(ctx, 'natea', 'natea-workers-8', { faults: { quality_violations: 1 } });
  await ctx.engine.runUntilIdle();
  const d = runDetail(ctx.store, 'natea', run.id);
  assert.equal(d.run.status, 'needs_review');
  assert.equal(d.drafts.length, 2);
  assert.equal(d.drafts[0].quality.passed, false);
  assert.ok(d.drafts[0].quality.issues.some((i) => i.id === 'no_invented_prices'));
  assert.ok(d.drafts[0].quality.issues.some((i) => i.id === 'no_availability_claims'));
  assert.equal(d.drafts[1].quality.passed, true);
});

test('repeated quality failure stops at the repair limit and requests a decision', async () => {
  const ctx = setup();
  const run = submitSample(ctx, 'natea', 'natea-workers-8', { faults: { quality_violations: 99 } });
  await ctx.engine.runUntilIdle();
  const d = runDetail(ctx.store, 'natea', run.id);
  assert.equal(d.run.status, 'blocked');
  assert.equal(d.run.blocked_reason, 'quality_failed_after_repairs');
  assert.equal(d.drafts.length, MAX_REPAIRS + 1);
  const dec = d.decisions.find((x) => x.kind === 'quality_exhausted');
  assert.equal(dec.status, 'pending');
  assert.throws(() => reviewRun(ctx.store, 'natea', run.id, { action: 'approve' }), /did not pass quality/);
});

test('repeated step errors reach the retry limit and the run fails', async () => {
  const ctx = setup();
  const run = submitSample(ctx, 'natea', 'natea-workers-8', { faults: { fail_step: { step: 'classify', message: 'simulated upstream error' } } });
  await ctx.engine.runUntilIdle();
  const d = runDetail(ctx.store, 'natea', run.id);
  assert.equal(d.run.status, 'failed');
  assert.match(d.run.error, /failed 3 times/);
  assert.equal(d.steps.filter((s) => s.step === 'classify' && s.status === 'failed').length, 3);
});

test('a transient step error is retried and the run continues', async () => {
  const ctx = setup();
  const run = submitSample(ctx, 'natea', 'natea-workers-8', { faults: { fail_step: { step: 'draft', times: 1 } } });
  await ctx.engine.runUntilIdle();
  const d = runDetail(ctx.store, 'natea', run.id);
  assert.equal(d.run.status, 'needs_review');
  assert.equal(d.steps.filter((s) => s.step === 'draft' && s.status === 'failed').length, 1);
});

test('validation failure is recorded', async () => {
  const ctx = setup();
  const { submitRequest } = await import('../src/graph.js');
  const run = submitRequest(ctx.store, 'natea', { title: 'Hi', body: 'too short' }, ctx.adapter);
  await ctx.engine.runUntilIdle();
  const d = runDetail(ctx.store, 'natea', run.id);
  assert.equal(d.run.status, 'failed');
  assert.match(d.run.error, /Validation failed/);
});
