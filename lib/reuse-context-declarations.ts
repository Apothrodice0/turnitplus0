import type { Client } from "@libsql/client";
import { resolveExactMatchPairReference } from "./e8s-match-pair-resolution";

/**
 * Phase E8S Step 4: the reuse-context declaration write/read layer designed
 * in E8S Step 2 and built on E8S Step 3's exact match-pair resolver
 * (lib/e8s-match-pair-resolution.ts). An independent, opt-in, human-asserted
 * claim about one specific historical match — never a replacement for, and
 * never read by, lib/user-submission-matching.ts's relationshipType
 * classification (SELF/PRIOR_SUBMISSION/UNKNOWN_RELATIONSHIP) or
 * lib/report-historical-match.ts's snapshot cache. This module does not
 * import either of those files, and neither of them imports this one — see
 * this file's own structural tests. E8S Step 6 adds real, session-authenticated
 * API routes (app/api/reuse-context/*) and presentational components
 * (components/reuse-context/*) on top of this module, but neither is
 * imported from the live report route/page/component — this feature is not
 * reachable by a real user yet (see this phase's own final report).
 *
 * SELF is deliberately not a storable declared_context value (it is an
 * existing, automatically-computed relationship, never a declaration — see
 * E8S Step 1 §5/Step 2's own task description) and declareReuseContext
 * actively refuses to create a row when the resolved match pair turns out
 * to belong to the same account on both sides (SELF_RELATIONSHIP_NOT_DECLARABLE)
 * — see test N.
 *
 * Every write is validated server-side against data already proven by the
 * match pair itself — never a client-supplied account relationship:
 *   - the declarer must be the account that owns documentIdentityId (the
 *     CURRENT submission), checked against document_identities.account_id;
 *   - the confirmer must be the account that owns the resolved matched_
 *     submission_reference_id's document identity (the ORIGINAL submission)
 *     — resolved server-side via corpus_submission_references, never
 *     trusted from the caller;
 *   - a declarer can never confirm their own declaration.
 * lib/e8s-match-pair-resolution.ts's own privacy guarantee (never joins
 * document_identities/users) does not apply inside this file: this module
 * IS the place account ownership is legitimately checked, exactly like
 * lib/user-submission-corpus.ts's summarizeSubmissionOwnership already does
 * for the production matcher. The difference is what leaves this module:
 * every function here returns ReuseContextDeclarationView, which never
 * contains a raw account id — only ids/enums/timestamps bounded exactly
 * like historical_match_shadow_evaluations' own telemetry discipline.
 *
 * Revoke is a state change (revoked_at/revoked_by_account_id set via
 * UPDATE), never a DELETE — every declaration ever made stays queryable.
 * Uniqueness of the ACTIVE row per match pair is enforced by the database's
 * own partial unique index (ux_reuse_context_declarations_active_pair,
 * drizzle/0022) — declareReuseContext also pre-checks it for a clean status
 * on the common path, but the INSERT itself is the actual authority, so two
 * genuinely concurrent declare calls for the same pair still leave exactly
 * one active row (see test O).
 *
 * Never reads or writes score, archiveScore, aiScore, or verifiedSimilarity
 * — see this file's own structural test L. Never stores document text,
 * historical document text, or email — the schema has no columns for any
 * of those (drizzle/0022_reuse_context_declarations.sql).
 */

export type DeclaredContext =
  | "SUPERVISOR_COPY"
  | "COAUTHOR_COPY"
  | "INSTITUTIONAL_SUBMISSION"
  | "AUTHORIZED_ARCHIVAL_COPY"
  | "OTHER_AUTHORIZED_REUSE";

export type VerificationState = "SELF_ASSERTED_UNVERIFIED" | "MUTUALLY_CONFIRMED" | "REVOKED";

/** Render-safe: no account id ever appears here, on any code path, for any function in this module. */
export type ReuseContextDeclarationView = {
  id: number;
  representationId: string;
  declaredContext: DeclaredContext;
  verificationState: VerificationState;
  declaredAt: string;
  confirmedAt: string | null;
  revokedAt: string | null;
};

type DeclarationRow = {
  id: number | bigint;
  document_identity_id: string;
  matched_representation_id: string;
  matched_submission_reference_id: number | bigint | null;
  declared_context: string;
  declared_by_account_id: string | null;
  declared_at: string;
  confirmed_by_account_id: string | null;
  confirmed_at: string | null;
  verification_state: string;
  revoked_at: string | null;
  revoked_by_account_id: string | null;
  created_at: string;
};

