import type { Client } from "@libsql/client";
import {
  deriveOwnerRefPair,
  isOwnerLinkInferenceAvailable,
  evidenceCanEstablishActiveLink,
  OWNER_LINK_KEY_VERSION,
  type OwnerLinkConfidence,
} from "./owner-link";
import { readDirectOwnerLink, readAccountOwnerLinkGeneration } from "./owner-link-repo";
import { resolveActorObservation, DEVICE_ACTOR_KEY_VERSION } from "./device-passport-actor-ledger";

/**
 * Direct owner-link REVIEW — read-only, pair-level. Given two account emails
 * (already resolved to account ids by the caller), assembles the bounded
 * evidence an admin needs before ever manually establishing a HIGH owner link:
 * Device Passport supporting evidence computed ON DEMAND from the durable
 * ledger, plus the current direct-link state / audit history once
 * drizzle/0042 exists.
 *
 * NOTHING here writes any owner-link / account / report / passport business
 * data. No transaction. No cache, no candidate/pending row — the durable
 * upstream tables ARE the source of truth and are cheap to re-query per admin
 * review action. Nothing here imports a scoring / matcher module, and nothing
 * it returns feeds one.
 *
 * HISTORICAL vs CURRENT-ELIGIBILITY vs CURRENT-REPORT evidence — three tiers,
 * kept explicitly separate so a review can never become "safer" merely because
 * mutable state changed:
 *
 *   HISTORICAL (historicalJointV1ActorPassportCount, maxHistoricalAuthenticatedActors,
 *   anonymousEverSeen) — from device_passport_actor_usage, an APPEND-ONLY ledger
 *   no lifecycle event ever shrinks (report deletion, account cleanup, room
 *   clearing, retention sweep, claimAnonymousReports, re-registration — see
 *   lib/device-passport-actor-ledger.ts). NOT filtered by passport revocation:
 *   revoking a passport invalidates it for a CURRENT decision but must NOT erase
 *   the historical fact that A and B were observed on it. These are the durable
 *   truth about whether the pair has ever shared a verified device.
 *
 *   CURRENT ELIGIBILITY (activeJointV1ActorPassportCount, revokedJointV1ActorPassportCount,
 *   crossPassportSupportingEvidence) — the same ledger evidence, partitioned by
 *   whether each passport is currently revoked. Only the NON-revoked partition
 *   counts toward current cross-Passport support.
 *
 *   CURRENT REPORT telemetry (sharedVerifiedPassportCount, maxCurrentReportAccountCount,
 *   maxCurrentSubmissionCount, complete/incompleteTrackedPassportCount) — from
 *   saved_reports; MUTABLE, can legitimately shrink when reports are deleted or
 *   an anonymous report is later claimed. The weakest signal.
 *
 * PRIVACY: the result carries ONLY bounded counts / booleans / closed-vocab
 * enum tokens. Never an email, a raw account id, an ownerAccountRef, a passport
 * id, an SPKI, an actor HMAC, an evidence fingerprint, a link / evidence UUID,
 * a report id, a source_ref, an IP, or any free text. The event history is
 * bounded to the most recent OWNER_REVIEW_MAX_EVENTS rows.
 *
 * "Supporting evidence" here means MEDIUM machine evidence — a shared verified
 * Device Passport, a cross-Passport actor co-occurrence. It is
 * household/family-ambiguous and is NEVER called "same owner": only a
 * HIGH-confidence owner-bound row (evidenceCanEstablishActiveLink) establishes
 * an owner link.
 */

/** The three states the frozen owner-link foundation can be in for this reviewer. */
export type OwnerReviewOwnerLinkState =
  | "SCHEMA_ABSENT" // drizzle/0042 not applied — no account_owner_links table
  | "KEY_UNAVAILABLE" // 0042 applied, OWNER_LINK_HMAC_KEY unset -> no pseudonym can be derived
  | "NONE" // 0042 + key available, no direct link row for this pair
  | "ACTIVE"
  | "WITHDRAWN";

