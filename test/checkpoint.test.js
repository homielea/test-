import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { setup, submitSample, tmpDir } from './helpers.js';
import { saveAppCheckpoint, buildAppCheckpoint } from '../src/checkpoint.js';
import { anthropicStatus } from '../src/adapters/anthropic.js';

test('checkpoint recommends exactly one decision, with alternatives and exact resume commands', async () => {
  const ctx = setup();
  const a = submitSample(ctx, 'natea', 'natea-workers-8');
  submitSample(ctx, 'natea', 'natea-buyer-home', { faults: { quality_violations: 99 } });
  submitSample(ctx, 'rewire', 'rewire-diagnostic');
  await ctx.engine.runUntilIdle();
  const dir = tmpDir();
  const cp = saveAppCheckpoint(ctx.store, { adapterStatus: { label: 'Mock' }, realStatus: anthropicStatus({}) }, dir);
  const r = cp.data.recommended_decision;
  // Highest value: the quality-exhausted run outranks ordinary reviews.
  assert.match(r.title, /failed quality review/);
  assert.ok(r.recommendation);
  assert.ok(r.alternatives.length >= 2);
  assert.ok(r.resume_instructions.some((x) => x.includes('npm run lab -- review natea')));
  assert.equal(cp.data.pending_decisions.length, 3);
  assert.equal(cp.data.businesses.find((b) => b.id === 'natea').counts.needs_review, 1);
  assert.match(cp.markdown, /## The one decision/);
  assert.match(cp.markdown, /## Can proceed without an answer/);
  assert.match(cp.markdown, /nobody was notified/);
  assert.ok(fs.existsSync(path.join(dir, 'app-checkpoint-latest.md')));
  assert.equal(ctx.store.latestCheckpoint('app').id, cp.id);
  assert.ok(a);
});

test('with an empty queue the checkpoint names the real-model authorisation as the decision', () => {
  const ctx = setup();
  const { data } = buildAppCheckpoint(ctx.store, { adapterStatus: {}, realStatus: anthropicStatus({}) });
  assert.match(data.recommended_decision.title, /real-model/);
  assert.match(data.recommended_decision.why, /ANTHROPIC_API_KEY not set/);
});

test('server writes an app checkpoint only when 4 wall-clock hours have elapsed since the last one', async () => {
  const { createApp } = await import('../src/server.js');
  const dir = tmpDir();
  const app = createApp({ dbFile: path.join(dir, 'lab.db'), checkpointDir: path.join(dir, 'cp'), env: {} });
  const first = app.checkpointIfDue();
  assert.ok(first, 'no previous checkpoint → write one');
  assert.equal(app.checkpointIfDue(Date.now() + 3.9 * 3600e3), null, 'not yet due');
  assert.ok(app.checkpointIfDue(Date.now() + 4.01 * 3600e3), 'due after 4h');
  await app.close().catch(() => {});
});
