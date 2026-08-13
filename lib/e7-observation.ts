/**
 * Phase E7 (calibration/observation pilot against the 230-document archive,
 * not part of the E1-E6D provenance/discovery module family): the
 * observation-mode wrapper around lib/source-discovery-workflow.ts (E6D).
 *
 * This file adds no discovery/retrieval/correspondence algorithm of its
 * own — it only (a) mints an experiment/run id, (b) calls
 * runSourceDiscoveryWorkflow exactly as E6D already defines it, against a
 * caller-supplied, already-isolated database client, and (c) maps E6D's
 * result onto the richer, E7-specific false-positive/calibration taxonomy
 * this phase's task description asks for (NO_CANDIDATE,
 * DISCOVERY_FALSE_POSITIVE, INACCESSIBLE_SOURCE, UNRELATED_RETRIEVED_CONTENT,
 * COMMON_LANGUAGE_ONLY, WEAK_CORRESPONDENCE, STRONG_CORRESPONDENCE,
 * LIKELY_RELEVANT_CANDIDATE, VERIFICATION_ELIGIBLE).
 *
 * Absolute boundary, enforced structurally by
 * tests/e7-observation.test.mjs (grepping this file's own source, the same
 * "structural test" convention every prior phase's tests already use): this
 * file does not import lib/provenance-verification-workflow.ts and cannot
 * call approveVerification / rejectVerification / recordDispute /
 * recordRetraction / reaffirmVerification. It can only ever report
 * `verificationEligible: true` (E4's pure read-only gate) — never act on it.
 *
 * Some categories in this phase's own taxonomy cannot be derived
 * mechanically (see classifyE7Outcome's own comment) — this module never
 * invents that judgment; it leaves those candidates classified as
 * WEAK_CORRESPONDENCE / LIKELY_RELEVANT_CANDIDATE and preserves the bounded
 * evidence a human reviewer would need to finish the call.
 */
import { randomBytes } from "node:crypto";
import type { Client } from "@libsql/client";
import { runSourceDiscoveryWorkflow } from "./source-discovery-workflow";
import type {
  SourceDiscoveryWorkflowConfig,
  WorkflowCandidateResult,
  SourceDiscoveryWorkflowResult,
} from "./source-discovery-workflow-types";
import type { DiscoveryProviderRegistry, ContentRetrieverRegistry } from "./source-discovery-registries";
import type { ArchiveDocumentMetadata } from "./e7-archive-adapter";

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

/** Format: E7-YYYYMMDD-HHMMSS-<6 random hex chars>. */
export function createE7ExperimentId(now: Date = new Date(), randomSuffix: string = bytesToHex(randomBytes(3))): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `E7-${stamp}-${randomSuffix}`;
}

export const E7_OUTCOME_CLASSES = [
  "NO_CANDIDATE",
  "DUPLICATE_CANDIDATE",
  "DISCOVERED_NOT_RETRIEVED",
  "INACCESSIBLE_SOURCE",
  "UNRELATED_RETRIEVED_CONTENT",
  "WEAK_CORRESPONDENCE",
  "STRONG_CORRESPONDENCE",
  "LIKELY_RELEVANT_CANDIDATE",
  "VERIFICATION_ELIGIBLE",
  "SKIPPED_BY_LIMIT",
  "PROCESSING_ERROR",
] as const;
export type E7OutcomeClass = (typeof E7_OUTCOME_CLASSES)[number];

/**
 * Mechanical mapping only. DISCOVERY_FALSE_POSITIVE and COMMON_LANGUAGE_ONLY
 * (named in this phase's own task description, section 10) are deliberately
 * NOT produced here: distinguishing "Crossref found something real but
 * unrelated" from "the retrieved page happens to share boilerplate phrasing"
 * requires reading the actual bounded passages (section 9's own point), a
 * human/E5 judgment this function does not make. UNRELATED_RETRIEVED_CONTENT
 * and WEAK_CORRESPONDENCE below are the closest mechanical proxies for those
 * two categories and are reported as such, not renamed to claim more
 * certainty than the data supports.
 */
export function classifyE7Outcome(candidate: WorkflowCandidateResult): E7OutcomeClass {
  switch (candidate.status) {
    case "DUPLICATE":
      return "DUPLICATE_CANDIDATE";
    case "SKIPPED_BY_LIMIT":
      return "SKIPPED_BY_LIMIT";
    case "DISCOVERED":
      return "DISCOVERED_NOT_RETRIEVED";
    case "RETRIEVAL_FAILED":
      return "INACCESSIBLE_SOURCE";
    case "PROVIDER_ERROR":
      return "PROCESSING_ERROR";
    case "NO_CORRESPONDENCE":
      return "UNRELATED_RETRIEVED_CONTENT";
    case "CORRESPONDENCE_WEAK":
      return "WEAK_CORRESPONDENCE";
    case "RETRIEVED":
      return "WEAK_CORRESPONDENCE";
    case "CORRESPONDENCE_FOUND":
      if (candidate.verificationEligible) return "VERIFICATION_ELIGIBLE";
      if (candidate.correspondence?.strongCorrespondence) return "LIKELY_RELEVANT_CANDIDATE";
      return "STRONG_CORRESPONDENCE";
    default:
      return "PROCESSING_ERROR";
  }
}

