import {
  classifyHistoricalMatch, PROPOSED_ACCEPTANCE_THRESHOLDS,
  type WholeDocumentSignal, type PassageLevelSignal, type HistoricalMatchClassification,
  type RelationshipType, type HistoricalMatchStatus, type EvidenceKind,
} from "../lib/e8o-historical-match-policy";
import { computeDocumentCorrespondence } from "../lib/document-correspondence";
import { USER_SUBMISSION_MATCH_THRESHOLDS } from "../lib/user-submission-matching";
import { evaluateVariant, type EvaluateVariantOptions } from "../lib/e8n-pipeline-evaluator";
import { buildE8NDataset, buildPerturbationBattery, type PerturbationKind } from "../lib/e8n-calibration-dataset";
import { tokens } from "../lib/similarity-core";
import {
  BASE_DOCUMENT, FORMATTING_ONLY_DOCUMENT, LIGHT_EDIT_DOCUMENT, MODERATE_EDIT_DOCUMENT, HEAVY_EDIT_DOCUMENT,
  PARTIAL_COPY_DOCUMENT, SAME_TOPIC_DIFFERENT_WORDING_DOCUMENT,
} from "../lib/e8j-calibration-fixtures";
import {
  HIST_DISTINCTIVE_DOCUMENT, SMALL_PASSAGE_100, SMALL_PASSAGE_250,
} from "../lib/e8k-calibration-fixtures";

/**
 * Phase E8O: acceptance test matrix (this phase's own task description,
 * section 18 — 20 scenarios A-T). Every scenario reuses an existing
 * fixture from E8J/E8K/E8L/E8N (via buildE8NDataset()/buildPerturbationBattery())
 * unchanged — no new synthetic text is generated in this file. Local/synthetic
 * fixtures only; nothing here connects to Turso or production data.
 *
 * Exported separately from main() so tests/e8o-policy-spec.test.mjs can
 * import and assert against the same scenario list this report prints,
 * rather than duplicating scenario definitions.
 */

const dataset = buildE8NDataset();
const battery = buildPerturbationBattery(dataset);

function findBattery(kind: PerturbationKind) {
  const found = battery.find((b) => b.kind === kind);
  if (!found) throw new Error(`E8O acceptance matrix: expected perturbation battery fixture not found: ${kind}`);
  return found;
}

export function computeWholeDocumentSignal(submittedText: string, candidateText: string): WholeDocumentSignal {
  const c = computeDocumentCorrespondence(submittedText, candidateText, USER_SUBMISSION_MATCH_THRESHOLDS.correspondence);
  return {
    exactCanonicalMatch: c.exactCanonicalMatch,
    meetsProductionThreshold: c.strongCorrespondence,
    containment: c.containment,
    matchedWordCount: c.matchedWordCount,
    longestMatchWords: c.longestMatchWords,
  };
}

export function computePassageLevelSignal(submittedText: string, candidateText: string): PassageLevelSignal {
  const options: EvaluateVariantOptions = { freqIndex: dataset.freqIndex, localCorpusContext: [] };
  const result = evaluateVariant("F_E8M_V2", submittedText, candidateText, options);
  const longestSinglePassageWords = result.passages.reduce((max, p) => Math.max(max, p.matchedWordCount), 0);
  return {
    matchedWordCount: result.matchedWordCount,
    longestMatchWords: result.longestMatchWords,
    longestSinglePassageWords,
    passageCount: result.passageCount,
    passageDensity: result.passageDensity,
    distinctivenessV2: result.distinctiveness ?? 0,
  };
}

/**
 * Full pipeline: whole-document signal always computed; passage-level
 * signal computed eagerly here for reporting transparency (so every
 * scenario's complete evidence picture is visible in the printed matrix).
 * Section 8's chosen Option B ("only run E8M+V2 when whole-document
 * acceptance already failed") is an ORCHESTRATION recommendation for a
 * real implementation to save runtime — classifyHistoricalMatch itself
 * ignores passageLevel whenever wholeDocument already qualifies (Steps
 * 1-2 of the decision tree), so eager computation here is harmless and
 * strictly more informative for this test tool.
 */
export function evaluate(submittedText: string, candidateText: string, relationship: RelationshipType): HistoricalMatchClassification {
  const wholeDocument = computeWholeDocumentSignal(submittedText, candidateText);
  const submittedWordCount = tokens(submittedText).length;
  const passageLevel = submittedWordCount >= PROPOSED_ACCEPTANCE_THRESHOLDS.minimumDocumentWordCountForPartialMatch.value
    ? computePassageLevelSignal(submittedText, candidateText)
    : null;
  return classifyHistoricalMatch({ wholeDocument, passageLevel, relationship, submittedWordCount });
}

