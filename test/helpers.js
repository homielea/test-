import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { seedBusinesses, SAMPLE_INQUIRIES } from '../src/businesses.js';
import { createMockAdapter } from '../src/adapters/mock.js';
import { WorkflowEngine, submitRequest } from '../src/graph.js';

export function tmpDir(prefix = 'lab-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function setup({ file } = {}) {
  const dbFile = file || path.join(tmpDir(), 'lab.db');
  const store = openDb(dbFile);
  seedBusinesses(store);
  const adapter = createMockAdapter();
  const engine = new WorkflowEngine({ store, adapter, retryDelayMs: 1 });
  return { store, adapter, engine, dbFile };
}

export function sample(businessId, key) {
  const s = SAMPLE_INQUIRIES[businessId].find((x) => x.key === key);
  return { title: s.title, body: s.body, contact: s.contact, isSample: true, sampleKey: s.key };
}

export function submitSample(ctx, businessId, key, options = {}) {
  return submitRequest(ctx.store, businessId, { ...sample(businessId, key), options }, ctx.adapter);
}
