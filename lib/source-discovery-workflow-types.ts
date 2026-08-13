import type { DiscoveryPurpose } from "./discovery-types";
import type { ProvenanceState } from "./provenance-types";
import type { RetrievalStatus } from "./retrieval-types";

/**
 * Phase E6D: the orchestration workflow's own vocabulary and shapes.
 *
 * CandidateProcessingStatus is deliberately NOT a ProvenanceState —
 * "how far did this workflow run get with this candidate" and "what is
 * this source's actual provenance state" are different axes (this phase's
 * own task description, section 13: "Candidate processing status is not
 * provenance state"). A candidate can be CORRESPONDENCE_FOUND while its
 * provenanceState is PROVENANCE_PENDING; nothing here ever reaches
 * VERIFIED_SOURCE, and this vocabulary has no value that means "verified."
 */
export const CANDIDATE_PROCESSING_STATUSES = [
  "DISCOVERED",
  "RETRIEVED",
  "CORRESPONDENCE_FOUND",
  "CORRESPONDENCE_WEAK",
  "RETRIEVAL_FAILED",
  "NO_CORRESPONDENCE",
  "SKIPPED_BY_LIMIT",
  "DUPLICATE",
  "PROVIDER_ERROR",
] as const;

export type CandidateProcessingStatus = (typeof CANDIDATE_PROCESSING_STATUSES)[number];

const CANDIDATE_PROCESSING_STATUS_SET: ReadonlySet<string> = new Set(CANDIDATE_PROCESSING_STATUSES);

export function isCandidateProcessingStatus(value: unknown): value is CandidateProcessingStatus {
  return typeof value === "string" && CANDIDATE_PROCESSING_STATUS_SET.has(value);
}

/**
 * A starting point for testing/development, not a calibrated or permanent
 * product decision — same disclaimer as every other DEFAULT_* config this
 * project has introduced since Phase B. Every field here is genuinely
 * load-bearing in lib/source-discovery-workflow.ts (none are decorative):
 * maxDiscoveryProviders bounds the provider list passed to
 * lib/discovery-orchestrator.ts's runDiscovery; maxQueriesPerProvider is
 * forwarded to that same call's queryConfig (E6A's own existing knob, not a
 * new query-generation mechanism); maxCandidatesProcessed and maxRetrievals
 * are independent budgets (a candidate can be selected/created without
 * necessarily being retrieved, if the retrieval budget runs out first);
 * maxResponseBytes/maxCorrespondencePassages are forwarded into E6C's
 * retriever/correspondence configuration, not reimplemented here.
 */
export type SourceDiscoveryWorkflowConfig = {
  maxDiscoveryProviders: number;
  maxQueriesPerProvider: number;
  maxCandidatesProcessed: number;
  maxRetrievals: number;
  maxResponseBytes: number;
  maxCorrespondencePassages: number;
  /** Soft wall-clock budget for the whole workflow run — checked between candidates, not mid-retrieval (each retrieval already has its own timeout via the retriever's own config). */
  workflowTimeoutMs: number;
};

export const DEFAULT_SOURCE_DISCOVERY_WORKFLOW_CONFIG: SourceDiscoveryWorkflowConfig = {
  maxDiscoveryProviders: 3,
  maxQueriesPerProvider: 6,
  maxCandidatesProcessed: 5,
  maxRetrievals: 5,
  maxResponseBytes: 2_000_000,
  maxCorrespondencePassages: 10,
  workflowTimeoutMs: 60_000,
};

export type SourceDiscoveryWorkflowInput = {
  /** Optional — a workflow run need not be tied to a live document_identities row (e.g. MANUAL_RESEARCH use). */
  documentIdentityId?: string | null;
  /**
   * The document's own text, held only in memory for the duration of this
   * call — never persisted by this module, matching Phase A's "raw text is
   * never stored" discipline and lib/retrieval-correspondence-bridge.ts's
   * own submittedText parameter (named identically here on purpose, to
   * avoid ever confusing it with a *retrieved* candidate's own extracted
   * text, which lib/retrieval-types.ts separately calls extractedText).
   */
  submittedText: string;
  title?: string | null;
  author?: string | null;
  purpose?: DiscoveryPurpose;
  /** Discovery provider IDs to resolve from the registry — defaults to ["crossref"]. */
  providerIds?: string[];
  /** Content retriever ID to resolve from the registry — defaults to "http". */
  retrieverId?: string;
};

export type CorrespondenceSummary = {
  method: "canonical_hash" | "shingle_containment";
  containment: number;
  strongCorrespondence: boolean;
  matchedWordCount: number;
  passageCount: number;
  longestMatchWords: number;
};

export type WorkflowCandidateResult = {
  candidateKey: string;
  /** Null only when no provenance_sources row was ever created for this candidate (SKIPPED_BY_LIMIT). */
  sourceId: string | null;
  status: CandidateProcessingStatus;
  provenanceState: ProvenanceState | null;
  retrievalStatus: RetrievalStatus | null;
  /**
   * A bounded summary only — deliberately excludes the full passages array
   * (which contains reconstructed excerpts of the submitted document's own
   * text). Full passage-level evidence remains safely available via
   * lib/provenance-evidence.ts's findEvidenceForSource for anyone with a
   * legitimate reason to look it up; it is not echoed back through this
   * workflow's return value (this phase's own task description, section
   * 12: "Do not expose private document text in the result").
   */
  correspondence: CorrespondenceSummary | null;
  evidenceCreated: string[];
  /**
   * Whether lib/provenance-verification-policy.ts's evaluateVerificationEligibility
   * (E4, pure, read-only) currently reports this candidate's accumulated
   * evidence as eligible — reporting ONLY. Nothing in this workflow acts on
   * this value; see this phase's own task description, section 21.
   */
  verificationEligible: boolean;
};

export type WorkflowFailure = {
  candidateKey: string | null;
  stage: "discovery" | "candidate-creation" | "retrieval" | "correspondence";
  message: string;
};

export type SourceDiscoveryWorkflowResult = {
  workflowId: string;
  documentId: string | null;
  discoveryAttempts: Array<{ providerId: string; providerType: string; status: string; resultCount: number; errorMessage: string | null }>;
  candidatesDiscovered: number;
  candidatesProcessed: number;
  candidatesSkipped: number;
  candidateResults: WorkflowCandidateResult[];
  /** True if ANY candidate is currently verification-eligible per E4's pure gate — reporting only, see WorkflowCandidateResult.verificationEligible's own comment. */
  verificationEligible: boolean;
  failures: WorkflowFailure[];
};
