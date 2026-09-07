import type { Client } from "@libsql/client";
import { summarizeSubmissionOwnership, type SubmissionOwnershipSummary } from "./user-submission-corpus";
import { buildReportAdmissionAccountPrefix } from "./corpus-admission-source-ref";
import { findFamilyForIdentity, findFamilyMembers } from "./document-family";

/**
 * Device Passport — Phase 4 (prior-submission SHADOW). A read-only wrapper
 * around lib/user-submission-corpus.ts's summarizeSubmissionOwnership that,
 * for ONE matched corpus representation, additionally computes bounded
 * device-provenance facts (from the per-admission-backing
 * corpus_admission_decision_device_provenance link, drizzle/0039) and
 * bounded System-2 identity facts (document_identities / document_families).
 *
 * NEVER modifies summarizeSubmissionOwnership's own return contract — its two
 * fields (hasSameAccountSubmission, otherAccountSubmissionCount) are
 * re-surfaced verbatim via the spread below, and this module never calls the
 * production matcher, never writes, and never decides a production
 * relationship. lib/device-provenance-shadow.ts is the shadow-only observer
 * that consumes this; nothing in the production similarity / scoring path
 * imports it.
 *
 * PRIVACY: every field returned is a bounded boolean or a bounded count.
 * Account ownership, device-passport identity, and admission source_ref
 * ownership are all resolved to booleans INSIDE the SQL below — the exact
 * substr(...) prefix-equality comparison lib/user-submission-corpus.ts's own
 * admissionEligibilitySql already uses (never SQL LIKE, no wildcard-injection
 * risk) — so no passport id, account id, email, IP, name, source_ref, or
 * document text is ever read into a returned value.
 */

/** The precise, single-source definition of "independent backing" — see lib/device-provenance-shadow.ts's proposed decision rule (Phase 4 section 10). */
export const INDEPENDENT_BACKING_DEFINITION = [
  "An independent backing of a matched corpus representation is any active/admitted backing that positively evidences a DISTINCT actor from this report's own uploader:",
  "  (1) a corpus_submission_references row whose document_identities.account_id is NULL or differs from the report's own account; OR",
  "  (2) an active indexed corpus_admission_promotions backing (its corpus_admission_accepted_representations.revoked_at IS NULL) whose paired",
  "      corpus_admission_decision_device_provenance.device_passport_id is a DIFFERENT verified passport from the report's own immutable upload passport; OR",
  "  (3) an active indexed admission backing with NO device provenance whose decision source_ref does not carry the report's own account prefix",
  "      (lib/corpus-admission-source-ref.ts's buildReportAdmissionAccountPrefix).",
  "A same-device admission backing (2, same passport) and a no-device admission backing from the report's own account (3, own prefix) are explicitly NOT independent.",
].join("\n");

export type MatchedRepresentationProvenance = SubmissionOwnershipSummary & {
  /**
   * System-2 evidence ONLY (Phase 4 section 7): the report's own account has
   * at least one OTHER document_identities row for this exact canonical text,
   * or shares a document_families group with another same-account identity.
   * Recorded so a later phase can measure convergence — it must NEVER alter a
   * production relationship in this phase.
   */
  identitySameAccount: boolean;
  /** document_identities rows for (reportAccount, reportCanonicalSha256) other than the report's own identity row. */
  priorSameAccountIdentityCount: number;

  /** ≥1 active/admitted backing of this representation is linked to the SAME verified device passport as the report's own upload. */
  sameVerifiedDeviceBacking: boolean;
  sameDeviceBackingCount: number;

  /** Backings that positively evidence a distinct actor from the report's uploader — see INDEPENDENT_BACKING_DEFINITION. */
  independentBackingCount: number;
  /** Backings carrying no device-passport provenance at all (every submission-reference backing + every admission backing with no corpus_admission_decision_device_provenance row). */
  backingsWithoutDeviceProvenance: number;

  submissionReferenceBackingCount: number;
  admittedPromotionBackingCount: number;
  admittedBackingsSameDevice: number;
  admittedBackingsDifferentDevice: number;
  admittedBackingsNoDeviceProvenance: number;
};

export type SummarizeSubmissionProvenanceOptions = {
  /** The report's account (the immutable upload account for a report read is its owner). null for an anonymous report. */
  accountId: string | null;
  /** The report's own corpus_submission_references / document_identities row to exclude from every count — mirrors summarizeSubmissionOwnership / matchAgainstUserSubmissionCorpus's own self-exclusion. */
  excludeDocumentIdentityId?: string | null;
  /** saved_reports.verified_device_passport_id for the report being evaluated, or null. Compared inside SQL, never returned. */
  reportVerifiedDevicePassportId: string | null;
  /** canonicalSha256(report rawText) — for the System-2 same-account identity check. */
  reportCanonicalSha256: string;
  /** saved_reports.document_identity_id for the report, excluded from the System-2 prior-identity count. */
  reportDocumentIdentityId: string | null;
};

type AdmittedBackingRow = {
  has_device_provenance: number | bigint;
  is_same_device: number | bigint;
  is_different_device: number | bigint;
  belongs_to_report_account: number | bigint;
};

