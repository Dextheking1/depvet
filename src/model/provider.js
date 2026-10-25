// Model provider layer. One OpenAI-compatible chat client, configured
// purely by environment variables, so the identical code talks to Nebius
// Token Factory in production and to any compatible endpoint in dev.

import { config, modelConfigured } from '../config.js';

export async function chatCompletion({ model, system, user, temperature = 0.2, maxTokens }) {
  if (!modelConfigured()) {
    throw new Error('model endpoint not configured');
  }
  const payload = {
    model,
    temperature,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  // Send an explicit output budget when the caller sets one. Reasoning
  // models spend part of that budget on their reasoning field first.
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    payload.max_tokens = maxTokens;
  }
  const res = await fetch(`${config.model.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.model.apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`model call failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  const message = body.choices?.[0]?.message || {};
  const content = typeof message.content === 'string' ? message.content : '';
  if (!content.trim()) {
    // Reasoning models can spend the whole output budget on the
    // reasoning field (reasoning_content or reasoning) and return
    // empty or null content. That is a failed stage, not an empty
    // answer. Throw so the caller falls back honestly and keeps the
    // mock stamp instead of presenting a stand-in as live output.
    const reasoning = message.reasoning_content || message.reasoning || '';
    const hint = reasoning ? ' (reasoning present, content empty)' : '';
    throw new Error(`model returned empty content${hint}`);
  }
  return content;
}
