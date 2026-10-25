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
const EXTRACT_TOP = 3;

export function tavilyConfigured() {
  return Boolean(config.tavilyApiKey);
}

// Query plan: incidents and compromises, maintenance state, and
// deprecation news. Pure function so the plan is unit-testable. The
// package name is quoted so the search engine anchors on the package
// itself, and the wording follows the package ecosystem (a PyPI
// package must not pull npm attack news). The relevance filter below
// is the second line of defence.
export function buildQueries(subject) {
  const { owner, repo } = subject;
  const pkg = subject.packageName || repo;
  const full = `${owner}/${repo}`;
  const eco =
    subject.ecosystem === 'PyPI'
      ? 'python package'
      : subject.ecosystem === 'npm'
        ? 'npm package'
        : 'software package';
  return [
    { id: 'incidents', query: `"${pkg}" ${eco} compromised OR malware OR hijacked OR backdoor`, topic: 'news' },
    { id: 'advisory', query: `"${pkg}" security advisory OR vulnerability OR CVE`, topic: 'news' },
    { id: 'maintenance', query: `${full} github deprecated OR unmaintained OR looking for maintainers OR archived`, topic: 'general' },
    { id: 'releases', query: `"${pkg}" ${eco} release OR changelog ${new Date().getFullYear()}`, topic: 'news' },
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

// Page chrome that rides along in Tavily content and extracts: nav
// labels, newsletter bait, reading-time stamps, icon alt text. A
// sentence carrying one of these is furniture, not evidence.
const CHROME_PATTERNS = [
  /skip to content/i,
  /\b\d+\s*min read\b/i,
  /newsletter/i,
  /follow us/i,
  /\bicon\b/i,
  /metadata\s*#/i,
  /perform that action at this time/i,
  /all rights reserved/i,
  /trusted (cybersecurity )?news platform/i,
  /reload to refresh your session/i,
  /you signed (out|in) (in|on) another/i,
  /you switched accounts/i,
  /navigation menu/i,
  /sign up for free/i,
  /metadata metadata/i,
  /no one assigned/i,
  /dismiss alert/i,
  /repository navigation/i,
  /copy link/i,
  /get the latest news/i,
];

// Evidence text cleaner. Strips markdown furniture and zero-width
// characters, then drops chrome sentences so what reaches the brief
// (and the model) is prose about the subject, not the page frame
// around it. Pure.
export function cleanEvidenceText(s, max = 400) {
  let t = String(s || '');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Markdown table bones: runs of pipes and dash separators are
  // layout, not words.
  t = t.replace(/\|+/g, ' ').replace(/(^|\s)-{3,}(?=\s|$)/g, ' ');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, ' ');
  // Zero-width marks, replacement chars, and private-use glyphs
  // (icon fonts) render as boxes or nothing; they are never content.
  t = t.replace(/[\u200B\uFEFF\uFFFD\uE000-\uF8FF]/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  const sentences = t.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [t];
  const kept = sentences.filter((x) => !CHROME_PATTERNS.some((p) => p.test(x)));
  if (kept.length) t = kept.join(' ').replace(/\s+/g, ' ').trim();
  return t.slice(0, max);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionsName(text, name) {
  if (!name || name.length < 3) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRe(name)}([^a-z0-9]|$)`, 'i').test(text);
}

// Context cues that make a bare name mention in a snippet count as
// evidence about the package, not about the English word.
const NAME_CUES = ['npm', 'pypi', 'python', 'node', 'javascript', 'typescript', 'github', 'package', 'library', 'dependency', 'registry', 'maintainer'];

// Relevance gate: is this result about THIS package? A result passes
// when its URL is the repo or the registry package page, when its
// title names the package, owner or repo, or when its text names one
// of them alongside a software context cue. Generic supply chain
// roundups (other packages' incidents) fail all three, which is the
// point: evidence about other packages is not evidence here. Pure.
export function isRelevantItem(item, subject) {
  const pkg = String(subject.packageName || subject.repo || '').toLowerCase();
  const owner = String(subject.owner || '').toLowerCase();
  const repo = String(subject.repo || '').toLowerCase();
  const url = String(item.url || '').toLowerCase();
  const title = String(item.title || '');
  const text = `${title} ${String(item.snippet || '')}`;
  if (owner && repo && url.includes(`${owner}/${repo}`)) return true;
  if (pkg && (url.includes(`/package/${pkg}`) || url.includes(`/project/${pkg}`))) return true;
  const names = [...new Set([pkg, repo, owner].filter(Boolean))];
  if (names.some((n) => mentionsName(title, n))) return true;
  if (names.some((n) => mentionsName(text, n)) && NAME_CUES.some((c) => text.toLowerCase().includes(c))) return true;
  return false;
}

// Maps one Tavily /search response body to evidence items. Pure.
export function normalizeSearchResults(body, queryId) {
  const results = Array.isArray(body?.results) ? body.results : [];
  return results
    .filter((r) => r && r.url && (r.title || r.content))
    .map((r) => ({
      title: cleanText(r.title, 200) || r.url,
      url: r.url,
      snippet: cleanEvidenceText(r.content, 400),
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
  const text = cleanEvidenceText(hit.raw_content, 600);
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
    // The claim carries the headline facts; the fuller text stays on
    // the item for the evidence card. Keeps the claims list readable.
    const body = cleanEvidenceText(item.excerpt || item.snippet, 260);
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
    // Relevance gate: only reports about this package count as
    // evidence. Generic ecosystem news is dropped here, not left for
    // the model (or the reader) to wade through.
    let items = [...byUrl.values()]
      .filter((item) => isRelevantItem(item, subject))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, MAX_ITEMS);

    // Extract the top pages so citations rest on full text, not only
    // on search snippets. Non-GitHub pages go first: GitHub issue and
    // commit extracts are mostly page chrome. Extract failure is
    // non-fatal.
    const isGithub = (u) => {
      try {
        return new URL(u).hostname.endsWith('github.com');
      } catch {
        return false;
      }
    };
    const top = [...items].sort((a, b) => Number(isGithub(a.url)) - Number(isGithub(b.url))).slice(0, EXTRACT_TOP);
    const extracted = await Promise.all(
      top.map(async (item) => {
        try {
          return applyExtract(item, await extractPage(item.url));
        } catch {
          return item;
        }
      }),
    );
    const byExtractedUrl = new Map(extracted.map((item) => [normaliseUrl(item.url), item]));
    items = items.map((item) => byExtractedUrl.get(normaliseUrl(item.url)) || item);

    return {
      status: 'live',
      note: items.length
        ? `Live web evidence from Tavily: ${items.length} package-specific reports across ${queries.length} searches (incidents, advisories, maintenance news).`
        : `Live web evidence from Tavily: ${queries.length} searches ran, but no package-specific reports were found. Structured sources (GitHub, OSV) carry this brief.`,
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
