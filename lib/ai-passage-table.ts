/**
 * ai-compact-v1 — the lossless, versioned compact form of an AI result's per-window passage list.
 *
 * WHY. The browser's AI result lists EVERY scored 240-token window (stride 120 => 50 % overlap, uncapped), each
 * carrying a decoded copy of its own ~1,000-character text plus 13 metadata fields. Summed, that is ~2.0x the
 * manuscript in copied text and ~2.4x in JSON — and it was sent and persisted TWICE over: by the automatic post-upload
 * AI save (which re-POSTs the whole report) and by an AI Retry. A ~600k-character report that saved and opened
 * perfectly therefore 413'd on its very first AI save and again on Retry (2,000,000-byte ceiling), and the only reader
 * of that text (components/report/ai-report.tsx) has the manuscript in hand anyway.
 *
 * WHAT. `passages: []` plus a `compactPassages` table: one 7-number row per window that POINTS INTO the already
 * persisted manuscript instead of copying it —
 *
 *   [start, end, charStart, charEnd, logOdds, probability, flagged(0|1), lead?, trail?]
 *
 * `start`/`end` are the window's token indices (unchanged meaning), `[charStart, charEnd)` is a slice of the frozen
 * display basis (below), `logOdds`/`probability`/`flagged` are the model outputs (not derivable, persisted as is), and
 * `lead`/`trail` (omitted when 0) count the U+FFFD edge fragments a window boundary that splits a multi-byte character
 * puts in today's persisted text. Every other passage field is DERIVED on read: wordStart = tokenStart = start,
 * wordEnd = tokenEnd = end, tokenCount = end - start, wasTruncated = false, wordCount = the words in the rebuilt
 * text. Nothing is dropped and nothing is approximated: expand(compact(x)) is deep-equal to x, field for field,
 * INCLUDING today's `text` — the encoder proves that for every window before it emits a table (and hands the
 * caller the legacy form, untouched, if it cannot).
 *
 * THE FROZEN DISPLAY BASIS (`textRule: 1`):  basis = cleanup_v1( NFC( toWellFormed( manuscript ) ) )
 *   - toWellFormed: the tokenizer's byte-level encoder turns a lone UTF-16 surrogate into U+FFFD;
 *   - NFC: ModernBERT's normalizer;
 *   - cleanup_v1: a frozen copy of transformers.js 4.2.0's `clean_up_tokenization` (the ten regexes the tokenizer runs
 *     on every window because tokenizer_config.json sets clean_up_tokenization_spaces).
 * Freezing it in-repo (rather than calling the tokenizer) is what keeps this module dependency-free and lets a row
 * written today be rebuilt identically after a library upgrade. Windows the basis cannot reproduce — a literal
 * `[CLS]`/`[MASK]`/`<|endoftext|>` in the manuscript, a clean-up pattern split by a window boundary — carry their text
 * as a bounded LITERAL instead; past the literal budget the whole analysis simply stays in the legacy form.
 *
 * INTEGRITY. `textLength` + `textHash` (FNV-1a-32 of the analysed manuscript) tie a table to the exact string it was
 * computed on, and `basisLength` ties it to the basis rule. Compact rows are only valid for that string: a table paired
 * with a different manuscript is REJECTED by the server validator and SOFT-FAILS in the reader — never rendered as
 * another string's text. (32-bit FNV is an integrity check, not authentication: the model runs in the browser, so the
 * server can never authenticate a `logOdds` value, compact or not — this format neither adds nor removes that trust.)
 *
 * TRANSPORT AND STORAGE. One canonical form, no transcoding: the browser compacts once, right after the model returns
 * (prepareReportForTransport / prepareAiAnalysisForTransport, called by the two client save helpers); the server
 * VALIDATES and persists exactly what it validated (never expands it); the only expansion is the lazy one in the single
 * consumer (resolveAiPassages, used by AiReport). GET, SSR and the room list therefore stay small too.
 *
 * ROLLOUT. Reader-first — see lib/ai-compact-passages-flag.ts. The reader and the validator always understand
 * compact/1; only WRITING it is gated (default OFF). Legacy rows (full `passages[]`) are read forever, unchanged;
 * there is no migration and no backfill.
 *
 * SCOPE. A pure post-processing of the object the worker returns, after every score, flag and median has been
 * computed. app/ai-detector-worker.ts, lib/ai-core.ts and AI_SCORING_VERSION are untouched.
 */

import { isAiCompactPassagesWriteEnabled, type AiCompactPassagesWriteOptions } from "./ai-compact-passages-flag";
import type { AiAnalysis, AiPassage } from "./report-types";