export type OwnerReviewSupportingAssessment = "NONE" | "SUPPORTING_ONLY";

/**
 * WHY a SUPPORTING_ONLY assessment exists — so an admin can tell durable
 * current evidence apart from a mutable fallback or a purely historical
 * (revoked-device) trace. NEVER implies same owner.
 *   ACTIVE_DURABLE_LEDGER            >= 1 NON-revoked v1 passport where the
 *                                    ledger shows both accounts' actor pseudonyms
 *   HISTORICAL_ONLY_REVOKED          the pair IS on the durable v1 ledger together,
 *                                    but every such passport is now revoked — a
 *                                    historical fact, not current verified support
 *   CURRENT_SHARED_PASSPORT_FALLBACK no durable ledger co-occurrence at all; only
 *                                    a currently-shared verified passport per
 *                                    saved_reports (mutable — the weakest signal)
 *   NONE                             no supporting evidence
 */
export type OwnerReviewSupportBasis =
  | "NONE"
  | "ACTIVE_DURABLE_LEDGER"
  | "HISTORICAL_ONLY_REVOKED"
  | "CURRENT_SHARED_PASSPORT_FALLBACK";

export type OwnerReviewTier = "NONE" | "SUPPORTING" | "ESTABLISHING" | "ESTABLISHED" | "WITHDRAWN";

export type OwnerReviewEvidenceRow = {
  /** OWNER_BOUND / OBSERVATION_ONLY signal token (closed vocab). */
  signalType: string;
  /** HIGH | MEDIUM | LOW (closed vocab). */
  confidence: string;
  /** true when this evidence row is not tombstoned. */
  live: boolean;
  observationCount: number;
};

export type OwnerReviewEventRow = {
  eventType: string;
  actor: string; // SYSTEM | ADMIN — a class, never which administrator
  previousState: string | null;
  newState: string;
  reason: string | null; // controlled withdrawal-reason vocab or null
  occurredAt: number; // epoch-ms transition time
};

export type OwnerReviewResult = {
  found: true;
  supportingEvidence: {
    // ---- CURRENT report telemetry (from saved_reports — MUTABLE: can shrink
    //      when reports are deleted or an anonymous report is later claimed) ----
    /** Verified Device Passports BOTH accounts CURRENTLY have a saved report under. */
    sharedVerifiedPassportCount: number;
    /** Of those, how many are actor_usage_tracking_version >= 1 AND not revoked. */
    completeTrackedPassportCount: number;
    /** Of those, how many are NOT (v1 AND not revoked) — legacy / incomplete / revoked. */
    incompletePassportCount: number;
    /** Max distinct authenticated account count across the currently-shared passports' saved_reports. */
    maxCurrentReportAccountCount: number;
    /** Max lifetime saved_reports count across the currently-shared passports. */
    maxCurrentSubmissionCount: number;

    // ---- HISTORICAL durable ledger evidence (from device_passport_actor_usage —
    //      append-only; NOT filtered by revocation; NO lifecycle event shrinks it,
    //      revoking a passport included) ----
    /** Distinct v1 passports EVER seen with BOTH accounts' actor pseudonyms on the ledger — revoked passports counted. */
    historicalJointV1ActorPassportCount: number;
    /** Max, over ALL those historical joint v1 passports, of the count of DISTINCT authenticated actor pseudonyms (household fan-out) — survives revocation. */
    maxHistoricalAuthenticatedActors: number;
    /** true iff ANY historical joint v1 passport ever recorded an anonymous ledger row — never reset by an anonymous-report claim or a revocation. */
    anonymousEverSeen: boolean;

    // ---- CURRENT eligibility view of that same ledger evidence (revoked passports
    //      excluded — a revoked passport is not valid for a CURRENT decision) ----
    /** Of the historical joint v1 passports, how many are NOT revoked. */
    activeJointV1ActorPassportCount: number;
    /** Of the historical joint v1 passports, how many ARE revoked. */
    revokedJointV1ActorPassportCount: number;
    /** activeJointV1ActorPassportCount >= 2 — the pair currently shares >= 2 independent NON-revoked verified devices. */
    crossPassportSupportingEvidence: boolean;

    /** false when DEVICE_PASSPORT_ACTOR_HMAC_KEY is unavailable — every ledger field above is then 0/false BY INABILITY, not by absence (never fabricated). */
    actorLedgerEvidenceAvailable: boolean;

    assessment: OwnerReviewSupportingAssessment;
    /** Why `assessment` is what it is — see OwnerReviewSupportBasis. */
    supportBasis: OwnerReviewSupportBasis;
  };
  establishingEvidence: {
    /** Live owner-bound HIGH evidence rows on the direct link (0 unless 0042 + key + an established link). */
    liveHighEvidenceRows: number;
    hasEstablishingEvidence: boolean;
  };
  ownerRelationship: {
    state: OwnerReviewOwnerLinkState;
    /** true IFF state === "ACTIVE" AND liveHighEvidenceRows > 0. */
    establishedOwnerRelationship: boolean;
    strongestConfidence: string | null;
    decidedBy: string | null; // SYSTEM | ADMIN
    withdrawnReason: string | null; // controlled vocab token
    generations: { a: number; b: number };
    evidence: OwnerReviewEvidenceRow[];
    events: OwnerReviewEventRow[]; // most recent OWNER_REVIEW_MAX_EVENTS, oldest-first
  };
  interpretation: { tier: OwnerReviewTier };
};

