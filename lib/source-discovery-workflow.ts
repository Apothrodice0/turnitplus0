import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { runDiscovery } from "./discovery-orchestrator";
import { createCandidateSourceFromDiscovery } from "./discovery-provenance-bridge";
import { retrieveAndCompareCandidate } from "./retrieval-correspondence-bridge";
import { DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS, type DocumentCorrespondenceResult } from "./document-correspondence";
import { findEvidenceForSource } from "./provenance-evidence";
import { evaluateVerificationEligibility } from "./provenance-verification-policy";
import { findProvenanceSourcesForDocumentIdentity, type ProvenanceSource } from "./provenance-registry";
import type { DiscoveryCandidate } from "./discovery-types";
import type { SourceDiscoveryProvider } from "./discovery-providers";
import {
  createDefaultDiscoveryProviderRegistry,
  createDefaultContentRetrieverRegistry,
  resolveDiscoveryProviders,
  resolveContentRetriever,
  type DiscoveryProviderRegistry,
  type ContentRetrieverRegistry,
} from "./source-discovery-registries";
import {
  DEFAULT_SOURCE_DISCOVERY_WORKFLOW_CONFIG,
  type SourceDiscoveryWorkflowConfig,
  type SourceDiscoveryWorkflowInput,
  type SourceDiscoveryWorkflowResult,
  type WorkflowCandidateResult,
  type WorkflowFailure,
  type CorrespondenceSummary,
} from "./source-discovery-workflow-types";

/**
 * Phase E6D: the controlled orchestration layer connecting E6A discovery,
 * E6B Crossref, and E6C retrieval/correspondence into one auditable,
 * server-side-only workflow. Not called from anywhere live in this phase —
 * see tests/source-discovery-workflow.test.mjs's structural "not imported
 * by any live route" check, matching every prior E6-phase orchestrator's
 * own precedent.
 *
 * This file adds no new algorithm anywhere: discovery signal/query
 * generation, provider calls, dedup/ranking, and discovery_attempts
 * persistence are all lib/discovery-orchestrator.ts's runDiscovery (E6A);
 * candidate creation is lib/discovery-provenance-bridge.ts (E6B) — the
 * ONLY path into CANDIDATE_SOURCE; retrieval, correspondence, and their
 * evidence are lib/retrieval-correspondence-bridge.ts (E6C). E6D composes
 * these, applies workflow-level budgets, and reports a bounded, structured
 * result — nothing more.
 *
 * The verification boundary (this phase's own task description, section
 * 21) is absolute: this file does not import lib/provenance-verification-
 * workflow.ts, never calls approveVerification, and never requests
 * VERIFIED_SOURCE from anything — see the structural test in
 * tests/provenance-scoring-invariance.test.mjs. `verificationEligible` in
 * the result is computed by re-reading each candidate's accumulated
 * evidence through lib/provenance-verification-policy.ts's pure,
 * side-effect-free evaluateVerificationEligibility (E4) — a report, never
 * an action.
 */

function candidateUrlFor(candidate: DiscoveryCandidate): string | null {
  return candidate.canonicalUrl ?? candidate.originalUrls[0] ?? null;
}

function findExistingSourceForCandidate(existingSources: ProvenanceSource[], candidate: DiscoveryCandidate): ProvenanceSource | null {
  for (const existing of existingSources) {
    if (candidate.externalIdentifier && existing.externalIdentifier && candidate.externalIdentifier === existing.externalIdentifier) return existing;
    if (candidate.canonicalUrl && existing.canonicalUrl && candidate.canonicalUrl === existing.canonicalUrl) return existing;
  }
  return null;
}

function summarizeCorrespondence(correspondence: DocumentCorrespondenceResult): CorrespondenceSummary {
  return {
    method: correspondence.method,
    containment: correspondence.containment,
    strongCorrespondence: correspondence.strongCorrespondence,
    matchedWordCount: correspondence.matchedWordCount,
    passageCount: correspondence.passages.length,
    longestMatchWords: correspondence.longestMatchWords,
  };
}

async function computeVerificationEligible(client: Client, sourceId: string): Promise<boolean> {
  const evidence = await findEvidenceForSource(client, sourceId);
  return evaluateVerificationEligibility(evidence).eligible;
}

/**
 * Processes exactly one document through the full discovery -> candidate
 * -> retrieval -> correspondence -> evidence pipeline. Sequential by
 * design (this phase's own task description, section 18: "Correctness >
 * performance at this stage") — candidates are processed one at a time,
 * not concurrently; a future phase can add bounded batching without
 * changing this function's contract.
 */
