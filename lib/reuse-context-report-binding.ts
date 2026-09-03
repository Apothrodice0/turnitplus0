import type { Client } from "@libsql/client";
import type { DeclaredContext } from "./reuse-context-declarations";
import {
  canDeclareReuseContext,
  getActiveDeclarationsByDocumentIdentity,
  getDeclarationsReferencingSubmission,
  type ReuseContextDeclarationView,
} from "./reuse-context-declarations";
import { deriveReuseContextActionRef } from "./reuse-context-action-ref";
import type { ReportHistoricalSubmissionMatch } from "./report-types";
import type {
  ReuseContextActiveDeclaration,
  ReuseContextConfirmedDeclaration,
  ReuseContextEnvelope,
  ReuseContextPendingDeclaration,
  ReuseContextUnavailableReason,
} from "./reuse-context-types";

export type {
  ReuseContextActiveDeclaration,
  ReuseContextConfirmedDeclaration,
  ReuseContextEnvelope,
  ReuseContextPendingDeclaration,
  ReuseContextUnavailableReason,
} from "./reuse-context-types";

/**
 * Report-bound resolution for the ordinary-user reuse-context flow.
 *
 * The ordinary client only ever holds `reportId` (the existing public report
 * handle) and opaque session-bound `actionRef` values (lib/reuse-context-
 * action-ref.ts). It never sees or supplies a document_identity_id, a
 * matched_representation_id, a matched_submission_reference_id, a
 * reuse_context_declarations primary key, an account id, or a source_ref.
 *
 * Every provenance identifier is resolved here, server-side, from a report
 * the caller demonstrably owns:
 *
 *   reportId + accountId
 *     -> saved_reports row (WHERE id = ? AND user_id = ?), cardinality-checked
 *     -> saved_reports.document_identity_id  (the ONLY valid identity source;
 *        NULL fails closed with REUSE_CONTEXT_UNAVAILABLE — no canonical-hash
 *        fallback anywhere)
 *     -> the exact (document_identity_id, representation) pair
 *
 * This module never imports the matcher. The already-computed
 * ReportHistoricalSubmissionMatch is passed in by the caller (the report GET
 * route reuses its own local value; the declare route computes it via the
 * normal cache-first snapshot path and passes it here).
 *
 * Nothing this module returns to a route response carries a raw id — only
 * bounded enums, dates, and actionRefs.
 */

export type CallerOwnedReportBinding =
  | { status: "OK"; documentIdentityId: string; deviceKey: string; rawText: string }
  | { status: "NOT_FOUND" }
  | { status: "AMBIGUOUS" }
  | { status: "REUSE_CONTEXT_UNAVAILABLE" };

type SavedReportBindingRow = {
  device_key: string;
  document_identity_id: string | null;
  payload_json: string;
};

/** YYYY-MM-DD from a SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS") or ISO string. Never exposes a time-of-day. */
function dateOnly(value: string | null): string {
  if (typeof value !== "string" || value.length < 10) return "";
  return value.slice(0, 10);
}

/**
 * Resolve the caller-owned report and its exact document identity.
 *
 * Cardinality is checked explicitly here rather than trusting a LIMIT 1 —
 * the signed-in lookup key is (id, user_id), and while a collision is
 * unlikely (report ids are client-generated), more than one matching row
 * must fail closed, never silently pick one.
 */
export async function resolveCallerOwnedReportBinding(
  client: Client,
  params: { reportId: string; accountId: string },
): Promise<CallerOwnedReportBinding> {
  const result = await client.execute({
    sql: `SELECT device_key, document_identity_id, payload_json
          FROM saved_reports WHERE id = ? AND user_id = ?`,
    args: [params.reportId, params.accountId],
  });
  if (result.rows.length === 0) return { status: "NOT_FOUND" };
  if (result.rows.length > 1) return { status: "AMBIGUOUS" };
  const row = result.rows[0] as unknown as SavedReportBindingRow;
  if (row.document_identity_id === null || String(row.document_identity_id).length === 0) {
    return { status: "REUSE_CONTEXT_UNAVAILABLE" };
  }
  let rawText = "";
  try {
    const parsed = JSON.parse(String(row.payload_json)) as { text?: unknown };
    if (typeof parsed.text === "string") rawText = parsed.text;
  } catch {
    rawText = "";
  }
  return {
    status: "OK",
    documentIdentityId: String(row.document_identity_id),
    deviceKey: String(row.device_key),
    rawText,
  };
}

/**
 * The first PRIOR_SUBMISSION entry in the already-deterministically-ordered
 * match list (lib/user-submission-matching.ts's compareMatches: exact first,
 * then containment, then matched-word count, then representation id). A SELF
 * or TURNITPLUS_CORPUS_SOURCE entry at index 0 never hides a PRIOR_SUBMISSION
 * later in the list. No title / text / hash / date is consulted.
 *
 * Used for NEW declarations only, and for the `isCurrent` flag. Withdrawal
 * never goes through this.
 */
