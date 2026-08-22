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
  },
  (table) => [
    primaryKey({ columns: [table.device_key, table.id] }),
    index("idx_saved_reports_device_key_created").on(table.device_key, table.report_created_at),
    index("idx_saved_reports_user_id_created").on(table.user_id, table.report_created_at),
    index("idx_saved_reports_document_identity_id").on(table.document_identity_id),
    index("idx_saved_reports_user_room").on(table.user_id, table.room_number),
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
  },
  (table) => [
    uniqueIndex("ux_report_historical_match_snapshots_report").on(table.report_device_key, table.report_id),
  ],
);

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

// Export nothing else — Drizzle will consume these definitions for migrations.
export {};

