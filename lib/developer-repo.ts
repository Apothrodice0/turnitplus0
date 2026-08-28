import type { Client } from "@libsql/client";
import { findFamilyForIdentity, findFamilyMembers, type FamilyForIdentity, type FamilyMember } from "./document-family";
import {
  findAcademicSearchRunDiagnosticsByDocumentIdentityId,
  findAcademicSearchRunDiagnosticsByReport,
  type AcademicSearchRunDiagnosticsRow,
} from "./academic-search-diagnostics-repo";
import { canonicalSha256 } from "./document-identity";
import { summarizeSubmissionOwnership } from "./user-submission-corpus";
import { summarizeSubmissionProvenance } from "./submission-provenance";
import { resolvePrimarySimilaritySummary } from "./report-primary-similarity";
import { DEVICE_PROVENANCE_SHADOW_POLICY_VERSION } from "./device-provenance-shadow";
import {
  buildAdminSimilarityDecisionTrace,
  type AdminSimilarityDecisionTrace,
  type DecisionTraceAccountEvidence,
  type DecisionTraceBackingAccount,
  type DecisionTraceDeviceEvidence,
  type DecisionTraceDeviceShadowInput,
  type DecisionTraceHistoricalMatchFacts,
} from "./admin-similarity-decision-trace";
import type { SimilarityReport } from "./report-types";

/**
 * Data-access layer for the developer/admin dashboard (app/developer/*,
 * app/api/developer/*). Every function here reads across accounts and
 * exposes fields (account email, other accounts' document hashes/titles,
 * raw pipeline diagnostics) that no ordinary user-facing route ever
 * returns — callers MUST gate every one of these behind
 * lib/auth-session.ts's getAdminSessionUser()/getAdminSessionUserByToken()
 * before calling anything in this file. This module itself performs no
 * authorization check of its own; it is intentionally a pure data layer,
 * matching every other *-repo.ts in this codebase.
 */

const MAX_RECENT_REPORTS = 200;
const MAX_LOOKUP_RESULTS = 25;

export type DeveloperReportSummary = {
  deviceKey: string;
  id: string;
  submissionId: string;
  title: string;
  reportCreatedAt: string;
  updatedAt: string;
  wordCount: number;
  archiveScore: number;
  scoreBand: string;
  aiScore: number | null;
  aiTone: string | null;
  userId: string | null;
  username: string | null;
  email: string | null;
  documentIdentityId: string | null;
};

type RawSummaryRow = {
  device_key: string;
  id: string;
  submission_id: string;
  title: string;
  report_created_at: string;
  updated_at: string;
  word_count: number;
  archive_score: number;
  score_band: string;
  ai_score: number | null;
  ai_tone: string | null;
  user_id: string | null;
  username: string | null;
  email: string | null;
  document_identity_id: string | null;
};

function toSummary(row: RawSummaryRow): DeveloperReportSummary {
  return {
    deviceKey: row.device_key,
    id: row.id,
    submissionId: row.submission_id,
    title: row.title,
    reportCreatedAt: row.report_created_at,
    updatedAt: row.updated_at,
    wordCount: Number(row.word_count),
    archiveScore: Number(row.archive_score),
    scoreBand: row.score_band,
    aiScore: row.ai_score === null ? null : Number(row.ai_score),
    aiTone: row.ai_tone,
    userId: row.user_id,
    username: row.username,
    email: row.email,
    documentIdentityId: row.document_identity_id,
  };
}

/** Every saved report across every account, most recently updated first — the developer dashboard's overview feed. */
export async function listRecentReportsForDeveloper(client: Client, limit = 50): Promise<DeveloperReportSummary[]> {
  const boundedLimit = Math.min(Math.max(1, limit), MAX_RECENT_REPORTS);
  const result = await client.execute({
    sql: `SELECT sr.device_key, sr.id, sr.submission_id, sr.title, sr.report_created_at, sr.updated_at,
                 sr.word_count, sr.archive_score, sr.score_band, sr.ai_score, sr.ai_tone,
                 sr.user_id, u.username, u.email, sr.document_identity_id
          FROM saved_reports sr
          LEFT JOIN users u ON u.id = sr.user_id
          ORDER BY sr.updated_at DESC
          LIMIT ?`,
    args: [boundedLimit],
  });
  return (result.rows as unknown as RawSummaryRow[]).map(toSummary);
}

