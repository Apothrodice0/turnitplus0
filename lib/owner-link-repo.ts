import { randomUUID } from "node:crypto";
import type { Client, InStatement, Transaction } from "@libsql/client";
import {
  OWNER_LINK_KEY_VERSION,
  ownerAccountRef,
  canonicalOwnerRefPair,
  deriveOwnerRefPair,
  evidenceCanEstablishActiveLink,
  isKnownOwnerLinkSignal,
  resolveLinkStatusFromEvidence,
  boundOwnerLinkDetail,
  assertOwnerLinkWithdrawalReason,
  assertOwnerLinkEventShape,
  type OwnerLinkConfidence,
  type OwnerLinkStatus,
  type OwnerLinkDecidedBy,
  type OwnerLinkSignalType,
  type OwnerLinkWithdrawalReason,
  type OwnerLinkEventType,
  type OwnerLinkEventState,
  type OwnerRefPair,
} from "./owner-link";

/**
 * Direct owner-link FOUNDATION — the DB layer. Pure SELECTs plus the small set
 * of transactional writers the storage shape needs: append / update evidence,
 * withdraw evidence or a whole link WITHOUT deletion, and bump BOTH endpoint
 * link generations atomically. Every write is DIRECT-PAIR only — there is no
 * transitive-closure helper here and there never will be in this phase. The
 * per-endpoint generation counter is sufficient PRECISELY BECAUSE links are
 * direct pairs (see lib/owner-link.ts's GENERATION SCOPE note); a transitive
 * phase must add closure-wide invalidation.
 *
 * NOTHING in this module is imported by any scoring / matcher / candidate-
 * discovery path (see tests/owner-link-foundation.test.mjs's invariance check).
 * The stamp/read helpers for report_historical_match_snapshots.owner_link_generation
 * exist for a later phase; they are not called anywhere yet.
 *
 * FAIL CLOSED: with OWNER_LINK_HMAC_KEY unavailable no ref can be derived, so
 * every entry point returns a no-op result and writes nothing. Changing that key
 * has NO online migration path in v1 — it orphans every stored ref and
 * generation (see lib/owner-link.ts's HMAC KEY ROTATION note).
 *
 * WITHDRAWAL REASONS: withdrawOwnerLinkEvidence / withdrawOwnerLink accept only
 * the OWNER_LINK_WITHDRAWAL_REASONS controlled vocabulary — assertOwnerLinkWithdrawalReason
 * runs before any write, and a DB CHECK on both withdrawn_reason columns is the
 * storage backstop. Free text / ids can reach neither column.
 *
 * STATE-TRANSITION HISTORY: the live account_owner_links / _evidence rows carry
 * CURRENT state only — a revive necessarily clears withdrawn_at / withdrawn_reason
 * on the row it revives. Every meaningful ACTIVE <-> WITHDRAWN transition (and
 * link / evidence genesis) is therefore ALSO appended, in the SAME write
 * transaction, to account_owner_link_events (insertOwnerLinkEvent below) — the
 * immutable record of "was this withdrawn / when / why / how many cycles / by
 * which actor CLASS". A plain repeat observation of already-live evidence, and a
 * strongest_confidence change that does not cross the ACTIVE/WITHDRAWN boundary,
 * produce NO event. Each event row is STRUCTURALLY constrained — not merely
 * vocabulary-constrained — to the one legal shape for its type
 * (assertOwnerLinkEventShape + a drizzle/0042 shape CHECK). `actor` is
 * SYSTEM | ADMIN as a CLASS, never proof of which administrator (see
 * lib/owner-link.ts's OWNER_LINK_EVENT_TYPES note).
 */

type Exec = Pick<Client, "execute">;

function num(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : Number(value ?? 0) || 0;
}

export type OwnerLinkRow = {
  id: string;
  accountRefLo: string;
  accountRefHi: string;
  keyVersion: number;
  status: OwnerLinkStatus;
  strongestConfidence: OwnerLinkConfidence;
  firstLinkedAt: number;
  lastEvidenceAt: number;
  withdrawnAt: number | null;
  withdrawnReason: string | null;
  decidedBy: OwnerLinkDecidedBy;
};

function mapLinkRow(row: Record<string, unknown>): OwnerLinkRow {
  return {
    id: String(row.id),
    accountRefLo: String(row.account_ref_lo),
    accountRefHi: String(row.account_ref_hi),
    keyVersion: num(row.key_version),
    status: String(row.status) as OwnerLinkStatus,
    strongestConfidence: String(row.strongest_confidence) as OwnerLinkConfidence,
    firstLinkedAt: num(row.first_linked_at),
    lastEvidenceAt: num(row.last_evidence_at),
    withdrawnAt: row.withdrawn_at == null ? null : num(row.withdrawn_at),
    withdrawnReason: row.withdrawn_reason == null ? null : String(row.withdrawn_reason),
    decidedBy: String(row.decided_by) as OwnerLinkDecidedBy,
  };
}

// ---------------------------------------------------------------------------
// direct-pair reads
// ---------------------------------------------------------------------------

