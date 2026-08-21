import type { Client } from "@libsql/client";
import { findFamilyForIdentity, findFamilyMembers, type FamilyForIdentity, type FamilyMember } from "./document-family";
import {
  findAcademicSearchRunDiagnosticsByDocumentIdentityId,
  findAcademicSearchRunDiagnosticsByReport,
  type AcademicSearchRunDiagnosticsRow,
} from "./academic-search-diagnostics-repo";
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
