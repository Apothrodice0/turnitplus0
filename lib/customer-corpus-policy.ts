/**
 * CUSTOMER CORPUS RETENTION — OFF (owner decision 2026-10-31, English launch). A customer's manuscript is not retained in
 * any shared comparison corpus, and no customer is matched against another customer's text. The report, and everything
 * derived from its document, belongs to that customer alone and goes when the subscription expires.
 *
 * This is decided here and not by the CORPUS_ADMISSION_ENABLED / CORPUS_PROMOTION_ENABLED / CORPUS_SOURCE_MATCHING_ENABLED
 * deployment flags, so a flag left on a deployment changes nothing: each of them also needs this answer to be true, and on
 * a hosted deployment it never is. Turning a customer corpus on means building explicit, per-customer retention
 * authorization first and changing this code, not setting a variable. CUSTOMER_CORPUS_RETENTION_AUTHORIZED exists only so
 * the local test suite can keep exercising that machinery.
 *
 * Nothing here touches the independent sources: the built-in archive (archive_document_representations), ASJP, PMC,
 * Wikipedia and the other collections are matched exactly as before.
 */
export function customerCorpusRetentionAuthorized(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CUSTOMER_CORPUS_RETENTION_AUTHORIZED === "1" && env.VERCEL !== "1" && env.VERCEL_ENV === undefined;
}
