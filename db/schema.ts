import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  blob,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/sqlite-core";

// Documents table stores canonical metadata about indexed documents.
export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    provenance_sha256: text("provenance_sha256").notNull(),
    contribution_policy_version: text("contribution_policy_version"),
    source_type: text("source_type").notNull().default("Publication"),
    original_similarity: real("original_similarity"),
    word_count: integer("word_count").notNull(),
    unique_shingle_count: integer("unique_shingle_count").notNull(),
    storage_pointer: text("storage_pointer"),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updated_at: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("ux_documents_provenance_sha256").on(table.provenance_sha256),
  ],
);

// Document chunks: documents can be split into manageable chunks for indexing
//
// document_id -> documents.id cascades on delete, restored by
// 0007_document_chunks_cascade.sql to match 0002_handy_forgotten_one.sql's
// original intent and every other document-owned child table in this schema.
export const document_chunks = sqliteTable(
  "document_chunks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    document_id: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    chunk_index: integer("chunk_index").notNull(),
    token_count: integer("token_count").notNull(),
    token_start: integer("token_start").notNull(),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("ux_document_chunks_document_chunk_idx").on(table.document_id, table.chunk_index),
  ],
);

// Chunk fingerprints / shingles — one row per shingle occurrence (positioned)
export const chunk_fingerprints = sqliteTable(
  "chunk_fingerprints",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chunk_id: integer("chunk_id").notNull().references(() => document_chunks.id, { onDelete: "cascade" }),
    shingle_hash: text("shingle_hash").notNull(),
    position: integer("position").notNull(),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_chunk_fingerprints_chunk_id").on(table.chunk_id),
    index("idx_chunk_fingerprints_shingle_hash").on(table.shingle_hash),
  ],
);

// Analysis runs record when a similarity analysis was performed for a document
export const analysis_runs = sqliteTable(
  "analysis_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    document_id: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    run_at: text("run_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    analyzer_version: text("analyzer_version"),
    status: text("status").notNull().default("complete"),
    result_json: text("result_json"),
  },
  (table) => [
    index("idx_analysis_runs_document_id").on(table.document_id),
  ],
);

// Matches: top-level source matches discovered during an analysis run
export const matches = sqliteTable(
  "matches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    analysis_run_id: integer("analysis_run_id").notNull().references(() => analysis_runs.id, { onDelete: "cascade" }),
    source_document_id: text("source_document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    matched_words: integer("matched_words").notNull().default(0),
    containment: real("containment").notNull().default(0),
    score: integer("score").notNull().default(0),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_matches_source_document_id").on(table.source_document_id),
    index("idx_matches_analysis_run_id").on(table.analysis_run_id),
  ],
);

// Match segments represent contiguous matched spans for a given match
export const match_segments = sqliteTable(
  "match_segments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    match_id: integer("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
    segment_start: integer("segment_start").notNull(),
    segment_end: integer("segment_end").notNull(),
    positions_blob: text("positions_blob"), // optional JSON array of positions
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  }
);

// Index versions: track published packed-index artifacts and metadata
export const index_versions = sqliteTable(
  "index_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    corpus_version: text("corpus_version").notNull(),
    key_count: integer("key_count").notNull().default(0),
    posting_count: integer("posting_count").notNull().default(0),
    assets_json: text("assets_json"), // JSON with filenames or object-storage keys
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    deployed_at: text("deployed_at"),
  },
  (table) => [
    uniqueIndex("ux_index_versions_corpus_version").on(table.corpus_version),
  ],
);

// Contributions: track individual corpus contributions (external identifier)
export const contributions = sqliteTable(
  "contributions",
  {
    contribution_id: text("contribution_id").primaryKey(),
    document_id: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    contribution_policy_version: text("contribution_policy_version").notNull(),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  }
);

// Phase 1 persistent reports (saved_reports). Deliberately independent of the
// corpus-contribution tables above — this stores a user's own completed
// report for later retrieval, not corpus data, so it has no foreign keys
// into that schema. device_key is a client-generated random identifier
// (soft scoping; no authentication exists yet) and is part of the primary
// key so two different browsers can never collide on the same report id.
export const saved_reports = sqliteTable(
  "saved_reports",
  {
    id: text("id").notNull(),
    device_key: text("device_key").notNull(),
    submission_id: text("submission_id").notNull(),
    title: text("title").notNull(),
    report_created_at: text("report_created_at").notNull(),
    word_count: integer("word_count").notNull(),
    archive_score: integer("archive_score").notNull(),
    score_band: text("score_band").notNull(),
    ai_score: integer("ai_score"),
    ai_tone: text("ai_tone"),
    payload_json: text("payload_json").notNull(),
    saved_at: text("saved_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updated_at: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    // Phase 2A: optional account scoping, additive (0011). NULL means the
    // report is still anonymous/device-key-only. Set once, the first time
    // this device_key's owner signs up or logs in (see claimAnonymousReports
    // in lib/auth-session.ts).
    user_id: text("user_id").references(() => users.id, { onDelete: "set null" }),
    // Privacy hardening (0023): the exact document_identities row this
    // report's identity/shingle/family/corpus data lives under, set once by
    // the same deferred callback that creates that row (see
    // app/api/reports/route.ts). Populated for both anonymous and signed-in
    // reports (an identity row is captured for either — see that route's
    // own comment), NULL only when no identity was captured at all or for
    // every report saved before this column existed. ON DELETE SET NULL:
    // losing the identity row must not delete the report. See
    // lib/report-deletion.ts for how DELETE /api/reports/[id] uses this to
    // cascade-clean the identity's own rows without risking a different
    // report's shared data.
    document_identity_id: text("document_identity_id").references(() => document_identities.id, { onDelete: "set null" }),
    // Room/slot architecture (0027): which of the account's room slots this
    // report occupies, an explicit fact recorded at upload time (the room
    // the user had open when they uploaded), never derived from `id`. NULL
    // for anonymous reports and for every report saved before this column
    // existed and then never re-saved (see drizzle/0027's own backfill,
    // which fills legacy authenticated rows with the old id%10 value so
    // their room-tile placement doesn't visibly jump). Immutable after the
    // first insert — app/api/reports/route.ts's ON CONFLICT DO UPDATE never
    // lists this column, so a resave (the existing save-then-re-save-with-
    // enrichment pattern) can never move a report to a different room.
    room_number: integer("room_number"),
    // AI-lifecycle status (0028): NULL for every report saved before this
    // column existed — those fall back to the pre-existing binary
    // ai_score-null-or-not derivation unchanged (see
    // lib/report-rooms.ts's deriveRoomStatus). Going forward, one of
    // 'processing' | 'ready' | 'failed', set explicitly by the client at
    // each save (see app/reports/rooms/[room]/room-page-shell.tsx) — never
    // reuses ai_tone, which is already 'unavailable' from the very first
    // save onward and so cannot distinguish "still running" from
    // "permanently failed" on its own.
    ai_status: text("ai_status"),
    // Device Passport (drizzle/0039): the device passport cryptographically
    // verified when POST /api/reports first created this report. NULL when
    // no passport was verified at upload (feature off, unsupported browser,
    // verification failed — all fail-safe: no device-based exclusion). NO
    // foreign key on purpose (same no-FK / explicit-application-cleanup
    // reasoning as report_historical_match_snapshots — report-local data
    // must never be collaterally mutated by a passport-side change), and
    // immutable after first insert (a later phase never lists it in the
    // upsert's ON CONFLICT DO UPDATE, exactly like room_number). NULL for
    // every pre-0039 row. Phase 1 = schema foundation only; nothing reads or
    // writes this yet.
    verified_device_passport_id: text("verified_device_passport_id"),
  },
  (table) => [
    primaryKey({ columns: [table.device_key, table.id] }),
    index("idx_saved_reports_device_key_created").on(table.device_key, table.report_created_at),
    index("idx_saved_reports_user_id_created").on(table.user_id, table.report_created_at),
    index("idx_saved_reports_document_identity_id").on(table.document_identity_id),
    index("idx_saved_reports_user_room").on(table.user_id, table.room_number),
    // drizzle/0039: partial index over the passport-attributed subset only —
    // supports the per-passport shared-device aggregate and provenance
    // lookups a later phase runs, without carrying an index entry for the
    // (large, common) NULL majority.
    index("idx_saved_reports_verified_device_passport")
      .on(table.verified_device_passport_id)
      .where(sql`verified_device_passport_id IS NOT NULL`),
  ],
);

// Phase 2A: real accounts. email is normalized (trim + lowercase) by the
// application before every insert/lookup, so a plain unique index gives
// effective case-insensitive uniqueness without needing COLLATE NOCASE.
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    username: text("username").notNull(),
    password_hash: text("password_hash").notNull(),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updated_at: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    // Privacy hardening (0023): explicit opt-in for the cross-account
    // matching corpus (lib/user-submission-corpus.ts). NULL (the default for
    // every existing and new account) means indexDocumentSubmissionIntoCorpus
    // is never called for this account's uploads — see
    // app/api/reports/route.ts. Non-NULL records *when* consent was granted,
    // matching this schema's existing declared_at/confirmed_at/revoked_at
    // convention (reuse_context_declarations) rather than a plain boolean.
    corpus_reuse_consented_at: text("corpus_reuse_consented_at"),
    // Developer/admin authorization (0025). "user" for every existing and
    // new account by default — the only way a row ever becomes "admin" is
    // lib/admin-role.ts's maybePromoteToAdmin(), called from login/signup,
    // which compares the account's own normalized email against the single
    // ADMIN_EMAIL environment variable. That variable is never hardcoded
    // into source and is not read anywhere else, so the designated address
    // itself lives in exactly one place (deployment config), not in this
    // codebase. A plain text enum (not a boolean) so a future intermediate
    // role does not require a second migration.
    role: text("role").notNull().default("user"),
  },
  (table) => [
    uniqueIndex("ux_users_email").on(table.email),
  ],
);