export type OwnerReviewResolution =
  | { kind: "found"; result: OwnerReviewResult }
  | { kind: "same_account" }
  | { kind: "not_found" } // one or both emails resolve to no account
  | { kind: "conflict"; which: "a" | "b"; count: number }; // >1 account for an email (should be impossible under ux_users_email)

/** Bound on the event history returned — the most recent N transitions. */
export const OWNER_REVIEW_MAX_EVENTS = 20;

type Exec = Pick<Client, "execute">;

function num(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : Number(value ?? 0) || 0;
}

async function tableExists(exec: Exec, name: string): Promise<boolean> {
  const rows = (
    await exec.execute({ sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", args: [name] })
  ).rows;
  return rows.length > 0;
}

/** Resolve a canonical account email to exactly one account id. */
async function resolveOneAccount(
  exec: Exec,
  canonicalEmail: string,
): Promise<{ kind: "found"; id: string } | { kind: "none" } | { kind: "conflict"; count: number }> {
  const rows = (await exec.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [canonicalEmail] })).rows;
  if (rows.length === 0) return { kind: "none" };
  if (rows.length > 1) return { kind: "conflict", count: rows.length };
  return { kind: "found", id: String((rows[0] as unknown as { id: string }).id) };
}

/** Distinct verified upload passport ids for one account, from the indexed saved_reports provenance. */
async function verifiedPassportsForAccount(exec: Exec, accountId: string): Promise<string[]> {
  const rows = (
    await exec.execute({
      sql: `SELECT DISTINCT verified_device_passport_id AS id
            FROM saved_reports
            WHERE user_id = ? AND verified_device_passport_id IS NOT NULL`,
      args: [accountId],
    })
  ).rows as unknown as { id: string }[];
  return rows.map((r) => String(r.id));
}

type CurrentPassportTelemetry = {
  trackingVersion: number;
  revoked: boolean;
  /** COUNT(DISTINCT user_id) over this passport's CURRENT saved_reports — mutable. */
  currentReportAccountCount: number;
  /** COUNT(*) over this passport's CURRENT saved_reports — mutable. */
  currentSubmissionCount: number;
};