function toView(row: DeclarationRow): ReuseContextDeclarationView {
  return {
    id: Number(row.id),
    representationId: row.matched_representation_id,
    declaredContext: row.declared_context as DeclaredContext,
    verificationState: row.verification_state as VerificationState,
    declaredAt: row.declared_at,
    confirmedAt: row.confirmed_at,
    revokedAt: row.revoked_at,
  };
}

async function fetchDeclarationRow(client: Client, declarationId: number): Promise<DeclarationRow | null> {
  const result = await client.execute({
    sql: `SELECT * FROM reuse_context_declarations WHERE id = ?`,
    args: [declarationId],
  });
  return (result.rows[0] as unknown as DeclarationRow) ?? null;
}

/**
 * The account that owns the ORIGINAL submission behind a resolved
 * corpus_submission_references row — resolved fresh from the database every
 * time, never trusted from a caller. Returns null both when the reference
 * itself no longer exists (deletion behavior: representation/reference
 * deletion does not cascade to this table, so a dangling pointer is a real,
 * expected state) and when the underlying identity is anonymous.
 */
async function accountForSubmissionReference(client: Client, submissionReferenceId: number): Promise<string | null> {
  const result = await client.execute({
    sql: `SELECT di.account_id AS account_id
          FROM corpus_submission_references sr
          JOIN document_identities di ON di.id = sr.document_identity_id
          WHERE sr.id = ?`,
    args: [submissionReferenceId],
  });
  const row = result.rows[0] as unknown as { account_id: string | null } | undefined;
  return row ? row.account_id : null;
}

export type DeclareReuseContextResult =
  | { status: "DECLARED"; declaration: ReuseContextDeclarationView }
  | { status: "IDENTITY_NOT_FOUND" }
  | { status: "REPRESENTATION_NOT_FOUND" }
  | { status: "DECLARER_NOT_SUBMISSION_OWNER" }
  | { status: "NO_MATCH_PAIR" }
  | { status: "AMBIGUOUS_MATCH_PAIR" }
  | { status: "SELF_RELATIONSHIP_NOT_DECLARABLE" }
  | { status: "ALREADY_ACTIVE" };

export async function declareReuseContext(
  client: Client,
  params: { documentIdentityId: string; representationId: string; declaredByAccountId: string; declaredContext: DeclaredContext },
): Promise<DeclareReuseContextResult> {
  const identity = await client.execute({
    sql: `SELECT id, account_id FROM document_identities WHERE id = ?`,
    args: [params.documentIdentityId],
  });
  const identityRow = identity.rows[0] as unknown as { id: string; account_id: string | null } | undefined;
  if (!identityRow) return { status: "IDENTITY_NOT_FOUND" };

  const representation = await client.execute({
    sql: `SELECT id FROM corpus_document_representations WHERE id = ?`,
    args: [params.representationId],
  });
  if (representation.rows.length === 0) return { status: "REPRESENTATION_NOT_FOUND" };

  // Security rule: the declarer must be the account that owns the CURRENT
  // submission. An anonymous identity (account_id null) can never declare.
  if (identityRow.account_id === null || identityRow.account_id !== params.declaredByAccountId) {
    return { status: "DECLARER_NOT_SUBMISSION_OWNER" };
  }

  const resolution = await resolveExactMatchPairReference(client, {
    documentIdentityId: params.documentIdentityId,
    representationId: params.representationId,
  });
  if (resolution.ambiguous) return { status: "AMBIGUOUS_MATCH_PAIR" };
  if (resolution.referenceId === null) return { status: "NO_MATCH_PAIR" };

  // SELF is not a declaration (E8S Step 1 §5 / Step 2's own task
  // description) — if the resolved prior reference turns out to belong to
  // the SAME account as the declarer, this is an existing, automatically-
  // computed relationship, not something to authorize. Checked here, not
  // assumed from the caller, using the same resolved reference id.
  const matchedAccountId = await accountForSubmissionReference(client, resolution.referenceId);
  if (matchedAccountId !== null && matchedAccountId === params.declaredByAccountId) {
    return { status: "SELF_RELATIONSHIP_NOT_DECLARABLE" };
  }

  const existingActive = await client.execute({
    sql: `SELECT id FROM reuse_context_declarations
          WHERE document_identity_id = ? AND matched_representation_id = ? AND revoked_at IS NULL`,
    args: [params.documentIdentityId, params.representationId],
  });
  if (existingActive.rows.length > 0) return { status: "ALREADY_ACTIVE" };

  try {
    const inserted = await client.execute({
      sql: `INSERT INTO reuse_context_declarations
            (document_identity_id, matched_representation_id, matched_submission_reference_id, declared_context, declared_by_account_id, declared_at, verification_state, created_at)
            VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,'SELF_ASSERTED_UNVERIFIED',CURRENT_TIMESTAMP)`,
      args: [params.documentIdentityId, params.representationId, resolution.referenceId, params.declaredContext, params.declaredByAccountId],
    });
    const row = await fetchDeclarationRow(client, Number(inserted.lastInsertRowid));
    if (!row) throw new Error("declareReuseContext: row vanished immediately after insert");
    return { status: "DECLARED", declaration: toView(row) };
  } catch (error) {
    // The partial unique index (ux_reuse_context_declarations_active_pair)
    // is the actual authority, not the pre-check above — two genuinely
    // concurrent declare calls for the same pair race here, and exactly one
    // wins. SQLite's own standard error text, not a driver-specific shape.
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      return { status: "ALREADY_ACTIVE" };
    }
    throw error;
  }
}

