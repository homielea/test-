// Deterministic mock model adapter.
// PROVENANCE: every output is labelled `mock`. It does rule-based keyword classification and
// regex extraction — it is NOT a language model. It never invents facts: each known fact carries
// the exact quote from the inquiry it was extracted from.
//
// Fault injection (tests / demos only) via run options:
//   options.faults.quality_violations = N  -> first N drafts include a forbidden price/availability claim
//   options.faults.fail_step = { step, times, message } -> throw in that step `times` times

const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20 };
const NUMW = `(\\d+|${Object.keys(NUM).join('|')})`;
const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';
const PLACES = ['Ferrol', 'Narón', 'Naron', 'Fene', 'Neda', 'Ares', 'Mugardos', 'Pontedeume', 'A Coruña', 'Galicia'];
const COUNTRIES = ['Ireland', 'Germany', 'the Netherlands', 'Netherlands', 'France', 'the UK', 'England', 'Scotland', 'Norway', 'Sweden', 'Denmark', 'Poland', 'Portugal', 'Italy', 'Belgium', 'the US', 'Canada', 'Australia'];

const first = (text, re) => {
  const m = text.match(re);
  return m ? m[0].trim() : null;
};

/** Field extractors: return { value, evidence } where evidence is an exact substring of the text. */
const EXTRACTORS = {
  headcount: (t) => {
    const ev = first(t, new RegExp(`\\b${NUMW}\\s+(?:\\w+\\s){0,2}?(workers|employees|people|technicians|staff|persons)\\b`, 'i'));
    return ev ? { value: ev, evidence: ev } : null;
  },
  duration: (t) => {
    const ev = first(t, new RegExp(`\\b(?:about |around |for )?${NUMW}\\s+(months?|weeks?)\\b`, 'i'));
    return ev ? { value: ev.replace(/^for /i, ''), evidence: ev } : null;
  },
  start_date: (t) => {
    const ev = first(t, new RegExp(`\\b(?:starting|from|beginning)\\s+(?:(?:early|mid|late)\\s+)?(?:${MONTHS})\\b`, 'i'));
    return ev ? { value: ev, evidence: ev } : null;
  },
  area: (t) => {
    const near = t.match(/\b(close to|near|next to)\s+(?:the\s+)?[a-z\s]{3,25}?(?=[.,;]|\s+and\b|\s+ideally\b|$)/i);
    const at = t.match(/\b(?:at|in) the (shipyard|port|harbour|industrial estate) (?:in|of) [A-Z][\wñ]+/);
    const parts = [];
    const evidence = [];
    if (at) { parts.push(at[0]); evidence.push(at[0]); }
    if (near) { parts.push(near[0].trim()); evidence.push(near[0].trim()); }
    if (!parts.length) {
      const place = PLACES.find((p) => t.includes(p));
      if (!place) return null;
      parts.push(`mentions ${place}`); evidence.push(place);
    }
    return { value: parts.join('; '), evidence: evidence.join(' … ') };
  },
  room_setup: (t) => {
    const ev = first(t, /\b(individual|single|private|shared|separate)\s+(rooms?|bedrooms?|accommodation)\b/i);
    return ev ? { value: ev, evidence: ev } : null;
  },
  budget: (t) => {
    const ev = first(t, /(?:budget (?:of|is|around)?\s*)?(?:€|eur\b|euros?\b|\$|£)\s?\d[\d.,]*k?|\d[\d.,]*k?\s?(?:€|eur\b|euros?\b)/i)
      || first(t, /\bbudget (?:of|is|around) [^.,]{2,30}/i);
    return ev ? { value: ev, evidence: ev } : null;
  },
  contact_role: (t) => {
    const ev = first(t, /\b(?:I will|I'll|I am responsible for|I approve|decision maker)[^.]{0,60}/i);
    return ev ? { value: ev, evidence: ev } : null;
  },
  buyer_origin: (t) => {
    for (const c of COUNTRIES) {
      const ev = first(t, new RegExp(`\\b(?:are|am|we're|I'm|come)\\s+from\\s+${c.replace(/ /g, '\\s')}\\b`, 'i'));
      if (ev) return { value: c.replace(/^the /, ''), evidence: ev };
    }
    return null;
  },
  property_type: (t) => {
    const ev = first(t, /\b(house|apartment|flat|villa|farmhouse|plot of land|land|cottage)\b/i);
    return ev ? { value: ev.toLowerCase(), evidence: ev } : null;
  },
  bedrooms: (t) => {
    const ev = first(t, new RegExp(`\\b${NUMW}\\s*-?\\s*bed(?:room)?s?\\b`, 'i'));
    return ev ? { value: ev, evidence: ev } : null;
  },
  timeline: (t) => {
    const ev = first(t, /\b(next year|this year|next month|later this year|in \d+ months|within (?:a|one|two|\d+) (?:year|months?)|by (?:spring|summer|autumn|winter)(?: \d{4})?)\b/i);
    return ev ? { value: ev, evidence: ev } : null;
  },
  financing: (t) => {
    const ev = first(t, /\b(mortgage|cash buyers?|without financing|financ\w+)\b/i);
    return ev ? { value: ev, evidence: ev } : null;
  },
  process: (t) => {
    const ev = first(t, /\b(copying|entering|typing|re-?keying|processing|checking)\s+[^.]{5,120}/i);
    return ev ? { value: ev, evidence: ev } : null;
  },
  volume: (t) => {
    const ev = first(t, /\b(?:every (?:month|week|day)|monthly|weekly|daily)\b[^.\n]*?\b(?:\w+ (?:days?|hours?))\b/i)
      || first(t, /\b(?:every (?:month|week|day)|monthly|weekly|daily)\b/i);
    return ev ? { value: ev, evidence: ev } : null;
  },
  tools: (t) => {
    const found = ['email', 'spreadsheet', 'Excel', 'accounting software', 'ERP', 'paper forms', 'Google Sheets'].filter((x) => new RegExp(`\\b${x}\\b`, 'i').test(t));
    return found.length ? { value: found.join(', '), evidence: found.map((x) => first(t, new RegExp(`\\b${x}\\b`, 'i'))).join(' … ') } : null;
  },
  people: (t) => {
    const ev = first(t, new RegExp(`\\b${NUMW}\\s+(?:people|persons|colleagues)\\s+(?:are\\s+)?(?:involved|work on)\\b`, 'i'));
    return ev ? { value: ev, evidence: ev } : null;
  },
  goal: (t) => {
    const ev = first(t, /\b(we want to|our goal is|we would like to (?:save|reduce|cut|stop))[^.]{3,80}/i);
    return ev ? { value: ev, evidence: ev } : null;
  },
  constraints: () => null,
  org_size: (t) => {
    const ev = first(t, new RegExp(`\\b(?:around |about |of )?${NUMW}\\s+(people|employees|staff)\\b`, 'i'));
    return ev ? { value: ev, evidence: ev } : null;
  },
  problem: (t) => {
    const ev = first(t, /\b(roles are unclear|we struggle|problem is|challenge is|grown quickly)[^.]{0,80}/i);
    return ev ? { value: ev, evidence: ev } : null;
  },
  format: (t) => {
    const ev = first(t, /\b(podcast|interview|newsletter|article|video|webinar)\b/i);
    return ev ? { value: ev.toLowerCase(), evidence: ev } : null;
  },
  audience: (t) => {
    const ev = first(t, /\babout (solo founders|founders|entrepreneurs|[a-z ]{4,40}?)(?=[.,]| running| who)/i);
    return ev ? { value: ev, evidence: ev } : null;
  },
};

/** Observations: facts that are useful but not required fields. Also always grounded. */
function observations(text, contact) {
  const obs = [];
  const company = first(text, new RegExp(`\\b(?:small|large|family)?\\s*(?:workshop|company|business|subcontractor|firm)\\b[^.]{0,30}?\\b${NUMW}\\s+employees\\b`, 'i'));
  if (company) obs.push({ label: 'Company size mentioned', value: company, evidence: company });
  const greet = first(text, /\b(Buenos días|Buenas tardes|Hola|Bom dia|Guten Tag)\b/);
  if (greet) obs.push({ label: 'Greeting language', value: `Opens with "${greet}" — confirm preferred language`, evidence: greet });
  const legal = first(text, /\b(how buying works for foreigners|legal|tax|visa|residency|NIE)\b[^.?\n]{0,40}/i);
  if (legal) obs.push({ label: 'Legal / process question', value: `Client asks: "${legal}" — route to a qualified professional; do not answer`, evidence: legal });
  const pain = first(text, /\b(it is manual[^.\n]*|we make mistakes|error-prone|takes too long)/i);
  if (pain) obs.push({ label: 'Stated pain point', value: pain, evidence: pain });
  const role = first(text, /\n(Project Coordinator|Office manager|Operations Manager|CEO|Director)\b/i);
  if (role) obs.push({ label: 'Sender role (from signature)', value: role.trim(), evidence: role.trim() });
  if (contact?.company) obs.push({ label: 'Company (from contact record)', value: contact.company, evidence: null, source: 'contact record' });
  return obs;
}

const UNCLEAR = {
  id: 'unclear', label: 'Unclear request',
  required: [{ id: 'need', label: 'What is needed', question: 'Could you tell us a little more about what you need and by when?' }],
  next_actions: ['Ask the sender to clarify their request.', 'Lea decides whether it fits this business.'],
};

export function classifyDeterministic(business, text) {
  const lower = text.toLowerCase();
  const scores = business.categories.map((c) => {
    const hits = c.keywords.filter((k) => lower.includes(k));
    return { id: c.id, label: c.label, score: hits.length, hits };
  }).sort((a, b) => b.score - a.score);
  const top = scores[0];
  const second = scores[1] || { score: 0 };
  if (!top || top.score === 0) {
    return { category: UNCLEAR.id, label: UNCLEAR.label, confidence: 0.1, rationale: 'No category keywords matched.', scores };
  }
  const confidence = Math.min(0.95, Number((0.4 + 0.1 * (top.score - second.score) + 0.05 * top.score).toFixed(2)));
  return {
    category: top.id,
    label: top.label,
    confidence,
    rationale: `Keyword match (${top.hits.map((h) => `"${h}"`).join(', ')}) — ${top.score} hits vs ${second.score} for the next category.`,
    scores,
  };
}

export function categoryConfig(business, categoryId) {
  return business.categories.find((c) => c.id === categoryId) || UNCLEAR;
}

function greetingName(contact) {
  const n = (contact?.name || '').replace(/\s*\(fictional\)\s*/i, '').trim();
  if (!n) return 'Hello,';
  const firstName = n.split(/\s+/)[0];
  return `Dear ${firstName},`;
}

export function buildBriefAndDraft({ business, request, classification, feedback, attempt, repair, qualityIssues, faults, draftNumber = 1 }) {
  const text = request.body;
  const cat = categoryConfig(business, classification.category);
  const known = [];
  const missing = [];
  for (const field of cat.required) {
    const ex = EXTRACTORS[field.id]?.(text);
    if (ex) known.push({ field: field.id, label: field.label, value: ex.value, evidence: ex.evidence });
    else missing.push({ field: field.id, label: field.label, question: field.question });
  }
  const obs = observations(text, request.contact);
  const legalFlag = obs.some((o) => o.label.startsWith('Legal'));
  const shorter = /\b(short|shorter|concise|brief)\b/i.test(feedback || '');

  const lines = [];
  lines.push(greetingName(request.contact), '');
  if (!shorter) {
    lines.push(`Thank you for contacting ${business.name}. ${cat.id === 'unclear' ? 'We would like to understand your request better.' : `We have read your message about ${cat.label.toLowerCase()} and would be glad to look into it.`}`, '');
  }
  if (known.length) {
    lines.push('What we have understood so far:');
    for (const k of known) lines.push(`- ${k.label}: ${k.value}`);
    lines.push('');
  }
  if (missing.length) {
    lines.push(shorter ? 'A few questions:' : 'To prepare a useful answer, could you tell us:');
    missing.forEach((m, i) => lines.push(`${i + 1}. ${m.question}`));
    lines.push('');
  }
  if (legalFlag) {
    lines.push('Questions about the legal and tax side should be answered by a qualified local professional. We can help you get in touch with one, but we do not give legal advice ourselves.', '');
  }
  lines.push(shorter
    ? 'Once we have these details we will come back to you with a proposed next step.'
    : 'Once we have these details, we will come back to you with a proposed next step. We only propose options that we have checked first, so we will not make promises before that.', '');
  lines.push('Kind regards,', business.signature);

  let body = lines.join('\n');
  const injected = draftNumber <= (faults?.quality_violations || 0);
  if (injected) {
    // Deliberate defect for testing the repair loop (labelled in the output).
    body = body.replace('Kind regards,', 'Good news: we have a fully available 4-bedroom house for €1,200 per month, guaranteed.\n\nKind regards,');
  }

  const subject = `Re: ${request.title.replace(/\s*\(sample\)\s*/i, '')}`;
  const changes = [];
  if (repair > 0 && qualityIssues?.length) changes.push(`Repair ${repair}: regenerated after quality issues: ${qualityIssues.map((i) => i.id).join(', ')}`);
  if (attempt > 1 && feedback) {
    changes.push(`Revision attempt ${attempt} requested by reviewer: "${feedback}"`);
    changes.push(shorter ? 'Applied: shortened the introduction and closing.' : 'Mock adapter cannot rewrite prose beyond fixed rules (only "shorter/concise" is applied); reviewer note recorded for Maya.');
  }

  return {
    brief: {
      client: request.contact,
      business: business.name,
      category: classification.category,
      category_label: cat.label,
      summary: `${cat.label} inquiry from ${request.contact?.company || request.contact?.name || 'unknown sender'}.`,
      known_facts: known,
      observations: obs,
      missing_info: missing,
      next_actions: cat.next_actions,
      policy_reminders: business.policies,
      sample_data: !!request.is_sample,
    },
    response_draft: { subject, body, language: 'en' },
    questions: missing.map((m) => m.question),
    changes_from_previous: changes,
    reviewer_feedback_applied: feedback || null,
    fault_injected: injected || undefined,
  };
}

export function createMockAdapter() {
  const failCounts = new Map();
  const maybeFail = (step, ctx) => {
    const f = ctx.faults?.fail_step;
    if (!f || f.step !== step) return;
    const key = `${ctx.runId}:${step}`;
    const n = failCounts.get(key) || 0;
    if (n < (f.times ?? Infinity)) {
      failCounts.set(key, n + 1);
      throw new Error(f.message || `Injected mock failure in ${step}`);
    }
  };
  return {
    name: 'mock',
    provenance: 'mock',
    label: 'Mock adapter (deterministic rules, not a language model)',
    status() {
      return { available: true, mode: 'mock', reason: 'Deterministic mock — outputs are simulated, not model-generated.' };
    },
    async classify(ctx) {
      maybeFail('classify', ctx);
      return classifyDeterministic(ctx.business, ctx.request.body);
    },
    async draft(ctx) {
      maybeFail('draft', ctx);
      return buildBriefAndDraft(ctx);
    },
    async review(ctx) {
      maybeFail('quality_review', ctx);
      return { notes: ['Mock adapter: no semantic review performed. Deterministic policy checks only.'], provenance: 'mock' };
    },
  };
}
