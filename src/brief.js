// Brief assembly. Deterministic facts first, every claim carries a
// source, contradictions are computed by cross-source rules, and the
// model layer only classifies and judges what the facts say.

import { fetchRepoFacts, fetchRepoFile, inferPackage } from './sources/github.js';
import { fetchAdvisories } from './sources/osv.js';
import { fetchWebEvidence, mergeWebEvidence } from './sources/tavily.js';
import { classifyEvidence, writeVerdict } from './model/route.js';
import { config } from './config.js';

function daysBetween(thenIso, now = new Date()) {
  if (!thenIso) return null;
  return Math.floor((now - new Date(thenIso)) / 86400000);
}

// Display formatting only: thousand separators in generated text.
function fmtInt(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString('en-US') : String(n);
}

export async function buildBrief(owner, repo) {
  const facts = await fetchRepoFacts(owner, repo);
  if (!facts) return null;

  const pkg = await inferPackage(owner, repo, facts);
  const latestVersion = facts.latestRelease ? facts.latestRelease.tag.replace(/^v/, '') : null;
  let osv = null;
  if (pkg) {
    try {
      osv = await fetchAdvisories(pkg, latestVersion);
    } catch {
      osv = null;
    }
  }

  const readme = await fetchRepoFile(owner, repo, 'README.md').catch(() => null);

  // Live web evidence (Tavily). Never throws: with no key it reports
  // itself not configured and the brief stays structured-sources only.
  const web = await fetchWebEvidence({ owner, repo, packageName: pkg ? pkg.name : null, ecosystem: pkg ? pkg.ecosystem : null }).catch(() => ({
    status: 'error',
    note: 'Live web evidence failed this run. Structured sources (GitHub, OSV) only in this brief.',
    queries: [],
    items: [],
  }));

  const signals = {
    archived: facts.archived,
    daysSinceLastCommit: daysBetween(facts.recentCommits.newestAt),
    daysSinceLastPush: daysBetween(facts.pushedAt),
    latestReleaseDays: daysBetween(facts.latestRelease?.publishedAt),
    hasLicense: Boolean(facts.license),
    advisoriesTotal: osv ? osv.total : null,
    advisoriesAffectingLatest: osv ? osv.affectingLatest.length : null,
    stars: facts.stars,
    openIssues: facts.openIssues,
    contributorCount: facts.contributorCount,
    webEvidenceStatus: web.status,
    webEvidenceCount: web.items.length,
  };

  // Claims: every one sourced.
  const claims = [];
  const ghUrl = facts.url;
  claims.push({ kind: 'maintenance', text: `Repository created ${facts.createdAt.slice(0, 10)}, last push ${facts.pushedAt.slice(0, 10)}, last fetched commit ${facts.recentCommits.newestAt?.slice(0, 10) || 'unknown'}.`, source: ghUrl });
  claims.push({ kind: 'maintenance', text: `${fmtInt(facts.stars)} stars, ${fmtInt(facts.forks)} forks, ${fmtInt(facts.openIssues)} open issues, ${facts.contributorCount == null ? 'unknown' : fmtInt(facts.contributorCount)} contributors.`, source: ghUrl });
  claims.push({ kind: 'licence', text: facts.license ? `Licensed under ${facts.license.name} (${facts.license.spdx}).` : 'GitHub detects no licence for this repository.', source: ghUrl });
  if (facts.archived) claims.push({ kind: 'maintenance', text: 'Repository is archived by its owner and read-only.', source: ghUrl });
  if (facts.latestRelease) claims.push({ kind: 'maintenance', text: `Latest release ${facts.latestRelease.tag} published ${facts.latestRelease.publishedAt.slice(0, 10)}.`, source: facts.latestRelease.url });
  if (osv) {
    claims.push({ kind: 'security', text: `OSV holds ${fmtInt(osv.total)} advisories for ${osv.package.ecosystem} package ${osv.package.name} (severity mix: ${Object.entries(osv.bySeverity).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}).`, source: osv.sourceUrl });
    if (osv.latestVersionChecked) {
      claims.push({ kind: 'security', text: osv.affectingLatest.length ? `${fmtInt(osv.affectingLatest.length)} advisories affect the latest released version ${osv.latestVersionChecked}: ${osv.affectingLatest.map((a) => a.id).join(', ')}.` : `No OSV advisory range covers the latest released version ${osv.latestVersionChecked} (heuristic range check).`, source: osv.sourceUrl });
    }
    for (const v of osv.recent.slice(0, 3)) {
      claims.push({ kind: 'security', text: `${v.id} (${v.severity}, published ${(v.published || '').slice(0, 10)}): ${v.summary}`, source: v.url });
    }
  } else if (pkg) {
    claims.push({ kind: 'security', text: `Package mapping found (${pkg.ecosystem} ${pkg.name}) but OSV returned no data in this run.`, source: 'https://osv.dev' });
  } else {
    claims.push({ kind: 'security', text: 'No registry package could be mapped from the repo manifests, so no OSV advisory history was checked.', source: ghUrl });
  }

  // Contradictions: cross-source rules, plain language.
  const contradictions = [];
  if (!facts.archived && signals.daysSinceLastCommit !== null && signals.daysSinceLastCommit > 365) {
    contradictions.push(`Not archived, which suggests an active project, but no commits in ${fmtInt(signals.daysSinceLastCommit)} days.`);
  }
  if (pkg?.manifestLicense && facts.license && pkg.manifestLicense !== facts.license.spdx) {
    contradictions.push(`Licence mismatch: the package manifest says ${pkg.manifestLicense}, GitHub reports ${facts.license.spdx}.`);
  }
  if (!facts.license && readme && /MIT License|Apache License|BSD/i.test(readme)) {
    contradictions.push('GitHub detects no licence, but the README text mentions a licence. Legal state is unclear from the sources.');
  }
  if (facts.latestRelease && signals.daysSinceLastPush !== null && signals.latestReleaseDays !== null && signals.latestReleaseDays > 365 && signals.daysSinceLastPush < 90) {
    contradictions.push('Code is pushed recently but no release has shipped in over a year, so registry users may run much older code than the repo suggests.');
  }
  if (osv && osv.total === 0 && facts.stars > 10000) {
    contradictions.push('Very popular project with zero advisories in OSV. That can mean clean code or thin advisory coverage; treat the clean record with care.');
  }
  // Web versus structured sources: the checks a keyword scan can do
  // honestly. Anything softer belongs to the model stage, not rules.
  if (web.status === 'live' && web.items.length) {
    const webText = web.items.map((i) => `${i.title} ${i.snippet} ${i.excerpt || ''}`).join(' ').toLowerCase();
    if (/compromis|malware|hijack|backdoor/.test(webText) && osv && osv.total === 0) {
      contradictions.push('Web reports describe a compromise of this package, but OSV holds no advisory for it. The structured record may lag the incident; read the linked reports before adopting.');
    }
    if (/unmaintained|no longer maintained|abandoned/.test(webText) && signals.daysSinceLastCommit !== null && signals.daysSinceLastCommit < 90) {
      contradictions.push('Web reports describe the project as unmaintained, but the repository shows commits in the last 90 days. Check which source is newer before deciding.');
    }
  }

  // Web evidence joins the claims list with its own citations, so the
  // model stage classifies and judges it like everything else.
  const allClaims = mergeWebEvidence(claims, web);

  const core = {
    subject: { owner, repo, url: facts.url, description: facts.description },
    signals,
    contradictions,
  };

  const classified = await classifyEvidence(allClaims);
  const verdictRes = await writeVerdict(core, classified.claims);
  const modelMode = classified.mode === 'live' && verdictRes.mode === 'live' ? 'live' : 'mock';

  return {
    meta: {
      tool: 'DepVet',
      version: '0.2.0',
      generatedAt: new Date().toISOString(),
      input: `${owner}/${repo}`,
      modelMode,
      modelNote:
        modelMode === 'mock'
          ? 'MOCK MODEL MODE: no model endpoint configured, verdict and classification are deterministic stand-ins. Configure MODEL_BASE_URL and MODEL_API_KEY (Nebius Token Factory) for live Nemotron routing.'
          : 'Live model routing via configured endpoint.',
      models: { fast: config.model.fast, strong: config.model.strong, baseUrlConfigured: Boolean(config.model.baseUrl) },
    },
    subject: {
      owner,
      repo,
      url: facts.url,
      description: facts.description,
      primaryLanguage: facts.primaryLanguage,
      stars: facts.stars,
      forks: facts.forks,
      openIssues: facts.openIssues,
      license: facts.license,
      archived: facts.archived,
      createdAt: facts.createdAt,
      pushedAt: facts.pushedAt,
      topics: facts.topics,
    },
    maintenance: {
      lastCommitAt: facts.recentCommits.newestAt,
      recentCommitsFetched: facts.recentCommits.fetched,
      latestRelease: facts.latestRelease,
      contributorCount: facts.contributorCount,
    },
    packageMapping: pkg,
    security: osv
      ? {
          totalAdvisories: osv.total,
          bySeverity: osv.bySeverity,
          latestVersionChecked: osv.latestVersionChecked,
          affectingLatest: osv.affectingLatest,
          recent: osv.recent,
          sourceUrl: osv.sourceUrl,
        }
      : null,
    claims: classified.claims,
    contradictions,
    signals,
    verdict: verdictRes.verdict,
    webEvidence: {
      status: web.status,
      note: web.note,
      items: web.items.map((i) => ({
        title: i.title,
        url: i.url,
        publishedDate: i.publishedDate,
        snippet: i.snippet,
        excerpt: i.excerpt,
        via: i.via,
      })),
    },
  };
}
