// CLI for the business runtime (works with or without the server running; state is in SQLite).
//   npm run lab -- status
//   npm run lab -- review <business> <runId> approve|request_changes|hold ["notes"]
//   npm run lab -- checkpoint
//   npm run lab -- handoff <business> <runId>
import { openDb } from './db.js';
import { seedBusinesses } from './businesses.js';
import { reviewRun, runDetail } from './graph.js';
import { saveAppCheckpoint } from './checkpoint.js';
import { selectAdapter } from './adapters/index.js';

const [cmd, ...args] = process.argv.slice(2);
const store = openDb(process.env.LAB_DB || 'data/lab.db');
seedBusinesses(store);

try {
  if (cmd === 'status') {
    for (const b of store.listBusinesses()) {
      const s = store.forBusiness(b.id);
      console.log(`${b.name.padEnd(12)} ${JSON.stringify(s.countRunsByStatus())}`);
      for (const d of s.listDecisions()) console.log(`  pending: ${d.title} — run ${d.run_id}`);
    }
  } else if (cmd === 'review') {
    const [biz, runId, action, notes] = args;
    const r = reviewRun(store, biz, runId, { action, notes, decidedBy: 'Lea (CLI)' });
    console.log(`Recorded ${action}. Run is now ${r.status} at ${r.current_step}. The server's worker (or next start) continues it.`);
  } else if (cmd === 'checkpoint') {
    const { adapter, real } = selectAdapter({ store });
    const c = saveAppCheckpoint(store, { adapterStatus: { label: adapter.label, ...adapter.status() }, realStatus: real });
    console.log(c.markdown);
    console.log(`Saved to ${c.file} and the checkpoints table.`);
  } else if (cmd === 'handoff') {
    const d = runDetail(store, args[0], args[1]);
    console.log(d.handoff ? d.handoff.markdown : `No handoff yet (run is ${d.run.status}).`);
  } else {
    console.log('Usage: status | review <business> <runId> <approve|request_changes|hold> ["notes"] | checkpoint | handoff <business> <runId>');
    process.exitCode = cmd ? 1 : 0;
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
} finally {
  store.close();
}
