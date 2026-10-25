// Model provider layer. One OpenAI-compatible chat client, configured
// purely by environment variables, so the identical code talks to Nebius
// Token Factory in production and to any compatible endpoint in dev.

import { config, modelConfigured } from '../config.js';

export async function chatCompletion({ model, system, user, temperature = 0.2 }) {
  if (!modelConfigured()) {
    throw new Error('model endpoint not configured');
  }
  const res = await fetch(`${config.model.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.model.apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`model call failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  return body.choices?.[0]?.message?.content || '';
}
