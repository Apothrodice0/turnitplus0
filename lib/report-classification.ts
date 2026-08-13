import type { Client } from "@libsql/client";
import { rawSha256, findDocumentIdentitiesByRawHash } from "./document-identity";
import { findFamilyForIdentity, findFamilyMembers } from "./document-family";
import { classifySubmitterRelationship } from "./document-relationship";
import type { ReportMatchClassification } from "./report-types";

/**
 * Phase D bridge layer: turns a saved report's raw text + viewing account
 * into the SELF/PRIOR_SUBMISSION summary attached to it as
 * SimilarityReport.matchClassification. This is the only module that knows
 * about both "reports" and "document identity/family" — lib/document-
 * family.ts and lib/document-relationship.ts stay unaware of the report
 * shape, exactly as their own header comments require.
 *
 * Deliberately never touches, reads for the purpose of changing, or is
 * called from anywhere near SimilarityReport.score/archiveScore (the
 * verified-source/archive similarity calculation, computed entirely
 * client-side in app/similarity-worker.ts, long before a report is ever
 * saved). The two numbers are computed by completely separate pipelines
 * comparing against completely separate data (the static archive vs. this
 * account's/other accounts' saved submissions) and are combined nowhere —
 * the reporting layer displays them as two clearly distinct figures, never
 * arithmetic on each other. This satisfies the frozen rule that SELF/
 * PRIOR_SUBMISSION must never inflate (or otherwise affect) verified
 * similarity by construction: there is no code path where they could.
 *
 * VERIFIED_SOURCE does not exist yet (a later phase); this module only ever
 * produces SELF or PRIOR_SUBMISSION.
 */

/**
 * Reads TURSO_DATABASE_URL-backed identity/family state for the document
 * that produced `rawText` (as submitted by `accountId`, or null for an
 * anonymous submission) and summarizes its family relationships into at most
 * two numbers. Returns undefined — not an object with both fields null —
 * whenever there is nothing to show yet: no matching document_identities row
 * (classification hasn't run — a race with the deferred capture pipeline, or
 * this report predates Phase C), no family, or a family with no other
 * members. This is not an error state — callers should render nothing extra
 * rather than a loading/error UI. undefined matters specifically because
 * SimilarityReport.matchClassification is optional: assigning undefined to
 * it means JSON.stringify drops the key entirely, so an unclassified report
 * round-trips through save/load byte-for-byte identical to a pre-Phase-D
 * one — an object with both fields null would instead add a new,
 * previously-absent key to every saved report's JSON, which is exactly the
 * kind of payload drift the project's own existing round-trip tests
 * (tests/api-reports.test.mjs, tests/document-identity.test.mjs) correctly
 * treat as a regression.
 *
 * Never returns any other account's id, email, title, or content — only
 * aggregated percentages.
 */
export async function classifyReportMatches(
  client: Client,
  params: { rawText: string; accountId: string | null },
): Promise<ReportMatchClassification | undefined> {
  const raw = rawSha256(params.rawText);
  const candidates = await findDocumentIdentitiesByRawHash(client, raw, 50);
  // Multiple identities can share this exact raw hash + account (the same
  // report resaved more than once each creates a new document_identities
  // row — see lib/document-identity.ts). They all have identical text, so
  // they should all resolve into the same family once fingerprinted; the
  // most recently created one is used deterministically.
  const mine = candidates.filter((candidate) => candidate.accountId === params.accountId).at(-1);
  if (!mine) return undefined;

  const own = await findFamilyForIdentity(client, mine.id);
  if (!own) return undefined;

  const members = await findFamilyMembers(client, own.family.id);
  const myRow = members.find((member) => member.documentIdentityId === mine.id);
  const others = members.filter((member) => member.documentIdentityId !== mine.id);
  if (others.length === 0) return undefined;

  let selfPercent: number | null = null;
  let priorPercent: number | null = null;

  for (const other of others) {
    const relationship = classifySubmitterRelationship(mine.accountId, other.accountId);

    // A family member's own stored evidence_score is only a *direct*
    // pairwise measurement against `mine` when that member matched
    // directly against `mine` (or vice versa) when it joined — see
    // lib/document-family.ts's resolveFamilyForIdentity. For a 2-member
    // family (the common case: a reupload, a revision, or a stranger's
    // identical copy) one of these two branches always applies and the
    // percentage is exact. For a 3+-member family where `other` connects to
    // the family through a third document rather than `mine` directly,
    // there is no direct measurement between this specific pair; `other`'s
    // own join evidence is used as a same-family proxy instead of omitting
    // a number, and a SEED member with no evidence anywhere in the pair
    // (nobody matched directly against them) is treated as a full match,
    // since family membership itself is already confirmed either way —
    // only the precise strength is approximate in that indirect case.
    let score: number;
    if (other.matchedAgainstIdentityId === mine.id && other.evidenceScore !== null) {
      score = other.evidenceScore;
    } else if (myRow?.matchedAgainstIdentityId === other.documentIdentityId && myRow.evidenceScore !== null && myRow.evidenceScore !== undefined) {
      score = myRow.evidenceScore;
    } else if (other.evidenceScore !== null) {
      score = other.evidenceScore;
    } else {
      score = 1;
    }

    const percent = Math.max(0, Math.min(100, Math.round(score * 100)));
    if (relationship === "SELF") {
      selfPercent = selfPercent === null ? percent : Math.max(selfPercent, percent);
    } else {
      priorPercent = priorPercent === null ? percent : Math.max(priorPercent, percent);
    }
  }

  // Defensive: the loop above always sets at least one of the two whenever
  // `others` is non-empty (every branch of the score selection produces a
  // number), but guard explicitly anyway rather than rely on that.
  if (selfPercent === null && priorPercent === null) return undefined;
  return { selfMatchPercent: selfPercent, priorSubmissionPercent: priorPercent };
}
