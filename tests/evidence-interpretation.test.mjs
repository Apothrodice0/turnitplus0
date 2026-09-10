import assert from "node:assert/strict";
import test from "node:test";

import { tokens } from "../lib/similarity-core.ts";
import {
  buildReportEvidenceInterpretation,
  normalizeReportEvidence,
  mapHistoricalMatchToSameWorkRelationship,
  SAME_WORK_RELATIONSHIP_DORMANT_FOR_HISTORICAL_EVIDENCE_V1,
  resolveReportCompletion,
  extractionDiagnosticFromCounts,
  plainTextExtractionDiagnostic,
  unknownExtractionDiagnostic,
  normalizeArchiveEvidence,
  normalizeScholarlyEvidence,
  normalizePriorSubmissionEvidence,
  normalizeSelectiveCorpusEvidence,
  EVIDENCE_INTERPRETATION_KINDS,
  EVIDENCE_INTERPRETATION_VERSION,
} from "../lib/evidence-interpretation/index.ts";

// ── fixture helpers ──────────────────────────────────────────────────────
// A submission whose text has predictable word indices. Words 0..N-1 are
// "wordK"; we splice a curly-quoted, attributed passage at [qStart..qEnd].
function makeText(n, { quoteAt } = {}) {
  const w = [];
  for (let i = 0; i < n; i += 1) w.push(`word${i}`);
  let text = w.join(" ");
  if (quoteAt) {
    const [qs, qe] = quoteAt;
    const before = w.slice(0, qs).join(" ");
    const quoted = w.slice(qs, qe + 1).join(" ");
    const after = w.slice(qe + 1).join(" ");
    // "According to Smith (2020), “<quoted>”." — signal phrase + author-year + curly quotes
    text = `${before} According to Smith (2020), “${quoted}”. ${after}`.trim();
  }
  return text;
}
const runs = (positions) => {
  const s = [...new Set(positions)].sort((a, b) => a - b);
  const out = [];
  for (const p of s) {
    const last = out[out.length - 1];
    if (last && p <= last.end + 1) last.end = p;
    else out.push({ start: p, end: p });
  }
  return out;
};
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function mkReport(over = {}) {
  const text = over.text ?? makeText(400);
  const wc = over.wordCount ?? tokens(text).length;
  return {
    version: 11,
    id: 1,
    submissionId: "0000000001",
    title: "t.txt",
    author: "Guest submission",
    assignment: "x",
    created: new Date().toISOString(),
    score: over.score ?? 0,
    wordCount: wc,
    characterCount: text.length,
    pageCount: 1,
    fileSize: "1 KB",
    databaseSize: 230,
    corpusVersion: "archive-v5-230-x",
    scoreBand: "Low",
    riskStatus: "Lower",
    riskTarget: 0,
    riskCutoff: 0,
    riskCalibration: { auc: 0, precision: 0, recall: 0, sampleSize: 0 },
    features: {
      maxSourceContainment: 0, longestMatchedSpan: 0, quotationDensity: 0,
      referenceListRatio: 0, highFrequencyShingleCount: 0, repeatedThreeGramCount: 0,
      detectedLanguage: "en",
    },
    excludedDocuments: 0,
    matchedWordCount: 0,
    sources: [],
    repeats: [],
    text,
    ...over,
  };
}

const reconciles = (r) => {
  const total = Object.values(r.countsByKind).reduce((a, b) => a + b, 0);
  return total === r.matchedWordCount && r.matchedWordCount === r.positionsByKind.DISTINCTIVE_EXTERNAL_MATCH.length
    + r.positionsByKind.ATTRIBUTED_QUOTATION.length + r.positionsByKind.DECLARED_QUOTATION.length
    + r.positionsByKind.POSSIBLE_SAME_WORK.length + r.positionsByKind.FAMILY_BOILERPLATE.length
    + r.positionsByKind.LEGITIMATE_ALTERNATE_SOURCE.length;
};

