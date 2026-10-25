// Central config. Everything model related comes from the environment so
// the same build runs against any OpenAI-compatible endpoint and switches
// to Nebius Token Factory by configuration alone.

import { readFileSync } from 'node:fs';

function loadLocalEnv() {
  // Tiny .env reader, good enough for this service. Real env vars win.
  try {
    const text = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    // No .env file is fine.
  }
}
loadLocalEnv();

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  port: Number(process.env.PORT || 8730),
  model: {
    baseUrl: (process.env.MODEL_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.MODEL_API_KEY || '',
    fast: process.env.MODEL_FAST || 'nvidia/nemotron-3-nano',
    strong: process.env.MODEL_STRONG || 'nvidia/nemotron-3-ultra',
    // Output budgets per stage. Nemotron models reason before they
    // answer, and the reasoning shares the output budget, so a small
    // cap can leave no room for visible content at all. Keep these
    // generous. Env overridable for tuning or for cheaper endpoints.
    fastMaxTokens: positiveInt(process.env.MODEL_FAST_MAX_TOKENS, 2000),
    strongMaxTokens: positiveInt(process.env.MODEL_STRONG_MAX_TOKENS, 3000),
  },
  githubToken: process.env.GITHUB_TOKEN || '',
  tavilyApiKey: process.env.TAVILY_API_KEY || '',
};

export function modelConfigured() {
  return Boolean(config.model.baseUrl && config.model.apiKey);
}