// Phase 2A: server-side session store. token_hash is SHA-256 of the raw
// session token carried in the httpOnly cookie — only the hash is ever
// persisted. created_at/expires_at are epoch-millisecond integers (not the
// TEXT CURRENT_TIMESTAMP convention used elsewhere) because expires_at is
// range-compared on every request, and mixing SQLite's CURRENT_TIMESTAMP
// string format with app-generated values in a comparison is a real
// lexicographic-ordering bug that integers sidestep entirely.
export const sessions = sqliteTable(
  "sessions",
  {
    token_hash: text("token_hash").primaryKey(),
    user_id: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    created_at: integer("created_at").notNull(),
    expires_at: integer("expires_at").notNull(),
  },
  (table) => [
    index("idx_sessions_user_id").on(table.user_id),
  ],
);

// Phase A (document identity): server-side identity record for an analyzed
// document, independent of both the corpus-contribution schema above
// (documents/.../contributions — that's archive/corpus material) and
// saved_reports (that's a user's saved report payload). This table only
// answers "what was submitted, by whom (if known), and what are its two
// hashes" — it does not drive similarity scoring, AI scoring, or the report
// UI in any way yet. account_id is nullable (anonymous submissions are
// expected) and mirrors saved_reports.user_id's ON DELETE SET NULL: losing
// the account must not delete identity history. raw_sha256 and
// canonical_sha256 are deliberately separate columns (see lib/document-
// identity.ts) and neither is unique — the same document can legitimately
// be submitted more than once, by the same account or different accounts;
// that's the same-account/other-account distinction this table exists to
// eventually support, not something to prevent at insert time.
export const document_identities = sqliteTable(
  "document_identities",
  {
    id: text("id").primaryKey(),
    account_id: text("account_id").references(() => users.id, { onDelete: "set null" }),
    title: text("title"),
    author: text("author"),
    raw_sha256: text("raw_sha256").notNull(),
    canonical_sha256: text("canonical_sha256").notNull(),
    // Phase B: count of distinct informative shingles recorded for this
    // identity in document_identity_shingles below. NULL until fingerprinting
    // has actually been run for this identity — createDocumentIdentity()
    // (Phase A) does not set this; it is populated only by the separate,
    // explicitly-called recordDocumentIdentityShingles() in
    // lib/document-family.ts, which is not wired into the live save path.
    unique_shingle_count: integer("unique_shingle_count"),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_document_identities_raw_sha256").on(table.raw_sha256),
    index("idx_document_identities_canonical_sha256").on(table.canonical_sha256),
    index("idx_document_identities_account_canonical").on(table.account_id, table.canonical_sha256),
  ],
);

// Phase B (document families/versions): one row per distinct *informative*
// shingle recorded for a document identity (not one row per occurrence —
// family detection only needs set membership for containment, not positions
// or highlighting). This is what makes "strong text similarity" between two
// document_identities rows computable at all: document_identities itself
// never stores submitted text (see its comment above), only hashes, so
// without this table there would be no representation of a document's
// content left to compare once its raw_text has been discarded by the
// caller. Independent of chunk_fingerprints (the corpus-contribution
// schema's equivalent) — that table has never been linked to
// document_identities, and this one is not linked to it either.
export const document_identity_shingles = sqliteTable(
  "document_identity_shingles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    document_identity_id: text("document_identity_id").notNull().references(() => document_identities.id, { onDelete: "cascade" }),
    shingle_hash: text("shingle_hash").notNull(),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("ux_document_identity_shingles_identity_hash").on(table.document_identity_id, table.shingle_hash),
    index("idx_document_identity_shingles_hash").on(table.shingle_hash),
  ],
);

// Phase B: a document family is just a group; every interesting fact about
// *why* an identity is in one lives on document_family_members below, not
// here. Deliberately minimal per the task's own suggested shape.
export const document_families = sqliteTable(
  "document_families",
  {
    id: text("id").primaryKey(),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updated_at: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
);

// Phase B: membership of one document_identities row in one document_families
// group. An identity belongs to at most one family (unique index on
// document_identity_id) — Phase B does not attempt multi-family graph
// resolution, only first-match attachment (see resolveFamilyForIdentity in
// lib/document-family.ts). match_type records *why* this identity is here:
// SEED (the founding member — no comparison was made), EXACT_CANONICAL_MATCH,
// or STRONG_TEXT_MATCH (matched against matched_against_identity_id at
// evidence_score, a 0..1 containment value). This is a document-relationship
// record, not a plagiarism or provenance classification — nothing here is
// SELF, PRIOR_SUBMISSION, or VERIFIED_SOURCE.
export const document_family_members = sqliteTable(
  "document_family_members",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    family_id: text("family_id").notNull().references(() => document_families.id, { onDelete: "cascade" }),
    document_identity_id: text("document_identity_id").notNull().references(() => document_identities.id, { onDelete: "cascade" }),
    match_type: text("match_type").notNull(),
    matched_against_identity_id: text("matched_against_identity_id").references(() => document_identities.id, { onDelete: "set null" }),
    evidence_score: real("evidence_score"),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("ux_document_family_members_identity").on(table.document_identity_id),
    index("idx_document_family_members_family_id").on(table.family_id),
  ],
);

// Phase E1 (provenance infrastructure): a source's provenance state is
// deliberately a separate concept from document_family_members.match_type
// above (a text relationship) and from lib/document-relationship.ts's
// SELF/PRIOR_SUBMISSION (an account relationship) — a row here can be
// provenance_state = VERIFIED_SOURCE while a comparison against it is
// independently relationship_type = PRIOR_SUBMISSION. Nothing in this table
// is read by, or written from, the similarity-scoring path
// (app/similarity-worker.ts, lib/report-types.ts, app/page.tsx,
// lib/receipt-pdf.ts) — see lib/provenance-types.ts's header comment and
// tests/provenance-scoring-invariance.test.mjs. document_identity_id is
// nullable and only set when this row represents a TurnitPlus account's own
// submission (OBSERVED_SUBMISSION) rather than an external candidate source;
// it deliberately carries no account_id of its own — see
// lib/provenance-registry.ts's createObservedSubmissionProvenance, which
// never accepts one, so account identity cannot leak into a provenance
// record through this table.
export const provenance_sources = sqliteTable(
  "provenance_sources",
  {
    id: text("id").primaryKey(),
    provenance_state: text("provenance_state").notNull(),
    source_type: text("source_type").notNull(),
    canonical_url: text("canonical_url"),
    external_identifier: text("external_identifier"),
    title: text("title"),
    author: text("author"),
    publisher: text("publisher"),
    publication_date: text("publication_date"),
    retrieved_at: text("retrieved_at"),
    content_hash: text("content_hash"),
    verification_method: text("verification_method"),
    verification_notes: text("verification_notes"),
    document_identity_id: text("document_identity_id").references(() => document_identities.id, { onDelete: "set null" }),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updated_at: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_provenance_sources_state").on(table.provenance_state),
    index("idx_provenance_sources_document_identity_id").on(table.document_identity_id),
  ],
);

// Append-only history of provenance_sources.provenance_state transitions.
// previous_state is NULL only for a source's genesis event (its very first
// row, written atomically with the source itself — see
// lib/provenance-registry.ts's createProvenanceSource). Every subsequent
// state change adds a new row here; existing rows are never updated or
// deleted by the repository layer (ON DELETE CASCADE only fires if the
// source itself is deleted, which is not a normal operation). This is what
// lets a later reader answer "when did this become VERIFIED_SOURCE" from the
// historical record instead of only the current state.
export const provenance_events = sqliteTable(
  "provenance_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source_id: text("source_id").notNull().references(() => provenance_sources.id, { onDelete: "cascade" }),
    previous_state: text("previous_state"),
    new_state: text("new_state").notNull(),
    reason: text("reason"),
    evidence: text("evidence"),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_provenance_events_source_id").on(table.source_id),
  ],
);

// Phase E4 (provenance evidence records): append-only, structured facts
// gathered about a provenance_sources row — "what do we know, and what did
// we know at what time." Deliberately a separate table from provenance_events
// above, not an extension of it: provenance_events records *state
// transitions* (UNKNOWN -> CANDIDATE_SOURCE -> ...), one row per change;
// this table records *evidence* (a URL was reachable, a content hash
// matched, a publisher was identified), one row per fact observed, and
// several rows can exist for the same source between any two state
// transitions, or none at all. Nothing here mutates provenance_sources or
// provenance_events, and nothing in lib/provenance-verification-policy.ts
// (the pure evaluator that reads this table's rows) writes back to either —
// see that file's own header comment and
// tests/provenance-scoring-invariance.test.mjs. payload_json holds the
// evidence_type-specific structured facts (see
// lib/provenance-evidence-types.ts for the controlled vocabulary and each
// type's expected payload shape) as a single JSON column, matching this
// schema's existing precedent for "structured data whose shape varies by row
// kind" (saved_reports.payload_json, analysis_runs.result_json,
// index_versions.assets_json) rather than a wide, mostly-NULL column set.
// observed_at is the app-supplied fact time (e.g. when a URL was actually
// fetched) and is independent of created_at (when this row was written to
// the database) — the same "first-seen time is not authorship/publication
// date" discipline provenance_sources already applies, extended to
// individual pieces of evidence. There is no UPDATE path in
// lib/provenance-evidence.ts: a changed fact (a URL that was reachable
// becomes unreachable) is always a new row, never an edit to an old one.
export const provenance_evidence = sqliteTable(
  "provenance_evidence",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source_id: text("source_id").notNull().references(() => provenance_sources.id, { onDelete: "cascade" }),
    evidence_type: text("evidence_type").notNull(),
    payload_json: text("payload_json").notNull(),
    observed_at: text("observed_at").notNull(),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_provenance_evidence_source_id").on(table.source_id),
    index("idx_provenance_evidence_type").on(table.evidence_type),
  ],
);

