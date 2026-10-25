// Model layer proof. No network and no real endpoint: global fetch is
// stubbed with Nemotron-shaped responses (a reasoning field plus, in
// the live case, real content). Covers the reasoning-only fallback and
// the per-stage max_tokens budgets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { classifyEvidence, writeVerdict } from '../src/model/route.js';

const FAST = 'stub-fast-model';
const STRONG = 'stub-strong-model';
const STUB_VERDICT_SUMMARY = 'STUB STRONG VERDICT: adopt with caution, stub rationale only.';

function core() {
  return {
    subject: { owner: 'expressjs', repo: 'express' },
    signals: {
      archived: false,
      daysSinceLastCommit: 10,
      advisoriesAffectingLatest: 0,
      advisoriesTotal: 2,
      hasLicense: true,
      latestReleaseDays: 30,
    },
    contradictions: [],
  };
}

function claims() {
  return [{ kind: 'security', text: 'critical remote code issue reported', source: 'https://example.com/advisory' }];
}

function stubFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });
    const data = handler(body);
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
  };
  return { fn, calls };
}

function completion(message) {
  return { choices: [{ message }] };
}

async function withModel(fn) {
  const savedFetch = globalThis.fetch;
  const saved = { ...config.model };
  config.model.baseUrl = 'http://127.0.0.1:9/stub';
  config.model.apiKey = 'dummy-key-not-a-secret';
  config.model.fast = FAST;
  config.model.strong = STRONG;
  config.model.fastMaxTokens = 2000;
  config.model.strongMaxTokens = 3000;
  try {
    return await fn();
  } finally {
    globalThis.fetch = savedFetch;
    Object.assign(config.model, saved);
  }
}

test('reasoning-only replies fall back honestly to the mock stand-ins', async () => {
  await withModel(async () => {
    // Both stages return reasoning with null content, the failure
    // shape a too-small output budget produces on a reasoning model.
    const { fn, calls } = stubFetch(() =>
      completion({ content: null, reasoning_content: 'long internal reasoning that ate the budget' }),
    );
    globalThis.fetch = fn;

    const classified = await classifyEvidence(claims());
    assert.equal(classified.mode, 'mock');
    assert.match(classified.note || '', /mock fallback/);
    assert.equal(classified.claims[0].classifiedBy, 'mock-fast-model');

    const verdictRes = await writeVerdict(core(), classified.claims);
    assert.equal(verdictRes.mode, 'mock');
    assert.match(verdictRes.note || '', /mock fallback/);
    assert.match(verdictRes.verdict.producedBy, /MOCK strong model/);
    assert.ok(!String(verdictRes.verdict.summary).includes('STUB STRONG'), 'stand-in output is never presented as live');

    assert.equal(calls.length, 2, 'both stages were attempted before falling back');
    assert.equal(calls[0].body.max_tokens, 2000);
    assert.equal(calls[1].body.max_tokens, 3000);
  });
});

test('empty string content also falls back instead of parsing as live output', async () => {
  await withModel(async () => {
    const { fn } = stubFetch(() => completion({ content: '', reasoning: 'reasoning only, empty content' }));
    globalThis.fetch = fn;
    const classified = await classifyEvidence(claims());
    assert.equal(classified.mode, 'mock');
    assert.equal(classified.claims[0].classifiedBy, 'mock-fast-model');
  });
});

test('live path: reasoning plus real content is used and budgets are sent per stage', async () => {
  await withModel(async () => {
    const { fn, calls } = stubFetch((body) => {
      if (body.model === FAST) {
        return completion({
          reasoning_content: 'classifying the one item as high risk',
          content: JSON.stringify([{ index: 0, riskTags: ['HIGH'] }]),
        });
      }
      return completion({
        reasoning_content: 'weighing the classified evidence',
        content: JSON.stringify({
          label: 'Adopt with caution',
          score: 42,
          summary: STUB_VERDICT_SUMMARY,
          rationale: ['stub rationale point'],
        }),
      });
    });
    globalThis.fetch = fn;

    const classified = await classifyEvidence(claims());
    assert.equal(classified.mode, 'live');
    assert.equal(classified.claims[0].classifiedBy, FAST);
    assert.deepEqual(classified.claims[0].riskTags, ['HIGH']);

    const verdictRes = await writeVerdict(core(), classified.claims);
    assert.equal(verdictRes.mode, 'live');
    assert.equal(verdictRes.verdict.summary, STUB_VERDICT_SUMMARY);
    assert.equal(verdictRes.verdict.producedBy, STRONG);

    // Fast stage first, strong stage second, each with its own budget.
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.model, FAST);
    assert.equal(calls[0].body.max_tokens, 2000);
    assert.equal(calls[1].body.model, STRONG);
    assert.equal(calls[1].body.max_tokens, 3000);
  });
});
