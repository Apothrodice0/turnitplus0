/**
 * TWO LIFECYCLES (owner decision 2026-10-31: the customer comparison corpus stays active).
 *
 * A REPORT belongs to its customer. When the subscription expires (lib/subscription-expiry-cleanup.ts), the report is
 * refused at once and then deleted together with every record made for it: REPORT_ARTIFACT_TABLES. Account deletion does
 * the same for every report of the account (lib/account-deletion.ts).
 *
 * A COMPARISON SOURCE is the reusable record an eligible upload becomes when the corpus admission gate accepts it
 * (lib/corpus-admission-report-integration.ts, behind CORPUS_ADMISSION_ENABLED / CORPUS_PROMOTION_ENABLED): the retained
 * canonical text, its fingerprints and the promoted representation other customers' documents are matched against
 * (behind CORPUS_SOURCE_MATCHING_ENABLED, after the 7-day maturity window, never against its own account).
 * COMPARISON_SOURCE_TABLES. It does not depend on its report and is not removed with it. Its own lifecycle today is:
 *   - kept until an administrator deactivates it (corpus_admission_accepted_representations.revoked_at, which stops
 *     matching at once) or an owner-approved manual purge removes it (lib/customer-corpus-purge.ts);
 *   - no automatic expiry. A retention period, if wanted, is an owner decision still to make.
 * Its provenance is recorded as retention basis SERVICE_POLICY with the policy version, never as the customer's consent
 * (lib/corpus-admission-types.ts).
 *
 * The source keeps one link back: source_ref names the account, device and report it came from. It is needed for the
 * same-account exclusion (a customer never matches their own earlier upload) and for a takedown, and is never shown to
 * another customer.
 */
export const REPORT_ARTIFACT_TABLES = [
  "saved_reports",
  "report_historical_match_snapshots",
  "report_highlight_predictions",
  "academic_search_run_diagnostics",
  "historical_match_shadow_evaluations",
  "corpus_duplicate_suppression_shadow_evaluations",
  "pmc_coverage_shadow_evaluations",
  "corpus_admission_report_jobs",
  "document_identities",
  "document_identity_shingles",
  "document_family_members",
] as const;

/** corpus_admission_decisions counts only once accepted with retained text; a rejected decision is a report artifact and goes with its report. */
export const COMPARISON_SOURCE_TABLES = [
  "corpus_admission_decisions",
  "corpus_admission_content_store",
  "corpus_admission_accepted_representations",
  "corpus_admission_accepted_shingles",
  "corpus_admission_promotions",
  "corpus_document_representations",
  "corpus_document_shingles",
] as const;
