import type { Client } from "@libsql/client";
import type {
  AcademicSearchCandidate,
  AcademicSearchQuery,
  AcademicSearchRetrievalDiagnostic,
  AcademicSearchRunStats,
  AcademicSearchStatus,
  ExternalAcademicEvidence,
} from "./academic-search/types";

/**
 * Repository for academic_search_run_diagnostics (see db/schema.ts's own
 * header comment on that table). Read only by app/api/developer/* — never
 * imported by the live report/scoring path, matching this codebase's
 * existing convention of keeping feature modules unaware of report-facing
 * or admin-facing bridges (see lib/report-classification.ts's own comment
 * on the same discipline).
 *
 * Defensive, not algorithmic: MAX_STORED_CANDIDATES bounds how many ranked
 * candidates get persisted for inspection so one unusually broad-recall
 * submission can't produce an unbounded row — it has no effect on which
 * candidates the pipeline itself ranks, retrieves, or reports as evidence.
 */
const MAX_STORED_CANDIDATES = 200;

/**
 * Defensive ceiling on how many ExternalAcademicEvidence entries get persisted
 * as the verified scoring anchor (drizzle/0052). runAcademicSearch's own
 * DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG.maxCandidatesToRetrieve is 5, so a real run
 * never produces more than that; this only guards against a future config change
 * or a hand-built value bloating one row. Same "defensive, not algorithmic"
 * discipline as MAX_STORED_CANDIDATES above.
 */
const MAX_STORED_VERIFIED_EVIDENCE = 20;

