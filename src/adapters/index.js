// Adapter selection. The engine depends only on the adapter interface
// { name, provenance, label, status(), classify(ctx), draft(ctx), review(ctx) },
// so the model behind it is replaceable.
import { createMockAdapter } from './mock.js';
import { createAnthropicAdapter, anthropicStatus } from './anthropic.js';

export function selectAdapter({ store, env = process.env }) {
  const real = anthropicStatus(env);
  if (env.LAB_ADAPTER === 'anthropic' && real.available) {
    return { adapter: createAnthropicAdapter({ store, env }), real };
  }
  // Requested real mode but not authorised/configured: fall back to mock and say so.
  return { adapter: createMockAdapter(), real, fallbackReason: env.LAB_ADAPTER === 'anthropic' ? real.missing.join('; ') : null };
}
