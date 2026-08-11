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
  },
  (table) => [
    primaryKey({ columns: [table.device_key, table.id] }),
    index("idx_saved_reports_device_key_created").on(table.device_key, table.report_created_at),
  ],
);

// Export nothing else — Drizzle will consume these definitions for migrations.
export {};

