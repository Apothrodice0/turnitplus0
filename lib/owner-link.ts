import { createHmac } from "node:crypto";

/**
 * Direct owner-link FOUNDATION — the PURE layer: the keyed account pseudonym,
 * the canonical unordered pair, the signal vocabulary, and the pure rules that
 * decide whether a piece of evidence may, by itself, establish an ACTIVE owner
 * link. No database, no I/O; the only environment read is the dedicated HMAC
 * secret (fresh on every call, no caching — the same convention
 * lib/device-passport-actor-ledger.ts follows). The DB helpers live in
 * lib/owner-link-repo.ts.
 *
 * WHAT AN OWNER LINK IS
 * A DIRECT owner link between account A and account B is durable evidence that
 * the two accounts share the same human owner. In v1 an owner link becomes
 * ACTIVE only from HIGH-confidence owner-bound evidence — currently, in
 * practice, an ADMIN_MANUAL link. Owner-bound signals that a producer can only
 * assert at MEDIUM (a shared verified Device Passport, a cross-Passport actor
 * co-occurrence, a verified shared phone / recovery email / OAuth subject /
 * payment account or instrument, …) are SUPPORTING evidence: they corroborate,
 * they attach to an existing link, but one of them alone never establishes or
 * keeps ACTIVE. A HIGH direct owner-bound signal MAY later make the other
 * account SELF / 0 for the unified similarity score — but NOT in this phase.
 * Nothing here is wired into scoring.
 *
 * WHAT IT IS NOT
 *   - NOT transitive: an A-B link and a B-C link never imply an A-C link. This
 *     module offers no closure helper and never will in this phase.
 *   - NOT vetoable by telemetry: shared-device fan-out, anonymous passport
 *     history, deviceDistinctAccounts, and IP / coarse-location / timing
 *     co-occurrence are OBSERVATION-ONLY. They are retained as LOW evidence for
 *     admin / audit but can never create, activate, or withdraw a direct link.
 *   - NOT created by IP / location / timing alone, ever.
 *
 * PRIVACY: a raw account id is never returned by ownerAccountRef (it returns an
 * HMAC pseudonym or null), never stored by the repo layer, never logged.
 * evidence_fingerprint values are themselves HMAC / domain-separated
 * (ownerLinkEvidenceFingerprint). detail_json is bounded to counts / booleans /
 * short enum tokens (boundOwnerLinkDetail) — never free text, never an id.
 */

/** The dedicated owner-link HMAC secret's env var. No default, no real secret shipped. */
export const OWNER_LINK_HMAC_KEY_ENV = "OWNER_LINK_HMAC_KEY";

/**
 * Domain separator prepended to the account id before the HMAC. Deliberately
 * DISTINCT from lib/device-passport-actor-ledger.ts's
 * DEVICE_ACTOR_KEY_DOMAIN_SEPARATOR ("TURNITPLUS_DEVICE_ACTOR_V1") and from a
 * different env key entirely, so an owner-link ref can never be mistaken for,
 * or collide with, a Device Passport actor key computed for the same account.
 * The HMAC input is exactly OWNER_LINK_ACCOUNT_REF_DOMAIN + accountId — i.e.
 * "TP_OWNER_LINK_V1:" + accountId.
 */
export const OWNER_LINK_ACCOUNT_REF_DOMAIN = "TP_OWNER_LINK_V1:";

/** Domain separator for evidence fingerprints — a second, distinct namespace from the account ref. */
export const OWNER_LINK_EVIDENCE_FINGERPRINT_DOMAIN = "TP_OWNER_LINK_EVIDENCE_V1:";