/** Re-export the pure derivation so callers have one import for "derive owner ref". */
export { ownerAccountRef as deriveOwnerRef, canonicalOwnerRefPair, deriveOwnerRefPair } from "./owner-link";

/** Read the (any-status) direct link row for one canonical pair, or null. SELECT-only. */
export async function readDirectOwnerLink(exec: Exec, pair: OwnerRefPair): Promise<OwnerLinkRow | null> {
  const row = (
    await exec.execute({
      sql: `SELECT * FROM account_owner_links
            WHERE account_ref_lo = ? AND account_ref_hi = ? AND key_version = ?`,
      args: [pair.lo, pair.hi, pair.keyVersion],
    })
  ).rows[0] as unknown as Record<string, unknown> | undefined;
  return row ? mapLinkRow(row) : null;
}

/**
 * Read the direct ACTIVE owner link between raw account A and candidate source
 * account B, or null. Null covers: key unavailable, A === B, no link row, and a
 * link row whose status is WITHDRAWN. This is the ONLY direct-link read a later
 * scoring phase would consult — it never widens to a second hop.
 */
export async function readDirectActiveOwnerLinkBetween(
  exec: Exec,
  accountIdA: string,
  accountIdB: string,
  keyVersion: number = OWNER_LINK_KEY_VERSION,
): Promise<OwnerLinkRow | null> {
  const pair = deriveOwnerRefPair(accountIdA, accountIdB, keyVersion);
  if (!pair) return null;
  const link = await readDirectOwnerLink(exec, pair);
  return link && link.status === "ACTIVE" ? link : null;
}

export type OwnerLinkEvidenceRow = {
  id: string;
  linkId: string;
  confidence: OwnerLinkConfidence;
  signalType: string;
  evidenceFingerprint: string;
  observationCount: number;
  firstObservedAt: number;
  lastObservedAt: number;
  withdrawnAt: number | null;
  /** Controlled vocabulary (OWNER_LINK_WITHDRAWAL_REASONS) or null for a live row. */
  withdrawnReason: OwnerLinkWithdrawalReason | null;
  detailJson: string | null;
  createdBy: OwnerLinkDecidedBy;
};

function mapEvidenceRow(row: Record<string, unknown>): OwnerLinkEvidenceRow {
  return {
    id: String(row.id),
    linkId: String(row.link_id),
    confidence: String(row.confidence) as OwnerLinkConfidence,
    signalType: String(row.signal_type),
    evidenceFingerprint: String(row.evidence_fingerprint),
    observationCount: num(row.observation_count),
    firstObservedAt: num(row.first_observed_at),
    lastObservedAt: num(row.last_observed_at),
    withdrawnAt: row.withdrawn_at == null ? null : num(row.withdrawn_at),
    withdrawnReason: row.withdrawn_reason == null ? null : (String(row.withdrawn_reason) as OwnerLinkWithdrawalReason),
    detailJson: row.detail_json == null ? null : String(row.detail_json),
    createdBy: String(row.created_by) as OwnerLinkDecidedBy,
  };
}

/** All evidence rows for a link (withdrawn included), oldest first. SELECT-only. */
export async function readOwnerLinkEvidence(exec: Exec, linkId: string): Promise<OwnerLinkEvidenceRow[]> {
  const rows = (
    await exec.execute({
      sql: `SELECT * FROM account_owner_link_evidence WHERE link_id = ? ORDER BY first_observed_at, id`,
      args: [linkId],
    })
  ).rows as unknown as Record<string, unknown>[];
  return rows.map(mapEvidenceRow);
}

// ---------------------------------------------------------------------------
// account_owner_link_events — append-only state-transition log
// ---------------------------------------------------------------------------

export type OwnerLinkEventRow = {
  /** autoincrement; also the canonical event ordering */
  id: number;
  linkId: string;
  /** null for a link-level event */
  evidenceId: string | null;
  eventType: OwnerLinkEventType;
  /** null only for LINK_CREATED / EVIDENCE_ADDED */
  previousState: OwnerLinkEventState | null;
  newState: OwnerLinkEventState;
  /** controlled vocabulary; non-null only for a *_WITHDRAWN event */
  reason: OwnerLinkWithdrawalReason | null;
  actor: OwnerLinkDecidedBy;
  occurredAt: number;
};

function mapEventRow(row: Record<string, unknown>): OwnerLinkEventRow {
  return {
    id: num(row.id),
    linkId: String(row.link_id),
    evidenceId: row.evidence_id == null ? null : String(row.evidence_id),
    eventType: String(row.event_type) as OwnerLinkEventType,
    previousState: row.previous_state == null ? null : (String(row.previous_state) as OwnerLinkEventState),
    newState: String(row.new_state) as OwnerLinkEventState,
    reason: row.reason == null ? null : (String(row.reason) as OwnerLinkWithdrawalReason),
    actor: String(row.actor) as OwnerLinkDecidedBy,
    occurredAt: num(row.occurred_at),
  };
}

