<!-- EXAMPLE: approved by DEMO HARNESS (simulated approval — not Lea). Lea's real queue still awaits her decisions. -->
# Maya handoff — NATEA: Accommodation for 8 workers near Ferrol (3 months)

> **SAMPLE DATA** — fictional client and inquiry
> **SIMULATED — produced by the deterministic mock adapter, not a language model**
> **NOT SENT** — approval saved this draft only; nothing was sent to the client

| | |
|---|---|
| Business | NATEA |
| Run | `1bd17db4-e152-4ee5-aa78-7c4a1714350c` |
| Classification | Worker accommodation (worker_accommodation, confidence 0.95) |
| Approved version | v1 (attempt 1) |
| Approved by | DEMO HARNESS (simulated approval — not Lea) at 2026-11-06T18:35:30.790Z |
| Quality review | passed (100%) |

## Client brief

Worker accommodation inquiry from Nordwerk Marine Services GmbH (fictional).

- Contact: Jonas Albrecht (fictional), Nordwerk Marine Services GmbH (fictional) <jonas.albrecht@example.invalid>

### Known facts (quoted from the inquiry)

- **Number of people:** 8 workers — _"8 workers"_
- **Length of stay:** about three months — _"about three months"_
- **Start date:** starting early March — _"starting early March"_
- **Preferred area / work site:** at the shipyard in Ferrol; close to the work site — _"at the shipyard in Ferrol … close to the work site"_

### Observations

- **Sender role (from signature):** Project Coordinator
- **Company (from contact record):** Nordwerk Marine Services GmbH (fictional)

### Missing information (asked in the draft)

- Room setup
- Budget range
- Decision maker

## Proposed next actions for Maya

- [ ] Review the approved draft below and send it from the usual channel (manual — not automated).
- [ ] Confirm missing requirements with the client (questions in the draft).
- [ ] Lea/Maya check real accommodation options manually — no availability has been verified.
- [ ] Prepare a shortlist only from verified options once requirements are confirmed.

## Approved response draft

**Subject:** Re: Accommodation for 8 workers near Ferrol (3 months)

```text
Dear Jonas,

Thank you for contacting NATEA. We have read your message about worker accommodation and would be glad to look into it.

What we have understood so far:
- Number of people: 8 workers
- Length of stay: about three months
- Start date: starting early March
- Preferred area / work site: at the shipyard in Ferrol; close to the work site

To prepare a useful answer, could you tell us:
1. Do people need individual rooms, or is shared accommodation acceptable?
2. Do you have a budget range per person or in total?
3. Who will approve the booking and handle invoicing on your side?

Once we have these details, we will come back to you with a proposed next step. We only propose options that we have checked first, so we will not make promises before that.

Kind regards,
Lea
NATEA
```

## Guardrails

- Never state property availability, prices, rents or fees unless the client stated them.
- Never give legal, tax or immigration conclusions; offer to involve a qualified professional.
- Ask for missing information explicitly; do not assume it.
- Approval saves a draft for Maya; nothing is sent automatically.
