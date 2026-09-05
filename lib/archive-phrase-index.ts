import type { Client, InStatement } from "@libsql/client";
import { tokens } from "./similarity-core";

/**
 * 100k-scale architecture — the contentless FTS5 phrase index over the
 * built-in archive, and its query helpers. Ported from the Slice 2A.4
 * prototype (tests/compact-archive-index/phrase-fallback/lib-fts.mjs),
 * validated in Slices 2A.4 / 2A.5.
 *
 * The index body for one archive document is exactly
 * tokens(canonical_text).join(" ") — the SAME token stream
 * lib/archive-similarity-scoring.ts shingles. The `ascii` FTS5 tokenizer on
 * that already-normalize()d stream is byte-identical to tokens() (proven:
 * 49,019/49,019 distinct terms on the real archive), so an FTS5 exact-phrase
 * MATCH is exactly "does this document's token stream contain this contiguous
 * word run". content='' stores no text — only the compressed inverted index,
 * one logical row per document.
 *
 * The virtual table `archive_phrase_fts` cannot be modelled by Drizzle; it is
 * created by drizzle/0049 and (re)populated here. A contentless FTS5 table
 * cannot return representation_id (reading its column yields NULL), so every
 * lookup joins back through archive_phrase_fts_map on the FTS rowid.
 */

/** Phrase/FTS policy generation. Bump on a tokenizer, body-derivation, or
 *  table-shape change; lib/archive-index-build.ts's rebuild path consults it
 *  to force a full FTS rebuild. Kept as its own constant so a phrase-index
 *  change is never conflated with a fingerprint-algorithm change
 *  (ARCHIVE_COMPACT_FINGERPRINT_VERSION) or a DF-policy change
 *  (ARCHIVE_DF_BAND_POLICY_VERSION). The FTS index carries no per-row version
 *  column — it is always rebuilt wholesale. */
export const ARCHIVE_PHRASE_INDEX_VERSION = "archive-phrase-fts5-v1";

export const ARCHIVE_PHRASE_FTS_TABLE = "archive_phrase_fts";
export const ARCHIVE_PHRASE_FTS_MAP_TABLE = "archive_phrase_fts_map";

/**
 * FTS5 phrase-query string: ONE double-quoted run so FTS5 enforces ordered
 * adjacency across the whole span. `"a" "b"` (per-token quoting) would be two
 * AND-ed phrases, not one phrase — the classic FTS5 footgun. tokens() output
 * contains only \p{L}\p{N}; a literal " can't occur, but the doubled-quote
 * escape is kept as defence in depth.
 */
export function toPhraseMatch(phraseWords: string[]): string {
  return `"${phraseWords.map((w) => String(w).replace(/"/g, '""')).join(" ")}"`;
}

/** The exact string indexed for one archive document. */
export function phraseIndexBody(canonicalText: string): string {
  return tokens(canonicalText).join(" ");
}

/** The two statements that add ONE document to the phrase index — a plain
 *  map row (rowid auto-assigned as max+1) then the FTS row bound to that
 *  same rowid via a subquery (client.batch runs both in one transaction, so
 *  statement 2 sees what statement 1 wrote). */
export function phraseIndexInsertStatements(representationId: string, canonicalText: string): InStatement[] {
  return [
    { sql: `INSERT INTO ${ARCHIVE_PHRASE_FTS_MAP_TABLE}(representation_id) VALUES (?)`, args: [representationId] },
    {
      sql: `INSERT INTO ${ARCHIVE_PHRASE_FTS_TABLE}(rowid, body)
            SELECT fts_rowid, ? FROM ${ARCHIVE_PHRASE_FTS_MAP_TABLE} WHERE representation_id = ?`,
      args: [phraseIndexBody(canonicalText), representationId],
    },
  ];
}

/** Wipe the whole phrase index without DROP (no destructive DDL, no
 *  contentless_delete needed): FTS5's 'delete-all' special command clears the
 *  contentless index; the bridge table is emptied normally. */
export async function clearPhraseIndex(client: Client): Promise<void> {
  await client.execute(`INSERT INTO ${ARCHIVE_PHRASE_FTS_TABLE}(${ARCHIVE_PHRASE_FTS_TABLE}) VALUES('delete-all')`);
  await client.execute(`DELETE FROM ${ARCHIVE_PHRASE_FTS_MAP_TABLE}`);
}

/** Merge FTS5 b-tree segments — run once after a bulk (re)build. */
export async function optimizePhraseIndex(client: Client): Promise<void> {
  await client.execute(`INSERT INTO ${ARCHIVE_PHRASE_FTS_TABLE}(${ARCHIVE_PHRASE_FTS_TABLE}) VALUES('optimize')`);
}

/**
 * Every archive document whose token stream contains `phraseWords` as a
 * contiguous run. representation_id list only — no text, no snippet, no score.
 */
export async function phraseSearch(client: Client, phraseWords: string[], limit = 100_000): Promise<string[]> {
  const res = await client.execute({
    sql: `SELECT m.representation_id AS representation_id
            FROM ${ARCHIVE_PHRASE_FTS_TABLE} f
            JOIN ${ARCHIVE_PHRASE_FTS_MAP_TABLE} m ON m.fts_rowid = f.rowid
           WHERE f.${ARCHIVE_PHRASE_FTS_TABLE} MATCH ?
           LIMIT ?`,
    args: [toPhraseMatch(phraseWords), limit],
  });
  return res.rows.map((r) => String((r as unknown as { representation_id: string }).representation_id));
}

/**
 * Fan-out count for a phrase without materialising the id list. For an exact
 * 5-word run this IS that 5-gram's archive-wide document frequency (modulo the
 * same hash-collision tolerance the scorer already accepts) — the FTS index
 * doubles as the exact DF oracle for DF values the compact df-band table
 * does not persist (lib/archive-phrase-fallback.ts).
 */
export async function phraseFanOut(client: Client, phraseWords: string[]): Promise<number> {
  const res = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM ${ARCHIVE_PHRASE_FTS_TABLE} f WHERE f.${ARCHIVE_PHRASE_FTS_TABLE} MATCH ?`,
    args: [toPhraseMatch(phraseWords)],
  });
  return Number((res.rows[0] as unknown as { n: number | bigint }).n);
}
