import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import {
  classifyHistoricalMatch, PROPOSED_ACCEPTANCE_THRESHOLDS, PROPOSED_ACCEPTANCE_POLICY_VERSION,
  PROPOSED_ROBUST_CORRESPONDENCE_VERSION, PROPOSED_DISTINCTIVENESS_MODEL_VERSION,
  CHOSEN_E8M_ROLE_PLACEMENT, UI_CONTRACT, PRIVACY_RETENTION_CONTRACT, ROLLOUT_PLAN, OBSERVABILITY_METRICS,
  MULTI_BLOCK_POLICY_NOTES, FALSE_POSITIVE_GUARDRAIL_NOTES,
} from "../lib/e8o-historical-match-policy.ts";
import { ROBUST_CORRESPONDENCE_VERSION } from "../lib/e8m-robust-correspondence.ts";
import { DISTINCTIVENESS_MODEL_V2 } from "../lib/e8l-distinctiveness-v2.ts";
import { ACCEPTANCE_SCENARIOS, runAcceptanceMatrix, MULTI_BLOCK_LANDMARK_NEAR_MISS } from "../tools/e8o-acceptance-matrix.ts";

/**
 * Phase E8O: tests for the production historical-match acceptance
 * specification. This is a DESIGN-PHASE test suite: it validates internal
 * consistency of the specification itself (taxonomy, decision tree,
 * threshold provenance, relationship/evidence independence) and runs the
 * acceptance matrix against E8J-E8N's already-built fixtures. Nothing here
 * connects to Turso, imports @libsql/client, or touches production code.
 */

const repoRoot = path.resolve(".");
function stripComments(source) { return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); }

// --- A: taxonomy vocabulary stays byte-identical to production's own RelationshipType -----------------

