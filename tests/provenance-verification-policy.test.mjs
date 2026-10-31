import assert from "node:assert/strict";
import test from "node:test";
import { EVIDENCE_TYPES, EVIDENCE_LEVELS, DISCOVERY_TYPES, isEvidenceType, isEvidenceLevel, isDiscoveryType } from "../lib/provenance-evidence-types.ts";
import {
  VERIFICATION_CRITERIA,
  evaluateVerificationGate,
  deriveEvidenceLevel,
  evaluateVerificationEligibility,
} from "../lib/provenance-verification-policy.ts";
import { classifySubmitterRelationship } from "../lib/document-relationship.ts";

// This whole file is pure-function testing: no database, no network, no
// filesystem beyond the test runner itself. Every fixture below assigns each
// evidence record its own distinct observedAt (minutes apart from a fixed
// base) specifically so that "ordering does not matter" (Edge case I) can be
// tested unambiguously — see lib/provenance-verification-policy.ts's own
// sortedByObservedAt() comment for why ties would otherwise fall back to
// input order.

let seq = 0;
function ev(evidenceType, payload) {
  seq += 1;
  return { id: seq, evidenceType, payload, observedAt: `2026-08-01T00:${String(seq).padStart(2, "0")}:00.000Z` };
}

// A minimal record for each of the nine gate criteria, built once per test
// via freshEvidence() below so `seq`-derived timestamps/ids never collide
// across tests.
function freshEvidence() {
  return {
    externalAnchor: ev("EXTERNAL_IDENTIFIER", { identifierType: "DOI", identifierValue: "10.1234/example" }),
    sourceClass: ev("SOURCE_CLASS", { sourceClass: "academic_journal", eligibleForVerification: true }),
    publisher: ev("PUBLISHER_IDENTITY", { publisher: "Example University Press", domain: "example.edu" }),
    correspondence: ev("CANONICAL_CORRESPONDENCE", { method: "canonical_hash", match: true }),
    retrievalTimestamp: ev("RETRIEVAL_TIMESTAMP", { retrievedAt: "2026-08-01T00:00:00.000Z" }),
    contentHash: ev("CONTENT_HASH", { candidateHash: "abc", externalHash: "abc", algorithm: "sha256", match: true }),
    accessibility: ev("URL_ACCESSIBILITY", { url: "https://example.edu/article", httpStatus: 200, retrievedAt: "2026-08-01T00:00:00.000Z", accessible: true }),
    independence: ev("DISCOVERY_INDEPENDENCE", { discoveryType: "INDEPENDENT_DISCOVERY", independent: true, basis: "found via curated registry" }),
  };
}

// Named for what it satisfies (all nine gate criteria), not for its record
// count: NO_UNRESOLVED_CONFLICT is satisfied by the *absence* of any
// MIRROR_CONFLICT/SOURCE_DISPUTE/RETRACTION record, so this fixture needs
// only eight actual evidence records to cover all nine criteria.
function fullEvidenceSet() {
  return Object.values(freshEvidence());
}

// --- Vocabulary ---------------------------------------------------------------

test("EVIDENCE_TYPES is exactly the fifteen Phase E3 types, no more, no less", () => {
  assert.equal(EVIDENCE_TYPES.length, 15);
  for (const type of EVIDENCE_TYPES) assert.equal(isEvidenceType(type), true);
  assert.equal(isEvidenceType("WIKIPEDIA_MATCH"), false, "unlisted types must not be invented");
});

test("EVIDENCE_LEVELS is exactly the five Phase E3 levels in ascending order", () => {
  assert.deepEqual(EVIDENCE_LEVELS, ["NO_EVIDENCE", "WEAK_DISCOVERY", "CANDIDATE_CORRESPONDENCE", "STRONG_CORRESPONDENCE", "PROVENANCE_VERIFIED"]);
  for (const level of EVIDENCE_LEVELS) assert.equal(isEvidenceLevel(level), true);
});

test("DISCOVERY_TYPES is exactly the three independence-rule values", () => {
  assert.deepEqual(DISCOVERY_TYPES, ["INDEPENDENT_DISCOVERY", "USER_SUPPLIED", "DERIVED_FROM_SUBMISSION_TEXT_ONLY"]);
  for (const type of DISCOVERY_TYPES) assert.equal(isDiscoveryType(type), true);
  assert.equal(isDiscoveryType("PRIOR_SUBMISSION"), false, "a document-relationship type must never be accepted as a discovery type");
});

// --- POLICY: the five evidence levels -----------------------------------------

