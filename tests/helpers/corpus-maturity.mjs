/**
 * Phase A — 7-day corpus maturity test helper.
 *
 * lib/user-submission-corpus.ts's admissionEligibilitySql() now requires every
 * corpus backing's immutable T0 to be at least CORPUS_ACTIVATION_DELAY_DAYS (7)
 * old before it contributes plagiarism evidence, and lib/report-historical-match.ts
 * stales a cached snapshot when a backing crosses that boundary.
 *
 * Tests that exercise MATCHING / relationship classification / scoring — not
 * the activation gate itself — seed corpus content "now" and then match
 * immediately, which under Phase A is an immature corpus. Call this once after
 * seeding (and before each match / route call that reads the corpus) to age
 * every backing's T0 well past the maturity window, restoring the pre-Phase-A
 * precondition those tests assume.
 *
 * Tests for the 7-day gate itself (tests/corpus-activation-*.test.mjs) never
 * call this — they inject a frozen `asOf` instead.
 */
export async function matureCorpusBackings(client, daysAgo = 90) {
  const cutoff = new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
  // Only backdate rows that are not already at/older than the cutoff, so
  // repeated calls and deliberately-old fixtures are left alone.
  await client.execute({
    sql: "UPDATE corpus_submission_references SET created_at = ? WHERE created_at > ?",
    args: [cutoff, cutoff],
  });
  await client.execute({
    sql: "UPDATE corpus_admission_decisions SET created_at = ? WHERE created_at > ?",
    args: [cutoff, cutoff],
  });
  await client.execute({
    sql: "UPDATE corpus_document_representations SET first_seen_at = ? WHERE first_seen_at > ?",
    args: [cutoff, cutoff],
  });
}
