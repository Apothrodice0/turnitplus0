/**
 * The exact canonical source_ref format corpus-admission decisions are
 * keyed on — deliberately its own tiny, dependency-free module (no
 * @libsql/client, no DB access, nothing else) rather than living only in
 * lib/corpus-admission-report-integration.ts (which re-exports it
 * unchanged, for every existing importer), because that file transitively
 * imports lib/corpus-admission-gate.ts -> lib/corpus-text-extraction.ts,
 * which runs Node worker-thread setup (fileURLToPath(new URL(...,
 * import.meta.url))) at module top level — safe in a server route/job
 * context, but fatal when pulled into a page-rendering bundle (a real,
 * confirmed `next build` failure for app/reports/[id]/page.tsx once
 * lib/report-primary-similarity.ts started importing
 * buildReportAdmissionSourceRef from the heavier module). Any caller that
 * only needs this pure string format — never the admission job pipeline
 * itself — must import it from here, not from lib/corpus-admission-report-
 * integration.ts.
 */
/**
 * The account-scoped prefix of buildReportAdmissionSourceRef's own output —
 * everything up to and including the `:device=` delimiter, never the
 * device_key/report_id suffix. Centralized here (the account-level
 * self-match fix) so a caller that needs to test "does this source_ref
 * belong to account X" — rather than build a full source_ref for one
 * specific report — never reconstructs the `report-upload:account=...:device=`
 * literal itself, which would risk drifting out of sync with
 * buildReportAdmissionSourceRef's own format.
 *
 * Deliberately includes the trailing `:device=` delimiter, not just
 * `account=${accountId}`: comparing source_ref against this exact prefix
 * (via a plain substr/exact-equality check, never SQL LIKE — see
 * lib/user-submission-corpus.ts's own admissionEligibilitySql) means a
 * shorter account id can never accidentally prefix-match a longer, unrelated
 * one that merely starts with the same characters (e.g. "abc" vs "abc123")
 * — the delimiter forces a hard boundary immediately after the real account
 * id, which a bare "account=${accountId}" prefix alone would not.
 */
export function buildReportAdmissionAccountPrefix(accountId: string): string {
  return `report-upload:account=${accountId}:device=`;
}

export function buildReportAdmissionSourceRef(params: { accountId: string; deviceKey: string; reportId: string }): string {
  return `${buildReportAdmissionAccountPrefix(params.accountId)}${params.deviceKey}:report=${params.reportId}`;
}