// Phase E5 (controlled provenance verification workflow): one row per
// explicit verification decision made about a provenance_sources row —
// approve, reject, dispute, retract, or reaffirm. Append-only, structurally
// parallel to provenance_events above (which this table's writes are always
// bundled into the same atomic client.batch() as, via
// lib/provenance-registry.ts's transitionProvenanceState extraStatements
// parameter — see that function's own comment) but conceptually distinct:
// provenance_events is the record of *what state a source moved to*;
// this table is the record of *why a human/system decided it should*,
// including the evidence evaluation that was consulted at the time. There
// is deliberately no "verified = true" flag anywhere in this schema — the
// current, authoritative answer to "is this source verified" is always
// provenance_sources.provenance_state (or, more precisely,
// isEligibleForVerifiedSimilarity(that state)); this table exists purely
// for the audit trail behind how it got there, and is never read to
// determine current eligibility.
// requested_state/previous_state are equal only for a REAFFIRMED decision
// (Phase E3 design section 7's "reviewed new evidence, remains VERIFIED"
// case) — the one kind of decision that has NO corresponding
// provenance_events row, since lib/provenance-types.ts's
// isValidProvenanceTransition() rejects same-state "transitions" by design;
// see lib/provenance-verification-workflow.ts's reaffirmVerification.
// evaluation_json is the full evaluateVerificationEligibility() result
// (Phase E4) at decision time — informational for every decision, but only
// load-bearing (gates the decision) when approving; a REJECTED/DISPUTED/
// RETRACTED decision is recorded with this same evaluation for audit
// purposes even though it did not require the gate to pass (Phase E3
// design's explicit "do not require the gate to pass before recording a
// rejection" rule).
export const provenance_verification_decisions = sqliteTable(
  "provenance_verification_decisions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source_id: text("source_id").notNull().references(() => provenance_sources.id, { onDelete: "cascade" }),
    previous_state: text("previous_state").notNull(),
    requested_state: text("requested_state").notNull(),
    decision: text("decision").notNull(),
    evaluation_json: text("evaluation_json").notNull(),
    evidence_ids_json: text("evidence_ids_json").notNull(),
    reason: text("reason"),
    method: text("method").notNull(),
    decided_at: text("decided_at").notNull(),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_provenance_verification_decisions_source_id").on(table.source_id),
  ],
);

// Phase E6A (source discovery architecture): one row per provider attempt
// within a discovery run — never the final candidate alone (see
// lib/discovery-repository.ts's own comment). request_id correlates every
// provider attempt that belongs to the same in-memory DiscoveryRequest
// (lib/discovery-types.ts) — that request itself is never persisted as its
// own row (Phase E6A task description section 2: "do not copy entire
// document text into every request record"), only its bounded, already-
// extracted queries/signals and the outcome of asking each provider.
// document_identity_id is nullable (a MANUAL_RESEARCH discovery attempt
// need not be tied to any live submission) and deliberately the only
// foreign key this table has: no reference to provenance_sources,
// provenance_evidence, document_families, or document_family_members
// exists here — discovery facts stay a separate concern from provenance
// facts (this phase's own task description, section 12), even though
// lib/discovery-provenance-bridge.ts can later read a completed discovery
// candidate and use it to create those other rows through their own,
// already-existing repositories. raw_results_json stores what each
// provider actually returned for this attempt (post-sanitization,
// pre-deduplication) — small and bounded, since discovery results are
// inherently short candidate lists, never a document body.
export const discovery_attempts = sqliteTable(
  "discovery_attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    request_id: text("request_id").notNull(),
    document_identity_id: text("document_identity_id").references(() => document_identities.id, { onDelete: "set null" }),
    purpose: text("purpose").notNull(),
    provider_id: text("provider_id").notNull(),
    provider_type: text("provider_type").notNull(),
    queries_used_json: text("queries_used_json").notNull(),
    status: text("status").notNull(),
    result_count: integer("result_count").notNull().default(0),
    raw_results_json: text("raw_results_json"),
    error_message: text("error_message"),
    requested_at: text("requested_at").notNull(),
    responded_at: text("responded_at"),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_discovery_attempts_request_id").on(table.request_id),
    index("idx_discovery_attempts_document_identity_id").on(table.document_identity_id),
  ],
);

// Phase E6C (external source retrieval + content correspondence): one row
// per attempt to retrieve a candidate source's actual content. Append-only,
// structurally parallel to discovery_attempts (E6A) but a separate concern
// — discovery_attempts records "did a provider find a candidate,"
// source_retrievals records "did we actually fetch and read its content."
// Deliberately has NO foreign key into provenance_evidence,
// document_families, saved_reports, or document_identities — this table
// answers "what did TurnitPlus retrieve, when, and what exactly did it
// retrieve" for a candidate source, nothing about a TurnitPlus user's own
// submission (external retrieved content is never treated as, or merged
// into, a document_identities row — see this phase's own task description,
// section 9). The only foreign key is source_id, into provenance_sources —
// a retrieval is always about a specific candidate/source row. raw_html is
// intentionally NOT a column: only hashes plus the bounded extracted text
// are kept (extracted_text_excerpt, capped independently of the retriever's
// own maxExtractedTextLength, purely so a reviewer can sanity-check what
// was compared without this table ever becoming a mirror of the external
// page). extractor_version lets a later reader tell whether two retrievals
// of the same page used comparable extraction rules (see
// lib/html-text-extraction.ts's HTML_EXTRACTOR_VERSION).
export const source_retrievals = sqliteTable(
  "source_retrievals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source_id: text("source_id").notNull().references(() => provenance_sources.id, { onDelete: "cascade" }),
    original_url: text("original_url").notNull(),
    final_url: text("final_url"),
    http_status: integer("http_status"),
    content_type: text("content_type"),
    retrieved_at: text("retrieved_at").notNull(),
    raw_sha256: text("raw_sha256"),
    canonical_sha256: text("canonical_sha256"),
    extracted_text_excerpt: text("extracted_text_excerpt"),
    extractor_version: text("extractor_version"),
    status: text("status").notNull(),
    error_message: text("error_message"),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_source_retrievals_source_id").on(table.source_id),
  ],
);

// Phase E8A (user submission history corpus — storage/indexing only, not yet
// wired into live scoring or matching): the reusable, deduplicated content
// layer document_identities never had. document_identities (Phase A) already
// records one row per submission event with both hashes, but never the text
// itself — nothing before E8A could ever compare two submissions at the
// passage level. These three tables are purely additive; no existing table's
// rows, columns, or constraints change. account ownership is deliberately
// NOT duplicated here — corpus_submission_references only stores
// document_identity_id, and every account-scoped query joins back through
// document_identities.account_id, so there is exactly one place account
// linkage lives.
//
// One row per distinct canonical_sha256 — many submissions (any account, any
// number of times) that canonicalize to the same text share one row here,
// never one copy per submission. canonical_text is stored so future passage-
// level comparison is possible at all (hashes alone cannot support that).
// canonicalization_version records which lib/canonical-text.ts behavior
// produced canonical_text, independent of fingerprint_version below, which
// records which shingling scheme produced this representation's
// corpus_document_shingles rows — two different "this could change later"
// axes, versioned separately on purpose (this phase's own task description,
// section 8). extractor_version is nullable: the server never learns which
// client-side extractor produced the text it receives, so this column exists
// for forward compatibility but is not populated by anything in this phase.
// first_seen_at is exactly that and nothing more — see this phase's own task
// description, section 21: it is not authorship, ownership, or a publication
// date.
export const corpus_document_representations = sqliteTable(
  "corpus_document_representations",
  {
    id: text("id").primaryKey(),
    canonical_sha256: text("canonical_sha256").notNull(),
    canonical_text: text("canonical_text").notNull(),
    word_count: integer("word_count").notNull(),
    language: text("language"),
    canonicalization_version: text("canonicalization_version").notNull(),
    extractor_version: text("extractor_version"),
    first_seen_at: text("first_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("ux_corpus_document_representations_canonical_sha256").on(table.canonical_sha256),
  ],
);

// One row per submission event that has been indexed into the corpus —
// document_identity_id is unique because a given submission maps to exactly
// one representation. link_type records whether this submission introduced
// a NEW_CONTENT_REPRESENTATION or matched an EXACT_CANONICAL_DUPLICATE
// already on file (this phase's own task description, section 6 — revision
// inference stays Phase B's job, not this table's). This is the only place
// "who submitted this, and how many times" is answered for the corpus layer,
// and it answers that by joining to document_identities, never by storing
// account_id a second time.
export const corpus_submission_references = sqliteTable(
  "corpus_submission_references",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    representation_id: text("representation_id").notNull().references(() => corpus_document_representations.id, { onDelete: "cascade" }),
    document_identity_id: text("document_identity_id").notNull().references(() => document_identities.id, { onDelete: "cascade" }),
    link_type: text("link_type").notNull(),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("ux_corpus_submission_references_document_identity_id").on(table.document_identity_id),
    index("idx_corpus_submission_references_representation_id").on(table.representation_id),
    // drizzle/0043 — Phase A 7-day corpus maturity. Range index over this
    // backing's immutable T0, for lib/report-historical-match.ts's
    // corpusBackingMaturedInWindow snapshot-invalidation range scan (not the
    // per-representation eligibility EXISTS, which the rep index already serves).
    index("idx_corpus_submission_references_created_at").on(table.created_at),
  ],
);

