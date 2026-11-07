import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SUP = path.join(here, '..', 'supervisor', 'supervisor.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } // zombie = exited
};

/** An isolated supervisor sandbox: its own home, backlog, checkpoints and cwd. */
function sandbox(tasks, decisions = []) {
  const dir = tmpDir('sup-test-');
  fs.writeFileSync(path.join(dir, 'backlog.json'), JSON.stringify({ tasks, decisions }));
  const env = { ...process.env, SUPERVISOR_HOME: path.join(dir, 'home'), SUPERVISOR_BACKLOG: path.join(dir, 'backlog.json'), SUPERVISOR_CHECKPOINT_DIR: path.join(dir, 'cp'), SUPERVISOR_CWD: dir };
  // The test deliberately launches an isolated supervisor; strip the marker so this works when the
  // test itself runs under the real supervisor. The sandbox has its own lock and backlog.
  delete env.LAB_SUPERVISOR_CHILD;
  delete env.SUPERVISOR_WORKER;
  delete env.SUPERVISOR_MAX_BUDGET_USD;
  const run = (args, extra = {}) => spawnSync(process.execPath, ['--no-warnings', SUP, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60000 });
  const db = () => new DatabaseSync(path.join(dir, 'home', 'supervisor.db'));
  const q = (sql, ...a) => { const d = db(); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
  const task = (id) => q('SELECT * FROM tasks WHERE id = ?', id)[0];
  const lockPid = () => q('SELECT pid FROM lock WHERE id = 1')[0]?.pid;
  const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (fn()) return true; } catch { /* db not ready */ } await sleep(100); } throw new Error('timeout waiting'); };
  return { dir, env, run, q, task, lockPid, waitFor };
}

// First run: create marker and hang; later runs: pass. Lets us interrupt and then resume.
const slowOnce = (name) => `if [ -f ${name}.marker ]; then echo verified-${name}; exit 0; fi; touch ${name}.marker; echo working; sleep 30`;

test('start --detach, status, duplicate refusal, stop (kills child), resume to completion', async () => {
  const s = sandbox([
    { id: 'A', title: 'slow once', check: slowOnce('a'), acceptance: ['passes after restart'] },
    { id: 'B', title: 'quick', check: 'echo ok-b', acceptance: ['prints ok'], depends_on: ['A'] },
  ]);
  const st = s.run(['start', '--hours', '1', '--detach']);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /started in background/);
  await s.waitFor(() => s.task('A')?.status === 'in_progress' && s.task('A').child_pid);
  const childPid = s.task('A').child_pid;
  assert.ok(alive(childPid));

  const status = s.run(['status']);
  assert.match(status.stdout, /Running: yes/);
  assert.match(status.stdout, /in_progress\s+A/);
  assert.match(status.stdout, /Claude worker: disabled/);

  const dup = s.run(['start', '--detach']);
  assert.equal(dup.status, 2, 'second instance refused');
  assert.match(dup.stderr, /already running/);

  const supPid = s.lockPid();
  const stop = s.run(['stop']);
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, /State saved/);
  assert.ok(!alive(supPid), 'supervisor exited');
  await s.waitFor(() => !alive(childPid), 5000);
  assert.equal(s.task('A').status, 'pending');
  assert.match(s.task('A').note, /interrupted/);
  assert.equal(s.task('A').attempts, 0, 'interrupted attempt is not counted as a failure');
  const deadlineBefore = s.q('SELECT deadline_at FROM window')[0].deadline_at;

  const res = s.run(['resume', '--detach']);
  assert.equal(res.status, 0, res.stderr);
  await s.waitFor(() => s.task('B')?.status === 'done' && !s.lockPid());
  assert.equal(s.task('A').status, 'done');
  assert.equal(s.q('SELECT deadline_at FROM window')[0].deadline_at, deadlineBefore, 'deadline survives restart');
  assert.equal(s.q('SELECT end_reason FROM window')[0].end_reason, 'backlog_complete');
  assert.match(fs.readFileSync(s.task('B').evidence_path, 'utf8'), /ok-b/);
  const cp = fs.readFileSync(path.join(s.dir, 'cp', 'supervisor-latest.md'), 'utf8');
  assert.match(cp, /What works/);
  assert.match(cp, /nobody was notified/);
});