type ExpectResult = { pass: boolean; reason: string };
export type Scenario = { letter: string; id: string; description: string; run: () => unknown; expect: (result: unknown) => ExpectResult };

function expectStatus(expected: HistoricalMatchStatus) {
  return (result: unknown): ExpectResult => {
    const r = result as HistoricalMatchClassification;
    return { pass: r.status === expected, reason: `expected status=${expected}, got status=${r.status} evidence=${r.evidence}` };
  };
}
function expectStatusAndEvidence(expectedStatus: HistoricalMatchStatus, expectedEvidence: EvidenceKind[]) {
  return (result: unknown): ExpectResult => {
    const r = result as HistoricalMatchClassification;
    const pass = r.status === expectedStatus && expectedEvidence.includes(r.evidence);
    return { pass, reason: `expected status=${expectedStatus} evidence in [${expectedEvidence.join("|")}], got status=${r.status} evidence=${r.evidence}` };
  };
}
function expectDetected(expected: boolean) {
  return (result: unknown): ExpectResult => {
    const r = result as HistoricalMatchClassification;
    const detected = r.status !== "NO_HISTORICAL_MATCH";
    return { pass: detected === expected, reason: `expected detected=${expected}, got detected=${detected} status=${r.status}` };
  };
}

const multiBlockFresh = dataset.fixtures.find((f) => f.underlyingLabel === "MULTI_BLOCK_COPY" && f.split === "train");
if (!multiBlockFresh) throw new Error("E8O acceptance matrix: expected a train-split MULTI_BLOCK_COPY fixture from E8N's dataset");
export const MULTI_BLOCK_LANDMARK_NEAR_MISS = dataset.fixtures.find((f) => f.id === "landmark-multi-block")!;

