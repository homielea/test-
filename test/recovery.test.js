import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, submitSample } from './helpers.js';
import { reviewRun, runDetail, WorkflowEngine } from '../src/graph.js';
import { openDb } from '../src/db.js';
import { createMockAdapter } from '../src/adapters/mock.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('pending approval survives a restart', async () => {
  const ctx = setup();
  const run = submitSample(ctx, 'natea', 'natea-workers-8');
  await ctx.engine.runUntilIdle();
  ctx.store.close();

  // "Restart": new store + engine on the same file.
  const store2 = openDb(ctx.dbFile);
  const engine2 = new WorkflowEngine({ store: store2, adapter: createMockAdapter() });
  engine2.reconcile();
  const scope = store2.forBusiness('natea');
  assert.equal(scope.getRun(run.id).status, 'needs_review');
  assert.equal(scope.listDecisions().length, 1);
  assert.equal(await engine2.runUntilIdle(), 0, 'nothing auto-approves: silence is not approval');
  reviewRun(store2, 'natea', run.id, { action: 'approve' });
  await engine2.runUntilIdle();
  assert.equal(scope.getRun(run.id).status, 'completed');
});

test('interrupted work (SIGKILL mid-run) resumes without duplicate step completion', async () => {
  const ctx = setup();
  const runs = [submitSample(ctx, 'natea', 'natea-workers-8'), submitSample(ctx, 'natea', 'natea-buyer-home')];
  const child = fork(path.join(here, 'fixtures/crash-worker.mjs'), [ctx.dbFile, '150'], { execArgv: ['--no-warnings'], stdio: 'ignore' });
  await new Promise((r) => child.once('message', r));
  const scope = ctx.store.forBusiness('natea');
  // Wait until the first run is mid-graph.
  for (let i = 0; i < 100; i++) {
    const n = scope.listSteps(runs[0].id).filter((s) => s.status === 'succeeded').length;
    if (n >= 3) break;
    await sleep(25);
  }
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  const mid = scope.getRun(runs[0].id);
  assert.equal(mid.status, 'running', 'killed worker left the run running with a live-looking lease');

  const engine = new WorkflowEngine({ store: ctx.store, adapter: createMockAdapter() });
  const requeued = engine.reconcile();
  assert.ok(requeued.includes(runs[0].id), 'dead worker detected and run requeued');
  await engine.runUntilIdle();

  for (const r of runs) {
    const d = runDetail(ctx.store, 'natea', r.id);
    assert.equal(d.run.status, 'needs_review');
    const ok = d.steps.filter((s) => s.status === 'succeeded').map((s) => `${s.step}:${s.attempt}:${s.repair}`);
    assert.equal(new Set(ok).size, ok.length, `duplicate step success: ${ok}`);
    assert.equal(d.drafts.length, 1);
  }
  assert.ok(runDetail(ctx.store, 'natea', runs[0].id).events.some((e) => e.type === 'run.recovered'));
});

test('two concurrent workers never process the same run twice', async () => {
  const ctx = setup();
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(submitSample(ctx, 'natea', ['natea-workers-8', 'natea-buyer-home', 'natea-automation-admin'][i % 3]).id);
  const a = new WorkflowEngine({ store: ctx.store, adapter: createMockAdapter(), stepDelayMs: 5 });
  const b = new WorkflowEngine({ store: ctx.store, adapter: createMockAdapter(), stepDelayMs: 5 });
  const [na, nb] = await Promise.all([a.runUntilIdle(), b.runUntilIdle()]);
  assert.equal(na + nb, 6);
  for (const id of ids) {
    const d = runDetail(ctx.store, 'natea', id);
    assert.equal(d.run.status, 'needs_review');
    assert.equal(d.steps.filter((s) => s.status === 'succeeded').length, 7);
  }
});

test('completion is idempotent: result and handoff cannot be saved twice', async () => {
  const ctx = setup();
  const run = submitSample(ctx, 'natea', 'natea-workers-8');
  await ctx.engine.runUntilIdle();
  reviewRun(ctx.store, 'natea', run.id, { action: 'approve' });
  await ctx.engine.runUntilIdle();
  const scope = ctx.store.forBusiness('natea');
  const draft = scope.latestDraft(run.id);
  assert.equal(scope.saveResult(run.id, draft).created, false);
  assert.equal(scope.saveHandoff(run.id, 'dup').created, false);
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) n FROM results WHERE run_id = ?').get(run.id).n, 1);
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) n FROM handoffs WHERE run_id = ?').get(run.id).n, 1);
});

test('stop() releases the lease cleanly so another worker can resume', async () => {
  const ctx = setup();
  const run = submitSample(ctx, 'natea', 'natea-workers-8');
  const engine = new WorkflowEngine({ store: ctx.store, adapter: createMockAdapter(), stepDelayMs: 60 });
  const p = engine.processOne();
  await sleep(150);
  await engine.stop();
  await p;
  const scope = ctx.store.forBusiness('natea');
  const r = scope.getRun(run.id);
  assert.equal(r.status, 'queued');
  assert.equal(r.lease_owner, null);
  const engine2 = new WorkflowEngine({ store: ctx.store, adapter: createMockAdapter() });
  await engine2.runUntilIdle();
  assert.equal(scope.getRun(run.id).status, 'needs_review');
});