export type DeveloperDocumentIdentity = {
  id: string;
  accountId: string | null;
  accountUsername: string | null;
  accountEmail: string | null;
  title: string | null;
  author: string | null;
  rawSha256: string;
  canonicalSha256: string;
  createdAt: string;
};

type RawIdentityRow = {
  id: string;
  account_id: string | null;
  username: string | null;
  email: string | null;
  title: string | null;
  author: string | null;
  raw_sha256: string;
  canonical_sha256: string;
  created_at: string;
};

function toIdentity(row: RawIdentityRow): DeveloperDocumentIdentity {
  return {
    id: row.id,
    accountId: row.account_id,
    accountUsername: row.username,
    accountEmail: row.email,
    title: row.title,
    author: row.author,
    rawSha256: row.raw_sha256,
    canonicalSha256: row.canonical_sha256,
    createdAt: row.created_at,
  };
}

const IDENTITY_SELECT = `SELECT di.id, di.account_id, u.username, u.email, di.title, di.author, di.raw_sha256, di.canonical_sha256, di.created_at
          FROM document_identities di
          LEFT JOIN users u ON u.id = di.account_id`;

export type ReportDeepDive = {
  report: {
    deviceKey: string;
    id: string;
    userId: string | null;
    username: string | null;
    email: string | null;
    reportCreatedAt: string;
    savedAt: string;
    updatedAt: string;
    payload: SimilarityReport;
  } | null;
  documentIdentity: DeveloperDocumentIdentity | null;
  /** Every OTHER identity sharing this one's document family — same-article/prior-submission relationships, across every account. */
  familyMembers: (FamilyMember & { relationship: "SELF" | "OTHER_SUBMISSION" })[];
  family: FamilyForIdentity | null;
  /** Every academic-search run captured for this document identity — usually one, but resubmission of the same text can produce more than one document_identities row, each with its own run. */
  academicSearchRuns: AcademicSearchRunDiagnosticsRow[];
};

/**
 * The full investigative bundle for one saved report: the report itself
 * (whichever account owns it), its document identity, every other
 * submission (any account) that document family resolved to, and every
 * academic-search diagnostics run captured for it — everything needed to
 * reproduce or explain a detection outcome without re-running the pipeline.
 */
export async function getReportDeepDiveForDeveloper(client: Client, deviceKey: string, id: string): Promise<ReportDeepDive> {
  const reportResult = await client.execute({
    sql: `SELECT sr.device_key, sr.id, sr.user_id, u.username, u.email, sr.report_created_at, sr.saved_at, sr.updated_at, sr.payload_json, sr.document_identity_id
          FROM saved_reports sr
          LEFT JOIN users u ON u.id = sr.user_id
          WHERE sr.device_key = ? AND sr.id = ?`,
    args: [deviceKey, id],
  });
  const raw = reportResult.rows[0] as unknown as
    | { device_key: string; id: string; user_id: string | null; username: string | null; email: string | null; report_created_at: string; saved_at: string; updated_at: string; payload_json: string; document_identity_id: string | null }
    | undefined;

  if (!raw) {
    return { report: null, documentIdentity: null, familyMembers: [], family: null, academicSearchRuns: [] };
  }

  const report = {
    deviceKey: raw.device_key,
    id: raw.id,
    userId: raw.user_id,
    username: raw.username,
    email: raw.email,
    reportCreatedAt: raw.report_created_at,
    savedAt: raw.saved_at,
    updatedAt: raw.updated_at,
    payload: JSON.parse(raw.payload_json) as SimilarityReport,
  };

  let documentIdentity: DeveloperDocumentIdentity | null = null;
  let family: FamilyForIdentity | null = null;
  let familyMembers: (FamilyMember & { relationship: "SELF" | "OTHER_SUBMISSION" })[] = [];
  let academicSearchRuns: AcademicSearchRunDiagnosticsRow[] = [];

  if (raw.document_identity_id) {
    const identityResult = await client.execute({
      sql: `${IDENTITY_SELECT} WHERE di.id = ?`,
      args: [raw.document_identity_id],
    });
    const identityRow = identityResult.rows[0] as unknown as RawIdentityRow | undefined;
    documentIdentity = identityRow ? toIdentity(identityRow) : null;

    family = await findFamilyForIdentity(client, raw.document_identity_id);
    if (family) {
      const members = await findFamilyMembers(client, family.family.id);
      familyMembers = members.map((member) => ({
        ...member,
        relationship: member.documentIdentityId === raw.document_identity_id ? "SELF" : "OTHER_SUBMISSION",
      }));
    }

    academicSearchRuns = await findAcademicSearchRunDiagnosticsByDocumentIdentityId(client, raw.document_identity_id);
  }

  // Independent of document_identity_id — a run can be captured even when
  // identity capture itself failed (see academic_search_run_diagnostics'
  // own schema comment), so this is a second, unconditional lookup path.
  if (academicSearchRuns.length === 0) {
    const byReport = await findAcademicSearchRunDiagnosticsByReport(client, deviceKey, id);
    if (byReport) academicSearchRuns = [byReport];
  }

  return { report, documentIdentity, familyMembers, family, academicSearchRuns };
}

