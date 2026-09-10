import assert from "node:assert/strict";
import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { tokens } from "../lib/similarity-core.ts";
import {
  interpretSelectiveCorpusEvidence,
  SELECTIVE_CORPUS_INTERPRETATION_KINDS,
  SELECTIVE_CORPUS_INTERPRETATION_VERSION,
} from "../lib/selective-corpus/interpretation.ts";
import { loadSelectiveCorpusArtifact, clearSelectiveCorpusArtifactCache } from "../lib/selective-corpus/artifact.ts";
import { selectiveCorpusStageA } from "../lib/selective-corpus/stage-a.ts";
import { loadSelectiveCorpusCandidateText } from "../lib/selective-corpus/source-loader.ts";
import { admitSelectiveCorpusCandidate } from "../lib/selective-corpus/verify.ts";
import { runSelectiveCorpusShadow } from "../lib/selective-corpus/shadow.ts";

const ARTIFACT = "D:/TurnitPlusTemp/selective-corpus-bulk-v1/run-20260909-224038";
const TRACKC = "D:/TurnitPlusTemp/selective-corpus-v1/run-20260909-211001";
const present = (() => {
  try {
    return (
      statSync(join(ARTIFACT, "corpus-version.json")).isFile() &&
      statSync(join(TRACKC, "track-c-dev.json")).isFile()
    );
  } catch {
    return false;
  }
})();

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const span = (start, end) => ({ start, end, words: end - start + 1 });
const src = (o) => ({ key: "k", spans: [], familyGuardActivated: false, dominantSpanBoilerplate: false, submissionCoverageFraction: 0, ...o });

// ── unit: the class list is exactly the V1 high-confidence set ─────────────
test("V1 exposes exactly the 6 high-confidence classes — no COMMON_DEFINITION / COMMON_ACADEMIC_LANGUAGE", () => {
  assert.deepEqual([...SELECTIVE_CORPUS_INTERPRETATION_KINDS].sort(), [
    "ATTRIBUTED_QUOTATION",
    "DECLARED_QUOTATION",
    "DISTINCTIVE_EXTERNAL_MATCH",
    "FAMILY_BOILERPLATE",
    "LEGITIMATE_ALTERNATE_SOURCE",
    "POSSIBLE_SAME_WORK",
  ]);
  assert.equal(SELECTIVE_CORPUS_INTERPRETATION_KINDS.includes("COMMON_DEFINITION"), false);
  assert.equal(SELECTIVE_CORPUS_INTERPRETATION_KINDS.includes("COMMON_ACADEMIC_LANGUAGE"), false);
});

// ── unit: quotation ───────────────────────────────────────────────────────
test("curly quotation marks alone => DECLARED_QUOTATION", () => {
  const filler = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron ";
  const quoted = "\u201cthe mitochondrion is the powerhouse of the cell and supplies the chemical energy the cell needs to survive and function\u201d";
  const text = `${filler}${quoted} ${filler}`;
  const words = tokens(text);
  // the quoted words start right after the filler (15 filler words) — find them
  const start = 15;
  const end = start + tokens(quoted).length - 1;
  const r = interpretSelectiveCorpusEvidence({
    submissionText: text,
    submissionWordCount: words.length,
    sources: [src({ spans: [span(start, end)], submissionCoverageFraction: 0.2 })],
  });
  const only = r.bySource.get("k")[0];
  assert.equal(only.kind, "DECLARED_QUOTATION");
  assert.equal(only.confidence, "high");
  assert.equal(r.counts.DECLARED_QUOTATION, 1);
  assert.equal(JSON.stringify(only.reasons).includes("quotation marks"), true);
});