export type ConfirmReuseContextResult =
  | { status: "CONFIRMED"; declaration: ReuseContextDeclarationView }
  | { status: "ALREADY_CONFIRMED"; declaration: ReuseContextDeclarationView }
  | { status: "NOT_FOUND" }
  | { status: "ALREADY_REVOKED" }
  | { status: "SELF_CONFIRMATION_REJECTED" }
  | { status: "ORIGINAL_SUBMISSION_UNRESOLVABLE" }
  | { status: "NOT_ORIGINAL_SUBMITTER" };

export async function confirmReuseContext(
  client: Client,
  params: { declarationId: number; confirmingAccountId: string },
): Promise<ConfirmReuseContextResult> {
  const row = await fetchDeclarationRow(client, params.declarationId);
  if (!row) return { status: "NOT_FOUND" };
  if (row.revoked_at !== null) return { status: "ALREADY_REVOKED" };
  if (row.verification_state === "MUTUALLY_CONFIRMED") return { status: "ALREADY_CONFIRMED", declaration: toView(row) };

  // Security rule: a declarer can never confirm their own declaration.
  if (row.declared_by_account_id !== null && row.declared_by_account_id === params.confirmingAccountId) {
    return { status: "SELF_CONFIRMATION_REJECTED" };
  }

  if (row.matched_submission_reference_id === null) return { status: "ORIGINAL_SUBMISSION_UNRESOLVABLE" };
  const expectedAccountId = await accountForSubmissionReference(client, Number(row.matched_submission_reference_id));
  if (expectedAccountId === null) return { status: "ORIGINAL_SUBMISSION_UNRESOLVABLE" };
  if (expectedAccountId !== params.confirmingAccountId) return { status: "NOT_ORIGINAL_SUBMITTER" };

  const updated = await client.execute({
    sql: `UPDATE reuse_context_declarations
          SET confirmed_by_account_id = ?, confirmed_at = CURRENT_TIMESTAMP, verification_state = 'MUTUALLY_CONFIRMED'
          WHERE id = ? AND revoked_at IS NULL AND confirmed_at IS NULL`,
    args: [params.confirmingAccountId, params.declarationId],
  });
  if (Number(updated.rowsAffected) === 0) {
    // Lost a race to a concurrent confirm/revoke between the reads above and this write.
    const fresh = await fetchDeclarationRow(client, params.declarationId);
    if (fresh && fresh.revoked_at !== null) return { status: "ALREADY_REVOKED" };
    if (fresh && fresh.verification_state === "MUTUALLY_CONFIRMED") return { status: "ALREADY_CONFIRMED", declaration: toView(fresh) };
    return { status: "NOT_FOUND" };
  }
  const fresh = await fetchDeclarationRow(client, params.declarationId);
  if (!fresh) return { status: "NOT_FOUND" };
  return { status: "CONFIRMED", declaration: toView(fresh) };
}

export type RevokeReuseContextResult =
  | { status: "REVOKED"; declaration: ReuseContextDeclarationView }
  | { status: "NOT_FOUND" }
  | { status: "ALREADY_REVOKED" }
  | { status: "NOT_AUTHORIZED_TO_REVOKE" };