export type ArticleLookupResult = {
  documentIdentities: DeveloperDocumentIdentity[];
  reports: DeveloperReportSummary[];
};

/**
 * Article History / Lookup: a single free-text query matched against every
 * field a developer might have on hand — document/report id, raw or
 * canonical hash, title, author. DOI/URL are not independently indexed
 * (see db/schema.ts's own comment on this table) — a query containing "10."
 * or "http" additionally scans academic_search_run_diagnostics' candidate
 * JSON and saved_reports' payload JSON as a bounded LIKE match, which is
 * adequate at this project's current data volume.
 */
export async function searchArticleHistory(client: Client, query: string): Promise<ArticleLookupResult> {
  const trimmed = query.trim();
  if (!trimmed) return { documentIdentities: [], reports: [] };
  const likePattern = `%${trimmed}%`;

  const identityResult = await client.execute({
    sql: `${IDENTITY_SELECT}
          WHERE di.id = ? OR di.raw_sha256 = ? OR di.canonical_sha256 = ? OR di.title LIKE ? OR di.author LIKE ?
          ORDER BY di.created_at DESC LIMIT ?`,
    args: [trimmed, trimmed, trimmed, likePattern, likePattern, MAX_LOOKUP_RESULTS],
  });
  const documentIdentitiesById = new Map((identityResult.rows as unknown as RawIdentityRow[]).map(toIdentity).map((identity) => [identity.id, identity]));

  const looksLikeDoiOrUrl = /10\.|https?:\/\//i.test(trimmed);
  const reportResult = await client.execute({
    sql: `SELECT sr.device_key, sr.id, sr.submission_id, sr.title, sr.report_created_at, sr.updated_at,
                 sr.word_count, sr.archive_score, sr.score_band, sr.ai_score, sr.ai_tone,
                 sr.user_id, u.username, u.email, sr.document_identity_id
          FROM saved_reports sr
          LEFT JOIN users u ON u.id = sr.user_id
          WHERE sr.id = ? OR sr.submission_id = ? OR sr.title LIKE ?${looksLikeDoiOrUrl ? " OR sr.payload_json LIKE ?" : ""}
          ORDER BY sr.updated_at DESC LIMIT ?`,
    args: looksLikeDoiOrUrl
      ? [trimmed, trimmed, likePattern, likePattern, MAX_LOOKUP_RESULTS]
      : [trimmed, trimmed, likePattern, MAX_LOOKUP_RESULTS],
  });
  const reportsByKey = new Map((reportResult.rows as unknown as RawSummaryRow[]).map(toSummary).map((report) => [`${report.deviceKey}:${report.id}`, report]));

  // A DOI/URL a developer has on hand may only ever have appeared as a
  // RANKED CANDIDATE (academic_search_run_diagnostics.candidates_json) —
  // never in externalAcademicEvidence/saved_reports.payload_json, since
  // most candidates never clear minEvidenceSimilarity. Scanning
  // candidates_json too means "was this source ever considered" is
  // answerable even when it was never reported as a match.
  if (looksLikeDoiOrUrl) {
    const diagnosticsResult = await client.execute({
      sql: `SELECT document_identity_id, report_device_key, report_id
            FROM academic_search_run_diagnostics
            WHERE candidates_json LIKE ?
            ORDER BY id DESC LIMIT ?`,
      args: [likePattern, MAX_LOOKUP_RESULTS],
    });
    const diagnosticsRows = diagnosticsResult.rows as unknown as { document_identity_id: string | null; report_device_key: string | null; report_id: string | null }[];

    const additionalIdentityIds = [...new Set(diagnosticsRows.map((row) => row.document_identity_id).filter((id): id is string => id !== null && !documentIdentitiesById.has(id)))];
    for (const identityId of additionalIdentityIds) {
      const result = await client.execute({ sql: `${IDENTITY_SELECT} WHERE di.id = ?`, args: [identityId] });
      const row = result.rows[0] as unknown as RawIdentityRow | undefined;
      if (row) documentIdentitiesById.set(row.id, toIdentity(row));
    }

    const additionalReportKeys = diagnosticsRows.filter((row) => row.report_device_key && row.report_id && !reportsByKey.has(`${row.report_device_key}:${row.report_id}`));
    for (const { report_device_key, report_id } of additionalReportKeys) {
      const result = await client.execute({
        sql: `SELECT sr.device_key, sr.id, sr.submission_id, sr.title, sr.report_created_at, sr.updated_at,
                     sr.word_count, sr.archive_score, sr.score_band, sr.ai_score, sr.ai_tone,
                     sr.user_id, u.username, u.email, sr.document_identity_id
              FROM saved_reports sr
              LEFT JOIN users u ON u.id = sr.user_id
              WHERE sr.device_key = ? AND sr.id = ?`,
        args: [report_device_key, report_id],
      });
      const row = result.rows[0] as unknown as RawSummaryRow | undefined;
      if (row) reportsByKey.set(`${row.device_key}:${row.id}`, toSummary(row));
    }
  }

  return { documentIdentities: [...documentIdentitiesById.values()], reports: [...reportsByKey.values()] };
}

