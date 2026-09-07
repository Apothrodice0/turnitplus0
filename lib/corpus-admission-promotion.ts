import { randomUUID } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";
import { canonicalSha256 } from "./document-identity";
import type { CorpusAdmissionConnectionFactory } from "./corpus-admission-gate";
import {
  createReusableDocumentRepresentation,
  findReusableRepresentationByCanonicalHash,
  recordCorpusShingles,
  CORPUS_FINGERPRINT_VERSION,
  type LinkType,
} from "./user-submission-corpus";
import { bumpCorpusMatchGeneration } from "./report-historical-match";

/**
 * Promotes an ACCEPTed corpus-admission decision's retained text into the
 * shared plagiarism-matching index (corpus_document_representations /
 * corpus_document_shingles — lib/user-submission-corpus.ts) so a live
 * submission can eventually be matched against it. NOT wired into POST
 * /api/reports, live scoring, or report rendering — see this module's own
 * CORPUS_PROMOTION_ENABLED gate and lib/user-submission-matching.ts's own
 * "not wired in yet" header comment, which this module does not change.
 *
 * Deliberately never touches corpus_submission_references (the ONLY place
 * account linkage exists in the shared index — see
 * lib/user-submission-corpus.ts's indexDocumentSubmissionIntoCorpus, which
 * this module intentionally does not call): a promoted representation is
 * never linked to a document_identity_id, so it can never resolve to an
 * account through anything downstream (findSubmissionReferencesForAccount,
 * summarizeSubmissionOwnership, etc. all stay structurally blind to it, the
 * same way they are already structurally blind to every other
 * representation). This module also never imports document-identity.ts's
 * account-shaped helpers, users, or corpus_admission_report_jobs' own
 * account_id/device_key/report_id columns — decision_id and
 * accepted_representation_id (both opaque, admin-domain-only ids) are the
 * only linkage it ever stores.
 *
 * Discovery + atomic-claim sweep shape mirrors
 * lib/corpus-admission-report-integration.ts's runReportAdmissionRetrySweep
 * exactly (fresh connection per SQLITE_BUSY retry, one real write
 * transaction for the claim). One durable job row per decision
 * (corpus_admission_promotions, drizzle/0034) is created lazily by the sweep
 * itself — there is deliberately no synchronous hook anywhere in
 * lib/corpus-admission-gate.ts, which keeps that module's own structural
 * privacy guarantee (tests/corpus-admission-privacy.test.mjs: it never
 * mentions the real corpus's write functions) intact without this module
 * needing to be an exception to it.
 *
 * Eligibility for live matching is NOT tracked by a column on this table —
 * see lib/user-submission-corpus.ts's findCandidateCorpusRepresentations for
 * why: a representation can be promoted by more than one decision (an exact
 * canonical duplicate), or already exist because a real user submission
 * created it first, so "is this decision's own accepted_representation
 * active" is never the right question. That function instead checks, for
 * each candidate representation, whether ANY source currently backs it (a
 * real submission reference, OR at least one 'indexed' promotion whose own
 * accepted_representation is not revoked). Deactivating one decision's
 * fingerprint therefore only ever removes ONE vote, never the
 * representation's eligibility outright — admin
 * deactivate/reactivate (lib/corpus-admission-admin-actions.ts) need no
 * changes at all for this to stay correct, since they already do nothing
 * but flip corpus_admission_accepted_representations.revoked_at, which is
 * exactly the column that join reads live.
 */

export function isCorpusPromotionEnabled(): boolean {
  return process.env.CORPUS_PROMOTION_ENABLED === "true";
}

export type CorpusAdmissionPromotionStatus = "staged" | "indexed" | "failed" | "skipped" | "dead_lettered";

/**
 * B1C: the one place "how many completed processing attempts before we stop
 * retrying" is defined — no CHECK constraint backs this (drizzle/0034 has
 * none), so this is the sole source of truth for the cap, read by both the
 * claim queries (excluding an at-or-past-cap 'failed' row from being
 * claimed again) and recordPromotionProcessingFailure (deciding 'failed' vs
 * 'dead_lettered' on each completed failure). attempt_count keeps its
 * pre-existing meaning unchanged (see indexPromotionAtomically's own
 * success-path increment): completed processing attempts, including the
 * initial automatic one — never bumped merely by claiming, only by a
 * terminal write, so a crash between claim and terminal write still costs
 * no attempt (recovered by the existing stale-claim timeout, unchanged).
 * 5 total attempts (the initial automatic one plus up to 4 daily-sweep
 * retries, since the promotion sweep's own cron runs once a day —
 * vercel.json) is a deliberately small, bounded number; no next_retry_at
 * column or backoff timing was added because the daily cron cadence is
 * already the backoff.
 */
export const MAX_PROMOTION_ATTEMPTS = 5;