/**
 * Either the declarer, the confirmer (once confirmed), OR the account
 * server-validated as the ORIGINAL submitter behind matched_submission_
 * reference_id may revoke — that third case is what lets the original
 * submitter reject a declaration they never confirmed (E8S Step 5's Flow
 * 5(a)/"reject" — Step 4 as originally built only authorized declared_by/
 * confirmed_by, which left an unconfirmed declaration un-rejectable by the
 * one party it's actually about; this closes that gap). The original-
 * submitter check is resolved fresh from the database every time, never
 * trusted from the caller, exactly like confirmReuseContext's own check.
 * Revoke is always a state change (revoked_at set), never a DELETE.
 */
export async function revokeReuseContext(
  client: Client,
  params: { declarationId: number; revokedByAccountId: string },
): Promise<RevokeReuseContextResult> {
  const row = await fetchDeclarationRow(client, params.declarationId);
  if (!row) return { status: "NOT_FOUND" };
  if (row.revoked_at !== null) return { status: "ALREADY_REVOKED" };

  let authorized = params.revokedByAccountId === row.declared_by_account_id || params.revokedByAccountId === row.confirmed_by_account_id;
  if (!authorized && row.matched_submission_reference_id !== null) {
    const originalAccountId = await accountForSubmissionReference(client, Number(row.matched_submission_reference_id));
    authorized = originalAccountId !== null && originalAccountId === params.revokedByAccountId;
  }
  if (!authorized) return { status: "NOT_AUTHORIZED_TO_REVOKE" };

  const updated = await client.execute({
    sql: `UPDATE reuse_context_declarations
          SET revoked_at = CURRENT_TIMESTAMP, revoked_by_account_id = ?, verification_state = 'REVOKED'
          WHERE id = ? AND revoked_at IS NULL`,
    args: [params.revokedByAccountId, params.declarationId],
  });
  if (Number(updated.rowsAffected) === 0) {
    // Already-revoked by a concurrent caller between the read above and this write.
    return { status: "ALREADY_REVOKED" };
  }
  const fresh = await fetchDeclarationRow(client, params.declarationId);
  if (!fresh) return { status: "NOT_FOUND" };
  return { status: "REVOKED", declaration: toView(fresh) };
}

/** The current (revoked_at IS NULL) declaration for one match pair, or null if none was ever declared or the only one(s) were revoked. */
export async function getActiveReuseContextDeclaration(
  client: Client,
  params: { documentIdentityId: string; representationId: string },
): Promise<ReuseContextDeclarationView | null> {
  const result = await client.execute({
    sql: `SELECT * FROM reuse_context_declarations
          WHERE document_identity_id = ? AND matched_representation_id = ? AND revoked_at IS NULL`,
    args: [params.documentIdentityId, params.representationId],
  });
  const row = result.rows[0] as unknown as DeclarationRow | undefined;
  return row ? toView(row) : null;
}

/** A single declaration by id, regardless of active/revoked state — used by the /reject route to distinguish "reject before ever confirmed" from "revoke an already-confirmed one" before acting, never to bypass any authorization check. */
export async function getReuseContextDeclarationById(client: Client, declarationId: number): Promise<ReuseContextDeclarationView | null> {
  const row = await fetchDeclarationRow(client, declarationId);
  return row ? toView(row) : null;
}

/**
 * E8S Step 6 requirement 1: the reverse lookup that powers the ORIGINAL
 * submitter's confirmation panel (E8S Step 5's Flow 3/4) — "which active
 * declarations reference one of MY submissions?" Resolved via this
 * identity's own corpus_submission_references row(s), the same table
 * accountForSubmissionReference already joins through, never via
 * document_identities.account_id directly (this function never touches
 * users/emails, and the returned rows are the same account-id-free
 * ReuseContextDeclarationView as every other function here). Callers are
 * responsible for verifying the caller's session actually owns
 * documentIdentityId before invoking this — see
 * app/api/reuse-context/pending/route.ts, which is the only place that
 * matters, since the DTO itself leaks nothing even if it didn't.
 *
 * Returns only ACTIVE (revoked_at IS NULL) rows — both SELF_ASSERTED_
 * UNVERIFIED (needs a confirm/reject decision) and MUTUALLY_CONFIRMED (the
 * original submitter's own past confirmation) are included; REVOKED rows
 * are not, matching E8S Step 5's default of no persistent revocation trace.
 */