/**
 * Which keying generation produced an account ref / link row. Bump only on a
 * real keying-scheme change.
 *
 * HMAC KEY ROTATION — v1 HAS NO ONLINE ROTATION PATH.
 * ownerAccountRef / ownerLinkEvidenceFingerprint always use the single current
 * OWNER_LINK_HMAC_KEY; they do NOT select a key by key_version and there is no
 * keyring. Consequently, changing OWNER_LINK_HMAC_KEY:
 *   - makes every existing account_owner_links / _evidence row unmatchable (the
 *     old pseudonyms can no longer be re-derived), and
 *   - makes readAccountOwnerLinkGeneration silently return 0 for every account
 *     (the state row is keyed by the OLD pseudonym), dropping the monotonic
 *     counter and corrupting the owner_link_generation staleness comparison.
 * Rotation is therefore a SEPARATELY REVIEWED migration / rebuild procedure, not
 * an env-var swap. key_version exists so that procedure can be written without
 * losing history — it is NOT evidence that rotation is already safe. This module
 * deliberately exports no rotation / keyring helper; drizzle/0042 and
 * tests/owner-link-foundation.test.mjs both pin this limitation so it stays
 * visible.
 *   NOTE for that future procedure: account_owner_link_events rows reference
 *   account_owner_links.id / account_owner_link_evidence.id (opaque randomUUID
 *   values, NOT key-derived), via ON DELETE RESTRICT foreign keys. A re-key must
 *   therefore re-key the account_ref_* / evidence_fingerprint COLUMNS IN PLACE
 *   (preserving every row's id), or migrate the account_owner_link_events
 *   link_id / evidence_id references in lockstep — a naive drop-and-recreate of
 *   the parent rows is both blocked by the RESTRICT FKs and would orphan the
 *   audit log.
 *
 * GENERATION SCOPE — DIRECT PAIRS ONLY.
 * account_owner_link_state.link_generation (and the report-account value stamped
 * into report_historical_match_snapshots.owner_link_generation) is sufficient
 * ONLY while owner relationships are direct pairs: every direct-pair change has
 * the affected account as one endpoint, so its own generation always advances.
 * A future TRANSITIVE owner-cluster phase MUST add a cluster-level generation
 * (or equivalent closure-wide invalidation) — a new B-C link would otherwise
 * change A's effective cluster without touching A's own generation.
 */
export const OWNER_LINK_KEY_VERSION = 1;

export type OwnerLinkConfidence = "HIGH" | "MEDIUM" | "LOW";
export type OwnerLinkStatus = "ACTIVE" | "WITHDRAWN";
export type OwnerLinkDecidedBy = "SYSTEM" | "ADMIN";

/**
 * OWNER-BOUND signals — a signal whose NATURE is about the same human owner
 * (not mere co-location telemetry). Being owner-bound does NOT make a signal
 * ownership-establishing: only a HIGH-confidence owner-bound row activates a
 * direct owner link (evidenceCanEstablishActiveLink — v1 threshold). A MEDIUM
 * owner-bound row is SUPPORTING evidence only. This phase collects NO new source
 * data for any of them; the vocabulary is defined now so the storage and helper
 * layer is complete.
 */
export const OWNER_BOUND_SIGNAL_TYPES = [
  "SHARED_DEVICE_PASSPORT",
  "SHARED_PASSPORT_ACTOR_COOCCURRENCE",
  "CROSS_PASSPORT_ACTOR_COOCCURRENCE",
  "SHARED_CORPUS_DEVICE_PROVENANCE",
  "VERIFIED_PHONE",
  "VERIFIED_RECOVERY_EMAIL",
  "OAUTH_PROVIDER_SUBJECT",
  "PAYMENT_ACCOUNT",
  "PAYMENT_INSTRUMENT",
  "ADMIN_MANUAL",
] as const;

/**
 * OBSERVATION-ONLY signals — recorded for admin / audit as LOW evidence on an
 * ALREADY-EXISTING link, but NEVER able to create, activate, or withdraw one,
 * at any confidence. This is where shared-device fan-out / anonymous history /
 * IP / location / timing co-occurrence land.
 */
export const OBSERVATION_ONLY_SIGNAL_TYPES = [
  "DEVICE_FINGERPRINT",
  "IP_COOCCURRENCE",
  "COARSE_LOCATION",
  "TIMING",
] as const;

export type OwnerBoundSignalType = (typeof OWNER_BOUND_SIGNAL_TYPES)[number];
export type ObservationOnlySignalType = (typeof OBSERVATION_ONLY_SIGNAL_TYPES)[number];
export type OwnerLinkSignalType = OwnerBoundSignalType | ObservationOnlySignalType;