test("POLICY: NO_EVIDENCE when there are no records at all", () => {
  const result = evaluateVerificationEligibility([]);
  assert.equal(result.evidenceLevel, "NO_EVIDENCE");
  assert.equal(result.eligible, false);
});

test("POLICY: WEAK_DISCOVERY when some evidence exists but no correspondence was attempted", () => {
  const evidence = [ev("EXTERNAL_IDENTIFIER", { identifierType: "DOI", identifierValue: "10.1/x" })];
  const result = evaluateVerificationEligibility(evidence);
  assert.equal(result.evidenceLevel, "WEAK_DISCOVERY");
  assert.equal(result.eligible, false);
});

test("POLICY: CANDIDATE_CORRESPONDENCE when correspondence was attempted but is not strong", () => {
  const belowThreshold = [ev("STRONG_TEXT_CORRESPONDENCE", { method: "shingle_containment", containment: 0.31, threshold: 0.6, match: false })];
  const result = evaluateVerificationEligibility(belowThreshold);
  assert.equal(result.evidenceLevel, "CANDIDATE_CORRESPONDENCE");
  assert.equal(result.eligible, false);
});

test("POLICY: CANDIDATE_CORRESPONDENCE also holds for passage-level-only overlap", () => {
  const passageOnly = [ev("PASSAGE_CORRESPONDENCE", { passages: [{ candidateExcerpt: "a", externalExcerpt: "a" }] })];
  const result = evaluateVerificationEligibility(passageOnly);
  assert.equal(result.evidenceLevel, "CANDIDATE_CORRESPONDENCE");
});

test("POLICY: STRONG_CORRESPONDENCE when correspondence is strong but the full gate is not satisfied", () => {
  const strongOnly = [ev("STRONG_TEXT_CORRESPONDENCE", { method: "shingle_containment", containment: 0.94, threshold: 0.6, match: true })];
  const result = evaluateVerificationEligibility(strongOnly);
  assert.equal(result.evidenceLevel, "STRONG_CORRESPONDENCE");
  assert.equal(result.eligible, false);
});

test("POLICY: PROVENANCE_VERIFIED only when all nine gate criteria are satisfied", () => {
  const result = evaluateVerificationEligibility(fullEvidenceSet());
  assert.equal(result.evidenceLevel, "PROVENANCE_VERIFIED");
  assert.equal(result.eligible, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.satisfied.length, 9);
});

test("deriveEvidenceLevel, called directly with a pre-computed gate, agrees with evaluateVerificationEligibility's composed result", () => {
  const evidence = fullEvidenceSet();
  const gate = evaluateVerificationGate(evidence);
  assert.equal(deriveEvidenceLevel(evidence, gate), "PROVENANCE_VERIFIED");

  const strongOnly = [ev("CANONICAL_CORRESPONDENCE", { method: "canonical_hash", match: true })];
  const strongOnlyGate = evaluateVerificationGate(strongOnly);
  assert.equal(deriveEvidenceLevel(strongOnly, strongOnlyGate), "STRONG_CORRESPONDENCE");
});

// --- GATE: nine criteria ---------------------------------------------------

test("GATE: VERIFICATION_CRITERIA has exactly the nine named criteria", () => {
  assert.deepEqual(VERIFICATION_CRITERIA, [
    "EXTERNAL_ANCHOR",
    "ACCEPTABLE_SOURCE_CLASS",
    "IDENTIFIABLE_PUBLISHER",
    "STRONG_CORRESPONDENCE",
    "RETRIEVAL_TIMESTAMP_RECORDED",
    "RETRIEVED_CONTENT_HASH",
    "ACCESSIBILITY_CONFIRMED",
    "NO_UNRESOLVED_CONFLICT",
    "INDEPENDENT_DISCOVERY",
  ]);
});

test("GATE (Edge case G): all nine criteria together produce eligibility", () => {
  const gate = evaluateVerificationGate(fullEvidenceSet());
  assert.equal(gate.eligible, true);
  assert.deepEqual(gate.missing, []);
});

