// OSV vulnerability data source. Keyless public API.
// Docs shape: POST /v1/query with a package returns every advisory OSV
// knows for that package. We summarise and check whether the latest
// released version falls inside any advisory's affected ranges.

const OSV_API = 'https://api.osv.dev/v1/query';

export function cmpSemver(a, b) {
  const pa = String(a).replace(/^v/, '').split('-')[0].split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('-')[0].split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Heuristic range walk over OSV ECOSYSTEM and SEMVER ranges.
function rangeAffectsVersion(range, version) {
  if (!['ECOSYSTEM', 'SEMVER'].includes(range.type)) return false;
  let affected = false;
  let started = false;
  for (const ev of range.events || []) {
    if (ev.introduced !== undefined) {
      started = true;
      affected = ev.introduced === '0' || cmpSemver(version, ev.introduced) >= 0;
    } else if (ev.fixed !== undefined) {
      if (started && affected && cmpSemver(version, ev.fixed) >= 0) affected = false;
    } else if (ev.last_affected !== undefined) {
      if (started && cmpSemver(version, ev.last_affected) > 0) affected = false;
    }
  }
  return started && affected;
}

function severityOf(vuln) {
  const ds = vuln.database_specific?.severity;
  if (ds) return String(ds).toUpperCase();
  const sev = (vuln.severity || []).find((s) => s.type === 'CVSS_V3' || s.type === 'CVSS_V4');
  if (sev) return `CVSS ${sev.score}`;
  return 'UNSCORED';
}

function fixedVersions(vuln) {
  const out = new Set();
  for (const aff of vuln.affected || []) {
    for (const range of aff.ranges || []) {
      for (const ev of range.events || []) {
        if (ev.fixed) out.add(ev.fixed);
      }
    }
  }
  return [...out].sort(cmpSemver);
}

export async function fetchAdvisories(pkg, latestVersion) {
  const res = await fetch(OSV_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ package: { name: pkg.name, ecosystem: pkg.ecosystem } }),
  });
  if (!res.ok) throw new Error(`OSV API ${res.status}`);
  const body = await res.json();
  const vulns = body.vulns || [];

  const bySeverity = {};
  const affectingLatest = [];
  const normalised = vulns.map((v) => {
    const sev = severityOf(v);
    bySeverity[sev] = (bySeverity[sev] || 0) + 1;
    let affects = null;
    if (latestVersion) {
      affects = (v.affected || []).some((aff) =>
        (aff.ranges || []).some((range) => rangeAffectsVersion(range, latestVersion)),
      );
      if (affects) {
        affectingLatest.push({ id: v.id, severity: sev, summary: v.summary || '' });
      }
    }
    return {
      id: v.id,
      aliases: v.aliases || [],
      severity: sev,
      summary: v.summary || '',
      published: v.published || null,
      modified: v.modified || null,
      fixedIn: fixedVersions(v),
      affectsLatestVersion: affects,
      url: `https://osv.dev/vulnerability/${v.id}`,
    };
  });

  normalised.sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')));

  return {
    package: { ecosystem: pkg.ecosystem, name: pkg.name },
    total: normalised.length,
    bySeverity,
    latestVersionChecked: latestVersion || null,
    affectingLatest,
    recent: normalised.slice(0, 8),
    all: normalised,
    sourceUrl: `https://osv.dev/list?ecosystem=${encodeURIComponent(pkg.ecosystem)}&q=${encodeURIComponent(pkg.name)}`,
  };
}