export async function getDeclarationsReferencingSubmission(
  client: Client,
  params: { documentIdentityId: string },
): Promise<ReuseContextDeclarationView[]> {
  const refs = await client.execute({
    sql: `SELECT id FROM corpus_submission_references WHERE document_identity_id = ?`,
    args: [params.documentIdentityId],
  });
  const referenceIds = (refs.rows as unknown as { id: number | bigint }[]).map((row) => Number(row.id));
  if (referenceIds.length === 0) return [];

  const placeholders = referenceIds.map(() => "?").join(",");
  const result = await client.execute({
    sql: `SELECT * FROM reuse_context_declarations
          WHERE matched_submission_reference_id IN (${placeholders}) AND revoked_at IS NULL
          ORDER BY declared_at DESC`,
    args: referenceIds,
  });
  return (result.rows as unknown as DeclarationRow[]).map(toView);
}

export type CanDeclareReuseContextResult =
  | { canDeclare: true }
  | { canDeclare: false; reason: "IDENTITY_NOT_FOUND" | "REPRESENTATION_NOT_FOUND" | "NOT_SUBMISSION_OWNER" | "NO_MATCH_PAIR" | "AMBIGUOUS" | "SELF_RELATIONSHIP" | "ALREADY_ACTIVE" };

/**
 * E8S Step 6 requirement 3: a pure read-only "would declareReuseContext
 * succeed" check, so the report-render path can decide whether to show the
 * "Add context" affordance at all — E8S Step 5's Flow 8/9 default is to
 * hide the CTA entirely when it would fail (ambiguous, no pair, SELF,
 * already active, not the owner), never render a dead-end button. Performs
 * every check declareReuseContext performs, in the same order, but never
 * writes anything. accountId is the CALLER's own session account id — the
 * caller must never pass another account's id (this function does not,
 * and cannot, verify that; the route layer's session lookup is what makes
 * this safe — see app/api/reuse-context/status/route.ts).
 */
export async function canDeclareReuseContext(
  client: Client,
  params: { documentIdentityId: string; representationId: string; accountId: string | null },
): Promise<CanDeclareReuseContextResult> {
  // A row-existence check first (same as declareReuseContext) is what
  // distinguishes IDENTITY_NOT_FOUND from an anonymous/mismatched-owner
  // identity (NOT_SUBMISSION_OWNER below) — both would read as account_id
  // === null/mismatch if checked from a bare SELECT alone.
  const identityRow = await client.execute({ sql: `SELECT account_id FROM document_identities WHERE id = ?`, args: [params.documentIdentityId] });
  if (identityRow.rows.length === 0) return { canDeclare: false, reason: "IDENTITY_NOT_FOUND" };
  const identityAccountId = (identityRow.rows[0] as unknown as { account_id: string | null }).account_id;

  const representationExists = await client.execute({ sql: `SELECT 1 FROM corpus_document_representations WHERE id = ?`, args: [params.representationId] });
  if (representationExists.rows.length === 0) return { canDeclare: false, reason: "REPRESENTATION_NOT_FOUND" };

  if (params.accountId === null || identityAccountId === null || identityAccountId !== params.accountId) {
    return { canDeclare: false, reason: "NOT_SUBMISSION_OWNER" };
  }

  const resolution = await resolveExactMatchPairReference(client, {
    documentIdentityId: params.documentIdentityId,
    representationId: params.representationId,
  });
  if (resolution.ambiguous) return { canDeclare: false, reason: "AMBIGUOUS" };
  if (resolution.referenceId === null) return { canDeclare: false, reason: "NO_MATCH_PAIR" };

  const matchedAccountId = await accountForSubmissionReference(client, resolution.referenceId);
  if (matchedAccountId !== null && matchedAccountId === params.accountId) {
    return { canDeclare: false, reason: "SELF_RELATIONSHIP" };
  }

  const existingActive = await client.execute({
    sql: `SELECT id FROM reuse_context_declarations
          WHERE document_identity_id = ? AND matched_representation_id = ? AND revoked_at IS NULL`,
    args: [params.documentIdentityId, params.representationId],
  });
  if (existingActive.rows.length > 0) return { canDeclare: false, reason: "ALREADY_ACTIVE" };

  return { canDeclare: true };
}
