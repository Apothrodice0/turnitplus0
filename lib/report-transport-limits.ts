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
