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

export type CorpusAdmissionPromotionStatus = "staged" | "indexed" | "failed" | "skipped";

type PromotionRow = {
  id: string;
  decisionId: string;
  acceptedRepresentationId: string;
  status: CorpusAdmissionPromotionStatus;
};

type RawPromotionRow = {
  id: string;
  decision_id: string;
  accepted_representation_id: string;
  status: string;
};

function toPromotionRow(row: RawPromotionRow): PromotionRow {
  return { id: row.id, decisionId: row.decision_id, acceptedRepresentationId: row.accepted_representation_id, status: row.status as CorpusAdmissionPromotionStatus };
}

async function fetchPromotionById(client: Client, promotionId: string): Promise<PromotionRow | null> {
  const result = await client.execute({ sql: "SELECT id, decision_id, accepted_representation_id, status FROM corpus_admission_promotions WHERE id = ?", args: [promotionId] });
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

async function executePromotionWriteWithRetry(openConnection: CorpusAdmissionConnectionFactory, stmt: InStatement): Promise<void> {
  for (let attempt = 1; attempt <= MAX_PROMOTION_BUSY_RETRIES; attempt += 1) {
    const attemptClient = await openConnection();
    try {
      await attemptClient.execute(stmt);
      return;
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
  | { outcome: "failed"; promotionId: string; decisionId: string; error: string };

export type ProcessCorpusAdmissionPromotionParams = {
  promotionId: string;
  openConnection: CorpusAdmissionConnectionFactory;
  /** Test-only fault injection, forwarded to indexPromotionAtomically — see that function's own header comment. Always undefined in production. */
  simulateFailureAfterShingles?: boolean;
};

/**
 * Processes ONE already-claimed promotion row. Every terminal write
 * (indexed/skipped/failed) goes through executePromotionWriteWithRetry, its
 * own fresh-connection SQLITE_BUSY retry — mirrors
 * lib/corpus-admission-report-integration.ts's processReportAdmissionJob
 * exactly, including "one status write per real attempt, whichever outcome
 * it was."
 */
export async function processCorpusAdmissionPromotion(client: Client, params: ProcessCorpusAdmissionPromotionParams): Promise<CorpusAdmissionPromotionOutcome> {
  const promotion = await fetchPromotionById(client, params.promotionId);
  if (!promotion) {
    throw new Error(`processCorpusAdmissionPromotion: no corpus_admission_promotions row for id ${params.promotionId}`);
  }

  const decisionResult = await client.execute({ sql: "SELECT decision FROM corpus_admission_decisions WHERE id = ?", args: [promotion.decisionId] });
  const decisionRow = decisionResult.rows[0] as unknown as { decision: string } | undefined;
  if (!decisionRow || decisionRow.decision !== "ACCEPT") {
    // Invariant violation, not an expected outcome (the sweep only ever
    // creates a promotions row for a decision it just confirmed is ACCEPT)
    // — recorded as 'failed' rather than thrown uncaught, so it surfaces
    // visibly in the admin dashboard's last-error column for investigation
    // instead of crashing the whole sweep batch over one bad row.
    const message = `decision ${promotion.decisionId} is not an ACCEPT (found: ${decisionRow?.decision ?? "missing"}) — a corpus_admission_promotions row should never exist for a non-ACCEPT decision`;
    await executePromotionWriteWithRetry(params.openConnection, {
      sql: "UPDATE corpus_admission_promotions SET status = 'failed', claimed_at = NULL, last_error = ?, attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [message, promotion.id],
    });
    return { outcome: "failed", promotionId: promotion.id, decisionId: promotion.decisionId, error: message };
  }

  const acceptedRepResult = await client.execute({ sql: "SELECT canonical_sha256 FROM corpus_admission_accepted_representations WHERE id = ?", args: [promotion.acceptedRepresentationId] });
  const acceptedRep = acceptedRepResult.rows[0] as unknown as { canonical_sha256: string } | undefined;
  if (!acceptedRep) {
    const message = `no corpus_admission_accepted_representations row for id ${promotion.acceptedRepresentationId} (decision ${promotion.decisionId})`;
    await executePromotionWriteWithRetry(params.openConnection, {
      sql: "UPDATE corpus_admission_promotions SET status = 'failed', claimed_at = NULL, last_error = ?, attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [message, promotion.id],
    });
    return { outcome: "failed", promotionId: promotion.id, decisionId: promotion.decisionId, error: message };
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
    await executePromotionWriteWithRetry(params.openConnection, {
      sql: "UPDATE corpus_admission_promotions SET status = 'failed', claimed_at = NULL, last_error = ?, attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [message, promotion.id],
    });
    return { outcome: "failed", promotionId: promotion.id, decisionId: promotion.decisionId, error: message };
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
 * One sweep tick, two things inside a single atomic write transaction:
 *   1. Discover — INSERT OR IGNORE a 'staged' promotions row for every
 *      ACCEPT decision that doesn't have one yet (bounded by batchSize).
 *      This is the only place a promotions row is ever created; there is no
 *      synchronous hook elsewhere (see this module's own header comment).
 *   2. Claim — same atomic-claim shape as runReportAdmissionRetrySweep:
 *      status IN ('staged','failed'), unclaimed or stale-claimed, claimed_at
 *      stamped inside the same transaction so no concurrent sweep can select
 *      the same rows before this one commits.
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
          const statements = newRows.map((row) => ({
            sql: `INSERT OR IGNORE INTO corpus_admission_promotions (id, decision_id, accepted_representation_id, status, attempt_count, created_at, updated_at)
                  VALUES (?,?,?,'staged',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
            args: [randomUUID(), row.decision_id, row.accepted_representation_id],
          }));
          await tx.batch(statements);
        }

        const candidates = await tx.execute({
          sql: `SELECT id FROM corpus_admission_promotions
                WHERE status IN ('staged','failed') AND (claimed_at IS NULL OR claimed_at < datetime('now', ?))
                ORDER BY updated_at ASC LIMIT ?`,
          args: [`-${staleClaimSeconds} seconds`, batchSize],
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
