# Checkpoint report for Lea — 2026-11-06 (first build session)

> Saved locally and committed. **No notification channel is configured, so nobody was notified.** Raw checkpoints: `checkpoints/app-checkpoint-latest.md` (business queue) and `checkpoints/supervisor-latest.md` (coding loop).

## What works

- **The full NATEA workflow, end to end:** inquiry → structured brief → quality-reviewed draft → your decision → saved approved version → Maya handoff. All three NATEA scenarios work in the dashboard and in tests. See `docs/examples/scenario-outputs.md`.
- **Review controls** (approve / request changes / hold), with full draft version history.
- **Business separation** is enforced in the data layer and the API. REWIRE and Polypreneur run the same shared capabilities on their own contexts.
- **Restart safety:** pending approvals survive restarts, killed workers resume without duplicate work, and repairs and retries are bounded.
- **The overnight coding supervisor** ran for real on the authorized backlog. It verified 9 of 10 tasks with saved evidence and stopped by itself when nothing eligible remained.

## Checks

| Check | Result |
|---|---|
| `npm test` (39 tests) | **passed** 39/39 |
| `npm run e2e` (Chromium journey, 9 steps) | **passed** 9/9 |
| Supervisor backlog T1–T5, T6, T7, T8, T9 | **passed** (evidence in `checkpoints/evidence/`) |
| T6b live real-model smoke test | **not run**: blocked on decision 2 |
| Real Claude worker invocation | **not run**: disabled (no budget); tested with a fake binary only |

## Blocked

- Real-model drafts and the T6b smoke test: no API key or budget is configured.
- The unattended Claude coding worker: disabled, because no budget was given.

## ★ The one decision: review the three NATEA drafts

They sit in your queue as **Needs review**: workers ×8, international buyer, automation. Each one passed every quality check: no prices, no availability claims, no legal conclusions, every fact quoted from the inquiry, and every missing item asked.

**Recommendation:** read the **8-workers** draft first and approve it if the tone is right. Approval saves it and creates Maya's handoff; nothing is sent. Use the same tone judgement on the other two.

**Alternatives:**
- **Request changes** with a note: this creates v2 and keeps v1. The mock only applies "shorter / concise" automatically; other notes are recorded for Maya.
- **Hold** any draft you want to discuss with Maya first. The decision stays pending.

**Exact instruction to resume:**

```bash
npm start
```

Then open http://127.0.0.1:4317, go to **NATEA**, open each run, and choose **Approve**, **Request changes** or **Hold**. If you're starting from a fresh machine, click the three **SAMPLE** buttons first to recreate the queue.

## Decision 2 (when you're ready): authorise real-model drafts?

**Recommendation:** decide after the drafts above. A **$2 cap** is enough for the smoke test and a handful of drafts.

**Alternatives:** stay mock-only for now, or set a larger cap.

```bash
export LAB_ADAPTER=anthropic LAB_MAX_BUDGET_USD=2
```

```bash
echo '{"authorize-real-model": "approved: $2 cap"}' > data/decisions-answered.json
```

```bash
npm run supervisor -- resume --detach
```

`ANTHROPIC_API_KEY` must already be in your shell; it is never printed. If the 8-hour window has ended, run `npm run supervisor -- reset-window --hours 8` first.

## What can proceed without your answer

- New inquiries in any business are drafted and queued for review (mock mode).
- Nothing else in the authorized backlog is waiting. The supervisor stopped rather than invent work.