// One row per distinct informative shingle of a representation's own
// canonical_text (not its submitters' raw text — deliberately different from
// document_identity_shingles, which fingerprints raw text for Phase B family
// matching; this table exists for a different purpose, future cross-
// submission passage matching, and is never read by lib/document-family.ts
// or lib/document-relationship.ts). fingerprint_version is part of the
// unique key together with shingle_hash so a future re-fingerprinting pass
// can add a new generation of shingles for the same representation without
// deleting or colliding with the old ones.
export const corpus_document_shingles = sqliteTable(
  "corpus_document_shingles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    representation_id: text("representation_id").notNull().references(() => corpus_document_representations.id, { onDelete: "cascade" }),
    shingle_hash: text("shingle_hash").notNull(),
    fingerprint_version: text("fingerprint_version").notNull(),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("ux_corpus_document_shingles_representation_version_hash").on(table.representation_id, table.fingerprint_version, table.shingle_hash),
    index("idx_corpus_document_shingles_hash").on(table.shingle_hash),
  ],
);

// Phase E8C: per-saved-report historical-match snapshot cache — connects
// lib/user-submission-matching.ts's (E8B) matcher to the saved-report
// lifecycle without ever touching saved_reports itself. One row per report,
// upserted (never appended) on recompute — see lib/report-historical-match.ts
// for why "latest snapshot + its own version tags" is enough to detect
// staleness without keeping a full audit history. report_device_key +
// report_id mirror saved_reports' own composite primary key exactly (not
// just id alone — saved_reports' id is only unique per device_key, a
// client-generated, timestamp-based value, so keying on id alone could in
// theory let two different devices' reports collide onto one snapshot row).
// No DB-level FOREIGN KEY here on purpose: this project's existing
// schema-drift tooling (tests/schema-drift.test.mjs) only recognizes
// single-column references() declarations, not a table-level composite
// foreign key, and this phase does not touch that shared tooling to add
// support for one. Cleanup is instead explicit and application-level —
// app/api/reports/[id]/route.ts's DELETE handler removes the matching
// snapshot row in the same request, right after deleting the report itself.
//
// result_json is bounded, privacy-screened evidence only (relationship
// type, containment, matched word count, passage count, longest match,
// bounded passages reconstructed from the CURRENT report's own text, and a
// historical-submission COUNT) — never full historical document text, never
// another account's id or email. See lib/report-historical-match.ts's own
// header comment for the exact shape, which mirrors
// lib/user-submission-matching.ts's UserSubmissionMatch without importing
// it here (this file never imports a feature module, matching every other
// table's own convention).
export const report_historical_match_snapshots = sqliteTable(
  "report_historical_match_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    report_device_key: text("report_device_key").notNull(),
    report_id: text("report_id").notNull(),
    status: text("status").notNull(),
    matcher_version: text("matcher_version"),
    fingerprint_version: text("fingerprint_version"),
    canonicalization_version: text("canonicalization_version"),
    result_json: text("result_json"),
    candidate_count: integer("candidate_count"),
    processing_duration_ms: integer("processing_duration_ms"),
    error_message: text("error_message"),
    computed_at: text("computed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    // drizzle/0035: see that migration's own comment. Never final — treated
    // like NO_HISTORICAL_MATCH's own "always recompute" rule.
    is_partial: integer("is_partial").notNull().default(0),
    // drizzle/0036: the corpus_match_generation value this row was computed
    // at — stale (and recomputed) once corpus_match_generation.generation
    // advances past it. See that migration's own comment.
    corpus_generation: integer("corpus_generation").notNull().default(0),
    // drizzle/0040: the PER-PASSPORT device_passports.provenance_generation
    // value the report's own immutable upload passport
    // (saved_reports.verified_device_passport_id) held when this snapshot's
    // device-sensitive classification was computed. 0 for a report with no
    // verified upload passport. A later phase recomputes the device-sensitive
    // part once that specific passport's counter advances past this value —
    // never a global epoch, so another passport's change never invalidates
    // this row. Phase 1 = schema foundation only; nothing reads or writes
    // this yet.
    device_provenance_generation: integer("device_provenance_generation").notNull().default(0),
    // drizzle/0042: the account_owner_link_state.link_generation value the
    // report account's owner-link state held when this snapshot's
    // owner-link-sensitive classification was computed. 0 for a report whose
    // account has no direct owner link (and every existing row). A later phase
    // recomputes the owner-link-sensitive part once the account's generation
    // advances past this value — never a global epoch, so another account's
    // link churn never invalidates this row. Foundation only; nothing reads or
    // writes this yet.
    owner_link_generation: integer("owner_link_generation").notNull().default(0),
  },
  (table) => [
    uniqueIndex("ux_report_historical_match_snapshots_report").on(table.report_device_key, table.report_id),
  ],
);

