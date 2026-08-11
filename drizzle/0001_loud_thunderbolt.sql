PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_analysis_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`run_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`analyzer_version` text,
	`status` text DEFAULT 'complete' NOT NULL,
	`result_json` text,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_analysis_runs`("id", "document_id", "run_at", "analyzer_version", "status", "result_json") SELECT "id", "document_id", "run_at", "analyzer_version", "status", "result_json" FROM `analysis_runs`;--> statement-breakpoint
DROP TABLE `analysis_runs`;--> statement-breakpoint
ALTER TABLE `__new_analysis_runs` RENAME TO `analysis_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_chunk_fingerprints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chunk_id` integer NOT NULL,
	`shingle_hash` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`chunk_id`) REFERENCES `document_chunks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_chunk_fingerprints`("id", "chunk_id", "shingle_hash", "position", "created_at") SELECT "id", "chunk_id", "shingle_hash", "position", "created_at" FROM `chunk_fingerprints`;--> statement-breakpoint
DROP TABLE `chunk_fingerprints`;--> statement-breakpoint
ALTER TABLE `__new_chunk_fingerprints` RENAME TO `chunk_fingerprints`;--> statement-breakpoint
CREATE TABLE `__new_document_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`text` text NOT NULL,
	`token_count` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_document_chunks`("id", "document_id", "chunk_index", "text", "token_count", "created_at") SELECT "id", "document_id", "chunk_index", "text", "token_count", "created_at" FROM `document_chunks`;--> statement-breakpoint
DROP TABLE `document_chunks`;--> statement-breakpoint
ALTER TABLE `__new_document_chunks` RENAME TO `document_chunks`;--> statement-breakpoint
CREATE TABLE `__new_match_segments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_id` integer NOT NULL,
	`segment_start` integer NOT NULL,
	`segment_end` integer NOT NULL,
	`positions_blob` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_match_segments`("id", "match_id", "segment_start", "segment_end", "positions_blob", "created_at") SELECT "id", "match_id", "segment_start", "segment_end", "positions_blob", "created_at" FROM `match_segments`;--> statement-breakpoint
DROP TABLE `match_segments`;--> statement-breakpoint
ALTER TABLE `__new_match_segments` RENAME TO `match_segments`;--> statement-breakpoint
CREATE TABLE `__new_matches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`analysis_run_id` integer NOT NULL,
	`source_document_id` text NOT NULL,
	`matched_words` integer DEFAULT 0 NOT NULL,
	`containment` real DEFAULT 0 NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`analysis_run_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_matches`("id", "analysis_run_id", "source_document_id", "matched_words", "containment", "score", "created_at") SELECT "id", "analysis_run_id", "source_document_id", "matched_words", "containment", "score", "created_at" FROM `matches`;--> statement-breakpoint
DROP TABLE `matches`;--> statement-breakpoint
ALTER TABLE `__new_matches` RENAME TO `matches`;