const OWNER_BOUND_SET: ReadonlySet<string> = new Set(OWNER_BOUND_SIGNAL_TYPES);
const OBSERVATION_ONLY_SET: ReadonlySet<string> = new Set(OBSERVATION_ONLY_SIGNAL_TYPES);

export function isOwnerBoundSignal(signalType: string): signalType is OwnerBoundSignalType {
  return OWNER_BOUND_SET.has(signalType);
}

export function isObservationOnlySignal(signalType: string): signalType is ObservationOnlySignalType {
  return OBSERVATION_ONLY_SET.has(signalType);
}

export function isKnownOwnerLinkSignal(signalType: string): signalType is OwnerLinkSignalType {
  return OWNER_BOUND_SET.has(signalType) || OBSERVATION_ONLY_SET.has(signalType);
}

/** The full closed vocabulary in one array — the exact set drizzle/0042's signal_type CHECK must mirror. */
export const ALL_OWNER_LINK_SIGNAL_TYPES: readonly OwnerLinkSignalType[] = [
  ...OWNER_BOUND_SIGNAL_TYPES,
  ...OBSERVATION_ONLY_SIGNAL_TYPES,
];

// ---------------------------------------------------------------------------
// withdrawal reasons — a fixed controlled vocabulary, never free text
// ---------------------------------------------------------------------------

/**
 * The ONLY permitted values for account_owner_links.withdrawn_reason and
 * account_owner_link_evidence.withdrawn_reason. Free text is forbidden at BOTH
 * layers: assertOwnerLinkWithdrawalReason() below (application) and a
 * DB CHECK constraint in drizzle/0042 (storage backstop). NULL is allowed — a
 * live (non-withdrawn) link or evidence row. Keep this list identical to the
 * two CHECK lists in drizzle/0042.
 *
 *   MANUAL_REVIEW           an admin / analyst withdrew it after review
 *   REVOKED                 the underlying owner-bound signal was revoked
 *   NO_QUALIFYING_EVIDENCE  automatic: no live owner-bound HIGH evidence remains
 *                           (the v1 establishment threshold — a lone MEDIUM/
 *                           supporting row does not keep a link ACTIVE)
 *   SUPERSEDED              replaced by another link / a re-keyed pair
 *   ADMIN_CORRECTION        an admin corrected a link recorded in error
 */
export const OWNER_LINK_WITHDRAWAL_REASONS = [
  "MANUAL_REVIEW",
  "REVOKED",
  "NO_QUALIFYING_EVIDENCE",
  "SUPERSEDED",
  "ADMIN_CORRECTION",
] as const;

export type OwnerLinkWithdrawalReason = (typeof OWNER_LINK_WITHDRAWAL_REASONS)[number];

const OWNER_LINK_WITHDRAWAL_REASON_SET: ReadonlySet<string> = new Set(OWNER_LINK_WITHDRAWAL_REASONS);

export function isOwnerLinkWithdrawalReason(value: unknown): value is OwnerLinkWithdrawalReason {
  return typeof value === "string" && OWNER_LINK_WITHDRAWAL_REASON_SET.has(value);
}

/**
 * Normalize a caller-supplied withdrawal reason to a permitted token, or throw.
 * Every repo write path runs this first, so a raw email / UUID / account id /
 * free note can never reach a withdrawn_reason column even before the DB CHECK
 * would reject it.
 */