test("curly quotation + nearby attribution phrase => ATTRIBUTED_QUOTATION", () => {
  const filler = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron ";
  const quoted = "\u201cthe mitochondrion is the powerhouse of the cell and supplies the chemical energy the cell needs to survive and function\u201d";
  const text = `${filler}As noted in "Cell biology", ${quoted} ${filler}`;
  const words = tokens(text);
  const lead = tokens(`${filler}As noted in "Cell biology", `).length;
  const start = lead;
  const end = start + tokens(quoted).length - 1;
  const r = interpretSelectiveCorpusEvidence({
    submissionText: text,
    submissionWordCount: words.length,
    sources: [src({ spans: [span(start, end)], submissionCoverageFraction: 0.2 })],
  });
  const only = r.bySource.get("k")[0];
  assert.equal(only.kind, "ATTRIBUTED_QUOTATION");
  assert.equal(only.confidence, "high");
  assert.equal(r.counts.ATTRIBUTED_QUOTATION, 1);
});

test("STRAIGHT quotation marks are NOT trusted in V1 => falls through to DISTINCTIVE", () => {
  const filler = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron ";
  const quoted = '"the mitochondrion is the powerhouse of the cell and supplies the chemical energy the cell needs to survive"';
  const text = `${filler}${quoted} ${filler}`;
  const words = tokens(text);
  const start = 15;
  const end = start + tokens(quoted).length - 1;
  const r = interpretSelectiveCorpusEvidence({
    submissionText: text,
    submissionWordCount: words.length,
    sources: [src({ spans: [span(start, end)], submissionCoverageFraction: 0.2 })],
  });
  assert.equal(r.bySource.get("k")[0].kind, "DISTINCTIVE_EXTERNAL_MATCH");
  assert.equal(r.counts.DECLARED_QUOTATION, 0);
  assert.equal(r.counts.ATTRIBUTED_QUOTATION, 0);
});

// ── unit: same-work — NEVER from overlap alone ────────────────────────────
test("unrelated external source at 80% overlap => NOT POSSIBLE_SAME_WORK (falls to DISTINCTIVE)", () => {
  const text = ("word ".repeat(300)).trim();
  const r = interpretSelectiveCorpusEvidence({
    submissionText: text,
    submissionWordCount: 300,
    sources: [src({ spans: [span(0, 240)], submissionCoverageFraction: 0.8 })], // no sameWorkRelationship
  });
  assert.equal(r.bySource.get("k")[0].kind, "DISTINCTIVE_EXTERNAL_MATCH");
  assert.equal(r.counts.POSSIBLE_SAME_WORK, 0);
});

test("unrelated external source at 100% overlap => NOT POSSIBLE_SAME_WORK (falls to DISTINCTIVE)", () => {
  const text = ("word ".repeat(300)).trim();
  const r = interpretSelectiveCorpusEvidence({
    submissionText: text,
    submissionWordCount: 300,
    sources: [src({ spans: [span(0, 299)], submissionCoverageFraction: 1.0 })], // no sameWorkRelationship
  });
  assert.equal(r.bySource.get("k")[0].kind, "DISTINCTIVE_EXTERNAL_MATCH");
  assert.equal(r.counts.POSSIBLE_SAME_WORK, 0);
});

test("source with an explicit trusted work/version relationship => POSSIBLE_SAME_WORK (even at LOW overlap)", () => {
  const text = ("word ".repeat(300)).trim();
  for (const evidence of ["CANONICAL_WORK_IDENTITY", "EXPLICIT_PRIOR_VERSION", "TRUSTED_SAME_WORK_METADATA"]) {
    const r = interpretSelectiveCorpusEvidence({
      submissionText: text,
      submissionWordCount: 300,
      sources: [src({ spans: [span(0, 40)], submissionCoverageFraction: 0.13, sameWorkRelationship: { evidence } })],
    });
    const only = r.bySource.get("k")[0];
    assert.equal(only.kind, "POSSIBLE_SAME_WORK", `evidence=${evidence}`);
    assert.equal(only.confidence, "medium");
    // the reason is relationship-based, NOT an overlap percentage, and leaks no
    // provenance/identity internal (not even the raw evidence enum token).
    const reasonBlob = JSON.stringify(only.reasons);
    assert.equal(/%|percent|\bid\b|hash|passport|account|canonical|version id|CANONICAL_WORK_IDENTITY|EXPLICIT_PRIOR_VERSION|TRUSTED_SAME_WORK_METADATA/i.test(reasonBlob), false, reasonBlob);
    assert.equal(reasonBlob.includes("work/version relationship"), true);
  }
});