type PromotionRow = {
  id: string;
  decisionId: string;
  acceptedRepresentationId: string;
  status: CorpusAdmissionPromotionStatus;
  /** Set only once status='indexed' — see the migration's own schema comment. Read here so processCorpusAdmissionPromotion's own terminal-idempotency guard can reconstruct an already-'indexed' outcome without a second query. */
  representationId: string | null;
  linkType: LinkType | null;
  lastError: string | null;
  /** B1C: read here so the dead_lettered branch of the terminal-idempotency guard can report it without a second query, matching the indexed/skipped branches' own existing shape. */
  attemptCount: number;
};

type RawPromotionRow = {
  id: string;
  decision_id: string;
  accepted_representation_id: string;
  status: string;
  representation_id: string | null;
  link_type: string | null;
  last_error: string | null;
  attempt_count: number | bigint;
};

function toPromotionRow(row: RawPromotionRow): PromotionRow {
  return {
    id: row.id,
    decisionId: row.decision_id,
    acceptedRepresentationId: row.accepted_representation_id,
    status: row.status as CorpusAdmissionPromotionStatus,
    representationId: row.representation_id,
    linkType: row.link_type as LinkType | null,
    lastError: row.last_error,
    attemptCount: Number(row.attempt_count),
  };
}

async function fetchPromotionById(client: Client, promotionId: string): Promise<PromotionRow | null> {
  const result = await client.execute({
    sql: "SELECT id, decision_id, accepted_representation_id, status, representation_id, link_type, last_error, attempt_count FROM corpus_admission_promotions WHERE id = ?",
    args: [promotionId],
  });
  const row = result.rows[0] as unknown as RawPromotionRow | undefined;
  return row ? toPromotionRow(row) : null;
}

const MAX_PROMOTION_BUSY_RETRIES = 10;
function promotionBackoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20 * attempt + Math.floor(Math.random() * 30)));
}
function isSqliteBusyError(err: unknown): boolean {
  return err instanceof Error && /SQLITE_BUSY/i.test(err.message);
}
function isCanonicalHashUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    /SQLITE_CONSTRAINT/i.test(err.message) &&
    /ux_corpus_document_representations_canonical_sha256|corpus_document_representations\.canonical_sha256/i.test(err.message)
  );
}

/** Returns the executed statement's own ResultSet (needed by recordPromotionProcessingFailure's RETURNING read) — every existing caller that only needed the write to land simply discards it, unchanged. */
async function executePromotionWriteWithRetry(openConnection: CorpusAdmissionConnectionFactory, stmt: InStatement): Promise<Awaited<ReturnType<Client["execute"]>>> {
  for (let attempt = 1; attempt <= MAX_PROMOTION_BUSY_RETRIES; attempt += 1) {
    const attemptClient = await openConnection();
    try {
      return await attemptClient.execute(stmt);
    } catch (err) {
      if (isSqliteBusyError(err) && attempt < MAX_PROMOTION_BUSY_RETRIES) {
        await promotionBackoff(attempt);
        continue;
      }
      throw err;
    } finally {
      attemptClient.close();
    }
  }
  throw new Error("executePromotionWriteWithRetry: exhausted retries without resolving");
}

export type PromotionFailureOutcome = { status: "failed" | "dead_lettered"; attemptCount: number };

/**
 * B1C: the single place a completed processing failure is ever recorded —
 * every failure branch in processCorpusAdmissionPromotion below calls this
 * instead of writing its own UPDATE, so "attempt_count + 1 >= MAX ?
 * dead_lettered : failed" can never drift out of sync between them. One
 * atomic UPDATE ... RETURNING (same idiom lib/rate-limit.ts's checkBucket
 * already uses for this exact reason: a CASE result written to its own
 * column and then RETURNED always reflects exactly what was just written,
 * with no ambiguity about which branch fired) does all of:
 *   - increments attempt_count exactly once;
 *   - decides 'failed' vs 'dead_lettered' from the RESULTING count (>= MAX_PROMOTION_ATTEMPTS),
 *     not the count read before this call — a single expression, not a
 *     read-then-write race;
 *   - clears claimed_at (this attempt has concluded, whichever way);
 *   - overwrites last_error with the actual final error (never a stale
 *     earlier one — this IS the final error for a dead-lettering write, and
 *     the most recent one for an ordinary 'failed' write, same as before);
 *   - bumps updated_at.
 * Never called for the initial claim, never for the 'skipped' outcome
 * (permanent-inapplicability is not a processing failure and keeps its own
 * unchanged inline UPDATE) — only for the three genuine-failure branches
 * below.
 */