// URL_ACCESSIBILITY's payload legitimately doubles as evidence for two other
// criteria (its `url` field also satisfies EXTERNAL_ANCHOR; its `retrievedAt`
// field also satisfies RETRIEVAL_TIMESTAMP_RECORDED — see
// lib/provenance-verification-policy.ts's hasExternalAnchor/
// hasRetrievalTimestamp). That overlap is intentional (a URL you actually
// fetched IS an anchor, and IS a retrieval), so isolating exactly one
// missing criterion for this test requires also neutralizing those
// overlapping fields on the accessibility fixture, not just deleting one
// record — a plain "delete one key" loop would otherwise still find EXTERNAL_
// ANCHOR/RETRIEVAL_TIMESTAMP_RECORDED satisfied via the untouched
// accessibility record.
function evidenceMissingOnly(criterion) {
  const fixture = freshEvidence();
  switch (criterion) {
    case "EXTERNAL_ANCHOR":
      delete fixture.externalAnchor;
      fixture.accessibility = ev("URL_ACCESSIBILITY", { url: null, httpStatus: 200, retrievedAt: "2026-08-01T00:00:00.000Z", accessible: true });
      break;
    case "ACCEPTABLE_SOURCE_CLASS":
      delete fixture.sourceClass;
      break;
    case "IDENTIFIABLE_PUBLISHER":
      delete fixture.publisher;
      break;
    case "STRONG_CORRESPONDENCE":
      delete fixture.correspondence;
      break;
    case "RETRIEVAL_TIMESTAMP_RECORDED":
      delete fixture.retrievalTimestamp;
      fixture.accessibility = ev("URL_ACCESSIBILITY", { url: "https://example.edu/article", httpStatus: 200, retrievedAt: null, accessible: true });
      break;
    case "RETRIEVED_CONTENT_HASH":
      delete fixture.contentHash;
      break;
    case "ACCESSIBILITY_CONFIRMED":
      fixture.accessibility = ev("URL_ACCESSIBILITY", { url: "https://example.edu/article", httpStatus: 404, retrievedAt: "2026-08-01T00:00:00.000Z", accessible: false });
      break;
    case "NO_UNRESOLVED_CONFLICT":
      return null; // absence is already satisfied; tested separately above via an active conflict record
    case "INDEPENDENT_DISCOVERY":
      delete fixture.independence;
      break;
    default:
      throw new Error(`unhandled criterion in test fixture builder: ${criterion}`);
  }
  return Object.values(fixture);
}

test("GATE (Edge case H): missing any single required criterion prevents eligibility", () => {
  for (const omitted of VERIFICATION_CRITERIA) {
    const evidence = evidenceMissingOnly(omitted);
    if (evidence === null) continue;
    const gate = evaluateVerificationGate(evidence);
    assert.equal(gate.eligible, false, `omitting ${omitted}'s evidence must prevent eligibility`);
    assert.ok(gate.missing.includes(omitted), `missing must list ${omitted}`);
    assert.equal(gate.missing.length, 1, `omitting only ${omitted}'s evidence should leave exactly one criterion missing (got: ${gate.missing.join(", ")})`);
  }
});

// --- Edge cases A-D: similarity/metadata/URL alone never verify --------------

test("Edge case A: strong text similarity alone does NOT produce PROVENANCE_VERIFIED", () => {
  const evidence = [ev("STRONG_TEXT_CORRESPONDENCE", { method: "shingle_containment", containment: 0.97, threshold: 0.6, match: true })];
  const result = evaluateVerificationEligibility(evidence);
  assert.notEqual(result.evidenceLevel, "PROVENANCE_VERIFIED");
  assert.equal(result.eligible, false);
  // Only STRONG_CORRESPONDENCE is satisfied by this single record;
  // NO_UNRESOLVED_CONFLICT is also (trivially) satisfied, since no
  // conflict/dispute/retraction evidence exists at all — so 7 of the
  // remaining 8 criteria are missing, not 8.
  assert.equal(result.missing.length, 7);
  assert.ok(!result.missing.includes("NO_UNRESOLVED_CONFLICT"));
});

test("Edge case B: the same title alone (mere metadata) does NOT produce PROVENANCE_VERIFIED", () => {
  const evidence = [ev("METADATA", { title: "A Shared Title" })];
  const result = evaluateVerificationEligibility(evidence);
  assert.equal(result.evidenceLevel, "WEAK_DISCOVERY");
  assert.equal(result.eligible, false);
});

test("Edge case C: an external URL alone does NOT produce PROVENANCE_VERIFIED", () => {
  const evidence = [ev("URL_ACCESSIBILITY", { url: "https://example.org/paper", httpStatus: 200, retrievedAt: "2026-08-01T00:00:00.000Z", accessible: true })];
  const result = evaluateVerificationEligibility(evidence);
  assert.notEqual(result.evidenceLevel, "PROVENANCE_VERIFIED");
  assert.equal(result.eligible, false, "a URL, even a reachable one, is not correspondence");
});

test("Edge case D: publisher metadata alone does NOT produce PROVENANCE_VERIFIED", () => {
  const evidence = [ev("PUBLISHER_IDENTITY", { publisher: "A Real Publisher", domain: "publisher.example" })];
  const result = evaluateVerificationEligibility(evidence);
  assert.notEqual(result.evidenceLevel, "PROVENANCE_VERIFIED");
  assert.equal(result.eligible, false);
});