test("a source overlapping a minority of the submission is NOT POSSIBLE_SAME_WORK", () => {
  const text = ("word ".repeat(300)).trim();
  const r = interpretSelectiveCorpusEvidence({
    submissionText: text,
    submissionWordCount: 300,
    sources: [src({ spans: [span(0, 60)], submissionCoverageFraction: 0.2 })],
  });
  assert.equal(r.bySource.get("k")[0].kind, "DISTINCTIVE_EXTERNAL_MATCH");
  assert.equal(r.counts.POSSIBLE_SAME_WORK, 0);
});

// ── unit: FAMILY_BOILERPLATE only where FAMILY_GUARD has positive evidence ──
test("FAMILY_BOILERPLATE only when FAMILY_GUARD already flagged the dominant span", () => {
  const text = ("word ".repeat(300)).trim();
  const withGuard = interpretSelectiveCorpusEvidence({
    submissionText: text, submissionWordCount: 300,
    sources: [src({ spans: [span(0, 40)], familyGuardActivated: true, dominantSpanBoilerplate: true, submissionCoverageFraction: 0.14 })],
  });
  assert.equal(withGuard.bySource.get("k")[0].kind, "FAMILY_BOILERPLATE");
  assert.equal(withGuard.bySource.get("k")[0].confidence, "high");

  const withoutGuard = interpretSelectiveCorpusEvidence({
    submissionText: text, submissionWordCount: 300,
    sources: [src({ spans: [span(0, 40)], familyGuardActivated: false, dominantSpanBoilerplate: false, submissionCoverageFraction: 0.14 })],
  });
  assert.equal(withoutGuard.bySource.get("k")[0].kind, "DISTINCTIVE_EXTERNAL_MATCH");
  assert.equal(withoutGuard.counts.FAMILY_BOILERPLATE, 0);
});

// ── unit: LEGITIMATE_ALTERNATE_SOURCE ─────────────────────────────────────
test("a source whose positions are fully covered by a larger matched source => LEGITIMATE_ALTERNATE_SOURCE", () => {
  const text = ("word ".repeat(400)).trim();
  const r = interpretSelectiveCorpusEvidence({
    submissionText: text,
    submissionWordCount: 400,
    sources: [
      src({ key: "big", spans: [span(50, 250)], submissionCoverageFraction: 0.5 }),
      src({ key: "small", spans: [span(80, 180)], submissionCoverageFraction: 0.25 }),
    ],
  });
  assert.equal(r.bySource.get("small")[0].kind, "LEGITIMATE_ALTERNATE_SOURCE");
  assert.equal(r.bySource.get("big")[0].kind, "DISTINCTIVE_EXTERNAL_MATCH");
});

// ── unit: no forbidden kinds ever appear ─────────────────────────────────
test("counts object never carries a COMMON_* key", () => {
  const r = interpretSelectiveCorpusEvidence({ submissionText: "word ".repeat(50), submissionWordCount: 50, sources: [] });
  assert.deepEqual(Object.keys(r.counts).sort(), [...SELECTIVE_CORPUS_INTERPRETATION_KINDS].sort());
  assert.equal(r.version, SELECTIVE_CORPUS_INTERPRETATION_VERSION);
});

// ── integration: frozen Track_C ──────────────────────────────────────────
const dev = present ? JSON.parse(readFileSync(join(TRACKC, "track-c-dev.json"), "utf8")) : { cases: [] };

