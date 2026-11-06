// Worker process used by the recovery test. It processes runs slowly so the parent can SIGKILL it mid-run.
import { openDb } from '../../src/db.js';
import { createMockAdapter } from '../../src/adapters/mock.js';
import { WorkflowEngine } from '../../src/graph.js';

const store = openDb(process.argv[2]);
const engine = new WorkflowEngine({ store, adapter: createMockAdapter(), stepDelayMs: Number(process.argv[3] || 150), leaseMs: 60000 });
process.send?.({ ready: true, owner: engine.owner });
await engine.runUntilIdle();
process.send?.({ done: true });