// --- Edge cases E-F: independence cannot be self-claimed ----------------------

test("Edge case E: a USER_SUPPLIED discovery cannot satisfy independence, even if the payload claims independent=true", () => {
  const fixture = freshEvidence();
  fixture.independence = ev("DISCOVERY_INDEPENDENCE", { discoveryType: "USER_SUPPLIED", independent: true, basis: "the same user who submitted also supplied this URL" });
  const result = evaluateVerificationEligibility(Object.values(fixture));
  assert.equal(result.eligible, false);
  assert.ok(result.missing.includes("INDEPENDENT_DISCOVERY"));
  assert.equal(result.evidenceLevel, "STRONG_CORRESPONDENCE", "correspondence still holds, but verification must not be reachable");
});

test("Edge case F: DERIVED_FROM_SUBMISSION_TEXT_ONLY cannot satisfy independence", () => {
  const fixture = freshEvidence();
  fixture.independence = ev("DISCOVERY_INDEPENDENCE", { discoveryType: "DERIVED_FROM_SUBMISSION_TEXT_ONLY", independent: true, basis: "reappeared online after the submission was made" });
  const result = evaluateVerificationEligibility(Object.values(fixture));
  assert.equal(result.eligible, false);
  assert.ok(result.missing.includes("INDEPENDENT_DISCOVERY"));
});

test("no DISCOVERY_INDEPENDENCE record at all also fails the independence criterion", () => {
  const fixture = freshEvidence();
  delete fixture.independence;
  const gate = evaluateVerificationGate(Object.values(fixture));
  assert.ok(gate.missing.includes("INDEPENDENT_DISCOVERY"));
});

// --- Conflict/dispute/retraction block NO_UNRESOLVED_CONFLICT -----------------

test("GATE: an unresolved mirror conflict blocks eligibility even with all other criteria satisfied", () => {
  const evidence = [...fullEvidenceSet(), ev("MIRROR_CONFLICT", { description: "a mirrored copy exists at another domain", resolved: false })];
  const result = evaluateVerificationEligibility(evidence);
  assert.equal(result.eligible, false);
  assert.ok(result.missing.includes("NO_UNRESOLVED_CONFLICT"));
});

test("GATE: a resolved mirror conflict does not block eligibility", () => {
  const evidence = [...fullEvidenceSet(), ev("MIRROR_CONFLICT", { description: "a mirrored copy exists at another domain", resolved: true })];
  const result = evaluateVerificationEligibility(evidence);
  assert.equal(result.eligible, true);
});

test("GATE: an unresolved source dispute blocks eligibility", () => {
  const evidence = [...fullEvidenceSet(), ev("SOURCE_DISPUTE", { description: "authenticity has been challenged", resolved: false })];
  const result = evaluateVerificationEligibility(evidence);
  assert.equal(result.eligible, false);
  assert.ok(result.missing.includes("NO_UNRESOLVED_CONFLICT"));
});

test("GATE: an active retraction blocks eligibility", () => {
  const evidence = [...fullEvidenceSet(), ev("RETRACTION", { description: "publisher retraction notice", active: true })];
  const result = evaluateVerificationEligibility(evidence);
  assert.equal(result.eligible, false);
  assert.ok(result.missing.includes("NO_UNRESOLVED_CONFLICT"));
});

test("GATE: a later resolution of a dispute restores eligibility (latest record wins)", () => {
  const fixture = fullEvidenceSet();
  fixture.push(ev("SOURCE_DISPUTE", { description: "authenticity challenged", resolved: false }));
  fixture.push(ev("SOURCE_DISPUTE", { description: "challenge withdrawn after review", resolved: true }));
  const result = evaluateVerificationEligibility(fixture);
  assert.equal(result.eligible, true, "the most recent dispute record (resolved) must be the one that governs");
});

// --- Determinism ---------------------------------------------------------------

test("Edge case I: evidence ordering does not change the derived result", () => {
  const forward = fullEvidenceSet();
  const reversed = [...forward].reverse();
  const shuffled = [forward[3], forward[0], forward[7], forward[1], forward[6], forward[2], forward[5], forward[4]];

  const resultForward = evaluateVerificationEligibility(forward);
  const resultReversed = evaluateVerificationEligibility(reversed);
  const resultShuffled = evaluateVerificationEligibility(shuffled);

  assert.deepEqual(resultReversed, resultForward);
  assert.deepEqual(resultShuffled, resultForward);
});

