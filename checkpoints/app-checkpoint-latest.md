# Business runtime checkpoint — 2026-11-06T18:38:10.671Z

> No notification channel is configured. This checkpoint was saved locally only; nobody was notified.

**Adapter:** Mock adapter (deterministic rules, not a language model)  
**Real model:** disabled — ANTHROPIC_API_KEY not set; LAB_MAX_BUDGET_USD not configured (real-model path stays disabled without a budget); LAB_ADAPTER=anthropic not set

## Queue by business

| Business | queued | running | needs review | blocked | completed | failed |
|---|---|---|---|---|---|---|
| NATEA | 0 | 0 | 3 | 0 | 0 | 0 |
| REWIRE | 0 | 0 | 0 | 0 | 0 | 0 |
| Polypreneur | 0 | 0 | 0 | 0 | 0 | 0 |

## What works

- Inquiry → validate → context → classify → draft → quality review → decision → save → handoff (0 run(s) completed).
- Approve / request changes / hold with full draft history.
- Business-scoped data access; restart recovery; bounded repairs and retries.

## Blocked

- Nothing blocked.

## The one decision

**NATEA: Review draft v1 — "Accommodation for 8 workers near Ferrol (3 months)"**

Draft v1 passed quality review and awaits approve / request changes / hold.

**Recommendation:** Read the draft and approve if accurate (approval saves it for Maya; nothing is sent).

**Alternatives:**
- Request changes with notes (new attempt, history kept).
- Hold until more information arrives.

**To resume dependent work:**

- Dashboard: http://127.0.0.1:4317/#/natea/runs/6aa02313-c2b5-4f41-8008-64cadf25d497 → choose Approve, Request changes or Hold.

```bash
npm run lab -- review natea 6aa02313-c2b5-4f41-8008-64cadf25d497 approve
npm run lab -- review natea 6aa02313-c2b5-4f41-8008-64cadf25d497 request_changes "<your notes>"
npm run lab -- review natea 6aa02313-c2b5-4f41-8008-64cadf25d497 hold "<reason>"
```

## Other pending decisions (2)

- NATEA — Review draft v1 (International buyer looking for a home near Ferrol)
- NATEA — Review draft v1 (Local company: automate an administrative process)

## Can proceed without an answer

- New inquiries can be submitted and drafted in every business (mock adapter).
- Runs not waiting on a decision continue automatically.
- Coding supervisor tasks that do not depend on these decisions.
