// GitHub public data source. Keyless: the public API works without a
// token, a token only raises the rate limit.

import { config } from '../config.js';

const API = 'https://api.github.com';

export function parseRepoInput(input) {
  if (!input) return null;
  let s = String(input).trim();
  s = s.replace(/^git@github\.com:/, '').replace(/\.git$/, '');
  const urlMatch = s.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2].replace(/\.git$/, '') };
  const plain = s.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (plain) return { owner: plain[1], repo: plain[2] };
  return null;
}

async function gh(pathname, { raw = false } = {}) {
  const headers = {
    'User-Agent': 'depvet',
    Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
  };
  if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;
  const res = await fetch(`${API}${pathname}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API ${res.status} on ${pathname}`);
  return { data: raw ? await res.text() : await res.json(), link: res.headers.get('link') || '' };
}

function lastPageFromLink(link) {
  const m = link.match(/[?&]page=(\d+)>;\s*rel="last"/);
  return m ? Number(m[1]) : null;
}

export async function fetchRepoFacts(owner, repo) {
  const base = `/repos/${owner}/${repo}`;
  const repoRes = await gh(base);
  if (!repoRes) return null;
  const r = repoRes.data;

  const [releaseRes, commitsRes, contribRes] = await Promise.all([
    gh(`${base}/releases/latest`).catch(() => null),
    gh(`${base}/commits?per_page=30`).catch(() => null),
    gh(`${base}/contributors?per_page=1&anon=true`).catch(() => null),
  ]);

  const commits = commitsRes ? commitsRes.data : [];
  const commitDates = commits
    .map((c) => c?.commit?.committer?.date)
    .filter(Boolean)
    .sort();
  let contributorCount = null;
  if (contribRes) {
    contributorCount = lastPageFromLink(contribRes.link) ?? contribRes.data.length;
  }

  return {
    owner,
    repo,
    url: r.html_url,
    description: r.description || '',
    homepage: r.homepage || '',
    primaryLanguage: r.language || null,
    stars: r.stargazers_count,
    forks: r.forks_count,
    watchers: r.subscribers_count ?? null,
    openIssues: r.open_issues_count,
    license: r.license ? { spdx: r.license.spdx_id, name: r.license.name } : null,
    archived: Boolean(r.archived),
    disabled: Boolean(r.disabled),
    isFork: Boolean(r.fork),
    createdAt: r.created_at,
    pushedAt: r.pushed_at,
    defaultBranch: r.default_branch,
    topics: r.topics || [],
    latestRelease: releaseRes
      ? {
          tag: releaseRes.data.tag_name,
          name: releaseRes.data.name || '',
          publishedAt: releaseRes.data.published_at,
          url: releaseRes.data.html_url,
        }
      : null,
    recentCommits: {
      fetched: commits.length,
      newestAt: commitDates.length ? commitDates[commitDates.length - 1] : null,
      oldestAt: commitDates.length ? commitDates[0] : null,
    },
    contributorCount,
    sourceUrl: r.html_url,
  };
}

// Reads a file at the repo root on the default branch, or null.
export async function fetchRepoFile(owner, repo, path) {
  const res = await gh(`/repos/${owner}/${repo}/contents/${path}`, { raw: true }).catch(() => null);
  return res ? res.data : null;
}

// Maps a repo to its registry package by reading real manifests.
export async function inferPackage(owner, repo, facts) {
  const candidates = [];
  const pkgJsonText = await fetchRepoFile(owner, repo, 'package.json');
  if (pkgJsonText) {
    try {
      const pkg = JSON.parse(pkgJsonText);
      if (pkg && pkg.name) {
        candidates.push({
          ecosystem: 'npm',
          name: pkg.name,
          manifestLicense: typeof pkg.license === 'string' ? pkg.license : pkg.license?.type || null,
          evidence: 'package.json name field',
        });
      }
    } catch {
      // Ignore a broken manifest.
    }
  }
  if (!candidates.length) {
    const pyproject = await fetchRepoFile(owner, repo, 'pyproject.toml');
    if (pyproject) {
      const m = pyproject.match(/\[project\][\s\S]*?^name\s*=\s*"([^"]+)"/m);
      if (m) {
        candidates.push({ ecosystem: 'PyPI', name: m[1], manifestLicense: null, evidence: 'pyproject.toml project name' });
      }
    }
  }
  if (!candidates.length) {
    const cargo = await fetchRepoFile(owner, repo, 'Cargo.toml');
    if (cargo) {
      const m = cargo.match(/\[package\][\s\S]*?^name\s*=\s*"([^"]+)"/m);
      if (m) {
        candidates.push({ ecosystem: 'crates.io', name: m[1], manifestLicense: null, evidence: 'Cargo.toml package name' });
      }
    }
  }
  if (!candidates.length && facts.primaryLanguage === 'Go') {
    const gomod = await fetchRepoFile(owner, repo, 'go.mod');
    if (gomod) {
      const m = gomod.match(/^module\s+(\S+)/m);
      if (m) {
        candidates.push({ ecosystem: 'Go', name: m[1], manifestLicense: null, evidence: 'go.mod module path' });
      }
    }
  }
  return candidates[0] || null;
}
