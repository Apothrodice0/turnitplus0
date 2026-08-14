/**
 * Phase E8I: the hardcoded, hand-reviewed allowlist of the exact rows a
 * targeted production cleanup is authorized to touch. Pure data — no DB
 * access, no process.env, no I/O of any kind — so it can be imported by
 * both the read-only planner (lib/e8i-cleanup-runner.ts) and tests without
 * either one ever needing a live connection just to see what the allowlist
 * contains.
 *
 * Every field below was captured directly from a read-only production query
 * (tools/e8i-cleanup-plan.ts's audit, cross-checked a second time against
 * document_identities/corpus_submission_references by id) — not
 * hand-derived or guessed. canonicalSha256/rawSha256/createdAt are pinned
 * here specifically so lib/e8i-cleanup-runner.ts's verification step can
 * detect drift: if production has changed since this allowlist was
 * reviewed (a row edited, re-created, or gone), the live values will no
 * longer match these pinned ones and verification refuses rather than
 * deleting something that merely happens to share an id.
 *
 * The 4 entries are legacy pre-E8F DUPLICATE_SAVE_ARTIFACT clusters: one
 * saved_reports row (device_key, id) upserted twice — an immediate save,
 * then again after Wikipedia enrichment merged in — each write triggering
 * its own document identity capture, before Phase E8F gated that capture on
 * isFirstSaveOfThisReport (see app/api/reports/route.ts). In every entry,
 * "keep" is the older (first-save) identity and "delete" is the younger
 * (second-save) identity — the same tie-break E8F itself uses.
 */

export type CleanupTarget = {
  cluster: number;
  title: string;
  accountId: string;
  /** Display/verification only — never used to select or filter rows. */
  accountEmailForDisplay: string;
  representationId: string;
  canonicalSha256: string;
  rawSha256: string;
  keepIdentityId: string;
  keepCreatedAt: string;
  deleteIdentityId: string;
  deleteCreatedAt: string;
  deleteSubmissionReferenceId: number;
  expectedReportId: string;
  expectedDeviceKey: string;
  maxDeltaSeconds: number;
};