export function firstEligiblePriorSubmissionRepresentationId(
  historicalSubmissionMatch: ReportHistoricalSubmissionMatch | undefined | null,
): string | null {
  if (!historicalSubmissionMatch || historicalSubmissionMatch.status !== "MATCHED") return null;
  const entry = (historicalSubmissionMatch.matches ?? []).find((m) => m.relationshipType === "PRIOR_SUBMISSION");
  return entry ? entry.matchedRepresentationId : null;
}

function toActiveDeclaration(
  sessionKey: string,
  view: ReuseContextDeclarationView,
  currentRepresentationId: string | null,
): ReuseContextActiveDeclaration | null {
  if (view.verificationState !== "SELF_ASSERTED_UNVERIFIED" && view.verificationState !== "MUTUALLY_CONFIRMED") {
    return null; // REVOKED never surfaces
  }
  return {
    actionRef: deriveReuseContextActionRef(sessionKey, view.id),
    state: view.verificationState,
    declaredContext: view.declaredContext,
    ...(view.verificationState === "MUTUALLY_CONFIRMED" && view.confirmedAt ? { confirmedDate: dateOnly(view.confirmedAt) } : {}),
    isCurrent: currentRepresentationId !== null && view.representationId === currentRepresentationId,
  };
}

/**
 * Build the bounded, id-free envelope for one caller-owned report.
 *
 * Assumes `documentIdentityId` was already resolved from a caller-owned
 * report by resolveCallerOwnedReportBinding (status "OK"). `sessionKey` must
 * be the session-bound HMAC key (lib/reuse-context-action-ref.ts) — callers
 * pass `null` when there is no usable session, and then this must not be
 * called at all (the route omits reuseContext).
 */
export async function buildReuseContextEnvelope(
  client: Client,
  params: {
    reportId: string;
    documentIdentityId: string;
    accountId: string;
    sessionKey: string;
    historicalSubmissionMatch: ReportHistoricalSubmissionMatch | undefined | null;
  },
): Promise<ReuseContextEnvelope> {
  const currentRepresentationId = firstEligiblePriorSubmissionRepresentationId(params.historicalSubmissionMatch);

  let available = false;
  let canDeclare = false;
  let unavailableReason: ReuseContextUnavailableReason | undefined;

  if (currentRepresentationId !== null) {
    available = true;
    const affordance = await canDeclareReuseContext(client, {
      documentIdentityId: params.documentIdentityId,
      representationId: currentRepresentationId,
      accountId: params.accountId,
    });
    if (affordance.canDeclare) {
      canDeclare = true;
    } else if (affordance.reason === "AMBIGUOUS") {
      unavailableReason = "MULTIPLE_SOURCES";
    }
    // SELF_RELATIONSHIP / NOT_SUBMISSION_OWNER / *_NOT_FOUND / ALREADY_ACTIVE:
    // no user-facing reason. ALREADY_ACTIVE is reflected by activeDeclarations.
  } else if ((params.historicalSubmissionMatch?.matches?.length ?? 0) > 0) {
    // There are historical matches, but none are PRIOR_SUBMISSION.
    unavailableReason = "NO_PRIOR_SUBMISSION_MATCH";
  }

  const activeViews = await getActiveDeclarationsByDocumentIdentity(client, { documentIdentityId: params.documentIdentityId });
  const activeDeclarations = activeViews
    .map((view) => toActiveDeclaration(params.sessionKey, view, currentRepresentationId))
    .filter((d): d is ReuseContextActiveDeclaration => d !== null);

  // Declarations referencing THIS report's own submission: SELF_ASSERTED_
  // UNVERIFIED rows are `pending` (awaiting a confirm/reject decision);
  // active MUTUALLY_CONFIRMED rows are `confirmed` (the viewer, as the
  // original submitter, previously confirmed them and may still retract via
  // POST /api/reuse-context/revoke). REVOKED rows are excluded by the query.
  const referencingViews = await getDeclarationsReferencingSubmission(client, { documentIdentityId: params.documentIdentityId });
  const pending: ReuseContextPendingDeclaration[] = referencingViews
    .filter((view) => view.verificationState === "SELF_ASSERTED_UNVERIFIED")
    .map((view) => ({
      actionRef: deriveReuseContextActionRef(params.sessionKey, view.id),
      state: "SELF_ASSERTED_UNVERIFIED",
      declaredContext: view.declaredContext,
      declaredDate: dateOnly(view.declaredAt),
    }));
  const confirmed: ReuseContextConfirmedDeclaration[] = referencingViews
    .filter((view) => view.verificationState === "MUTUALLY_CONFIRMED")
    .map((view) => ({
      actionRef: deriveReuseContextActionRef(params.sessionKey, view.id),
      declaredContext: view.declaredContext,
      ...(view.confirmedAt ? { confirmedDate: dateOnly(view.confirmedAt) } : {}),
    }));

  return {
    reportId: params.reportId,
    declare: { available, canDeclare, ...(unavailableReason ? { unavailableReason } : {}), activeDeclarations },
    confirm: { pending, confirmed },
  };
}
