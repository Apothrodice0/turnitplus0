import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  classifyDocumentLocalCorpusDuplicate,
  CORPUS_DUPLICATE_SUPPRESSION_POLICY_VERSION,
  DOCUMENT_LOCAL_CORPUS_DUPLICATE_EVIDENCE_LABEL,
} from "../lib/corpus-duplicate-suppression-policy.ts";

/**
 * Phase B1 — tests for the PURE candidate policy. No DB, no env, no HTTP —
 * every case constructs plain evidence and asserts on the plain return value.
 * The policy establishes ONLY "is this a shadow exact-canonical duplicate
 * candidate" — never SELF / ownership / authorship / authorized reuse.
 */

function evidence(overrides = {}) {
  return {
    historicalStatus: "MATCHED",
    relationshipType: "TURNITPLUS_CORPUS_SOURCE",
    matchType: "EXACT_CANONICAL_MATCH",
    reportIsAuthenticated: true,
    isAlreadyEffectiveDeviceSelf: false,
    backing: { admittedPromotionBackingCount: 1, submissionReferenceBackingCount: 0 },
    ...overrides,
  };
}

test("qualifying: TURNITPLUS_CORPUS_SOURCE + EXACT_CANONICAL_MATCH + single-backing shape + authenticated + not device-self → candidate", () => {
  const c = classifyDocumentLocalCorpusDuplicate(evidence());
  assert.equal(c.isCandidate, true);
  assert.equal(c.category, "CROSS_ACCOUNT_EXACT_CANONICAL");
  assert.equal(c.originConfidence, "SINGLE_BACKING_NO_MULTI_ORIGIN_EVIDENCE");
  assert.equal(c.multiOriginEvidence, "MULTI_ORIGIN_NOT_PROVEN");
  assert.equal(c.evidenceLabel, DOCUMENT_LOCAL_CORPUS_DUPLICATE_EVIDENCE_LABEL);
  assert.equal(c.evidenceLabel, "DOCUMENT_LOCAL_CORPUS_DUPLICATE_CANDIDATE");
  assert.equal(c.policyVersion, CORPUS_DUPLICATE_SUPPRESSION_POLICY_VERSION);
});

test("STRONG_TEXT_MATCH → not a candidate (Phase B is exact-canonical whole-document only)", () => {
  const c = classifyDocumentLocalCorpusDuplicate(evidence({ matchType: "STRONG_TEXT_MATCH" }));
  assert.equal(c.isCandidate, false);
  assert.equal(c.category, "NOT_EXACT_CANONICAL");
  assert.equal(c.originConfidence, "NOT_EVALUATED");
  assert.equal(c.multiOriginEvidence, "N/A");
});

test("UNKNOWN_RELATIONSHIP → not a candidate (scoring already excludes it)", () => {
  const c = classifyDocumentLocalCorpusDuplicate(evidence({ relationshipType: "UNKNOWN_RELATIONSHIP" }));
  assert.equal(c.isCandidate, false);
  assert.equal(c.category, "ALREADY_UNKNOWN");
});

test("SELF → not a candidate (scoring already excludes it; Phase B claims no additional suppression)", () => {
  const c = classifyDocumentLocalCorpusDuplicate(evidence({ relationshipType: "SELF" }));
  assert.equal(c.isCandidate, false);
  assert.equal(c.category, "ALREADY_SELF");
});

test("already an effective same-Passport SELF → not a candidate / already-excluded category (no double-count)", () => {
  const c = classifyDocumentLocalCorpusDuplicate(evidence({ isAlreadyEffectiveDeviceSelf: true }));
  assert.equal(c.isCandidate, false);
  assert.equal(c.category, "ALREADY_EFFECTIVE_DEVICE_SELF");
});

test("anonymous report → conservatively not a candidate", () => {
  const c = classifyDocumentLocalCorpusDuplicate(evidence({ reportIsAuthenticated: false }));
  assert.equal(c.isCandidate, false);
  assert.equal(c.category, "ANONYMOUS");
});

test("PRIOR_SUBMISSION is NOT a Phase-B1 candidate even with exact canonical match + good backing (dormant path, needs its own review)", () => {
  const c = classifyDocumentLocalCorpusDuplicate(evidence({ relationshipType: "PRIOR_SUBMISSION" }));
  assert.equal(c.isCandidate, false);
  assert.equal(c.category, "NOT_CORPUS_SOURCE");
});

test("backing shape with 2 admission backings → BACKING_SHAPE_UNSUPPORTED (never MULTI_ORIGIN_PROVEN in B1)", () => {
  const c = classifyDocumentLocalCorpusDuplicate(evidence({
    backing: { admittedPromotionBackingCount: 2, submissionReferenceBackingCount: 0 },
  }));
  assert.equal(c.isCandidate, false);
  assert.equal(c.category, "BACKING_SHAPE_UNSUPPORTED");
  assert.equal(c.originConfidence, "BACKING_SHAPE_UNSUPPORTED");
  assert.equal(c.multiOriginEvidence, "N/A");
});

