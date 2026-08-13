import type { Client } from "@libsql/client";
import { findProvenanceSourceById, transitionProvenanceState } from "./provenance-registry";
import { createProvenanceEvidence } from "./provenance-evidence";
import { canonicalSha256 } from "./document-identity";
import { createSourceRetrieval } from "./retrieval-repository";
import { createHttpContentRetriever, DEFAULT_HTTP_CONTENT_RETRIEVER_CONFIG } from "./http-content-retriever";
import type { SourceContentRetriever } from "./retrieval-types";
import {
  computeDocumentCorrespondence,
  DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS,
  type DocumentCorrespondenceResult,
  type DocumentCorrespondenceThresholds,
} from "./document-correspondence";
import { isValidProvenanceTransition } from "./provenance-types";

/**
 * Phase E6C: the retrieval + correspondence orchestration. This module is
 * the ONLY place that creates URL_ACCESSIBILITY, RETRIEVAL_TIMESTAMP,
 * CONTENT_HASH, CANONICAL_CORRESPONDENCE, STRONG_TEXT_CORRESPONDENCE, and
 * PASSAGE_CORRESPONDENCE evidence from a retrieval — see this phase's own
 * task description, section 18's evidence-chain diagram. It never creates
 * DISCOVERY_INDEPENDENCE (that comes only from
 * lib/discovery-provenance-bridge.ts, Phase E6B) and never creates
 * PUBLISHER_IDENTITY merely because a page happens to name a publisher
 * (this phase's own task description, section 17 — establishing publisher
 * identity is a stronger claim than "the page's HTML mentioned a name,"
 * which this module has no way to verify).
 *
 * This module NEVER calls lib/provenance-verification-workflow.ts's
 * approveVerification, and NEVER transitions a source to VERIFIED_SOURCE —
 * see tests/retrieval-correspondence-bridge.test.mjs's structural proof.
 * The one state transition it DOES perform — CANDIDATE_SOURCE ->
 * PROVENANCE_PENDING, only after a SUCCESSFUL retrieval — is the same
 * gate-free, evidence-independent transition Phase E5's own tests already
 * established needs no dedicated workflow function
 * (lib/provenance-types.ts's isValidProvenanceTransition already allows it
 * unconditionally). Without something performing this exact transition
 * somewhere, a discovered candidate could never reach PROVENANCE_PENDING at
 * all, and E5's approveVerification (which requires PROVENANCE_PENDING or
 * DISPUTED_SOURCE as a starting state) would be permanently unreachable for
 * every real candidate — this phase is where that pipeline finally
 * connects, without ever approving anything itself.
 */

export type RetrieveAndCompareParams = {
  sourceId: string;
  candidateUrl: string;
  /** The TurnitPlus submission's own text, held only in memory for this call — never persisted here, matching Phase A's "raw text is never stored" discipline. */
  submittedText: string;
  retriever?: SourceContentRetriever;
  thresholds?: DocumentCorrespondenceThresholds;
};

export type RetrieveAndCompareResult = {
  retrievalStatus: string;
  retrievalId: number;
  correspondence: DocumentCorrespondenceResult | null;
  evidenceCreated: string[];
  stateChanged: boolean;
  newState: string;
};

/**
 * Moves a source from CANDIDATE_SOURCE to PROVENANCE_PENDING once evidence
 * has been gathered for it. A safe no-op if the source is already past
 * CANDIDATE_SOURCE (idempotent — see lib/provenance-verification-workflow.ts's
 * own idempotency note for the identical reasoning) or if, for any reason,
 * the transition is not currently valid; never throws for either case,
 * since failing to advance the review queue is not a reason to fail the
 * whole retrieval+correspondence operation that already succeeded.
 */
async function advanceCandidateToPendingReview(client: Client, sourceId: string): Promise<{ changed: boolean; newState: string }> {
  const source = await findProvenanceSourceById(client, sourceId);
  if (!source) throw new Error(`advanceCandidateToPendingReview: no provenance_sources row ${sourceId}`);
  if (source.provenanceState !== "CANDIDATE_SOURCE") {
    return { changed: false, newState: source.provenanceState };
  }
  if (!isValidProvenanceTransition(source.provenanceState, "PROVENANCE_PENDING")) {
    return { changed: false, newState: source.provenanceState };
  }
  const { source: updated } = await transitionProvenanceState(client, {
    sourceId,
    toState: "PROVENANCE_PENDING",
    reason: "retrieval and correspondence evidence gathered (Phase E6C)",
  });
  return { changed: true, newState: updated.provenanceState };
}

/**
 * The full E6C pipeline for one candidate: retrieve -> extract -> hash ->
 * compare -> create evidence -> advance to PROVENANCE_PENDING. Never
 * throws on a retrieval failure (that is itself a recorded, legitimate
 * outcome) — only throws for a genuinely unexpected condition (e.g. an
 * unknown sourceId), consistent with this codebase's "honest functions"
 * convention for actual programming errors versus expected real-world
 * outcomes.
 */
