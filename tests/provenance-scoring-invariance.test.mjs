import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { archiveOverlapScore, archiveScopeCount, archiveMatchedWordCount } from "../lib/report-types.ts";

// Phase E1 must produce ZERO changes to report.score, report.archiveScore,
// archive overlap calculations, similarity worker scoring, Wikipedia
// enrichment, report rendering, or PDF receipt calculations. The strongest
// available proof of "zero changes" is not re-testing what those numbers
// compute to (tests/similarity-core.test.mjs, tests/archive-overlap-claim.test.mjs,
// tests/packed-index.test.mjs, and tests/report-match-classification.test.mjs
// already do that, comprehensively, and continue to pass unmodified) — it's
// proving the new provenance module is not even reachable from the scoring
// path. A test asserting "the numbers are still X" would pass whether or not
// lib/provenance-registry.ts had been silently wired into the pipeline; a
// test asserting "these files never import the provenance module at all"
// cannot.

const repoRoot = path.resolve(".");

const SCORING_PATH_FILES = [
  "app/similarity-worker.ts",
  "app/ai-detector-worker.ts",
  "app/web-check-worker.ts",
  "app/page.tsx",
  "lib/report-types.ts",
  "lib/similarity-core.ts",
  "lib/similarity-enrichment.ts",
  "lib/receipt-pdf.ts",
  "app/api/reports/route.ts",
  "app/api/reports/[id]/route.ts",
  "app/reports/[id]/page.tsx",
  "app/reports/[id]/report-detail-shell.tsx",
  "components/report/similarity-report-papers.tsx",
  "components/report/ai-report.tsx",
];

// Only real `import ... from "..."` / `export ... from "..."` statement
// lines — never comment prose, which can legitimately name these files
// (this test's own header does). Matches this project's existing style of
// import-line-only checks (tests/database-isolation.test.mjs).
function importLines(source) {
  return source
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:import|export)\b.*\bfrom\b/.test(line))
    .join("\n");
}

// Phase E4 added three provenance-adjacent modules (evidence vocabulary,
// evidence repository, verification policy) alongside Phase E1's two; Phase
// E5 adds two more (the decision-outcome/actor vocabulary and the
// verification workflow itself) — all extended here rather than duplicating
// this whole file, so "no scoring file reaches any provenance-adjacent
// module" stays a single, exhaustive check.
const PROVENANCE_MODULE_PATTERN = /provenance-(?:types|registry|evidence(?:-types)?|verification-policy|verification-workflow|verification-decision-types)/;

test("no file on the scoring/report path imports any Phase E1/E4 provenance module", () => {
  const offenders = [];
  for (const relativePath of SCORING_PATH_FILES) {
    const fullPath = path.join(repoRoot, relativePath);
    assert.ok(fs.existsSync(fullPath), `expected ${relativePath} to exist — the file list itself may be stale`);
    const imports = importLines(fs.readFileSync(fullPath, "utf8"));
    if (PROVENANCE_MODULE_PATTERN.test(imports)) offenders.push(relativePath);
  }
  assert.deepEqual(
    offenders,
    [],
    `these scoring/report-path files import a provenance module, which Phase E1/E4 must not wire in: ${offenders.join(", ")}`,
  );
});