function frozenInterpret(caseId, { skipHost = true } = {}) {
  const raw = readFileSync(join(TRACKC, "track-c", "submissions", `${caseId}.txt`), "utf8");
  clearSelectiveCorpusArtifactCache();
  const artifact = loadSelectiveCorpusArtifact(ARTIFACT);
  const rawToOrd = new Map();
  for (const d of artifact.docs) {
    rawToOrd.set(d.rawId, d.ordinal);
    const b = d.rawId.replace(/^(bulk|fixture|prior|build):/, "");
    if (!rawToOrd.has(b)) rawToOrd.set(b, d.ordinal);
  }
  const c = dev.cases.find((x) => x.caseId === caseId);
  const hostOrd = rawToOrd.get(c.hostDocId);
  const words = tokens(raw);
  const stageA = selectiveCorpusStageA(raw, artifact);
  const sources = [];
  for (const cand of stageA.topK) {
    if (skipHost && cand.ordinal === hostOrd) continue;
    const ct = loadSelectiveCorpusCandidateText(artifact, cand.ordinal);
    if (!ct) continue;
    const res = admitSelectiveCorpusCandidate(raw, words, ct.text, artifact);
    if (!res.admitted) continue;
    const pos = new Set();
    for (const s of res.spans) for (let i = s.start; i <= s.end; i += 1) pos.add(i);
    sources.push({
      key: ct.doc.rawId,
      rawId: ct.doc.rawId,
      spans: res.spans,
      familyGuardActivated: res.familyGuardActivated,
      dominantSpanBoilerplate: res.dominantSpanBoilerplate,
      submissionCoverageFraction: pos.size / words.length,
    });
  }
  const r = interpretSelectiveCorpusEvidence({ submissionText: raw, submissionWordCount: words.length, sources });
  return { r, sources };
}

test("Track_C: the 5 quotation-controlled cases all classify as ATTRIBUTED_QUOTATION", { skip: !present }, () => {
  let hits = 0;
  for (const id of ["tcx-029", "tcx-030", "tcx-031", "tcx-032", "tcx-033"]) {
    const c = dev.cases.find((x) => x.caseId === id);
    const [gs, ge] = c.groundTruth[0].submissionSpanWords;
    const { r, sources } = withEnv({ SELECTIVE_CORPUS_FIXTURE_PATH: TRACKC }, () => frozenInterpret(id));
    // the source carrying the copied quotation is the one whose spans land in
    // the ground-truth copied region (robust to the bulk corpus re-crawling the
    // expected source under a different id).
    const expSrc = sources.find((s) =>
      s.spans.some((sp) => Math.min(sp.end, ge) - Math.max(sp.start, gs) > (sp.end - sp.start) * 0.3),
    );
    assert.ok(expSrc, `${id}: a source covering the quoted region is admitted`);
    const kinds = r.bySource.get(expSrc.key).map((s) => s.kind);
    assert.ok(kinds.includes("ATTRIBUTED_QUOTATION"), `${id}: quoted-region source has an ATTRIBUTED_QUOTATION span (${kinds})`);
    hits += 1;
  }
  assert.equal(hits, 5);
});

test("Track_C tcx-017: the alternate Wikipedia source is LEGITIMATE_ALTERNATE_SOURCE", { skip: !present }, () => {
  const { r, sources } = withEnv({ SELECTIVE_CORPUS_FIXTURE_PATH: TRACKC }, () => frozenInterpret("tcx-017"));
  const alt = sources.find((s) => s.rawId.replace(/^(bulk|fixture):/, "") === "A-wiki-051");
  assert.ok(alt, "A-wiki-051 admitted");
  const kinds = r.bySource.get(alt.key).map((s) => s.kind);
  assert.ok(kinds.every((k) => k === "LEGITIMATE_ALTERNATE_SOURCE"), `all A-wiki-051 spans are LEGITIMATE_ALTERNATE_SOURCE (${kinds})`);
});

test("Track_C tcx-004: the FAO source stays ORDINARY verified overlap (DISTINCTIVE) — common-definition deferred", { skip: !present }, () => {
  const { r, sources } = withEnv({ SELECTIVE_CORPUS_FIXTURE_PATH: TRACKC }, () => frozenInterpret("tcx-004"));
  const fao = sources.find((s) => s.rawId.endsWith("B-00235") || s.rawId.endsWith("B-rpt-022"));
  assert.ok(fao, "the FAO source is admitted for tcx-004");
  const kinds = r.bySource.get(fao.key).map((s) => s.kind);
  assert.equal(kinds.includes("DECLARED_QUOTATION"), false, "not labelled a quotation");
  assert.equal(kinds.includes("ATTRIBUTED_QUOTATION"), false, "not labelled a quotation");
  assert.ok(kinds.every((k) => k === "DISTINCTIVE_EXTERNAL_MATCH"), `FAO spans are ordinary verified overlap (${kinds})`);
});