/**
 * CURRENT (mutable) per-passport telemetry: the completeness marker + revoke
 * state from device_passports, plus the LIVE saved_reports aggregate for this
 * passport. These counts shrink when reports are deleted / anonymous reports
 * claimed — the reviewer keeps them explicitly under *Current*-named fields and
 * never lets them drive the durable assessment.
 */
async function currentPassportTelemetry(exec: Exec, passportId: string): Promise<CurrentPassportTelemetry | null> {
  const ppRow = (
    await exec.execute({
      sql: "SELECT actor_usage_tracking_version AS v, revoked_at FROM device_passports WHERE id = ?",
      args: [passportId],
    })
  ).rows[0] as unknown as { v: number | bigint | null; revoked_at: unknown } | undefined;
  if (!ppRow) return null;

  const agg = (
    await exec.execute({
      sql: `SELECT COUNT(*) AS submission_count, COUNT(DISTINCT user_id) AS distinct_accounts
            FROM saved_reports
            WHERE verified_device_passport_id = ?`,
      args: [passportId],
    })
  ).rows[0] as unknown as { submission_count: number | bigint; distinct_accounts: number | bigint };

  return {
    trackingVersion: ppRow.v == null ? 0 : num(ppRow.v),
    revoked: ppRow.revoked_at != null,
    currentReportAccountCount: num(agg.distinct_accounts),
    currentSubmissionCount: num(agg.submission_count),
  };
}

type JointV1LedgerFacts = {
  /** Historical: DISTINCT v1 passports EVER seen with both actor pseudonyms — revoked included. */
  historicalCount: number;
  /** Of those, how many are NOT currently revoked. */
  activeCount: number;
  /** Of those, how many ARE currently revoked. */
  revokedCount: number;
  /** Max DISTINCT authenticated actor pseudonyms across ALL historical joint passports (survives revocation). */
  maxHistoricalAuthenticatedActors: number;
  /** true iff ANY historical joint passport ever recorded an anonymous ledger row. */
  anonymousEverSeen: boolean;
};

/**
 * DURABLE pair-level cross-Passport facts, computed ENTIRELY from the
 * append-only device_passport_actor_usage ledger (no saved_reports) so no
 * report-lifecycle event can shrink them.
 *
 * REVOCATION IS NOT A FILTER HERE. The JOIN keeps only
 * `actor_usage_tracking_version >= 1` (a v0 passport's history is not proven
 * complete) but does NOT filter `revoked_at` — revoking a passport invalidates
 * it for a CURRENT decision, but must not erase the historical fact that A and
 * B were observed on it. Each returned row carries its own `revoked` flag; the
 * caller partitions historical / active / revoked counts.
 *
 * The `HAVING SUM(actor_key = ?A) > 0 AND SUM(actor_key = ?B) > 0` co-occurrence
 * predicate is the PAIR-relative equivalent of lib/device-shared-guard.ts's
 * private, REPORT/PASSPORT-relative `pairOtherPassportActorCoOccurrence`
 * (`actor_key IN (?A,?B) ... HAVING COUNT(DISTINCT actor_key) >= 2` — it takes
 * an `excludePassportId` and answers "how many OTHER passports"). Expressed
 * without an `actor_key IN` WHERE clause so the same GROUP can also count ALL
 * authenticated actors and spot anonymous rows; the per-passport
 * `SUM(is_anonymous=0)` / `MAX(is_anonymous=1)` at DEVICE_ACTOR_KEY_VERSION
 * mirror the guard's own loadPassportActorLedgerFacts.
 * tests/owner-review.test.mjs proves the co-occurrence count agrees with the
 * guard's exclusion semantics; device-shared-guard's behaviour is unchanged.
 */