export const AI_COMPACT_PASSAGES_FORMAT = "turnitplus.ai-passages" as const;
export const AI_COMPACT_PASSAGES_FORMAT_VERSION = 1 as const;
export const AI_COMPACT_PASSAGES_TEXT_RULE = 1 as const;

/**
 * The windowing / scoring contract format v1 was defined against. Pinned here (not imported from lib/ai-core.ts) so
 * this module stays dependency-free and client-safe; tests/ai-passage-table.test.mjs asserts these equal ai-core's
 * AI_CONTENT_TOKENS / AI_TOKEN_STRIDE / AI_SCORING_VERSION, so a scoring-contract change cannot pass unnoticed — it
 * must consciously bump the format version instead.
 */
export const AI_COMPACT_V1_CONTRACT = { windowTokens: 240, strideTokens: 120, scoringVersion: 10 } as const;

export const AI_COMPACT_LIMITS = {
  /** Longest slice of the basis one row may cover (a real window is ~1,000 characters). */
  maxRangeChars: 16_384,
  /** Sum of every row's slice length, as a multiple of the manuscript length (real: ~2.0). */
  rangeBudgetFactor: 2.5,
  /** The basis can be longer than the manuscript (NFC can expand a character); never by more than this. */
  basisLengthFactor: 3,
  /** Token count bound: a token is at least one UTF-8 byte and a UTF-16 unit is at most three. */
  tokensPerCharFactor: 4,
  /** Edge U+FFFD fragments one row may record (a window boundary splits at most one character per side). */
  maxEdgeFragments: 8,
  maxLiteralChars: 16_384,
  maxLiteralBudgetChars: 512 * 1024,
  literalBudgetFactor: 0.5,
  /** Encoder-only: how far past the previous window's start the next window is searched for in the basis. */
  maxSearchGap: 8_192,
  logOddsAbs: 64,
  maxTextChars: 50_000_000,
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------

export type CompactAiPassageRowV1 =
  | [start: number, end: number, charStart: number, charEnd: number, logOdds: number, probability: number, flagged: 0 | 1]
  | [start: number, end: number, charStart: number, charEnd: number, logOdds: number, probability: number, flagged: 0 | 1, lead: number, trail: number];

export type CompactAiPassageTableV1 = {
  format: typeof AI_COMPACT_PASSAGES_FORMAT;
  formatVersion: typeof AI_COMPACT_PASSAGES_FORMAT_VERSION;
  textRule: typeof AI_COMPACT_PASSAGES_TEXT_RULE;
  /** `text.length` (UTF-16 units) of the manuscript the analysis was computed on. */
  textLength: number;
  /** FNV-1a-32 of that manuscript. */
  textHash: number;
  /** Length of the display basis the char ranges index into. */
  basisLength: number;
  windowTokens: number;
  rows: CompactAiPassageRowV1[];
  /** Last-resort escape: "<row index>" -> the window's literal text, present iff that row's char range is (-1, -1). */
  literals?: Record<string, string>;
};

export type CompactAiRejectionReason =
  | "NOT_OBJECT" | "NOT_COMPACT" | "UNKNOWN_KEY" | "STATUS" | "SCORING_VERSION" | "SCALAR" | "BOTH_FORMS"
  | "FORMAT" | "FORMAT_VERSION" | "TEXT_RULE" | "WINDOW_TOKENS" | "TEXT_MISSING" | "TEXT_LENGTH" | "TEXT_HASH"
  | "BASIS_LENGTH" | "ROWS" | "ROW_SHAPE" | "TOKEN_RANGE" | "TOKEN_LAYOUT" | "CHAR_RANGE" | "RANGE_BUDGET"
  | "MODEL_VALUE" | "EDGE_MARKER" | "LITERAL" | "LITERAL_BUDGET" | "COUNT_MISMATCH";

export type CompactAiValidation = { ok: true } | { ok: false; reason: CompactAiRejectionReason };

export type CompactAiEncodeFailure =
  | "NOT_COMPLETE" | "ALREADY_COMPACT" | "NO_PASSAGES" | "TEXT_MISSING" | "SCORING_VERSION" | "UNKNOWN_TOP_LEVEL_KEY"
  | "PASSAGE_SHAPE" | "WINDOW_LAYOUT" | "BASIS_TOO_LARGE" | "LITERAL_TOO_LARGE" | "LITERAL_BUDGET"
  | "SELF_VALIDATION" | "SELF_CHECK_MISMATCH";

export type CompactAiEncodeStats = { windows: number; plain: number; edge: number; literal: number; literalChars: number };

export type CompactAiEncodeOutcome =
  | { ok: true; analysis: AiAnalysis; stats: CompactAiEncodeStats }
  | { ok: false; reason: CompactAiEncodeFailure };

export type ResolvedAiPassages =
  | { status: "ok"; passages: AiPassage[]; source: "legacy" | "compact" }
  | { status: "unavailable"; reason: CompactAiRejectionReason };

type PlainRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------------------------

const FFFD = "�";

function isPlainObject(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function isBoundedString(value: unknown, max: number): boolean {
  return typeof value === "string" && value.length <= max;
}
const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

/** FNV-1a 32-bit over UTF-16 code units: synchronous, dependency-free, identical in the browser and Node. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// A frozen copy of lib/ai-core.ts's WORD_PATTERN — the words a window's `wordCount` counts. The encoder checks every
// window's recorded wordCount against THIS count, so a drift between the two can only ever fall back to legacy.
const WORD_PATTERN = /[A-Za-z]+(?:['’\-][A-Za-z]+)*/g;
function countWords(text: string): number {
  let count = 0;
  WORD_PATTERN.lastIndex = 0;
  while (WORD_PATTERN.exec(text) !== null) count += 1;
  return count;
}

/** transformers.js 4.2.0 `clean_up_tokenization` (dist/transformers.node.mjs), frozen as textRule 1. */
export function cleanupTokenizationV1(text: string): string {
  return text
    .replace(/ \./g, ".")
    .replace(/ \?/g, "?")
    .replace(/ !/g, "!")
    .replace(/ ,/g, ",")
    .replace(/ ' /g, "'")
    .replace(/ n't/g, "n't")
    .replace(/ 'm/g, "'m")
    .replace(/ 's/g, "'s")
    .replace(/ 've/g, "'ve")
    .replace(/ 're/g, "'re");
}

const SURROGATE_UNIT = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;
/** String.prototype.toWellFormed, spelled out so the rule is identical on every engine: a lone surrogate becomes U+FFFD. */
function toWellFormedFrozen(text: string): string {
  return text.replace(SURROGATE_UNIT, (unit) => (unit.length === 2 ? unit : FFFD));
}

/** The display basis every char range indexes into (textRule 1): cleanup_v1( NFC( toWellFormed( text ) ) ). */
export function aiPassageDisplayBasis(text: string): string {
  return cleanupTokenizationV1(toWellFormedFrozen(text).normalize("NFC"));
}

// ---------------------------------------------------------------------------------------------------------------
// Top-level analysis keys (the AiAnalysis shape the worker produces, plus the table)
// ---------------------------------------------------------------------------------------------------------------

const nullableFinite = (value: unknown) => value === null || isFiniteNumber(value);
const nonNegativeInt = (value: unknown) => isInt(value) && value >= 0;

/** Every key a compact-form analysis may carry, with the check its value must pass. Anything else is rejected. */
const ANALYSIS_KEY_RULES: Record<string, (value: unknown) => boolean> = {
  status: (value) => value === "complete",
  scoringVersion: (value) => value === AI_COMPACT_V1_CONTRACT.scoringVersion,
  score: nullableFinite,
  populationPercentile: nullableFinite,
  medianLogOdds: nullableFinite,
  top3MeanLogOdds: nullableFinite,
  coveragePercent: isFiniteNumber,
  meanProbability: isFiniteNumber,
  maxProbability: isFiniteNumber,
  threshold: isFiniteNumber,
  thresholdLogOdds: isFiniteNumber,
  model: (value) => isBoundedString(value, 256),
  engine: (value) => value === null || isBoundedString(value, 32),
  eligibleWordCount: nonNegativeInt,
  analyzedWordCount: nonNegativeInt,
  analyzedTokenCount: nonNegativeInt,
  flaggedWordCount: nonNegativeInt,
  flaggedPassageCount: nonNegativeInt,
  flaggedTokenCount: nonNegativeInt,
  truncatedPassageCount: nonNegativeInt,
  detectedLanguage: (value) => isBoundedString(value, 64),
  languageDetectorVersion: nonNegativeInt,
  error: (value) => isBoundedString(value, 2_000),
  passages: (value) => Array.isArray(value) && value.length === 0,
  compactPassages: () => true, // validated by checkTable
};
const REQUIRED_ANALYSIS_KEYS = ["status", "scoringVersion", "analyzedTokenCount", "passages", "compactPassages"] as const;

const TABLE_KEYS = new Set(["format", "formatVersion", "textRule", "textLength", "textHash", "basisLength", "windowTokens", "rows", "literals"]);

// ---------------------------------------------------------------------------------------------------------------
// The shared table check (server validator + reader)
// ---------------------------------------------------------------------------------------------------------------

type TableCheckOptions = {
  /** The manuscript, when known: exact `textLength` and `textHash`. */
  text?: string;
  /** Server mode: the token layout the analysis's own `analyzedTokenCount` fixes (a subset of it, never anything else). */
  layout?: { analyzedTokenCount: number };
};

const reject = (reason: CompactAiRejectionReason): { ok: false; reason: CompactAiRejectionReason } => ({ ok: false, reason });

/** `maxWindows(N)`: how many windows a 240/120 layout over N tokens can have. */
function maxWindows(analyzedTokens: number): number {
  const { windowTokens, strideTokens } = AI_COMPACT_V1_CONTRACT;
  return Math.max(1, Math.ceil((analyzedTokens - windowTokens) / strideTokens) + 1);
}

function checkTable(table: unknown, options: TableCheckOptions): { ok: true; table: CompactAiPassageTableV1 } | { ok: false; reason: CompactAiRejectionReason } {
  if (!isPlainObject(table)) return reject("NOT_OBJECT");
  for (const key of Object.keys(table)) if (!TABLE_KEYS.has(key)) return reject("UNKNOWN_KEY");
  if (table.format !== AI_COMPACT_PASSAGES_FORMAT) return reject("FORMAT");
  if (table.formatVersion !== AI_COMPACT_PASSAGES_FORMAT_VERSION) return reject("FORMAT_VERSION");
  if (table.textRule !== AI_COMPACT_PASSAGES_TEXT_RULE) return reject("TEXT_RULE");

  const { textLength, textHash, basisLength, windowTokens, rows } = table;
  if (!isInt(textLength) || textLength < 1 || textLength > AI_COMPACT_LIMITS.maxTextChars) return reject("TEXT_LENGTH");
  if (!isInt(textHash) || textHash < 0 || textHash > 0xffffffff) return reject("TEXT_HASH");
  if (!isInt(basisLength) || basisLength < 1 || basisLength > AI_COMPACT_LIMITS.basisLengthFactor * textLength) return reject("BASIS_LENGTH");
  if (!isInt(windowTokens) || windowTokens < 8 || windowTokens > 254) return reject("WINDOW_TOKENS");
  if (options.layout && windowTokens !== AI_COMPACT_V1_CONTRACT.windowTokens) return reject("WINDOW_TOKENS");

  if (options.text !== undefined) {
    if (options.text.length !== textLength) return reject("TEXT_LENGTH");
    if (fnv1a32(options.text) !== textHash) return reject("TEXT_HASH");
  }

  if (!Array.isArray(rows) || rows.length < 1) return reject("ROWS");
  const layout = options.layout;
  if (layout) {
    const tokens = layout.analyzedTokenCount;
    if (tokens < AI_COMPACT_V1_CONTRACT.windowTokens || tokens > AI_COMPACT_LIMITS.tokensPerCharFactor * textLength) return reject("TOKEN_RANGE");
    if (rows.length > maxWindows(tokens)) return reject("ROWS");
  }

  const maxTokens = AI_COMPACT_LIMITS.tokensPerCharFactor * textLength;
  const rangeBudget = AI_COMPACT_LIMITS.rangeBudgetFactor * textLength;
  const strideTokens = AI_COMPACT_V1_CONTRACT.strideTokens;
  let previousStart = -1;
  let previousCharStart = 0;
  let rangeTotal = 0;
  let literalRowCount = 0;
  const literalRowIndexes = new Set<number>();
  for (let index = 0; index < rows.length; index += 1) {
    const row: unknown = rows[index];
    if (!Array.isArray(row) || (row.length !== 7 && row.length !== 9)) return reject("ROW_SHAPE");
    const [start, end, charStart, charEnd, logOdds, probability, flagged] = row as unknown[];
    if (!isInt(start) || !isInt(end) || !isInt(charStart) || !isInt(charEnd)) return reject("ROW_SHAPE");
    if (start < 0 || end <= start || end > maxTokens || end - start !== windowTokens) return reject("TOKEN_RANGE");
    if (start <= previousStart) return reject("TOKEN_LAYOUT");
    previousStart = start;
    if (layout) {
      // The start set is a SUBSET of the layout the token count fixes (a subset, not an equality: buildAiTokenChunks
      // drops a window whose decoded text trims to empty): multiples of the stride, plus the anchored final window.
      if (start % strideTokens !== 0 && start !== layout.analyzedTokenCount - windowTokens) return reject("TOKEN_LAYOUT");
      if (end > layout.analyzedTokenCount) return reject("TOKEN_RANGE");
    }
    if (!isFiniteNumber(logOdds) || Math.abs(logOdds) > AI_COMPACT_LIMITS.logOddsAbs) return reject("MODEL_VALUE");
    if (!isFiniteNumber(probability) || probability < 0 || probability > 1) return reject("MODEL_VALUE");
    if (flagged !== 0 && flagged !== 1) return reject("MODEL_VALUE");
    let edgeFragments = 0;
    if (row.length === 9) {
      const lead = row[7];
      const trail = row[8];
      if (!isInt(lead) || !isInt(trail) || lead < 0 || trail < 0) return reject("EDGE_MARKER");
      edgeFragments = lead + trail;
      if (edgeFragments > AI_COMPACT_LIMITS.maxEdgeFragments) return reject("EDGE_MARKER");
    }
    if (charStart === -1 && charEnd === -1) {
      if (row.length === 9) return reject("EDGE_MARKER"); // a literal row carries its complete text
      literalRowCount += 1;
      literalRowIndexes.add(index);
    } else {
      if (charStart < 0 || charEnd < charStart || charEnd > basisLength) return reject("CHAR_RANGE");
      if (charEnd - charStart > AI_COMPACT_LIMITS.maxRangeChars) return reject("CHAR_RANGE");
      if (charStart < previousCharStart) return reject("CHAR_RANGE");
      if (charEnd === charStart && edgeFragments === 0) return reject("CHAR_RANGE"); // an empty slice needs fragments to be a window
      previousCharStart = charStart;
      rangeTotal += charEnd - charStart;
      if (rangeTotal > rangeBudget) return reject("RANGE_BUDGET");
    }
  }

  const literals = table.literals;
  let literalKeyCount = 0;
  if (literals !== undefined) {
    if (!isPlainObject(literals)) return reject("LITERAL");
    const budget = Math.min(AI_COMPACT_LIMITS.literalBudgetFactor * textLength, AI_COMPACT_LIMITS.maxLiteralBudgetChars);
    let literalChars = 0;
    for (const key of Object.keys(literals)) {
      if (!/^(?:0|[1-9]\d{0,8})$/.test(key)) return reject("LITERAL");
      const index = Number(key);
      if (!literalRowIndexes.has(index)) return reject("LITERAL"); // a literal exists iff its row is (-1, -1)
      const value = literals[key];
      if (typeof value !== "string" || value.length === 0 || value.length > AI_COMPACT_LIMITS.maxLiteralChars) return reject("LITERAL");
      literalChars += value.length;
      if (literalChars > budget) return reject("LITERAL_BUDGET");
      literalKeyCount += 1;
    }
  }
  if (literalKeyCount !== literalRowCount) return reject("LITERAL");
  return { ok: true, table: table as unknown as CompactAiPassageTableV1 };
}

// ---------------------------------------------------------------------------------------------------------------
// Public validator (server: POST /api/reports and POST /api/reports/[id]/ai-retry)
// ---------------------------------------------------------------------------------------------------------------

export function isCompactAiAnalysis(analysis: unknown): analysis is AiAnalysis & { compactPassages: CompactAiPassageTableV1 } {
  return isPlainObject(analysis) && analysis.compactPassages !== undefined;
}

/**
 * Validates a client-supplied compact-form AI analysis. Never throws. Enforces: a top-level key allow-list with typed
 * values (unknown keys rejected, `passages` must be `[]` — never both forms), the format / version / text rule, the
 * window contract, a row count bounded by the analysed token count, the token layout (strictly increasing starts that
 * are a subset of the 240/120 layout), monotone, bounded, budgeted char ranges, finite model values, bounded edge
 * markers, a bounded literal escape that exists exactly for the (-1, -1) rows, and self-consistency (`analyzedTokenCount`
 * is the last window's end; `flaggedPassageCount` is the number of flagged rows).
 *
 * `text` — the manuscript the table claims to describe — makes `textLength` / `textHash` EXACT. POST /api/reports
 * always has it (`payload.text`) and the retry route reads the stored one inside its write transaction; without it the
 * check is structural only.
 */
export function validateCompactAiAnalysis(input: unknown, options: { text?: string } = {}): CompactAiValidation {
  if (!isPlainObject(input)) return reject("NOT_OBJECT");
  if (input.compactPassages === undefined) return reject("NOT_COMPACT");
  for (const key of Object.keys(input)) {
    if (!hasOwn(ANALYSIS_KEY_RULES, key)) return reject("UNKNOWN_KEY"); // own keys only: "__proto__", "constructor" … are never allowed
    if (input[key] === undefined) return reject("SCALAR");
    if (!ANALYSIS_KEY_RULES[key](input[key])) {
      if (key === "passages") return reject("BOTH_FORMS");
      if (key === "status") return reject("STATUS");
      if (key === "scoringVersion") return reject("SCORING_VERSION");
      return reject("SCALAR");
    }
  }
  for (const key of REQUIRED_ANALYSIS_KEYS) if (!hasOwn(input, key)) return reject("SCALAR");

  const analyzedTokenCount = input.analyzedTokenCount as number;
  const checked = checkTable(input.compactPassages, { text: options.text, layout: { analyzedTokenCount } });
  if (!checked.ok) return checked;
  const rows = checked.table.rows;
  if ((rows[rows.length - 1] as number[])[1] !== analyzedTokenCount) return reject("COUNT_MISMATCH");
  if (typeof input.flaggedPassageCount === "number") {
    let flagged = 0;
    for (const row of rows) if ((row as number[])[6] === 1) flagged += 1;
    if (flagged !== input.flaggedPassageCount) return reject("COUNT_MISMATCH");
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Expansion (reader) — rebuilds the exact runtime AiPassage[] from the table and the manuscript
// ---------------------------------------------------------------------------------------------------------------

function passageFromRow(row: CompactAiPassageRowV1, index: number, basis: string, literals: Record<string, string> | undefined): AiPassage {
  const start = row[0];
  const end = row[1];
  const literal = literals?.[String(index)];
  const text = literal !== undefined
    ? literal
    : (row.length === 9 ? FFFD.repeat(row[7]) : "") + basis.slice(row[2], row[3]) + (row.length === 9 ? FFFD.repeat(row[8]) : "");
  return {
    start,
    end,
    wordStart: start,
    wordEnd: end,
    text,
    wordCount: countWords(text),
    probability: row[5],
    logOdds: row[4],
    flagged: row[6] === 1,
    tokenStart: start,
    tokenEnd: end,
    tokenCount: end - start,
    wasTruncated: false,
  };
}

function expandRows(table: CompactAiPassageTableV1, basis: string): AiPassage[] {
  return table.rows.map((row, index) => passageFromRow(row, index, basis, table.literals));
}

/**
 * Rebuilds `analysis.passages` from its compact table and the manuscript it was computed on. Fail-soft by design: any
 * table that does not verify against THIS manuscript (unknown version, text length/hash mismatch, out-of-range row,
 * a basis that no longer matches) returns `{ ok: false }` — the caller shows the existing "passage breakdown is not
 * available" state. Never throws, and never returns text that is not exactly what the encoder verified.
 */
export function expandCompactAiPassages(analysis: unknown, text: unknown): { ok: true; passages: AiPassage[] } | { ok: false; reason: CompactAiRejectionReason } {
  if (!isPlainObject(analysis)) return reject("NOT_OBJECT");
  if (analysis.compactPassages === undefined) return reject("NOT_COMPACT");
  if (Array.isArray(analysis.passages) && analysis.passages.length > 0) return reject("BOTH_FORMS");
  if (typeof text !== "string") return reject("TEXT_MISSING");
  try {
    const checked = checkTable(analysis.compactPassages, { text });
    if (!checked.ok) return checked;
    const basis = aiPassageDisplayBasis(text);
    if (basis.length !== checked.table.basisLength) return reject("BASIS_LENGTH");
    return { ok: true, passages: expandRows(checked.table, basis) };
  } catch {
    return reject("ROW_SHAPE");
  }
}

/**
 * The single read-side entry point for AiReport: the legacy `passages[]` as is, or the expansion of a compact table.
 * `unavailable` is distinct from "zero windows" — the reader must never print "0 passages exceeded the threshold" for a
 * table it could not read.
 */
export function resolveAiPassages(analysis: AiAnalysis | null | undefined, text: unknown): ResolvedAiPassages {
  if (!analysis) return { status: "ok", passages: [], source: "legacy" };
  if (analysis.compactPassages === undefined) {
    return { status: "ok", passages: Array.isArray(analysis.passages) ? analysis.passages : [], source: "legacy" };
  }
  const expanded = expandCompactAiPassages(analysis, text);
  return expanded.ok ? { status: "ok", passages: expanded.passages, source: "compact" } : { status: "unavailable", reason: expanded.reason };
}

// ---------------------------------------------------------------------------------------------------------------
// Compaction (browser, at the two client save helpers)
// ---------------------------------------------------------------------------------------------------------------

const PASSAGE_KEYS = ["start", "end", "wordStart", "wordEnd", "text", "wordCount", "probability", "logOdds", "flagged", "tokenStart", "tokenEnd", "tokenCount", "wasTruncated"] as const;
const PASSAGE_KEY_SET = new Set<string>(PASSAGE_KEYS);

function hasExactPassageShape(passage: unknown): passage is PlainRecord {
  if (!isPlainObject(passage)) return false;
  const keys = Object.keys(passage);
  if (keys.length !== PASSAGE_KEYS.length) return false;
  for (const key of keys) if (!PASSAGE_KEY_SET.has(key)) return false;
  return true;
}

/** The identities that make wordStart/wordEnd/tokenStart/tokenEnd/tokenCount/wasTruncated/wordCount derivable (ai-core.ts:349-359). */
function isDerivablePassage(passage: PlainRecord): boolean {
  const { start, end, text } = passage;
  return isInt(start) && isInt(end) && (end as number) > (start as number) && (start as number) >= 0
    && passage.wordStart === start && passage.wordEnd === end && passage.tokenStart === start && passage.tokenEnd === end
    && passage.tokenCount === (end as number) - (start as number) && passage.wasTruncated === false
    && typeof text === "string" && text.length > 0 && passage.wordCount === countWords(text)
    && typeof passage.flagged === "boolean" && isFiniteNumber(passage.logOdds) && isFiniteNumber(passage.probability);
}

function leadingFragmentRun(text: string): number {
  let count = 0;
  while (count < text.length && text.charCodeAt(count) === 0xfffd) count += 1;
  return count;
}
function trailingFragmentRun(text: string, from: number): number {
  let count = 0;
  while (text.length - 1 - count >= from && text.charCodeAt(text.length - 1 - count) === 0xfffd) count += 1;
  return count;
}

function passagesEqual(rebuilt: AiPassage[], original: unknown[]): boolean {
  if (rebuilt.length !== original.length) return false;
  for (let index = 0; index < rebuilt.length; index += 1) {
    const a = rebuilt[index] as unknown as PlainRecord;
    const b = original[index] as PlainRecord;
    for (const key of PASSAGE_KEYS) if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * Compacts a COMPLETE analysis against the manuscript it was computed on. Returns the compact analysis — every top-level
 * scalar unchanged, `passages: []`, `compactPassages` set — or a reason it stays in the legacy form (which is not an
 * error: legacy is always a valid, exact fallback). Before it succeeds the encoder (1) checks every passage has exactly
 * today's 13 fields and the derivation identities, (2) places every window in the basis (a bounded forward search) or
 * stores it as a bounded literal, (3) validates its own output with the SAME validator the server runs, and (4) expands
 * it again and compares every field of every window to the original — so `expand(compact(x))` equalling `x` is not a
 * hope but a precondition of ever returning a table. Pure and deterministic; never mutates its input.
 */
export function compactAiAnalysis(analysis: AiAnalysis, text: string): CompactAiEncodeOutcome {
  const fail = (reason: CompactAiEncodeFailure): { ok: false; reason: CompactAiEncodeFailure } => ({ ok: false, reason });
  if (!isPlainObject(analysis)) return fail("NOT_COMPLETE");
  if (analysis.compactPassages !== undefined) return fail("ALREADY_COMPACT");
  if (analysis.status !== "complete") return fail("NOT_COMPLETE");
  if (analysis.scoringVersion !== AI_COMPACT_V1_CONTRACT.scoringVersion) return fail("SCORING_VERSION");
  const passages: unknown = analysis.passages;
  if (!Array.isArray(passages) || passages.length === 0) return fail("NO_PASSAGES");
  if (typeof text !== "string" || text.length === 0) return fail("TEXT_MISSING");
  for (const key of Object.keys(analysis)) if (!hasOwn(ANALYSIS_KEY_RULES, key)) return fail("UNKNOWN_TOP_LEVEL_KEY");

  const basis = aiPassageDisplayBasis(text);
  if (basis.length > AI_COMPACT_LIMITS.basisLengthFactor * text.length) return fail("BASIS_TOO_LARGE");

  const rows: CompactAiPassageRowV1[] = [];
  const literals: Record<string, string> = {};
  const stats: CompactAiEncodeStats = { windows: passages.length, plain: 0, edge: 0, literal: 0, literalChars: 0 };
  let cursor = 0;
  for (let index = 0; index < passages.length; index += 1) {
    const passage: unknown = passages[index];
    if (!hasExactPassageShape(passage) || !isDerivablePassage(passage)) return fail("PASSAGE_SHAPE");
    const start = passage.start as number;
    const end = passage.end as number;
    if (end - start !== AI_COMPACT_V1_CONTRACT.windowTokens) return fail("WINDOW_LAYOUT");
    const passageText = passage.text as string;
    const flagged: 0 | 1 = passage.flagged === true ? 1 : 0;
    const logOdds = passage.logOdds as number;
    const probability = passage.probability as number;

    const lead = leadingFragmentRun(passageText);
    const trail = lead === passageText.length ? 0 : trailingFragmentRun(passageText, lead);
    let placed = false;
    if (lead + trail <= AI_COMPACT_LIMITS.maxEdgeFragments) {
      const middle = passageText.slice(lead, passageText.length - trail);
      if (middle.length === 0) {
        // A window that is nothing but edge fragments: an empty slice at the cursor keeps char starts monotone.
        rows.push([start, end, cursor, cursor, logOdds, probability, flagged, lead + trail, 0]);
        stats.edge += 1;
        placed = true;
      } else {
        const found = basis.slice(cursor, cursor + AI_COMPACT_LIMITS.maxSearchGap + middle.length).indexOf(middle);
        if (found >= 0) {
          const charStart = cursor + found;
          if (lead || trail) {
            rows.push([start, end, charStart, charStart + middle.length, logOdds, probability, flagged, lead, trail]);
            stats.edge += 1;
          } else {
            rows.push([start, end, charStart, charStart + middle.length, logOdds, probability, flagged]);
            stats.plain += 1;
          }
          // NOT `charStart + 1`: token starts are strictly increasing but char starts are only NON-DECREASING — when a
          // window's first token is whitespace (runs of spaces in extracted text) `.trim()` removes it, so the next
          // window can begin at the very same character. (Found on a real document: the anchored last window, one token
          // after the previous one, was pushed to a literal by the stricter cursor.)
          cursor = charStart;
          placed = true;
        }
      }
    }
    if (!placed) {
      if (passageText.length > AI_COMPACT_LIMITS.maxLiteralChars) return fail("LITERAL_TOO_LARGE");
      rows.push([start, end, -1, -1, logOdds, probability, flagged]);
      literals[String(index)] = passageText;
      stats.literal += 1;
      stats.literalChars += passageText.length;
    }
  }
  if (stats.literalChars > Math.min(AI_COMPACT_LIMITS.literalBudgetFactor * text.length, AI_COMPACT_LIMITS.maxLiteralBudgetChars)) return fail("LITERAL_BUDGET");

  const table: CompactAiPassageTableV1 = {
    format: AI_COMPACT_PASSAGES_FORMAT,
    formatVersion: AI_COMPACT_PASSAGES_FORMAT_VERSION,
    textRule: AI_COMPACT_PASSAGES_TEXT_RULE,
    textLength: text.length,
    textHash: fnv1a32(text),
    basisLength: basis.length,
    windowTokens: AI_COMPACT_V1_CONTRACT.windowTokens,
    rows,
    ...(stats.literal > 0 ? { literals } : {}),
  };
  const { passages: _legacyPassages, ...rest } = analysis;
  void _legacyPassages;
  const compact = { ...rest, passages: [], compactPassages: table } as AiAnalysis;

  if (!validateCompactAiAnalysis(compact, { text }).ok) return fail("SELF_VALIDATION");
  if (!passagesEqual(expandRows(table, basis), passages)) return fail("SELF_CHECK_MISMATCH");
  return { ok: true, analysis: compact, stats };
}

// ---------------------------------------------------------------------------------------------------------------
// Client transport boundary
// ---------------------------------------------------------------------------------------------------------------

/**
 * The AI result exactly as it should LEAVE the browser: the compact table when the writer gate is ON and the analysis is
 * compactable against `text`, otherwise the very same object (by reference) — so with the gate OFF, or for an
 * error/unsupported/legacy-shaped result, behaviour is byte-for-byte what it was. Never throws: a failure to compact
 * can only ever mean "send the legacy form", which is the exact, pre-existing behaviour.
 */
export function prepareAiAnalysisForTransport<A>(aiAnalysis: A, text: unknown, options?: AiCompactPassagesWriteOptions): A {
  const enabled = options?.compactWrites ?? isAiCompactPassagesWriteEnabled();
  if (!enabled || !isPlainObject(aiAnalysis) || typeof text !== "string") return aiAnalysis;
  try {
    const outcome = compactAiAnalysis(aiAnalysis as unknown as AiAnalysis, text);
    return outcome.ok ? (outcome.analysis as unknown as A) : aiAnalysis;
  } catch {
    return aiAnalysis;
  }
}

/**
 * The report payload as it should leave the browser through POST /api/reports: `report` itself (same reference) unless
 * it carries a compactable `aiAnalysis` and the writer gate is ON — then a shallow copy whose `aiAnalysis` is the
 * compact form. The first save (no `aiAnalysis` yet) is therefore untouched.
 */
export function prepareReportForTransport<R>(report: R, options?: AiCompactPassagesWriteOptions): R {
  if (!isPlainObject(report)) return report;
  const { aiAnalysis, text } = report;
  if (aiAnalysis === undefined || aiAnalysis === null) return report;
  const prepared = prepareAiAnalysisForTransport(aiAnalysis, text, options);
  return prepared === aiAnalysis ? report : ({ ...report, aiAnalysis: prepared } as R);
}
