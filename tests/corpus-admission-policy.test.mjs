import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { decideCorpusAdmission, computeCorpusValueScore } from "../lib/corpus-admission-policy.ts";

const repoRoot = path.resolve(".");

function passingHardGate(languageClass = "CONFIDENT_ENGLISH") {
  return { passed: true, failureCodes: [], languageClass };
}
function failingHardGate(codes) {
  return { passed: false, failureCodes: codes, languageClass: "UNCERTAIN" };
}
function quality(qualityScore, overrides = {}) {
  return {
    qualityScore,
    qualityModelVersion: "test",
    componentScores: { extractionIntegrity: 80, linguisticQuality: 80, documentStructure: 80, contamination: 80, redundancy: 80, articleComposition: 80, ...overrides },
  };
}

test("hard-gate failure always REJECTs, regardless of quality/family/corpus-value", () => {
  const result = decideCorpusAdmission({
    hardGate: failingHardGate(["WORD_COUNT_BELOW_MINIMUM"]),
    format: "pdf",
    family: { relation: "NONE" },
    quality: quality(99),
    featureVector: null,
    corpusValueScore: 100,
  });
  assert.equal(result.decision, "REJECT");
  assert.ok(result.reasonCodes.includes("WORD_COUNT_BELOW_MINIMUM"));
});

test("a family match (exact duplicate) REJECTs before quality is even consulted — 'first accepted sample wins'", () => {
  const result = decideCorpusAdmission({
    hardGate: passingHardGate(),
    format: "pdf",
    family: { relation: "EXACT_DUPLICATE", matchedSourceRef: "prior-1" },
    quality: quality(99),
    featureVector: null,
    corpusValueScore: 100,
  });
  assert.equal(result.decision, "REJECT");
  assert.ok(result.reasonCodes.includes("DUPLICATE_ALREADY_REPRESENTED"));
});

test("a family match (edited version) REJECTs with EDITED_VERSION_ALREADY_REPRESENTED", () => {
  const result = decideCorpusAdmission({
    hardGate: passingHardGate(),
    format: "pdf",
    family: { relation: "EDITED_VERSION", matchedSourceRef: "prior-1", containment: 0.9 },
    quality: quality(99),
    featureVector: null,
    corpusValueScore: 100,
  });
  assert.equal(result.decision, "REJECT");
  assert.ok(result.reasonCodes.includes("EDITED_VERSION_ALREADY_REPRESENTED"));
});

test("high quality + high corpus-value + passing hard gate + no family match => ACCEPT", () => {
  const result = decideCorpusAdmission({
    hardGate: passingHardGate(),
    format: "pdf",
    family: { relation: "NONE" },
    quality: quality(90),
    featureVector: null,
    corpusValueScore: 90,
  });
  assert.equal(result.decision, "ACCEPT");
});

test("mid-band quality => REVIEW, not REJECT or ACCEPT (wide REVIEW band, favoring precision)", () => {
  const result = decideCorpusAdmission({
    hardGate: passingHardGate(),
    format: "pdf",
    family: { relation: "NONE" },
    quality: quality(50),
    featureVector: null,
    corpusValueScore: 90,
  });
  assert.equal(result.decision, "REVIEW");
});

test("critically low quality => REJECT even with passing hard gates and no family match", () => {
  const result = decideCorpusAdmission({
    hardGate: passingHardGate(),
    format: "pdf",
    family: { relation: "NONE" },
    quality: quality(5),
    featureVector: null,
    corpusValueScore: 90,
  });
  assert.equal(result.decision, "REJECT");
  assert.ok(result.reasonCodes.includes("OVERALL_QUALITY_CRITICALLY_LOW"));
});

test("the spec's own worked example: quality 95 + low corpus-value (near-duplicate-ish) => REVIEW, not ACCEPT, via LOW_CORPUS_VALUE", () => {
  const result = decideCorpusAdmission({
    hardGate: passingHardGate(),
    format: "pdf",
    family: { relation: "NONE" },
    quality: quality(95),
    featureVector: null,
    corpusValueScore: 32,
  });
  assert.equal(result.qualityScore, 95);
  assert.equal(result.corpusValueScore, 32);
  assert.equal(result.decision, "REVIEW");
  assert.ok(result.reasonCodes.includes("LOW_CORPUS_VALUE"));
});