// ── archive evidence ────────────────────────────────────────────────────
test("archive evidence: aggregate source, distinctive by default, reconciles", () => {
  const report = mkReport({
    archiveMatchedPositions: [...range(10, 60), ...range(200, 230)],
    sources: [
      { name: "Wikipedia — “Photosynthesis”", type: "Internet", percent: 12, matches: 3, matchedWords: 51, phrases: [], color: "#000" },
      { name: "Some Journal", type: "Publication", percent: 5, matches: 1, matchedWords: 31, phrases: [], color: "#111" },
    ],
  });
  const r = buildReportEvidenceInterpretation(report);
  assert.equal(r.version, EVIDENCE_INTERPRETATION_VERSION);
  assert.equal(r.matchedWordCount, 82);
  assert.ok(reconciles(r));
  assert.equal(r.countsByKind.DISTINCTIVE_EXTERNAL_MATCH, 82);
  const card = r.sources[0];
  assert.equal(card.id, "src-1");
  assert.equal(card.sourceType, "internet");
  assert.equal(card.interpretation.primaryKind, "DISTINCTIVE_EXTERNAL_MATCH");
  assert.ok(Array.isArray(card.namedSources) && card.namedSources.length === 2);
  assert.equal(card.namedSources[0].label, "Wikipedia — “Photosynthesis”");
});

// ── scholarly evidence (quotation) ──────────────────────────────────────
test("scholarly evidence: an attributed curly-quoted passage => ATTRIBUTED_QUOTATION", () => {
  const text = makeText(400, { quoteAt: [120, 175] });
  // after the splice, "word120".."word175" no longer sit at token 120..175 —
  // recompute where they land
  const toks = tokens(text);
  const qStart = toks.indexOf("word120");
  const qEnd = toks.indexOf("word175");
  const positions = range(qStart, qEnd);
  const report = mkReport({
    text,
    unifiedSimilarity: { matchedPositions: positions, previousUploadPositions: [] },
    externalAcademicEvidence: [
      {
        provider: "openaire", providerId: "openaire", title: "A study of X", authors: ["Smith"],
        publication: "Journal of X", year: 2020, doi: "10.1/x", url: "https://doi.org/10.1/x",
        matchedPassages: [{ submittedText: "", submittedWordStart: qStart, submittedWordEnd: qEnd, matchedWordCount: qEnd - qStart + 1 }],
        similarity: 60,
      },
    ],
  });
  const r = buildReportEvidenceInterpretation(report);
  assert.ok(reconciles(r));
  assert.equal(r.countsByKind.ATTRIBUTED_QUOTATION, qEnd - qStart + 1);
  assert.equal(r.countsByKind.DISTINCTIVE_EXTERNAL_MATCH, 0);
  const card = r.sources.find((s) => s.sourceType === "publication");
  assert.ok(card);
  assert.equal(card.interpretation.primaryKind, "ATTRIBUTED_QUOTATION");
  assert.equal(card.label, "A study of X");
  assert.equal(card.doi, "10.1/x");
  assert.equal(card.passageRefs.length >= 1, true);
  assert.equal(r.passages.some((p) => p.interpretation.kind === "ATTRIBUTED_QUOTATION" && p.interpretation.tone === "informational"), true);
});

// ── prior-submission evidence + same-work mapping ───────────────────────
// ── SAME-WORK ADAPTER HARDENING ──────────────────────────────────────────
// The current data model has NO independent work/version relationship signal:
// relationshipType is account-identity-derived, matchType is similarity
// strength. So the historical-match adapter never manufactures a
// sameWorkRelationship in V1, and POSSIBLE_SAME_WORK is dormant for that
// producer.
const HM = (relationshipType, matchType, extra = {}) => ({
  status: "MATCHED", computedAt: "x", matcherVersion: "x", fingerprintVersion: "x", canonicalizationVersion: "x",
  matches: [{
    relationshipType, matchType, matchedRepresentationId: "rep-SECRET", containment: matchType === "EXACT_CANONICAL_MATCH" ? 1 : 0.9,
    matchedWordCount: 221, passageCount: 1, longestMatchWords: 221, passages: [], historicalSubmissionCount: extra.otherCount ?? 0,
  }],
});

