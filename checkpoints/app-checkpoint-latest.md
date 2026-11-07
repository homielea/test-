# Business runtime checkpoint — 2026-11-07T07:11:43.461Z

> No notification channel is configured. This checkpoint was saved locally only; nobody was notified.

**Adapter:** Mock adapter (deterministic rules, not a language model)  
**Real model:** disabled — ANTHROPIC_API_KEY not set; LAB_MAX_BUDGET_USD not configured (real-model path stays disabled without a budget); LAB_ADAPTER=anthropic not set

## Queue by business

| Business | queued | running | needs review | blocked | completed | failed |
|---|---|---|---|---|---|---|
| NATEA | 0 | 0 | 0 | 0 | 3 | 0 |
| REWIRE | 0 | 0 | 0 | 0 | 0 | 0 |
| Polypreneur | 0 | 0 | 0 | 0 | 0 | 0 |

## What works

- Inquiry → validate → context → classify → draft → quality review → decision → save → handoff (3 run(s) completed).
- Approve / request changes / hold with full draft history.
- Business-scoped data access; restart recovery; bounded repairs and retries.

## Blocked

- Nothing blocked.

## The one decision

**Set up the Anthropic API key (budget of $3 already approved by Lea (in chat) on 2026-11-07)**

Real model is still disabled: ANTHROPIC_API_KEY not set; LAB_MAX_BUDGET_USD not configured (real-model path stays disabled without a budget); LAB_ADAPTER=anthropic not set. Mock mode continues until the key exists.

**Recommendation:** Create the key in your Anthropic account, then ask Claude to open the secure credential form; the key is never pasted into chat or printed.

**Alternatives:**
- Stay on mock indefinitely.
- Change the approved budget before enabling.

**To resume dependent work:**

```bash
LAB_ADAPTER=anthropic LAB_MAX_BUDGET_USD=3 npm start   (with the key available to the process)
```

## Other pending decisions (0)


## Can proceed without an answer

- New inquiries can be submitted and drafted in every business (mock adapter).
- Runs not waiting on a decision continue automatically.
- Coding supervisor tasks that do not depend on these decisions.