// ── integration: the shadow result carries a SAFE interpretation breakdown ─
test("shadow result: interpretationBreakdown is present, safe-labelled, and does not change positions/score", { skip: !present }, () => {
  const sub = readFileSync(join(TRACKC, "track-c", "submissions", "tcx-029.txt"), "utf8");
  const authoritative = { unifiedScore: 9, matchedPositions: [3, 4, 5] };
  const before = JSON.stringify(authoritative);
  const r = withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true", SELECTIVE_CORPUS_ARTIFACT_PATH: ARTIFACT, SELECTIVE_CORPUS_FIXTURE_PATH: TRACKC }, () => {
    clearSelectiveCorpusArtifactCache();
    return runSelectiveCorpusShadow({ canonicalSubmissionText: sub, authoritative });
  });
  assert.ok(r.state === "COMPLETED" || r.state === "PARTIAL");
  assert.equal(r.interpretationVersion, SELECTIVE_CORPUS_INTERPRETATION_VERSION);
  assert.ok(r.interpretationCounts && typeof r.interpretationCounts.DISTINCTIVE_EXTERNAL_MATCH === "number");
  assert.equal("COMMON_DEFINITION" in r.interpretationCounts, false);
  // the shadow supplies NO trusted work/version relationship => POSSIBLE_SAME_WORK
  // is never emitted (a whole-document twin is DISTINCTIVE, not same-work).
  assert.equal(r.interpretationCounts.POSSIBLE_SAME_WORK, 0);
  assert.ok(Array.isArray(r.interpretationBreakdown) && r.interpretationBreakdown.length >= 1);
  assert.equal(r.interpretationBreakdown.some((s) => s.spans.some((x) => x.kind === "POSSIBLE_SAME_WORK")), false);

  // authoritative object untouched; positions/score independent of interpretation
  assert.equal(JSON.stringify(authoritative), before);
  assert.equal(r.authoritativeUnifiedSimilarity, 9);
  assert.equal(typeof r.matchedPositionCount, "number");
  assert.ok(r.matchedPositionCount >= 0);
  const totalInterpSpans = r.interpretationBreakdown.reduce((n, s) => n + s.spans.length, 0);
  const totalCount = Object.values(r.interpretationCounts).reduce((a, b) => a + b, 0);
  assert.equal(totalInterpSpans, totalCount);

  // SERIALIZATION SAFETY — no ids / paths / hashes / fingerprints / digests
  const json = JSON.stringify(r.interpretationBreakdown);
  assert.equal(/scb-\d|fixture:|bulk:|[/\\]|[0-9a-f]{32}/.test(json), false, "no internal identifiers in the user-facing breakdown");
  for (const s of r.interpretationBreakdown) {
    assert.match(s.sourceLabel, /^S\d+$/);
    for (const sp of s.spans) {
      assert.ok(Array.isArray(sp.wordRange) && sp.wordRange.length === 2);
      assert.ok(["high", "medium", "low"].includes(sp.confidence));
      assert.ok(SELECTIVE_CORPUS_INTERPRETATION_KINDS.includes(sp.kind));
    }
  }
});

test("shadow flag OFF is unchanged by the interpretation layer (immediate DISABLED, no fields)", () => {
  withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: undefined, SELECTIVE_CORPUS_ARTIFACT_PATH: "/nope" }, () => {
    const r = runSelectiveCorpusShadow({ canonicalSubmissionText: "word ".repeat(400), authoritative: { unifiedScore: 1, matchedPositions: [1] } });
    assert.equal(r.state, "DISABLED");
    assert.equal(r.interpretationCounts, undefined);
    assert.equal(r.interpretationBreakdown, undefined);
  });
});