export const ACCEPTANCE_SCENARIOS: Scenario[] = [
  {
    letter: "A", id: "exact", description: "Exact copy",
    run: () => evaluate(BASE_DOCUMENT, BASE_DOCUMENT, "UNKNOWN_RELATIONSHIP"),
    expect: expectStatusAndEvidence("HISTORICAL_FULL_MATCH", ["EXACT_CANONICAL_MATCH"]),
  },
  {
    letter: "B", id: "formatting-only", description: "Formatting-only copy (whitespace/BOM differences, same canonical text)",
    run: () => evaluate(FORMATTING_ONLY_DOCUMENT, BASE_DOCUMENT, "UNKNOWN_RELATIONSHIP"),
    expect: expectStatusAndEvidence("HISTORICAL_FULL_MATCH", ["EXACT_CANONICAL_MATCH"]),
  },
  {
    letter: "C", id: "light-edit", description: "Light edit (~5-10% modified)",
    run: () => evaluate(LIGHT_EDIT_DOCUMENT, BASE_DOCUMENT, "UNKNOWN_RELATIONSHIP"),
    expect: expectStatusAndEvidence("HISTORICAL_FULL_MATCH", ["STRONG_WHOLE_DOCUMENT_CORRESPONDENCE"]),
  },
  {
    letter: "D", id: "moderate-edit", description: "Moderate edit (~20-30% modified)",
    run: () => evaluate(MODERATE_EDIT_DOCUMENT, BASE_DOCUMENT, "UNKNOWN_RELATIONSHIP"),
    expect: expectStatusAndEvidence("HISTORICAL_FULL_MATCH", ["STRONG_WHOLE_DOCUMENT_CORRESPONDENCE"]),
  },
  {
    letter: "E", id: "heavy-edit", description: "Heavy edit (~40-60% modified)",
    run: () => evaluate(HEAVY_EDIT_DOCUMENT, BASE_DOCUMENT, "UNKNOWN_RELATIONSHIP"),
    expect: expectDetected(true),
  },
  {
    letter: "F", id: "partial-copy", description: "Partial copy (~35.8% / 435 words) — E8J's headline gap: V0 alone (today's production) does not qualify; proves the passage-level path adds real detection capability",
    run: () => evaluate(PARTIAL_COPY_DOCUMENT, BASE_DOCUMENT, "UNKNOWN_RELATIONSHIP"),
    expect: expectStatusAndEvidence("HISTORICAL_PARTIAL_MATCH", ["STRONG_DISTINCTIVE_PASSAGE", "MULTIPLE_DISTINCTIVE_PASSAGES"]),
  },
  {
    letter: "G", id: "multi-block-copy", description: "Multi-block copy — two independently-generated distinctive blocks copied into an otherwise-unrelated document (E8N's multi-block-query fixture)",
    run: () => evaluate(multiBlockFresh!.text, multiBlockFresh!.candidateText, "UNKNOWN_RELATIONSHIP"),
    expect: expectDetected(true),
  },
  {
    letter: "H", id: "generic-boilerplate", description: "Generic boilerplate embedded in an otherwise-unrelated document, real (literal, non-adversarial) overlap below whole-document threshold — must be rejected on passage-level distinctiveness, not on lack of overlap",
    run: () => { const f = dataset.appendedFixtures.find((x) => x.id === "appended-many-short-blocks")!; return evaluate(f.text, f.candidateText, "UNKNOWN_RELATIONSHIP"); },
    expect: expectStatus("NO_HISTORICAL_MATCH"),
  },
  {
    letter: "I", id: "same-topic", description: "Same topic, different wording (paraphrase-level rewrite, no literal reuse)",
    run: () => evaluate(SAME_TOPIC_DIFFERENT_WORDING_DOCUMENT, BASE_DOCUMENT, "UNKNOWN_RELATIONSHIP"),
    expect: expectStatus("NO_HISTORICAL_MATCH"),
  },
  {
    letter: "J", id: "sentence-split-merge", description: "Sentence split perturbation of an otherwise-substantial distinctive-copy passage (E8N perturbation battery)",
    run: () => { const f = findBattery("SENTENCE_SPLIT"); return evaluate(f.text, f.candidateText, "UNKNOWN_RELATIONSHIP"); },
    expect: expectDetected(true),
  },
  {
    letter: "K", id: "insertions-deletions", description: "5-word insertion perturbation of an otherwise-substantial distinctive-copy passage (E8N perturbation battery)",
    run: () => { const f = findBattery("INSERT_5"); return evaluate(f.text, f.candidateText, "UNKNOWN_RELATIONSHIP"); },
    expect: expectDetected(true),
  },
  {
    letter: "L", id: "entity-change", description: "Entity substitution perturbation (organization name changed) of an otherwise-substantial distinctive-copy passage",
    run: () => { const f = findBattery("ENTITY_CHANGE"); return evaluate(f.text, f.candidateText, "UNKNOWN_RELATIONSHIP"); },
    expect: expectDetected(true),
  },
  {
    letter: "M", id: "number-change", description: "Numeric value change perturbation of an otherwise-substantial distinctive-copy passage",
    run: () => { const f = findBattery("NUMBER_CHANGE"); return evaluate(f.text, f.candidateText, "UNKNOWN_RELATIONSHIP"); },
    expect: expectDetected(true),
  },
  {
    letter: "N", id: "cross-account-privacy", description: "Classification output never contains any account-identity-shaped data (structural)",
    run: () => evaluate(LIGHT_EDIT_DOCUMENT, BASE_DOCUMENT, "PRIOR_SUBMISSION"),
    expect: (result) => {
      const json = JSON.stringify(result);
      const forbidden = ["accountId", "account_id", "email", "userId", "user_id", "@"];
      const leaked = forbidden.filter((k) => json.includes(k));
      return { pass: leaked.length === 0, reason: leaked.length ? `leaked identity-shaped tokens: ${leaked.join(",")}` : "no identity-shaped tokens present in output" };
    },
  },
  {
    letter: "O", id: "self-relationship", description: "SELF relationship correctly carried through, independent of which evidence path produced the match",
    run: () => evaluate(LIGHT_EDIT_DOCUMENT, BASE_DOCUMENT, "SELF"),
    expect: (result) => {
      const r = result as HistoricalMatchClassification;
      return { pass: r.relationship === "SELF" && r.status === "HISTORICAL_FULL_MATCH", reason: `relationship=${r.relationship} status=${r.status}` };
    },
  },
  {
    letter: "P", id: "prior-submission-relationship", description: "PRIOR_SUBMISSION relationship correctly carried through; evidence classification identical to the SELF case (O) for the same text pair — proves relationship and evidence are independent axes",
    run: () => ({ prior: evaluate(LIGHT_EDIT_DOCUMENT, BASE_DOCUMENT, "PRIOR_SUBMISSION"), self: evaluate(LIGHT_EDIT_DOCUMENT, BASE_DOCUMENT, "SELF") }),
    expect: (result) => {
      const { prior, self } = result as { prior: HistoricalMatchClassification; self: HistoricalMatchClassification };
      const pass = prior.relationship === "PRIOR_SUBMISSION" && prior.status === self.status && prior.evidence === self.evidence;
      return { pass, reason: `prior.relationship=${prior.relationship} prior.status=${prior.status} self.status=${self.status}` };
    },
  },
  {
    letter: "Q", id: "first-upload", description: "First upload / no historical candidate at all",
    run: () => classifyHistoricalMatch({
      wholeDocument: { exactCanonicalMatch: false, meetsProductionThreshold: false, containment: 0, matchedWordCount: 0, longestMatchWords: 0 },
      passageLevel: null, relationship: "UNKNOWN_RELATIONSHIP", submittedWordCount: tokens(BASE_DOCUMENT).length,
    }),
    expect: expectStatus("NO_HISTORICAL_MATCH"),
  },
  {
    letter: "R", id: "anonymous-submitter", description: "Anonymous submitter (accountId=null in production terms) maps to UNKNOWN_RELATIONSHIP regardless of evidence strength",
    run: () => evaluate(PARTIAL_COPY_DOCUMENT, BASE_DOCUMENT, "UNKNOWN_RELATIONSHIP"),
    expect: (result) => {
      const r = result as HistoricalMatchClassification;
      return { pass: r.relationship === "UNKNOWN_RELATIONSHIP", reason: `relationship=${r.relationship}` };
    },
  },
  {
    letter: "S", id: "short-documents", description: "Short-document guardrail: a genuinely-copied but very short excerpt does not qualify for HISTORICAL_PARTIAL_MATCH; a long-enough excerpt of the same source is evaluated normally",
    run: () => {
      const shortExcerpt = tokens(SMALL_PASSAGE_100).slice(0, 60).join(" ");
      return { short: evaluate(shortExcerpt, HIST_DISTINCTIVE_DOCUMENT, "UNKNOWN_RELATIONSHIP"), longer: evaluate(SMALL_PASSAGE_250, HIST_DISTINCTIVE_DOCUMENT, "UNKNOWN_RELATIONSHIP") };
    },
    expect: (result) => {
      const { short, longer } = result as { short: HistoricalMatchClassification; longer: HistoricalMatchClassification };
      const pass = short.status === "NO_HISTORICAL_MATCH" && short.passageLevelSignal === null;
      return { pass, reason: `short(60w).status=${short.status} passageLevelSignal=${short.passageLevelSignal === null ? "null (guardrail applied)" : "computed"}; longer(250w).status=${longer.status} (informational only, not asserted)` };
    },
  },
  {
    letter: "T", id: "deterministic-repeatability", description: "Identical input classified identically on repeated calls",
    run: () => {
      const input = {
        wholeDocument: computeWholeDocumentSignal(PARTIAL_COPY_DOCUMENT, BASE_DOCUMENT),
        passageLevel: computePassageLevelSignal(PARTIAL_COPY_DOCUMENT, BASE_DOCUMENT),
        relationship: "UNKNOWN_RELATIONSHIP" as RelationshipType,
        submittedWordCount: tokens(PARTIAL_COPY_DOCUMENT).length,
      };
      return { a: classifyHistoricalMatch(input), b: classifyHistoricalMatch(input) };
    },
    expect: (result) => {
      const { a, b } = result as { a: HistoricalMatchClassification; b: HistoricalMatchClassification };
      const identical = JSON.stringify(a) === JSON.stringify(b);
      return { pass: identical, reason: identical ? "identical on repeated calls" : "MISMATCH — nondeterministic output" };
    },
  },
];

