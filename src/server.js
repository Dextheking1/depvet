// DepVet web service. Plain node:http, no framework.
// GET / serves the page, GET /api/brief?repo=owner/name returns JSON.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { config, modelConfigured } from './config.js';
import { tavilyConfigured } from './sources/tavily.js';
import { parseRepoInput } from './sources/github.js';
import { buildBrief } from './brief.js';

const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const favicon = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8');
const cache = new Map();
const CACHE_MS = 15 * 60 * 1000;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page);
    return;
  }
  if (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
    res.end(favicon);
    return;
  }
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      tool: 'DepVet',
      version: '0.6.0',
      modelMode: modelConfigured() ? 'live' : 'mock',
      webEvidence: tavilyConfigured() ? 'live' : 'not-configured',
    }));
    return;
  }
  if (url.pathname === '/api/brief') {
    const parsed = parseRepoInput(url.searchParams.get('repo') || '');
    if (!parsed) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Give a GitHub repo link or owner/name.' }));
      return;
    }
    const key = `${parsed.owner}/${parsed.repo}`.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(hit.brief));
      return;
    }
    try {
      const brief = await buildBrief(parsed.owner, parsed.repo);
      if (!brief) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Repository not found on GitHub (or it is private).' }));
        return;
      }
      cache.set(key, { at: Date.now(), brief });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(brief));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Upstream problem: ${err.message}` }));
    }
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`DepVet listening on http://127.0.0.1:${config.port}`);
});