test("the provenance/evidence modules do not import anything from the scoring/report path either (the separation holds in both directions)", () => {
  const provenanceFiles = [
    "lib/provenance-types.ts",
    "lib/provenance-registry.ts",
    "lib/provenance-evidence-types.ts",
    "lib/provenance-evidence.ts",
    "lib/provenance-verification-policy.ts",
    "lib/provenance-verification-decision-types.ts",
    "lib/provenance-verification-workflow.ts",
  ];
  const forbiddenImportPattern = /similarity-worker|similarity-core|similarity-enrichment|report-types|receipt-pdf|ai-core|web-check/;
  const offenders = [];
  for (const relativePath of provenanceFiles) {
    const imports = importLines(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
    if (forbiddenImportPattern.test(imports)) offenders.push(relativePath);
  }
  assert.deepEqual(offenders, [], `provenance/evidence module files must not import scoring/report code: ${offenders.join(", ")}`);
});

test("lib/document-family.ts and lib/document-relationship.ts (Phases B/C) remain untouched by Phase E1/E4 — they do not import any provenance module either", () => {
  const relationshipFiles = ["lib/document-family.ts", "lib/document-relationship.ts"];
  const offenders = [];
  for (const relativePath of relationshipFiles) {
    const imports = importLines(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
    if (PROVENANCE_MODULE_PATTERN.test(imports)) offenders.push(relativePath);
  }
  assert.deepEqual(
    offenders,
    [],
    `document-family/document-relationship must stay independent of provenance/evidence state — this phase explicitly must not redesign relationships: ${offenders.join(", ")}`,
  );
});

// --- Phase E4-specific guarantees --------------------------------------------

test("lib/provenance-verification-policy.ts is a pure module: it never imports @libsql/client and never calls the database directly", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/provenance-verification-policy.ts"), "utf8");
  const imports = importLines(source);
  assert.doesNotMatch(imports, /@libsql\/client/, "the verification-policy evaluator must take already-fetched evidence records, never a database client");
  assert.doesNotMatch(source, /\bclient\.(execute|batch)\b/, "the verification-policy evaluator must perform no database calls");
});

// Strips /** */ and // comments before searching code — this file's own
// header comment documents a prior bug where a structural check like this
// one matched a test file's *prose* (which legitimately names the function
// it asserts the absence of) rather than a real call; the fix there was
// restricting the search to import lines. That trick doesn't apply here
// (this check must scan the whole function body, not just imports), so the
// fix here is stripping comments instead, before searching for real call
// syntax (`transitionProvenanceState(`, not just the bare word, which this
// module's own doc comments legitimately mention).
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("lib/provenance-verification-policy.ts never calls transitionProvenanceState — evaluating eligibility must not itself change a source's provenance_state (this phase's section 11)", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/provenance-verification-policy.ts"), "utf8");
  const imports = importLines(source);
  assert.doesNotMatch(imports, /provenance-registry/, "the evaluator must not import the registry's write path at all");
  assert.doesNotMatch(stripComments(source), /transitionProvenanceState\s*\(/, "the evaluator must never invoke a state transition itself");
});

test("SimilarityReport gains no evidence-level or verification-eligibility field in Phase E4 either", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/report-types.ts"), "utf8");
  const typeBlock = source.slice(source.indexOf("export type SimilarityReport"), source.indexOf("export type HighlightRange"));
  assert.doesNotMatch(typeBlock, /evidenceLevel|EvidenceLevel|VerificationEligibility|provenanceEvidence/i, "Phase E4 must not add an evidence/verification field to SimilarityReport in this phase");
});

// --- Phase E5-specific guarantees --------------------------------------------

test("SimilarityReport gains no verification-decision or verified-source field in Phase E5 either", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/report-types.ts"), "utf8");
  const typeBlock = source.slice(source.indexOf("export type SimilarityReport"), source.indexOf("export type HighlightRange"));
  assert.doesNotMatch(typeBlock, /verificationDecision|VerificationDecision|verifiedSource|VerifiedSource/i, "Phase E5 must not add a verification-decision field to SimilarityReport in this phase");
});

test("lib/provenance-verification-workflow.ts changes provenance state only through lib/provenance-registry.ts's transitionProvenanceState — it contains no direct UPDATE to provenance_sources", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/provenance-verification-workflow.ts"), "utf8");
  assert.doesNotMatch(source, /UPDATE\s+provenance_sources/i, "the workflow must never update provenance_sources directly — only transitionProvenanceState may");
});

// --- Phase E6A/E6B-specific guarantees -----------------------------------------

const DISCOVERY_MODULE_PATTERN = /discovery-(?:types|signals|query-generation|normalization|providers|candidates|repository|orchestrator|provenance-bridge|crossref-provider)|source-class/;

test("no file on the scoring/report path imports any Phase E6A discovery module", () => {
  const offenders = [];
  for (const relativePath of SCORING_PATH_FILES) {
    const imports = importLines(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
    if (DISCOVERY_MODULE_PATTERN.test(imports)) offenders.push(relativePath);
  }
  assert.deepEqual(offenders, [], `these scoring/report-path files import a discovery module, which Phase E6A must not wire in: ${offenders.join(", ")}`);
});

test("SimilarityReport gains no discovery-related field in Phase E6A either", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/report-types.ts"), "utf8");
  const typeBlock = source.slice(source.indexOf("export type SimilarityReport"), source.indexOf("export type HighlightRange"));
  assert.doesNotMatch(typeBlock, /discoveryCandidate|DiscoveryCandidate|discoverySignal|DiscoverySignal/i, "Phase E6A must not add a discovery field to SimilarityReport in this phase");
});