export type ScenarioOutcome = { letter: string; id: string; description: string; pass: boolean; reason: string };

export function runAcceptanceMatrix(): ScenarioOutcome[] {
  return ACCEPTANCE_SCENARIOS.map((s) => {
    const result = s.run();
    const { pass, reason } = s.expect(result);
    return { letter: s.letter, id: s.id, description: s.description, pass, reason };
  });
}

function main() {
  console.log("=== E8O ACCEPTANCE MATRIX (local/synthetic fixtures only — no Turso, no production data) ===\n");
  const outcomes = runAcceptanceMatrix();
  for (const o of outcomes) {
    console.log(`[${o.pass ? "PASS" : "FAIL"}] ${o.letter}. ${o.description}`);
    console.log(`       ${o.reason}`);
  }
  const passCount = outcomes.filter((o) => o.pass).length;
  console.log(`\n${passCount}/${outcomes.length} scenarios passed.`);

  console.log("\n--- Addendum: known near-miss (not a strict pass/fail item) ---");
  const landmark = evaluate(MULTI_BLOCK_LANDMARK_NEAR_MISS.text, MULTI_BLOCK_LANDMARK_NEAR_MISS.candidateText, "UNKNOWN_RELATIONSHIP");
  console.log(`landmark-multi-block: status=${landmark.status} evidence=${landmark.evidence} distinctivenessV2=${landmark.passageLevelSignal?.distinctivenessV2?.toFixed(3) ?? "n/a"} (E8N documented this case at 0.693-0.697, near the 0.7 gate)`);

  console.log("\n--- GO/NO-GO signal (informational; see final report for the full criteria) ---");
  console.log(passCount === outcomes.length
    ? "All acceptance-matrix scenarios pass on local/synthetic fixtures. This is NOT a production accuracy claim (see Section 19 of the final report)."
    : `${outcomes.length - passCount} scenario(s) failed — see FAIL rows above before considering this specification ready for an implementation phase.`);

  if (outcomes.some((o) => !o.pass)) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith("e8o-acceptance-matrix.ts")) main();