// drizzle/0036: single-row global epoch for "corpus eligibility was ADDED"
// events — see that migration's own comment for the full argument
// (targeted, per-representation snapshot invalidation cannot discover a
// report that should gain a match to content it doesn't reference yet).
export const corpus_match_generation = sqliteTable("corpus_match_generation", {
  id: integer("id").primaryKey(),
  generation: integer("generation").notNull().default(0),
  updated_at: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Phase E8P: bounded shadow-evaluation telemetry comparing production's
// real historical-match result against the proposed E8O policy
// (lib/e8o-historical-match-policy.ts) — see
// drizzle/0021_historical_match_shadow_evaluations.sql for the full
// rationale. Never read by the production matching path; write-only from
// lib/e8p-shadow-evaluation.ts. No document/passage text, no account id —
// counts, enums, and timings only. Same "no DB-level FOREIGN KEY" reasoning
// as report_historical_match_snapshots above.
export const historical_match_shadow_evaluations = sqliteTable(
  "historical_match_shadow_evaluations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    report_device_key: text("report_device_key").notNull(),
    report_id: text("report_id").notNull(),
    production_status: text("production_status").notNull(),
    production_relationship: text("production_relationship"),
    proposed_status: text("proposed_status").notNull(),
    proposed_relationship: text("proposed_relationship"),
    proposed_evidence: text("proposed_evidence"),
    agreement: text("agreement").notNull(),
    candidate_count: integer("candidate_count").notNull().default(0),
    passage_level_evaluated_count: integer("passage_level_evaluated_count").notNull().default(0),
    freq_index_document_count: integer("freq_index_document_count").notNull().default(0),
    submitted_word_count: integer("submitted_word_count").notNull().default(0),
    e8m_runtime_ms: integer("e8m_runtime_ms"),
    v2_runtime_ms: integer("v2_runtime_ms"),
    total_runtime_ms: integer("total_runtime_ms").notNull(),
    policy_version: text("policy_version").notNull(),
    correspondence_version: text("correspondence_version").notNull(),
    distinctiveness_version: text("distinctiveness_version").notNull(),
    status: text("status").notNull(),
    error_message: text("error_message"),
    computed_at: text("computed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("ux_historical_match_shadow_evaluations_report_policy").on(table.report_device_key, table.report_id, table.policy_version),
  ],
);

// Phase E8S Step 4: reuse-context declarations — see
// drizzle/0022_reuse_context_declarations.sql for the full rationale.
// DORMANT as of 2026-09: the ordinary-user reuse-context declaration /
// confirmation workflow (app/api/reuse-context/*, components/reuse-context/*,
// lib/reuse-context-*, lib/e8s-*) was removed as a cancelled product
// direction. This table + its 0022 migration are retained (migration history
// is immutable; the runner pins 0022's hash/order), but NOTHING reads or
// writes it any more. No down migration; existing rows are left in place.
// document_identity_id / matched_representation_id / matched_submission_
// reference_id deliberately carry no DB-level FOREIGN KEY (same schema-
// drift-tooling reason as report_historical_match_snapshots and
// historical_match_shadow_evaluations above). declared_by_account_id /
// confirmed_by_account_id / revoked_by_account_id DO reference users(id)
// ON DELETE SET NULL, matching document_identities.account_id and
// saved_reports.user_id — losing an account must not delete the audit
// trail. The partial unique index enforces at most one ACTIVE (revoked_at
// IS NULL) declaration per match pair; revoked rows are retained, never
// deleted, and do not block a fresh declaration for the same pair.
export const reuse_context_declarations = sqliteTable(
  "reuse_context_declarations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    document_identity_id: text("document_identity_id").notNull(),
    matched_representation_id: text("matched_representation_id").notNull(),
    matched_submission_reference_id: integer("matched_submission_reference_id"),
    declared_context: text("declared_context").notNull(),
    declared_by_account_id: text("declared_by_account_id").references(() => users.id, { onDelete: "set null" }),
    declared_at: text("declared_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    confirmed_by_account_id: text("confirmed_by_account_id").references(() => users.id, { onDelete: "set null" }),
    confirmed_at: text("confirmed_at"),
    verification_state: text("verification_state").notNull().default("SELF_ASSERTED_UNVERIFIED"),
    revoked_at: text("revoked_at"),
    revoked_by_account_id: text("revoked_by_account_id").references(() => users.id, { onDelete: "set null" }),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("ux_reuse_context_declarations_active_pair")
      .on(table.document_identity_id, table.matched_representation_id)
      .where(sql`revoked_at IS NULL`),
    index("idx_reuse_context_declarations_document_identity").on(table.document_identity_id),
    index("idx_reuse_context_declarations_matched_submission_reference").on(table.matched_submission_reference_id),
    index("idx_reuse_context_declarations_declared_by").on(table.declared_by_account_id),
  ],
);

// Durable rate limiting (production audit fix): see
// drizzle/0024_rate_limit_buckets.sql for the full rationale. bucket_key is
// namespaced ("general:<clientId>" vs "auth:<clientId>") so lib/rate-limit.ts's
// checkRate and checkAuthRate never share a bucket for the same client,
// matching the pre-migration two-separate-in-memory-Maps behavior exactly.
export const rate_limit_buckets = sqliteTable(
  "rate_limit_buckets",
  {
    bucket_key: text("bucket_key").primaryKey(),
    tokens: real("tokens").notNull(),
    last_refill: integer("last_refill").notNull(),
    last_allowed: integer("last_allowed").notNull(),
  },
  (table) => [
    index("idx_rate_limit_buckets_last_refill").on(table.last_refill),
  ],
);

// Developer-diagnostics addition (0026): one row per live /api/academic-
// evidence run (lib/academic-evidence-integration.ts), captured additively
// in app/api/reports/route.ts's existing deferred runAfterResponse callback
// — the same one that already creates a document_identities row on first
// save. Before this table existed, runAcademicSearch's own per-run
// diagnostics (generated queries, ranked candidates, per-candidate
// retrieval/comparison outcome, provider errors, stage timings — see
// lib/academic-search/types.ts's AcademicSearchRunStats/
// AcademicSearchRetrievalDiagnostic) were computed on every real submission
// and then discarded; nothing captured them for later inspection. This is
// pure instrumentation: nothing in lib/academic-search/ changes what it
// ranks, retrieves, or reports as evidence because this table exists — it
// only stores values that pipeline already produced.
//
// document_identity_id is nullable and set the same best-effort way
// saved_reports.document_identity_id is (identity capture can fail
// independently of this capture). report_device_key/report_id mirror
// saved_reports' own composite primary key, giving a second, independent
// lookup path if identity capture failed but this still succeeded — same
// "no DB-level FOREIGN KEY on a composite key" reasoning as
// report_historical_match_snapshots above (this project's schema-drift
// tooling only recognizes single-column references()). Variable-shape
// pipeline data (stats, queries, candidates, retrieval diagnostics) is kept
// as JSON columns rather than exploded into a wide, mostly-duplicative
// column set — matching this schema's own existing convention for that
// (see provenance_evidence.payload_json's header comment). total_latency_ms
// is pulled out as its own column since it's the one field a developer
// dashboard needs to sort/filter runs by without parsing stats_json.
export const academic_search_run_diagnostics = sqliteTable(
  "academic_search_run_diagnostics",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    document_identity_id: text("document_identity_id").references(() => document_identities.id, { onDelete: "set null" }),
    report_device_key: text("report_device_key"),
    report_id: text("report_id"),
    status: text("status").notNull(),
    total_latency_ms: integer("total_latency_ms").notNull(),
    stats_json: text("stats_json").notNull(),
    queries_json: text("queries_json"),
    candidates_json: text("candidates_json"),
    retrieval_diagnostics_json: text("retrieval_diagnostics_json"),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_academic_search_run_diagnostics_document_identity_id").on(table.document_identity_id),
    index("idx_academic_search_run_diagnostics_report").on(table.report_device_key, table.report_id),
  ],
);

// Corpus admission / quality gate (v1, drizzle/0029): audit-trail decision
// records for candidates being evaluated for admission into the reusable
// corpus (corpus_document_representations et al. above) — never wired to
// write those tables itself (lib/corpus-admission-gate.ts never imports
// lib/user-submission-corpus.ts's write functions; see
// tests/corpus-admission-privacy.test.mjs). One row per EVALUATION, not per
// candidate: canonical_sha256 is deliberately not unique here (unlike
// corpus_document_representations.canonical_sha256) so the same candidate
// can be re-evaluated under a new policy_version without colliding — the
// calibrate/refreeze/rerun-all-770 workflow depends on this. No
// canonical_text column exists on this table at all — see
// corpus_admission_content_store below for the one place raw text may ever
// be persisted, and lib/corpus-admission-gate.ts's own header comment for
// why the split exists.
export const corpus_admission_decisions = sqliteTable(
  "corpus_admission_decisions",
  {
    id: text("id").primaryKey(),
    run_id: text("run_id"),
    source_ref: text("source_ref").notNull(),
    policy_version: text("policy_version").notNull(),
    decision: text("decision").notNull(),
    reason_codes: text("reason_codes").notNull(),
    hard_gate_passed: integer("hard_gate_passed").notNull(),
    hard_gate_failure_codes: text("hard_gate_failure_codes").notNull(),
    detected_format: text("detected_format"),
    extracted_word_count: integer("extracted_word_count"),
    detected_language: text("detected_language"),
    language_confidence: real("language_confidence"),
    canonical_sha256: text("canonical_sha256"),
    extractor_version: text("extractor_version"),
    // Deliberately not a references() FK — see this table's twin column
    // comment in drizzle/0029_corpus_admission_decisions.sql for why
    // (avoids a circular same-migration FK; the enforced direction lives on
    // corpus_admission_content_store.decision_id below).
    content_store_id: text("content_store_id"),
    quality_score: real("quality_score"),
    quality_model_version: text("quality_model_version"),
    component_scores: text("component_scores"),
    feature_vector: text("feature_vector"),
    feature_vector_version: text("feature_vector_version"),
    corpus_value_score: real("corpus_value_score"),
    corpus_value_model_version: text("corpus_value_model_version"),
    family_relation: text("family_relation"),
    family_matched_source_ref: text("family_matched_source_ref"),
    family_containment: real("family_containment"),
    consent_metadata: text("consent_metadata"),
    dry_run: integer("dry_run").notNull(),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_corpus_admission_decisions_source_ref").on(table.source_ref),
    index("idx_corpus_admission_decisions_decision").on(table.decision),
    index("idx_corpus_admission_decisions_run_id").on(table.run_id),
    // drizzle/0043 — Phase A 7-day corpus maturity. A promotion's OWN decision
    // (promotions.decision_id -> this row) supplies both its account-exclusion
    // source_ref and its immutable maturity T0 (created_at). Range index for
    // lib/report-historical-match.ts's corpusBackingMaturedInWindow scan.
    index("idx_corpus_admission_decisions_created_at").on(table.created_at),
  ],
);

// The ONLY place full extracted text may ever be persisted for a
// corpus-admission candidate (requirement 2/4) — written only when
// dry_run=false AND the decision is ACCEPT AND retention rights were
// resolved; never during a dry run, never for a candidate whose
// retention/consent hard gate failed. See lib/corpus-admission-gate.ts.
export const corpus_admission_content_store = sqliteTable(
  "corpus_admission_content_store",
  {
    id: text("id").primaryKey(),
    decision_id: text("decision_id").notNull().references(() => corpus_admission_decisions.id, { onDelete: "cascade" }),
    canonical_sha256: text("canonical_sha256").notNull(),
    canonical_text: text("canonical_text").notNull(),
    extractor_version: text("extractor_version"),
    retention_basis: text("retention_basis").notNull(),
    stored_at: text("stored_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("ux_corpus_admission_content_store_decision_id").on(table.decision_id),
    index("idx_corpus_admission_content_store_canonical_sha256").on(table.canonical_sha256),
  ],
);

// Corpus admission / quality gate (drizzle/0030): durable, cross-process
// "first accepted sample wins" enforcement — fixes the confirmed
// concurrency/idempotency defect where family resolution only ever checked
// the real corpus tables (never written to by a real ACCEPT here). Holds
// ONLY the derived fingerprint needed for staging dedup — canonical_sha256
// (UNIQUE — the actual atomicity primitive; see the migration file's own
// comment), word_count, and shingle hashes — never raw text.
// lib/corpus-admission-gate.ts is the only writer, always inside a real
// SQLite write transaction paired with a re-check immediately before
// insert, not a JavaScript mutex.
// revoked_at (drizzle/0032): reserved for a future, explicitly
// admin-triggered removal flow (e.g. a legal takedown) — nothing in this
// codebase sets it yet. Accepted corpus content is durable by policy (see
// lib/corpus-admission-report-integration.ts's own header comment): a
// consent change or a report/account deletion never sets this column.
// lib/corpus-admission-gate.ts only ever reads it (filters WHERE
// revoked_at IS NULL in its family-matching queries), so whenever that
// future flow does ship, it is excluded from matching immediately, with no
// further gate changes needed. The canonical_sha256 uniqueness constraint
// below is a PARTIAL index over the same condition — see that migration
// file's own header comment for why a revoked fingerprint must stop
// occupying its hash's uniqueness slot, not just stop matching.
export const corpus_admission_accepted_representations = sqliteTable(
  "corpus_admission_accepted_representations",
  {
    id: text("id").primaryKey(),
    decision_id: text("decision_id").notNull().references(() => corpus_admission_decisions.id, { onDelete: "cascade" }),
    canonical_sha256: text("canonical_sha256").notNull(),
    word_count: integer("word_count").notNull(),
    fingerprint_version: text("fingerprint_version").notNull(),
    revoked_at: text("revoked_at"),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("ux_corpus_admission_accepted_representations_canonical_sha256_active").on(table.canonical_sha256).where(sql`revoked_at IS NULL`),
    uniqueIndex("ux_corpus_admission_accepted_representations_decision_id").on(table.decision_id),
    index("idx_corpus_admission_accepted_representations_revoked_at").on(table.revoked_at),
  ],
);

export const corpus_admission_accepted_shingles = sqliteTable(
  "corpus_admission_accepted_shingles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accepted_representation_id: text("accepted_representation_id").notNull().references(() => corpus_admission_accepted_representations.id, { onDelete: "cascade" }),
    shingle_hash: text("shingle_hash").notNull(),
    fingerprint_version: text("fingerprint_version").notNull(),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("ux_corpus_admission_accepted_shingles_rep_version_hash").on(table.accepted_representation_id, table.fingerprint_version, table.shingle_hash),
    index("idx_corpus_admission_accepted_shingles_hash").on(table.shingle_hash),
  ],
);

// Controlled live-report integration (drizzle/0031): a durable job/status
// record per report so a failed admission attempt is visible and retryable,
// not only ever a console.error line. source_ref is built from
// (account_id, device_key, report_id) directly — see
// lib/corpus-admission-report-integration.ts and the migration file's own
// header comment for why this is deliberately NOT a bare
// document_identity_id (report/account-scoped deletion, and consent-
// revocation cleanup, must never be able to reach a different report's
// retained source). Created SYNCHRONOUSLY (same request that inserts the
// report), never only inside a deferred after() callback — see the
// migration file's own header comment for why, and status/claimed_at's own
// comments for the full pending/succeeded/failed/cancelled/revoked
// lifecycle and the sweep's atomic-claim mechanism.
export const corpus_admission_report_jobs = sqliteTable(
  "corpus_admission_report_jobs",
  {
    id: text("id").primaryKey(),
    source_ref: text("source_ref").notNull(),
    account_id: text("account_id").notNull(),
    device_key: text("device_key").notNull(),
    report_id: text("report_id").notNull(),
    status: text("status").notNull(),
    decision_id: text("decision_id").references(() => corpus_admission_decisions.id, { onDelete: "set null" }),
    claimed_at: text("claimed_at"),
    attempt_count: integer("attempt_count").notNull().default(0),
    last_error: text("last_error"),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updated_at: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    // Device Passport (drizzle/0039): the passport verified synchronously in
    // the upload request, carried here so the deferred admission-decision
    // path can write the per-backing
    // corpus_admission_decision_device_provenance row on ACCEPT. Nullable,
    // no foreign key (mirrors this table's existing plain account_id /
    // device_key columns). Phase 1 = schema foundation only; nothing reads
    // or writes this yet.
    verified_device_passport_id: text("verified_device_passport_id"),
  },
  (table) => [
    uniqueIndex("ux_corpus_admission_report_jobs_source_ref").on(table.source_ref),
    index("idx_corpus_admission_report_jobs_account_id").on(table.account_id),
    index("idx_corpus_admission_report_jobs_sweep_candidates").on(table.status, table.claimed_at),
  ],
);

// Audit trail for the admin-only corpus-admission dashboard (drizzle/0033)
// — see that migration file's own header comment for why there is
// deliberately no FOREIGN KEY here.
export const corpus_admission_admin_audit_log = sqliteTable(
  "corpus_admission_admin_audit_log",
  {
    id: text("id").primaryKey(),
    admin_user_id: text("admin_user_id").notNull(),
    action: text("action").notNull(),
    decision_id: text("decision_id").notNull(),
    accepted_representation_id: text("accepted_representation_id"),
    reason: text("reason"),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_corpus_admission_admin_audit_log_decision_id").on(table.decision_id),
    index("idx_corpus_admission_admin_audit_log_admin_user_id").on(table.admin_user_id),
  ],
);

// Promotion of an ACCEPTed corpus-admission decision's retained text into
// the shared plagiarism-matching index (corpus_document_representations /
// corpus_document_shingles, drizzle/0034) — see
// lib/corpus-admission-promotion.ts's own header comment. No account/report-
// shaped column on purpose: decision_id/accepted_representation_id both
// resolve only through the admin-only corpus_admission_* tables.
export const corpus_admission_promotions = sqliteTable(
  "corpus_admission_promotions",
  {
    id: text("id").primaryKey(),
    decision_id: text("decision_id").notNull().references(() => corpus_admission_decisions.id),
    accepted_representation_id: text("accepted_representation_id").notNull().references(() => corpus_admission_accepted_representations.id),
    representation_id: text("representation_id").references(() => corpus_document_representations.id),
    link_type: text("link_type"),
    fingerprint_version: text("fingerprint_version"),
    status: text("status").notNull().default("staged"),
    claimed_at: text("claimed_at"),
    attempt_count: integer("attempt_count").notNull().default(0),
    last_error: text("last_error"),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updated_at: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("ux_corpus_admission_promotions_decision_id").on(table.decision_id),
    index("idx_corpus_admission_promotions_sweep_candidates").on(table.status, table.claimed_at),
    index("idx_corpus_admission_promotions_representation_id").on(table.representation_id),
  ],
);

// drizzle/0037: durable SINGLETON operational-state table for the admin
// corpus dashboard's status strip — one row per logical sweep kind
// ('promotion' | 'report_admission' | 'retention'), upserted in place, not
// a history log. See that migration's own header comment for the full
// rationale (mirrors corpus_match_generation's own singleton pattern) and
// lib/corpus-admission-sweep-state.ts for the sole writer/reader discipline. No
// account/report/decision/representation-shaped column; last_summary_json
// is a bounded, numeric-only JSON blob.
export const corpus_admission_sweep_runs = sqliteTable("corpus_admission_sweep_runs", {
  sweep_kind: text("sweep_kind").primaryKey(),
  last_run_at: text("last_run_at").notNull(),
  last_status: text("last_status").notNull(),
  last_summary_json: text("last_summary_json"),
  updated_at: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Device Passport — Phase 1 SCHEMA FOUNDATION ONLY (drizzle/0038-0040). Three
// additive tables plus the two verified_device_passport_id columns and the
// report_historical_match_snapshots.device_provenance_generation column
// declared above. NOTHING reads or writes any of this yet: browser key
// generation, challenge issuance, signature verification, device-continuity
// matching, the SELF downgrade, shared-device thresholds, and admin UI are
// all out of scope for this phase. See the three migration files' own header
// comments for the full rationale.

// One row per registered browser public key. id = lowercase SHA-256 hex of
// public_key_spki (idempotent registration). public_key_spki is the raw DER
// SubjectPublicKeyInfo, kept ONLY to verify ECDSA P-256 / SHA-256
// signatures — the private key never leaves the browser. No account_id /
// device_key / foreign key: a passport is deliberately not account-owned
// (cross-account use is the whole point). provenance_generation is a
// PER-PASSPORT monotonic counter — a later phase bumps THIS passport's
// counter when it gains a materially relevant new distinct account
// association, and on revocation. revoked_at is the only removal lever for
// v1. Epoch-millisecond integer timestamps (the sessions / 0010 convention).
export const device_passports = sqliteTable(
  "device_passports",
  {
    id: text("id").primaryKey(),
    public_key_spki: blob("public_key_spki").notNull(),
    algorithm: text("algorithm").notNull().default("ECDSA-P256-SHA256"),
    created_at: integer("created_at").notNull(),
    last_seen_at: integer("last_seen_at"),
    revoked_at: integer("revoked_at"),
    provenance_generation: integer("provenance_generation").notNull().default(0),
    // drizzle/0041 — durable actor-usage completeness marker. 0 (every
    // existing row, the default): historical actor usage is NOT proven
    // complete. 1: durably actor-tracked since creation. NEVER promoted
    // 0 -> 1 after the fact — only a genuinely new passport registered while
    // the dedicated actor HMAC key is available may be born at 1. See
    // lib/device-passport-actor-ledger.ts and device_passport_actor_usage.
    actor_usage_tracking_version: integer("actor_usage_tracking_version").notNull().default(0),
  },
  (table) => [
    index("idx_device_passports_last_seen").on(table.last_seen_at),
  ],
);

// drizzle/0041 — the durable, APPEND-ONLY Device Passport actor-usage ledger.
// One row per (passport, actor-key-version, actor-key) triple ever observed
// uploading under a verified passport. actor_key is a stable keyed pseudonym
// (HMAC-SHA256 over a domain-separated account id) or a fixed anonymous
// sentinel — NEVER a raw account id. Rows are never deleted and
// observation_count is never decremented; a repeat observation preserves
// first_observed_at, advances last_observed_at, increments observation_count.
// device_passport_id is ON DELETE RESTRICT so a passport can never be removed
// while any usage observation references it. NOTHING in any scoring path reads
// this yet. See lib/device-passport-actor-ledger.ts and drizzle/0041.
export const device_passport_actor_usage = sqliteTable(
  "device_passport_actor_usage",
  {
    device_passport_id: text("device_passport_id")
      .notNull()
      .references(() => device_passports.id, { onDelete: "restrict" }),
    actor_key_version: integer("actor_key_version").notNull(),
    actor_key: text("actor_key").notNull(),
    is_anonymous: integer("is_anonymous").notNull().default(0),
    first_observed_at: integer("first_observed_at").notNull(),
    last_observed_at: integer("last_observed_at").notNull(),
    observation_count: integer("observation_count").notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.device_passport_id, table.actor_key_version, table.actor_key] }),
    index("idx_device_passport_actor_usage_passport").on(table.device_passport_id),
  ],
);