// ===========================================================================
// ADMIN SIMILARITY DECISION TRACE
// ===========================================================================
//
// The authenticated developer/admin explanation of WHY a report's final
// TurnitPlus Similarity score is the number it is. This layer GATHERS the
// already-finalized production results and hands them to the PURE
// lib/admin-similarity-decision-trace.ts builder — it never implements a
// matcher and never recomputes similarity independently:
//
//   - resolvePrimarySimilaritySummary() is the ONE existing server-side
//     resolver (lib/report-primary-similarity.ts) already run on every
//     ordinary report view (app/api/reports/[id]/route.ts GET). It is
//     cache-first; calling it here observes the same resolved result an
//     ordinary viewer's own request already produced, never a different one.
//   - the device-provenance shadow row + per-representation provenance are
//     read (never written) here, through the same bounded helpers
//     lib/device-provenance-shadow.ts already uses.
//
// ADMIN-ONLY. Callers MUST gate on getAdminSessionUser() before invoking
// this — like every other function in this file.

const MAX_TRACE_REPRESENTATIONS = 25;
const MAX_TRACE_BACKINGS_PER_REPRESENTATION = 20;

/**
 * Resolves the identity of every active backing of one matched corpus
 * representation — ADMIN-ONLY, and deliberately NOT part of the bounded
 * lib/submission-provenance.ts summary (which resolves ownership to booleans
 * inside SQL). Account identity is read here from the backing/provenance
 * tables (corpus_submission_references -> document_identities -> users, and
 * corpus_admission_decisions.source_ref's own account prefix), never from a
 * column on corpus_document_representations.
 */