type OwnerLinkEventInsert = {
  linkId: string;
  evidenceId: string | null;
  eventType: OwnerLinkEventType;
  previousState: OwnerLinkEventState | null;
  newState: OwnerLinkEventState;
  reason: OwnerLinkWithdrawalReason | null;
  actor: OwnerLinkDecidedBy;
  occurredAt: number;
};

/**
 * Append ONE row to account_owner_link_events. MUST be called inside the same
 * write transaction as the state mutation it records (every caller here does),
 * so the event and the mutation commit or roll back together. The row is
 * immutable — nothing ever UPDATEs or DELETEs this table.
 *
 * Two invariant layers run before the INSERT, mirrored by DB CHECKs:
 *   - assertOwnerLinkWithdrawalReason: any non-null `reason` is a controlled token.
 *   - assertOwnerLinkEventShape: (eventType, evidence_id presence, previous_state,
 *     new_state, reason presence) is the ONE legal combination for that type —
 *     e.g. a LINK_* event never carries an evidence_id, EVIDENCE_WITHDRAWN always
 *     carries a reason, LINK_REACTIVATED never does, states match the direction.
 */
async function insertOwnerLinkEvent(exec: Pick<Transaction, "execute">, event: OwnerLinkEventInsert): Promise<void> {
  const reason = event.reason == null ? null : assertOwnerLinkWithdrawalReason(event.reason);
  assertOwnerLinkEventShape({
    eventType: event.eventType,
    evidenceId: event.evidenceId,
    previousState: event.previousState,
    newState: event.newState,
    reason,
  });
  await exec.execute({
    sql: `INSERT INTO account_owner_link_events
            (link_id, evidence_id, event_type, previous_state, new_state, reason, actor, occurred_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    args: [
      event.linkId,
      event.evidenceId,
      event.eventType,
      event.previousState,
      event.newState,
      reason,
      event.actor,
      event.occurredAt,
    ],
  });
}

/** Every state-transition event for a link, oldest first (by insertion order). SELECT-only. */
export async function readOwnerLinkEvents(exec: Exec, linkId: string): Promise<OwnerLinkEventRow[]> {
  const rows = (
    await exec.execute({
      sql: `SELECT * FROM account_owner_link_events WHERE link_id = ? ORDER BY id`,
      args: [linkId],
    })
  ).rows as unknown as Record<string, unknown>[];
  return rows.map(mapEventRow);
}

/** Every state-transition event for one evidence row, oldest first. SELECT-only. */
export async function readOwnerLinkEventsForEvidence(exec: Exec, evidenceId: string): Promise<OwnerLinkEventRow[]> {
  const rows = (
    await exec.execute({
      sql: `SELECT * FROM account_owner_link_events WHERE evidence_id = ? ORDER BY id`,
      args: [evidenceId],
    })
  ).rows as unknown as Record<string, unknown>[];
  return rows.map(mapEventRow);
}

// ---------------------------------------------------------------------------
// generation foundation
// ---------------------------------------------------------------------------

function bumpGenerationStatements(pair: OwnerRefPair, at: number): InStatement[] {
  const one = (ref: string): InStatement => ({
    sql: `INSERT INTO account_owner_link_state (account_ref, key_version, link_generation, updated_at)
          VALUES (?, ?, 1, ?)
          ON CONFLICT (account_ref, key_version) DO UPDATE SET
            link_generation = account_owner_link_state.link_generation + 1,
            updated_at = excluded.updated_at`,
    args: [ref, pair.keyVersion, at],
  });
  return [one(pair.lo), one(pair.hi)];
}

/**
 * Bump BOTH endpoint link generations for one canonical pair, atomically
 * (client.batch("write") is one server-side transaction — either both rows
 * advance or neither does). A brand-new state row is born at generation 1 (an
 * absent row already reads as 0, so the first bump is 0 -> 1). Monotonic: the
 * counter is only ever incremented, never reset, including on withdrawal.
 */
export async function bumpOwnerLinkGenerationsForPair(
  client: Pick<Client, "batch">,
  pair: OwnerRefPair,
  at: number = Date.now(),
): Promise<void> {
  await client.batch(bumpGenerationStatements(pair, at), "write");
}

/** Read one account's current link generation. 0 when the key is unavailable (fail closed) or no state row exists. SELECT-only. */
export async function readAccountOwnerLinkGeneration(
  exec: Exec,
  accountId: string,
  keyVersion: number = OWNER_LINK_KEY_VERSION,
): Promise<number> {
  const ref = ownerAccountRef(accountId);
  if (!ref) return 0;
  return readOwnerRefLinkGeneration(exec, ref, keyVersion);
}

/** Read one already-derived ref's current link generation. 0 when no state row exists. SELECT-only. */
export async function readOwnerRefLinkGeneration(
  exec: Exec,
  accountRef: string,
  keyVersion: number = OWNER_LINK_KEY_VERSION,
): Promise<number> {
  const row = (
    await exec.execute({
      sql: `SELECT link_generation FROM account_owner_link_state WHERE account_ref = ? AND key_version = ?`,
      args: [accountRef, keyVersion],
    })
  ).rows[0] as unknown as Record<string, unknown> | undefined;
  return row == null ? 0 : num(row.link_generation);
}

/**
 * Read the owner_link_generation stamped on one report's historical-match
 * snapshot, or null when there is no snapshot row. Foundation only — nothing in
 * scoring reads this yet.
 */
export async function readReportSnapshotOwnerLinkGeneration(
  exec: Exec,
  reportDeviceKey: string,
  reportId: string,
): Promise<number | null> {
  const row = (
    await exec.execute({
      sql: `SELECT owner_link_generation FROM report_historical_match_snapshots
            WHERE report_device_key = ? AND report_id = ?`,
      args: [reportDeviceKey, reportId],
    })
  ).rows[0] as unknown as Record<string, unknown> | undefined;
  return row == null ? null : num(row.owner_link_generation);
}

/**
 * Stamp a report snapshot's owner_link_generation. Returns whether a row was
 * updated. Foundation only — no scoring path calls this yet; it exists so the
 * staleness comparison a later phase performs has a writer ready.
 */
export async function stampReportSnapshotOwnerLinkGeneration(
  exec: Exec,
  params: { reportDeviceKey: string; reportId: string; generation: number },
): Promise<{ updated: boolean }> {
  const result = await exec.execute({
    sql: `UPDATE report_historical_match_snapshots SET owner_link_generation = ?
          WHERE report_device_key = ? AND report_id = ?`,
    args: [Math.max(0, Math.trunc(params.generation)), params.reportDeviceKey, params.reportId],
  });
  return { updated: num(result.rowsAffected) > 0 };
}

// ---------------------------------------------------------------------------
// append / update evidence
// ---------------------------------------------------------------------------

export type UpsertOwnerLinkEvidenceParams = {
  /** the report / subject account */
  accountId: string;
  /** the candidate source account the link would be to */
  candidateSourceAccountId: string;
  signalType: OwnerLinkSignalType;
  confidence: OwnerLinkConfidence;
  /**
   * An HMAC / domain-separated fingerprint (lib/owner-link.ts's
   * ownerLinkEvidenceFingerprint) — the dedup discriminator alongside
   * (link_id, signal_type). NEVER a raw id.
   */
  evidenceFingerprint: string;
  observedAt: number;
  /** Bounded via boundOwnerLinkDetail before it is written — counts / booleans / enum tokens only. */
  detail?: Record<string, unknown>;
  createdBy: OwnerLinkDecidedBy;
  /** decided_by for the link row when this call CREATES it. Default SYSTEM. */
  decidedBy?: OwnerLinkDecidedBy;
  keyVersion?: number;
};

export type UpsertOwnerLinkEvidenceOutcome =
  | "NO_INFERENCE_KEY"
  | "SAME_ACCOUNT"
  | "UNKNOWN_SIGNAL"
  | "MISSING_FINGERPRINT"
  | "OBSERVATION_ONLY_NO_LINK"
  | "EVIDENCE_RECORDED";

export type UpsertOwnerLinkEvidenceResult = {
  outcome: UpsertOwnerLinkEvidenceOutcome;
  linkId: string | null;
  linkStatus: OwnerLinkStatus | null;
  linkCreated: boolean;
  evidenceId: string | null;
  evidenceCreated: boolean;
  strongestConfidence: OwnerLinkConfidence | null;
  generationsBumped: boolean;
};

function emptyUpsert(outcome: UpsertOwnerLinkEvidenceOutcome): UpsertOwnerLinkEvidenceResult {
  return {
    outcome,
    linkId: null,
    linkStatus: null,
    linkCreated: false,
    evidenceId: null,
    evidenceCreated: false,
    strongestConfidence: null,
    generationsBumped: false,
  };
}

/**
 * Append or update ONE direct-pair evidence row, then recompute the link.
 *
 *   - key unavailable / same account / unknown signal / missing fingerprint
 *     -> a no-op result, nothing written.
 *   - a qualifying owner-bound signal (>= MEDIUM) with no link row yet
 *     -> the link row is CREATED ACTIVE, the evidence row inserted, BOTH
 *        endpoint generations bumped.
 *   - a non-qualifying signal (observation-only, or LOW) with no link row
 *     -> OBSERVATION_ONLY_NO_LINK, nothing written (there is nothing for it to
 *        attach to; it can never create a link by itself).
 *   - any signal when a link row already exists
 *     -> the evidence row is UPSERTed (first_observed_at preserved,
 *        last_observed_at advanced, observation_count incremented; a withdrawn
 *        row is revived), then the link's status + strongest_confidence are
 *        recomputed from ALL live evidence.
 *
 * Shared-device fan-out / anonymous-history / IP / timing values passed in
 * `detail` are stored (bounded) but are NEVER consulted here — they cannot veto
 * link creation or activation.
 */
export async function upsertOwnerLinkEvidence(
  client: Client,
  params: UpsertOwnerLinkEvidenceParams,
): Promise<UpsertOwnerLinkEvidenceResult> {
  const keyVersion = params.keyVersion ?? OWNER_LINK_KEY_VERSION;
  const now = params.observedAt;

  const refA = ownerAccountRef(params.accountId);
  const refB = ownerAccountRef(params.candidateSourceAccountId);
  if (!refA || !refB) return emptyUpsert("NO_INFERENCE_KEY");
  const pair = canonicalOwnerRefPair(refA, refB, keyVersion);
  if (!pair) return emptyUpsert("SAME_ACCOUNT");
  if (!isKnownOwnerLinkSignal(params.signalType)) return emptyUpsert("UNKNOWN_SIGNAL");
  if (typeof params.evidenceFingerprint !== "string" || params.evidenceFingerprint.length === 0) {
    return emptyUpsert("MISSING_FINGERPRINT");
  }

  const qualifies = evidenceCanEstablishActiveLink(params.signalType, params.confidence);
  const detailJson = params.detail === undefined ? null : boundOwnerLinkDetail(params.detail);

  const tx: Transaction = await client.transaction("write");
  try {
    const existingLink = (
      await tx.execute({
        sql: `SELECT id, status FROM account_owner_links
              WHERE account_ref_lo = ? AND account_ref_hi = ? AND key_version = ?`,
        args: [pair.lo, pair.hi, keyVersion],
      })
    ).rows[0] as unknown as { id: string; status: string } | undefined;

    if (!existingLink && !qualifies) {
      await tx.rollback();
      return emptyUpsert("OBSERVATION_ONLY_NO_LINK");
    }

    let linkId: string;
    let linkCreated = false;
    let previousStrongest: OwnerLinkConfidence | null = null;
    if (!existingLink) {
      linkId = randomUUID();
      linkCreated = true;
      await tx.execute({
        sql: `INSERT INTO account_owner_links
                (id, account_ref_lo, account_ref_hi, key_version, status, strongest_confidence,
                 first_linked_at, last_evidence_at, decided_by)
              VALUES (?,?,?,?,?,?,?,?,?)`,
        args: [linkId, pair.lo, pair.hi, keyVersion, "ACTIVE", params.confidence, now, now, params.decidedBy ?? "SYSTEM"],
      });
    } else {
      linkId = existingLink.id;
      const cur = (
        await tx.execute({ sql: `SELECT strongest_confidence FROM account_owner_links WHERE id = ?`, args: [linkId] })
      ).rows[0] as unknown as { strongest_confidence: string } | undefined;
      previousStrongest = (cur?.strongest_confidence as OwnerLinkConfidence | undefined) ?? null;
    }

    const evExisting = (
      await tx.execute({
        sql: `SELECT id, withdrawn_at FROM account_owner_link_evidence
              WHERE link_id = ? AND signal_type = ? AND evidence_fingerprint = ?`,
        args: [linkId, params.signalType, params.evidenceFingerprint],
      })
    ).rows[0] as unknown as { id: string; withdrawn_at: number | bigint | null } | undefined;

    let evidenceId: string;
    let evidenceCreated = false;
    let evidenceRevived = false;
    if (!evExisting) {
      evidenceId = randomUUID();
      evidenceCreated = true;
      await tx.execute({
        sql: `INSERT INTO account_owner_link_evidence
                (id, link_id, confidence, signal_type, evidence_fingerprint,
                 observation_count, first_observed_at, last_observed_at, detail_json, created_by)
              VALUES (?,?,?,?,?,1,?,?,?,?)`,
        args: [
          evidenceId,
          linkId,
          params.confidence,
          params.signalType,
          params.evidenceFingerprint,
          now,
          now,
          detailJson,
          params.createdBy,
        ],
      });
    } else {
      evidenceId = evExisting.id;
      evidenceRevived = evExisting.withdrawn_at != null;
      // repeat observation: preserve first_observed_at, advance last_observed_at,
      // increment observation_count, refresh confidence / detail, and revive a
      // previously-withdrawn row (a fresh observation is fresh evidence) —
      // clearing withdrawn_reason with withdrawn_at so a live row carries neither.
      await tx.execute({
        sql: `UPDATE account_owner_link_evidence SET
                observation_count = observation_count + 1,
                last_observed_at = max(last_observed_at, ?),
                confidence = ?,
                withdrawn_at = NULL,
                withdrawn_reason = NULL,
                detail_json = COALESCE(?, detail_json)
              WHERE id = ?`,
        args: [now, params.confidence, detailJson, evidenceId],
      });
    }

    const liveEvidence = (
      await tx.execute({
        sql: `SELECT signal_type, confidence FROM account_owner_link_evidence
              WHERE link_id = ? AND withdrawn_at IS NULL`,
        args: [linkId],
      })
    ).rows as unknown as { signal_type: string; confidence: OwnerLinkConfidence }[];
    const resolved = resolveLinkStatusFromEvidence(
      liveEvidence.map((e) => ({ signalType: e.signal_type, confidence: e.confidence })),
    );
    const strongest = resolved.strongestConfidence ?? params.confidence;

    if (resolved.status === "ACTIVE") {
      // A WITHDRAWN -> ACTIVE flip is a REACTIVATION: re-attribute decided_by to
      // the actor responsible for THIS reactivation (an explicit decidedBy, else
      // the actor recording the reviving evidence) — never leave the previous
      // withdrawal actor stamped on a now-live link. The withdrawal/revival
      // history is NOT kept on this row (its withdrawn_* fields are cleared here);
      // it is recorded immutably in account_owner_link_events below.
      const reactivating = existingLink != null && existingLink.status === "WITHDRAWN";
      if (reactivating) {
        const reactivationActor: OwnerLinkDecidedBy = params.decidedBy ?? params.createdBy;
        await tx.execute({
          sql: `UPDATE account_owner_links SET
                  status = 'ACTIVE',
                  strongest_confidence = ?,
                  last_evidence_at = max(last_evidence_at, ?),
                  withdrawn_at = NULL,
                  withdrawn_reason = NULL,
                  decided_by = ?
                WHERE id = ?`,
          args: [strongest, now, reactivationActor, linkId],
        });
      } else {
        await tx.execute({
          sql: `UPDATE account_owner_links SET
                  status = 'ACTIVE',
                  strongest_confidence = ?,
                  last_evidence_at = max(last_evidence_at, ?),
                  withdrawn_at = NULL,
                  withdrawn_reason = NULL
                WHERE id = ?`,
          args: [strongest, now, linkId],
        });
      }
    } else {
      await tx.execute({
        sql: `UPDATE account_owner_links SET
                status = 'WITHDRAWN',
                strongest_confidence = ?,
                last_evidence_at = max(last_evidence_at, ?),
                withdrawn_at = COALESCE(withdrawn_at, ?),
                withdrawn_reason = COALESCE(withdrawn_reason, 'NO_QUALIFYING_EVIDENCE')
              WHERE id = ?`,
        args: [strongest, now, now, linkId],
      });
    }

    // ---- append the state-transition events (same transaction) ----
    // Order: genesis first, then the evidence transition, then any resulting
    // link transition. A plain repeat observation of already-live evidence
    // (evidenceCreated && evidenceRevived both false) records nothing.
    if (linkCreated) {
      await insertOwnerLinkEvent(tx, {
        linkId, evidenceId: null, eventType: "LINK_CREATED",
        previousState: null, newState: "ACTIVE",
        reason: null, actor: params.decidedBy ?? "SYSTEM", occurredAt: now,
      });
    }
    if (evidenceCreated) {
      await insertOwnerLinkEvent(tx, {
        linkId, evidenceId, eventType: "EVIDENCE_ADDED",
        previousState: null, newState: "ACTIVE",
        reason: null, actor: params.createdBy, occurredAt: now,
      });
    } else if (evidenceRevived) {
      await insertOwnerLinkEvent(tx, {
        linkId, evidenceId, eventType: "EVIDENCE_REACTIVATED",
        previousState: "WITHDRAWN", newState: "ACTIVE",
        reason: null, actor: params.createdBy, occurredAt: now,
      });
    }
    if (!linkCreated && existingLink != null && existingLink.status !== resolved.status) {
      if (resolved.status === "ACTIVE") {
        await insertOwnerLinkEvent(tx, {
          linkId, evidenceId: null, eventType: "LINK_REACTIVATED",
          previousState: "WITHDRAWN", newState: "ACTIVE",
          reason: null, actor: params.decidedBy ?? params.createdBy, occurredAt: now,
        });
      } else {
        // The sole qualifying evidence lost its qualifying confidence via this
        // upsert -> the link drops to WITHDRAWN. Reason mirrors the row write.
        await insertOwnerLinkEvent(tx, {
          linkId, evidenceId: null, eventType: "LINK_WITHDRAWN",
          previousState: "ACTIVE", newState: "WITHDRAWN",
          reason: "NO_QUALIFYING_EVIDENCE", actor: params.decidedBy ?? params.createdBy, occurredAt: now,
        });
      }
    }

    const materiallyChanged =
      linkCreated ||
      evidenceCreated ||
      evidenceRevived ||
      (existingLink != null && existingLink.status !== resolved.status) ||
      previousStrongest !== strongest;

    let generationsBumped = false;
    if (materiallyChanged) {
      for (const stmt of bumpGenerationStatements(pair, now)) {
        await tx.execute(stmt);
      }
      generationsBumped = true;
    }

    await tx.commit();
    return {
      outcome: "EVIDENCE_RECORDED",
      linkId,
      linkStatus: resolved.status,
      linkCreated,
      evidenceId,
      evidenceCreated,
      strongestConfidence: strongest,
      generationsBumped,
    };
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      /* already settled */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// withdrawal — tombstone only, never DELETE
// ---------------------------------------------------------------------------

export type WithdrawOwnerLinkEvidenceParams = {
  evidenceId: string;
  /** Controlled vocabulary only (OWNER_LINK_WITHDRAWAL_REASONS) — validated before any write. */
  reason: OwnerLinkWithdrawalReason;
  withdrawnAt: number;
  decidedBy: OwnerLinkDecidedBy;
  keyVersion?: number;
};

export type WithdrawOwnerLinkEvidenceResult = {
  outcome: "EVIDENCE_NOT_FOUND" | "ALREADY_WITHDRAWN" | "EVIDENCE_WITHDRAWN";
  linkId: string | null;
  linkStatus: OwnerLinkStatus | null;
  generationsBumped: boolean;
};

/**
 * Tombstone ONE evidence row (set withdrawn_at — the row is NEVER deleted, the
 * observation_count is NEVER decremented), then recompute the parent link. If
 * no qualifying live evidence remains the link flips to WITHDRAWN (its
 * strongest_confidence value is retained for audit). Both endpoint generations
 * are bumped.
 *
 * Appends an EVIDENCE_WITHDRAWN event (and a LINK_WITHDRAWN event when this is
 * what drops the link) to account_owner_link_events in the SAME transaction — so
 * the reason/actor/time survive a later revive that clears the row's own
 * withdrawn_* fields. Idempotent: an already-tombstoned evidence row returns
 * ALREADY_WITHDRAWN before any write, so it never appends a duplicate event.
 */
export async function withdrawOwnerLinkEvidence(
  client: Client,
  params: WithdrawOwnerLinkEvidenceParams,
): Promise<WithdrawOwnerLinkEvidenceResult> {
  const reason = assertOwnerLinkWithdrawalReason(params.reason);
  const now = params.withdrawnAt;
  const tx: Transaction = await client.transaction("write");
  try {
    const ev = (
      await tx.execute({
        sql: `SELECT e.id AS id, e.link_id AS link_id, e.withdrawn_at AS withdrawn_at,
                     l.account_ref_lo AS lo, l.account_ref_hi AS hi, l.key_version AS kv,
                     l.strongest_confidence AS strongest, l.status AS link_status
              FROM account_owner_link_evidence e
              JOIN account_owner_links l ON l.id = e.link_id
              WHERE e.id = ?`,
        args: [params.evidenceId],
      })
    ).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!ev) {
      await tx.rollback();
      return { outcome: "EVIDENCE_NOT_FOUND", linkId: null, linkStatus: null, generationsBumped: false };
    }
    const linkId = String(ev.link_id);
    const previousLinkStatus = String(ev.link_status) as OwnerLinkStatus;
    if (ev.withdrawn_at != null) {
      await tx.rollback();
      return { outcome: "ALREADY_WITHDRAWN", linkId, linkStatus: previousLinkStatus, generationsBumped: false };
    }

    await tx.execute({
      sql: `UPDATE account_owner_link_evidence SET withdrawn_at = ?, withdrawn_reason = ? WHERE id = ? AND withdrawn_at IS NULL`,
      args: [now, reason, params.evidenceId],
    });

    const liveEvidence = (
      await tx.execute({
        sql: `SELECT signal_type, confidence FROM account_owner_link_evidence
              WHERE link_id = ? AND withdrawn_at IS NULL`,
        args: [linkId],
      })
    ).rows as unknown as { signal_type: string; confidence: OwnerLinkConfidence }[];
    const resolved = resolveLinkStatusFromEvidence(
      liveEvidence.map((e) => ({ signalType: e.signal_type, confidence: e.confidence })),
    );
    // strongest_confidence NOT NULL — keep the last known value when nothing lives.
    const strongest = resolved.strongestConfidence ?? (String(ev.strongest) as OwnerLinkConfidence);

    if (resolved.status === "ACTIVE") {
      await tx.execute({
        sql: `UPDATE account_owner_links SET status = 'ACTIVE', strongest_confidence = ? WHERE id = ?`,
        args: [strongest, linkId],
      });
    } else {
      await tx.execute({
        sql: `UPDATE account_owner_links SET
                status = 'WITHDRAWN',
                strongest_confidence = ?,
                withdrawn_at = COALESCE(withdrawn_at, ?),
                withdrawn_reason = COALESCE(withdrawn_reason, ?),
                decided_by = ?
              WHERE id = ?`,
        args: [strongest, now, reason, params.decidedBy, linkId],
      });
    }

    // ---- state-transition events (same transaction) ----
    await insertOwnerLinkEvent(tx, {
      linkId, evidenceId: params.evidenceId, eventType: "EVIDENCE_WITHDRAWN",
      previousState: "ACTIVE", newState: "WITHDRAWN",
      reason, actor: params.decidedBy, occurredAt: now,
    });
    if (previousLinkStatus === "ACTIVE" && resolved.status === "WITHDRAWN") {
      await insertOwnerLinkEvent(tx, {
        linkId, evidenceId: null, eventType: "LINK_WITHDRAWN",
        previousState: "ACTIVE", newState: "WITHDRAWN",
        reason, actor: params.decidedBy, occurredAt: now,
      });
    }

    const pair: OwnerRefPair = { lo: String(ev.lo), hi: String(ev.hi), keyVersion: num(ev.kv) };
    for (const stmt of bumpGenerationStatements(pair, now)) {
      await tx.execute(stmt);
    }

    await tx.commit();
    return { outcome: "EVIDENCE_WITHDRAWN", linkId, linkStatus: resolved.status, generationsBumped: true };
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      /* already settled */
    }
    throw err;
  }
}

export type WithdrawOwnerLinkParams = {
  linkId: string;
  /** Controlled vocabulary only (OWNER_LINK_WITHDRAWAL_REASONS) — validated before any write. */
  reason: OwnerLinkWithdrawalReason;
  withdrawnAt: number;
  decidedBy: OwnerLinkDecidedBy;
  /** also tombstone every remaining live evidence row for the link. Default true. */
  withdrawEvidence?: boolean;
};

export type WithdrawOwnerLinkResult = {
  outcome: "LINK_NOT_FOUND" | "ALREADY_WITHDRAWN" | "LINK_WITHDRAWN";
  linkId: string;
  evidenceTombstoned: number;
  generationsBumped: boolean;
};

/**
 * Withdraw a whole link: set status = WITHDRAWN + withdrawn_at / withdrawn_reason
 * / decided_by, optionally tombstone every remaining live evidence row (never
 * deleting anything), and bump both endpoint generations. Appends one
 * EVIDENCE_WITHDRAWN event per row it tombstones plus one LINK_WITHDRAWN event,
 * all in the SAME transaction. Idempotent — a second call on an already-withdrawn
 * link returns ALREADY_WITHDRAWN before any write, so it appends no events.
 */
export async function withdrawOwnerLink(
  client: Client,
  params: WithdrawOwnerLinkParams,
): Promise<WithdrawOwnerLinkResult> {
  const reason = assertOwnerLinkWithdrawalReason(params.reason);
  const now = params.withdrawnAt;
  const withdrawEvidence = params.withdrawEvidence ?? true;
  const tx: Transaction = await client.transaction("write");
  try {
    const link = (
      await tx.execute({
        sql: `SELECT account_ref_lo AS lo, account_ref_hi AS hi, key_version AS kv, status
              FROM account_owner_links WHERE id = ?`,
        args: [params.linkId],
      })
    ).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!link) {
      await tx.rollback();
      return { outcome: "LINK_NOT_FOUND", linkId: params.linkId, evidenceTombstoned: 0, generationsBumped: false };
    }
    if (String(link.status) === "WITHDRAWN") {
      await tx.rollback();
      return { outcome: "ALREADY_WITHDRAWN", linkId: params.linkId, evidenceTombstoned: 0, generationsBumped: false };
    }

    // Capture the ids BEFORE tombstoning so one EVIDENCE_WITHDRAWN event can be
    // appended per row (a bulk UPDATE alone would not identify them).
    let tombstonedEvidenceIds: string[] = [];
    if (withdrawEvidence) {
      const live = await tx.execute({
        sql: `SELECT id FROM account_owner_link_evidence WHERE link_id = ? AND withdrawn_at IS NULL`,
        args: [params.linkId],
      });
      tombstonedEvidenceIds = (live.rows as unknown as { id: string }[]).map((r) => String(r.id));
      if (tombstonedEvidenceIds.length > 0) {
        await tx.execute({
          sql: `UPDATE account_owner_link_evidence SET withdrawn_at = ?, withdrawn_reason = ? WHERE link_id = ? AND withdrawn_at IS NULL`,
          args: [now, reason, params.linkId],
        });
      }
    }
    const evidenceTombstoned = tombstonedEvidenceIds.length;

    await tx.execute({
      sql: `UPDATE account_owner_links SET
              status = 'WITHDRAWN',
              withdrawn_at = ?,
              withdrawn_reason = ?,
              decided_by = ?
            WHERE id = ? AND status = 'ACTIVE'`,
      args: [now, reason, params.decidedBy, params.linkId],
    });

    // ---- state-transition events (same transaction) ----
    for (const evId of tombstonedEvidenceIds) {
      await insertOwnerLinkEvent(tx, {
        linkId: params.linkId, evidenceId: evId, eventType: "EVIDENCE_WITHDRAWN",
        previousState: "ACTIVE", newState: "WITHDRAWN",
        reason, actor: params.decidedBy, occurredAt: now,
      });
    }
    await insertOwnerLinkEvent(tx, {
      linkId: params.linkId, evidenceId: null, eventType: "LINK_WITHDRAWN",
      previousState: "ACTIVE", newState: "WITHDRAWN",
      reason, actor: params.decidedBy, occurredAt: now,
    });

    const pair: OwnerRefPair = { lo: String(link.lo), hi: String(link.hi), keyVersion: num(link.kv) };
    for (const stmt of bumpGenerationStatements(pair, now)) {
      await tx.execute(stmt);
    }

    await tx.commit();
    return { outcome: "LINK_WITHDRAWN", linkId: params.linkId, evidenceTombstoned, generationsBumped: true };
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      /* already settled */
    }
    throw err;
  }
}
