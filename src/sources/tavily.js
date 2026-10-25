// Tavily live web evidence source. Keyed: searches and page extracts
// against https://api.tavily.com, configured purely by TAVILY_API_KEY.
// With no key the module reports itself not configured and the brief
// falls back to the structured sources, labelled as such. The prize
// rules require a functional runtime call to the Tavily API, so when a
// key is present this module really calls it on every brief.

import { config } from '../config.js';

const SEARCH_URL = 'https://api.tavily.com/search';
const EXTRACT_URL = 'https://api.tavily.com/extract';
const MAX_ITEMS = 8;
const EXTRACT_TOP = 2;

export function tavilyConfigured() {
  return Boolean(config.tavilyApiKey);
}

// Query plan: incidents and compromises, maintenance state, and
// deprecation news. Pure function so the plan is unit-testable.
export function buildQueries(subject) {
  const { owner, repo } = subject;
  const pkg = subject.packageName || repo;
  const full = `${owner}/${repo}`;
  return [
    { id: 'incidents', query: `${pkg} npm OR package compromised OR malware OR hijacked OR supply chain attack`, topic: 'news' },
    { id: 'advisory', query: `${pkg} security advisory OR vulnerability OR CVE`, topic: 'news' },
    { id: 'maintenance', query: `${full} github deprecated OR unmaintained OR looking for maintainers OR archived`, topic: 'general' },
    { id: 'releases', query: `${pkg} package release OR changelog ${new Date().getFullYear()}`, topic: 'news' },
  ];
}

function normaliseUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return String(u || '').toLowerCase();
  }
}

function cleanText(s, max = 400) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Maps one Tavily /search response body to evidence items. Pure.
export function normalizeSearchResults(body, queryId) {
  const results = Array.isArray(body?.results) ? body.results : [];
  return results
    .filter((r) => r && r.url && (r.title || r.content))
    .map((r) => ({
      title: cleanText(r.title, 200) || r.url,
      url: r.url,
      snippet: cleanText(r.content, 400),
      publishedDate: r.published_date || null,
      score: typeof r.score === 'number' ? r.score : null,
      queryId: queryId || null,
      via: 'tavily-search',
      excerpt: null,
    }));
}

// Applies an extract result to an item: the extract is the fuller,
// citable text behind the snippet. Pure.
export function applyExtract(item, extractBody) {
  const hit = (extractBody?.results || []).find((r) => normaliseUrl(r.url) === normaliseUrl(item.url));
  if (!hit) return item;
  const text = cleanText(hit.raw_content, 600);
  if (!text) return item;
  return { ...item, excerpt: text, via: 'tavily-search+extract' };
}

// Merges web evidence into the claims list as claim-level cited items,
// same shape as every other claim: { kind, text, source }. Pure: the
// input array is not mutated, duplicates by URL are dropped.
export function mergeWebEvidence(claims, webEvidence) {
  const items = webEvidence?.items || [];
  if (!items.length) return [...claims];
  const seen = new Set(claims.map((c) => normaliseUrl(c.source)));
  const webClaims = [];
  for (const item of items) {
    const key = normaliseUrl(item.url);
    if (seen.has(key)) continue;
    seen.add(key);
    const when = item.publishedDate ? `, ${String(item.publishedDate).slice(0, 10)}` : '';
    const body = item.excerpt || item.snippet;
    webClaims.push({
      kind: 'web',
      text: `Web report (${item.title}${when}): ${body}`,
      source: item.url,
    });
  }
  return [...claims, ...webClaims];
}

async function tavilyPost(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.tavilyApiKey}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Tavily API ${res.status} on ${url}: ${text.slice(0, 160)}`);
  }
  return res.json();
}

export async function searchWeb(query, { topic = 'news', maxResults = 5 } = {}) {
  const body = await tavilyPost(SEARCH_URL, {
    query,
    topic,
    search_depth: 'advanced',
    max_results: maxResults,
    include_answer: false,
    include_raw_content: false,
    // No time_range on purpose: an old compromise is still material
    // evidence for an adoption decision, and relevance ranking already
    // surfaces recent news first.
  });
  return normalizeSearchResults(body, null);
}

export async function extractPage(url) {
  return tavilyPost(EXTRACT_URL, {
    urls: [url],
    extract_depth: 'basic',
    format: 'text',
  });
}

// Orchestrator. Never throws: any failure becomes a labelled empty
// result so the brief still ships on structured sources alone.
export async function fetchWebEvidence(subject) {
  if (!tavilyConfigured()) {
    return {
      status: 'not-configured',
      note: 'Live web evidence is off: no TAVILY_API_KEY configured. Structured sources (GitHub, OSV) only in this brief.',
      queries: [],
      items: [],
    };
  }
  const queries = buildQueries(subject);
  try {
    const perQuery = await Promise.all(
      queries.map(async (q) => {
        const items = await searchWeb(q.query, { topic: q.topic });
        return items.map((item) => ({ ...item, queryId: q.id }));
      }),
    );
    const byUrl = new Map();
    for (const item of perQuery.flat()) {
      const key = normaliseUrl(item.url);
      const prev = byUrl.get(key);
      if (!prev || (item.score ?? 0) > (prev.score ?? 0)) byUrl.set(key, item);
    }
    let items = [...byUrl.values()]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, MAX_ITEMS);

    // Extract the top pages so citations rest on full text, not only
    // on search snippets. Extract failure is non-fatal.
    const top = items.slice(0, EXTRACT_TOP);
    const extracted = await Promise.all(
      top.map(async (item) => {
        try {
          return applyExtract(item, await extractPage(item.url));
        } catch {
          return item;
        }
      }),
    );
    items = [...extracted, ...items.slice(EXTRACT_TOP)];

    return {
      status: 'live',
      note: `Live web evidence from Tavily: ${items.length} reports across ${queries.length} searches (incidents, advisories, maintenance news).`,
      queries: queries.map((q) => q.query),
      items,
    };
  } catch (err) {
    return {
      status: 'error',
      note: `Live web evidence failed this run (${err.message}). Structured sources (GitHub, OSV) only in this brief.`,
      queries: queries.map((q) => q.query),
      items: [],
    };
  }
}