test("same-work adapter: SELF + STRONG_TEXT_MATCH => null (similarity strength is not a relationship)", () => {
  assert.equal(mapHistoricalMatchToSameWorkRelationship(HM("SELF", "STRONG_TEXT_MATCH")), null);
});
test("same-work adapter: SELF + EXACT_CANONICAL_MATCH (no independent version relation) => null (canonical text equality is not an identity relation)", () => {
  assert.equal(mapHistoricalMatchToSameWorkRelationship(HM("SELF", "EXACT_CANONICAL_MATCH")), null);
});
test("same-work adapter: PRIOR_SUBMISSION + STRONG_TEXT_MATCH => null", () => {
  assert.equal(mapHistoricalMatchToSameWorkRelationship(HM("PRIOR_SUBMISSION", "STRONG_TEXT_MATCH")), null);
});
test("same-work adapter: PRIOR_SUBMISSION + exact text equality alone => null", () => {
  assert.equal(mapHistoricalMatchToSameWorkRelationship(HM("PRIOR_SUBMISSION", "EXACT_CANONICAL_MATCH", { otherCount: 3 })), null);
});
test("same-work adapter: a Device-Passport-backed SELF => null (SELF is account/Passport-derived, not a version relation)", () => {
  // SELF here is exactly what a same-device / same-account classification produces
  assert.equal(mapHistoricalMatchToSameWorkRelationship(HM("SELF", "EXACT_CANONICAL_MATCH")), null);
});
test("same-work adapter: UNKNOWN_RELATIONSHIP / TURNITPLUS_CORPUS_SOURCE / no match => null", () => {
  assert.equal(mapHistoricalMatchToSameWorkRelationship(HM("UNKNOWN_RELATIONSHIP", "STRONG_TEXT_MATCH")), null);
  assert.equal(mapHistoricalMatchToSameWorkRelationship(HM("TURNITPLUS_CORPUS_SOURCE", "EXACT_CANONICAL_MATCH")), null);
  assert.equal(mapHistoricalMatchToSameWorkRelationship({ status: "NO_HISTORICAL_MATCH", computedAt: "x", matcherVersion: "x", fingerprintVersion: "x", canonicalizationVersion: "x" }), null);
  assert.equal(mapHistoricalMatchToSameWorkRelationship(undefined), null);
});

test("same-work adapter: no explicit independent prior-version field exists today => POSSIBLE_SAME_WORK dormant for historical evidence", () => {
  assert.equal(SAME_WORK_RELATIONSHIP_DORMANT_FOR_HISTORICAL_EVIDENCE_V1, true);
  // strongest possible historical signal -> still DISTINCTIVE, never POSSIBLE_SAME_WORK
  const positions = range(0, 220);
  const report = mkReport({
    unifiedSimilarity: { matchedPositions: positions, previousUploadPositions: positions },
    historicalSubmissionMatch: HM("SELF", "EXACT_CANONICAL_MATCH"),
  });
  const r = buildReportEvidenceInterpretation(report);
  assert.ok(reconciles(r));
  assert.equal(r.countsByKind.POSSIBLE_SAME_WORK, 0);
  assert.equal(r.countsByKind.DISTINCTIVE_EXTERNAL_MATCH, 221);
  assert.equal(r.sources[0].interpretation.primaryKind, "DISTINCTIVE_EXTERNAL_MATCH");
  const blob = JSON.stringify(r);
  assert.equal(blob.includes("rep-SECRET"), false);
  assert.equal(blob.includes("PRIOR_SUBMISSION") || blob.includes("SELF"), false);
});

// (Requirement #6) No explicit independent work/version relationship field
// exists in the data model today, so POSSIBLE_SAME_WORK is intentionally
// dormant for historical-submission evidence (asserted above). The interpreter's
// POSSIBLE_SAME_WORK path — the path a future explicit-version signal would use —
// is proven unchanged by tests/selective-corpus-interpretation.test.mjs's
// "source with an explicit trusted work/version relationship => POSSIBLE_SAME_WORK"
// (a DIRECT sameWorkRelationship input, bypassing the historical-match mapping).

