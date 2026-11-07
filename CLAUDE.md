# Business Agent Lab — project instructions

Read this before changing anything. It explains the two separate systems in this repo, the overnight loop, and its limits.

## Two systems, kept separate

| | Business workflow runtime | Coding supervisor |
|---|---|---|
| Purpose | Runs client inquiries through the agent graph for each business | Works through the authorized coding backlog overnight |
| Code | `src/`, `public/` | `supervisor/` |
| State | `data/lab.db` (SQLite) | `data/supervisor.db` (SQLite, separate file) |
| Start | `npm start` (dashboard on http://127.0.0.1:4317) | `npm run supervisor -- start --hours 8 --detach` |

The supervisor never reads or writes `data/lab.db`. The runtime never spawns Claude sessions.

## Business runtime rules

- Graph: `capture → validate → load_context → classify → draft → quality_review → await_decision → save_result → create_handoff` (`src/graph.js`).
- Quality failures loop back to `draft`, up to **2 repairs** per attempt. After that the run is `blocked` with a pending decision.
- Step errors are retried up to **2 times**, then the run is `failed`. Credential, budget and rate-limit errors block immediately and are never retried.
- **Approval saves the result. It never sends anything.** Request changes starts a new attempt; earlier drafts are kept.
- **Business separation lives in the data layer.** All business data goes through `store.forBusiness(id)` (`src/db.js`). Never query business tables directly from routes or UI code.
- The deterministic quality review (`src/quality.js`) runs on every draft, whatever the adapter. It rejects invented prices, availability claims, legal conclusions, ungrounded facts, unasked missing info and mentions of other businesses.
- Every output carries provenance (`mock` / `model` / `system`). Sample data is flagged `is_sample`. The UI and the handoff must show both labels.
- Do not invent property availability, prices, customer facts or legal conclusions, in code, sample data or prompts.

## Model adapter

- Default: `src/adapters/mock.js`. It is deterministic, rule-based, and labelled SIMULATED.
- Real: `src/adapters/anthropic.js` (official SDK). It is enabled only when **all** of these are set: `LAB_ADAPTER=anthropic`, `ANTHROPIC_API_KEY`, and `LAB_MAX_BUDGET_USD > 0`. Spend is estimated from usage and stored as `model.usage` events, so the budget holds across restarts.
- Never print secrets. Never add paid services or overages.

## Overnight coding loop (`supervisor/supervisor.js`)

```
select eligible task → [optional bounded Claude worker] → run acceptance check → inspect
   → done (evidence saved) | retry (new evidence) | blocked (identical failure / permission / decision) | failed (3 attempts)
   → checkpoint every 4h of wall-clock time → next task
```

- **Backlog:** `supervisor/backlog.json` is the only authorized work. Each task has acceptance criteria and a check command, and its evidence log is saved to `checkpoints/evidence/`. The loop stops once nothing is eligible. Do not add tasks to keep it busy.
- **Deadline:** set by `start --hours N` (default 8) and persisted. `resume` reuses it, so it holds across restarts. Only `reset-window` authorizes a new window.
- **Single instance:** a lock row holds the live pid. A second `start` is refused. The supervisor also refuses to start inside its own child processes (`LAB_SUPERVISOR_CHILD`), so it cannot recurse.
- **Children:** each check or worker runs in its own process group. Stop, deadline and timeout kill the whole group. After a crash, `resume` kills orphaned children and **re-runs the acceptance check before redoing anything**, so completed work is not repeated.
- **Retries:** up to 3 attempts per task. A failure with the same fingerprint as the previous one (check output plus git working-tree hash) blocks the task: there is no new evidence, so retrying would not help.
- **Permission denial** (exit 126, `Permission denied`, or worker `permission_denials`) blocks the task. Never work around it.
- **Usage:** if a rate or usage limit is reported, the loop stops cleanly and the task stays pending.
- **Claude worker:** disabled unless `SUPERVISOR_WORKER=claude` and `SUPERVISOR_MAX_BUDGET_USD > 0`. When enabled it runs `claude -p --max-turns 40 --max-budget-usd <per-task> --permission-mode dontAsk --settings supervisor/worker-settings.json --no-session-persistence --output-format json`. It is capped at `SUPERVISOR_MAX_WORKER_RUNS` (default 8) runs per window. It never uses `--dangerously-skip-permissions`.
- **Decisions:** decisions are persisted in the supervisor DB, and silence is never treated as approval. To answer one, Lea writes `data/decisions-answered.json` (`{"<decision-id>": "<answer>"}`) and resumes.
- **Notifications:** none is configured. Checkpoints are saved to `checkpoints/` and the DB only. Never claim delivery.

### Commands

```bash
npm run supervisor -- start --hours 8 --detach   # new window (or reuse existing deadline)
npm run supervisor -- status
npm run supervisor -- stop                       # SIGTERM → kills child group → saves state
npm run supervisor -- resume --detach            # reconcile in-progress work, continue
npm run supervisor -- checkpoint                 # write a checkpoint now
npm run supervisor -- reset-window --hours 8     # explicitly authorize a new window
```

## Authorized scope

Local implementation, project dependencies, local tests, sample data, documentation and local commits only. No public deploys, no merges to shared branches, no contacting people, no sending messages, no purchases, no production changes. Record such actions as pending in `docs/STATUS.md`.

## Checks

```bash
npm test        # node:test suite (unit, integration, crash/restart, supervisor CLI)
npm run e2e     # Chromium journey; screenshots in docs/screenshots/
```