/** 64 lowercase hex chars — the shape lib/document-identity.ts's canonicalSha256 produces. */
const CANONICAL_SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * documentIdentityId/reportDeviceKey/reportId are all optional here (unlike
 * a normal repository insert) because this is called from
 * app/api/academic-evidence/route.ts — BEFORE a report id or document
 * identity exists (see that route's own comment on why). The row is created
 * with those three null and linked later by linkAcademicSearchRunDiagnosticsToReport,
 * once app/api/reports/route.ts's deferred callback knows both. This two-step
 * shape (record now, link later) exists specifically so the raw diagnostic
 * content itself — candidates, queries, provider errors, timings — never has
 * to round-trip through the client at all: only a bare numeric id does. See
 * that route's own header comment for the full rationale.
 */
export type RecordAcademicSearchRunDiagnosticsParams = {
  status: AcademicSearchStatus;
  stats: AcademicSearchRunStats;
  queries: AcademicSearchQuery[] | null;
  candidates: AcademicSearchCandidate[] | null;
  retrievalDiagnostics: AcademicSearchRetrievalDiagnostic[] | null;
  /**
   * Scholarly evidence server trust boundary (drizzle/0052): the exact
   * ExternalAcademicEvidence[] the server-side matcher (runAcademicSearch
   * Stage 7) produced for this run. This is the ONLY scholarly matchedPassages
   * the report/scoring path will ever score — resolveVerifiedAcademicEvidence
   * below reads it back, gated on submissionCanonicalSha256. Written once, by
   * app/api/academic-evidence/route.ts; never touched by a client-facing route.
   * Optional/absent-safe: a caller that omits it (older tests, a future
   * diagnostics-only recorder) simply stores NULL, and no scholarly evidence is
   * ever verifiable from that row.
   */
  evidence?: ExternalAcademicEvidence[] | null;
  /**
   * canonicalSha256(submission text) at run time — the binding
   * resolveVerifiedAcademicEvidence checks against the report's own text hash so
   * a high-evidence row can never be replayed against a different document.
   * Optional/absent-safe like `evidence` above.
   */
  submissionCanonicalSha256?: string | null;
};

/** Inserts one unlinked diagnostics row and returns its id — the only thing app/api/academic-evidence/route.ts ever sends back to the client. */
export async function recordAcademicSearchRunDiagnostics(client: Client, params: RecordAcademicSearchRunDiagnosticsParams): Promise<number> {
  const boundedCandidates = params.candidates ? params.candidates.slice(0, MAX_STORED_CANDIDATES) : null;
  const boundedEvidence = Array.isArray(params.evidence) ? params.evidence.slice(0, MAX_STORED_VERIFIED_EVIDENCE) : null;
  const canonicalHash =
    typeof params.submissionCanonicalSha256 === "string" && CANONICAL_SHA256_RE.test(params.submissionCanonicalSha256)
      ? params.submissionCanonicalSha256
      : null;
  const result = await client.execute({
    sql: `INSERT INTO academic_search_run_diagnostics
            (document_identity_id, report_device_key, report_id, status, total_latency_ms, stats_json, queries_json, candidates_json, retrieval_diagnostics_json, evidence_json, submission_canonical_sha256)
          VALUES (NULL, NULL, NULL, ?,?,?,?,?,?,?,?)`,
    args: [
      params.status,
      params.stats.totalLatencyMs,
      JSON.stringify(params.stats),
      params.queries ? JSON.stringify(params.queries) : null,
      boundedCandidates ? JSON.stringify(boundedCandidates) : null,
      params.retrievalDiagnostics ? JSON.stringify(params.retrievalDiagnostics) : null,
      // Always a string when the pipeline ran (recordAcademicSearchRunDiagnostics
      // is only called when stats is truthy) — "[]" for COMPLETE_NO_MATCHES, a
      // populated array for COMPLETE_WITH_MATCHES. Distinguishing "[] persisted"
      // from "column NULL (pre-fix / never ran)" is deliberate: only the former
      // is an authoritative "the server verified nothing".
      boundedEvidence ? JSON.stringify(boundedEvidence) : null,
      canonicalHash,
    ],
  });
  return Number(result.lastInsertRowid);
}

export type ResolveVerifiedAcademicEvidenceParams = {
  /**
   * The diagnostics row id — an OPAQUE LOOKUP HANDLE the client carries
   * (POST /api/reports' body academicSearchDiagnosticsId, or the persisted
   * payload.verifiedAcademicSearchDiagnosticsId on a resave / GET / self-heal).
   * It is NOT trusted for anything except "which row to look at": every field
   * that matters is re-verified from the server-owned row below.
   */
  diagnosticsId: number | null | undefined;
  /**
   * canonicalSha256(the report's own text) computed right now, server-side. The
   * row's stored submission_canonical_sha256 must equal this exactly or the
   * result is [] — this is what stops a high-evidence row being replayed against
   * a different document.
   */
  submissionCanonicalSha256: string;
};

export type ResolveVerifiedAcademicEvidenceResult = {
  /** The server-verified ExternalAcademicEvidence[] — [] on ANY lookup / hash / parse failure. Never a client-supplied value. */
  evidence: ExternalAcademicEvidence[];
  /**
   * The row id whose evidence was accepted, or null when nothing verified. The
   * caller (POST /api/reports) persists this as
   * payload.verifiedAcademicSearchDiagnosticsId so GET / self-heal can re-resolve
   * WITHOUT depending on the deferred report-link columns ever being written.
   */
  verifiedDiagnosticsId: number | null;
};

const EMPTY_VERIFIED: ResolveVerifiedAcademicEvidenceResult = { evidence: [], verifiedDiagnosticsId: null };

/**
 * The single server-authoritative resolver for scholarly scoring evidence.
 *
 * TRUST ANCHOR (all three required):
 *   1. a real academic_search_run_diagnostics row (server-owned, client cannot write it),
 *   2. its submission_canonical_sha256 == canonicalSha256(the report's own text), and
 *   3. its evidence_json parses to a well-formed ExternalAcademicEvidence[].
 *
 * It NEVER reads the report-link columns (report_device_key / report_id) — those
 * are set by a deferred runAfterResponse callback and their absence must never
 * cost a legitimately-verified report its scholarly evidence.
 *
 * Any failure — no id, no row, either column NULL, hash mismatch, malformed JSON,
 * DB error — resolves to { evidence: [], verifiedDiagnosticsId: null }. Never
 * throws. The caller must use this result verbatim and must NOT fall back to any
 * client-supplied matchedPassages.
 */
export async function resolveVerifiedAcademicEvidence(
  client: Client,
  params: ResolveVerifiedAcademicEvidenceParams,
): Promise<ResolveVerifiedAcademicEvidenceResult> {
  try {
    const id = params.diagnosticsId;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return EMPTY_VERIFIED;
    if (!CANONICAL_SHA256_RE.test(params.submissionCanonicalSha256)) return EMPTY_VERIFIED;

    const result = await client.execute({
      sql: "SELECT id, evidence_json, submission_canonical_sha256 FROM academic_search_run_diagnostics WHERE id = ?",
      args: [id],
    });
    const raw = result.rows[0] as unknown as { id: number; evidence_json: string | null; submission_canonical_sha256: string | null } | undefined;
    if (!raw) return EMPTY_VERIFIED;
    if (typeof raw.submission_canonical_sha256 !== "string" || raw.submission_canonical_sha256 !== params.submissionCanonicalSha256) return EMPTY_VERIFIED;
    if (typeof raw.evidence_json !== "string") return EMPTY_VERIFIED;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.evidence_json);
    } catch {
      return EMPTY_VERIFIED;
    }
    if (!Array.isArray(parsed)) return EMPTY_VERIFIED;

    // Shape-guard every entry: this feeds computeUnifiedSimilarity directly, so a
    // malformed persisted value must degrade to [] just like the failure cases.
    const evidence: ExternalAcademicEvidence[] = [];
    for (const entry of parsed.slice(0, MAX_STORED_VERIFIED_EVIDENCE)) {
      if (!entry || typeof entry !== "object") return EMPTY_VERIFIED;
      const e = entry as Partial<ExternalAcademicEvidence>;
      if (typeof e.provider !== "string" || typeof e.providerId !== "string") return EMPTY_VERIFIED;
      if (!Array.isArray(e.matchedPassages)) return EMPTY_VERIFIED;
      for (const p of e.matchedPassages) {
        if (!p || typeof p !== "object") return EMPTY_VERIFIED;
        const mp = p as Record<string, unknown>;
        if (!Number.isInteger(mp.submittedWordStart) || !Number.isInteger(mp.submittedWordEnd) || !Number.isInteger(mp.matchedWordCount)) return EMPTY_VERIFIED;
      }
      if (typeof e.similarity !== "number" || !Number.isFinite(e.similarity)) return EMPTY_VERIFIED;
      evidence.push(entry as ExternalAcademicEvidence);
    }

    return { evidence, verifiedDiagnosticsId: Number(raw.id) };
  } catch (err) {
    console.error("resolveVerifiedAcademicEvidence failed (non-fatal — verified scholarly evidence = []):", err instanceof Error ? err.message : String(err));
    return EMPTY_VERIFIED;
  }
}