async function resolveMatchedRepresentationBackingEvidence(
  client: Client,
  representationId: string,
  options: { reportAccountId: string | null; excludeDocumentIdentityId: string | null },
): Promise<DecisionTraceAccountEvidence> {
  const excludeId = options.excludeDocumentIdentityId ?? null;
  const ownership = await summarizeSubmissionOwnership(client, representationId, {
    accountId: options.reportAccountId,
    excludeDocumentIdentityId: excludeId,
  });

  const backings: DecisionTraceBackingAccount[] = [];

  const submissionRefs = await client.execute({
    sql: `SELECT sr.document_identity_id, di.account_id, u.email, u.username
          FROM corpus_submission_references sr
          JOIN document_identities di ON di.id = sr.document_identity_id
          LEFT JOIN users u ON u.id = di.account_id
          WHERE sr.representation_id = ? AND (? IS NULL OR sr.document_identity_id != ?)
          ORDER BY sr.created_at ASC, sr.id ASC
          LIMIT ?`,
    args: [representationId, excludeId, excludeId, MAX_TRACE_BACKINGS_PER_REPRESENTATION + 1],
  });
  for (const raw of submissionRefs.rows as unknown as {
    document_identity_id: string;
    account_id: string | null;
    email: string | null;
    username: string | null;
  }[]) {
    backings.push({
      channel: "SUBMISSION_REFERENCE",
      relationshipToReportAccount: classifyBackingAccount(raw.account_id, options.reportAccountId),
      accountEmail: raw.email,
      accountUsername: raw.username,
      documentIdentityId: raw.document_identity_id,
      admissionDecisionId: null,
      sourceReportId: null,
    });
  }

  const admissions = await client.execute({
    sql: `SELECT d.id AS decision_id, d.source_ref
          FROM corpus_admission_promotions p
          JOIN corpus_admission_accepted_representations ar ON ar.id = p.accepted_representation_id
          JOIN corpus_admission_decisions d ON d.id = ar.decision_id
          WHERE p.representation_id = ? AND p.status = 'indexed' AND ar.revoked_at IS NULL
          ORDER BY d.created_at ASC, d.id ASC
          LIMIT ?`,
    args: [representationId, MAX_TRACE_BACKINGS_PER_REPRESENTATION + 1],
  });
  for (const raw of admissions.rows as unknown as { decision_id: string; source_ref: string | null }[]) {
    const parsed = parseReportAdmissionSourceRef(raw.source_ref);
    let email: string | null = null;
    let username: string | null = null;
    if (parsed?.accountId) {
      const user = await client.execute({
        sql: `SELECT email, username FROM users WHERE id = ?`,
        args: [parsed.accountId],
      });
      const userRow = user.rows[0] as unknown as { email: string | null; username: string | null } | undefined;
      email = userRow?.email ?? null;
      username = userRow?.username ?? null;
    }
    backings.push({
      channel: "ADMISSION_PROMOTION",
      relationshipToReportAccount: parsed
        ? classifyBackingAccount(parsed.accountId, options.reportAccountId)
        : "UNKNOWN",
      accountEmail: email,
      accountUsername: username,
      documentIdentityId: null,
      admissionDecisionId: raw.decision_id,
      sourceReportId: parsed?.reportId ?? null,
    });
  }

  const backingListTruncated = backings.length > MAX_TRACE_BACKINGS_PER_REPRESENTATION;
  const boundedBackings = backings.slice(0, MAX_TRACE_BACKINGS_PER_REPRESENTATION);
  const sameAccountBackingCount = boundedBackings.filter((b) => b.relationshipToReportAccount === "SAME_ACCOUNT").length;
  const otherAccountBackingCount = boundedBackings.filter((b) => b.relationshipToReportAccount === "OTHER_ACCOUNT").length;
  const anonymousBackingCount = boundedBackings.filter((b) => b.relationshipToReportAccount === "ANONYMOUS").length;

  return {
    hasSameAccountSubmission: ownership.hasSameAccountSubmission,
    otherAccountSubmissionCount: ownership.otherAccountSubmissionCount,
    sameAccountBackingCount,
    otherAccountBackingCount,
    anonymousBackingCount,
    backings: boundedBackings,
    backingListTruncated,
  };
}

function classifyBackingAccount(
  backingAccountId: string | null,
  reportAccountId: string | null,
): DecisionTraceBackingAccount["relationshipToReportAccount"] {
  if (backingAccountId === null) return "ANONYMOUS";
  if (reportAccountId !== null && backingAccountId === reportAccountId) return "SAME_ACCOUNT";
  return "OTHER_ACCOUNT";
}

