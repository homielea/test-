# Status — implemented, mocked, blocked (2026-11-06)

## Implemented and verified

| Capability | Evidence |
|---|---|
| Graph capture → … → create_handoff, persisted per step | `test/workflow.test.js`, `test/scenarios.test.js` |
| Approve / request changes (new attempt, history kept) / hold | `test/workflow.test.js`, `test/api.test.js`, browser journey |
| Approval saves the exact approved version (v2 after a revision) | `request changes … approval saves v2` |
| Quality repair loop (≤2), then blocked with a pending decision | `repeated quality failure stops at the repair limit` |
| Step retry limit (≤2 retries), then failed | `repeated step errors reach the retry limit` |
| Business separation in the data layer and HTTP API | `test/separation.test.js`, `test/api.test.js` |
| Pending approval survives restart (also checked live with SIGTERM + restart) | `pending approval survives a restart` |
| SIGKILLed worker → resume without duplicate completion | `interrupted work (SIGKILL mid-run)…` |
| Concurrent workers never double-process | `two concurrent workers…` |
| Honest credential status, plus fallback to mock | `test/adapter.test.js`; dashboard badge |
| Four-hour checkpoint with one decision, alternatives, and resume commands | `test/checkpoint.test.js`; `checkpoints/*.md` |
| Supervisor start/stop/status/resume, deadline, orphan kill, identical-failure stop, permission block, worker flags, usage stop, recursion refusal | `test/supervisor.test.js` |
| Dashboard journey in Chromium, phone width, no console errors | `npm run e2e`; `docs/screenshots/` |
| Real overnight supervisor run on the authorized backlog | `checkpoints/evidence/*.log`, `checkpoints/supervisor-latest.md` |

**Check results:** `npm test` 39/39 passed · `npm run e2e` 9/9 passed · supervisor backlog 9/10 tasks done, with T6b blocked on a decision (no task failed).

## Mocked / simulated

- **All business outputs** (classification, brief, draft, review notes) come from `src/adapters/mock.js`: deterministic keyword rules and regex extraction, labelled **SIMULATED · mock**. It can only "revise" by shortening (when your note says shorter/concise); for other notes it records your request rather than rewriting the prose.
- **All client data** is fictional (`*.invalid` emails, "(fictional)" names), labelled **SAMPLE DATA**.
- **Example handoffs** in `docs/examples/` were approved by a labelled *demo harness*, not by Lea.
- The **Claude worker** path of the supervisor was only exercised with a fake `claude` binary in tests. It has not been run against the real CLI.

## Blocked (needs Lea)

| Item | Why | To unblock |
|---|---|---|
| Real-model drafts (`LAB_ADAPTER=anthropic`) | No `ANTHROPIC_API_KEY` and no budget configured. The path stays disabled without both. | See `docs/CHECKPOINT-REPORT.md` → decision 2 |
| T6b live model smoke test | Gated on decision `authorize-real-model` | Same |
| Unattended Claude coding worker | `SUPERVISOR_WORKER` and `SUPERVISOR_MAX_BUDGET_USD` not set (by design: no budget was given) | `SUPERVISOR_WORKER=claude SUPERVISOR_MAX_BUDGET_USD=<amount> npm run supervisor -- resume --detach` |

## Pending external actions (recorded, not done)

- Sending any approved draft to a client: manual, by Maya or Lea.
- Merging this branch to a shared branch, or deploying anywhere: not authorized.
- Notification channel for checkpoints: none configured. Checkpoints are saved locally only, and nothing claims delivery.

## Assumptions and decisions made

1. **Stack:** Node 22 + built-in `node:sqlite` + `node:http` + vanilla JS. No framework and no build, so the only dependency is the official Anthropic SDK (`@anthropic-ai/sdk@1.1.0`, lazy-loaded).
2. **eve evaluated, not used:** `eve@1.0.0-rc.6` (published 2026-11-05) requires Node ≥ 24 (we have 22.23), is a release candidate, and is built for Vercel/AI Gateway deployment and conversational agents. An explicit persisted graph with human review was smaller and easier to verify tonight. This can be revisited once eve is stable.
3. **SQLite** is the smallest suitable persistent store: single local file, transactions, unique constraints for idempotency.
4. **One run = one inquiry**, with attempts (Lea's revisions) and repairs (automatic quality fixes) as separate counters. Drafts are versioned per run and never overwritten.
5. **"Hold"** keeps the decision pending and the run `blocked` (`held_by_reviewer`). Lea can still approve or request changes later.
6. **Approval requires a passing quality review.** A draft that failed review can only get "Request changes" or "Hold".
7. **Quality review is deterministic and authoritative.** A model adapter may add notes but cannot override the rules.
8. **Cross-business access returns "not found"**, so a record's existence is not leaked, and the attempt is logged as `access.denied`.
9. **The default real model** is `claude-opus-5-5` at low effort, with server-side refusal fallback (`fallbacks: "default"`). Spend is estimated from token usage at $4 / $20 per MTok and checked before each call.
10. **Worker permissions** live in `supervisor/worker-settings.json`, passed via `--settings`, not in `.claude/settings.json`, so interactive sessions are unaffected.
11. **Wall-clock four-hour checkpoints** are measured from `window.last_checkpoint_at` in the supervisor DB, so they survive restarts. The business-runtime server likewise writes an app checkpoint whenever 4 h have elapsed since the last saved one (checked every minute, measured from the DB, so it survives restarts), and also on demand (dashboard button / CLI).
12. **Local state** (`data/*.db`) is gitignored. In this cloud container it disappears when the container is reclaimed. On your machine, `npm start` and clicking the three samples recreates the same queue.