test("lib/discovery-orchestrator.ts is not imported by any live route or the document-identity/family runtime", () => {
  const liveFiles = [...SCORING_PATH_FILES, "lib/document-family.ts", "lib/document-identity.ts", "lib/document-relationship.ts"];
  const offenders = [];
  for (const relativePath of liveFiles) {
    const imports = importLines(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
    if (/discovery-orchestrator/.test(imports)) offenders.push(relativePath);
  }
  assert.deepEqual(offenders, [], `the discovery orchestrator must not be reachable from any live path yet: ${offenders.join(", ")}`);
});

test("no file on the scoring/report path imports lib/discovery-crossref-provider.ts, and the document-identity/family runtime does not either (Phase E6B)", () => {
  const liveFiles = [...SCORING_PATH_FILES, "lib/document-family.ts", "lib/document-identity.ts", "lib/document-relationship.ts"];
  const offenders = [];
  for (const relativePath of liveFiles) {
    const imports = importLines(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
    if (/discovery-crossref-provider/.test(imports)) offenders.push(relativePath);
  }
  assert.deepEqual(offenders, [], `the real Crossref provider must not be reachable from any live path yet: ${offenders.join(", ")}`);
});

// --- Phase E6C-specific guarantees --------------------------------------------

const RETRIEVAL_MODULE_PATTERN = /retrieval-(?:safety|types|repository|correspondence-bridge)|http-content-retriever|html-text-extraction|document-correspondence/;

test("no file on the scoring/report path imports any Phase E6C retrieval/correspondence module", () => {
  const offenders = [];
  for (const relativePath of SCORING_PATH_FILES) {
    const imports = importLines(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
    if (RETRIEVAL_MODULE_PATTERN.test(imports)) offenders.push(relativePath);
  }
  assert.deepEqual(offenders, [], `these scoring/report-path files import a Phase E6C module, which must not be wired in: ${offenders.join(", ")}`);
});

test("the document-identity/family/relationship runtime does not import any Phase E6C retrieval/correspondence module either", () => {
  const liveFiles = ["lib/document-family.ts", "lib/document-identity.ts", "lib/document-relationship.ts"];
  const offenders = [];
  for (const relativePath of liveFiles) {
    const imports = importLines(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
    if (RETRIEVAL_MODULE_PATTERN.test(imports)) offenders.push(relativePath);
  }
  assert.deepEqual(offenders, [], `document-identity/family/relationship must stay independent of retrieval/correspondence: ${offenders.join(", ")}`);
});

test("SimilarityReport gains no retrieval- or correspondence-related field in Phase E6C either", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/report-types.ts"), "utf8");
  const typeBlock = source.slice(source.indexOf("export type SimilarityReport"), source.indexOf("export type HighlightRange"));
  assert.doesNotMatch(typeBlock, /retrievedSource|RetrievedSource|documentCorrespondence|DocumentCorrespondence/i, "Phase E6C must not add a retrieval/correspondence field to SimilarityReport in this phase");
});

test("lib/document-correspondence.ts is a pure module: it never imports @libsql/client and never calls the database directly", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/document-correspondence.ts"), "utf8");
  const imports = importLines(source);
  assert.doesNotMatch(imports, /@libsql\/client/, "the correspondence engine must take already-retrieved text, never a database client");
  assert.doesNotMatch(source, /\bclient\.(execute|batch)\b/, "the correspondence engine must perform no database calls");
});

test("lib/retrieval-correspondence-bridge.ts changes provenance state only through lib/provenance-registry.ts's transitionProvenanceState — no direct UPDATE to provenance_sources", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/retrieval-correspondence-bridge.ts"), "utf8");
  assert.doesNotMatch(source, /UPDATE\s+provenance_sources/i, "the bridge must never update provenance_sources directly — only transitionProvenanceState may");
});

// --- Phase E6D-specific guarantees --------------------------------------------

const WORKFLOW_MODULE_PATTERN = /source-discovery-(?:workflow|workflow-types|registries)/;

test("no file on the scoring/report path imports any Phase E6D workflow module", () => {
  const offenders = [];
  for (const relativePath of SCORING_PATH_FILES) {
    const imports = importLines(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
    if (WORKFLOW_MODULE_PATTERN.test(imports)) offenders.push(relativePath);
  }
  assert.deepEqual(offenders, [], `these scoring/report-path files import a Phase E6D workflow module: ${offenders.join(", ")}`);
});

test("the document-identity/family/relationship runtime does not import lib/source-discovery-workflow.ts, and lib/source-discovery-workflow.ts does not import lib/document-family.ts", () => {
  const liveFiles = ["lib/document-family.ts", "lib/document-identity.ts", "lib/document-relationship.ts"];
  const offenders = [];
  for (const relativePath of liveFiles) {
    const imports = importLines(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
    if (WORKFLOW_MODULE_PATTERN.test(imports)) offenders.push(relativePath);
  }
  assert.deepEqual(offenders, [], `document-identity/family/relationship must stay independent of the E6D workflow: ${offenders.join(", ")}`);

  const workflowImports = importLines(fs.readFileSync(path.join(repoRoot, "lib/source-discovery-workflow.ts"), "utf8"));
  assert.doesNotMatch(workflowImports, /document-family/, "the workflow must never import lib/document-family.ts (no resolveFamilyForIdentity calls)");
});

test("SimilarityReport gains no workflow-related field in Phase E6D either", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/report-types.ts"), "utf8");
  const typeBlock = source.slice(source.indexOf("export type SimilarityReport"), source.indexOf("export type HighlightRange"));
  assert.doesNotMatch(typeBlock, /workflowId|WorkflowResult|candidateResults/i, "Phase E6D must not add a workflow field to SimilarityReport in this phase");
});

test("lib/source-discovery-workflow.ts never imports or calls lib/provenance-verification-workflow.ts's approveVerification, and never requests VERIFIED_SOURCE directly", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/source-discovery-workflow.ts"), "utf8");
  const imports = importLines(source);
  assert.doesNotMatch(imports, /provenance-verification-workflow/, "the workflow must never import the E5 verification workflow");
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(stripComments(source), /approveVerification/, "the workflow must never call approveVerification");
  assert.doesNotMatch(stripComments(source), /toState:\s*"VERIFIED_SOURCE"/, "the workflow must never request VERIFIED_SOURCE directly");
});

test("lib/source-discovery-workflow.ts is not imported by any live route", () => {
  const offenders = [];
  for (const relativePath of SCORING_PATH_FILES) {
    const imports = importLines(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
    if (/source-discovery-workflow/.test(imports)) offenders.push(relativePath);
  }
  assert.deepEqual(offenders, [], `the E6D workflow must not be reachable from any live path yet: ${offenders.join(", ")}`);
});

test("archiveOverlapScore/archiveScopeCount/archiveMatchedWordCount (the actual verified-similarity/archive numbers) still compute exactly as before", () => {
  // A direct, minimal sanity check alongside the structural proof above —
  // not a replacement for tests/archive-overlap-claim.test.mjs or
  // tests/similarity-core.test.mjs, which cover this exhaustively.
  const report = {
    score: 12,
    archiveScore: 9,
    databaseSize: 230,
    corpusVersion: "archive-v4-230-4553fba3a7",
    matchedWordCount: 40,
    wikipediaMatchedWordCount: 5,
  };
  assert.equal(archiveOverlapScore(report), 9, "archiveOverlapScore must still prefer archiveScore over score, unchanged");
  assert.equal(archiveScopeCount(report), 230, "archiveScopeCount must still derive from corpusVersion/databaseSize, unchanged");
  assert.equal(archiveMatchedWordCount(report), 35, "archiveMatchedWordCount must still subtract wikipediaMatchedWordCount from matchedWordCount, unchanged");
});

test("SimilarityReport.matchClassification (Phase D) remains the only provenance-adjacent field on the report shape — Phase E1 adds no new field to it", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/report-types.ts"), "utf8");
  const typeBlock = source.slice(source.indexOf("export type SimilarityReport"), source.indexOf("export type HighlightRange"));
  assert.match(typeBlock, /matchClassification\?: ReportMatchClassification;/, "Phase D's field must still be present");
  assert.doesNotMatch(typeBlock, /provenanceState|ProvenanceState/i, "Phase E1 must not add a provenance field to SimilarityReport in this phase");
});