async function recordPromotionProcessingFailure(
  openConnection: CorpusAdmissionConnectionFactory,
  promotionId: string,
  message: string,
): Promise<PromotionFailureOutcome> {
  const result = await executePromotionWriteWithRetry(openConnection, {
    sql: `UPDATE corpus_admission_promotions
          SET attempt_count = attempt_count + 1,
              status = CASE WHEN attempt_count + 1 >= ? THEN 'dead_lettered' ELSE 'failed' END,
              claimed_at = NULL, last_error = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
          RETURNING status, attempt_count`,
    args: [MAX_PROMOTION_ATTEMPTS, message, promotionId],
  });
  const row = result.rows[0] as unknown as { status: string; attempt_count: number | bigint };
  return { status: row.status as "failed" | "dead_lettered", attemptCount: Number(row.attempt_count) };
}

/**
 * The exact staging INSERT — the one place "what does a freshly-staged
 * corpus_admission_promotions row look like" is defined. Shared by
 * stageCorpusAdmissionPromotionForDecision (below) and
 * runCorpusAdmissionPromotionSweep's own batch discovery step, so the
 * immediate post-ACCEPT path and the sweep's own recovery path can never
 * define "staged" differently. ux_corpus_admission_promotions_decision_id
 * (drizzle/0034) is a real unique index, not merely the NOT EXISTS the
 * sweep's own discovery SELECT also happens to use — OR IGNORE here relies
 * on that index directly, so two concurrent staging attempts for the same
 * decision (this function called twice at once, a caller racing the
 * sweep's own discovery, or two sweep ticks racing each other) converge on
 * exactly one row.
 */