/**
 * Most-informative-first ranking used to pick a single document-level
 * label from several candidates' outcomes. This is NOT array order:
 * lib/source-discovery-workflow.ts's own candidateResults puts every
 * SKIPPED_BY_LIMIT candidate BEFORE the ones actually processed (its own
 * candidateResults array is built as skipped.map(...) followed by the
 * processed loop's pushes) — picking candidates[0] naively would report
 * "SKIPPED_BY_LIMIT" for a document even when Crossref returned more than
 * maxCandidatesProcessed results and every one of the candidates actually
 * retrieved got a real, informative outcome. Discovered during the first
 * real 11-document pilot run: 9 of 11 documents had candidatesDiscovered
 * > 5 (the default budget), and every one of them was mislabeled
 * SKIPPED_BY_LIMIT by the naive candidates[0] version of this function
 * despite every processed candidate having a real INACCESSIBLE_SOURCE or
 * UNRELATED_RETRIEVED_CONTENT outcome.
 */
const E7_OUTCOME_RANK: E7OutcomeClass[] = [
  "VERIFICATION_ELIGIBLE",
  "LIKELY_RELEVANT_CANDIDATE",
  "STRONG_CORRESPONDENCE",
  "WEAK_CORRESPONDENCE",
  "UNRELATED_RETRIEVED_CONTENT",
  "INACCESSIBLE_SOURCE",
  "DISCOVERED_NOT_RETRIEVED",
  "DUPLICATE_CANDIDATE",
  "PROCESSING_ERROR",
  "SKIPPED_BY_LIMIT",
];

export function summarizeDocumentE7Outcome(candidates: E7CandidateObservation[]): E7OutcomeClass {
  if (candidates.length === 0) return "NO_CANDIDATE";
  // Prefer whatever was actually processed; only fall back to the skipped
  // set if literally every candidate was skipped by the budget (which
  // would mean maxCandidatesProcessed was 0 — not this phase's default).
  const processed = candidates.filter((c) => c.e7Outcome !== "SKIPPED_BY_LIMIT");
  const pool = processed.length > 0 ? processed : candidates;
  for (const rank of E7_OUTCOME_RANK) {
    const hit = pool.find((c) => c.e7Outcome === rank);
    if (hit) return hit.e7Outcome;
  }
  return pool[0].e7Outcome;
}

export type E7CandidateObservation = {
  candidateKey: string;
  sourceId: string | null;
  processingStatus: WorkflowCandidateResult["status"];
  provenanceState: WorkflowCandidateResult["provenanceState"];
  retrievalStatus: WorkflowCandidateResult["retrievalStatus"];
  correspondence: WorkflowCandidateResult["correspondence"];
  evidenceTypesCreated: string[];
  verificationEligible: boolean;
  e7Outcome: E7OutcomeClass;
};

export type E7DocumentObservation = {
  experimentId: string;
  documentId: string;
  documentTitle: string;
  documentCohort: string;
  workflowId: string;
  discoveryAttempts: SourceDiscoveryWorkflowResult["discoveryAttempts"];
  candidatesDiscovered: number;
  candidatesProcessed: number;
  candidatesSkipped: number;
  candidates: E7CandidateObservation[];
  documentE7Outcome: E7OutcomeClass;
  anyVerificationEligible: boolean;
  failures: SourceDiscoveryWorkflowResult["failures"];
};

/**
 * Runs exactly one archive document through E6D's observation-mode workflow
 * (discovery -> candidate -> retrieval -> correspondence -> evidence ->
 * verification-eligibility REPORT) against the caller-supplied client, which
 * this phase's task description requires to be an isolated experiment
 * database, never the shared production/dev connection. submittedText must
 * already have been resolved by lib/e7-archive-adapter.ts's
 * resolveArchiveDocumentText — this function never reads archive files
 * itself and never substitutes anything for missing text.
 */
export async function runE7ObservationForDocument(
  client: Client,
  params: {
    experimentId: string;
    metadata: ArchiveDocumentMetadata;
    documentCohort: string;
    submittedText: string;
    providerIds?: string[];
    retrieverId?: string;
  },
  config: Partial<SourceDiscoveryWorkflowConfig> = {},
  registries: { discoveryProviders?: DiscoveryProviderRegistry; contentRetrievers?: ContentRetrieverRegistry } = {},
): Promise<E7DocumentObservation> {
  const result = await runSourceDiscoveryWorkflow(
    client,
    {
      submittedText: params.submittedText,
      title: params.metadata.title,
      purpose: "LEGACY_BACKFILL",
      providerIds: params.providerIds,
      retrieverId: params.retrieverId,
    },
    config,
    registries,
  );

  const candidates: E7CandidateObservation[] = result.candidateResults.map((c) => ({
    candidateKey: c.candidateKey,
    sourceId: c.sourceId,
    processingStatus: c.status,
    provenanceState: c.provenanceState,
    retrievalStatus: c.retrievalStatus,
    correspondence: c.correspondence,
    evidenceTypesCreated: c.evidenceCreated,
    verificationEligible: c.verificationEligible,
    e7Outcome: classifyE7Outcome(c),
  }));

  const documentE7Outcome = summarizeDocumentE7Outcome(candidates);

  return {
    experimentId: params.experimentId,
    documentId: params.metadata.id,
    documentTitle: params.metadata.title,
    documentCohort: params.documentCohort,
    workflowId: result.workflowId,
    discoveryAttempts: result.discoveryAttempts,
    candidatesDiscovered: result.candidatesDiscovered,
    candidatesProcessed: result.candidatesProcessed,
    candidatesSkipped: result.candidatesSkipped,
    candidates,
    documentE7Outcome,
    anyVerificationEligible: result.verificationEligible,
    failures: result.failures,
  };
}
