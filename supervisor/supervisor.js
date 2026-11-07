#!/usr/bin/env node
// Bounded, restartable coding supervisor. SEPARATE from the business workflow runtime:
// own process, own SQLite file (supervisor.db), own tables. It never touches data/lab.db.
//
// Loop: select eligible task → (optional Claude worker) → run acceptance check → inspect → retry
//       or block → checkpoint → next task. Stops on: backlog complete, nothing eligible, deadline,
//       stop request, usage unavailable.
//
// Commands:  start [--hours 8] [--detach] | run | stop | status | resume [--detach] | checkpoint | reset-window [--hours 8]
//
// Safety properties:
//   - single instance (lock row with live pid); refuses to start inside a supervisor child (no recursion)
//   - deadline persisted in the DB and applied across restarts
//   - every child runs in its own process group and is killed on stop/deadline/timeout
//   - identical failures without new evidence stop retrying; permission denials block, never bypass
//   - Claude worker path is DISABLED unless SUPERVISOR_WORKER=claude and SUPERVISOR_MAX_BUDGET_USD > 0
import { DatabaseSync } from 'node:sqlite';
import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const ENV = process.env;
const HOME = path.resolve(ENV.SUPERVISOR_HOME || path.join(ROOT, 'data'));
const CWD = path.resolve(ENV.SUPERVISOR_CWD || ROOT);
const BACKLOG = path.resolve(ENV.SUPERVISOR_BACKLOG || path.join(here, 'backlog.json'));
const CHECKPOINT_DIR = path.resolve(ENV.SUPERVISOR_CHECKPOINT_DIR || path.join(ROOT, 'checkpoints'));
const EVIDENCE_DIR = path.join(CHECKPOINT_DIR, 'evidence');
const CHECKPOINT_HOURS = Number(ENV.SUPERVISOR_CHECKPOINT_HOURS || 4);
const DEFAULT_HOURS = 8;
const LIMITS = {
  maxAttempts: Number(ENV.SUPERVISOR_MAX_ATTEMPTS || 3),
  taskTimeoutMs: Number(ENV.SUPERVISOR_TASK_TIMEOUT_MS || 15 * 60 * 1000),
  maxWorkerRuns: Number(ENV.SUPERVISOR_MAX_WORKER_RUNS || 8),
  workerMaxTurns: Number(ENV.SUPERVISOR_WORKER_MAX_TURNS || 40),
  budgetUsd: Number(ENV.SUPERVISOR_MAX_BUDGET_USD || 0),
  killGraceMs: 3000,
};

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (e) { return e.code === 'EPERM'; }
  // An unreaped zombie still answers kill(0); treat it as dead.
  try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
};
const log = (...a) => console.log(`[supervisor ${nowIso()}]`, ...a);

// ---------------- Store ----------------
function openStore() {
  fs.mkdirSync(HOME, { recursive: true });
  const db = new DatabaseSync(path.join(HOME, 'supervisor.db'));
  db.exec(`
    PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS window (id INTEGER PRIMARY KEY CHECK (id = 1), started_at TEXT, deadline_at TEXT, hours REAL,
      stop_requested INTEGER DEFAULT 0, last_checkpoint_at TEXT, worker_runs INTEGER DEFAULT 0, spent_usd REAL DEFAULT 0, end_reason TEXT);
    CREATE TABLE IF NOT EXISTS lock (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER, acquired_at TEXT, heartbeat_at TEXT);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, ord INTEGER, title TEXT, kind TEXT, acceptance_json TEXT, check_cmd TEXT,
      depends_json TEXT, requires_decision TEXT, prompt TEXT, status TEXT, attempts INTEGER DEFAULT 0, last_fingerprint TEXT,
      last_error TEXT, evidence_path TEXT, child_pid INTEGER, started_at TEXT, finished_at TEXT, note TEXT);
    CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, n INTEGER, outcome TEXT, exit_code INTEGER,
      fingerprint TEXT, evidence_path TEXT, started_at TEXT, finished_at TEXT, detail TEXT);
    CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, task_id TEXT, title TEXT, why TEXT, recommendation TEXT,
      alternatives_json TEXT, resume TEXT, status TEXT DEFAULT 'pending', created_at TEXT, resolved_at TEXT);
    CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, data_json TEXT, created_at TEXT);
  `);
  return db;
}
const ev = (db, type, data = {}) => db.prepare('INSERT INTO events (type, data_json, created_at) VALUES (?, ?, ?)').run(type, JSON.stringify(data), nowIso());
const getWindow = (db) => db.prepare('SELECT * FROM window WHERE id = 1').get();

