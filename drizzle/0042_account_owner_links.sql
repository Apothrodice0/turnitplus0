-- Direct owner-link FOUNDATION — SCHEMA + STORAGE ONLY. Purely additive: four
-- new tables plus one new NOT NULL DEFAULT 0 column on the already-existing
-- report_historical_match_snapshots table. NOTHING in any scoring path reads
-- or writes any of this yet — computeUnifiedSimilarity,
-- resolveEffectiveDeviceSelfRepresentationIds, the same-device SELF rule, the
-- refined CONSERVATIVE_COMBINED (Policy D) shared-device guard, relationshipType,
-- candidate discovery and the matcher are all untouched and unaware of it. No
-- OWNER_LINK_SELF_ENABLED flag is wired into scoring. This migration only
-- establishes the storage shape; DO NOT apply it to Preview or Production in
-- this phase.
--
-- WHY THIS EXISTS
-- A DIRECT, owner-bound signal between two accounts — the same cryptographically
-- verified Device Passport used by both; a verified shared phone / recovery
-- email / OAuth provider subject / payment account or instrument; an admin
-- manual link; or >= 1 cross-Passport actor co-occurrence — is durable evidence
-- that the two accounts have the SAME human owner. account_owner_links records
-- exactly those direct pairwise links.
--
-- It is deliberately NON-TRANSITIVE: an A-B link and a B-C link never imply an
-- A-C link in this phase. Shared-device fan-out, anonymous passport history,
-- deviceDistinctAccounts, IP / coarse-location / timing co-occurrence and every
-- other telemetry-only signal are recorded (as observation-only evidence,
-- confidence LOW) but can NEVER, on their own, create, activate, or withdraw a
-- direct owner link. IP / location / timing alone never create an owner link.
--
-- ── HMAC KEY ROTATION — v1 HAS NO ONLINE ROTATION PATH ─────────────────────
-- account_ref_lo / account_ref_hi, account_owner_link_state.account_ref, and
-- account_owner_link_evidence.evidence_fingerprint are ALL keyed by the single
-- process-wide OWNER_LINK_HMAC_KEY (lib/owner-link.ts). ownerAccountRef /
-- ownerLinkEvidenceFingerprint always use the CURRENT key — they do not select
-- a key by key_version, and there is no keyring. Consequently, changing
-- OWNER_LINK_HMAC_KEY:
--   * makes every existing account_owner_links / _evidence row unmatchable (the
--     old pseudonyms can no longer be re-derived), and
--   * makes readAccountOwnerLinkGeneration silently return 0 for every account
--     (the state row is keyed by the OLD pseudonym), dropping the monotonic
--     counter and corrupting the owner_link_generation staleness comparison.
-- Rotation is therefore a SEPARATELY REVIEWED migration / rebuild procedure (re-key
-- the account_ref_* / evidence_fingerprint COLUMNS IN PLACE, preserving every
-- row's id), NEVER a plain env-var swap. It must NOT drop-and-recreate the parent
-- rows: account_owner_link_events references account_owner_links.id /
-- account_owner_link_evidence.id (opaque randomUUID values, NOT key-derived) via
-- ON DELETE RESTRICT foreign keys — a recreate is both blocked by RESTRICT and
-- would orphan the audit log; the alternative is migrating those event
-- link_id / evidence_id references in lockstep.
-- key_version exists so that procedure can be written without losing history —
-- it is NOT evidence that rotation is already safe.
-- tests/owner-link-foundation.test.mjs pins this limitation so it stays visible.
--
-- ── GENERATION SCOPE — DIRECT PAIRS ONLY ──────────────────────────────────
-- report_historical_match_snapshots.owner_link_generation is stamped with the
-- REPORT ACCOUNT's own account_owner_link_state.link_generation. This is
-- sufficient ONLY while owner relationships are DIRECT PAIRS: every direct-pair
-- change necessarily has the affected account as one endpoint, so its own
-- generation always advances. A future TRANSITIVE owner-cluster phase MUST
-- introduce a cluster-level generation (or an equivalent closure-wide
-- invalidation) — a new B-C link would otherwise change A's effective cluster
-- without touching A's own generation, and A's stamped snapshot would never be
-- recomputed. Do NOT add transitivity without that.
--
-- account_owner_links: one row per canonical unordered account-ref pair.
--   account_ref_lo / account_ref_hi are keyed pseudonyms —
--     HMAC-SHA256(OWNER_LINK_HMAC_KEY, "TP_OWNER_LINK_V1:" + accountId)
--     lowercase hex (lib/owner-link.ts's ownerAccountRef) — NEVER a raw account
--     id, and ordered lexicographically so {A,B} and {B,A} collapse to one row.
--     CHECK (account_ref_lo < account_ref_hi) enforces canonical ordering and
--     rules out a self-pair. A missing OWNER_LINK_HMAC_KEY means no pseudonym
--     can be derived, so no owner-link row is ever written (fail closed).
--   key_version records which keying generation produced the pair (see HMAC KEY
--     ROTATION above) — OWNER_LINK_KEY_VERSION.
--   status ACTIVE | WITHDRAWN — WITHDRAWN is a tombstone; a link row is NEVER
--     deleted. strongest_confidence HIGH | MEDIUM | LOW is the strongest
--     confidence across the link's non-withdrawn evidence, retained for
--     admin / audit (scoring integration comes in a later phase).
--   first_linked_at / last_evidence_at / withdrawn_at and decided_by
--     SYSTEM | ADMIN — epoch-millisecond integers (the drizzle/0038 / sessions
--     / 0010 convention), never TEXT CURRENT_TIMESTAMP. On a WITHDRAWN -> ACTIVE
--     REACTIVATION via upsertOwnerLinkEvidence, decided_by is re-attributed to
--     the actor responsible for the reactivation — it does NOT retain the prior
--     withdrawal actor.
--   withdrawn_reason is a CONTROLLED VOCABULARY, never free text: NULL, or one
--     of MANUAL_REVIEW | REVOKED | NO_QUALIFYING_EVIDENCE | SUPERSEDED |
--     ADMIN_CORRECTION (lib/owner-link.ts's OWNER_LINK_WITHDRAWAL_REASONS). The
--     CHECK below is the DB-level backstop for the app-level
--     assertOwnerLinkWithdrawalReason() — a raw email / UUID / account id / note
--     can reach neither. Keep this list identical to the evidence table's list
--     and to OWNER_LINK_WITHDRAWAL_REASONS.
--   UNIQUE(account_ref_lo, account_ref_hi, key_version) is the upsert key.
--   idx_account_owner_links_account_ref_hi is the REVERSE-ENDPOINT index: the
--     unique pair index already covers "links where account_ref_lo = ?" (lo is
--     its leftmost column); this covers "links where account_ref_hi = ?", so
--     "every direct link touching one ref" never needs a full table scan
--     (needed by a later admin view / any closure walk).
--
-- account_owner_link_evidence: append-only, tombstone-only evidence rows.
--   link_id -> account_owner_links(id) ON DELETE RESTRICT: an owner link can
--     never be removed while any evidence references it (and links are never
--     removed anyway) — the same durability posture drizzle/0039 /
--     drizzle/0041 took.
--   confidence / signal_type / evidence_fingerprint — evidence_fingerprint is
--     itself an HMAC / domain-separated digest over a JSON-ENCODED component
--     array (lib/owner-link.ts's ownerLinkEvidenceFingerprint — the encoding is
--     unambiguous: ["a b","c"] and ["a","b c"] never collide), NEVER a raw
--     account / passport / phone / email / payment value.
--   signal_type is a CHECK-constrained CLOSED vocabulary — the 10 owner-bound
--     plus 4 observation-only tokens defined in lib/owner-link.ts
--     (OWNER_BOUND_SIGNAL_TYPES + OBSERVATION_ONLY_SIGNAL_TYPES). Adding a new
--     signal type is deliberately a migration, matching the confidence /
--     status / decided_by CHECKs already in this file. Keep this list identical
--     to lib/owner-link.ts's ALL_OWNER_LINK_SIGNAL_TYPES
--     (tests/owner-link-foundation.test.mjs cross-checks the two).
--   observation_count / first_observed_at / last_observed_at follow UPSERT
--     semantics keyed on UNIQUE(link_id, signal_type, evidence_fingerprint): a
--     repeat observation of the SAME triple PRESERVES first_observed_at,
--     ADVANCES last_observed_at (never regressed), INCREMENTS observation_count.
--     withdrawn_at tombstones a row; rows are NEVER deleted, counts NEVER
--     decremented. observation_count and first_observed_at are preserved across
--     every revive. A fresh observation of a tombstoned triple REVIVES it, which
--     NECESSARILY clears its own withdrawn_at + withdrawn_reason (a live row must
--     read as live — otherwise every `WHERE withdrawn_at IS NULL` query and
--     resolveLinkStatusFromEvidence would be wrong). The withdrawal/revival
--     AUDIT HISTORY is therefore NOT on the live row — it lives, immutably, in
--     account_owner_link_events (below).
--   withdrawn_reason — same controlled vocabulary + CHECK as
--     account_owner_links.withdrawn_reason above; reflects only the CURRENT
--     tombstone (NULL for a live row, cleared on revive). Historical withdrawal
--     reasons are retained in account_owner_link_events, never here.
--   detail_json is a bounded, numeric / boolean / short-enum-token blob only
--     (lib/owner-link.ts's boundOwnerLinkDetail) — no free text, no ids.
--   created_by SYSTEM | ADMIN.
--
-- account_owner_link_events: APPEND-ONLY state-transition log — the immutable
--   history the live rows above cannot be. One row per meaningful transition:
--   LINK_CREATED / LINK_WITHDRAWN / LINK_REACTIVATED / EVIDENCE_ADDED /
--   EVIDENCE_WITHDRAWN / EVIDENCE_REACTIVATED (lib/owner-link.ts
--   OWNER_LINK_EVENT_TYPES). Rows are NEVER updated or deleted.
--     id INTEGER PRIMARY KEY AUTOINCREMENT — monotonic insertion order IS the
--       canonical event ordering (occurred_at can tie within one transaction).
--     link_id -> account_owner_links(id) ON DELETE RESTRICT; evidence_id ->
--       account_owner_link_evidence(id) ON DELETE RESTRICT (NULL for a
--       link-level event). Both parents are themselves never deleted, so this
--       log is never cascade-removed by report / room / account cleanup.
--     event_type / previous_state / new_state — bounded enums
--       (OWNER_LINK_EVENT_TYPES / OWNER_LINK_EVENT_STATES). previous_state is
--       NULL only for LINK_CREATED / EVIDENCE_ADDED.
--     reason — the SAME controlled vocabulary + CHECK as the withdrawn_reason
--       columns; non-NULL only for a *_WITHDRAWN event.
--     actor SYSTEM | ADMIN — an actor CLASS, NOT proof of which administrator.
--       SYSTEM = automatic; ADMIN = a human admin action. This foundation stores
--       no admin identity (the only existing admin-audit trail,
--       corpus_admission_admin_audit_log, records a RAW users.id — forbidden
--       here). A later admin-producer phase needing per-administrator
--       attribution can add an OPTIONAL actor_ref column populated with
--       ownerAccountRef(adminAccountId); out of scope now.
--     occurred_at — epoch-ms, the app-supplied transition time.
--   NO account ref, passport id, fingerprint, email, IP, or free text — only
--   internal link/evidence ids, bounded enums, one controlled reason, one
--   actor class, one timestamp. Event insertion always happens in the SAME write
--   transaction as the state mutation it records.
--   STRUCTURAL invariant: beyond per-column vocabularies, ONE table-level CHECK
--   pins each event_type to its single legal shape — evidence_id presence,
--   previous_state, new_state, reason presence — so the log cannot represent an
--   impossible combination (a LINK_* event with an evidence_id, an
--   EVIDENCE_WITHDRAWN with no reason, a LINK_REACTIVATED whose previous_state is
--   ACTIVE, ...). lib/owner-link.ts's assertOwnerLinkEventShape /
--   OWNER_LINK_EVENT_SHAPES is the app-side mirror; keep the two in lockstep
--   (tests/owner-link-foundation.test.mjs cross-checks them). NOT a state-machine
--   framework — a fixed table for six known event types.
--
-- account_owner_link_state: one row per (account_ref, key_version) carrying a
--   monotonic link_generation counter. It is bumped on BOTH endpoints whenever a
--   direct link between them is created, materially gains or loses evidence, or
--   is withdrawn — never a global counter, so one account's churn never
--   invalidates an unrelated account's snapshot. PK (account_ref, key_version);
--   an absent row reads as generation 0. (See GENERATION SCOPE above for why
--   this per-account counter is sufficient only for direct pairs.)
--
-- report_historical_match_snapshots.owner_link_generation — a later phase stamps
--   this with the report account's account_owner_link_state.link_generation at
--   owner-link classification time and treats the owner-link-sensitive part of
--   the snapshot as stale once the stored value trails the account's current
--   generation — the same per-key staleness shape corpus_generation
--   (drizzle/0036) and device_provenance_generation (drizzle/0040) already use.
--   NOT NULL DEFAULT 0 backfills every existing snapshot row to 0 (no owner-link
--   classification was ever computed for it), the correct resting state, so no
--   explicit backfill statement is needed. Nothing reads or writes it yet.

CREATE TABLE IF NOT EXISTS account_owner_links (
  id TEXT PRIMARY KEY NOT NULL,
  account_ref_lo TEXT NOT NULL,
  account_ref_hi TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'WITHDRAWN')),
  strongest_confidence TEXT NOT NULL CHECK (strongest_confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  first_linked_at INTEGER NOT NULL,
  last_evidence_at INTEGER NOT NULL,
  withdrawn_at INTEGER,
  withdrawn_reason TEXT CHECK (
    withdrawn_reason IS NULL OR withdrawn_reason IN
      ('MANUAL_REVIEW', 'REVOKED', 'NO_QUALIFYING_EVIDENCE', 'SUPERSEDED', 'ADMIN_CORRECTION')
  ),
  decided_by TEXT NOT NULL DEFAULT 'SYSTEM' CHECK (decided_by IN ('SYSTEM', 'ADMIN')),
  CHECK (account_ref_lo < account_ref_hi)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_account_owner_links_pair
  ON account_owner_links(account_ref_lo, account_ref_hi, key_version);

CREATE INDEX IF NOT EXISTS idx_account_owner_links_account_ref_hi
  ON account_owner_links(account_ref_hi);

CREATE TABLE IF NOT EXISTS account_owner_link_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  link_id TEXT NOT NULL REFERENCES account_owner_links(id) ON DELETE RESTRICT,
  confidence TEXT NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  signal_type TEXT NOT NULL CHECK (signal_type IN (
    -- owner-bound (lib/owner-link.ts OWNER_BOUND_SIGNAL_TYPES)
    'SHARED_DEVICE_PASSPORT', 'SHARED_PASSPORT_ACTOR_COOCCURRENCE',
    'CROSS_PASSPORT_ACTOR_COOCCURRENCE', 'SHARED_CORPUS_DEVICE_PROVENANCE',
    'VERIFIED_PHONE', 'VERIFIED_RECOVERY_EMAIL', 'OAUTH_PROVIDER_SUBJECT',
    'PAYMENT_ACCOUNT', 'PAYMENT_INSTRUMENT', 'ADMIN_MANUAL',
    -- observation-only (lib/owner-link.ts OBSERVATION_ONLY_SIGNAL_TYPES)
    'DEVICE_FINGERPRINT', 'IP_COOCCURRENCE', 'COARSE_LOCATION', 'TIMING'
  )),
  evidence_fingerprint TEXT NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 1,
  first_observed_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL,
  withdrawn_at INTEGER,
  withdrawn_reason TEXT CHECK (
    withdrawn_reason IS NULL OR withdrawn_reason IN
      ('MANUAL_REVIEW', 'REVOKED', 'NO_QUALIFYING_EVIDENCE', 'SUPERSEDED', 'ADMIN_CORRECTION')
  ),
  detail_json TEXT,
  created_by TEXT NOT NULL DEFAULT 'SYSTEM' CHECK (created_by IN ('SYSTEM', 'ADMIN'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_account_owner_link_evidence_signal
  ON account_owner_link_evidence(link_id, signal_type, evidence_fingerprint);

CREATE INDEX IF NOT EXISTS idx_account_owner_link_evidence_link
  ON account_owner_link_evidence(link_id);

CREATE TABLE IF NOT EXISTS account_owner_link_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  link_id TEXT NOT NULL REFERENCES account_owner_links(id) ON DELETE RESTRICT,
  evidence_id TEXT REFERENCES account_owner_link_evidence(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'LINK_CREATED', 'LINK_WITHDRAWN', 'LINK_REACTIVATED',
    'EVIDENCE_ADDED', 'EVIDENCE_WITHDRAWN', 'EVIDENCE_REACTIVATED'
  )),
  previous_state TEXT CHECK (previous_state IS NULL OR previous_state IN ('ACTIVE', 'WITHDRAWN')),
  new_state TEXT NOT NULL CHECK (new_state IN ('ACTIVE', 'WITHDRAWN')),
  reason TEXT CHECK (
    reason IS NULL OR reason IN
      ('MANUAL_REVIEW', 'REVOKED', 'NO_QUALIFYING_EVIDENCE', 'SUPERSEDED', 'ADMIN_CORRECTION')
  ),
  actor TEXT NOT NULL CHECK (actor IN ('SYSTEM', 'ADMIN')),
  occurred_at INTEGER NOT NULL,
  -- STRUCTURAL invariant: each event_type has exactly ONE legal shape
  -- (evidence_id presence, previous_state, new_state, reason presence). The
  -- app-side mirror is lib/owner-link.ts's assertOwnerLinkEventShape /
  -- OWNER_LINK_EVENT_SHAPES — keep the two in lockstep. NOT a state-machine
  -- framework; a fixed enumeration of the six known event shapes.
  CHECK (
    (event_type = 'LINK_CREATED'         AND evidence_id IS NULL     AND previous_state IS NULL       AND new_state = 'ACTIVE'    AND reason IS NULL)     OR
    (event_type = 'LINK_WITHDRAWN'       AND evidence_id IS NULL     AND previous_state = 'ACTIVE'    AND new_state = 'WITHDRAWN' AND reason IS NOT NULL) OR
    (event_type = 'LINK_REACTIVATED'     AND evidence_id IS NULL     AND previous_state = 'WITHDRAWN' AND new_state = 'ACTIVE'    AND reason IS NULL)     OR
    (event_type = 'EVIDENCE_ADDED'       AND evidence_id IS NOT NULL AND previous_state IS NULL       AND new_state = 'ACTIVE'    AND reason IS NULL)     OR
    (event_type = 'EVIDENCE_WITHDRAWN'   AND evidence_id IS NOT NULL AND previous_state = 'ACTIVE'    AND new_state = 'WITHDRAWN' AND reason IS NOT NULL) OR
    (event_type = 'EVIDENCE_REACTIVATED' AND evidence_id IS NOT NULL AND previous_state = 'WITHDRAWN' AND new_state = 'ACTIVE'    AND reason IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_account_owner_link_events_link
  ON account_owner_link_events(link_id, id);

CREATE INDEX IF NOT EXISTS idx_account_owner_link_events_evidence
  ON account_owner_link_events(evidence_id, id)
  WHERE evidence_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_owner_link_state (
  account_ref TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  link_generation INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_ref, key_version)
);

ALTER TABLE report_historical_match_snapshots ADD COLUMN owner_link_generation INTEGER NOT NULL DEFAULT 0;
