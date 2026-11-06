// Local dashboard + JSON API + in-process workflow worker. Binds to 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { seedBusinesses, SAMPLE_INQUIRIES, SHARED_CAPABILITIES } from './businesses.js';
import { selectAdapter } from './adapters/index.js';
import { WorkflowEngine, submitRequest, reviewRun, runDetail, GRAPH, RUN_STATUSES } from './graph.js';
import { saveAppCheckpoint } from './checkpoint.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export function createApp({ dbFile = process.env.LAB_DB || 'data/lab.db', env = process.env, stepDelayMs = Number(env.LAB_STEP_DELAY_MS ?? 350), checkpointDir = 'checkpoints', port = 4317 } = {}) {
  const store = openDb(dbFile);
  seedBusinesses(store);
  const { adapter, real, fallbackReason } = selectAdapter({ store, env });
  const engine = new WorkflowEngine({ store, adapter, stepDelayMs: adapter.name === 'mock' ? stepDelayMs : 0 });
  const recovered = engine.reconcile();
  const started = new Date().toISOString();

  const status = () => ({
    started_at: started,
    adapter: { name: adapter.name, provenance: adapter.provenance, label: adapter.label, ...adapter.status() },
    real_model: real,
    fallback_reason: fallbackReason,
    recovered_on_start: recovered.length,
    notification_channel: { configured: false, note: 'No notification channel configured; checkpoints are saved locally only.' },
    graph: GRAPH,
    statuses: RUN_STATUSES,
    capabilities: SHARED_CAPABILITIES,
  });

  const routes = [
    ['GET', /^\/api\/status$/, () => status()],
    ['GET', /^\/api\/businesses$/, () => store.listBusinesses().map((b) => ({ id: b.id, name: b.name, tagline: b.config.tagline, counts: store.forBusiness(b.id).countRunsByStatus() }))],
    ['GET', /^\/api\/b\/([\w-]+)\/context$/, (m) => store.forBusiness(m[1]).business()],
    ['GET', /^\/api\/b\/([\w-]+)\/samples$/, (m) => { store.forBusiness(m[1]); return (SAMPLE_INQUIRIES[m[1]] || []).map((s) => ({ ...s, is_sample: true })); }],
    ['GET', /^\/api\/b\/([\w-]+)\/runs$/, (m) => store.forBusiness(m[1]).listRuns()],
    ['GET', /^\/api\/b\/([\w-]+)\/decisions$/, (m) => store.forBusiness(m[1]).listDecisions()],
    ['POST', /^\/api\/b\/([\w-]+)\/requests$/, (m, body) => {
      const sample = body.sample_key ? (SAMPLE_INQUIRIES[m[1]] || []).find((s) => s.key === body.sample_key) : null;
      const input = sample
        ? { title: sample.title, body: sample.body, contact: sample.contact, isSample: true, sampleKey: sample.key }
        : { title: body.title, body: body.body, contact: body.contact || {}, isSample: !!body.is_sample };
      return submitRequest(store, m[1], { ...input, options: body.options || {} }, adapter);
    }],
    ['GET', /^\/api\/b\/([\w-]+)\/runs\/([\w-]+)$/, (m) => runDetail(store, m[1], m[2])],
    ['POST', /^\/api\/b\/([\w-]+)\/runs\/([\w-]+)\/review$/, (m, body) => reviewRun(store, m[1], m[2], { action: body.action, notes: body.notes, decidedBy: 'Lea' })],
    ['GET', /^\/api\/checkpoint$/, () => ({ app: store.latestCheckpoint('app'), supervisor: readSupervisorCheckpoint() })],
    ['POST', /^\/api\/checkpoint$/, () => saveAppCheckpoint(store, { adapterStatus: status().adapter, realStatus: real, port }, checkpointDir)],
  ];

  function readSupervisorCheckpoint() {
    try { return JSON.parse(fs.readFileSync(path.join(checkpointDir, 'supervisor-latest.json'), 'utf8')); } catch { return null; }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    try {
      if (url.pathname.startsWith('/api/')) {
        const route = routes.find(([meth, re]) => meth === req.method && re.test(url.pathname));
        if (!route) return send(res, 404, { error: 'Not found' });
        let body = {};
        if (req.method === 'POST') {
          let raw = '';
          for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) throw Object.assign(new Error('Body too large'), { status: 413 }); }
          body = raw ? JSON.parse(raw) : {};
        }
        const out = await route[2](url.pathname.match(route[1]), body);
        return send(res, req.method === 'POST' ? 201 : 200, out);
      }
      const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      send(res, e.status || (e instanceof SyntaxError ? 400 : 500), { error: e.message, code: e.code });
    }
  });

  function send(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  return {
    store, engine, adapter, server, status,
    async listen(p = port, host = '127.0.0.1') {
      await new Promise((r) => server.listen(p, host, r));
      engine.start();
      return server.address().port;
    },
    async close() {
      await engine.stop();
      await new Promise((r) => server.close(r));
      store.close();
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 4317);
  const app = createApp({ port });
  const p = await app.listen(port);
  const s = app.status();
  console.log(`Business Agent Lab running at http://127.0.0.1:${p}`);
  console.log(`Adapter: ${s.adapter.label}`);
  console.log(`Real model: ${s.real_model.available ? 'enabled' : `disabled (${s.real_model.missing.join('; ')})`}`);
  if (s.recovered_on_start) console.log(`Recovered ${s.recovered_on_start} interrupted run(s).`);
  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return; closing = true;
    console.log(`\n${sig}: stopping worker, releasing leases, closing DB…`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