// ── selective-corpus evidence ──────────────────────────────────────────
test("selective-corpus evidence: FAMILY_GUARD-flagged dominant span => FAMILY_BOILERPLATE", () => {
  const report = mkReport({
    unifiedSimilarity: { matchedPositions: range(30, 130), previousUploadPositions: [] },
  });
  const r = buildReportEvidenceInterpretation(report, {
    selectiveCorpusAdmittedSources: [
      { key: "sc-1", spans: [{ start: 30, end: 130, words: 101 }], familyGuardActivated: true, dominantSpanBoilerplate: true },
    ],
  });
  assert.ok(reconciles(r));
  assert.equal(r.countsByKind.FAMILY_BOILERPLATE, 101);
  assert.equal(r.sources[0].interpretation.primaryKind, "FAMILY_BOILERPLATE");
  assert.equal(r.sources[0].sourceType, "selective-corpus");
});

// ── mixed-source report + reconciliation ───────────────────────────────
test("mixed-source report: archive + scholarly + prior, positionsByKind is a disjoint partition", () => {
  const text = makeText(600, { quoteAt: [300, 340] });
  const toks = tokens(text);
  const qs = toks.indexOf("word300");
  const qe = toks.indexOf("word340");
  const archivePos = range(0, 120);
  const quotePos = range(qs, qe);
  const priorPos = range(450, 520);
  const union = [...new Set([...archivePos, ...quotePos, ...priorPos])].sort((a, b) => a - b);
  const report = mkReport({
    text,
    archiveMatchedPositions: archivePos,
    sources: [{ name: "Ref A", type: "Internet", percent: 20, matches: 2, matchedWords: 121, phrases: [], color: "#0" }],
    externalAcademicEvidence: [{
      provider: "epmc", providerId: "epmc", title: null, authors: null, publication: null, year: null, doi: null,
      url: "https://europepmc.org/article/MED/1", similarity: 55,
      matchedPassages: [{ submittedText: "", submittedWordStart: qs, submittedWordEnd: qe, matchedWordCount: qe - qs + 1 }],
    }],
    unifiedSimilarity: { matchedPositions: union, previousUploadPositions: priorPos },
    historicalSubmissionMatch: {
      status: "MATCHED", computedAt: "x", matcherVersion: "x", fingerprintVersion: "x", canonicalizationVersion: "x",
      matches: [{ relationshipType: "SELF", matchedRepresentationId: "r", matchType: "EXACT_CANONICAL_MATCH", containment: 1, matchedWordCount: 71, passageCount: 1, longestMatchWords: 71, passages: [], historicalSubmissionCount: 0 }],
    },
  });
  const r = buildReportEvidenceInterpretation(report);
  assert.equal(r.matchedWordCount, union.length);
  assert.ok(reconciles(r));
  // every position appears in exactly one kind bucket
  const all = [];
  for (const k of EVIDENCE_INTERPRETATION_KINDS) all.push(...r.positionsByKind[k]);
  assert.equal(all.length, new Set(all).size, "no position in two kinds");
  assert.deepEqual([...new Set(all)].sort((a, b) => a - b), union);
  assert.equal(r.countsByKind.ATTRIBUTED_QUOTATION, quotePos.length);
  // hardened: SELF + EXACT_CANONICAL_MATCH is NOT a work/version relationship,
  // so the prior-submission positions are DISTINCTIVE, not POSSIBLE_SAME_WORK.
  assert.equal(r.countsByKind.POSSIBLE_SAME_WORK, 0);
  assert.equal(r.countsByKind.DISTINCTIVE_EXTERNAL_MATCH, archivePos.length + priorPos.length);
  // opaque ids only
  const blob = JSON.stringify(r);
  assert.equal(/scb-\d|fixture:|bulk:|rep-|[0-9a-f]{32}/.test(blob), false);
  for (const s of r.sources) assert.match(s.id, /^src-\d+$/);
});

test("positionsByKind reconciliation: an authoritative position no adapter covers still lands in DISTINCTIVE", () => {
  const report = mkReport({
    // unified union has positions the archive/scholarly/prior adapters produce NO span for
    unifiedSimilarity: { matchedPositions: range(700, 760), previousUploadPositions: [] },
    archiveMatchedPositions: [],
  });
  const r = buildReportEvidenceInterpretation(report);
  assert.equal(r.matchedWordCount, 61);
  assert.equal(r.countsByKind.DISTINCTIVE_EXTERNAL_MATCH, 61);
  assert.ok(reconciles(r));
});