export type LinkAcademicSearchRunDiagnosticsParams = {
  documentIdentityId: string | null;
  reportDeviceKey: string;
  reportId: string;
};

/**
 * Called from app/api/reports/route.ts's deferred save callback — the first
 * point where a report id and (usually) a document identity actually exist.
 * A no-op (0 rows affected, not an error) if `id` doesn't correspond to a
 * real unlinked row — e.g. a stale/forged id a client sent — since this must
 * never be able to fail a report save.
 */
export async function linkAcademicSearchRunDiagnosticsToReport(client: Client, id: number, params: LinkAcademicSearchRunDiagnosticsParams): Promise<void> {
  await client.execute({
    sql: `UPDATE academic_search_run_diagnostics SET document_identity_id = ?, report_device_key = ?, report_id = ? WHERE id = ? AND report_device_key IS NULL AND report_id IS NULL`,
    args: [params.documentIdentityId, params.reportDeviceKey, params.reportId, id],
  });
}

export type AcademicSearchRunDiagnosticsRow = {
  id: number;
  documentIdentityId: string | null;
  reportDeviceKey: string | null;
  reportId: string | null;
  status: AcademicSearchStatus;
  totalLatencyMs: number;
  stats: AcademicSearchRunStats;
  queries: AcademicSearchQuery[] | null;
  candidates: AcademicSearchCandidate[] | null;
  retrievalDiagnostics: AcademicSearchRetrievalDiagnostic[] | null;
  createdAt: string;
};

type RawRow = {
  id: number;
  document_identity_id: string | null;
  report_device_key: string | null;
  report_id: string | null;
  status: string;
  total_latency_ms: number;
  stats_json: string;
  queries_json: string | null;
  candidates_json: string | null;
  retrieval_diagnostics_json: string | null;
  created_at: string;
};

const COLUMNS =
  "id, document_identity_id, report_device_key, report_id, status, total_latency_ms, stats_json, queries_json, candidates_json, retrieval_diagnostics_json, created_at";

function toRow(raw: RawRow): AcademicSearchRunDiagnosticsRow {
  return {
    id: Number(raw.id),
    documentIdentityId: raw.document_identity_id,
    reportDeviceKey: raw.report_device_key,
    reportId: raw.report_id,
    status: raw.status as AcademicSearchStatus,
    totalLatencyMs: Number(raw.total_latency_ms),
    stats: JSON.parse(raw.stats_json),
    queries: raw.queries_json ? JSON.parse(raw.queries_json) : null,
    candidates: raw.candidates_json ? JSON.parse(raw.candidates_json) : null,
    retrievalDiagnostics: raw.retrieval_diagnostics_json ? JSON.parse(raw.retrieval_diagnostics_json) : null,
    createdAt: raw.created_at,
  };
}

/** Every diagnostics run captured for one document identity, most recent first — the "has this exact submission event been analyzed before, and what did the pipeline see" view. */
export async function findAcademicSearchRunDiagnosticsByDocumentIdentityId(client: Client, documentIdentityId: string): Promise<AcademicSearchRunDiagnosticsRow[]> {
  const result = await client.execute({
    sql: `SELECT ${COLUMNS} FROM academic_search_run_diagnostics WHERE document_identity_id = ? ORDER BY id DESC`,
    args: [documentIdentityId],
  });
  return (result.rows as unknown as RawRow[]).map(toRow);
}

/** The diagnostics run captured for one specific saved report, if any. */
export async function findAcademicSearchRunDiagnosticsByReport(client: Client, reportDeviceKey: string, reportId: string): Promise<AcademicSearchRunDiagnosticsRow | undefined> {
  const result = await client.execute({
    sql: `SELECT ${COLUMNS} FROM academic_search_run_diagnostics WHERE report_device_key = ? AND report_id = ? ORDER BY id DESC LIMIT 1`,
    args: [reportDeviceKey, reportId],
  });
  const raw = result.rows[0] as unknown as RawRow | undefined;
  return raw ? toRow(raw) : undefined;
}

/** Most recent diagnostics runs across every account — the developer dashboard's overview feed. */
export async function findRecentAcademicSearchRunDiagnostics(client: Client, limit = 50): Promise<AcademicSearchRunDiagnosticsRow[]> {
  const result = await client.execute({
    sql: `SELECT ${COLUMNS} FROM academic_search_run_diagnostics ORDER BY id DESC LIMIT ?`,
    args: [limit],
  });
  return (result.rows as unknown as RawRow[]).map(toRow);
}