/** Load the authorised backlog. New tasks are added; existing task progress is never reset. */
function syncBacklog(db) {
  const backlog = JSON.parse(fs.readFileSync(BACKLOG, 'utf8'));
  const ins = db.prepare(`INSERT INTO tasks (id, ord, title, kind, acceptance_json, check_cmd, depends_json, requires_decision, prompt, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending') ON CONFLICT(id) DO UPDATE SET ord = excluded.ord, title = excluded.title,
    acceptance_json = excluded.acceptance_json, check_cmd = excluded.check_cmd, depends_json = excluded.depends_json,
    requires_decision = excluded.requires_decision, prompt = excluded.prompt, kind = excluded.kind`);
  backlog.tasks.forEach((t, i) => ins.run(t.id, i, t.title, t.kind || 'verify', JSON.stringify(t.acceptance || []), t.check,
    JSON.stringify(t.depends_on || []), t.requires_decision || null, t.prompt || null));
  for (const d of backlog.decisions || []) {
    db.prepare(`INSERT INTO decisions (id, task_id, title, why, recommendation, alternatives_json, resume, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(d.id, d.task_id || null, d.title, d.why, d.recommendation,
      JSON.stringify(d.alternatives || []), d.resume || null, nowIso());
  }
  // A decision is resolved only by an explicit file written by Lea — never by silence.
  const answers = path.join(HOME, 'decisions-answered.json');
  if (fs.existsSync(answers)) {
    for (const [id, answer] of Object.entries(JSON.parse(fs.readFileSync(answers, 'utf8')))) {
      db.prepare("UPDATE decisions SET status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'pending'").run(nowIso(), id);
      ev(db, 'decision.answered', { id, answer });
    }
  }
}

// ---------------- Lock ----------------
function acquireLock(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const l = db.prepare('SELECT * FROM lock WHERE id = 1').get();
    if (l && l.pid !== process.pid && isAlive(l.pid)) { db.exec('ROLLBACK'); return { ok: false, pid: l.pid }; }
    db.prepare('INSERT INTO lock (id, pid, acquired_at, heartbeat_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at')
      .run(process.pid, nowIso(), nowIso());
    db.exec('COMMIT');
    return { ok: true };
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
}
const releaseLock = (db) => db.prepare('DELETE FROM lock WHERE id = 1 AND pid = ?').run(process.pid);
const lockHolder = (db) => { const l = db.prepare('SELECT * FROM lock WHERE id = 1').get(); return l && isAlive(l.pid) ? l : null; };

// ---------------- Child processes ----------------
let currentChild = null;

function runChild(cmd, args, { timeoutMs, logFile, env = {} }) {
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, 'a');
    const child = spawn(cmd, args, { cwd: CWD, detached: true, stdio: ['ignore', out, out], env: { ...ENV, ...env, LAB_SUPERVISOR_CHILD: '1' } });
    currentChild = child;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(child.pid); }, Math.max(1000, timeoutMs));
    child.on('error', (e) => { fs.appendFileSync(logFile, `\n[spawn error] ${e.message}\n`); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      fs.closeSync(out);
      currentChild = null;
      resolve({ code: code ?? (signal ? 128 : 1), signal, timedOut, pid: child.pid });
    });
  });
}

function killGroup(pid, signal = 'SIGTERM') {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* gone */ } }
  if (signal === 'SIGTERM') setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, LIMITS.killGraceMs).unref();
}

function repoFingerprint() {
  try { return createHash('sha256').update(execSync('git status --porcelain && git diff', { cwd: CWD, stdio: ['ignore', 'pipe', 'ignore'] })).digest('hex').slice(0, 12); } catch { return 'no-git'; }
}
function failureFingerprint(logFile, code) {
  const text = fs.readFileSync(logFile, 'utf8');
  const tail = text.slice(text.lastIndexOf('# --- acceptance check ---')).slice(-4000)
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<ts>').replace(/\b\d+(\.\d+)?\s?ms\b/g, '<ms>').replace(/\/tmp\/\S+/g, '<tmp>').replace(/pid \d+/g, 'pid <n>');
  return createHash('sha256').update(`${code}|${tail}|${repoFingerprint()}`).digest('hex').slice(0, 16);
}
const PERMISSION_RE = /permission denied|EACCES|EPERM|not permitted|requires approval|permission_denials":\s*\[\s*\{/i;
const USAGE_RE = /rate.?limit|usage limit|quota|overloaded|credit balance/i;

function workerStatus() {
  const missing = [];
  if (ENV.SUPERVISOR_WORKER !== 'claude') missing.push('SUPERVISOR_WORKER=claude not set');
  if (!(LIMITS.budgetUsd > 0)) missing.push('SUPERVISOR_MAX_BUDGET_USD not configured');
  return { enabled: missing.length === 0, missing };
}

/** Bounded Claude Code worker invocation (only when explicitly enabled with a budget). */
async function runWorker(db, task, logFile, remainingMs) {
  const w = getWindow(db);
  const remainingBudget = LIMITS.budgetUsd - (w.spent_usd || 0);
  if (remainingBudget <= 0.01) return { outcome: 'usage', detail: 'Supervisor budget exhausted.' };
  if (w.worker_runs >= LIMITS.maxWorkerRuns) return { outcome: 'usage', detail: `Worker run cap (${LIMITS.maxWorkerRuns}) reached.` };
  db.prepare('UPDATE window SET worker_runs = worker_runs + 1 WHERE id = 1').run();
  const perTask = Math.min(remainingBudget, Number(ENV.SUPERVISOR_TASK_BUDGET_USD || 2));
  const cmd = ENV.SUPERVISOR_WORKER_CMD || 'claude';
  const args = ['-p', `${task.prompt}\n\nAcceptance criteria:\n${JSON.parse(task.acceptance_json).map((a) => `- ${a}`).join('\n')}\nCheck command: ${task.check_cmd}\nDo not run the supervisor. Do not push, deploy or contact anyone.`,
    '--output-format', 'json', '--max-turns', String(LIMITS.workerMaxTurns), '--max-budget-usd', perTask.toFixed(2),
    '--permission-mode', 'dontAsk', '--settings', path.join(here, 'worker-settings.json'), '--no-session-persistence'];
  const res = await runChild(cmd, args, { timeoutMs: Math.min(LIMITS.taskTimeoutMs, remainingMs), logFile });
  const text = fs.readFileSync(logFile, 'utf8');
  let json = null;
  try { json = JSON.parse(text.slice(text.lastIndexOf('\n{') + 1)); } catch { /* not json */ }
  if (json?.total_cost_usd) db.prepare('UPDATE window SET spent_usd = spent_usd + ? WHERE id = 1').run(json.total_cost_usd);
  if (json?.permission_denials?.length) return { outcome: 'permission', detail: `Worker hit ${json.permission_denials.length} permission denial(s).` };
  if ((json?.is_error || res.code !== 0) && USAGE_RE.test(text)) return { outcome: 'usage', detail: 'Usage/rate limit reported by worker.' };
  return { outcome: 'ran', detail: `worker exit ${res.code}${res.timedOut ? ' (timeout)' : ''}` };
}

// ---------------- Decisions & checkpoints ----------------
function openDecision(db, d) {
  db.prepare(`INSERT INTO decisions (id, task_id, title, why, recommendation, alternatives_json, resume, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(d.id, d.task_id, d.title, d.why, d.recommendation, JSON.stringify(d.alternatives || []), d.resume, nowIso());
}

export function buildCheckpoint(db, reason = 'scheduled') {
  const w = getWindow(db);
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY ord').all();
  const decisions = db.prepare("SELECT * FROM decisions WHERE status = 'pending' ORDER BY created_at").all();
  const lastAttempt = (id) => db.prepare('SELECT * FROM attempts WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(id);
  const now = Date.now();
  const L = [];
  L.push(`# Coding supervisor checkpoint — ${nowIso()}`, '');
  L.push('> No notification channel is configured. This checkpoint is saved locally only; nobody was notified.', '');
  L.push(`**Reason:** ${reason}  `);
  if (w) {
    L.push(`**Window:** started ${w.started_at}, deadline ${w.deadline_at} (${Math.max(0, Math.round((Date.parse(w.deadline_at) - now) / 60000))} min left), elapsed ${Math.round((now - Date.parse(w.started_at)) / 60000)} min  `);
    L.push(`**Worker:** ${workerStatus().enabled ? `Claude worker enabled, ${w.worker_runs}/${LIMITS.maxWorkerRuns} runs, ~$${(w.spent_usd || 0).toFixed(2)} of $${LIMITS.budgetUsd}` : `Claude worker disabled (${workerStatus().missing.join('; ')}) — verify-only mode`}`);
  }
  L.push('', '## What works (acceptance checks passed, with evidence)', '');
  const done = tasks.filter((t) => t.status === 'done');
  L.push(...(done.length ? done.map((t) => `- ✅ **${t.id}** ${t.title} — evidence: \`${path.relative(ROOT, t.evidence_path || '')}\``) : ['- Nothing verified yet.']));
  L.push('', '## Checks', '', '| Task | Status | Attempts | Last result |', '|---|---|---|---|');
  for (const t of tasks) {
    const a = lastAttempt(t.id);
    L.push(`| ${t.id} | ${t.status} | ${t.attempts} | ${a ? `${a.outcome} (exit ${a.exit_code ?? '—'})` : 'not run'} |`);
  }
  const blocked = tasks.filter((t) => t.status === 'blocked' || t.status === 'failed');
  L.push('', '## Blocked', '', ...(blocked.length ? blocked.map((t) => `- **${t.id}** ${t.title}: ${t.last_error || t.note || 'blocked'}`) : ['- Nothing blocked.']));
  const top = decisions[0];
  L.push('', '## The one decision', '');
  if (top) {
    L.push(`**${top.title}**`, '', top.why, '', `**Recommendation:** ${top.recommendation}`, '', '**Alternatives:**', ...JSON.parse(top.alternatives_json).map((a) => `- ${a}`), '');
    L.push('**Exact instruction to resume dependent work:**', '', '```bash', top.resume || 'npm run supervisor -- resume', '```');
    if (decisions.length > 1) L.push('', `Other pending decisions: ${decisions.slice(1).map((d) => d.title).join('; ')}`);
  } else L.push('No decision pending.');
  const independent = tasks.filter((t) => t.status === 'pending' && !t.requires_decision);
  L.push('', '## Can proceed without an answer', '', ...(independent.length ? independent.map((t) => `- ${t.id} ${t.title}`) : ['- All independent authorised tasks are complete; the supervisor stops instead of inventing work.']));
  L.push('', '## Resume', '', '```bash', 'npm run supervisor -- status', 'npm run supervisor -- resume --detach', '```', '');
  return { markdown: L.join('\n'), data: { at: nowIso(), reason, tasks: tasks.map((t) => ({ id: t.id, status: t.status, attempts: t.attempts })), pending_decisions: decisions.map((d) => d.id) } };
}

function writeCheckpoint(db, reason) {
  const { markdown, data } = buildCheckpoint(db, reason);
  fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(CHECKPOINT_DIR, `supervisor-${stamp}.md`), markdown);
  fs.writeFileSync(path.join(CHECKPOINT_DIR, 'supervisor-latest.md'), markdown);
  fs.writeFileSync(path.join(CHECKPOINT_DIR, 'supervisor-latest.json'), JSON.stringify({ markdown, ...data }, null, 2));
  db.prepare('UPDATE window SET last_checkpoint_at = ? WHERE id = 1').run(nowIso());
  ev(db, 'checkpoint', { reason });
  return markdown;
}

// ---------------- Loop ----------------
async function reconcile(db) {
  for (const t of db.prepare("SELECT * FROM tasks WHERE status = 'in_progress'").all()) {
    if (t.child_pid && isAlive(t.child_pid)) { log(`reconcile: killing orphaned child ${t.child_pid} of ${t.id}`); killGroup(t.child_pid, 'SIGKILL'); }
    // Re-verify instead of blindly redoing: if the acceptance check already passes, record completion once.
    log(`reconcile: ${t.id} was in progress; re-running its acceptance check`);
    const logFile = path.join(EVIDENCE_DIR, `${t.id}-reconcile-${Date.now()}.log`);
    fs.writeFileSync(logFile, `# reconcile check for ${t.id}\n$ ${t.check_cmd}\n`);
    const res = await runChild('sh', ['-c', t.check_cmd], { timeoutMs: LIMITS.taskTimeoutMs, logFile });
    if (res.code === 0) {
      db.prepare("UPDATE tasks SET status = 'done', evidence_path = ?, child_pid = NULL, finished_at = ?, note = 'completed on reconcile (no duplicate work)' WHERE id = ? AND status = 'in_progress'").run(logFile, nowIso(), t.id);
    } else {
      db.prepare("UPDATE tasks SET status = 'pending', child_pid = NULL, note = 'interrupted; requeued after reconcile' WHERE id = ? AND status = 'in_progress'").run(t.id);
    }
    db.prepare('INSERT INTO attempts (task_id, n, outcome, exit_code, evidence_path, started_at, finished_at, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(t.id, t.attempts, res.code === 0 ? 'passed-on-reconcile' : 'interrupted', res.code, logFile, nowIso(), nowIso(), 'reconcile');
    ev(db, 'reconciled', { task: t.id, passed: res.code === 0 });
  }
}

function nextEligible(db) {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY ord').all();
  const status = Object.fromEntries(tasks.map((t) => [t.id, t.status]));
  const pendingDecision = (id) => id && db.prepare("SELECT 1 FROM decisions WHERE id = ? AND status = 'pending'").get(id);
  for (const t of tasks) {
    if (t.status !== 'pending') continue;
    if (JSON.parse(t.depends_json).some((d) => status[d] !== 'done')) continue;
    if (pendingDecision(t.requires_decision)) {
      db.prepare("UPDATE tasks SET status = 'blocked', last_error = ? WHERE id = ?").run(`Waiting for decision ${t.requires_decision}`, t.id);
      continue;
    }
    return t;
  }
  // Unblock tasks whose decision has since been answered explicitly.
  for (const t of tasks.filter((x) => x.status === 'blocked' && x.requires_decision && !pendingDecision(x.requires_decision) && (x.last_error || '').startsWith('Waiting for decision'))) {
    db.prepare("UPDATE tasks SET status = 'pending', last_error = NULL WHERE id = ?").run(t.id);
    return nextEligible(db);
  }
  return null;
}

async function executeTask(db, t, remainingMs) {
  const n = t.attempts + 1;
  const startedAt = nowIso();
  db.prepare("UPDATE tasks SET status = 'in_progress', attempts = ?, started_at = ? WHERE id = ? AND status = 'pending'").run(n, startedAt, t.id);
  ev(db, 'task.started', { task: t.id, attempt: n });
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const logFile = path.join(EVIDENCE_DIR, `${t.id}-attempt${n}.log`);
  fs.writeFileSync(logFile, `# ${t.id}: ${t.title}\n# attempt ${n} at ${startedAt}\n# acceptance:\n${JSON.parse(t.acceptance_json).map((a) => `#  - ${a}`).join('\n')}\n`);
  const record = (outcome, code, detail, fp = null) => {
    db.prepare('INSERT INTO attempts (task_id, n, outcome, exit_code, fingerprint, evidence_path, started_at, finished_at, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(t.id, n, outcome, code, fp, logFile, startedAt, nowIso(), detail);
    ev(db, `task.${outcome}`, { task: t.id, attempt: n, detail });
  };

  if (t.kind === 'implement') {
    const ws = workerStatus();
    if (!ws.enabled) {
      db.prepare("UPDATE tasks SET status = 'blocked', attempts = attempts - 1, last_error = ? WHERE id = ?").run(`Claude worker disabled: ${ws.missing.join('; ')}`, t.id);
      openDecision(db, { id: 'enable-claude-worker', task_id: t.id, title: 'Enable the bounded Claude worker for implementation tasks?', why: `Task ${t.id} needs code changes by an unattended worker. ${ws.missing.join('; ')}.`, recommendation: 'Keep disabled tonight; implement during an attended session.', alternatives: ['Set SUPERVISOR_WORKER=claude and an explicit SUPERVISOR_MAX_BUDGET_USD, then resume.'], resume: 'SUPERVISOR_WORKER=claude SUPERVISOR_MAX_BUDGET_USD=<amount> npm run supervisor -- resume --detach' });
      record('blocked', null, 'worker disabled');
      return 'continue';
    }
    fs.appendFileSync(logFile, '\n# --- worker ---\n');
    const w = await runWorker(db, t, logFile, remainingMs);
    if (w.outcome === 'permission') { db.prepare("UPDATE tasks SET status = 'blocked', last_error = ? WHERE id = ?").run(w.detail, t.id); record('blocked', null, w.detail); return 'continue'; }
    if (w.outcome === 'usage') { db.prepare("UPDATE tasks SET status = 'pending', attempts = attempts - 1, note = ? WHERE id = ?").run(w.detail, t.id); record('usage-unavailable', null, w.detail); return 'usage_unavailable'; }
    if (stopping) return 'stopped';
  }

  fs.appendFileSync(logFile, `\n# --- acceptance check ---\n$ ${t.check_cmd}\n`);
  const child = runChild('sh', ['-c', t.check_cmd], { timeoutMs: Math.min(LIMITS.taskTimeoutMs, remainingMs), logFile });
  await sleep(10);
  if (currentChild) db.prepare('UPDATE tasks SET child_pid = ? WHERE id = ?').run(currentChild.pid, t.id);
  const res = await child;
  db.prepare('UPDATE tasks SET child_pid = NULL WHERE id = ?').run(t.id);
  const text = fs.readFileSync(logFile, 'utf8');
  fs.appendFileSync(logFile, `\n# exit code ${res.code}${res.signal ? ` signal ${res.signal}` : ''}${res.timedOut ? ' (timed out)' : ''}\n`);

  if (stopping || (res.signal && !res.timedOut)) {
    db.prepare("UPDATE tasks SET status = 'pending', attempts = attempts - 1, note = 'interrupted by stop/deadline' WHERE id = ? AND status = 'in_progress'").run(t.id);
    record('interrupted', res.code, 'stopped while running');
    return 'stopped';
  }
  if (res.code === 0) {
    db.prepare("UPDATE tasks SET status = 'done', evidence_path = ?, finished_at = ?, last_error = NULL, note = NULL WHERE id = ?").run(logFile, nowIso(), t.id);
    record('passed', 0, 'acceptance check passed');
    return 'continue';
  }
  const tail = text.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);
  if (res.code === 126 || PERMISSION_RE.test(text.slice(text.indexOf('# --- acceptance check')))) {
    db.prepare("UPDATE tasks SET status = 'blocked', last_error = ? WHERE id = ?").run(`Permission denied — not worked around. ${tail}`, t.id);
    record('blocked-permission', res.code, tail);
    return 'continue';
  }
  const fp = failureFingerprint(logFile, res.code);
  if (fp === t.last_fingerprint) {
    db.prepare("UPDATE tasks SET status = 'blocked', last_error = ? WHERE id = ?").run(`Identical failure repeated with no new evidence (fingerprint ${fp}); stopped retrying. ${tail}`, t.id);
    record('blocked-identical', res.code, tail, fp);
    return 'continue';
  }
  if (n >= LIMITS.maxAttempts) {
    db.prepare("UPDATE tasks SET status = 'failed', last_error = ?, last_fingerprint = ? WHERE id = ?").run(`Failed ${n} attempts. ${tail}`, fp, t.id);
    record('failed', res.code, tail, fp);
    return 'continue';
  }
  db.prepare("UPDATE tasks SET status = 'pending', last_error = ?, last_fingerprint = ? WHERE id = ?").run(tail, fp, t.id);
  record('failed-retryable', res.code, tail, fp);
  return 'continue';
}

let stopping = false;

async function runLoop() {
  if (ENV.LAB_SUPERVISOR_CHILD) { console.error('Refusing to run: already inside a supervisor child (no recursive supervisors).'); process.exit(3); }
  const db = openStore();
  const lock = acquireLock(db);
  if (!lock.ok) { console.error(`Supervisor already running (pid ${lock.pid}). Use "status" or "stop".`); process.exit(2); }
  const w = getWindow(db);
  if (!w) { console.error('No execution window. Use "start".'); releaseLock(db); process.exit(1); }
  if (Date.now() >= Date.parse(w.deadline_at)) {
    db.prepare("UPDATE window SET end_reason = 'deadline' WHERE id = 1").run();
    writeCheckpoint(db, 'deadline already passed at start');
    console.error(`Deadline ${w.deadline_at} has passed. Not running. Use "reset-window" to authorise a new window.`);
    releaseLock(db); process.exit(4);
  }
  db.prepare('UPDATE window SET stop_requested = 0, end_reason = NULL WHERE id = 1').run();
  const onSignal = (sig) => {
    if (stopping) return;
    stopping = true;
    log(`${sig} received: stopping child and saving state`);
    if (currentChild) killGroup(currentChild.pid);
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
  syncBacklog(db);
  ev(db, 'supervisor.started', { pid: process.pid });
  log(`started pid ${process.pid}; deadline ${w.deadline_at}; worker ${workerStatus().enabled ? 'enabled' : 'disabled (verify-only)'}`);
  await reconcile(db);

  const deadline = Date.parse(w.deadline_at);
  const deadlineTimer = setInterval(() => {
    db.prepare('UPDATE lock SET heartbeat_at = ? WHERE id = 1 AND pid = ?').run(nowIso(), process.pid);
    if (getWindow(db).stop_requested) onSignal('stop-request');
    if (Date.now() >= deadline && !stopping) { log('deadline reached'); stopping = 'deadline'; if (currentChild) killGroup(currentChild.pid); }
  }, 500);

  let reason = 'backlog_complete';
  for (;;) {
    if (stopping) { reason = stopping === 'deadline' ? 'deadline' : 'stopped'; break; }
    const cur = getWindow(db);
    if (Date.now() - Date.parse(cur.last_checkpoint_at || cur.started_at) >= CHECKPOINT_HOURS * 3600 * 1000) writeCheckpoint(db, `${CHECKPOINT_HOURS}h elapsed`);
    const t = nextEligible(db);
    if (!t) {
      const left = db.prepare("SELECT COUNT(*) n FROM tasks WHERE status NOT IN ('done')").get().n;
      reason = left ? 'nothing_eligible (remaining tasks are blocked/failed or need a decision)' : 'backlog_complete';
      break;
    }
    log(`task ${t.id} attempt ${t.attempts + 1}: ${t.title}`);
    const out = await executeTask(db, t, deadline - Date.now());
    const after = db.prepare('SELECT status FROM tasks WHERE id = ?').get(t.id).status;
    log(`task ${t.id} → ${after}`);
    if (out === 'usage_unavailable') { reason = 'usage_unavailable'; break; }
    if (out === 'stopped') { reason = stopping === 'deadline' ? 'deadline' : 'stopped'; break; }
  }
  clearInterval(deadlineTimer);
  db.prepare('UPDATE window SET end_reason = ? WHERE id = 1').run(reason);
  writeCheckpoint(db, `loop ended: ${reason}`);
  ev(db, 'supervisor.stopped', { reason });
  log(`stopped: ${reason}`);
  releaseLock(db);
  db.close();
  process.exit(0);
}

// ---------------- CLI ----------------
function argHours(args) { const i = args.indexOf('--hours'); return i >= 0 ? Number(args[i + 1]) : DEFAULT_HOURS; }

function createWindow(db, hours) {
  const start = new Date();
  const deadline = new Date(start.getTime() + hours * 3600 * 1000);
  db.prepare(`INSERT INTO window (id, started_at, deadline_at, hours, stop_requested, last_checkpoint_at, worker_runs, spent_usd)
    VALUES (1, ?, ?, ?, 0, ?, 0, 0) ON CONFLICT(id) DO UPDATE SET started_at = excluded.started_at, deadline_at = excluded.deadline_at,
    hours = excluded.hours, stop_requested = 0, last_checkpoint_at = excluded.last_checkpoint_at, worker_runs = 0, spent_usd = 0, end_reason = NULL`)
    .run(start.toISOString(), deadline.toISOString(), hours, start.toISOString());
  ev(db, 'window.created', { hours, deadline: deadline.toISOString() });
}

function launch(detach) {
  if (!detach) return runLoop();
  const logFile = path.join(HOME, 'supervisor.log');
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, ['--no-warnings', fileURLToPath(import.meta.url), 'run'], { detached: true, stdio: ['ignore', out, out], env: ENV, cwd: ROOT });
  child.unref();
  console.log(`Supervisor started in background (pid ${child.pid}). Log: ${path.relative(ROOT, logFile) || logFile}`);
  process.exit(0);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'run') return runLoop();
  const db = openStore();
  if (['start', 'resume', 'reset-window'].includes(cmd) && ENV.LAB_SUPERVISOR_CHILD) { console.error('Refusing: inside a supervisor child (no recursive supervisors).'); process.exit(3); }
  if (cmd === 'start' || cmd === 'resume') {
    const holder = lockHolder(db);
    if (holder) { console.error(`Supervisor already running (pid ${holder.pid}).`); process.exit(2); }
    const w = getWindow(db);
    if (cmd === 'start' && !w) createWindow(db, argHours(args));
    if (cmd === 'resume' && !w) { console.error('Nothing to resume: no window exists. Use "start".'); process.exit(1); }
    if (cmd === 'start' && w) console.log(`Reusing existing window (deadline ${w.deadline_at}). The deadline applies across restarts; use "reset-window" to authorise a new one.`);
    syncBacklog(db);
    db.close();
    return launch(args.includes('--detach'));
  }
  if (cmd === 'reset-window') {
    if (lockHolder(db)) { console.error('Stop the supervisor first.'); process.exit(2); }
    createWindow(db, argHours(args));
    console.log(`New ${argHours(args)}h window: deadline ${getWindow(db).deadline_at}`);
    return;
  }
  if (cmd === 'stop') {
    const holder = lockHolder(db);
    db.prepare('UPDATE window SET stop_requested = 1 WHERE id = 1').run();
    if (!holder) { console.log('Supervisor is not running.'); return; }
    process.kill(holder.pid, 'SIGTERM');
    for (let i = 0; i < 100 && isAlive(holder.pid); i++) await sleep(100);
    if (isAlive(holder.pid)) { console.error(`Supervisor ${holder.pid} did not exit in 10s; sending SIGKILL. State is recoverable via "resume".`); process.kill(holder.pid, 'SIGKILL'); }
    const kids = db.prepare("SELECT id, child_pid FROM tasks WHERE child_pid IS NOT NULL").all();
    for (const k of kids) if (isAlive(k.child_pid)) killGroup(k.child_pid, 'SIGKILL');
    console.log(`Stopped supervisor (pid ${holder.pid}). State saved; resume with: npm run supervisor -- resume --detach`);
    return;
  }
  if (cmd === 'status') {
    syncBacklog(db);
    const w = getWindow(db);
    const holder = lockHolder(db);
    console.log(`Running: ${holder ? `yes (pid ${holder.pid}, heartbeat ${holder.heartbeat_at})` : 'no'}`);
    if (w) console.log(`Window: ${w.started_at} → ${w.deadline_at} (${Math.max(0, Math.round((Date.parse(w.deadline_at) - Date.now()) / 60000))} min left)${w.end_reason ? `; last end: ${w.end_reason}` : ''}`);
    else console.log('Window: none (use "start")');
    const ws = workerStatus();
    console.log(`Claude worker: ${ws.enabled ? `enabled (budget $${LIMITS.budgetUsd}, ${w?.worker_runs || 0}/${LIMITS.maxWorkerRuns} runs, spent ~$${(w?.spent_usd || 0).toFixed(2)})` : `disabled — ${ws.missing.join('; ')}`}`);
    console.log('\nTasks:');
    for (const t of db.prepare('SELECT * FROM tasks ORDER BY ord').all()) {
      console.log(`  ${t.status.padEnd(11)} ${t.id.padEnd(26)} attempts ${t.attempts}  ${t.title}${t.last_error && t.status !== 'done' ? `\n              ↳ ${t.last_error.slice(0, 160)}` : ''}`);
    }
    const ds = db.prepare("SELECT * FROM decisions WHERE status = 'pending'").all();
    if (ds.length) { console.log('\nPending decisions:'); for (const d of ds) console.log(`  - ${d.id}: ${d.title}`); }
    return;
  }
  if (cmd === 'checkpoint') {
    if (!getWindow(db)) createWindow(db, DEFAULT_HOURS);
    syncBacklog(db);
    console.log(writeCheckpoint(db, 'manual'));
    return;
  }
  console.log('Usage: npm run supervisor -- <start [--hours 8] [--detach] | resume [--detach] | stop | status | checkpoint | reset-window [--hours N] | run>');
  process.exitCode = cmd ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