// One row per issued device-attestation challenge nonce. nonce_hash is
// SHA-256 of the 32-byte random nonce — the raw nonce is returned to the
// client exactly once and never stored (the sessions.token_hash discipline).
// account_id / session_token_hash capture the session context SERVER-SIDE at
// issue time; verification compares them against the then-current session,
// so the browser never handles a session secret. Single-use via an atomic
// consumed_at write. Rows are removed freely once expired (opportunistic,
// traffic-piggybacked — the rate_limit_buckets / 0024 pattern). No foreign
// key: a challenge outlives nothing.
export const device_passport_challenges = sqliteTable(
  "device_passport_challenges",
  {
    id: text("id").primaryKey(),
    nonce_hash: text("nonce_hash").notNull(),
    account_id: text("account_id"),
    session_token_hash: text("session_token_hash"),
    issued_at: integer("issued_at").notNull(),
    expires_at: integer("expires_at").notNull(),
    consumed_at: integer("consumed_at"),
  },
  (table) => [
    index("idx_device_passport_challenges_expiry").on(table.expires_at),
  ],
);

// One verified device per admission decision (decision_id is the primary
// key). The ONLY place a promoted corpus backing is linked to a device
// passport — joined to the deduplicated representation only through
// corpus_admission_promotions.decision_id, the same per-backing shape
// admissionEligibilitySql already uses for the account check. The passport
// id is NEVER placed on corpus_document_representations (deduplicated, many
// independent backings). decision_id CASCADEs with its decision (accepted
// provenance is as durable as the accepted decision); device_passport_id is
// RESTRICT so a passport can never be removed while a promoted backing still
// references it. verified_at is an epoch-millisecond integer.
export const corpus_admission_decision_device_provenance = sqliteTable(
  "corpus_admission_decision_device_provenance",
  {
    decision_id: text("decision_id")
      .primaryKey()
      .references(() => corpus_admission_decisions.id, { onDelete: "cascade" }),
    device_passport_id: text("device_passport_id")
      .notNull()
      .references(() => device_passports.id, { onDelete: "restrict" }),
    verified_at: integer("verified_at").notNull(),
  },
  (table) => [
    index("idx_cadp_device_passport_id").on(table.device_passport_id),
  ],
);

