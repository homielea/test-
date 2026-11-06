// One bounded real-model call on NATEA scenario 1. Refuses to run without explicit configuration.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { seedBusinesses, SAMPLE_INQUIRIES } from '../src/businesses.js';
import { selectAdapter } from '../src/adapters/index.js';
import { WorkflowEngine, submitRequest, runDetail } from '../src/graph.js';

const { real } = selectAdapter({ store: { db: null } });
if (!real.available) {
  console.error(`NOT RUN: real model disabled — ${real.missing.join('; ')}`);
  process.exit(2);
}
const store = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-')), 'lab.db'));
seedBusinesses(store);
const { adapter } = selectAdapter({ store });
const s = SAMPLE_INQUIRIES.natea[0];
const run = submitRequest(store, 'natea', { title: s.title, body: s.body, contact: s.contact, isSample: true }, adapter);
await new WorkflowEngine({ store, adapter }).runUntilIdle();
const d = runDetail(store, 'natea', run.id);
console.log(`status=${d.run.status} drafts=${d.drafts.length} quality=${d.drafts.at(-1)?.quality?.passed}`);
console.log(d.drafts.at(-1)?.content.response_draft.body || d.run.error);
process.exit(d.run.status === 'needs_review' ? 0 : 1);