function buildStagePromotionInsertStatement(decisionId: string, acceptedRepresentationId: string): InStatement {
  return {
    sql: `INSERT OR IGNORE INTO corpus_admission_promotions (id, decision_id, accepted_representation_id, status, attempt_count, created_at, updated_at)
          VALUES (?,?,?,'staged',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [randomUUID(), decisionId, acceptedRepresentationId],
  };
}

/**
 * Idempotently ensures exactly one corpus_admission_promotions row exists
 * for this ACCEPT decision, staging it if none exists yet — the
 * single-decision analogue of runCorpusAdmissionPromotionSweep's own batch
 * discovery, sharing the exact same INSERT (buildStagePromotionInsertStatement)
 * so the two can never drift into staging different shapes.
 *
 * The fix for "ACCEPT relies exclusively on the scheduled sweep": called
 * synchronously, immediately after an ACCEPT decision's accepted
 * representation/content has committed
 * (lib/corpus-admission-report-integration.ts's processReportAdmissionJob),
 * so a decision no longer has to wait for the next scheduled sweep tick to
 * even be discovered. The sweep's own discovery step is intentionally left
 * as-is (still one batched multi-row INSERT inside its own transaction,
 * sharing only the statement shape, not this function's own extra
 * roundtrips) — it remains the recovery/retry path for anything this
 * synchronous call missed or failed to stage (a transient error here, a
 * request that crashed before reaching this point, CORPUS_PROMOTION_ENABLED
 * having been off at ACCEPT time and flipped on later).
 *
 * Returns the existing OR newly-created promotion id — a caller never needs
 * to distinguish "was already staged" from "just staged it," matching
 * createPendingReportAdmissionJob's own "ensure the row exists" idiom.
 * Returns null (never throws for this reason) when decisionId does not
 * currently resolve to an eligible ACCEPT with a committed accepted
 * representation — defensive: a caller that just confirmed ACCEPT status
 * itself should never actually observe this, but this function does not
 * assume that and re-derives eligibility from the database itself rather
 * than trusting a caller-supplied flag.
 */
export async function stageCorpusAdmissionPromotionForDecision(client: Client, decisionId: string): Promise<string | null> {
  const existing = await client.execute({ sql: "SELECT id FROM corpus_admission_promotions WHERE decision_id = ?", args: [decisionId] });
  const existingRow = existing.rows[0] as unknown as { id: string } | undefined;
  if (existingRow) return existingRow.id;

  const acceptedRepResult = await client.execute({
    sql: `SELECT ar.id AS accepted_representation_id
          FROM corpus_admission_decisions d
          JOIN corpus_admission_accepted_representations ar ON ar.decision_id = d.id
          WHERE d.decision = 'ACCEPT' AND d.id = ?`,
    args: [decisionId],
  });
  const acceptedRep = acceptedRepResult.rows[0] as unknown as { accepted_representation_id: string } | undefined;
  if (!acceptedRep) return null;

  await client.execute(buildStagePromotionInsertStatement(decisionId, acceptedRep.accepted_representation_id));

  // Re-read rather than trust the id just generated: OR IGNORE means a
  // concurrent staging attempt for the same decision may have won the
  // unique-index race instead — this returns whichever row actually exists
  // now, exactly like createPendingReportAdmissionJob's own re-fetch after
  // its own ON CONFLICT DO NOTHING insert.
  const finalRow = await client.execute({ sql: "SELECT id FROM corpus_admission_promotions WHERE decision_id = ?", args: [decisionId] });
  const row = finalRow.rows[0] as unknown as { id: string } | undefined;
  return row ? row.id : null;
}

export type StageAndClaimPromotionResult =
  | { staged: false; claimed: false; promotionId: null }
  | { staged: true; promotionId: string; claimed: boolean };

const DEFAULT_STALE_CLAIM_MS = 5 * 60 * 1000;

/**
 * The claim-safety fix: single-owner claim semantics for the immediate,
 * automatic-promotion path — the exact same predicate
 * runCorpusAdmissionPromotionSweep's own claim step already uses (status =
 * 'staged', or 'failed' with attempt_count still under MAX_PROMOTION_ATTEMPTS
 * (B1C — an at-or-past-cap 'failed' row is not claimable here either; the
 * sweep's own normalization step is what moves it to 'dead_lettered'), AND
 * (claimed_at IS NULL OR claimed_at < stale threshold)), applied to one
 * specific row instead of a batch.
 *
 * Stages first (via stageCorpusAdmissionPromotionForDecision — idempotent,
 * unchanged), then attempts to claim that SAME row with a single
 * conditional UPDATE. A single UPDATE statement is its own atomic unit in
 * SQLite (no explicit transaction needed for this one check-and-set): if a
 * concurrent claimant (a racing sweep tick, or another immediate-promotion
 * call for the same decision) already claimed it first, this UPDATE's own
 * WHERE clause no longer matches (claimed_at is now fresh, non-stale) and
 * affects zero rows — `claimed` comes back false, telling the caller not to
 * process. Whichever caller's UPDATE actually lands first wins; the loser
 * never processes, so the same promotion can never be indexed twice
 * concurrently by two different callers.
 *
 * A promotion already 'indexed', 'skipped', or 'dead_lettered' can never be
 * claimed here — `claimed` comes back false for those too, which is exactly
 * "already terminal, do not process again," the other half of this fix (see
 * processCorpusAdmissionPromotion's own defensive terminal-idempotency guard
 * for the second layer of this same guarantee).
 *
 * Takes openConnection, not a plain client, and retries with a genuinely
 * fresh connection on SQLITE_BUSY (the same MAX_PROMOTION_BUSY_RETRIES/
 * promotionBackoff every other write in this module already uses) —
 * confirmed necessary by this fix's own regression test, not merely
 * consistent-for-its-own-sake: this function is EXPECTED to genuinely race
 * the sweep's own claim transaction under real concurrent load (that IS the
 * scenario this fix exists for), and retrying on the SAME connection does
 * not reliably recover from SQLITE_BUSY once a transaction elsewhere is
 * actually holding the write lock — this codebase's own established,
 * empirically-confirmed finding (see e.g. acceptWithAtomicDedupCriticalSection's
 * own header comment in lib/corpus-admission-gate.ts).
 */
export async function stageAndClaimCorpusAdmissionPromotionForDecision(
  openConnection: CorpusAdmissionConnectionFactory,
  decisionId: string,
  staleClaimMs: number = DEFAULT_STALE_CLAIM_MS,
): Promise<StageAndClaimPromotionResult> {
  const staleClaimSeconds = Math.max(1, Math.floor(staleClaimMs / 1000));
  for (let attempt = 1; attempt <= MAX_PROMOTION_BUSY_RETRIES; attempt += 1) {
    const attemptClient = await openConnection();
    try {
      const promotionId = await stageCorpusAdmissionPromotionForDecision(attemptClient, decisionId);
      if (!promotionId) return { staged: false, claimed: false, promotionId: null };

      const claimResult = await attemptClient.execute({
        sql: `UPDATE corpus_admission_promotions
              SET claimed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND (status = 'staged' OR (status = 'failed' AND attempt_count < ?))
                AND (claimed_at IS NULL OR claimed_at < datetime('now', ?))`,
        args: [promotionId, MAX_PROMOTION_ATTEMPTS, `-${staleClaimSeconds} seconds`],
      });
      return { staged: true, promotionId, claimed: Number(claimResult.rowsAffected) > 0 };
    } catch (err) {
      if (isSqliteBusyError(err) && attempt < MAX_PROMOTION_BUSY_RETRIES) {
        await promotionBackoff(attempt);
        continue;
      }
      throw err;
    } finally {
      attemptClient.close();
    }
  }
  throw new Error("stageAndClaimCorpusAdmissionPromotionForDecision: exhausted retries without resolving");
}

type IndexedResult = { representationId: string; linkType: LinkType; fingerprintVersion: string };

/**
 * Representation find-or-create, shingle insertion, and the promotion row's
 * own success write all happen inside ONE real write transaction — they
 * commit together or not at all, so a crash or a losing race never leaves a
 * representation indexed without its shingles, or shingles without the
 * promotion row ever recording it.
 *
 * findReusableRepresentationByCanonicalHash is checked first, INSIDE the
 * transaction (closes almost all of the race window), but
 * corpus_document_representations.canonical_sha256 carries a real UNIQUE
 * index as the authoritative cross-process backstop — the same idiom
 * lib/corpus-admission-gate.ts's own acceptWithAtomicDedupCriticalSection
 * uses for corpus_admission_accepted_representations. It differs in what
 * losing the race means, though: that function's loser gets a genuinely
 * different outcome (a REJECT decision referencing the winner). Here, the
 * desired end state is IDENTICAL whether this attempt created the
 * representation or lost the race to another process (this decision's
 * promotion succeeds, referencing whichever representation ended up
 * canonical) — so losing the race just retries the whole attempt
 * immediately (no backoff; this is a resolved race, not lock contention),
 * and the next attempt's own pre-check finds the winner's now-committed row
 * and proceeds normally as an EXACT_CANONICAL_DUPLICATE, inside one clean
 * transaction.
 *
 * simulateFailureAfterShingles is test-only fault injection (mirrors
 * tests/ingest.unit.test.mjs's own simulateFailureAfterChunkIndex on
 * ingestDocument) — throws AFTER the representation and its shingles are
 * both written but BEFORE the promotions-row success write and commit, so a
 * test can prove the whole transaction — representation, shingles, AND the
 * promotions row's own status — rolls back together, not just that a
 * uniqueness-race retry resolves cleanly (a different, earlier-stage
 * scenario that alone does not exercise this rollback path). Always
 * undefined/falsy in production.
 */
async function indexPromotionAtomically(
  openConnection: CorpusAdmissionConnectionFactory,
  params: { promotionId: string; canonicalText: string; canonicalHash: string; simulateFailureAfterShingles?: boolean },
): Promise<IndexedResult> {
  for (let attempt = 1; attempt <= MAX_PROMOTION_BUSY_RETRIES; attempt += 1) {
    const activeClient = await openConnection();
    let tx: Awaited<ReturnType<Client["transaction"]>> | undefined;
    try {
      tx = await activeClient.transaction("write");
    } catch (err) {
      activeClient.close();
      if (isSqliteBusyError(err) && attempt < MAX_PROMOTION_BUSY_RETRIES) {
        await promotionBackoff(attempt);
        continue;
      }
      throw err;
    }

    try {
      // lib/user-submission-corpus.ts's helpers are typed for the full
      // Client interface (migrate/transaction/sync/... included), which
      // Transaction structurally lacks even though it has every method
      // these three functions actually call (execute/batch) — same
      // Client-vs-Transaction mismatch lib/corpus-admission-gate.ts's own
      // SqlExecutor type exists to route around for ITS OWN local
      // functions. Reusing these existing, already-tested primitives as-is
      // (rather than widening their exported signatures, which would ripple
      // into every other caller) is worth one narrow, contained cast here.
      const asClient = tx as unknown as Client;
      const existing = await findReusableRepresentationByCanonicalHash(asClient, params.canonicalHash);
      let representationId: string;
      let linkType: LinkType;
      if (existing) {
        representationId = existing.id;
        linkType = "EXACT_CANONICAL_DUPLICATE";
      } else {
        const created = await createReusableDocumentRepresentation(asClient, { canonicalText: params.canonicalText });
        representationId = created.id;
        linkType = "NEW_CONTENT_REPRESENTATION";
      }

      await recordCorpusShingles(asClient, representationId, params.canonicalText, CORPUS_FINGERPRINT_VERSION);

      if (params.simulateFailureAfterShingles) {
        throw new Error("Simulated failure after representation creation and shingle insertion (test-only fault injection)");
      }

      await tx.execute({
        sql: `UPDATE corpus_admission_promotions
              SET representation_id = ?, link_type = ?, fingerprint_version = ?, status = 'indexed',
                  claimed_at = NULL, last_error = NULL, attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`,
        args: [representationId, linkType, CORPUS_FINGERPRINT_VERSION, params.promotionId],
      });

      // Cache invalidation, same transaction — a GLOBAL generation bump,
      // deliberately not a targeted per-representation delete: newly
      // eligible content (this is exactly that, new or reused
      // representation alike) can match a report whose cached snapshot
      // doesn't reference this representation AT ALL yet, which a search
      // over stored rows could never discover. See
      // lib/report-historical-match.ts's own header comment.
      await bumpCorpusMatchGeneration(tx);

      await tx.commit();
      return { representationId, linkType, fingerprintVersion: CORPUS_FINGERPRINT_VERSION };
    } catch (err) {
      await tx.rollback().catch(() => {});

      if (isCanonicalHashUniqueViolation(err)) {
        continue;
      }
      if (isSqliteBusyError(err) && attempt < MAX_PROMOTION_BUSY_RETRIES) {
        await promotionBackoff(attempt);
        continue;
      }
      throw err;
    } finally {
      tx?.close();
      activeClient.close();
    }
  }
  throw new Error("indexPromotionAtomically: exhausted retries without resolving");
}

export type CorpusAdmissionPromotionOutcome =
  | { outcome: "indexed"; promotionId: string; decisionId: string; representationId: string; linkType: LinkType }
  | { outcome: "skipped"; promotionId: string; decisionId: string; reason: string }
  | { outcome: "failed"; promotionId: string; decisionId: string; error: string; attemptCount: number }
  | { outcome: "dead_lettered"; promotionId: string; decisionId: string; error: string; attemptCount: number };

export type ProcessCorpusAdmissionPromotionParams = {
  promotionId: string;
  openConnection: CorpusAdmissionConnectionFactory;
  /** Test-only fault injection, forwarded to indexPromotionAtomically — see that function's own header comment. Always undefined in production. */
  simulateFailureAfterShingles?: boolean;
};

/**
 * Processes ONE already-claimed promotion row. Every terminal write
 * (indexed/skipped/failed/dead_lettered) goes through
 * executePromotionWriteWithRetry (the last two exclusively via
 * recordPromotionProcessingFailure), its own fresh-connection SQLITE_BUSY
 * retry — mirrors lib/corpus-admission-report-integration.ts's
 * processReportAdmissionJob exactly, including "one status write per real
 * attempt, whichever outcome it was." 'dead_lettered' is not a distinct
 * outcome path of its own here; it is simply what recordPromotionProcessingFailure
 * writes instead of 'failed' once the resulting attempt_count reaches
 * MAX_PROMOTION_ATTEMPTS (B1C) — every genuine-failure branch below is
 * eligible to produce it.
 */
export async function processCorpusAdmissionPromotion(client: Client, params: ProcessCorpusAdmissionPromotionParams): Promise<CorpusAdmissionPromotionOutcome> {
  const promotion = await fetchPromotionById(client, params.promotionId);
  if (!promotion) {
    throw new Error(`processCorpusAdmissionPromotion: no corpus_admission_promotions row for id ${params.promotionId}`);
  }

  // Defensive terminal-idempotency (claim-safety fix): the PRIMARY defense
  // against double-processing is the claim itself
  // (stageAndClaimCorpusAdmissionPromotionForDecision / the sweep's own
  // claim query) — a caller that does not own the claim should never reach
  // this function with an id that is already terminal. This is a SECOND,
  // independent layer that makes the function itself safe even when called
  // directly (every existing sweep/test call site still does, unclaimed),
  // so that re-processing an already-'indexed', already-'skipped', or
  // already-'dead_lettered' row — however it happened — can never re-run
  // indexPromotionAtomically or recordPromotionProcessingFailure, which
  // would otherwise double-increment attempt_count, double-bump
  // corpus_match_generation, or overwrite a dead-lettered row's final
  // last_error for what is logically a single completed attempt (B1C:
  // "direct processing of dead-lettered is idempotent" — no indexing, no
  // attempt/generation change, no last_error change). 'staged' and 'failed'
  // (below MAX_PROMOTION_ATTEMPTS) are the only retryable statuses and fall
  // through to the normal processing below, unchanged.
  if (promotion.status === "indexed" && promotion.representationId && promotion.linkType) {
    return { outcome: "indexed", promotionId: promotion.id, decisionId: promotion.decisionId, representationId: promotion.representationId, linkType: promotion.linkType };
  }
  if (promotion.status === "skipped") {
    return { outcome: "skipped", promotionId: promotion.id, decisionId: promotion.decisionId, reason: promotion.lastError ?? "previously skipped (no error message recorded)" };
  }
  if (promotion.status === "dead_lettered") {
    return { outcome: "dead_lettered", promotionId: promotion.id, decisionId: promotion.decisionId, error: promotion.lastError ?? "previously dead-lettered (no error message recorded)", attemptCount: promotion.attemptCount };
  }

  const decisionResult = await client.execute({ sql: "SELECT decision FROM corpus_admission_decisions WHERE id = ?", args: [promotion.decisionId] });
  const decisionRow = decisionResult.rows[0] as unknown as { decision: string } | undefined;
  if (!decisionRow || decisionRow.decision !== "ACCEPT") {
    // Invariant violation, not an expected outcome (the sweep only ever
    // creates a promotions row for a decision it just confirmed is ACCEPT)
    // — recorded as 'failed' (or 'dead_lettered' at the cap) rather than
    // thrown uncaught, so it surfaces visibly in the admin dashboard's
    // last-error column for investigation instead of crashing the whole
    // sweep batch over one bad row. B1C: routed through
    // recordPromotionProcessingFailure, the single place that decides
    // 'failed' vs 'dead_lettered' — see that function's own comment.
    const message = `decision ${promotion.decisionId} is not an ACCEPT (found: ${decisionRow?.decision ?? "missing"}) — a corpus_admission_promotions row should never exist for a non-ACCEPT decision`;
    const failure = await recordPromotionProcessingFailure(params.openConnection, promotion.id, message);
    return { outcome: failure.status, promotionId: promotion.id, decisionId: promotion.decisionId, error: message, attemptCount: failure.attemptCount };
  }

  const acceptedRepResult = await client.execute({ sql: "SELECT canonical_sha256 FROM corpus_admission_accepted_representations WHERE id = ?", args: [promotion.acceptedRepresentationId] });
  const acceptedRep = acceptedRepResult.rows[0] as unknown as { canonical_sha256: string } | undefined;
  if (!acceptedRep) {
    const message = `no corpus_admission_accepted_representations row for id ${promotion.acceptedRepresentationId} (decision ${promotion.decisionId})`;
    const failure = await recordPromotionProcessingFailure(params.openConnection, promotion.id, message);
    return { outcome: failure.status, promotionId: promotion.id, decisionId: promotion.decisionId, error: message, attemptCount: failure.attemptCount };
  }

  const contentResult = await client.execute({ sql: "SELECT canonical_text FROM corpus_admission_content_store WHERE decision_id = ?", args: [promotion.decisionId] });
  const contentRow = contentResult.rows[0] as unknown as { canonical_text: string } | undefined;
  if (!contentRow) {
    // Permanent, not transient — some ACCEPTs never get retained text (the
    // retention basis didn't apply). 'skipped' is a terminal status the
    // sweep's own claim query excludes, unlike 'failed'.
    const message = "no retained text exists for this accepted decision — nothing to index";
    await executePromotionWriteWithRetry(params.openConnection, {
      sql: "UPDATE corpus_admission_promotions SET status = 'skipped', claimed_at = NULL, last_error = ?, attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [message, promotion.id],
    });
    return { outcome: "skipped", promotionId: promotion.id, decisionId: promotion.decisionId, reason: message };
  }

  try {
    const computedHash = canonicalSha256(contentRow.canonical_text);
    if (computedHash !== acceptedRep.canonical_sha256) {
      throw new Error(
        `retained text's canonical hash (${computedHash}) does not match corpus_admission_accepted_representations.canonical_sha256 (${acceptedRep.canonical_sha256}) for decision ${promotion.decisionId} — refusing to index mismatched text`,
      );
    }

    const { representationId, linkType } = await indexPromotionAtomically(params.openConnection, {
      promotionId: promotion.id,
      canonicalText: contentRow.canonical_text,
      canonicalHash: computedHash,
      simulateFailureAfterShingles: params.simulateFailureAfterShingles,
    });
    return { outcome: "indexed", promotionId: promotion.id, decisionId: promotion.decisionId, representationId, linkType };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failure = await recordPromotionProcessingFailure(params.openConnection, promotion.id, message);
    return { outcome: failure.status, promotionId: promotion.id, decisionId: promotion.decisionId, error: message, attemptCount: failure.attemptCount };
  }
}

