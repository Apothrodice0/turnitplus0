CREATE TABLE `analysis_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`run_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`analyzer_version` text,
	`status` text DEFAULT 'complete' NOT NULL,
	`result_json` text
);
--> statement-breakpoint
CREATE TABLE `chunk_fingerprints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chunk_id` integer NOT NULL,
	`shingle_hash` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `document_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`text` text NOT NULL,
	`token_count` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`provenance_sha256` text NOT NULL,
	`source_type` text DEFAULT 'Publication' NOT NULL,
	`original_similarity` real,
	`word_count` integer NOT NULL,
	`unique_shingle_count` integer NOT NULL,
	`storage_pointer` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `index_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`corpus_version` text NOT NULL,
	`key_count` integer DEFAULT 0 NOT NULL,
	`posting_count` integer DEFAULT 0 NOT NULL,
	`assets_json` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deployed_at` text
);
--> statement-breakpoint
CREATE TABLE `match_segments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_id` integer NOT NULL,
	`segment_start` integer NOT NULL,
	`segment_end` integer NOT NULL,
	`positions_blob` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `matches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`analysis_run_id` integer NOT NULL,
	`source_document_id` text NOT NULL,
	`matched_words` integer DEFAULT 0 NOT NULL,
	`containment` real DEFAULT 0 NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