test('SIGKILLed supervisor: resume kills the orphaned child and reconciles without redoing work', async () => {
  const s = sandbox([{ id: 'A', title: 'slow once', check: slowOnce('k'), acceptance: ['x'] }]);
  s.run(['start', '--hours', '1', '--detach']);
  await s.waitFor(() => s.task('A')?.child_pid);
  const childPid = s.task('A').child_pid;
  process.kill(s.lockPid(), 'SIGKILL');
  await sleep(300);
  assert.ok(alive(childPid), 'child survives in its own process group');
  assert.equal(s.task('A').status, 'in_progress');
  const r = s.run(['resume']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reconcile: killing orphaned child/);
  await s.waitFor(() => !alive(childPid), 5000);
  assert.equal(s.task('A').status, 'done');
  assert.match(s.task('A').note, /completed on reconcile/);
  assert.equal(s.q("SELECT COUNT(*) n FROM attempts WHERE task_id = 'A' AND outcome LIKE 'passed%'")[0].n, 1, 'completed exactly once');
});

test('deadline stops the loop, terminates the child, and blocks a later resume', async () => {
  const s = sandbox([{ id: 'A', title: 'hangs', check: 'echo start; sleep 60', acceptance: ['x'] }]);
  const t0 = Date.now();
  const r = s.run(['start', '--hours', String(2 / 3600)]); // 2-second window, foreground
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - t0 < 15000, 'stopped promptly');
  assert.match(r.stdout, /deadline reached/);
  assert.equal(s.q('SELECT end_reason FROM window')[0].end_reason, 'deadline');
  assert.equal(s.task('A').status, 'pending');
  const again = s.run(['resume']);
  assert.equal(again.status, 4);
  assert.match(again.stderr, /Deadline .* has passed/);
  const ps = spawnSync('sh', ['-c', "ps -eo stat=,args= | grep -v '^Z' | grep '[s]leep 60' || true"], { encoding: 'utf8' });
  assert.equal(ps.stdout.trim(), '', 'no leftover child');
});

test('identical failures stop retrying; changed evidence allows a retry; limit marks failed', () => {
  const s = sandbox([
    { id: 'same', title: 'always same error', check: 'echo boom >&2; exit 1', acceptance: ['x'] },
    { id: 'flaky', title: 'fails once then passes', check: 'n=$(cat f 2>/dev/null || echo 0); n=$((n+1)); echo $n > f; [ $n -ge 2 ] && echo fixed && exit 0; echo first-failure; exit 1', acceptance: ['x'] },
    { id: 'varying', title: 'different error each time', check: 'n=$(cat v 2>/dev/null || echo 0); n=$((n+1)); echo $n > v; echo error-$n; exit 1', acceptance: ['x'] },
  ]);
  const r = s.run(['start', '--hours', '1']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.task('same').status, 'blocked');
  assert.equal(s.task('same').attempts, 2);
  assert.match(s.task('same').last_error, /Identical failure repeated with no new evidence/);
  assert.equal(s.task('flaky').status, 'done');
  assert.equal(s.task('flaky').attempts, 2);
  assert.equal(s.task('varying').status, 'failed');
  assert.equal(s.task('varying').attempts, 3);
  assert.match(s.q('SELECT end_reason FROM window')[0].end_reason, /nothing_eligible/);
});

test('permission denial blocks the task instead of being worked around', () => {
  const s = sandbox([{ id: 'P', title: 'denied', check: 'echo "sh: ./deploy.sh: Permission denied" >&2; exit 126', acceptance: ['x'] }]);
  s.run(['start', '--hours', '1']);
  assert.equal(s.task('P').status, 'blocked');
  assert.equal(s.task('P').attempts, 1, 'not retried');
  assert.match(s.task('P').last_error, /Permission denied — not worked around/);
});