export type RunCorpusAdmissionPromotionSweepParams = {
  openConnection: CorpusAdmissionConnectionFactory;
  batchSize?: number;
  /** A claim older than this is considered abandoned and reclaimable. Default 5 minutes — mirrors runReportAdmissionRetrySweep's own default. */
  staleClaimMs?: number;
};

export type RunCorpusAdmissionPromotionSweepResult = {
  claimedPromotionIds: string[];
  results: CorpusAdmissionPromotionOutcome[];
};

/**
 * One sweep tick, three things inside a single atomic write transaction:
 *   1. Discover — INSERT OR IGNORE a 'staged' promotions row for every
 *      ACCEPT decision that doesn't have one yet (bounded by batchSize).
 *      This is the only place a promotions row is ever created; there is no
 *      synchronous hook elsewhere (see this module's own header comment).
 *   2. Normalize (B1C) — every 'failed' row already AT OR PAST
 *      MAX_PROMOTION_ATTEMPTS, that is not currently held by a fresh claim
 *      (same claimed_at IS NULL OR claimed_at < stale-threshold test the
 *      claim step below uses — a row actively being worked by another
 *      process right now must never be stolen out from under it merely
 *      because its count already sits at the cap), transitions straight to
 *      'dead_lettered' — WITHOUT re-running indexPromotionAtomically,
 *      WITHOUT incrementing attempt_count again, and WITHOUT touching
 *      last_error (the existing final error is preserved as-is). This is
 *      the safety net for a legacy row that reached 'failed' at
 *      attempt_count >= MAX_PROMOTION_ATTEMPTS before this cap existed (or,
 *      in principle, any row that otherwise ended up in that shape) — it
 *      can never be silently stranded retryable-forever, but it also never
 *      gets a phantom extra processing attempt just for being normalized.
 *      Runs BEFORE the claim step so a just-normalized row can never also
 *      be claimed in the same tick.
 *   3. Claim — same atomic-claim shape as runReportAdmissionRetrySweep:
 *      status = 'staged', or 'failed' with attempt_count still under
 *      MAX_PROMOTION_ATTEMPTS (step 2 above already moved every over-cap,
 *      non-fresh-claimed row out of 'failed', but this condition is kept
 *      here too as its own independent guarantee — see B1C's own "Claim
 *      rules" requirement), unclaimed or stale-claimed, claimed_at stamped
 *      inside the same transaction so no concurrent sweep can select the
 *      same rows before this one commits.
 * Claimed rows are then processed one at a time via
 * processCorpusAdmissionPromotion on the plain `client` passed in, exactly
 * like the report-admission sweep's own reasoning for keeping claim and
 * processing separate steps.
 */