export const E8I_CLEANUP_TARGETS: readonly CleanupTarget[] = [
  {
    cluster: 1,
    title: "gamorrine.docx",
    accountId: "a2071cea-85cc-4fa6-a49a-922d2fd099c6",
    accountEmailForDisplay: "saaduniversity07@gmail.com",
    representationId: "a658c59e-4d7d-4ae6-817f-e5d4c5db3660",
    canonicalSha256: "298b240f7019467840147c2d23a441175feae88368728efcb1caf265d99657f8",
    rawSha256: "298b240f7019467840147c2d23a441175feae88368728efcb1caf265d99657f8",
    keepIdentityId: "1f0e761b-ac4e-46a0-b10e-476d64a5ce5e",
    keepCreatedAt: "2026-08-14 03:48:25",
    deleteIdentityId: "67a744d2-cdae-4203-ab5c-40bf989610a0",
    deleteCreatedAt: "2026-08-14 03:48:25",
    deleteSubmissionReferenceId: 4,
    expectedReportId: "1786679295031",
    expectedDeviceKey: "c586fd6a-0980-4a57-a704-d0ad778904a5",
    maxDeltaSeconds: 2,
  },
  {
    cluster: 2,
    title: "economy in algeria.docx",
    accountId: "a2071cea-85cc-4fa6-a49a-922d2fd099c6",
    accountEmailForDisplay: "saaduniversity07@gmail.com",
    representationId: "d227cdb5-23a0-408c-a552-15a26cd4c586",
    canonicalSha256: "3b14dc50b11257bfd334a4df4f6a2b73d7c60249f4bd75a9e7f829f82f628b64",
    rawSha256: "3b14dc50b11257bfd334a4df4f6a2b73d7c60249f4bd75a9e7f829f82f628b64",
    keepIdentityId: "43405082-2aea-4021-98f9-11f6e53ace4b",
    keepCreatedAt: "2026-08-14 03:52:13",
    deleteIdentityId: "e642bc0d-6b05-4a38-8037-7ba3594106d2",
    deleteCreatedAt: "2026-08-14 03:52:14",
    deleteSubmissionReferenceId: 8,
    expectedReportId: "1786679517271",
    expectedDeviceKey: "c586fd6a-0980-4a57-a704-d0ad778904a5",
    maxDeltaSeconds: 2,
  },
  {
    cluster: 3,
    title: "IT Governance and Food Traceability in Emerging Economies A COBIT 2019 Maturity Assessment of the Benamor Group, Algeria.docx",
    accountId: "a2071cea-85cc-4fa6-a49a-922d2fd099c6",
    accountEmailForDisplay: "saaduniversity07@gmail.com",
    representationId: "b50bd8ad-0c7d-45a6-ba47-b91ef3bb8543",
    canonicalSha256: "a799c2970b3a1ee8ff082afd6c6198f994244c364104bf0abcea0135a1c136cd",
    rawSha256: "562364d258f5670698c7aa0ea6639db111bedb45ffd869aa827ccd7081c0d7c2",
    keepIdentityId: "bc7dfa31-587d-41a3-83f8-17c42c4213b1",
    keepCreatedAt: "2026-08-14 03:49:19",
    deleteIdentityId: "abee3540-1cb2-4b3f-915e-9535b31a9d7d",
    deleteCreatedAt: "2026-08-14 03:49:21",
    deleteSubmissionReferenceId: 5,
    expectedReportId: "1786679348256",
    expectedDeviceKey: "c586fd6a-0980-4a57-a704-d0ad778904a5",
    maxDeltaSeconds: 2,
  },
  {
    cluster: 4,
    title: "gamorrine.docx",
    accountId: "bf5318a6-9e09-4c14-a175-15edee8191cc",
    accountEmailForDisplay: "professional.translation.a@gmail.com",
    representationId: "a658c59e-4d7d-4ae6-817f-e5d4c5db3660",
    canonicalSha256: "298b240f7019467840147c2d23a441175feae88368728efcb1caf265d99657f8",
    rawSha256: "298b240f7019467840147c2d23a441175feae88368728efcb1caf265d99657f8",
    keepIdentityId: "5ec60ce4-8ac6-43df-b701-02bf0bd4d66c",
    keepCreatedAt: "2026-08-14 03:46:08",
    deleteIdentityId: "fbd2499b-f2d7-49a6-a46d-68142f3de064",
    deleteCreatedAt: "2026-08-14 03:46:09",
    deleteSubmissionReferenceId: 2,
    expectedReportId: "1786679103022",
    expectedDeviceKey: "c586fd6a-0980-4a57-a704-d0ad778904a5",
    maxDeltaSeconds: 2,
  },
] as const;

/**
 * The legitimate repeat-submission cluster's own two identity ids — never
 * eligible for deletion. Used as a hard refusal check (see
 * assertNoForbiddenIdentityInTargets in lib/e8i-cleanup-runner.ts): if this
 * allowlist above is ever edited to accidentally include one of these two
 * ids, the whole run refuses before touching the database, rather than
 * relying solely on the per-target verification checks to catch it.
 */
export const E8I_FORBIDDEN_IDENTITY_IDS: ReadonlySet<string> = new Set([
  "0ebc435f-508f-43d4-9a43-4a8a5dd6edc7",
  "81493182-87e9-435f-9c25-bc1267cb3589",
]);

/** Informational only (dry-run display) — this cluster is never queried by id for deletion, only asserted absent from E8I_CLEANUP_TARGETS. */
export const E8I_LEGITIMATE_CLUSTER = {
  title: "turnitplus-cross-account-test.docx.docx",
  accountId: "bf5318a6-9e09-4c14-a175-15edee8191cc",
  accountEmailForDisplay: "professional.translation.a@gmail.com",
  representationId: "4d3cdc9d-c705-41e9-a303-99c0160efd5f",
  identityIds: ["0ebc435f-508f-43d4-9a43-4a8a5dd6edc7", "81493182-87e9-435f-9c25-bc1267cb3589"] as const,
  savedReportsIds: ["1786680441053", "1786680811534"] as const,
  deltaSeconds: 319,
} as const;
