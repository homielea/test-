// Real model adapter (Anthropic Messages API via the official SDK).
// DISABLED unless ALL of these are configured explicitly:
//   LAB_ADAPTER=anthropic, ANTHROPIC_API_KEY (never printed), LAB_MAX_BUDGET_USD > 0
// Spend is estimated from response usage and persisted as events, so the budget holds across
// restarts. Rate-limit / auth / budget problems block the run instead of retrying.
import { BlockingError } from '../graph.js';
import { categoryConfig } from './mock.js';

export const MODEL = process.env.LAB_MODEL || 'claude-opus-5-5';
// USD per million tokens for the default model (input, output). Used for a conservative estimate.
const PRICE = { 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5] };

export function anthropicStatus(env = process.env) {
  const missing = [];
  if (!env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY not set');
  const budget = Number(env.LAB_MAX_BUDGET_USD || 0);
  if (!(budget > 0)) missing.push('LAB_MAX_BUDGET_USD not configured (real-model path stays disabled without a budget)');
  if (env.LAB_ADAPTER !== 'anthropic') missing.push('LAB_ADAPTER=anthropic not set');
  return { available: missing.length === 0, budget_usd: budget || null, model: MODEL, missing };
}

function spentUsd(store) {
  const rows = store.db.prepare("SELECT data_json FROM events WHERE type = 'model.usage'").all();
  return rows.reduce((s, r) => s + (JSON.parse(r.data_json).cost_usd || 0), 0);
}

const BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'known_facts', 'missing_info', 'next_actions', 'subject', 'body'],
  properties: {
    summary: { type: 'string' },
    known_facts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['field', 'label', 'value', 'evidence'], properties: { field: { type: 'string' }, label: { type: 'string' }, value: { type: 'string' }, evidence: { type: 'string' } } } },
    missing_info: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['field', 'label', 'question'], properties: { field: { type: 'string' }, label: { type: 'string' }, question: { type: 'string' } } } },
    next_actions: { type: 'array', items: { type: 'string' } },
    subject: { type: 'string' },
    body: { type: 'string' },
  },
};

const CLASSIFY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['category', 'confidence', 'rationale'],
  properties: { category: { type: 'string' }, confidence: { type: 'number' }, rationale: { type: 'string' } },
};

export function createAnthropicAdapter({ store, env = process.env }) {
  const st = anthropicStatus(env);
  let client = null;
  async function getClient() {
    if (!st.available) throw new BlockingError('CREDENTIALS', `Real model disabled: ${st.missing.join('; ')}`);
    if (!client) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      client = new Anthropic({ maxRetries: 1 });
    }
    return client;
  }

  async function call(ctx, system, user, schema) {
    const c = await getClient();
    if (spentUsd(store) >= st.budget_usd) throw new BlockingError('BUDGET', `Estimated spend reached LAB_MAX_BUDGET_USD=${st.budget_usd}.`);
    let resp;
    try {
      resp = await c.beta.messages.create({
        model: MODEL,
        max_tokens: 4000,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: { effort: 'low', format: { type: 'json_schema', schema } },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    } catch (e) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      if (e instanceof Anthropic.RateLimitError) throw new BlockingError('RATE_LIMIT', 'Model rate limit / usage unavailable; stopped cleanly.');
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new BlockingError('CREDENTIALS', 'Model credentials rejected.');
      throw e;
    }
    const [pin, pout] = PRICE[MODEL] || [10, 50];
    const cost = (resp.usage.input_tokens * pin + resp.usage.output_tokens * pout) / 1e6;
    store.logEvent(ctx.run.business_id, ctx.run.id, 'model.usage', { model: MODEL, input_tokens: resp.usage.input_tokens, output_tokens: resp.usage.output_tokens, cost_usd: cost });
    if (resp.stop_reason === 'refusal') throw new BlockingError('REFUSAL', 'Model declined the request.');
    const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return JSON.parse(text);
  }

  const contextBlock = (b) => `Business: ${b.name} — ${b.tagline}\nRegion: ${b.region}\nPolicies:\n${b.policies.map((p) => `- ${p}`).join('\n')}`;

  return {
    name: 'anthropic',
    provenance: 'model',
    label: `Real model (${MODEL})`,
    status: () => ({ ...st, mode: 'model' }),
    async classify(ctx) {
      const cats = ctx.business.categories.map((c) => `${c.id}: ${c.label}`).join('\n');
      const out = await call(ctx, `${contextBlock(ctx.business)}\nClassify the inquiry into exactly one category id, or "unclear".`, `Categories:\n${cats}\n\nInquiry:\n${ctx.request.body}`, CLASSIFY_SCHEMA);
      return { ...out, label: categoryConfig(ctx.business, out.category).label };
    },
    async draft(ctx) {
      const cat = categoryConfig(ctx.business, ctx.classification.category);
      const sys = `${contextBlock(ctx.business)}\nYou write a client brief and a reply draft for Lea to review. Known facts must quote the inquiry verbatim in "evidence". Ask each missing required field using exactly the provided question text. Never state prices, availability or legal conclusions. Sign as:\n${ctx.business.signature}`;
      const user = `Required fields:\n${cat.required.map((r) => `${r.id} | ${r.label} | ${r.question}`).join('\n')}\n\nInquiry from ${ctx.request.contact?.name || 'unknown'}:\n${ctx.request.body}` +
        (ctx.feedback ? `\n\nReviewer requested changes: ${ctx.feedback}` : '') +
        (ctx.qualityIssues?.length ? `\n\nFix these quality issues: ${JSON.stringify(ctx.qualityIssues)}` : '');
      const o = await call(ctx, sys, user, BRIEF_SCHEMA);
      return {
        brief: { client: ctx.request.contact, business: ctx.business.name, category: cat.id, category_label: cat.label, summary: o.summary, known_facts: o.known_facts, observations: [], missing_info: o.missing_info, next_actions: o.next_actions, policy_reminders: ctx.business.policies, sample_data: !!ctx.request.is_sample },
        response_draft: { subject: o.subject, body: o.body, language: 'en' },
        questions: o.missing_info.map((m) => m.question),
        changes_from_previous: ctx.feedback ? [`Reviewer feedback: ${ctx.feedback}`] : [],
        reviewer_feedback_applied: ctx.feedback || null,
      };
    },
    async review() {
      // Deterministic rules are authoritative; no extra model call to keep spend bounded.
      return { notes: ['Deterministic policy checks applied to model output.'], provenance: 'system' };
    },
  };
}