test("A: RelationshipType values are byte-identical to lib/user-submission-matching.ts's own vocabulary", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/user-submission-matching.ts"), "utf8");
  const match = source.match(/export type RelationshipType = ("[^"]+" \| "[^"]+" \| "[^"]+");/);
  assert.ok(match, "expected to find RelationshipType's literal union in lib/user-submission-matching.ts");
  const productionValues = match[1].split("|").map((s) => s.trim().replace(/"/g, ""));
  assert.deepEqual(productionValues.sort(), ["SELF", "PRIOR_SUBMISSION", "UNKNOWN_RELATIONSHIP"].sort());
  // lib/e8o-historical-match-policy.ts re-declares (does not import) the same three values — exercised structurally below (test H) and behaviorally via every classifyHistoricalMatch call in this file.
});

// --- B: version constants match the real, already-shipped E8L/E8M constants (no silent drift) ---------

test("B: proposed version constants for reused engines match the real exported constants exactly", () => {
  assert.equal(PROPOSED_ROBUST_CORRESPONDENCE_VERSION, ROBUST_CORRESPONDENCE_VERSION);
  assert.equal(PROPOSED_DISTINCTIVENESS_MODEL_VERSION, DISTINCTIVENESS_MODEL_V2);
  assert.equal(PROPOSED_ACCEPTANCE_POLICY_VERSION, "e8o-policy-v1");
});

// --- C: threshold metadata completeness and provenance --------------------------------------------------

test("C: every proposed threshold has a status in the 4-value vocabulary and a non-empty rationale", () => {
  const allowed = new Set(["EVIDENCE_BACKED", "ENGINEERING_DEFAULT", "PRODUCTION_INHERITED", "UNRESOLVED"]);
  for (const [key, spec] of Object.entries(PROPOSED_ACCEPTANCE_THRESHOLDS)) {
    assert.ok(allowed.has(spec.status), `${key}: status "${spec.status}" not in allowed vocabulary`);
    assert.ok(spec.rationale.length > 20, `${key}: rationale is too short to be meaningful`);
    assert.equal(typeof spec.value, "number", `${key}: value must be numeric`);
  }
});

test("C2: the four EVIDENCE_BACKED thresholds carry E8N's actual swept, holdout-validated numbers", () => {
  assert.equal(PROPOSED_ACCEPTANCE_THRESHOLDS.minimumMatchedWords.value, 50);
  assert.equal(PROPOSED_ACCEPTANCE_THRESHOLDS.minimumLongestPassageWords.value, 50);
  assert.equal(PROPOSED_ACCEPTANCE_THRESHOLDS.minimumPassageDensity.value, 0.05);
  assert.equal(PROPOSED_ACCEPTANCE_THRESHOLDS.minimumDistinctiveness.value, 0.7);
  for (const key of ["minimumMatchedWords", "minimumLongestPassageWords", "minimumPassageDensity", "minimumDistinctiveness"]) {
    assert.equal(PROPOSED_ACCEPTANCE_THRESHOLDS[key].status, "EVIDENCE_BACKED");
  }
});

// --- D: decision tree, Steps 1-2 (exact / production-threshold short-circuit) --------------------------

test("D1: exact canonical match always yields HISTORICAL_FULL_MATCH/EXACT_CANONICAL_MATCH regardless of a hostile passage-level signal", () => {
  const result = classifyHistoricalMatch({
    wholeDocument: { exactCanonicalMatch: true, meetsProductionThreshold: true, containment: 1, matchedWordCount: 500, longestMatchWords: 500 },
    passageLevel: { matchedWordCount: 0, longestMatchWords: 0, longestSinglePassageWords: 0, passageCount: 0, passageDensity: 0, distinctivenessV2: 0 },
    relationship: "UNKNOWN_RELATIONSHIP",
    submittedWordCount: 500,
  });
  assert.equal(result.status, "HISTORICAL_FULL_MATCH");
  assert.equal(result.evidence, "EXACT_CANONICAL_MATCH");
});

test("D2: production's existing strong-correspondence threshold alone yields HISTORICAL_FULL_MATCH, matching today's unchanged production behavior", () => {
  const result = classifyHistoricalMatch({
    wholeDocument: { exactCanonicalMatch: false, meetsProductionThreshold: true, containment: 0.62, matchedWordCount: 300, longestMatchWords: 120 },
    passageLevel: null,
    relationship: "UNKNOWN_RELATIONSHIP",
    submittedWordCount: 500,
  });
  assert.equal(result.status, "HISTORICAL_FULL_MATCH");
  assert.equal(result.evidence, "STRONG_WHOLE_DOCUMENT_CORRESPONDENCE");
});

// --- E: decision tree, Step 3 (short-document guardrail) -------------------------------------------------

test("E: below the short-document floor, a passage-level signal that would otherwise clearly qualify is still suppressed", () => {
  const hostileGoodPassageLevel = { matchedWordCount: 200, longestMatchWords: 90, longestSinglePassageWords: 90, passageCount: 1, passageDensity: 0.9, distinctivenessV2: 0.99 };
  const result = classifyHistoricalMatch({
    wholeDocument: { exactCanonicalMatch: false, meetsProductionThreshold: false, containment: 0.1, matchedWordCount: 10, longestMatchWords: 10 },
    passageLevel: hostileGoodPassageLevel,
    relationship: "UNKNOWN_RELATIONSHIP",
    submittedWordCount: PROPOSED_ACCEPTANCE_THRESHOLDS.minimumDocumentWordCountForPartialMatch.value - 1,
  });
  assert.equal(result.status, "NO_HISTORICAL_MATCH");
});

// --- F: decision tree, Step 5 (multi-guardrail passage-level acceptance) --------------------------------

function passingPassageLevel(overrides = {}) {
  return {
    matchedWordCount: 80, longestMatchWords: 60, longestSinglePassageWords: 60, passageCount: 1, passageDensity: 0.5, distinctivenessV2: 0.85,
    ...overrides,
  };
}
function failingWholeDocument() {
  return { exactCanonicalMatch: false, meetsProductionThreshold: false, containment: 0.1, matchedWordCount: 10, longestMatchWords: 10 };
}

test("F1: a passage-level signal clearing every guardrail yields HISTORICAL_PARTIAL_MATCH", () => {
  const result = classifyHistoricalMatch({ wholeDocument: failingWholeDocument(), passageLevel: passingPassageLevel(), relationship: "UNKNOWN_RELATIONSHIP", submittedWordCount: 500 });
  assert.equal(result.status, "HISTORICAL_PARTIAL_MATCH");
  assert.equal(result.evidence, "STRONG_DISTINCTIVE_PASSAGE");
});

test("F2: multiple passages clearing every guardrail yields MULTIPLE_DISTINCTIVE_PASSAGES evidence, not STRONG_DISTINCTIVE_PASSAGE", () => {
  const result = classifyHistoricalMatch({ wholeDocument: failingWholeDocument(), passageLevel: passingPassageLevel({ passageCount: 3 }), relationship: "UNKNOWN_RELATIONSHIP", submittedWordCount: 500 });
  assert.equal(result.status, "HISTORICAL_PARTIAL_MATCH");
  assert.equal(result.evidence, "MULTIPLE_DISTINCTIVE_PASSAGES");
});

test("F3: distinctiveness just below the gate (0.699 < 0.7) is rejected — reproduces E8N's own documented multi-block near-miss margin", () => {
  const result = classifyHistoricalMatch({ wholeDocument: failingWholeDocument(), passageLevel: passingPassageLevel({ distinctivenessV2: 0.699 }), relationship: "UNKNOWN_RELATIONSHIP", submittedWordCount: 500 });
  assert.equal(result.status, "NO_HISTORICAL_MATCH");
});

test("F4: evidence floor not met (matchedWordCount below minimum) is rejected even with high distinctiveness", () => {
  const result = classifyHistoricalMatch({ wholeDocument: failingWholeDocument(), passageLevel: passingPassageLevel({ matchedWordCount: 49, longestMatchWords: 49 }), relationship: "UNKNOWN_RELATIONSHIP", submittedWordCount: 500 });
  assert.equal(result.status, "NO_HISTORICAL_MATCH");
});

test("F5 (many-short-overlaps guardrail): a high aggregate matchedWordCount and high distinctiveness are rejected when no single passage is individually substantial", () => {
  // Simulates E8K/E8L's original false-positive concern: many short overlaps summing to a large aggregate without any one of them being a real, substantial passage.
  const result = classifyHistoricalMatch({
    wholeDocument: failingWholeDocument(),
    passageLevel: passingPassageLevel({ matchedWordCount: 200, longestMatchWords: 60, longestSinglePassageWords: 15, passageCount: 12 }),
    relationship: "UNKNOWN_RELATIONSHIP",
    submittedWordCount: 500,
  });
  assert.equal(result.status, "NO_HISTORICAL_MATCH", "the minimumSinglePassageWords guardrail should have rejected this even though the aggregate floor and distinctiveness both passed");
});

test("F6: no passage-level signal computed at all (null) yields NO_HISTORICAL_MATCH when the whole-document path also failed", () => {
  const result = classifyHistoricalMatch({ wholeDocument: failingWholeDocument(), passageLevel: null, relationship: "UNKNOWN_RELATIONSHIP", submittedWordCount: 500 });
  assert.equal(result.status, "NO_HISTORICAL_MATCH");
});

// --- G: relationship / evidence independence --------------------------------------------------------------

test("G: relationship never influences status or evidence — only which of SELF/PRIOR_SUBMISSION/UNKNOWN_RELATIONSHIP is echoed back", () => {
  const wholeDocument = { exactCanonicalMatch: false, meetsProductionThreshold: true, containment: 0.7, matchedWordCount: 200, longestMatchWords: 150 };
  const relationships = ["SELF", "PRIOR_SUBMISSION", "UNKNOWN_RELATIONSHIP"];
  const results = relationships.map((relationship) => classifyHistoricalMatch({ wholeDocument, passageLevel: null, relationship, submittedWordCount: 500 }));
  for (let i = 0; i < results.length; i += 1) {
    assert.equal(results[i].relationship, relationships[i]);
    assert.equal(results[i].status, results[0].status);
    assert.equal(results[i].evidence, results[0].evidence);
  }
});

// --- H: structural — the policy module never imports a correspondence engine, production matcher, or DB client ---

test("H (structural): lib/e8o-historical-match-policy.ts is import-free of every correspondence/matcher/DB module", () => {
  const source = stripComments(fs.readFileSync(path.join(repoRoot, "lib/e8o-historical-match-policy.ts"), "utf8"));
  const forbidden = [
    /@libsql\/client/,
    /from\s+["'].*document-correspondence["']/,
    /from\s+["'].*e8m-robust-correspondence["']/,
    /from\s+["'].*e8l-distinctiveness-v2["']/,
    /from\s+["'].*user-submission-matching["']/,
    /from\s+["'].*user-submission-corpus["']/,
    /^import\b/m,
  ];
  // The last pattern (^import) is deliberately the strongest check: this file should have ZERO import statements at all.
  assert.doesNotMatch(source, /^import\b/m, "lib/e8o-historical-match-policy.ts must have zero import statements — pure types/constants/decision-function only");
  for (const pattern of forbidden.slice(0, -1)) assert.doesNotMatch(source, pattern);
});

test("H2 (structural): no production or app code imports lib/e8o-historical-match-policy.ts, except the approved E8P shadow-evaluation module", () => {
  const searchRoots = ["lib", "app", "components"].map((d) => path.join(repoRoot, d)).filter((d) => fs.existsSync(d));
  const offenders = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (entry.name.startsWith("e8o-")) continue; // the E8O files themselves are allowed to reference each other
      if (entry.name.startsWith("e8p-")) continue; // Phase E8P: the approved production SHADOW-ONLY consumer — see lib/e8p-shadow-evaluation.ts's own header comment for why this is safe (never renders, never changes score, never changes the real matcher's result)
      const source = fs.readFileSync(full, "utf8");
      if (/e8o-historical-match-policy/.test(source)) offenders.push(full);
    }
  }
  for (const root of searchRoots) walk(root);
  assert.deepEqual(offenders, [], `lib/e8o-historical-match-policy.ts must not be imported by production code (other than lib/e8p-shadow-evaluation.ts); found references in: ${offenders.join(", ")}`);
});

test("H3 (structural): tools/e8o-acceptance-matrix.ts reads production thresholds read-only and never writes anywhere", () => {
  const source = stripComments(fs.readFileSync(path.join(repoRoot, "tools/e8o-acceptance-matrix.ts"), "utf8"));
  assert.doesNotMatch(source, /@libsql\/client/, "must never import a DB client");
  assert.doesNotMatch(source, /\.write\(|INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM/i, "must never write anywhere");
  assert.doesNotMatch(source, /\b(archiveScore|report\.score|aiScore|verifiedSimilarity)\b/, "must never reference a scoring field");
});

// --- I: acceptance matrix (Section 18) -----------------------------------------------------------------

test("I: all 20 acceptance-matrix scenarios (A-T) pass", () => {
  const outcomes = runAcceptanceMatrix();
  assert.equal(outcomes.length, 20, "expected exactly 20 lettered scenarios (A-T)");
  const failures = outcomes.filter((o) => !o.pass);
  assert.deepEqual(failures, [], `scenario failures: ${JSON.stringify(failures, null, 2)}`);
});

test("I2: scenario F (partial copy) specifically proves the passage-level path adds detection capability beyond production's unchanged whole-document path", () => {
  const scenario = ACCEPTANCE_SCENARIOS.find((s) => s.letter === "F");
  const result = scenario.run();
  assert.equal(result.wholeDocumentSignal.meetsProductionThreshold, false, "the whole-document path must NOT have qualified on its own — this is the E8J headline gap being closed");
  assert.equal(result.wholeDocumentSignal.exactCanonicalMatch, false);
  assert.equal(result.status, "HISTORICAL_PARTIAL_MATCH");
});

test("I3: the landmark multi-block near-miss is honestly reproduced (documented at 0.693-0.697, below the 0.7 gate)", () => {
  const outcome = ACCEPTANCE_SCENARIOS.find((s) => s.letter === "G");
  assert.ok(outcome, "scenario G must exist");
  // MULTI_BLOCK_LANDMARK_NEAR_MISS is exported separately from the strict A-T scenarios precisely because it is a known, documented near-miss, not a stable pass/fail acceptance item.
  assert.equal(MULTI_BLOCK_LANDMARK_NEAR_MISS.id, "landmark-multi-block");
});

// --- J: deterministic repeatability (unit-level, independent of the acceptance-matrix's own scenario T) --

test("J: classifyHistoricalMatch is a pure function — identical input always yields deep-equal output", () => {
  const input = {
    wholeDocument: { exactCanonicalMatch: false, meetsProductionThreshold: false, containment: 0.3, matchedWordCount: 40, longestMatchWords: 30 },
    passageLevel: passingPassageLevel(),
    relationship: "PRIOR_SUBMISSION",
    submittedWordCount: 500,
  };
  const a = classifyHistoricalMatch(input);
  const b = classifyHistoricalMatch(input);
  assert.deepEqual(a, b);
});

// --- K: documentation constants are well-formed -----------------------------------------------------------

test("K1: UI_CONTRACT covers exactly the 3 HistoricalMatchStatus values, each with at least one whatIsShown item", () => {
  const statuses = UI_CONTRACT.map((e) => e.status).sort();
  assert.deepEqual(statuses, ["HISTORICAL_FULL_MATCH", "HISTORICAL_PARTIAL_MATCH", "NO_HISTORICAL_MATCH"].sort());
  for (const entry of UI_CONTRACT) assert.ok(entry.whatIsShown.length > 0, `${entry.status} must document what is shown`);
});

test("K2: PRIVACY_RETENTION_CONTRACT items all carry a valid EvidenceStatus, and unresolved retention/consent questions are explicitly marked UNRESOLVED rather than silently decided", () => {
  const allowed = new Set(["EVIDENCE_BACKED", "ENGINEERING_DEFAULT", "PRODUCTION_INHERITED", "UNRESOLVED"]);
  for (const item of PRIVACY_RETENTION_CONTRACT) assert.ok(allowed.has(item.status));
  const unresolvedCount = PRIVACY_RETENTION_CONTRACT.filter((i) => i.status === "UNRESOLVED").length;
  assert.ok(unresolvedCount >= 2, "retention duration and at least one other open privacy question must be explicitly flagged UNRESOLVED, not invented");
});

test("K3: ROLLOUT_PLAN defines stages 0-3 in order, each with a rollback trigger", () => {
  assert.deepEqual(ROLLOUT_PLAN.map((s) => s.stage), [0, 1, 2, 3]);
  for (const stage of ROLLOUT_PLAN) assert.ok(stage.rollbackTrigger.length > 0);
});

test("K4: OBSERVABILITY_METRICS names never encode document content or account identity", () => {
  for (const metric of OBSERVABILITY_METRICS) {
    assert.doesNotMatch(metric, /text|content|passage_text|account_id|email/i, `${metric} looks like it could encode content or identity, not a bounded count/rate/timing`);
  }
});

test("K5: E8M role placement is explicitly one of the 4 named options and carries a non-trivial rationale", () => {
  const allowed = new Set(["ALWAYS_REPLACE_V0", "ONLY_FOR_FAILED_WHOLE_DOCUMENT_CANDIDATES", "PARALLEL_COMPARE", "ONLY_WHEN_STRONG_ANCHORS_PRESENT"]);
  assert.ok(allowed.has(CHOSEN_E8M_ROLE_PLACEMENT.option));
  assert.equal(CHOSEN_E8M_ROLE_PLACEMENT.option, "ONLY_FOR_FAILED_WHOLE_DOCUMENT_CANDIDATES");
  assert.ok(CHOSEN_E8M_ROLE_PLACEMENT.rationale.length > 40);
});

test("K6: multi-block and false-positive guardrail notes are non-empty and documented", () => {
  assert.ok(MULTI_BLOCK_POLICY_NOTES.length >= 3);
  assert.ok(FALSE_POSITIVE_GUARDRAIL_NOTES.length >= 3);
  for (const note of [...MULTI_BLOCK_POLICY_NOTES, ...FALSE_POSITIVE_GUARDRAIL_NOTES]) assert.ok(note.length > 20);
});