// ── Direct owner-link foundation (drizzle/0042) — SCHEMA + STORAGE ONLY ──────
// Three additive tables plus report_historical_match_snapshots.owner_link_generation
// (declared above). NOTHING reads or writes any of this yet: computeUnifiedSimilarity,
// resolveEffectiveDeviceSelfRepresentationIds, the same-device SELF rule, the
// Policy D shared-device guard, relationshipType, candidate discovery and the
// matcher are all untouched, and no OWNER_LINK_SELF_ENABLED flag is wired into
// scoring. See lib/owner-link.ts / lib/owner-link-repo.ts and the migration's
// own header for the full rationale.
//
// account_owner_links: one row per canonical unordered account-ref pair.
// account_ref_lo / account_ref_hi are HMAC pseudonyms
// (HMAC-SHA256(OWNER_LINK_HMAC_KEY, "TP_OWNER_LINK_V1:" + accountId), lib/owner-link.ts) —
// NEVER a raw account id — ordered lexicographically so {A,B} and {B,A} collapse
// to one row (a SQL CHECK (account_ref_lo < account_ref_hi) enforces it and
// rules out a self-pair; not modelled here as this project's schema-drift
// tooling does not compare CHECK constraints, matching corpus_match_generation's
// own id=1 CHECK). status ACTIVE | WITHDRAWN — ACTIVE iff >= 1 live owner-bound
// HIGH evidence row (the v1 OWNERSHIP-ESTABLISHING threshold; MEDIUM owner-bound
// evidence is SUPPORTING only and never establishes or keeps ACTIVE alone — see
// lib/owner-link.ts evidenceCanEstablishActiveLink and the migration header).
// WITHDRAWN is a tombstone; a link row is NEVER deleted. strongest_confidence is
// the strongest confidence across the link's non-withdrawn evidence, retained
// for admin / audit — it does NOT gate status. Epoch-ms integer timestamps (the
// 0038 convention). withdrawn_reason is a CHECK-
// constrained controlled vocabulary (lib/owner-link.ts's
// OWNER_LINK_WITHDRAWAL_REASONS — MANUAL_REVIEW | REVOKED | NO_QUALIFYING_EVIDENCE
// | SUPERSEDED | ADMIN_CORRECTION, or NULL), never free text; the CHECK lives in
// the migration only (schema-drift tooling does not compare CHECKs).
// idx_account_owner_links_account_ref_hi is the reverse-endpoint index — the
// unique pair index already covers account_ref_lo lookups (leftmost column), so
// only account_ref_hi needs its own.
// HMAC KEY ROTATION: OWNER_LINK_HMAC_KEY has no online rotation path in v1 —
// changing it orphans every ref and every generation counter (see
// lib/owner-link.ts / the migration header). GENERATION SCOPE: the per-account
// link_generation is sufficient ONLY for direct pairs; a transitive phase MUST
// add cluster-wide invalidation.
export const account_owner_links = sqliteTable(
  "account_owner_links",
  {
    id: text("id").primaryKey(),
    account_ref_lo: text("account_ref_lo").notNull(),
    account_ref_hi: text("account_ref_hi").notNull(),
    key_version: integer("key_version").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    strongest_confidence: text("strongest_confidence").notNull(),
    first_linked_at: integer("first_linked_at").notNull(),
    last_evidence_at: integer("last_evidence_at").notNull(),
    withdrawn_at: integer("withdrawn_at"),
    withdrawn_reason: text("withdrawn_reason"),
    decided_by: text("decided_by").notNull().default("SYSTEM"),
  },
  (table) => [
    uniqueIndex("ux_account_owner_links_pair").on(
      table.account_ref_lo,
      table.account_ref_hi,
      table.key_version,
    ),
    index("idx_account_owner_links_account_ref_hi").on(table.account_ref_hi),
  ],
);

// account_owner_link_evidence: append-only, tombstone-only evidence rows.
// link_id -> account_owner_links(id) ON DELETE RESTRICT (an owner link can
// never be removed while any evidence references it, and links are never
// removed anyway — the same posture drizzle/0039 / drizzle/0041 took).
// evidence_fingerprint is itself an HMAC / domain-separated digest over a
// JSON-encoded component array (lib/owner-link.ts's ownerLinkEvidenceFingerprint
// — unambiguous, so ["a b","c"] and ["a","b c"] never collide), NEVER a raw
// account / passport / phone / email value. signal_type is a CHECK-constrained
// closed vocabulary (lib/owner-link.ts's ALL_OWNER_LINK_SIGNAL_TYPES) — the
// CHECK lives in the migration only. confidence HIGH | MEDIUM | LOW: HIGH is the
// v1 ownership-ESTABLISHING tier; MEDIUM owner-bound rows are SUPPORTING only
// (they attach to an existing link but never create/keep ACTIVE alone).
// observation_count / first_observed_at /
// last_observed_at follow UPSERT semantics keyed on
// UNIQUE(link_id, signal_type, evidence_fingerprint): a repeat observation
// PRESERVES first_observed_at, ADVANCES last_observed_at, INCREMENTS
// observation_count. observation_count / first_observed_at are preserved across
// every revive. withdrawn_at tombstones a row; rows are NEVER deleted, counts
// NEVER decremented. withdrawn_reason is the same CHECK-constrained controlled
// vocabulary as account_owner_links.withdrawn_reason but reflects only the
// CURRENT tombstone (NULL for a live row; a revive necessarily clears it, since
// a live row must read as live). The withdrawal/revival AUDIT HISTORY is NOT on
// the live row — it is the append-only account_owner_link_events table below.
// detail_json is a bounded numeric / boolean / short-enum-token blob only
// (lib/owner-link.ts's boundOwnerLinkDetail).
export const account_owner_link_evidence = sqliteTable(
  "account_owner_link_evidence",
  {
    id: text("id").primaryKey(),
    link_id: text("link_id")
      .notNull()
      .references(() => account_owner_links.id, { onDelete: "restrict" }),
    confidence: text("confidence").notNull(),
    signal_type: text("signal_type").notNull(),
    evidence_fingerprint: text("evidence_fingerprint").notNull(),
    observation_count: integer("observation_count").notNull().default(1),
    first_observed_at: integer("first_observed_at").notNull(),
    last_observed_at: integer("last_observed_at").notNull(),
    withdrawn_at: integer("withdrawn_at"),
    withdrawn_reason: text("withdrawn_reason"),
    detail_json: text("detail_json"),
    created_by: text("created_by").notNull().default("SYSTEM"),
  },
  (table) => [
    uniqueIndex("ux_account_owner_link_evidence_signal").on(
      table.link_id,
      table.signal_type,
      table.evidence_fingerprint,
    ),
    index("idx_account_owner_link_evidence_link").on(table.link_id),
  ],
);

// account_owner_link_events (drizzle/0042): APPEND-ONLY state-transition log —
// the immutable history the live account_owner_links / _evidence rows cannot be
// (reviving a tombstoned evidence row necessarily clears its own withdrawn_at /
// withdrawn_reason). One row per meaningful ACTIVE<->WITHDRAWN transition plus
// link / evidence genesis (lib/owner-link.ts OWNER_LINK_EVENT_TYPES). Rows are
// NEVER updated or deleted; nothing here cascades from report / room / account
// cleanup (both FKs are ON DELETE RESTRICT and neither parent is ever deleted).
// id is an autoincrement INTEGER so insertion order is the canonical event
// order. event_type / previous_state / new_state / reason / actor are all
// CHECK-constrained bounded enums (the CHECKs live in the migration only);
// reason reuses OWNER_LINK_WITHDRAWAL_REASONS and is non-NULL only on a
// *_WITHDRAWN event. Beyond the per-column vocabularies, ONE table-level shape
// CHECK (also migration-only) pins each event_type to its single legal
// combination of evidence_id presence / previous_state / new_state / reason
// presence — mirrored by lib/owner-link.ts's assertOwnerLinkEventShape. actor is
// SYSTEM | ADMIN as a CLASS, not proof of which administrator (this foundation
// stores no admin identity). NO account ref / passport id / fingerprint / email
// / IP / free text — only internal link/evidence ids, enums, one reason, one
// actor class, one epoch-ms timestamp. Every insert is in the same write
// transaction as the state mutation it records.
export const account_owner_link_events = sqliteTable(
  "account_owner_link_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    link_id: text("link_id")
      .notNull()
      .references(() => account_owner_links.id, { onDelete: "restrict" }),
    evidence_id: text("evidence_id").references(() => account_owner_link_evidence.id, { onDelete: "restrict" }),
    event_type: text("event_type").notNull(),
    previous_state: text("previous_state"),
    new_state: text("new_state").notNull(),
    reason: text("reason"),
    actor: text("actor").notNull(),
    occurred_at: integer("occurred_at").notNull(),
  },
  (table) => [
    index("idx_account_owner_link_events_link").on(table.link_id, table.id),
    index("idx_account_owner_link_events_evidence")
      .on(table.evidence_id, table.id)
      .where(sql`evidence_id IS NOT NULL`),
  ],
);

