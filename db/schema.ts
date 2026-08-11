import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  blob,
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
  }
);

// Document chunks: documents can be split into manageable chunks for indexing
export const document_chunks = sqliteTable(
  "document_chunks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    document_id: text("document_id").notNull().references(() => documents.id),
    chunk_index: integer("chunk_index").notNull(),
    token_count: integer("token_count").notNull(),
    token_start: integer("token_start").notNull(),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  }
);

// Chunk fingerprints / shingles — one row per shingle occurrence (positioned)
export const chunk_fingerprints = sqliteTable(
  "chunk_fingerprints",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chunk_id: integer("chunk_id").notNull().references(() => document_chunks.id),
    shingle_hash: text("shingle_hash").notNull(),
    position: integer("position").notNull(),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  }
);

// Analysis runs record when a similarity analysis was performed for a document
export const analysis_runs = sqliteTable(
  "analysis_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    document_id: text("document_id").notNull().references(() => documents.id),
    run_at: text("run_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    analyzer_version: text("analyzer_version"),
    status: text("status").notNull().default("complete"),
    result_json: text("result_json"),
  }
);

// Matches: top-level source matches discovered during an analysis run
export const matches = sqliteTable(
  "matches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    analysis_run_id: integer("analysis_run_id").notNull().references(() => analysis_runs.id),
    source_document_id: text("source_document_id").notNull().references(() => documents.id),
    matched_words: integer("matched_words").notNull().default(0),
    containment: real("containment").notNull().default(0),
    score: integer("score").notNull().default(0),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  }
);

// Match segments represent contiguous matched spans for a given match
export const match_segments = sqliteTable(
  "match_segments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    match_id: integer("match_id").notNull().references(() => matches.id),
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
  }
);

// Contributions: track individual corpus contributions (external identifier)
export const contributions = sqliteTable(
  "contributions",
  {
    contribution_id: text("contribution_id").primaryKey(),
    document_id: text("document_id").notNull().references(() => documents.id),
    contribution_policy_version: text("contribution_policy_version").notNull(),
    created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  }
);

// Export nothing else — Drizzle will consume these definitions for migrations.
export {};