export async function summarizeSubmissionProvenance(
  client: Client,
  representationId: string,
  options: SummarizeSubmissionProvenanceOptions,
): Promise<MatchedRepresentationProvenance> {
  // (A) Unchanged production ownership contract — re-surfaced verbatim.
  const ownership = await summarizeSubmissionOwnership(client, representationId, {
    accountId: options.accountId,
    excludeDocumentIdentityId: options.excludeDocumentIdentityId ?? null,
  });

  const excludeId = options.excludeDocumentIdentityId ?? null;

  // (B) Submission-reference backings — never device-passport-linked (a
  // passport is only ever attached to an admission decision, drizzle/0039).
  const submissionRefResult = await client.execute({
    sql: `SELECT di.account_id AS account_id
          FROM corpus_submission_references sr
          JOIN document_identities di ON di.id = sr.document_identity_id
          WHERE sr.representation_id = ?
            AND (? IS NULL OR sr.document_identity_id != ?)`,
    args: [representationId, excludeId, excludeId],
  });
  const submissionRefAccounts = (submissionRefResult.rows as unknown as { account_id: string | null }[]).map((r) => r.account_id);
  const submissionReferenceBackingCount = submissionRefAccounts.length;
  const submissionRefIndependentCount = submissionRefAccounts.filter(
    (id) => id === null || id !== options.accountId,
  ).length;

  // (C) Active/admitted admission-promotion backings + per-backing device
  // provenance. Correlated per backing exactly like admissionEligibilitySql:
  // eligibility is (status = 'indexed' AND accepted_representation not
  // revoked); the account/device comparisons are resolved to 1/0 columns
  // here so no source_ref or passport id is ever pulled into JS.
  const accountPrefix = options.accountId ? buildReportAdmissionAccountPrefix(options.accountId) : null;
  const passportId = options.reportVerifiedDevicePassportId;
  const admittedResult = await client.execute({
    sql: `SELECT
            CASE WHEN cadp.device_passport_id IS NOT NULL THEN 1 ELSE 0 END AS has_device_provenance,
            CASE WHEN ? IS NOT NULL AND cadp.device_passport_id = ? THEN 1 ELSE 0 END AS is_same_device,
            CASE WHEN ? IS NOT NULL AND cadp.device_passport_id IS NOT NULL AND cadp.device_passport_id <> ? THEN 1 ELSE 0 END AS is_different_device,
            CASE WHEN ? IS NOT NULL AND substr(d.source_ref, 1, length(?)) = ? THEN 1 ELSE 0 END AS belongs_to_report_account
          FROM corpus_admission_promotions p
          JOIN corpus_admission_accepted_representations ar ON ar.id = p.accepted_representation_id
          JOIN corpus_admission_decisions d ON d.id = ar.decision_id
          LEFT JOIN corpus_admission_decision_device_provenance cadp ON cadp.decision_id = d.id
          WHERE p.representation_id = ? AND p.status = 'indexed' AND ar.revoked_at IS NULL`,
    args: [
      passportId, passportId,
      passportId, passportId,
      accountPrefix, accountPrefix, accountPrefix,
      representationId,
    ],
  });
  const admittedRows = (admittedResult.rows as unknown as AdmittedBackingRow[]).map((r) => ({
    hasDeviceProvenance: Number(r.has_device_provenance) === 1,
    isSameDevice: Number(r.is_same_device) === 1,
    isDifferentDevice: Number(r.is_different_device) === 1,
    belongsToReportAccount: Number(r.belongs_to_report_account) === 1,
  }));

  const admittedPromotionBackingCount = admittedRows.length;
  const admittedBackingsSameDevice = admittedRows.filter((r) => r.isSameDevice).length;
  const admittedBackingsDifferentDevice = admittedRows.filter((r) => r.isDifferentDevice).length;
  const admittedBackingsNoDeviceProvenance = admittedRows.filter((r) => !r.hasDeviceProvenance).length;
  const admittedIndependentCount = admittedRows.filter(
    (r) => r.isDifferentDevice || (!r.hasDeviceProvenance && !r.belongsToReportAccount),
  ).length;

  const sameDeviceBackingCount = admittedBackingsSameDevice;
  const independentBackingCount = submissionRefIndependentCount + admittedIndependentCount;
  const backingsWithoutDeviceProvenance = submissionReferenceBackingCount + admittedBackingsNoDeviceProvenance;

  // (D) System-2 identity/family evidence — READ ONLY. Never calls
  // resolveFamilyForIdentity (which writes); never expands System 2's own
  // frozen admin classifier (Phase 4 section 7).
  let priorSameAccountIdentityCount = 0;
  let familySameAccount = false;
  if (options.accountId !== null) {
    const identityCountResult = await client.execute({
      sql: `SELECT COUNT(*) AS c FROM document_identities
            WHERE account_id = ? AND canonical_sha256 = ?
              AND (? IS NULL OR id <> ?)`,
      args: [options.accountId, options.reportCanonicalSha256, options.reportDocumentIdentityId, options.reportDocumentIdentityId],
    });
    priorSameAccountIdentityCount = Number((identityCountResult.rows[0] as unknown as { c: number | bigint }).c);
    if (options.reportDocumentIdentityId) {
      const family = await findFamilyForIdentity(client, options.reportDocumentIdentityId);
      if (family) {
        const members = await findFamilyMembers(client, family.family.id);
        familySameAccount = members.some(
          (m) => m.documentIdentityId !== options.reportDocumentIdentityId && m.accountId === options.accountId,
        );
      }
    }
  }
  const identitySameAccount = priorSameAccountIdentityCount > 0 || familySameAccount;

  return {
    ...ownership,
    identitySameAccount,
    priorSameAccountIdentityCount,
    sameVerifiedDeviceBacking: sameDeviceBackingCount > 0,
    sameDeviceBackingCount,
    independentBackingCount,
    backingsWithoutDeviceProvenance,
    submissionReferenceBackingCount,
    admittedPromotionBackingCount,
    admittedBackingsSameDevice,
    admittedBackingsDifferentDevice,
    admittedBackingsNoDeviceProvenance,
  };
}