// ── safe source fallback labels ────────────────────────────────────────
test("safe source labels: title -> publication -> hostname -> generic", () => {
  const report = mkReport({
    unifiedSimilarity: { matchedPositions: range(0, 30), previousUploadPositions: [] },
    externalAcademicEvidence: [
      { provider: "p", providerId: "p", title: null, authors: null, publication: "Nature Methods", year: 2019, doi: null, url: null, similarity: 40, matchedPassages: [{ submittedText: "", submittedWordStart: 0, submittedWordEnd: 10, matchedWordCount: 11 }] },
      { provider: "p", providerId: "p", title: null, authors: null, publication: null, year: null, doi: null, url: "https://www.example.org/a/b", similarity: 40, matchedPassages: [{ submittedText: "", submittedWordStart: 12, submittedWordEnd: 20, matchedWordCount: 9 }] },
      { provider: "p", providerId: "p", title: null, authors: null, publication: null, year: null, doi: null, url: null, similarity: 40, matchedPassages: [{ submittedText: "", submittedWordStart: 22, submittedWordEnd: 30, matchedWordCount: 9 }] },
    ],
  });
  const r = buildReportEvidenceInterpretation(report);
  const labels = r.sources.map((s) => s.label);
  assert.ok(labels.includes("Nature Methods"));
  assert.ok(labels.includes("example.org"));
  assert.ok(labels.includes("Publication") || labels.includes("Internet source"));
});

// ── completion state ──────────────────────────────────────────────────
test("completion: EXTRACTION_PARTIAL beats provider failure", () => {
  const c = resolveReportCompletion({
    academicSearch: "FAILED",
    extraction: extractionDiagnosticFromCounts({ extractor: "pdf-text-extraction-v1", unit: "pages", total: 12, read: 9 }),
    verifiedSimilarityPercent: 14,
  });
  assert.equal(c.state, "EXTRACTION_PARTIAL");
  assert.match(c.headline, /could not be analyzed/);
  assert.match(c.detail, /3 pages/);
  assert.equal(c.reasons.length >= 2, true); // both extraction and provider failure recorded
});

test("completion: provider FAILED => PARTIAL with lower-bound detail", () => {
  const c = resolveReportCompletion({ academicSearch: "FAILED", extraction: plainTextExtractionDiagnostic(400), verifiedSimilarityPercent: 12 });
  assert.equal(c.state, "PARTIAL");
  assert.match(c.detail, /lower bound/);
  assert.equal(/entire internet/i.test(`${c.headline} ${c.detail}`), false);
});

test("completion: SOURCE_UNAVAILABLE when only an unverified candidate exists", () => {
  const c = resolveReportCompletion({ academicSearch: "COMPLETE_WITH_MATCHES", unverifiedCandidateCount: 1, extraction: unknownExtractionDiagnostic() });
  assert.equal(c.state, "SOURCE_UNAVAILABLE");
  assert.match(c.headline, /could not be verified/);
});

test("completion: clean run => COMPLETED, unknown extraction never forces EXTRACTION_PARTIAL", () => {
  const c = resolveReportCompletion({ academicSearch: "COMPLETE_NO_MATCHES", selectiveCorpus: "COMPLETED", extraction: unknownExtractionDiagnostic() });
  assert.equal(c.state, "COMPLETED");
  assert.equal(c.detail, null);
});

test("completion: Selective Corpus PARTIAL shard state feeds the model", () => {
  const c = resolveReportCompletion({ academicSearch: "COMPLETE_WITH_MATCHES", selectiveCorpus: "PARTIAL", verifiedSimilarityPercent: 9 });
  assert.equal(c.state, "PARTIAL");
  assert.match(c.reasons.join(" "), /reference index was unavailable/);
});

// ── adapters produce nothing when their channel is empty ────────────────
test("adapters: empty channels produce zero normalized sources", () => {
  const report = mkReport();
  assert.equal(normalizeArchiveEvidence(report).length, 0);
  assert.equal(normalizeScholarlyEvidence(report).length, 0);
  assert.equal(normalizePriorSubmissionEvidence(report).length, 0);
  assert.equal(normalizeSelectiveCorpusEvidence([], 100).length, 0);
  const r = buildReportEvidenceInterpretation(report);
  assert.equal(r.matchedWordCount, 0);
  assert.equal(r.sources.length, 0);
  assert.equal(r.passages.length, 0);
  assert.ok(reconciles(r));
});

