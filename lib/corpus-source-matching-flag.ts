/**
 * Deliberately its own file, not exported from lib/user-submission-matching.ts
 * directly — that module is under a blanket structural guarantee
 * (tests/user-submission-matching-privacy.test.mjs's own "the matching
 * service is never imported by any file under app/") that this codebase
 * treats as zero-exception: no app/ file may pull it in, admin-gated or
 * not. The admin corpus dashboard only ever needs this one boolean for a
 * read-only status line — splitting it out here lets it do that without
 * weakening that guarantee for the real matching logic.
 */
export function isCorpusSourceMatchingEnabled(): boolean {
  return process.env.CORPUS_SOURCE_MATCHING_ENABLED === "true";
}