export function assertOwnerLinkWithdrawalReason(value: string): OwnerLinkWithdrawalReason {
  if (isOwnerLinkWithdrawalReason(value)) return value;
  throw new Error(
    `Invalid owner-link withdrawal reason ${JSON.stringify(value)} — must be one of ${OWNER_LINK_WITHDRAWAL_REASONS.join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// state-transition event vocabulary (account_owner_link_events, drizzle/0042)
// ---------------------------------------------------------------------------

/**
 * The append-only state-transition log's event types.
 *
 * WHY IT EXISTS: the live account_owner_links / account_owner_link_evidence rows
 * carry CURRENT state only. Reviving a tombstoned evidence row necessarily
 * clears its own withdrawn_at / withdrawn_reason (a live row MUST read as live,
 * or every `WHERE withdrawn_at IS NULL` query and resolveLinkStatusFromEvidence
 * break) — so the live row cannot also be the history. account_owner_link_events
 * records every meaningful ACTIVE <-> WITHDRAWN transition (plus link / evidence
 * genesis) as one immutable row, so "was this withdrawn / when / why / how many
 * cycles / by which actor CLASS" stays answerable across any number of later
 * state changes. Rows here are NEVER updated or deleted.
 *
 *   LINK_CREATED          a link row was created ACTIVE (previous_state null)
 *   LINK_WITHDRAWN        a link went ACTIVE -> WITHDRAWN
 *   LINK_REACTIVATED      a link went WITHDRAWN -> ACTIVE
 *   EVIDENCE_ADDED        a new evidence row was inserted (previous_state null)
 *   EVIDENCE_WITHDRAWN    an evidence row was tombstoned (live -> withdrawn)
 *   EVIDENCE_REACTIVATED  a tombstoned evidence row was revived by a fresh observation
 *
 * ACTOR IS A CLASS, NOT AN IDENTITY: account_owner_link_events.actor is exactly
 * SYSTEM (an automatic transition) or ADMIN (a human admin action) — it is NOT
 * proof of WHICH administrator. This foundation deliberately stores no admin
 * identity: the only existing admin-audit trail (corpus_admission_admin_audit_log)
 * records a RAW users.id, which this log's privacy rules forbid. A later
 * admin-producer phase that needs per-administrator attribution can add an
 * OPTIONAL actor_ref column populated with ownerAccountRef(adminAccountId) — the
 * same HMAC pseudonym already used for the linked accounts — but that is out of
 * scope here (no admin producer exists, and it is a new field).
 *
 * NOT logged: a plain repeat observation of already-live evidence, or a
 * strongest_confidence change that does not cross the ACTIVE/WITHDRAWN boundary
 * — those are not state transitions.
 */
export const OWNER_LINK_EVENT_TYPES = [
  "LINK_CREATED",
  "LINK_WITHDRAWN",
  "LINK_REACTIVATED",
  "EVIDENCE_ADDED",
  "EVIDENCE_WITHDRAWN",
  "EVIDENCE_REACTIVATED",
] as const;

export type OwnerLinkEventType = (typeof OWNER_LINK_EVENT_TYPES)[number];

const OWNER_LINK_EVENT_TYPE_SET: ReadonlySet<string> = new Set(OWNER_LINK_EVENT_TYPES);

export function isOwnerLinkEventType(value: unknown): value is OwnerLinkEventType {
  return typeof value === "string" && OWNER_LINK_EVENT_TYPE_SET.has(value);
}

/**
 * The two states a link — and, derived from withdrawn_at, an evidence row — can
 * be in. previous_state is additionally allowed to be NULL (genesis events).
 */
export const OWNER_LINK_EVENT_STATES = ["ACTIVE", "WITHDRAWN"] as const;

export type OwnerLinkEventState = (typeof OWNER_LINK_EVENT_STATES)[number];

const OWNER_LINK_EVENT_STATE_SET: ReadonlySet<string> = new Set(OWNER_LINK_EVENT_STATES);

export function isOwnerLinkEventState(value: unknown): value is OwnerLinkEventState {
  return typeof value === "string" && OWNER_LINK_EVENT_STATE_SET.has(value);
}

// ---------------------------------------------------------------------------
// event SHAPE invariant — each of the six types has exactly ONE legal shape
// ---------------------------------------------------------------------------

export type OwnerLinkEventScope = "LINK" | "EVIDENCE";

/**
 * The ONE legal shape per event type: which endpoint it is about (LINK => no
 * evidence_id, EVIDENCE => evidence_id required), the exact previous_state /
 * new_state, and whether a controlled `reason` is required. This is the
 * single source of truth mirrored by drizzle/0042's account_owner_link_events
 * shape CHECK — keep the two in lockstep (a test cross-checks them). This is a
 * fixed table for six known event types, NOT a state-machine framework.
 */
export const OWNER_LINK_EVENT_SHAPES: Record<
  OwnerLinkEventType,
  {
    scope: OwnerLinkEventScope;
    previousState: OwnerLinkEventState | null;
    newState: OwnerLinkEventState;
    reasonRequired: boolean;
  }
> = {
  LINK_CREATED: { scope: "LINK", previousState: null, newState: "ACTIVE", reasonRequired: false },
  LINK_WITHDRAWN: { scope: "LINK", previousState: "ACTIVE", newState: "WITHDRAWN", reasonRequired: true },
  LINK_REACTIVATED: { scope: "LINK", previousState: "WITHDRAWN", newState: "ACTIVE", reasonRequired: false },
  EVIDENCE_ADDED: { scope: "EVIDENCE", previousState: null, newState: "ACTIVE", reasonRequired: false },
  EVIDENCE_WITHDRAWN: { scope: "EVIDENCE", previousState: "ACTIVE", newState: "WITHDRAWN", reasonRequired: true },
  EVIDENCE_REACTIVATED: { scope: "EVIDENCE", previousState: "WITHDRAWN", newState: "ACTIVE", reasonRequired: false },
};

/**
 * Whether an event type carries a controlled withdrawal reason (== requires one:
 * for these six types a reason is either mandatory or forbidden, never optional).
 */
export function ownerLinkEventTypeAllowsReason(eventType: OwnerLinkEventType): boolean {
  return OWNER_LINK_EVENT_SHAPES[eventType]?.reasonRequired === true;
}

export type OwnerLinkEventShapeInput = {
  eventType: OwnerLinkEventType;
  /** the actual evidence_id that will be written (null => none) */
  evidenceId: string | null;
  previousState: OwnerLinkEventState | null;
  newState: OwnerLinkEventState;
  /** the actual reason that will be written (null => none) */
  reason: OwnerLinkWithdrawalReason | null;
};

/**
 * App-side mirror of drizzle/0042's account_owner_link_events shape CHECK: throw
 * unless (eventType, evidence_id presence, previous_state, new_state, reason
 * presence) is the single legal combination for that event type. `reason` value
 * validity (controlled vocabulary) is a separate check
 * (assertOwnerLinkWithdrawalReason); this only checks PRESENCE/ABSENCE and the
 * state fields. insertOwnerLinkEvent runs this before every INSERT.
 */
export function assertOwnerLinkEventShape(e: OwnerLinkEventShapeInput): void {
  const spec = OWNER_LINK_EVENT_SHAPES[e.eventType];
  if (!spec) throw new Error(`Unknown owner-link event type ${JSON.stringify(e.eventType)}`);
  const wantsEvidence = spec.scope === "EVIDENCE";
  if (wantsEvidence !== (e.evidenceId != null)) {
    throw new Error(
      `owner-link event ${e.eventType} requires evidence_id ${wantsEvidence ? "NOT NULL" : "NULL"}`,
    );
  }
  if (e.previousState !== spec.previousState) {
    throw new Error(
      `owner-link event ${e.eventType} requires previous_state ${spec.previousState ?? "NULL"}, got ${e.previousState ?? "NULL"}`,
    );
  }
  if (e.newState !== spec.newState) {
    throw new Error(`owner-link event ${e.eventType} requires new_state ${spec.newState}, got ${e.newState}`);
  }
  if (spec.reasonRequired !== (e.reason != null)) {
    throw new Error(
      `owner-link event ${e.eventType} requires reason ${spec.reasonRequired ? "NOT NULL" : "NULL"}`,
    );
  }
}

// ---------------------------------------------------------------------------
// keyed pseudonyms
// ---------------------------------------------------------------------------

/** The dedicated owner-link HMAC key, or null when unset / blank. Read fresh every call so tests can toggle it. */
export function getOwnerLinkHmacKey(): string | null {
  const raw = process.env[OWNER_LINK_HMAC_KEY_ENV];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Whether owner-link inference is possible at all in this process. FALSE (key
 * missing) must FAIL CLOSED everywhere: no ref is derived, no link row is
 * written, and readAccountOwnerLinkGeneration resolves to 0.
 */
export function isOwnerLinkInferenceAvailable(): boolean {
  return getOwnerLinkHmacKey() !== null;
}

/**
 * The stable keyed pseudonym for one account —
 * HMAC-SHA256(OWNER_LINK_HMAC_KEY, "TP_OWNER_LINK_V1:" + accountId) lowercase
 * hex. Returns null when the key is unavailable or accountId is not a non-empty
 * string. NEVER returns, and the value can never be reversed to, the raw id.
 */
export function ownerAccountRef(accountId: string): string | null {
  if (typeof accountId !== "string" || accountId.length === 0) return null;
  const key = getOwnerLinkHmacKey();
  if (!key) return null;
  return createHmac("sha256", key)
    .update(`${OWNER_LINK_ACCOUNT_REF_DOMAIN}${accountId}`, "utf8")
    .digest("hex");
}

export type OwnerRefPair = {
  /** the lexicographically smaller ref */
  lo: string;
  /** the lexicographically larger ref */
  hi: string;
  keyVersion: number;
};

/**
 * The canonical unordered pair of two already-derived refs. {A,B} and {B,A}
 * produce the identical result. Returns null when either ref is not a non-empty
 * string or the two are equal (a self-pair is not a link).
 */
export function canonicalOwnerRefPair(
  refA: string,
  refB: string,
  keyVersion: number = OWNER_LINK_KEY_VERSION,
): OwnerRefPair | null {
  if (typeof refA !== "string" || typeof refB !== "string") return null;
  if (refA.length === 0 || refB.length === 0) return null;
  if (refA === refB) return null;
  const [lo, hi] = refA < refB ? [refA, refB] : [refB, refA];
  return { lo, hi, keyVersion };
}

/**
 * Derive both refs from raw account ids and return their canonical unordered
 * pair. Null when the key is unavailable (fail closed) or the two ids resolve
 * to the same ref (same account).
 */
export function deriveOwnerRefPair(
  accountIdA: string,
  accountIdB: string,
  keyVersion: number = OWNER_LINK_KEY_VERSION,
): OwnerRefPair | null {
  const a = ownerAccountRef(accountIdA);
  const b = ownerAccountRef(accountIdB);
  if (!a || !b) return null;
  return canonicalOwnerRefPair(a, b, keyVersion);
}

/**
 * A keyed, domain-separated fingerprint for one piece of evidence, used as the
 * dedup key alongside (link_id, signal_type). `components` are the bounded,
 * non-identifying discriminators of the observation (e.g. a passport ref, an
 * OAuth provider name) — they are HMAC'd, never stored raw. Returns null when
 * the key is unavailable or any component is not a string.
 */
export function ownerLinkEvidenceFingerprint(
  signalType: OwnerLinkSignalType,
  components: readonly string[],
): string | null {
  const key = getOwnerLinkHmacKey();
  if (!key) return null;
  // Fail closed on a non-string component rather than coerce it.
  if (!Array.isArray(components) || !components.every((c) => typeof c === "string")) return null;
  // CANONICALIZATION: JSON.stringify an explicit array literal so ambiguous
  // inputs cannot collide. A bare join on a single delimiter made ["a b","c"]
  // and ["a","b c"] produce the same digest; JSON encoding preserves every
  // element boundary and escapes any quote / backslash / control char inside a
  // component. Deterministic: identical inputs always yield the identical digest.
  const payload = JSON.stringify([OWNER_LINK_EVIDENCE_FINGERPRINT_DOMAIN + signalType, ...components]);
  return createHmac("sha256", key).update(payload, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// pure confidence / link-eligibility rules
// ---------------------------------------------------------------------------

const CONFIDENCE_RANK: Record<OwnerLinkConfidence, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export function isOwnerLinkConfidence(value: unknown): value is OwnerLinkConfidence {
  return value === "HIGH" || value === "MEDIUM" || value === "LOW";
}

/** The stronger of two confidences. */
export function strongerConfidence(a: OwnerLinkConfidence, b: OwnerLinkConfidence): OwnerLinkConfidence {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
}

/** The strongest confidence across a list, or null for an empty list. Unknown values are ignored. */
export function strongestConfidenceOf(confidences: readonly (OwnerLinkConfidence | string)[]): OwnerLinkConfidence | null {
  let best: OwnerLinkConfidence | null = null;
  for (const c of confidences) {
    if (!isOwnerLinkConfidence(c)) continue;
    best = best === null ? c : strongerConfidence(best, c);
  }
  return best;
}

/**
 * ESTABLISHMENT THRESHOLD (v1): owner-bound is NOT the same as
 * ownership-establishing.
 *
 *   LOW    = weak / observational
 *   MEDIUM = SUPPORTING owner evidence — corroborates an ownership finding but
 *            CANNOT, alone, create or keep an ACTIVE owner relationship
 *   HIGH   = ownership-ESTABLISHING evidence — the ONLY tier that activates a
 *            direct owner link in this phase
 *
 * A single MEDIUM owner-bound row (e.g. SHARED_DEVICE_PASSPORT or
 * CROSS_PASSPORT_ACTOR_COOCCURRENCE) is household/family-ambiguous: one person's
 * two accounts and two related people sharing two devices produce identical
 * evidence, and a false owner link can later suppress genuine plagiarism as
 * SELF / 0. Precision over recall => MEDIUM never establishes on its own. This
 * is a GENERAL, fail-closed confidence boundary — no signal type is
 * special-cased.
 *
 * ADMIN_MANUAL at HIGH is currently the ONLY practical path to an ACTIVE link.
 * Future automatic identity producers (VERIFIED_PHONE, OAUTH_PROVIDER_SUBJECT,
 * PAYMENT_*, …) must NOT be promoted to HIGH merely for being owner-bound —
 * each requires its own separate confidence review before it may emit HIGH.
 *
 * The load-bearing pure rule: can THIS one piece of evidence, by itself,
 * establish (or keep) an ACTIVE direct owner link?
 *   - observation-only signal            -> NO, at any confidence.
 *   - owner-bound signal, LOW or MEDIUM   -> NO (MEDIUM = supporting only).
 *   - owner-bound signal, HIGH            -> YES.
 * Any non-HIGH value (including an unrecognised one) fails closed.
 */
export function evidenceCanEstablishActiveLink(signalType: string, confidence: OwnerLinkConfidence): boolean {
  if (!isOwnerBoundSignal(signalType)) return false;
  return confidence === "HIGH";
}

export type LinkStatusResolution = {
  status: OwnerLinkStatus;
  strongestConfidence: OwnerLinkConfidence | null;
  /** how many of the live evidence rows are owner-bound AND HIGH (the v1 establishment threshold) */
  qualifyingCount: number;
};

/**
 * Resolve a link's effective status from its LIVE (non-withdrawn) evidence:
 *   - ACTIVE iff at least one live row is owner-bound at HIGH (the v1
 *     establishment threshold — see evidenceCanEstablishActiveLink).
 *   - WITHDRAWN otherwise: no live evidence at all, OR only observation-only /
 *     LOW / MEDIUM (supporting) owner-bound evidence remains. So an ACTIVE link
 *     that loses its last live HIGH row drops to WITHDRAWN even while MEDIUM
 *     supporting evidence still lives.
 * strongestConfidence is the max across ALL live rows (supporting / observation-
 * only rows included — retained for admin / audit even though it cannot activate
 * the link).
 */
export function resolveLinkStatusFromEvidence(
  liveEvidence: readonly { signalType: string; confidence: OwnerLinkConfidence }[],
): LinkStatusResolution {
  let qualifyingCount = 0;
  for (const e of liveEvidence) {
    if (evidenceCanEstablishActiveLink(e.signalType, e.confidence)) qualifyingCount += 1;
  }
  return {
    status: qualifyingCount > 0 ? "ACTIVE" : "WITHDRAWN",
    strongestConfidence: strongestConfidenceOf(liveEvidence.map((e) => e.confidence)),
    qualifyingCount,
  };
}

// ---------------------------------------------------------------------------
// the two concrete evidence-semantics rules for this phase
// ---------------------------------------------------------------------------

/**
 * The same verified Device Passport used by both accounts -> a direct MEDIUM
 * owner-bound evidence row (signal SHARED_DEVICE_PASSPORT). MEDIUM = SUPPORTING
 * only: one shared/public browser produces this shape with two unrelated
 * accounts, so it never establishes an ACTIVE link on its own (v1 threshold is
 * HIGH — evidenceCanEstablishActiveLink). Shared-device fan-out / anonymous
 * history telemetry MUST NOT veto its RECORDING as supporting evidence.
 */
export function sharedVerifiedPassportEvidenceConfidence(): OwnerLinkConfidence {
  return "MEDIUM";
}

/**
 * A cross-Passport actor co-occurrence count of >= 1 -> a direct MEDIUM
 * owner-bound evidence row (signal CROSS_PASSPORT_ACTOR_COOCCURRENCE). A count
 * of 0 (or a non-finite value) yields null — nothing to record. MEDIUM =
 * SUPPORTING only: a two-device household in which two related people each use
 * both machines produces the identical evidence to one person's two accounts,
 * so it never establishes an ACTIVE link on its own (v1 threshold is HIGH). A
 * producer of this signal needs an independent HIGH corroboration or an
 * ADMIN_MANUAL confirmation before an owner link can go ACTIVE.
 */
export function crossPassportActorCooccurrenceConfidence(cooccurrenceCount: number): OwnerLinkConfidence | null {
  return Number.isFinite(cooccurrenceCount) && cooccurrenceCount >= 1 ? "MEDIUM" : null;
}

// ---------------------------------------------------------------------------
// bounded detail_json
// ---------------------------------------------------------------------------

const MAX_DETAIL_KEYS = 24;
const MAX_DETAIL_JSON_BYTES = 2048;
const MAX_DETAIL_ARRAY_LEN = 16;
const DETAIL_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
/** A short, ALL-CAPS enum-like token — an email / phone / uuid account id can never match. */
const ENUM_TOKEN_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const DETAIL_NUMBER_ABS_MAX = 1e12;

type BoundedScalar = number | boolean | string;
type BoundedValue = BoundedScalar | BoundedScalar[];

function boundScalar(value: unknown): BoundedScalar | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    const clamped = Math.max(-DETAIL_NUMBER_ABS_MAX, Math.min(DETAIL_NUMBER_ABS_MAX, value));
    return Number.isInteger(clamped) ? clamped : Math.round(clamped * 1000) / 1000;
  }
  if (typeof value === "string") return ENUM_TOKEN_RE.test(value) ? value : undefined;
  return undefined;
}

function boundValue(value: unknown): BoundedValue | undefined {
  if (Array.isArray(value)) {
    const out: BoundedScalar[] = [];
    for (const item of value) {
      if (out.length >= MAX_DETAIL_ARRAY_LEN) break;
      const bounded = boundScalar(item);
      if (bounded !== undefined) out.push(bounded);
    }
    return out.length > 0 ? out : undefined;
  }
  return boundScalar(value);
}

/**
 * Reduce an arbitrary object to bounded counts / booleans / short enum tokens
 * only, then serialize. Drops any key that is not a plain identifier, any value
 * that is not a finite number / boolean / enum token (or an array of those),
 * caps the key count and the total serialized size. Returns null when nothing
 * survives. This is the ONLY thing that ever writes account_owner_link_evidence
 * .detail_json — a raw email / phone / account id / passport id cannot pass it.
 */
export function boundOwnerLinkDetail(input: unknown): string | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const entries: [string, BoundedValue][] = [];
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (entries.length >= MAX_DETAIL_KEYS) break;
    if (!DETAIL_KEY_RE.test(key)) continue;
    const bounded = boundValue(raw);
    if (bounded === undefined) continue;
    entries.push([key, bounded]);
  }
  while (entries.length > 0) {
    const json = JSON.stringify(Object.fromEntries(entries));
    if (Buffer.byteLength(json, "utf8") <= MAX_DETAIL_JSON_BYTES) return json;
    entries.pop();
  }
  return null;
}