export async function runSourceDiscoveryWorkflow(
  client: Client,
  input: SourceDiscoveryWorkflowInput,
  config: Partial<SourceDiscoveryWorkflowConfig> = {},
  registries: { discoveryProviders?: DiscoveryProviderRegistry; contentRetrievers?: ContentRetrieverRegistry } = {},
): Promise<SourceDiscoveryWorkflowResult> {
  const resolvedConfig: SourceDiscoveryWorkflowConfig = { ...DEFAULT_SOURCE_DISCOVERY_WORKFLOW_CONFIG, ...config };
  const workflowId = randomUUID();
  const failures: WorkflowFailure[] = [];

  const discoveryProviderRegistry = registries.discoveryProviders ?? createDefaultDiscoveryProviderRegistry();
  const contentRetrieverRegistry = registries.contentRetrievers ?? createDefaultContentRetrieverRegistry();

  const providerIds = (input.providerIds ?? ["crossref"]).slice(0, resolvedConfig.maxDiscoveryProviders);
  let providers: SourceDiscoveryProvider[];
  try {
    providers = resolveDiscoveryProviders(discoveryProviderRegistry, providerIds);
  } catch (error) {
    failures.push({ candidateKey: null, stage: "discovery", message: error instanceof Error ? error.message : String(error) });
    providers = [];
  }

  const retriever = resolveContentRetriever(contentRetrieverRegistry, input.retrieverId ?? "http");

  const discovery = await runDiscovery({
    documentIdentityId: input.documentIdentityId ?? null,
    purpose: input.purpose ?? "MANUAL_RESEARCH",
    title: input.title ?? null,
    author: input.author ?? null,
    rawText: input.submittedText,
    providers,
    queryConfig: { maxQueries: resolvedConfig.maxQueriesPerProvider },
    client,
  });

  const existingSources = input.documentIdentityId
    ? await findProvenanceSourcesForDocumentIdentity(client, input.documentIdentityId)
    : [];

  const selected = discovery.candidates.slice(0, resolvedConfig.maxCandidatesProcessed);
  const skipped = discovery.candidates.slice(resolvedConfig.maxCandidatesProcessed);

  const candidateResults: WorkflowCandidateResult[] = skipped.map((candidate) => ({
    candidateKey: candidate.candidateKey,
    sourceId: null,
    status: "SKIPPED_BY_LIMIT",
    provenanceState: null,
    retrievalStatus: null,
    correspondence: null,
    evidenceCreated: [],
    verificationEligible: false,
  }));

  const workflowDeadline = Date.now() + resolvedConfig.workflowTimeoutMs;
  let retrievalsUsed = 0;

  for (const candidate of selected) {
    const existing = findExistingSourceForCandidate(existingSources, candidate);
    if (existing) {
      candidateResults.push({
        candidateKey: candidate.candidateKey,
        sourceId: existing.id,
        status: "DUPLICATE",
        provenanceState: existing.provenanceState,
        retrievalStatus: null,
        correspondence: null,
        evidenceCreated: [],
        verificationEligible: await computeVerificationEligible(client, existing.id).catch(() => false),
      });
      continue;
    }

    let source: ProvenanceSource;
    try {
      source = await createCandidateSourceFromDiscovery(client, candidate, input.documentIdentityId ?? null);
    } catch (error) {
      failures.push({ candidateKey: candidate.candidateKey, stage: "candidate-creation", message: error instanceof Error ? error.message : String(error) });
      candidateResults.push({
        candidateKey: candidate.candidateKey,
        sourceId: null,
        status: "PROVIDER_ERROR",
        provenanceState: null,
        retrievalStatus: null,
        correspondence: null,
        evidenceCreated: [],
        verificationEligible: false,
      });
      continue;
    }

    const url = candidateUrlFor(candidate);
    const canRetrieve = url !== null && retrievalsUsed < resolvedConfig.maxRetrievals && Date.now() < workflowDeadline;

    if (!canRetrieve) {
      candidateResults.push({
        candidateKey: candidate.candidateKey,
        sourceId: source.id,
        status: "DISCOVERED",
        provenanceState: source.provenanceState,
        retrievalStatus: null,
        correspondence: null,
        evidenceCreated: [],
        verificationEligible: await computeVerificationEligible(client, source.id).catch(() => false),
      });
      continue;
    }

    retrievalsUsed += 1;
    try {
      const outcome = await retrieveAndCompareCandidate(client, {
        sourceId: source.id,
        candidateUrl: url,
        submittedText: input.submittedText,
        retriever,
        thresholds: { ...DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS, maxPassages: resolvedConfig.maxCorrespondencePassages },
      });

      const status = outcome.retrievalStatus !== "SUCCESS"
        ? "RETRIEVAL_FAILED"
        : !outcome.correspondence
          ? "RETRIEVED"
          : outcome.correspondence.exactCanonicalMatch || outcome.correspondence.strongCorrespondence
            ? "CORRESPONDENCE_FOUND"
            : outcome.correspondence.matchedWordCount > 0
              ? "CORRESPONDENCE_WEAK"
              : "NO_CORRESPONDENCE";

      candidateResults.push({
        candidateKey: candidate.candidateKey,
        sourceId: source.id,
        status,
        provenanceState: outcome.newState as WorkflowCandidateResult["provenanceState"],
        retrievalStatus: outcome.retrievalStatus as WorkflowCandidateResult["retrievalStatus"],
        correspondence: outcome.correspondence ? summarizeCorrespondence(outcome.correspondence) : null,
        evidenceCreated: outcome.evidenceCreated,
        verificationEligible: await computeVerificationEligible(client, source.id).catch(() => false),
      });
    } catch (error) {
      failures.push({ candidateKey: candidate.candidateKey, stage: "retrieval", message: error instanceof Error ? error.message : String(error) });
      candidateResults.push({
        candidateKey: candidate.candidateKey,
        sourceId: source.id,
        status: "PROVIDER_ERROR",
        provenanceState: source.provenanceState,
        retrievalStatus: null,
        correspondence: null,
        evidenceCreated: [],
        verificationEligible: await computeVerificationEligible(client, source.id).catch(() => false),
      });
    }
  }

  return {
    workflowId,
    documentId: input.documentIdentityId ?? null,
    discoveryAttempts: discovery.attempts.map((a) => ({ providerId: a.providerId, providerType: a.providerType, status: a.status, resultCount: a.resultCount, errorMessage: a.errorMessage })),
    candidatesDiscovered: discovery.candidates.length,
    candidatesProcessed: selected.length,
    candidatesSkipped: skipped.length,
    candidateResults,
    verificationEligible: candidateResults.some((c) => c.verificationEligible),
    failures,
  };
}