/** Parses buildReportAdmissionSourceRef's own format: `report-upload:account=<id>:device=<dk>:report=<rid>`. */
function parseReportAdmissionSourceRef(sourceRef: string | null): { accountId: string; deviceKey: string; reportId: string } | null {
  if (!sourceRef) return null;
  const match = sourceRef.match(/^report-upload:account=(.+?):device=(.+?):report=(.+)$/);
  if (!match) return null;
  return { accountId: match[1], deviceKey: match[2], reportId: match[3] };
}

type SavedReportTraceRow = {
  device_key: string;
  id: string;
  user_id: string | null;
  document_identity_id: string | null;
  archive_score: number | bigint | null;
  verified_device_passport_id: string | null;
  payload_json: string;
};

/**
 * The full admin similarity decision trace for one saved report, or null
 * when the report does not exist. Best-effort: any single evidence-gathering
 * step that fails degrades that part of the trace to "not available" rather
 * than failing the whole call (the underlying score and matches are never
 * touched either way).
 */
export async function getReportSimilarityDecisionTrace(
  client: Client,
  deviceKey: string,
  id: string,
): Promise<AdminSimilarityDecisionTrace | null> {
  const reportResult = await client.execute({
    sql: `SELECT device_key, id, user_id, document_identity_id, archive_score, verified_device_passport_id, payload_json
          FROM saved_reports WHERE device_key = ? AND id = ?`,
    args: [deviceKey, id],
  });
  const raw = reportResult.rows[0] as unknown as SavedReportTraceRow | undefined;
  if (!raw) return null;

  let payload: SimilarityReport;
  try {
    payload = JSON.parse(raw.payload_json) as SimilarityReport;
  } catch {
    return null;
  }

  const accountId = raw.user_id;
  const archiveScore = payload.archiveScore ?? payload.score ?? Number(raw.archive_score ?? 0);
  const hasVerifiedUploadPassport = raw.verified_device_passport_id !== null;

  // The ONE existing server-side resolver — cache-first, the same call the
  // ordinary GET /api/reports/[id] route already makes on every view. Never
  // persisted from here (this is a read surface); never a second matcher.
  let resolution: Awaited<ReturnType<typeof resolvePrimarySimilaritySummary>> | null = null;
  try {
    resolution = await resolvePrimarySimilaritySummary(client, {
      reportDeviceKey: deviceKey,
      reportId: id,
      accountId,
      rawText: payload.text,
      wordCount: payload.wordCount,
      archiveMatchedPositions: payload.archiveMatchedPositions,
      externalAcademicEvidence: payload.externalAcademicEvidence,
      archiveScore,
    });
  } catch (err) {
    console.error("getReportSimilarityDecisionTrace: resolvePrimarySimilaritySummary failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }

  const unifiedSimilarity = resolution?.unifiedSimilarity ?? payload.unifiedSimilarity ?? null;
  const historicalSubmissionMatch = resolution?.historicalSubmissionMatch ?? payload.historicalSubmissionMatch ?? null;

  // Device-provenance shadow telemetry row (Phase 4) — observation only.
  let deviceShadow: DecisionTraceDeviceShadowInput | null = null;
  try {
    const shadow = await client.execute({
      sql: `SELECT computed_at, status, production_status, production_relationship, proposed_relationship,
                   agreement, proposed_evidence
            FROM historical_match_shadow_evaluations
            WHERE report_device_key = ? AND report_id = ? AND policy_version = ?`,
      args: [deviceKey, id, DEVICE_PROVENANCE_SHADOW_POLICY_VERSION],
    });
    const shadowRow = shadow.rows[0] as unknown as {
      computed_at: string;
      status: string;
      production_status: string;
      production_relationship: string | null;
      proposed_relationship: string | null;
      agreement: string;
      proposed_evidence: string | null;
    } | undefined;
    if (shadowRow) {
      let evidence: Record<string, unknown> = {};
      try {
        evidence = shadowRow.proposed_evidence ? (JSON.parse(shadowRow.proposed_evidence) as Record<string, unknown>) : {};
      } catch {
        evidence = {};
      }
      deviceShadow = {
        policyVersion: DEVICE_PROVENANCE_SHADOW_POLICY_VERSION,
        computedAt: shadowRow.computed_at,
        status: shadowRow.status === "FAILED" ? "FAILED" : "OK",
        productionStatus: shadowRow.production_status,
        productionRelationship: shadowRow.production_relationship,
        proposedRelationship: shadowRow.proposed_relationship,
        agreement: shadowRow.agreement,
        evidence,
      };
    }
  } catch (err) {
    console.error("getReportSimilarityDecisionTrace: shadow-row read failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }

  // Per-representation account/device evidence for every matched
  // representation that either contributed to, or was considered for, the
  // unified result.
  const representationIds = new Set<string>();
  for (const contribution of unifiedSimilarity?.contributions ?? []) {
    if (contribution.sourceType === "previous_upload") representationIds.add(contribution.sourceId);
  }
  for (const match of historicalSubmissionMatch?.matches ?? []) {
    representationIds.add(match.matchedRepresentationId);
  }

  const historicalMatchFacts: Record<string, DecisionTraceHistoricalMatchFacts> = {};
  for (const match of historicalSubmissionMatch?.matches ?? []) {
    if (historicalMatchFacts[match.matchedRepresentationId]) continue;
    historicalMatchFacts[match.matchedRepresentationId] = {
      matchType: match.matchType,
      containment: match.containment,
      passageCount: match.passageCount,
      longestMatchWords: match.longestMatchWords,
      historicalSubmissionCount: match.historicalSubmissionCount,
      matchedWordCount: match.matchedWordCount,
    };
  }

  const accountEvidenceByRepresentation: Record<string, DecisionTraceAccountEvidence> = {};
  const deviceEvidenceByRepresentation: Record<string, DecisionTraceDeviceEvidence> = {};
  const reportCanonicalSha256 = safeCanonicalSha256(payload.text);
  let processed = 0;
  for (const representationId of representationIds) {
    if (processed >= MAX_TRACE_REPRESENTATIONS) break;
    processed += 1;
    try {
      const provenance = await summarizeSubmissionProvenance(client, representationId, {
        accountId,
        excludeDocumentIdentityId: raw.document_identity_id,
        reportVerifiedDevicePassportId: raw.verified_device_passport_id,
        reportCanonicalSha256,
        reportDocumentIdentityId: raw.document_identity_id,
      });
      deviceEvidenceByRepresentation[representationId] = {
        sameVerifiedDeviceBacking: provenance.sameVerifiedDeviceBacking,
        sameDeviceBackingCount: provenance.sameDeviceBackingCount,
        independentBackingCount: provenance.independentBackingCount,
        backingsWithoutDeviceProvenance: provenance.backingsWithoutDeviceProvenance,
        admittedBackingsDifferentDevice: provenance.admittedBackingsDifferentDevice,
        admittedBackingsNoDeviceProvenance: provenance.admittedBackingsNoDeviceProvenance,
        admittedPromotionBackingCount: provenance.admittedPromotionBackingCount,
        submissionReferenceBackingCount: provenance.submissionReferenceBackingCount,
        identitySameAccount: provenance.identitySameAccount,
        priorSameAccountIdentityCount: provenance.priorSameAccountIdentityCount,
      };
    } catch (err) {
      console.error(`getReportSimilarityDecisionTrace: summarizeSubmissionProvenance failed for one representation (non-fatal):`, err instanceof Error ? err.message : String(err));
    }
    try {
      accountEvidenceByRepresentation[representationId] = await resolveMatchedRepresentationBackingEvidence(client, representationId, {
        reportAccountId: accountId,
        excludeDocumentIdentityId: raw.document_identity_id,
      });
    } catch (err) {
      console.error(`getReportSimilarityDecisionTrace: backing-evidence resolution failed for one representation (non-fatal):`, err instanceof Error ? err.message : String(err));
    }
  }

  return buildAdminSimilarityDecisionTrace({
    archiveScore,
    unifiedSimilarity,
    archiveMatchedPositions: payload.archiveMatchedPositions,
    externalAcademicEvidence: payload.externalAcademicEvidence,
    historicalSubmissionMatch,
    historicalMatchFacts,
    accountEvidenceByRepresentation,
    deviceEvidenceByRepresentation,
    deviceShadow,
    hasVerifiedUploadPassport,
  });
}

function safeCanonicalSha256(text: string): string {
  try {
    return canonicalSha256(text ?? "");
  } catch {
    return canonicalSha256("");
  }
}