// account_owner_link_state: one row per (account_ref, key_version) carrying a
// monotonic link_generation counter, bumped on BOTH endpoints whenever a direct
// link between them is created, materially gains / loses evidence, or is
// withdrawn. Never a global counter; an absent row reads as generation 0. A
// later phase stamps report_historical_match_snapshots.owner_link_generation
// with the report account's counter and treats the owner-link-sensitive part of
// the snapshot as stale once the stored value trails it — the same per-key
// staleness shape corpus_generation / device_provenance_generation use.
export const account_owner_link_state = sqliteTable(
  "account_owner_link_state",
  {
    account_ref: text("account_ref").notNull(),
    key_version: integer("key_version").notNull(),
    link_generation: integer("link_generation").notNull().default(0),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.account_ref, table.key_version] }),
  ],
);

// Phase B2a (drizzle/0044): bounded SHADOW-MEASUREMENT telemetry for the B1
// corpus-duplicate counterfactual (lib/corpus-duplicate-suppression-policy.ts +
// lib/corpus-duplicate-counterfactual.ts). MEASUREMENT ONLY — never read by the
// production similarity / relationship / scoring path; write-only from
// lib/corpus-duplicate-suppression-shadow.ts, scheduled off-response. No B2
// field ever reaches an ordinary user's report payload. See
// drizzle/0044_corpus_duplicate_suppression_shadow_evaluations.sql for the full
// rationale, the nullable-measurement-column contract, and the AFTER DELETE
// trigger (which drizzle-orm cannot express and which the schema-drift test does
// not enumerate — its correctness is covered by the B2 deletion tests). No
// DB-level FOREIGN KEY, same reasoning as report_historical_match_snapshots /
// historical_match_shadow_evaluations above. report_device_key is a random
// per-browser UUID, not an account identity.
export const corpus_duplicate_suppression_shadow_evaluations = sqliteTable(
  "corpus_duplicate_suppression_shadow_evaluations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    report_device_key: text("report_device_key").notNull(),
    report_id: text("report_id").notNull(),
    status: text("status").notNull(),
    error_code: text("error_code"),
    error_detail: text("error_detail"),
    checker_accounts_status: text("checker_accounts_status").notNull().default("NOT_APPLICABLE"),
    distinct_checker_accounts_bucket: text("distinct_checker_accounts_bucket"),
    policy_version: text("policy_version").notNull(),
    rule_version: text("rule_version").notNull(),
    unified_similarity_version: text("unified_similarity_version").notNull(),
    counterfactual_version: text("counterfactual_version").notNull(),
    authoritative_corpus_generation: integer("authoritative_corpus_generation"),
    authoritative_snapshot_computed_at: text("authoritative_snapshot_computed_at"),
    submitted_word_count: integer("submitted_word_count"),
    authoritative_score: integer("authoritative_score"),
    hypothetical_score: integer("hypothetical_score"),
    score_delta: integer("score_delta"),
    authoritative_unique_matched_words: integer("authoritative_unique_matched_words"),
    hypothetical_unique_matched_words: integer("hypothetical_unique_matched_words"),
    unique_matched_words_removed: integer("unique_matched_words_removed"),
    candidate_matched_words: integer("candidate_matched_words"),
    candidates_excluded: integer("candidates_excluded"),
    archive_only_words_surviving: integer("archive_only_words_surviving"),
    live_academic_only_words_surviving: integer("live_academic_only_words_surviving"),
    previous_upload_only_words_surviving: integer("previous_upload_only_words_surviving"),
    overlap_words_surviving: integer("overlap_words_surviving"),
    candidate_count: integer("candidate_count"),
    measurement_category: text("measurement_category"),
    origin_confidence: text("origin_confidence"),
    multi_origin_evidence: text("multi_origin_evidence"),
    candidate_admitted_promotion_backing_count: integer("candidate_admitted_promotion_backing_count"),
    candidate_submission_reference_backing_count: integer("candidate_submission_reference_backing_count"),
    candidate_independent_backing_count: integer("candidate_independent_backing_count"),
    candidate_same_device_backing_count: integer("candidate_same_device_backing_count"),
    same_passport_category: integer("same_passport_category"),
    cross_account_category: integer("cross_account_category"),
    evaluation_truncated: integer("evaluation_truncated").notNull().default(0),
    total_runtime_ms: integer("total_runtime_ms"),
    computed_at: text("computed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("ux_corpus_duplicate_suppression_shadow_report_policy").on(
      table.report_device_key,
      table.report_id,
      table.policy_version,
    ),
  ],
);

// ── Account Identity FOUNDATION (drizzle/0045) — SCHEMA + STORAGE ONLY ──────
// Two additive tables; NOTHING is altered on `users` or any other existing
// table. NOTHING reads or writes any of this in a scoring / similarity /
// owner-link / Device Passport / corpus path — see lib/account-identity.ts and
// lib/account-identity-repo.ts and tests/account-identity*.test.mjs.
//
// account_identity_profiles: strictly 1:1 with `users` (user_id is BOTH the
// primary key and a REFERENCES users(id) ON DELETE CASCADE foreign key, so
// account deletion removes the profile automatically — it is per-account PII,
// unlike the durable RESTRICT owner-link tables). account_type (student |
// instructor | researcher | independent) is DESCRIPTIVE identity, never
// authorization — `users.role` stays the only authorization field. Institution
// and city each have an explicit 'NONE' state plus a canonical form (ROR id /
// GeoNames id) and a low-trust 'UNVERIFIED_TEXT' form kept only for future
// import compatibility. full_name is NOT NULL (the required identity anchor).
// country_code is RESIDENCE (ISO 3166-1 alpha-2), a separate concept from
// phone_region (the phone number's own dial context). phone_e164 is
// libphonenumber-js/max-validated E.164, with a wildcard-free structural DB
// backstop CHECK. The *_verified_at columns are ALWAYS NULL in this phase — no
// code marks anything VERIFIED in A1. The CHECK constraints (account_type /
// *_status vocabularies, the one-shape-per-status consistency rules, the
// country / E.164 structural backstops) live in the migration only, matching
// this project's schema-drift tooling (which does not compare CHECKs), as
// account_owner_links already does.
//
// account_identity_fingerprints: FUTURE keyed-HMAC pseudonyms of VERIFIED
// identity values. In A1 this table is NEVER written — lib/account-identity-repo.ts
// has a reader and no writer, and lib/account-identity.ts's
// accountIdentityFingerprint fails closed unless { verified: true }. A
// fingerprint is an HMAC-SHA256 digest, never a raw email / phone / ror id.
export const account_identity_profiles = sqliteTable(
  "account_identity_profiles",
  {
    user_id: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    account_type: text("account_type").notNull().default("independent"),
    // NOT NULL — the required human-identity anchor. normalizeAccountIdentityProfile
    // rejects a missing/empty name, so a profile row never exists without one.
    full_name: text("full_name").notNull(),
    country_code: text("country_code"),
    institution_status: text("institution_status").notNull().default("NONE"),
    institution_ror_id: text("institution_ror_id"),
    institution_unverified_name: text("institution_unverified_name"),
    city_status: text("city_status").notNull().default("NONE"),
    city_geonames_id: integer("city_geonames_id"),
    city_unverified_name: text("city_unverified_name"),
    phone_e164: text("phone_e164"),
    phone_region: text("phone_region"),
    // ALWAYS NULL in A1 — the verified-identity phase is purely additive on top.
    email_verified_at: integer("email_verified_at"),
    phone_verified_at: integer("phone_verified_at"),
    institution_verified_at: integer("institution_verified_at"),
    normalization_version: integer("normalization_version").notNull().default(1),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_account_identity_profiles_institution_ror")
      .on(table.institution_ror_id)
      .where(sql`institution_ror_id IS NOT NULL`),
    index("idx_account_identity_profiles_city_geonames")
      .on(table.city_geonames_id)
      .where(sql`city_geonames_id IS NOT NULL`),
    index("idx_account_identity_profiles_country_code")
      .on(table.country_code)
      .where(sql`country_code IS NOT NULL`),
  ],
);

export const account_identity_fingerprints = sqliteTable(
  "account_identity_fingerprints",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fingerprint_kind: text("fingerprint_kind").notNull(),
    fingerprint: text("fingerprint").notNull(),
    key_version: integer("key_version").notNull(),
    source_verified_at: integer("source_verified_at").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("ux_account_identity_fingerprints_kind").on(
      table.user_id,
      table.fingerprint_kind,
      table.key_version,
    ),
    index("idx_account_identity_fingerprints_lookup").on(
      table.fingerprint_kind,
      table.fingerprint,
    ),
  ],
);

// Export nothing else — Drizzle will consume these definitions for migrations.
export {};

