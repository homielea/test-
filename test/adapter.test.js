import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicStatus, createAnthropicAdapter } from '../src/adapters/anthropic.js';
import { selectAdapter } from '../src/adapters/index.js';
import { setup, sample } from './helpers.js';
import { WorkflowEngine, submitRequest, runDetail } from '../src/graph.js';

test('real adapter reports every missing prerequisite (never prints secrets)', () => {
  const s = anthropicStatus({});
  assert.equal(s.available, false);
  assert.deepEqual(s.missing, ['ANTHROPIC_API_KEY not set', 'LAB_MAX_BUDGET_USD not configured (real-model path stays disabled without a budget)', 'LAB_ADAPTER=anthropic not set']);
  const withKey = anthropicStatus({ ANTHROPIC_API_KEY: 'sk-test-secret', LAB_ADAPTER: 'anthropic' });
  assert.equal(withKey.available, false, 'key alone is not enough: a budget is required');
  assert.doesNotMatch(JSON.stringify(withKey), /sk-test-secret/);
  assert.equal(anthropicStatus({ ANTHROPIC_API_KEY: 'x', LAB_ADAPTER: 'anthropic', LAB_MAX_BUDGET_USD: '2' }).available, true);
});

test('requesting real mode without credentials falls back to mock and explains why', () => {
  const r = selectAdapter({ store: null, env: { LAB_ADAPTER: 'anthropic' } });
  assert.equal(r.adapter.name, 'mock');
  assert.match(r.fallbackReason, /ANTHROPIC_API_KEY not set/);
  assert.equal(selectAdapter({ store: null, env: {} }).fallbackReason, null);
});

test('a disabled real adapter blocks the run (no retries, honest reason, pending decision)', async () => {
  const ctx = setup();
  const adapter = createAnthropicAdapter({ store: ctx.store, env: {} });
  const run = submitRequest(ctx.store, 'natea', sample('natea', 'natea-workers-8'), adapter);
  await new WorkflowEngine({ store: ctx.store, adapter, retryDelayMs: 1 }).runUntilIdle();
  const d = runDetail(ctx.store, 'natea', run.id);
  assert.equal(d.run.status, 'blocked');
  assert.match(d.run.blocked_reason, /^CREDENTIALS: Real model disabled/);
  assert.equal(d.steps.filter((s) => s.status === 'failed').length, 1, 'not retried');
  assert.ok(d.decisions.some((x) => x.kind === 'blocked' && x.status === 'pending'));
});

test('server status exposes adapter labels and the missing-credential reasons', async () => {
  const { createApp } = await import('../src/server.js');
  const app = createApp({ dbFile: ':memory:', env: {} });
  const s = app.status();
  assert.equal(s.adapter.provenance, 'mock');
  assert.match(s.adapter.label, /not a language model/);
  assert.equal(s.real_model.available, false);
  assert.equal(s.notification_channel.configured, false);
  await app.close().catch(() => {});
});