async function jointV1PassportLedgerFacts(
  exec: Exec,
  actorKeyA: string,
  actorKeyB: string,
): Promise<JointV1LedgerFacts> {
  const rows = (
    await exec.execute({
      sql: `SELECT au.device_passport_id AS pid,
                   MAX(CASE WHEN dp.revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked,
                   SUM(CASE WHEN au.is_anonymous = 0 THEN 1 ELSE 0 END) AS auth_actors,
                   MAX(CASE WHEN au.is_anonymous = 1 THEN 1 ELSE 0 END) AS anon_seen
            FROM device_passport_actor_usage au
            JOIN device_passports dp
              ON dp.id = au.device_passport_id
             AND dp.actor_usage_tracking_version >= 1
            WHERE au.actor_key_version = ?
            GROUP BY au.device_passport_id
            HAVING SUM(CASE WHEN au.is_anonymous = 0 AND au.actor_key = ? THEN 1 ELSE 0 END) > 0
               AND SUM(CASE WHEN au.is_anonymous = 0 AND au.actor_key = ? THEN 1 ELSE 0 END) > 0`,
      args: [DEVICE_ACTOR_KEY_VERSION, actorKeyA, actorKeyB],
    })
  ).rows as unknown as { pid: string; revoked: number | bigint; auth_actors: number | bigint; anon_seen: number | bigint }[];

  let activeCount = 0;
  let revokedCount = 0;
  let maxHistoricalAuthenticatedActors = 0;
  let anonymousEverSeen = false;
  for (const r of rows) {
    if (num(r.revoked) > 0) revokedCount += 1;
    else activeCount += 1;
    const n = num(r.auth_actors);
    if (n > maxHistoricalAuthenticatedActors) maxHistoricalAuthenticatedActors = n;
    if (num(r.anon_seen) > 0) anonymousEverSeen = true;
  }
  return { historicalCount: rows.length, activeCount, revokedCount, maxHistoricalAuthenticatedActors, anonymousEverSeen };
}

/**
 * The link's evidence rows, bounded to only the four columns the review needs
 * — never materialising evidence_fingerprint / detail_json near the response
 * builder. Evidence rows per link are naturally few (keyed on
 * UNIQUE(link_id, signal_type, evidence_fingerprint) and re-observed via
 * UPSERT, not appended per cycle), so this is not LIMITed. A local SELECT
 * rather than owner-link-repo's readOwnerLinkEvidence, which the frozen
 * foundation must not be changed for.
 */
async function readOwnerLinkEvidenceForReview(exec: Exec, linkId: string): Promise<OwnerReviewEvidenceRow[]> {
  const rows = (
    await exec.execute({
      sql: `SELECT signal_type, confidence, withdrawn_at, observation_count
            FROM account_owner_link_evidence
            WHERE link_id = ?
            ORDER BY first_observed_at, id`,
      args: [linkId],
    })
  ).rows as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    signalType: String(r.signal_type),
    confidence: String(r.confidence),
    live: r.withdrawn_at == null,
    observationCount: num(r.observation_count),
  }));
}

/**
 * The most recent `limit` state-transition events for a link, bounded AT THE DB
 * QUERY (`ORDER BY id DESC LIMIT ?`) so the unbounded, ever-growing event log
 * is never materialised in full — id is the AUTOINCREMENT PK and canonical
 * ordering, so this is deterministic. Returned chronological (oldest-first) to
 * match the response contract. A local SELECT rather than owner-link-repo's
 * readOwnerLinkEvents, which the frozen foundation must not be changed for; it
 * also selects only the columns the review returns (no id / link_id / evidence_id).
 */
async function readRecentOwnerLinkEventsForReview(
  exec: Exec,
  linkId: string,
  limit: number,
): Promise<OwnerReviewEventRow[]> {
  const rows = (
    await exec.execute({
      sql: `SELECT event_type, previous_state, new_state, reason, actor, occurred_at
            FROM account_owner_link_events
            WHERE link_id = ?
            ORDER BY id DESC
            LIMIT ?`,
      args: [linkId, limit],
    })
  ).rows as unknown as Record<string, unknown>[];
  return rows
    .map((r) => ({
      eventType: String(r.event_type),
      actor: String(r.actor),
      previousState: r.previous_state == null ? null : String(r.previous_state),
      newState: String(r.new_state),
      reason: r.reason == null ? null : String(r.reason),
      occurredAt: num(r.occurred_at),
    }))
    .reverse();
}