export async function retrieveAndCompareCandidate(client: Client, params: RetrieveAndCompareParams): Promise<RetrieveAndCompareResult> {
  const source = await findProvenanceSourceById(client, params.sourceId);
  if (!source) throw new Error(`retrieveAndCompareCandidate: no provenance_sources row ${params.sourceId}`);

  const retriever = params.retriever ?? createHttpContentRetriever(DEFAULT_HTTP_CONTENT_RETRIEVER_CONFIG);
  const thresholds = params.thresholds ?? DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS;

  const retrieved = await retriever.retrieve({ url: params.candidateUrl });

  const retrievalRow = await createSourceRetrieval(client, {
    sourceId: params.sourceId,
    originalUrl: retrieved.originalUrl,
    finalUrl: retrieved.finalUrl,
    httpStatus: retrieved.httpStatus,
    contentType: retrieved.contentType,
    retrievedAt: retrieved.retrievedAt,
    rawSha256: retrieved.rawSha256,
    canonicalSha256: retrieved.canonicalSha256,
    extractedText: retrieved.extractedText,
    extractorVersion: retrieved.extractorVersion,
    status: retrieved.status,
    errorMessage: retrieved.errorMessage,
  });

  const evidenceCreated: string[] = [];
  const succeeded = retrieved.status === "SUCCESS";

  await createProvenanceEvidence(client, {
    sourceId: params.sourceId,
    evidenceType: "URL_ACCESSIBILITY",
    payload: {
      url: retrieved.finalUrl ?? retrieved.originalUrl,
      httpStatus: retrieved.httpStatus,
      retrievedAt: retrieved.retrievedAt,
      accessible: succeeded,
    },
    observedAt: retrieved.retrievedAt,
  });
  evidenceCreated.push("URL_ACCESSIBILITY");

  await createProvenanceEvidence(client, {
    sourceId: params.sourceId,
    evidenceType: "RETRIEVAL_TIMESTAMP",
    payload: { retrievedAt: retrieved.retrievedAt },
    observedAt: retrieved.retrievedAt,
  });
  evidenceCreated.push("RETRIEVAL_TIMESTAMP");

  let correspondence: DocumentCorrespondenceResult | null = null;

  if (succeeded && retrieved.extractedText && retrieved.rawSha256 && retrieved.canonicalSha256) {
    const externalCanonicalHash = retrieved.canonicalSha256;
    correspondence = computeDocumentCorrespondence(params.submittedText, retrieved.extractedText, thresholds);

    // candidateHash/externalHash follow lib/provenance-evidence-types.ts's
    // ContentHashPayload convention exactly: candidateHash is OUR side (the
    // submission under review), externalHash is the retrieved source's own
    // hash — match is whether the two are actually identical, which is the
    // same canonical-hash comparison lib/document-correspondence.ts's
    // exactCanonicalMatch already made, reused here rather than recomputed.
    await createProvenanceEvidence(client, {
      sourceId: params.sourceId,
      evidenceType: "CONTENT_HASH",
      payload: {
        candidateHash: canonicalSha256(params.submittedText),
        externalHash: externalCanonicalHash,
        algorithm: "sha256",
        match: correspondence.exactCanonicalMatch,
      },
      observedAt: retrieved.retrievedAt,
    });
    evidenceCreated.push("CONTENT_HASH");

    if (correspondence.exactCanonicalMatch) {
      await createProvenanceEvidence(client, {
        sourceId: params.sourceId,
        evidenceType: "CANONICAL_CORRESPONDENCE",
        payload: { method: "canonical_hash", match: true },
        observedAt: retrieved.retrievedAt,
      });
      evidenceCreated.push("CANONICAL_CORRESPONDENCE");
    } else {
      await createProvenanceEvidence(client, {
        sourceId: params.sourceId,
        evidenceType: "STRONG_TEXT_CORRESPONDENCE",
        payload: {
          method: "shingle_containment",
          containment: correspondence.containment,
          threshold: thresholds.strongContainmentThreshold,
          match: correspondence.strongCorrespondence,
        },
        observedAt: retrieved.retrievedAt,
      });
      evidenceCreated.push("STRONG_TEXT_CORRESPONDENCE");
    }

    if (correspondence.passages.length > 0) {
      await createProvenanceEvidence(client, {
        sourceId: params.sourceId,
        evidenceType: "PASSAGE_CORRESPONDENCE",
        payload: {
          method: correspondence.method,
          passageCount: correspondence.passages.length,
          passages: correspondence.passages,
        },
        observedAt: retrieved.retrievedAt,
      });
      evidenceCreated.push("PASSAGE_CORRESPONDENCE");
    }
  }

  const advance = succeeded
    ? await advanceCandidateToPendingReview(client, params.sourceId)
    : { changed: false, newState: source.provenanceState };

  return {
    retrievalStatus: retrieved.status,
    retrievalId: retrievalRow.id,
    correspondence,
    evidenceCreated,
    stateChanged: advance.changed,
    newState: advance.newState,
  };
}
