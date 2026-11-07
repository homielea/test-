// Deterministic quality review. Runs for every draft regardless of adapter, so the guarantees
// (no invented prices/availability, no legal conclusions, grounded facts, missing info asked,
// no cross-business leakage) do not depend on model behaviour.

const CURRENCY = /(?:€|\$|£)\s?\d[\d.,]*k?|\d[\d.,]*k?\s?(?:€|eur\b|euros?\b|usd\b|gbp\b)|\bper (?:month|night|week)\b/gi;
const AVAILABILITY = /\b(we have (?:a|an|several|some|many|\d+)|is (?:currently )?available|are (?:currently )?available|fully available|guarantee(?:d)?|in stock|ready to move in|we can offer you (?:a|an|\d+))\b/i;
const LEGAL = /\b(legally|you are entitled|the law (?:requires|allows|says)|is (?:perfectly )?legal|tax[- ]free|exempt from|you (?:do not|don't) need (?:a|an) (?:visa|permit|licen[cs]e|NIE)|no visa (?:is )?(?:needed|required))\b/i;
const SENT_CLAIM = /\b(we have (?:booked|reserved|sent|signed)|has been booked|is confirmed|contract (?:is )?attached)\b/i;

export const MAX_BODY_CHARS = 2500;

export function reviewDraft({ business, otherBusinessNames = [], request, draft }) {
  const body = draft?.response_draft?.body || '';
  const inquiry = request.body;
  const checks = [];
  const add = (id, label, passed, detail) => checks.push({ id, label, passed, detail });

  // 1. Prices: any currency/rate expression must already appear in the client's inquiry.
  const prices = [...body.matchAll(CURRENCY)].map((m) => m[0]);
  const invented = prices.filter((p) => !inquiry.toLowerCase().includes(p.toLowerCase()));
  add('no_invented_prices', 'No prices or rates the client did not state', invented.length === 0,
    invented.length ? `Found: ${invented.join(', ')}` : 'No unstated prices.');

  // 2. Availability claims.
  const avail = body.match(AVAILABILITY);
  add('no_availability_claims', 'No property or accommodation availability claims', !avail,
    avail ? `Found: "${avail[0]}"` : 'No availability claims.');

  // 3. Legal / tax conclusions.
  const legal = body.match(LEGAL);
  add('no_legal_conclusions', 'No legal, tax or immigration conclusions', !legal,
    legal ? `Found: "${legal[0]}"` : 'No legal conclusions.');

  // 4. Nothing implies an action was already taken externally.
  const sent = body.match(SENT_CLAIM);
  add('no_external_action_claims', 'Does not claim bookings, reservations or sending', !sent,
    sent ? `Found: "${sent[0]}"` : 'No external-action claims.');

  // 5. Every missing-information item is asked in the draft.
  const missing = draft?.brief?.missing_info || [];
  const unasked = missing.filter((m) => !body.includes(m.question));
  add('asks_missing_info', 'Asks for every missing piece of information', unasked.length === 0,
    unasked.length ? `Not asked: ${unasked.map((m) => m.label).join(', ')}` : `${missing.length} question(s) asked.`);

  // 6. Known facts are grounded in the inquiry (exact evidence quotes).
  const facts = draft?.brief?.known_facts || [];
  const ungrounded = facts.filter((f) => !f.evidence || f.evidence.split(' … ').some((q) => !inquiry.includes(q)));
  add('facts_grounded', 'Every known fact is quoted from the inquiry', ungrounded.length === 0,
    ungrounded.length ? `Ungrounded: ${ungrounded.map((f) => f.label).join(', ')}` : `${facts.length} fact(s) grounded.`);

  // 7. Business context separation: no other business is mentioned.
  const leaked = otherBusinessNames.filter((n) => new RegExp(`\\b${n}\\b`, 'i').test(body));
  add('business_scope', `Stays within ${business.name} context`, leaked.length === 0,
    leaked.length ? `Mentions other business: ${leaked.join(', ')}` : 'No other business mentioned.');

  // 8. Shape.
  const okLen = body.trim().length > 40 && body.length <= MAX_BODY_CHARS;
  add('length', `Body present and under ${MAX_BODY_CHARS} characters`, okLen, `${body.length} characters.`);

  const failed = checks.filter((c) => !c.passed);
  return {
    passed: failed.length === 0,
    score: Number(((checks.length - failed.length) / checks.length).toFixed(2)),
    checks,
    issues: failed.map((c) => ({ id: c.id, detail: c.detail })),
    reviewer: 'deterministic-rules',
  };
}