export async function runCorpusAdmissionPromotionSweep(client: Client, params: RunCorpusAdmissionPromotionSweepParams): Promise<RunCorpusAdmissionPromotionSweepResult> {
  const batchSize = params.batchSize ?? 20;
  const staleClaimMs = params.staleClaimMs ?? 5 * 60 * 1000;
  const staleClaimSeconds = Math.max(1, Math.floor(staleClaimMs / 1000));

  let claimedPromotionIds: string[] = [];
  for (let attempt = 1; attempt <= MAX_PROMOTION_BUSY_RETRIES; attempt += 1) {
    const attemptClient = await params.openConnection();
    try {
      const tx = await attemptClient.transaction("write");
      try {
        const discovered = await tx.execute({
          sql: `SELECT d.id AS decision_id, ar.id AS accepted_representation_id
                FROM corpus_admission_decisions d
                JOIN corpus_admission_accepted_representations ar ON ar.decision_id = d.id
                WHERE d.decision = 'ACCEPT'
                  AND NOT EXISTS (SELECT 1 FROM corpus_admission_promotions p WHERE p.decision_id = d.id)
                LIMIT ?`,
          args: [batchSize],
        });
        const newRows = discovered.rows as unknown as { decision_id: string; accepted_representation_id: string }[];
        if (newRows.length > 0) {
          // Same staging INSERT stageCorpusAdmissionPromotionForDecision's
          // own single-row path uses (buildStagePromotionInsertStatement) —
          // reused here as a batch via tx.batch, not a loop, so this step's
          // existing roundtrip/performance characteristics are unchanged.
          const statements = newRows.map((row) => buildStagePromotionInsertStatement(row.decision_id, row.accepted_representation_id));
          await tx.batch(statements);
        }

        // Step 2 (B1C): normalize legacy/stranded over-cap 'failed' rows to
        // 'dead_lettered' — see this function's own header comment. Only
        // unclaimed-or-stale rows qualify, the identical predicate the
        // claim step below uses, so a freshly claimed in-flight row (however
        // it got to attempt_count >= MAX_PROMOTION_ATTEMPTS) is never
        // touched here.
        await tx.execute({
          sql: `UPDATE corpus_admission_promotions
                SET status = 'dead_lettered', claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
                WHERE status = 'failed' AND attempt_count >= ?
                  AND (claimed_at IS NULL OR claimed_at < datetime('now', ?))`,
          args: [MAX_PROMOTION_ATTEMPTS, `-${staleClaimSeconds} seconds`],
        });

        const candidates = await tx.execute({
          sql: `SELECT id FROM corpus_admission_promotions
                WHERE (status = 'staged' OR (status = 'failed' AND attempt_count < ?))
                  AND (claimed_at IS NULL OR claimed_at < datetime('now', ?))
                ORDER BY updated_at ASC LIMIT ?`,
          args: [MAX_PROMOTION_ATTEMPTS, `-${staleClaimSeconds} seconds`, batchSize],
        });
        const ids = (candidates.rows as unknown as { id: string }[]).map((r) => r.id);
        if (ids.length > 0) {
          const placeholders = ids.map(() => "?").join(",");
          await tx.execute({
            sql: `UPDATE corpus_admission_promotions SET claimed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
            args: ids,
          });
        }
        await tx.commit();
        claimedPromotionIds = ids;
        break;
      } catch (err) {
        await tx.rollback().catch(() => {});
        throw err;
      } finally {
        tx.close();
      }
    } catch (err) {
      if (isSqliteBusyError(err) && attempt < MAX_PROMOTION_BUSY_RETRIES) {
        await promotionBackoff(attempt);
        continue;
      }
      throw err;
    } finally {
      attemptClient.close();
    }
  }

  const results: CorpusAdmissionPromotionOutcome[] = [];
  for (const promotionId of claimedPromotionIds) {
    results.push(await processCorpusAdmissionPromotion(client, { promotionId, openConnection: params.openConnection }));
  }
  return { claimedPromotionIds, results };
}