/**
 * Assemble the pair-level owner-review evidence. `emailA` / `emailB` MUST
 * already be canonicalized (trim + lowercase) by the caller — the same rule
 * ux_users_email is written under. Read-only: no statement here mutates.
 */
export async function reviewOwnerEvidence(
  client: Client,
  params: { emailA: string; emailB: string },
): Promise<OwnerReviewResolution> {
  const a = await resolveOneAccount(client, params.emailA);
  if (a.kind === "conflict") return { kind: "conflict", which: "a", count: a.count };
  const b = await resolveOneAccount(client, params.emailB);
  if (b.kind === "conflict") return { kind: "conflict", which: "b", count: b.count };
  if (a.kind === "none" || b.kind === "none") return { kind: "not_found" };
  if (a.id === b.id) return { kind: "same_account" };

  const accountIdA = a.id;
  const accountIdB = b.id;

  // ---- Device Passport supporting evidence (independent of drizzle/0042) ----
  const [passportsA, passportsB] = await Promise.all([
    verifiedPassportsForAccount(client, accountIdA),
    verifiedPassportsForAccount(client, accountIdB),
  ]);
  const bSet = new Set(passportsB);
  const sharedPassports = passportsA.filter((id) => bSet.has(id));

  // ---- CURRENT (mutable) saved_reports telemetry over the currently-shared passports ----
  let completeTrackedPassportCount = 0;
  let incompletePassportCount = 0;
  let maxCurrentReportAccountCount = 0;
  let maxCurrentSubmissionCount = 0;
  for (const passportId of sharedPassports) {
    const t = await currentPassportTelemetry(client, passportId);
    if (!t) {
      incompletePassportCount += 1;
      continue;
    }
    if (t.trackingVersion >= 1 && !t.revoked) completeTrackedPassportCount += 1;
    else incompletePassportCount += 1;
    if (t.currentReportAccountCount > maxCurrentReportAccountCount) maxCurrentReportAccountCount = t.currentReportAccountCount;
    if (t.currentSubmissionCount > maxCurrentSubmissionCount) maxCurrentSubmissionCount = t.currentSubmissionCount;
  }

  // ---- DURABLE ledger evidence (append-only; revocation is NOT a filter here) ----
  const obsA = resolveActorObservation(accountIdA);
  const obsB = resolveActorObservation(accountIdB);
  const actorLedgerEvidenceAvailable = obsA != null && !obsA.isAnonymous && obsB != null && !obsB.isAnonymous;
  const ledger = actorLedgerEvidenceAvailable
    ? await jointV1PassportLedgerFacts(client, obsA.actorKey, obsB.actorKey)
    : { historicalCount: 0, activeCount: 0, revokedCount: 0, maxHistoricalAuthenticatedActors: 0, anonymousEverSeen: false };

  // current cross-Passport support counts only NON-revoked joint v1 passports.
  const crossPassportSupportingEvidence = ledger.activeCount >= 2;

  // WHY a SUPPORTING_ONLY assessment exists (see OwnerReviewSupportBasis):
  //   - >= 1 NON-revoked joint v1 passport            -> ACTIVE_DURABLE_LEDGER
  //   - joint v1 history exists but all revoked         -> HISTORICAL_ONLY_REVOKED
  //   - no ledger co-occurrence, but a current shared
  //     verified passport (saved_reports, mutable)      -> CURRENT_SHARED_PASSPORT_FALLBACK
  //   - nothing                                         -> NONE
  let supportBasis: OwnerReviewSupportBasis;
  if (ledger.activeCount >= 1) supportBasis = "ACTIVE_DURABLE_LEDGER";
  else if (ledger.historicalCount >= 1) supportBasis = "HISTORICAL_ONLY_REVOKED";
  else if (sharedPassports.length >= 1) supportBasis = "CURRENT_SHARED_PASSPORT_FALLBACK";
  else supportBasis = "NONE";

  const supportingEvidence: OwnerReviewResult["supportingEvidence"] = {
    sharedVerifiedPassportCount: sharedPassports.length,
    completeTrackedPassportCount,
    incompletePassportCount,
    maxCurrentReportAccountCount,
    maxCurrentSubmissionCount,
    historicalJointV1ActorPassportCount: ledger.historicalCount,
    maxHistoricalAuthenticatedActors: ledger.maxHistoricalAuthenticatedActors,
    anonymousEverSeen: ledger.anonymousEverSeen,
    activeJointV1ActorPassportCount: ledger.activeCount,
    revokedJointV1ActorPassportCount: ledger.revokedCount,
    crossPassportSupportingEvidence,
    actorLedgerEvidenceAvailable,
    assessment: supportBasis === "NONE" ? "NONE" : "SUPPORTING_ONLY",
    supportBasis,
  };

  // ---- Direct owner-link state (drizzle/0042) ----
  let state: OwnerReviewOwnerLinkState;
  let strongestConfidence: string | null = null;
  let decidedBy: string | null = null;
  let withdrawnReason: string | null = null;
  let evidence: OwnerReviewEvidenceRow[] = [];
  let events: OwnerReviewEventRow[] = [];
  let liveHighEvidenceRows = 0;
  const generations = { a: 0, b: 0 };

  if (!(await tableExists(client, "account_owner_links"))) {
    state = "SCHEMA_ABSENT";
  } else if (!isOwnerLinkInferenceAvailable()) {
    state = "KEY_UNAVAILABLE";
  } else {
    generations.a = await readAccountOwnerLinkGeneration(client, accountIdA, OWNER_LINK_KEY_VERSION);
    generations.b = await readAccountOwnerLinkGeneration(client, accountIdB, OWNER_LINK_KEY_VERSION);
    const pair = deriveOwnerRefPair(accountIdA, accountIdB, OWNER_LINK_KEY_VERSION);
    const link = pair ? await readDirectOwnerLink(client, pair) : null;
    if (!link) {
      state = "NONE";
    } else {
      state = link.status; // "ACTIVE" | "WITHDRAWN"
      strongestConfidence = link.strongestConfidence;
      decidedBy = link.decidedBy;
      withdrawnReason = link.withdrawnReason;
      evidence = await readOwnerLinkEvidenceForReview(client, link.id);
      liveHighEvidenceRows = evidence.filter(
        (e) => e.live && evidenceCanEstablishActiveLink(e.signalType, e.confidence as OwnerLinkConfidence),
      ).length;
      events = await readRecentOwnerLinkEventsForReview(client, link.id, OWNER_REVIEW_MAX_EVENTS);
    }
  }

  const hasEstablishingEvidence = liveHighEvidenceRows > 0;
  const establishedOwnerRelationship = state === "ACTIVE" && hasEstablishingEvidence;

  let tier: OwnerReviewTier;
  if (establishedOwnerRelationship) tier = "ESTABLISHED";
  else if (state === "WITHDRAWN") tier = "WITHDRAWN";
  else if (hasEstablishingEvidence) tier = "ESTABLISHING";
  else if (supportingEvidence.assessment === "SUPPORTING_ONLY") tier = "SUPPORTING";
  else tier = "NONE";

  return {
    kind: "found",
    result: {
      found: true,
      supportingEvidence,
      establishingEvidence: { liveHighEvidenceRows, hasEstablishingEvidence },
      ownerRelationship: {
        state,
        establishedOwnerRelationship,
        strongestConfidence,
        decidedBy,
        withdrawnReason,
        generations,
        evidence,
        events,
      },
      interpretation: { tier },
    },
  };
}
