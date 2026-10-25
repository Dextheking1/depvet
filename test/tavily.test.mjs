// Tavily module unit proof. No network and no API key: the fixtures
// are recorded responses in the documented Tavily API shape (the
// event-stream compromise case), replayed through a stubbed fetch so
// the full module path, search, dedupe, extract and merge, is proven
// offline. When a real key lands, the same code runs live.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { config } from '../src/config.js';
import {
  buildQueries,
  normalizeSearchResults,
  applyExtract,
  mergeWebEvidence,
  fetchWebEvidence,
  tavilyConfigured,
  isRelevantItem,
  cleanEvidenceText,
} from '../src/sources/tavily.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const incidents = fixture('tavily-search-incidents.json');
const maintenance = fixture('tavily-search-maintenance.json');
const extract = fixture('tavily-extract.json');

test('query plan covers incidents, advisories, maintenance and releases', () => {
  const queries = buildQueries({ owner: 'dominictarr', repo: 'event-stream', packageName: 'event-stream' });
  assert.equal(queries.length, 4);
  assert.deepEqual(queries.map((q) => q.id), ['incidents', 'advisory', 'maintenance', 'releases']);
  assert.ok(queries[0].query.includes('event-stream'));
  assert.ok(queries[2].query.includes('dominictarr/event-stream'));
});

test('search results normalise to evidence items', () => {
  const items = normalizeSearchResults(incidents, 'incidents');
  assert.equal(items.length, 3);
  assert.equal(items[0].title, 'Popular npm package event-stream compromised to steal bitcoin wallets');
  assert.equal(items[0].publishedDate, '2018-11-26T09:14:00.000Z');
  assert.equal(items[0].score, 0.92);
  assert.equal(items[0].via, 'tavily-search');
  assert.match(items[0].snippet, /compromised/);
});

test('extract enriches the matching item only', () => {
  const items = normalizeSearchResults(incidents, 'incidents');
  const enriched = applyExtract(items[0], extract);
  assert.match(enriched.excerpt, /handed publish rights/);
  assert.equal(enriched.via, 'tavily-search+extract');
  const untouched = applyExtract(items[1], extract);
  assert.equal(untouched.excerpt, null);
});

