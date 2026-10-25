// Model routing. Two stages, on purpose:
//   stage 1 (fast model) reads the raw collected evidence and classifies
//     each item with risk tags, cheaply and in parallel-friendly form;
//   stage 2 (strong model) reads the classified evidence and writes the
//     final verdict a developer acts on.
// When no endpoint is configured, both stages fall back to deterministic
// stand-ins and the brief is stamped modelMode "mock" everywhere it
// matters. Mock output must never reach a judge.

import { config, modelConfigured } from '../config.js';
import { chatCompletion } from './provider.js';

const RISK_WORDS = [
  ['critical', 'CRITICAL'],
  ['malware', 'CRITICAL'],
  ['compromis', 'HIGH'],
  ['hijack', 'HIGH'],
  ['backdoor', 'HIGH'],
  ['high', 'HIGH'],
  ['unauthenticated', 'HIGH'],
  ['remote code', 'HIGH'],
  ['archived', 'MEDIUM'],
  ['stale', 'MEDIUM'],
  ['no licence', 'MEDIUM'],
  ['no license', 'MEDIUM'],
  ['deprecated', 'MEDIUM'],
];

// Deterministic stand-in for the fast stage: keyword tagging only.
function mockClassify(claims) {
  return claims.map((claim) => {
    const text = claim.text.toLowerCase();
    const tags = [];
    for (const [word, tag] of RISK_WORDS) {
      if (text.includes(word) && !tags.includes(tag)) tags.push(tag);
    }
    return { ...claim, riskTags: tags.length ? tags : ['INFO'], classifiedBy: 'mock-fast-model' };
  });
}

async function liveClassify(claims) {
  const list = claims.map((c, i) => `${i}. [${c.kind}] ${c.text} (source: ${c.source})`).join('\n');
  const out = await chatCompletion({
    model: config.model.fast,
    maxTokens: config.model.fastMaxTokens,
    system:
      'You classify evidence items for a dependency risk brief. Reply with JSON only: an array of objects {"index": number, "riskTags": string[]} where riskTags is a subset of CRITICAL, HIGH, MEDIUM, LOW, INFO. No prose.',
    user: `Classify each evidence item:\n${list}`,
  });
  const parsed = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1));
  return claims.map((claim, i) => {
    const hit = parsed.find((p) => p.index === i);
    return { ...claim, riskTags: hit?.riskTags?.length ? hit.riskTags : ['INFO'], classifiedBy: config.model.fast };
  });
}

export async function classifyEvidence(claims) {
  if (!modelConfigured()) return { claims: mockClassify(claims), mode: 'mock' };
  try {
    return { claims: await liveClassify(claims), mode: 'live' };
  } catch {
    return { claims: mockClassify(claims), mode: 'mock', note: 'live classification failed, mock fallback used' };
  }
}

// Deterministic stand-in for the strong stage: a transparent score.
function mockVerdict(core) {
  let score = 70;
  const reasons = [];
  const sig = core.signals;
  if (sig.archived) { score -= 35; reasons.push('Repository is archived by its owner.'); }
  if (sig.daysSinceLastCommit !== null && sig.daysSinceLastCommit > 365) { score -= 20; reasons.push('No commits for over a year.'); }
  else if (sig.daysSinceLastCommit !== null && sig.daysSinceLastCommit > 180) { score -= 8; reasons.push('Commits have slowed down.'); }
  if (sig.advisoriesAffectingLatest > 0) { score -= 15 * Math.min(sig.advisoriesAffectingLatest, 3); reasons.push(`${sig.advisoriesAffectingLatest} known advisories affect the latest released version.`); }
  if (sig.advisoriesTotal >= 10) { score -= 6; reasons.push(`Long advisory history: ${sig.advisoriesTotal} advisories on record.`); }
  if (!sig.hasLicense) { score -= 12; reasons.push('No licence detected, which blocks legal reuse.'); }
  if (sig.latestReleaseDays !== null && sig.latestReleaseDays <= 90) { score += 5; reasons.push('A release shipped in the last 90 days.'); }
  score = Math.max(2, Math.min(97, score));
  const label = score >= 70 ? 'Adopt with routine monitoring' : score >= 40 ? 'Adopt with caution' : 'Avoid, or pin and patch first';
  return {
    label,
    score,
    summary: `${core.subject.repo} scores ${score}/100 on maintenance and security signals. ${label}.`,
    rationale: reasons.length ? reasons : ['No strong negative signals in the collected evidence.'],
    producedBy: 'MOCK strong model (no model endpoint configured)',
  };
}

// The evidence lines carry bracketed risk tags for the model's
// benefit; the model sometimes echoes them into its prose. Strip the
// echoes so the published rationale reads as plain sentences. Pure.
export function cleanVerdictText(s) {
  return String(s || '')
    .replace(/\s*\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function liveVerdict(core, classifiedClaims) {
  const evidence = classifiedClaims.map((c) => `- [${c.riskTags.join(', ')}] ${c.text} (${c.source})`).join('\n');
  const contra = core.contradictions.map((c) => `- ${c}`).join('\n') || '- none';
  const out = await chatCompletion({
    model: config.model.strong,
    maxTokens: config.model.strongMaxTokens,
    system:
      'You write the verdict section of a dependency risk brief. Be direct and specific. Reply with JSON only: {"label": string, "score": number 0-100, "summary": string, "rationale": string[]}. The label is one of: "Adopt with routine monitoring", "Adopt with caution", "Avoid, or pin and patch first". Ground every rationale point in the supplied evidence. Never invent facts. Write rationale points as plain prose sentences: do not repeat the bracketed risk tags from the evidence list in your output.',
    user: `Repository: ${core.subject.owner}/${core.subject.repo}\nSignals: ${JSON.stringify(core.signals)}\nEvidence:\n${evidence}\nContradictions flagged:\n${contra}`,
    temperature: 0.1,
  });
  const parsed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
  if (Array.isArray(parsed.rationale)) parsed.rationale = parsed.rationale.map(cleanVerdictText).filter(Boolean);
  if (typeof parsed.summary === 'string') parsed.summary = cleanVerdictText(parsed.summary);
  return { ...parsed, producedBy: config.model.strong };
}

export async function writeVerdict(core, classifiedClaims) {
  if (!modelConfigured()) return { verdict: mockVerdict(core), mode: 'mock' };
  try {
    return { verdict: await liveVerdict(core, classifiedClaims), mode: 'live' };
  } catch {
    return { verdict: mockVerdict(core), mode: 'mock', note: 'live verdict failed, mock fallback used' };
  }
}