test('implementation tasks are blocked while the Claude worker is disabled; decision-gated tasks wait', () => {
  const s = sandbox([
    { id: 'impl', kind: 'implement', title: 'needs code', prompt: 'do it', check: 'true', acceptance: ['x'] },
    { id: 'gated', title: 'needs decision', requires_decision: 'd1', check: 'true', acceptance: ['x'] },
    { id: 'free', title: 'independent', check: 'echo free', acceptance: ['x'] },
  ], [{ id: 'd1', title: 'Pick one', why: 'because', recommendation: 'A', alternatives: ['B'], resume: 'echo resume' }]);
  const r = s.run(['start', '--hours', '1']);
  assert.equal(r.status, 0);
  assert.equal(s.task('impl').status, 'blocked');
  assert.match(s.task('impl').last_error, /Claude worker disabled: SUPERVISOR_WORKER=claude not set; SUPERVISOR_MAX_BUDGET_USD not configured/);
  assert.equal(s.task('gated').status, 'blocked');
  assert.equal(s.task('free').status, 'done', 'independent work proceeds');
  const cp = fs.readFileSync(path.join(s.dir, 'cp', 'supervisor-latest.md'), 'utf8');
  assert.match(cp, /## The one decision/);
  assert.match(cp, /Exact instruction to resume/);

  // An explicit answer file (never silence) unblocks the gated task on the next resume.
  fs.writeFileSync(path.join(s.dir, 'home', 'decisions-answered.json'), JSON.stringify({ d1: 'A' }));
  s.run(['reset-window', '--hours', '1']);
  s.run(['resume']);
  assert.equal(s.task('gated').status, 'done');
});

test('enabled worker is invoked with bounded flags; denials block; usage exhaustion stops cleanly', () => {
  const s = sandbox([
    { id: 'w1', kind: 'implement', title: 'denied worker', prompt: 'p', check: 'true', acceptance: ['x'] },
    { id: 'w2', kind: 'implement', title: 'rate limited', prompt: 'p', check: 'true', acceptance: ['x'] },
    { id: 'w3', kind: 'implement', title: 'never reached', prompt: 'p', check: 'true', acceptance: ['x'] },
  ]);
  const fake = path.join(s.dir, 'fake-claude.sh');
  fs.writeFileSync(fake, `#!/bin/sh
printf '%s\\n' "$@" > "${s.dir}/argv-$(date +%s%N).txt"
if [ -f "${s.dir}/denied-once" ]; then echo '{"type":"result","is_error":true,"result":"API Error: rate limit exceeded","total_cost_usd":0.01}'; exit 1; fi
touch "${s.dir}/denied-once"
echo '{"type":"result","is_error":false,"permission_denials":[{"tool_name":"Bash"}],"total_cost_usd":0.05}'
`);
  fs.chmodSync(fake, 0o755);
  const r = s.run(['start', '--hours', '1'], { SUPERVISOR_WORKER: 'claude', SUPERVISOR_MAX_BUDGET_USD: '1', SUPERVISOR_WORKER_CMD: fake });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.task('w1').status, 'blocked');
  assert.match(s.task('w1').last_error, /permission denial/);
  assert.equal(s.task('w2').status, 'pending', 'left for later, not failed');
  assert.equal(s.task('w3').status, 'pending', 'loop stopped instead of hammering the API');
  assert.equal(s.q('SELECT end_reason FROM window')[0].end_reason, 'usage_unavailable');
  const argv = fs.readdirSync(s.dir).filter((f) => f.startsWith('argv-')).map((f) => fs.readFileSync(path.join(s.dir, f), 'utf8'))[0];
  for (const flag of ['--max-turns', '--max-budget-usd', '--permission-mode', 'dontAsk', '--no-session-persistence', '--output-format', '--settings']) assert.ok(argv.includes(flag), flag);
  assert.ok(!argv.includes('dangerously'), 'no permission bypass');
  assert.ok(Math.abs(s.q('SELECT spent_usd FROM window')[0].spent_usd - 0.06) < 1e-9, 'spend tracked');
});

test('refuses to start inside a supervisor child (no recursive sessions)', () => {
  const s = sandbox([{ id: 'A', title: 'x', check: 'true', acceptance: ['x'] }]);
  const r = s.run(['start'], { LAB_SUPERVISOR_CHILD: '1' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /no recursive supervisors/);
});