test('merge appends cited web claims, deduped, without mutating the input', () => {
  const base = [
    { kind: 'maintenance', text: 'Repository facts.', source: 'https://github.com/dominictarr/event-stream' },
    { kind: 'security', text: 'OSV facts.', source: 'https://osv.dev/list?q=event-stream' },
  ];
  const items = [
    ...normalizeSearchResults(incidents, 'incidents'),
    ...normalizeSearchResults(maintenance, 'maintenance'),
  ];
  const merged = mergeWebEvidence(base, { items });
  // 3 incident items + 1 new maintenance item; the duplicate zdnet URL
  // (trailing slash variant) and the already-cited GitHub URL drop out.
  assert.equal(merged.length, base.length + 4);
  assert.equal(base.length, 2, 'input claims array must not be mutated');
  const webClaims = merged.filter((c) => c.kind === 'web');
  assert.equal(webClaims.length, 4);
  for (const c of webClaims) {
    assert.ok(c.source.startsWith('http'), 'every web claim carries its source URL');
    assert.match(c.text, /^Web report \(/);
  }
  assert.ok(webClaims.some((c) => c.source.includes('zdnet.com')));
  assert.ok(!webClaims.some((c) => c.source === 'https://github.com/dominictarr/event-stream'));
});

test('query plan anchors on the quoted package and follows the ecosystem', () => {
  const pypi = buildQueries({ owner: 'psf', repo: 'requests', packageName: 'requests', ecosystem: 'PyPI' });
  assert.ok(pypi[0].query.startsWith('"requests"'));
  assert.match(pypi[0].query, /python package/);
  assert.ok(!/npm/.test(pypi[0].query), 'a PyPI package must not pull npm wording');
  const npm = buildQueries({ owner: 'expressjs', repo: 'express', packageName: 'express', ecosystem: 'npm' });
  assert.match(npm[0].query, /npm package/);
});

test('relevance gate drops generic ecosystem news, keeps package reports', () => {
  const express = { owner: 'expressjs', repo: 'express', packageName: 'express', ecosystem: 'npm' };
  const generic = {
    title: 'Tensorlake npm Package Compromised to Deliver Credential-Stealing Worm',
    url: 'https://example-news.test/tensorlake-npm-compromised',
    snippet: 'A trusted news platform reports another npm supply chain attack.',
  };
  assert.equal(isRelevantItem(generic, express), false);
  const onTopic = {
    title: 'Express 5.3.0 released with security fixes',
    url: 'https://example.test/express-release',
    snippet: 'The Express team shipped the release.',
  };
  assert.equal(isRelevantItem(onTopic, express), true);
  const repoPage = { title: 'Issues', url: 'https://github.com/expressjs/express/issues/2499', snippet: '' };
  assert.equal(isRelevantItem(repoPage, express), true);
  // A common-word package name in a snippet needs a software cue.
  const requests = { owner: 'psf', repo: 'requests', packageName: 'requests', ecosystem: 'PyPI' };
  const collision = {
    title: 'Studio release notes: October 2026',
    url: 'https://example.test/studio-release-notes',
    snippet: 'The Requests workspace now distinguishes the requests you make from the ones you receive.',
  };
  assert.equal(isRelevantItem(collision, requests), false);
  const pythonReport = {
    title: 'Advisory database roundup',
    url: 'https://example.test/advisory-roundup',
    snippet: 'The Python requests library shipped a fix for a session handling flaw.',
  };
  assert.equal(isRelevantItem(pythonReport, requests), true);
});

test('evidence text cleaner strips markdown and page chrome', () => {
  const raw =
    '## Metadata ## No one assigned. Skip to content and read the docs. The package was compromised in 2018 when publish rights changed hands. Join our newsletter for updates. See [the advisory](https://example.test/a) for details.';
  const cleaned = cleanEvidenceText(raw, 400);
  assert.match(cleaned, /compromised in 2018/);
  assert.match(cleaned, /See the advisory for details/);
  assert.ok(!/Skip to content/.test(cleaned));
  assert.ok(!/newsletter/i.test(cleaned));
  assert.ok(!/##/.test(cleaned));
});

test('evidence text cleaner drops GitHub page frame fragments', () => {
  const raw =
    'Metadata Metadata No one assigned Labels question. The answer depends on what you are using that for. Can you post some examples of the failing call? Dismiss alert and copy link to share.';
  const cleaned = cleanEvidenceText(raw, 400);
  assert.match(cleaned, /answer depends on what you are using that for/);
  assert.ok(!/No one assigned/.test(cleaned));
  assert.ok(!/Dismiss alert/.test(cleaned));
});

test('evidence text cleaner drops session chrome and icon glyphs', () => {
  const raw =
    'You signed out in another tab or window. Reload to refresh your session. The maintainer shipped a fix in version 2.0. 70+ million downloads this week.';
  const cleaned = cleanEvidenceText(raw, 400);
  assert.match(cleaned, /maintainer shipped a fix/);
  assert.ok(!/signed out/i.test(cleaned));
  assert.ok(!/[\uE000-\uF8FF]/.test(cleaned));
});

test('no key means an honest not-configured result', async () => {
  const saved = config.tavilyApiKey;
  config.tavilyApiKey = '';
  try {
    assert.equal(tavilyConfigured(), false);
    const web = await fetchWebEvidence({ owner: 'expressjs', repo: 'express', packageName: 'express' });
    assert.equal(web.status, 'not-configured');
    assert.equal(web.items.length, 0);
    assert.match(web.note, /no TAVILY_API_KEY configured/i);
  } finally {
    config.tavilyApiKey = saved;
  }
});

test('full module path against recorded fixtures: live status, dedupe, extract', async () => {
  const savedKey = config.tavilyApiKey;
  const savedFetch = globalThis.fetch;
  config.tavilyApiKey = 'fixture-key-not-a-secret';
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (String(url).endsWith('/search')) {
      return ok(body.query.includes('compromised') ? incidents : maintenance);
    }
    if (String(url).endsWith('/extract')) return ok(extract);
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  try {
    assert.equal(tavilyConfigured(), true);
    const web = await fetchWebEvidence({ owner: 'dominictarr', repo: 'event-stream', packageName: 'event-stream' });
    assert.equal(web.status, 'live');
    assert.equal(web.queries.length, 4);
    const urls = web.items.map((i) => i.url.replace(/\/$/, '').toLowerCase());
    assert.equal(new Set(urls).size, urls.length, 'items are deduped by normalised URL');
    assert.ok(web.items.length >= 4);
    const top = web.items[0];
    assert.ok(top.url.includes('zdnet.com'), 'highest scored report ranks first');
    assert.match(top.excerpt || '', /handed publish rights/);
    assert.equal(top.via, 'tavily-search+extract');
    // And the merged claims carry the incident as cited web evidence.
    const merged = mergeWebEvidence([], web);
    assert.ok(merged.some((c) => c.kind === 'web' && /compromised/.test(c.text)));
  } finally {
    globalThis.fetch = savedFetch;
    config.tavilyApiKey = savedKey;
  }
});
