# Business Agent Lab (MVP)

A local, business-scoped agent workflow for Lea's portfolio (NATEA, REWIRE, Polypreneur). It turns a client inquiry into a structured brief and a quality-reviewed response draft, waits for Lea's decision, then saves the approved version and writes a handoff for Maya, Lea's Chief of Staff. **Nothing is ever sent externally.**

> All client data in this repo is **fictional sample data**. Unless a real model is explicitly configured, all business outputs are **simulated** by a deterministic mock adapter. Both are labelled in the UI and in every handoff.

## Start

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`). There is no build step.

```bash
npm install
```

```bash
npm start
```

Open http://127.0.0.1:4317. Pick a business, click a **SAMPLE** inquiry (or paste your own), and watch the graph run. Then choose **Approve**, **Request changes** or **Hold**. After approval, use **Copy Markdown** on the Maya handoff.

Other commands:

```bash
npm test                     # 39 tests: workflow, separation, crash/restart, API, checkpoint, supervisor CLI
npm run e2e                  # Chromium journey + screenshots (docs/screenshots/)
npm run lab -- status        # queue + pending decisions from the CLI
npm run lab -- review <business> <runId> approve|request_changes|hold ["notes"]
npm run lab -- checkpoint    # write the business checkpoint (checkpoints/app-checkpoint-latest.md)
npm run demo                 # example outputs + handoffs in docs/examples/ (throwaway DB, simulated approval)
npm run supervisor -- start --hours 8 --detach | status | stop | resume --detach | checkpoint
```

## Workflow graph

```
capture → validate → load_context → classify → draft → quality_review ─┬─ pass ─→ await_decision ─┬─ approve ──────→ save_result → create_handoff → completed
                                                  ▲                     │                          ├─ request changes → (attempt n+1) → draft …
                                                  └── repair (≤2) ──────┤                          └─ hold → blocked (decision stays pending)
                                                                        └─ still failing → blocked + pending decision
step error → retry (≤2) → failed      credentials / budget / rate limit → blocked immediately (no retry)
```

Every step result, draft version, review decision, pending decision and event is persisted in `data/lab.db`. Nothing relies on chat history.

## Where things are

| Path | What |
|---|---|
| `src/db.js` | SQLite schema; `forBusiness(id)` scope enforces business separation |
| `src/graph.js` | Graph engine (leases, idempotent steps, repairs, retries), intake, review |
| `src/quality.js` | Deterministic quality review applied to every draft |
| `src/adapters/` | `mock.js` (default), `anthropic.js` (disabled without key and budget) |
| `src/businesses.js` | Business configs and labelled sample inquiries |
| `src/handoff.js`, `src/checkpoint.js` | Maya handoff; four-hour checkpoint |
| `src/server.js`, `public/` | HTTP API and dashboard |
| `supervisor/` | Coding supervisor, authorized backlog, narrow worker permissions |
| `checkpoints/` | Saved checkpoints and task evidence logs |
| `docs/STATUS.md` | What is implemented, mocked or blocked, plus assumptions |
| `docs/CHECKPOINT-REPORT.md` | Bundled decision checkpoint for Lea |
| `CLAUDE.md` | Project instructions: the loop, its limits and its rules |