// ── ordinary-user serialization privacy ────────────────────────────────
test("privacy: a full mixed interpretation payload serializes with no internal identifier", () => {
  const text = makeText(500, { quoteAt: [200, 230] });
  const toks = tokens(text);
  const qs = toks.indexOf("word200");
  const qe = toks.indexOf("word230");
  const report = mkReport({
    text,
    archiveMatchedPositions: range(0, 90),
    sources: [{ name: "Wikipedia — “Cell”", type: "Internet", percent: 15, matches: 2, matchedWords: 91, phrases: [], color: "#0" }],
    externalAcademicEvidence: [{ provider: "openaire", providerId: "openaire", title: "T", authors: ["A"], publication: "P", year: 2021, doi: "10.9/z", url: "https://pubmed.ncbi.nlm.nih.gov/123", similarity: 70, matchedPassages: [{ submittedText: "", submittedWordStart: qs, submittedWordEnd: qe, matchedWordCount: qe - qs + 1 }] }],
    unifiedSimilarity: {
      matchedPositions: [...new Set([...range(0, 90), ...range(qs, qe), ...range(400, 460)])].sort((a, b) => a - b),
      previousUploadPositions: range(400, 460),
      contributions: [{ matchedRepresentationId: "rep-XYZ", sourceId: "scb-000999" }],
    },
    historicalSubmissionMatch: {
      status: "MATCHED", computedAt: "x", matcherVersion: "x", fingerprintVersion: "x", canonicalizationVersion: "x",
      matches: [{ relationshipType: "PRIOR_SUBMISSION", matchedRepresentationId: "rep-XYZ", matchType: "STRONG_TEXT_MATCH", containment: 0.9, matchedWordCount: 61, passageCount: 1, longestMatchWords: 61, passages: [], historicalSubmissionCount: 3 }],
    },
  });
  const r = buildReportEvidenceInterpretation(report);
  const blob = JSON.stringify(r);
  for (const bad of ["rep-XYZ", "scb-000999", "matchedRepresentationId", "PRIOR_SUBMISSION", "historicalSubmissionCount", "canonicalizationVersion", "openaire", "providerId"]) {
    assert.equal(blob.includes(bad), false, `payload must not contain ${bad}`);
  }
  // public source URLs are allowed; filesystem paths and 32-hex digests are not
  assert.equal(/[0-9a-f]{32}/.test(blob), false, "no 32-hex digest");
  assert.equal(/[A-Za-z]:\\|\\\\|\/lib\/|\/home\/|\/Users\//.test(blob), false, "no filesystem path");
  // excerpts are the student's own text only
  for (const p of r.passages) assert.equal(typeof p.excerpt === "string" && p.excerpt.length > 0, true);
  assert.ok(reconciles(r));
});

// ── the builder never touches the report / its authoritative fields ─────
test("builder is read-only: report object and its authoritative fields are byte-identical after", () => {
  const report = mkReport({
    archiveMatchedPositions: range(0, 50),
    sources: [{ name: "X", type: "Internet", percent: 10, matches: 1, matchedWords: 51, phrases: [], color: "#0" }],
    unifiedSimilarity: { matchedPositions: range(0, 50), previousUploadPositions: [], unifiedScore: 13, uniqueMatchedWords: 51 },
    score: 13,
  });
  const before = JSON.stringify(report);
  const ev = normalizeReportEvidence(report);
  buildReportEvidenceInterpretation(report);
  assert.equal(JSON.stringify(report), before, "report untouched");
  // the normalized evidence reuses the authoritative union verbatim
  assert.deepEqual(ev.authoritativeMatchedPositions, range(0, 50));
});

test("kinds surface: exactly the 6 user-facing kinds, no COMMON_*", () => {
  assert.deepEqual([...EVIDENCE_INTERPRETATION_KINDS].sort(), [
    "ATTRIBUTED_QUOTATION", "DECLARED_QUOTATION", "DISTINCTIVE_EXTERNAL_MATCH",
    "FAMILY_BOILERPLATE", "LEGITIMATE_ALTERNATE_SOURCE", "POSSIBLE_SAME_WORK",
  ]);
});