test("uncertain language caps an otherwise-ACCEPT decision to REVIEW, never REJECT", () => {
  const result = decideCorpusAdmission({
    hardGate: passingHardGate("UNCERTAIN"),
    format: "pdf",
    family: { relation: "NONE" },
    quality: quality(95),
    featureVector: null,
    corpusValueScore: 95,
  });
  assert.equal(result.decision, "REVIEW");
  assert.ok(result.reasonCodes.includes("LANGUAGE_UNCERTAIN"));
});

test("ACCEPT is impossible unless language is CONFIDENT_ENGLISH, across a matrix of otherwise-maximal inputs", () => {
  for (const languageClass of ["CONFIDENT_ENGLISH", "CONFIDENT_NON_ENGLISH", "UNCERTAIN"]) {
    const hardGate = languageClass === "CONFIDENT_NON_ENGLISH" ? failingHardGate(["NOT_ENGLISH"]) : passingHardGate(languageClass);
    const result = decideCorpusAdmission({
      hardGate,
      format: "pdf",
      family: { relation: "NONE" },
      quality: quality(100),
      featureVector: null,
      corpusValueScore: 100,
    });
    if (languageClass === "CONFIDENT_ENGLISH") {
      assert.equal(result.decision, "ACCEPT", "confident English with maximal other signals should ACCEPT");
    } else {
      assert.notEqual(result.decision, "ACCEPT", `${languageClass} must never reach ACCEPT`);
    }
  }
});

test("html/md format caps an otherwise-ACCEPT decision to REVIEW (v1 defers these formats)", () => {
  for (const format of ["html", "md"]) {
    const result = decideCorpusAdmission({
      hardGate: passingHardGate(),
      format,
      family: { relation: "NONE" },
      quality: quality(95),
      featureVector: null,
      corpusValueScore: 95,
    });
    assert.equal(result.decision, "REVIEW", `${format} must be capped to REVIEW`);
    assert.ok(result.reasonCodes.includes("FORMAT_DEFERRED_FOR_V1"));
  }
});

test("pdf/docx/txt formats are not capped by the format-deferred rule", () => {
  for (const format of ["pdf", "docx", "txt"]) {
    const result = decideCorpusAdmission({
      hardGate: passingHardGate(),
      format,
      family: { relation: "NONE" },
      quality: quality(95),
      featureVector: null,
      corpusValueScore: 95,
    });
    assert.ok(!result.reasonCodes.includes("FORMAT_DEFERRED_FOR_V1"));
  }
});

test("decision is always exactly one of ACCEPT/REVIEW/REJECT — never a 4th value", () => {
  const allowed = new Set(["ACCEPT", "REVIEW", "REJECT"]);
  const samples = [
    decideCorpusAdmission({ hardGate: failingHardGate(["NOT_ENGLISH"]), format: "pdf", family: { relation: "NONE" }, quality: null, featureVector: null, corpusValueScore: null }),
    decideCorpusAdmission({ hardGate: passingHardGate(), format: "pdf", family: { relation: "EXACT_DUPLICATE", matchedSourceRef: "x" }, quality: quality(99), featureVector: null, corpusValueScore: 10 }),
    decideCorpusAdmission({ hardGate: passingHardGate(), format: "pdf", family: { relation: "NONE" }, quality: quality(95), featureVector: null, corpusValueScore: 95 }),
  ];
  for (const sample of samples) assert.ok(allowed.has(sample.decision));
});

test("computeCorpusValueScore: no candidates at all (null containment) scores maximally novel", () => {
  assert.equal(computeCorpusValueScore(null).corpusValueScore, 100);
});

test("computeCorpusValueScore: near-total containment against existing corpus scores near zero", () => {
  assert.ok(computeCorpusValueScore(0.98).corpusValueScore < 5);
});

// --- structural self-check (mirrors lib/e8o-historical-match-policy.ts's own import-free discipline) ---

test("structural: lib/corpus-admission-policy.ts stays import-free of lib/user-submission-corpus.ts and @libsql/client", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/corpus-admission-policy.ts"), "utf8");
  const importLines = source.split(/\r?\n/).filter((l) => /^\s*import\b.*\bfrom\b/.test(l)).join("\n");
  assert.doesNotMatch(importLines, /user-submission-corpus/);
  assert.doesNotMatch(importLines, /@libsql\/client/);
});
