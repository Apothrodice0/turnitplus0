/**
 * The report-save request transport ceiling — the single source of truth for
 * "how large may a POST /api/reports body be".
 *
 * `app/api/reports/route.ts` enforces this value against the `Content-Length`
 * header, the serialized client `payload`, and the finalized persisted payload
 * (each independently → HTTP 413). Every PRE-SUBMIT client guard — notably the
 * user-supplied-reference transport-budget check (lib/user-supplied-reference-
 * constants.ts `referenceTransportBudgetError`) — must stay conservatively under
 * this number so the friendly local message is shown instead of a bare 413.
 *
 * Dependency-free so it is safe to import from client code.
 */
export const MAX_REPORT_SAVE_REQUEST_BYTES = 2_000_000;

/**
 * THE CANONICAL PERSISTED-SIZE UNIT — what "the persisted report is over the ceiling" means.
 *
 * The persisted-report ceiling is compared against the length, in UTF-16 CODE UNITS (JavaScript `String.prototype.length`),
 * of the serialized JSON text a report is stored as: at POST /api/reports that is `JSON.stringify(encodeReportForPersistence(report))`
 * (the three `PERSISTED_PAYLOAD_TOO_LARGE` checks, including the first-save terminal-AI reserve), and for an already-stored report it
 * is the `payload_json` text itself. It is NOT UTF-8 bytes and NOT Unicode code points: a non-BMP character (an emoji, a rare CJK
 * ideograph, a mathematical letter) counts 2, a BMP character 1. (The constant's historical name says "BYTES"; only the request-level
 * `Content-Length` check is in bytes. The body-text and client-payload guards are also UTF-16 units.)
 *
 * Every size decision about a stored/persisted report must measure with this one function, so no two checks can disagree about what a
 * character is. In particular SQLite's `length()` is NOT this unit (it counts code points, so an astral character is 1), which is
 * why the AI-result route does not do arithmetic on SQL lengths — see app/api/reports/[id]/ai-retry/route.ts.
 */
export function persistedPayloadSize(serializedPayload: string): number {
  return serializedPayload.length;
}

export type PersistedFitVerdict = "FITS" | "EXCEEDS" | "AMBIGUOUS";

/**
 * Settles "does a payload stored as SQLite TEXT fit the persisted ceiling (in the canonical unit)?" from two cheap SQL measurements,
 * so the text itself only has to be transferred when the answer genuinely depends on how many astral characters it holds.
 *
 * For any string, code points ≤ UTF-16 units ≤ UTF-8 bytes (an astral character is 1 / 2 / 4, every other character n / n / ≥ n):
 *  - `utf8Bytes ≤ ceiling`  ⇒ units ≤ ceiling  ⇒ FITS, for certain — this is every ASCII payload (units == bytes) and every payload
 *    comfortably under the ceiling;
 *  - `codePoints > ceiling` ⇒ units > ceiling  ⇒ EXCEEDS, for certain;
 *  - otherwise (code points ≤ ceiling < bytes: a non-ASCII payload straddling the ceiling) the answer is AMBIGUOUS and the caller
 *    must measure the text with `persistedPayloadSize`.
 * `codePoints` is SQL `length(payload_json)`, `utf8Bytes` is `length(CAST(payload_json AS BLOB))`. (`length()` stops at the first NUL,
 * which only makes `codePoints` smaller — still a valid lower bound; serialized JSON has no raw NUL, it is escaped.)
 */
export function persistedFitFromSqlBounds(codePoints: number, utf8Bytes: number, ceiling: number = MAX_REPORT_SAVE_REQUEST_BYTES): PersistedFitVerdict {
  if (utf8Bytes <= ceiling) return "FITS";
  if (codePoints > ceiling) return "EXCEEDS";
  return "AMBIGUOUS";
}
