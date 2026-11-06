import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { tmpDir } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('HTTP API: intake → review → approve, with business-scoped URLs', async () => {
  const dir = tmpDir();
  const app = createApp({ dbFile: path.join(dir, 'lab.db'), stepDelayMs: 0, checkpointDir: path.join(dir, 'cp'), env: {} });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}/api`;
  const j = async (p, opts) => { const r = await fetch(base + p, opts && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts) }); return { status: r.status, body: await r.json() }; };
  try {
    const created = await j('/b/natea/requests', { sample_key: 'natea-workers-8' });
    assert.equal(created.status, 201);
    const id = created.body.id;
    let d;
    for (let i = 0; i < 100; i++) { d = (await j(`/b/natea/runs/${id}`)).body; if (d.run.status === 'needs_review') break; await sleep(30); }
    assert.equal(d.run.status, 'needs_review');

    // Cross-business access through the API is refused.
    assert.equal((await j(`/b/rewire/runs/${id}`)).status, 404);
    assert.equal((await j(`/b/rewire/runs/${id}/review`, { action: 'approve' })).status, 404);
    assert.equal((await j('/b/rewire/runs')).body.length, 0);
    assert.equal((await j('/b/unknown/runs')).status, 404);

    assert.equal((await j(`/b/natea/runs/${id}/review`, { action: 'request_changes' })).status, 400);
    assert.equal((await j(`/b/natea/runs/${id}/review`, { action: 'approve' })).status, 201);
    assert.equal((await j(`/b/natea/runs/${id}/review`, { action: 'approve' })).status, 409, 'double approval rejected');
    for (let i = 0; i < 100; i++) { d = (await j(`/b/natea/runs/${id}`)).body; if (d.run.status === 'completed') break; await sleep(30); }
    assert.equal(d.run.status, 'completed');
    assert.match(d.handoff.markdown, /Maya handoff/);

    const cp = await j('/checkpoint', {});
    assert.equal(cp.status, 201);
    assert.match(cp.body.markdown, /nobody was notified/);
  } finally {
    await app.close();
  }
});
