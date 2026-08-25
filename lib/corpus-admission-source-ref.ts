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
export function buildReportAdmissionSourceRef(params: { accountId: string; deviceKey: string; reportId: string }): string {
  return `report-upload:account=${params.accountId}:device=${params.deviceKey}:report=${params.reportId}`;
}