test("Edge case J: duplicate evidence records do not accidentally weaken eligibility", () => {
  const base = fullEvidenceSet();
  const duplicated = [...base, ...base.map((record) => ({ ...record, id: record.id + 1000 }))];
  const result = evaluateVerificationEligibility(duplicated);
  assert.equal(result.eligible, true);
  assert.deepEqual(result.missing, []);
});

test("Edge case K: a later negative evidence record is represented, not silently overwritten by the earlier positive", () => {
  const base = fullEvidenceSet();
  const laterNegative = ev("URL_ACCESSIBILITY", { url: "https://example.edu/article", httpStatus: 404, retrievedAt: "2026-09-01T00:00:00.000Z", accessible: false });
  const withLaterNegative = [...base, laterNegative];

  const before = evaluateVerificationEligibility(base);
  assert.equal(before.eligible, true);

  const after = evaluateVerificationEligibility(withLaterNegative);
  assert.equal(after.eligible, false, "the newer, negative accessibility fact must take precedence for current eligibility");
  assert.ok(after.missing.includes("ACCESSIBILITY_CONFIRMED"));

  // The original positive record is still present in the input — it was
  // never removed, only outranked by a more recent observation.
  assert.equal(withLaterNegative.filter((r) => r.evidenceType === "URL_ACCESSIBILITY").length, 2);
});

test("Edge case L: evidence records are never mutated by evaluation", () => {
  const evidence = fullEvidenceSet().map((record) => Object.freeze({ ...record, payload: Object.freeze({ ...record.payload }) }));
  const frozenArray = Object.freeze(evidence);
  const snapshotBefore = JSON.parse(JSON.stringify(evidence));

  assert.doesNotThrow(() => evaluateVerificationEligibility(frozenArray));

  assert.deepEqual(JSON.parse(JSON.stringify(evidence)), snapshotBefore, "evaluation must not mutate the records it was given");
});

test("determinism: calling evaluateVerificationEligibility twice with the same input yields identical output", () => {
  const evidence = fullEvidenceSet();
  const first = evaluateVerificationEligibility(evidence);
  const second = evaluateVerificationEligibility(evidence);
  assert.deepEqual(first, second);
});

// --- SEPARATION: relationship classification is a wholly independent axis ----

test("SEPARATION: a PRIOR_SUBMISSION relationship does not qualify as, or contribute to, provenance evidence", () => {
  // classifySubmitterRelationship (Phase C) and evaluateVerificationEligibility
  // (Phase E4) operate on entirely disjoint inputs — an account-id pair
  // versus an evidence-record array — and neither is ever passed into the
  // other. This test demonstrates that computing one has no bearing on the
  // other's result, for the same conceptual "match."
  const relationship = classifySubmitterRelationship("account-b", "account-a");
  assert.equal(relationship, "PRIOR_SUBMISSION");

  const eligibility = evaluateVerificationEligibility([]);
  assert.equal(eligibility.evidenceLevel, "NO_EVIDENCE", "a PRIOR_SUBMISSION relationship must not itself supply any evidence");
  assert.equal(eligibility.eligible, false);
});

test("SEPARATION: SELF does not qualify as, or contribute to, provenance evidence", () => {
  const relationship = classifySubmitterRelationship("account-a", "account-a");
  assert.equal(relationship, "SELF");

  const eligibility = evaluateVerificationEligibility([]);
  assert.equal(eligibility.evidenceLevel, "NO_EVIDENCE", "a SELF relationship must not itself supply any evidence");
});

test("SEPARATION: full provenance verification (independent of any relationship) coexists with an unrelated PRIOR_SUBMISSION classification without either affecting the other", () => {
  const relationship = classifySubmitterRelationship("account-b", "account-a");
  const eligibility = evaluateVerificationEligibility(fullEvidenceSet());
  assert.equal(relationship, "PRIOR_SUBMISSION");
  assert.equal(eligibility.eligible, true);
  // Computing eligibility a second time after computing the relationship
  // must give byte-identical results — proof that the relationship call had
  // no side effect on the (purely functional) evidence evaluator.
  assert.deepEqual(evaluateVerificationEligibility(fullEvidenceSet()).missing, []);
});

test("SEPARATION: no evidence type or discovery type overlaps with DocumentRelationshipType's vocabulary (SELF/PRIOR_SUBMISSION/VERIFIED_SOURCE_MATCH)", () => {
  const relationshipValues = ["SELF", "PRIOR_SUBMISSION", "VERIFIED_SOURCE_MATCH"];
  for (const value of relationshipValues) {
    assert.equal(isEvidenceType(value), false);
    assert.equal(isDiscoveryType(value), false);
  }
});