test("backing shape with a submission-reference backing → BACKING_SHAPE_UNSUPPORTED", () => {
  const c = classifyDocumentLocalCorpusDuplicate(evidence({
    backing: { admittedPromotionBackingCount: 1, submissionReferenceBackingCount: 1 },
  }));
  assert.equal(c.isCandidate, false);
  assert.equal(c.category, "BACKING_SHAPE_UNSUPPORTED");
});

test("backing shape with zero backings → BACKING_SHAPE_UNSUPPORTED", () => {
  const c = classifyDocumentLocalCorpusDuplicate(evidence({
    backing: { admittedPromotionBackingCount: 0, submissionReferenceBackingCount: 0 },
  }));
  assert.equal(c.isCandidate, false);
  assert.equal(c.category, "BACKING_SHAPE_UNSUPPORTED");
});

test("historical status NO_HISTORICAL_MATCH → not a candidate", () => {
  const c = classifyDocumentLocalCorpusDuplicate(evidence({ historicalStatus: "NO_HISTORICAL_MATCH" }));
  assert.equal(c.isCandidate, false);
  assert.equal(c.category, "NOT_MATCHED");
});

test("historical status UNAVAILABLE → not a candidate", () => {
  const c = classifyDocumentLocalCorpusDuplicate(evidence({ historicalStatus: "UNAVAILABLE" }));
  assert.equal(c.isCandidate, false);
  assert.equal(c.category, "NOT_MATCHED");
});

test("gate precedence: SELF wins over an unsupported backing shape (SELF is checked first)", () => {
  const c = classifyDocumentLocalCorpusDuplicate(evidence({
    relationshipType: "SELF",
    backing: { admittedPromotionBackingCount: 5, submissionReferenceBackingCount: 3 },
  }));
  assert.equal(c.category, "ALREADY_SELF");
});

test("the classification never contains ownership / SELF-attribution / authorship / authorized-reuse wording for a real candidate", () => {
  const c = classifyDocumentLocalCorpusDuplicate(evidence());
  const blob = JSON.stringify(c).toLowerCase();
  assert.doesNotMatch(blob, /same owner|same person|is self\b|authorship|authored by|authorized reuse|declared reuse/);
  // "already_self" / "already_effective_device_self" categories are fine as
  // NON-candidate reasons, but a real candidate must never carry them.
  assert.doesNotMatch(c.category, /SELF/);
});

test("no forbidden lineage vocabulary in the module's CODE (comments may explain why it is absent)", () => {
  const raw = fs.readFileSync(path.resolve("lib/corpus-duplicate-suppression-policy.ts"), "utf8");
  // Strip /* */ and // comments — the header comment legitimately names these
  // tokens to document that they are deliberately NOT emitted.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /PROVEN_SINGLE_LINEAGE/, "Phase B must never have a PROVEN_SINGLE_LINEAGE value in code");
  assert.doesNotMatch(code, /MULTI_ORIGIN_PROVEN/, "Phase B1 must never have a MULTI_ORIGIN_PROVEN value in code");

  // And prove it at runtime: no reachable classification carries either token.
  const cases = [
    evidence(),
    evidence({ matchType: "STRONG_TEXT_MATCH" }),
    evidence({ relationshipType: "SELF" }),
    evidence({ relationshipType: "PRIOR_SUBMISSION" }),
    evidence({ backing: { admittedPromotionBackingCount: 3, submissionReferenceBackingCount: 2 } }),
    evidence({ historicalStatus: "NO_HISTORICAL_MATCH" }),
    evidence({ reportIsAuthenticated: false }),
  ];
  for (const c of cases) {
    const blob = JSON.stringify(classifyDocumentLocalCorpusDuplicate(c));
    assert.doesNotMatch(blob, /PROVEN_SINGLE_LINEAGE|MULTI_ORIGIN_PROVEN/);
  }
});

test("structural: the policy module is pure — no DB client, no env reads, no db calls", () => {
  const source = fs.readFileSync(path.resolve("lib/corpus-duplicate-suppression-policy.ts"), "utf8");
  const importLines = source.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join("\n");
  assert.doesNotMatch(importLines, /@libsql\/client/, "must not import a database client");
  assert.doesNotMatch(source, /process\.env/, "must not read the environment");
  assert.doesNotMatch(source, /\bclient\.(execute|batch)\b/, "must perform no database calls");
});

test("byte-for-byte determinism: same evidence in → identical classification out", () => {
  const a = classifyDocumentLocalCorpusDuplicate(evidence());
  const b = classifyDocumentLocalCorpusDuplicate(evidence());
  assert.deepEqual(a, b);
});
