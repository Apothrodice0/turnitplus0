import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../lib/reports-db';
import { checkRate, checkPollRate, checkReadRate } from '../../../lib/rate-limit';
import { clientIpFrom } from '../../../lib/client-ip';
import { getSessionUser, parseCookie, hashToken, SESSION_COOKIE_NAME } from '../../../lib/auth-session';
import {
  isDevicePassportEnabled,
  verifyDevicePassportAttestation,
  maybeBumpDevicePassportProvenanceGeneration,
} from '../../../lib/device-passport-server';
import { captureDocumentIdentityAndFamily } from '../../../lib/document-family';
import { linkAcademicSearchRunDiagnosticsToReport } from '../../../lib/academic-search-diagnostics-repo';
import { checkUploadLimit } from '../../../lib/upload-limit';
import { getRoomCountForRole, isWithinActiveCycle, roomCycleEndsAt } from '../../../lib/report-rooms';
import { findRoomOccupant } from '../../../lib/reports-repo';
import { runAfterResponse } from '../../../lib/run-after-response';
import { createPendingReportAdmissionJob, processReportAdmissionJob } from '../../../lib/corpus-admission-report-integration';
import { resolvePrimarySimilaritySummary } from '../../../lib/report-primary-similarity';
import { scheduleReportShadowEvaluations } from '../../../lib/report-shadow-evaluations';
import type { SimilarityReport, ReportHistoricalSubmissionMatch } from '../../../lib/report-types';

// Reports carry derived data (AI passages, matched phrases, extracted text)
// on top of the ingest pipeline's raw text, so this cap is larger than
// /api/ingest's 200KB — sized generously pending real-world calibration.
const MAX_BYTES = 2_000_000;
const MAX_DEVICE_KEY_LENGTH = 200;
const MAX_LISTED_REPORTS = 50;
// Device Passport (Phase 2) — coarse structural ceilings on the optional
// attestation object; lib/device-passport-server.ts re-validates every field
// strictly (exact decoded byte lengths, canonical base64, EC P-256 curve).
const MAX_ATTESTATION_FIELD_LENGTH = 1_000;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// Release-hardening audit finding LIFECYCLE-02: two AI-completion resaves
// for the same report can race (the automatic post-upload pass in one tab
// still finishing while a different tab/device's manual "Retry analysis"
// also completes — both target the same (device_key, id), see
// app/reports/rooms/[room]/room-page-shell.tsx's saveEnrichedAiResult). A
// plain unconditional UPSERT is last-write-wins: whichever request's
// transaction commits last would silently overwrite a genuine, already-
// persisted "ready" result (a real ai_score) with a later-arriving "failed"
// one, discarding real data. The three CASE guards below make "ready" a
// one-way, sticky terminal state with respect to a "failed" write
// specifically: once ai_status is already 'ready', an incoming 'failed'
// write leaves ai_score/ai_tone/ai_status/payload_json exactly as they
// were (every other column — title, word_count, etc. — still updates
// normally, since both a 'ready' and a 'failed' resave carry the same
// underlying similarity data). Every other transition is untouched: ready
// can still be reached from processing or failed (a late genuine success
// is exactly what a retry is for), and processing/failed/failed all behave
// exactly as before.
//
// Release-hardening audit finding SIM-04: payload_json's own CASE gained a
// SECOND, independent guard — concurrent resaves of the SAME report can
// each finalize (lib/report-primary-similarity.ts) against a DIFFERENT
// corpus_match_generation snapshot; whichever transaction happens to COMMIT
// last must not be allowed to overwrite an already-persisted result that
// reflects a NEWER generation with one reflecting an OLDER one, regardless
// of commit order. json_extract on excluded/saved_reports.payload_json
// compares the unifiedSimilarityGeneration each side's own payload embeds
// (see lib/report-types.ts's own comment on that field) — COALESCE(...,-1)
// treats "never persisted a generation at all" (a legacy payload, or a
// finalization attempt that genuinely failed and left unifiedSimilarity
// unset — see this route's own POST handler try/catch) as lower than any
// real generation, so a first-ever write, or a failed finalization's
// unenriched payload, can never regress an already-good persisted value —
// it simply keeps what was already there instead.
//
// AI score / pending-state consistency fix (upstream persistence half):
// that generation guard protects the WHOLE payload_json blob, similarity
// AND AI fields alike — but the two are genuinely independent pipelines.
// The exact production split (room card "0% AI" / detail page "AI report
// pending" for report 1787833395119): the AI-enrichment resave carries a
// freshly-completed payload.aiAnalysis AND updates the flat ai_score/
// ai_tone/ai_status columns (separate args, not under this guard), but its
// own write-time similarity finalization transiently failed, so its
// payload has no unifiedSimilarityGeneration — the guard then keeps the
// existing (generation-stamped) payload, which never had aiAnalysis, while
// the columns still moved to 'ready' + a real score. The nested CASE below
// closes that: when the guard keeps the existing payload BECAUSE the
// incoming similarity generation is stale/missing, and the incoming
// payload carries a real aiAnalysis, that aiAnalysis (and its paired raw
// aiScore — written together by saveEnrichedAiResult) is merged into the
// retained authoritative payload via json_set. Nothing else is touched:
// the retained payload's unifiedSimilarity / unifiedSimilarityGeneration /
// every other field stay byte-for-byte as they were, so a stale similarity
// resave still cannot overwrite newer similarity data (json_extract of a
// JSON object carries the JSON subtype, so json_set inserts it AS JSON,
// never a re-quoted string). An incoming payload WITHOUT an aiAnalysis
// (a similarity-only resave, or the still-processing first save) hits the
// inner ELSE and leaves the retained payload — including any existing
// aiAnalysis — completely untouched. The first WHEN (a 'failed' resave
// against an already-'ready' row) is unchanged and never merges: that
// incoming aiAnalysis is a genuine failure result that must not clobber
// the good one, exactly as the ai_score/ai_tone/ai_status CASEs above
// already refuse it.
// Exported so tests/report-write-time-finalization.test.mjs's own SIM-04
// concurrency-guard test can exercise this EXACT SQL text directly — never a
// hand-copied duplicate that could silently drift from what production
// actually runs.
export const SAVE_REPORT_SQL = `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_score, ai_tone, ai_status, payload_json, user_id, room_number, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(device_key, id) DO UPDATE SET
        submission_id = excluded.submission_id,
        title = excluded.title,
        report_created_at = excluded.report_created_at,
        word_count = excluded.word_count,
        archive_score = excluded.archive_score,
        score_band = excluded.score_band,
        ai_score = CASE WHEN saved_reports.ai_status = 'ready' AND excluded.ai_status = 'failed' THEN saved_reports.ai_score ELSE excluded.ai_score END,
        ai_tone = CASE WHEN saved_reports.ai_status = 'ready' AND excluded.ai_status = 'failed' THEN saved_reports.ai_tone ELSE excluded.ai_tone END,
        ai_status = CASE WHEN saved_reports.ai_status = 'ready' AND excluded.ai_status = 'failed' THEN saved_reports.ai_status ELSE excluded.ai_status END,
        payload_json = CASE
          WHEN saved_reports.ai_status = 'ready' AND excluded.ai_status = 'failed' THEN saved_reports.payload_json
          WHEN COALESCE(json_extract(saved_reports.payload_json, '$.unifiedSimilarityGeneration'), -1) > COALESCE(json_extract(excluded.payload_json, '$.unifiedSimilarityGeneration'), -1)
            THEN CASE
              WHEN json_extract(excluded.payload_json, '$.aiAnalysis') IS NOT NULL
                THEN json_set(saved_reports.payload_json, '$.aiAnalysis', json_extract(excluded.payload_json, '$.aiAnalysis'), '$.aiScore', json_extract(excluded.payload_json, '$.aiScore'))
              ELSE saved_reports.payload_json
            END
          ELSE excluded.payload_json
        END,
        user_id = COALESCE(excluded.user_id, saved_reports.user_id),
        updated_at = CURRENT_TIMESTAMP`;

const MAX_ROOM_INSERT_BUSY_RETRIES = 5;

function isSqliteBusyError(err: unknown): boolean {
  return err instanceof Error && /SQLITE_BUSY/i.test(err.message);
}

/**
 * The room-occupancy check and the insert as one atomic write transaction,
 * retried on SQLITE_BUSY with a genuinely fresh connection each attempt
 * (production audit fix for the concurrent-upload race — two different new
 * uploads racing for the same empty room). Verified directly against a real
 * two-tab race in tests/report-rooms.test.mjs: two connections both opening
 * a write transaction against the same database at once reliably raises
 * SQLITE_BUSY on the loser, and simply retrying on the SAME connection does
 * not recover it — only a fresh connection per attempt does, which is also
 * exactly what a real concurrent HTTP request already gets (its own
 * getReportsDbClient() call), so this mirrors real request-level retry
 * rather than working around a test-only quirk. Each attempt re-reads
 * occupancy fresh, so a retry can never act on stale data from an earlier
 * attempt — either it observes the winner's row and returns a real
 * conflict, or it becomes the winner itself.
 */
async function insertReportWithRoomCheck(params: {
  id: string; deviceKey: string; submissionId: string; title: string; createdAt: string;
  wordCount: number; archiveScore: number; scoreBand: string;
  aiScore: number | null; aiTone: string | null; aiStatus: string | null;
  payloadJson: string; userId: string | null;
  roomNumberForInsert: number | null; roomOwnerId: string | null;
  /**
   * Device Passport (Phase 2): the cryptographically verified upload
   * passport, or null. Written in a SECOND statement inside this same
   * transaction, immediately after the row is inserted — never folded into
   * SAVE_REPORT_SQL (which several tests exercise as an exact string) — and
   * guarded `WHERE verified_device_passport_id IS NULL`, so it can only ever
   * be set once. The caller passes non-null only on a genuine first save; a
   * resave passes null and this statement never runs.
   */
  verifiedDevicePassportId: string | null;
}): Promise<{ conflict: { mostRecent: string } | null }> {
  for (let attempt = 1; attempt <= MAX_ROOM_INSERT_BUSY_RETRIES; attempt++) {
    const txClient = await getReportsDbClient();
    try {
      const tx = await txClient.transaction('write');
      try {
        let conflict: { mostRecent: string } | null = null;
        if (params.roomNumberForInsert !== null && params.roomOwnerId !== null) {
          const occupant = await tx.execute({
            sql: `SELECT report_created_at FROM saved_reports WHERE user_id = ? AND room_number = ? ORDER BY report_created_at DESC LIMIT 1`,
            args: [params.roomOwnerId, params.roomNumberForInsert],
          });
          const mostRecent = occupant.rows[0]?.report_created_at as string | undefined;
          if (mostRecent && isWithinActiveCycle(mostRecent)) {
            conflict = { mostRecent };
          }
        }
        if (!conflict) {
          await tx.execute({
            sql: SAVE_REPORT_SQL,
            args: [
              params.id, params.deviceKey, params.submissionId, params.title, params.createdAt,
              params.wordCount, params.archiveScore, params.scoreBand,
              params.aiScore, params.aiTone, params.aiStatus,
              params.payloadJson, params.userId, params.roomNumberForInsert,
            ],
          });
          if (params.verifiedDevicePassportId) {
            // Immutable upload-time device provenance — set once, in the same
            // transaction as the insert, never overwritten (the IS NULL
            // guard). See db/schema.ts's saved_reports.verified_device_passport_id.
            await tx.execute({
              sql: `UPDATE saved_reports SET verified_device_passport_id = ?
                    WHERE device_key = ? AND id = ? AND verified_device_passport_id IS NULL`,
              args: [params.verifiedDevicePassportId, params.deviceKey, params.id],
            });
          }
        }
        await tx.commit();
        return { conflict };
      } catch (err) {
        await tx.rollback().catch(() => {});
        throw err;
      } finally {
        tx.close();
      }
    } catch (err) {
      if (!isSqliteBusyError(err) || attempt === MAX_ROOM_INSERT_BUSY_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, 30 * attempt + Math.floor(Math.random() * 30)));
    } finally {
      txClient.close();
    }
  }
  // Unreachable — the loop above always either returns or throws on its final iteration.
  throw new Error('insertReportWithRoomCheck: exhausted retries without resolving');
}

export async function POST(request: Request) {
  try {
    const rate = await checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const contentLength = request.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_BYTES) {
      return new NextResponse(JSON.stringify({ error: 'Payload too large' }), { status: 413 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return new NextResponse(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });

    const { deviceKey, id, submissionId, title, createdAt, wordCount, archiveScore, scoreBand, aiScore, aiTone, aiStatus, payload, academicSearchDiagnosticsId, room, devicePassport } = body as Record<string, unknown>;

    // device_key is part of saved_reports' composite primary key, so it is
    // always required regardless of authentication state — unlike the list/
    // get/delete endpoints below, where an authenticated session replaces
    // the need for it entirely.
    if (!isNonEmptyString(deviceKey) || deviceKey.length > MAX_DEVICE_KEY_LENGTH) {
      return new NextResponse(JSON.stringify({ error: 'deviceKey is required' }), { status: 400 });
    }
    if (!isNonEmptyString(id)) return new NextResponse(JSON.stringify({ error: 'id is required' }), { status: 400 });
    if (!isNonEmptyString(submissionId)) return new NextResponse(JSON.stringify({ error: 'submissionId is required' }), { status: 400 });
    if (!isNonEmptyString(title)) return new NextResponse(JSON.stringify({ error: 'title is required' }), { status: 400 });
    if (!isNonEmptyString(createdAt)) return new NextResponse(JSON.stringify({ error: 'createdAt is required' }), { status: 400 });
    if (typeof wordCount !== 'number' || !Number.isFinite(wordCount)) return new NextResponse(JSON.stringify({ error: 'wordCount must be a number' }), { status: 400 });
    if (typeof archiveScore !== 'number' || !Number.isFinite(archiveScore)) return new NextResponse(JSON.stringify({ error: 'archiveScore must be a number' }), { status: 400 });
    if (!isNonEmptyString(scoreBand)) return new NextResponse(JSON.stringify({ error: 'scoreBand is required' }), { status: 400 });
    if (aiScore !== null && aiScore !== undefined && typeof aiScore !== 'number') return new NextResponse(JSON.stringify({ error: 'aiScore must be a number or null' }), { status: 400 });
    if (aiTone !== null && aiTone !== undefined && typeof aiTone !== 'string') return new NextResponse(JSON.stringify({ error: 'aiTone must be a string or null' }), { status: 400 });
    if (aiStatus !== null && aiStatus !== undefined && aiStatus !== 'processing' && aiStatus !== 'ready' && aiStatus !== 'failed') {
      return new NextResponse(JSON.stringify({ error: "aiStatus must be 'processing', 'ready', 'failed', or null" }), { status: 400 });
    }
    if (payload === undefined) return new NextResponse(JSON.stringify({ error: 'payload is required' }), { status: 400 });
    // Developer-diagnostics addition: optional, never required — an older
    // client build, or a run where /api/academic-evidence never produced a
    // diagnostics row (network failure, short text), simply omits or nulls
    // this. Only ever a bare row id — see
    // app/api/academic-evidence/route.ts's own header comment for why the
    // raw diagnostic content never reaches this route (or this client) at
    // all.
    const academicDiagnosticsId = typeof academicSearchDiagnosticsId === 'number' && Number.isFinite(academicSearchDiagnosticsId)
      ? academicSearchDiagnosticsId
      : null;

    const payloadJson = JSON.stringify(payload);
    if (payloadJson.length > MAX_BYTES) {
      return new NextResponse(JSON.stringify({ error: 'Payload too large' }), { status: 413 });
    }

    const client = await getReportsDbClient();
    try {
      const sessionUser = await getSessionUser(request, client);
      const userId = sessionUser ? sessionUser.id : null;

      // Phase E8F: (device_key, id) is saved_reports' own composite primary
      // key — already the stable identifier for "one upload," with no new
      // UUID needed. app/page.tsx's generateReport() saves every report
      // twice for the SAME id (once immediately, once again a few seconds
      // later with Wikipedia-enrichment data merged in — see saveReport/
      // saveReportRemote there); this checks, before the upsert below runs,
      // whether this exact (device_key, id) has ever been saved before.
      // That boundary — not elapsed time, not content equality — is what
      // the runAfterResponse callback below uses to decide whether this
      // save may create a document identity / corpus reference at all.
      const existingReportRow = await client.execute({
        sql: `SELECT user_id FROM saved_reports WHERE device_key = ? AND id = ?`,
        args: [deviceKey, id],
      });
      const isFirstSaveOfThisReport = existingReportRow.rows.length === 0;

      // Release-hardening audit finding AUTHZ-01 (corrected): (device_key,
      // id) is the primary key, but the resave upsert (SAVE_REPORT_SQL
      // below) overwrites every column — including payload_json —
      // unconditionally from the request body.
      // COALESCE(excluded.user_id, saved_reports.user_id) only ever
      // protects against a NULL excluded.user_id clearing an existing
      // owner; it does nothing to stop the write itself, from anyone, once
      // (device_key, id) is known or guessed.
      //
      // Policy (an earlier version of this fix was too permissive — it
      // exempted an unauthenticated caller entirely, which still let an
      // anonymous request overwrite an account-owned report's content
      // without ever claiming it):
      //   - existing user_id IS NULL: any resave (anonymous or
      //     authenticated) proceeds under the existing device-key
      //     behavior — an anonymous report staying claimable is the
      //     pre-existing, intentional "claim on resave" behavior, and
      //     COALESCE resolving to a real userId there is a legitimate
      //     first claim, never a transfer away from an existing owner.
      //   - existing user_id IS NOT NULL: the request must carry an
      //     authenticated session whose id matches that owner exactly.
      //     No session, or a different account, gets the same generic
      //     404 — regardless of which one it is, never revealing that a
      //     report under this exact id belongs to someone else — and the
      //     row is never touched. This also covers the deferred Wikipedia-
      //     enrichment double-save: it normally carries the same session
      //     as the first save (same-origin fetch, cookies included by
      //     default) and passes; if the user signed out in between, the
      //     resave now correctly rejects rather than silently succeeding
      //     unauthenticated against someone else's report.
      // Ownership itself can therefore never be transferred away from an
      // existing non-NULL owner by any resave — the only way to pass this
      // guard for an owned report is for the caller to already BE that
      // owner, so COALESCE's result is always the same value it already
      // was. A 404, matching app/api/reports/[id]/route.ts's own "Report
      // not found" convention for a cross-account access attempt.
      if (!isFirstSaveOfThisReport) {
        const existingOwnerId = (existingReportRow.rows[0]?.user_id as string | null) ?? null;
        if (existingOwnerId !== null && existingOwnerId !== userId) {
          return new NextResponse(JSON.stringify({ error: 'Report not found' }), { status: 404 });
        }
      }

      // Daily upload quota (separate abuse-control layer from the IP rate
      // limiter above): applies only to authenticated, non-admin accounts,
      // and only to a genuinely new upload — never a resave of an
      // already-saved report (see lib/upload-limit.ts's own header comment
      // for why isFirstSaveOfThisReport is the right gate, and why
      // saved_reports.saved_at is what "genuinely new" means). Anonymous
      // requests (sessionUser === null) are entirely unaffected — they have
      // no account to meter and remain governed only by checkRate above.
      if (sessionUser && sessionUser.role !== 'admin' && isFirstSaveOfThisReport) {
        const limitCheck = await checkUploadLimit(client, sessionUser.id);
        if (!limitCheck.allowed) {
          return new NextResponse(
            JSON.stringify({
              error: `Daily upload limit reached (${limitCheck.uploadsToday}/${limitCheck.limit}). Try again after the limit resets.`,
              limit: limitCheck.limit,
              uploadsToday: limitCheck.uploadsToday,
              resetsAt: limitCheck.resetsAt,
            }),
            { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(limitCheck.retryAfterSeconds) } },
          );
        }
      }

      // Room/slot ownership: a genuinely new, authenticated upload must name
      // which of the account's room slots it belongs to (the room the user
      // had open — see components/reports/report-rooms.tsx), and the server
      // re-validates that slot is actually available RIGHT NOW rather than
      // trusting the client's own (possibly stale) view of room status —
      // this is the real enforcement of "one upload per room per 24h cycle";
      // the client-side UI gate (an empty room shows the upload panel) is
      // only ever a convenience on top of this. Never applies to a resave
      // (room_number is immutable after the first insert — see below) or to
      // an anonymous save (rooms are an authenticated-account concept only).
      let roomNumberForInsert: number | null = null;
      let roomOwnerId: string | null = null;
      if (sessionUser && isFirstSaveOfThisReport) {
        const roomCount = getRoomCountForRole(sessionUser.role);
        if (!Number.isInteger(room) || (room as number) < 0 || (room as number) >= roomCount) {
          return new NextResponse(JSON.stringify({ error: `room must be an integer 0-${roomCount - 1}` }), { status: 400 });
        }
        roomNumberForInsert = room as number;
        roomOwnerId = sessionUser.id;
      }

      // Release-hardening audit finding SIM-03: write-time finalization —
      // the report-generation pipeline's own authoritative unified-
      // similarity computation, persisted here (inside payload_json, via
      // payloadJson below) BEFORE this save's response is ever sent, never
      // deferred via runAfterResponse. That distinction matters: after()
      // gives no ordering guarantee relative to this same client's very
      // next request (see lib/run-after-response.ts's own header comment
      // and lib/report-historical-match.ts's own documented E8D race for a
      // concrete precedent) — a deferred finalization could still be
      // in-flight when the client turns around and opens the report or
      // polls its room, reproducing exactly the "still matching after the
      // user opens it" bug this fix exists to close.
      //
      // Runs on EVERY save with real text, not only the first: a resave's
      // own payload only ever carries the CLIENT's own partial (archive +
      // live-academic only — see lib/document-check-pipeline.ts's
      // attachUnifiedSimilarity, which has no way to reach the corpus at
      // all) computation, and the UPSERT below replaces payload_json
      // unconditionally; skipping this on a resave would silently regress
      // an already-finalized report back to that partial value.
      // getOrComputeHistoricalMatchSnapshot's own snapshot cache (reused
      // as-is, never a second matching implementation) makes every call
      // after the first genuine one for this exact (deviceKey, id) a cheap
      // cache hit, never a second real matcher search — see
      // tests/report-primary-similarity.test.mjs's own dedup coverage.
      //
      // Never touches archiveScore/score/scoreBand — only
      // payload.unifiedSimilarity, exactly like every other read-time
      // enrichment in this codebase already respects (see
      // lib/unified-similarity.ts's own DECISION 3).
      //
      // Release-hardening audit finding SIM-04: wrapped in its own
      // try/catch — this OUTER catch is for anything unexpected bubbling
      // out of resolvePrimarySimilaritySummary itself (e.g. a DB
      // connectivity error in getCurrentCorpusMatchGeneration or the
      // historical-match snapshot's own initial read, both outside that
      // function's own try/catch) — likely transient infrastructure
      // trouble, not a permanent, reproducible computation failure, so it
      // is deliberately left as "pending" (payloadJsonToPersist stays the
      // client's own submitted payloadJson, unchanged), eligible for an
      // automatic retry on the next view. This is distinct from
      // resolution.failed below (LIFECYCLE-06, corrected): THAT is
      // resolvePrimarySimilaritySummary's own INNER catch — computeUnifiedSimilarity
      // itself threw for this report's own data, a genuine, reproducible
      // overall-computation failure — persisted explicitly as
      // unifiedSimilarityFailed: true rather than silently staying
      // "pending" forever. SAVE_REPORT_SQL's own generation guard protects
      // both branches identically: an unenriched or failed-and-persisted
      // payload can never regress an already-good persisted result from an
      // earlier successful save.
      let payloadJsonToPersist = payloadJson;
      const reportPayload = payload as SimilarityReport;
      // Shadow-telemetry handoff: production's own historical-match result
      // from write-time finalization, captured here so the deferred
      // shadow-evaluation scheduling below (after the row is persisted) can
      // reuse it exactly — never a second matcher run, never a recomputed or
      // mutated score. Stays null when this save carries no finalizable text
      // or finalization threw unexpectedly; the GET /api/reports/[id]
      // fallback trigger still covers those reports.
      let historicalSubmissionMatchForShadow: ReportHistoricalSubmissionMatch | null = null;
      if (isNonEmptyString(reportPayload?.text)) {
        try {
          const resolution = await resolvePrimarySimilaritySummary(client, {
            reportDeviceKey: deviceKey,
            reportId: id,
            accountId: userId,
            rawText: reportPayload.text,
            wordCount: reportPayload.wordCount,
            archiveMatchedPositions: reportPayload.archiveMatchedPositions,
            externalAcademicEvidence: reportPayload.externalAcademicEvidence,
            archiveScore: reportPayload.archiveScore ?? reportPayload.score,
          });
          // Reused as-is by the deferred shadow evaluators below — the SAME
          // resolvePrimarySimilaritySummary output the GET route hands them,
          // populated on both the success and the
          // computeUnifiedSimilarity-failed branches.
          historicalSubmissionMatchForShadow = resolution.historicalSubmissionMatch;
          if (resolution.unifiedSimilarity) {
            payloadJsonToPersist = JSON.stringify({
              ...reportPayload,
              unifiedSimilarity: resolution.unifiedSimilarity,
              corpusSourceMatchingEnabledAtComputation: resolution.corpusSourceMatchingEnabled,
              unifiedSimilarityGeneration: resolution.corpusGeneration,
              // Explicit false, never omitted: a resave following an
              // earlier genuine failure must clear that marker, not let it
              // survive via reportPayload's own spread (which, for a retry
              // resave built by re-reading the previously stored report,
              // could otherwise still carry it forward).
              unifiedSimilarityFailed: false,
            });
            if (payloadJsonToPersist.length > MAX_BYTES) {
              return new NextResponse(JSON.stringify({ error: 'Payload too large' }), { status: 413 });
            }
          } else if (resolution.failed) {
            // Release-hardening audit finding LIFECYCLE-06 (corrected): a
            // genuine, reproducible overall-computation failure (see
            // resolution.failed's own comment) — persisted explicitly
            // instead of silently leaving this report indistinguishable
            // from "never attempted" (which stays "pending" forever,
            // auto-retried on every view, but never gives the user an
            // honest, actionable "Unavailable" the atomic reveal can work
            // with). unifiedSimilarityGeneration is still recorded so this
            // write participates correctly in SAVE_REPORT_SQL's own
            // generation guard below — omitting it would let COALESCE(...,
            // -1) make this failure write always lose to ANY already-
            // persisted generation, including a much older one, and never
            // actually land.
            //
            // Release-hardening audit finding LIFECYCLE-06 (approval-pass
            // fix): unifiedSimilarity: undefined is REQUIRED here, not
            // decorative. reportPayload is the client's own submitted
            // payload — for a resave built from a locally-cached copy of a
            // PREVIOUSLY successful result (e.g. saveEnrichedAiResult's
            // {...report, ...aiResult} spread), reportPayload.unifiedSimilarity
            // can already be set. Without this explicit clear, the spread
            // below would silently carry that stale success forward
            // alongside the fresh unifiedSimilarityFailed marker —
            // resolvePersistedSimilarityDisplay checks hasUnifiedSimilarity
            // BEFORE unifiedSimilarityFailed (a real result is meant to
            // always win over a stale failure marker — see that function's
            // own comment), so a lingering stale success would silently
            // mask this genuinely fresh failure, showing "resolved" with an
            // outdated score instead of "Unavailable". JSON.stringify drops
            // an `undefined`-valued key entirely, so this genuinely deletes
            // the field rather than persisting a literal null.
            payloadJsonToPersist = JSON.stringify({
              ...reportPayload,
              unifiedSimilarity: undefined,
              unifiedSimilarityFailed: true,
              corpusSourceMatchingEnabledAtComputation: resolution.corpusSourceMatchingEnabled,
              unifiedSimilarityGeneration: resolution.corpusGeneration,
            });
            if (payloadJsonToPersist.length > MAX_BYTES) {
              return new NextResponse(JSON.stringify({ error: 'Payload too large' }), { status: 413 });
            }
          }
        } catch (err) {
          console.error('write-time similarity finalization failed unexpectedly (non-fatal, report save proceeds without it):', err instanceof Error ? err.message : String(err));
        }
      }

      // Device Passport (Phase 2): cryptographically verify an optional
      // upload-time device attestation. NEVER affects the similarity score,
      // the matcher, or relationship classification — this phase only
      // captures verified provenance. Attempted only when the feature flag
      // is ON, this is a genuine first save (a resave carries no fresh
      // challenge), the attestation object is present, and the payload has
      // real text to bind a hash to.
      //
      // Fail-safe by construction: verifyDevicePassportAttestation returns
      // null (never throws) for every failure — bad signature, expired /
      // consumed / missing challenge, wrong session/account binding,
      // unregistered or revoked passport, tampered text or report id,
      // malformed base64, oversized field, DB error — and the report upload
      // then proceeds exactly as if no attestation had been sent. Only
      // positive verified evidence ever produces a non-null id.
      let verifiedDevicePassportId: string | null = null;
      if (
        isDevicePassportEnabled() &&
        isFirstSaveOfThisReport &&
        devicePassport && typeof devicePassport === 'object' &&
        isNonEmptyString(reportPayload?.text)
      ) {
        const dp = devicePassport as Record<string, unknown>;
        const attestationFieldsOk = [dp.challengeId, dp.nonce, dp.publicKeySpki, dp.signature].every(
          (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ATTESTATION_FIELD_LENGTH,
        );
        if (attestationFieldsOk) {
          try {
            const rawSessionToken = parseCookie(request.headers.get('cookie'), SESSION_COOKIE_NAME);
            verifiedDevicePassportId = await verifyDevicePassportAttestation(client, {
              challengeId: dp.challengeId,
              nonce: dp.nonce,
              publicKeySpki: dp.publicKeySpki,
              signature: dp.signature,
              method: 'POST',
              path: '/api/reports',
              payloadText: reportPayload.text,
              reportId: id,
              currentAccountId: userId,
              currentSessionTokenHash: sessionUser && rawSessionToken ? hashToken(rawSessionToken) : null,
            });
          } catch (err) {
            console.error('device passport verification failed unexpectedly (non-fatal, report upload proceeds without provenance):', err instanceof Error ? err.message : String(err));
            verifiedDevicePassportId = null;
          }
        }
      }

      // Concurrency (production audit fix): the occupancy check and the
      // insert must be one atomic unit relative to any OTHER concurrent
      // request touching the same room slot — otherwise two different new
      // uploads (e.g. the same account open in two tabs, both starting a
      // check on the same empty room within the same few-second analysis
      // window) can each observe "this room is free" before either has
      // inserted, and both succeed — silently violating "a room holds AT
      // MOST one current report" (see lib/report-rooms.ts's own header
      // comment). See insertReportWithRoomCheck's own comment for why this
      // needs a real busy-retry loop, not just a transaction.
      const { conflict: roomConflict } = await insertReportWithRoomCheck({
        id, deviceKey, submissionId, title, createdAt, wordCount, archiveScore, scoreBand,
        aiScore: aiScore ?? null, aiTone: aiTone ?? null, aiStatus: aiStatus ?? null,
        payloadJson: payloadJsonToPersist, userId, roomNumberForInsert, roomOwnerId,
        verifiedDevicePassportId,
      });

      if (roomConflict) {
        return new NextResponse(
          JSON.stringify({
            error: `Room ${(roomNumberForInsert as number) + 1} already has an active report. It will be available again at ${roomCycleEndsAt(roomConflict.mostRecent)}.`,
            cycleEndsAt: roomCycleEndsAt(roomConflict.mostRecent),
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Device Passport (Phase 2): bump this ONE passport's
      // provenance_generation only when this just-inserted verified report
      // introduces a NEW (passport, account) association — a repeat report
      // from the same account on the same passport does not bump; the first
      // anonymous report from a passport does. Never a global counter, so it
      // never invalidates a report tied to a different passport. Synchronous
      // (one indexed lookup + at most one one-statement UPDATE), best-effort.
      if (verifiedDevicePassportId) {
        try {
          await maybeBumpDevicePassportProvenanceGeneration(client, {
            passportId: verifiedDevicePassportId,
            accountId: userId,
            deviceKey,
            reportId: id,
          });
        } catch (err) {
          console.error('device passport provenance-generation bump failed (non-fatal):', err instanceof Error ? err.message : String(err));
        }
      }

      // Document identity + fingerprint + family capture (Phase A/B/C):
      // best-effort, non-fatal side effect of saving a report — this is
      // currently the only point in the live product where a server ever
      // sees the full submitted text. Capturing here (rather than adding a
      // new call on every analysis, not just saved ones) keeps this
      // additive: no new network call from the client, no UI change.
      //
      // Phase C activates fingerprinting and family resolution (Phase B's
      // recordDocumentIdentityShingles/resolveFamilyForIdentity, previously
      // built but never called from here) via runAfterResponse: the whole
      // pipeline runs *after* this response is sent, on its own DB
      // connection, so it can never add to this route's response latency —
      // see lib/run-after-response.ts for why a plain non-awaited call isn't
      // safe here and what the fallback does in contexts (tests) with no
      // real Next.js request scope. author is intentionally never populated
      // from `payload` — there is no real author input in the product yet.
      const rawText = payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).text === 'string'
        ? (payload as Record<string, unknown>).text as string
        : null;

      // Corpus-admission job scaffolding: created SYNCHRONOUSLY, here,
      // still inside this request — never only inside the runAfterResponse
      // callback below. If the process crashes or is recycled after the
      // response is sent but before that deferred work ever starts, a
      // deferred-only creation would leave no trace at all that admission
      // was ever supposed to happen; this durable 'pending' row is what a
      // later corpus-admission retry sweep (lib/corpus-admission-report-
      // integration.ts's runReportAdmissionRetrySweep) can find and
      // process instead. Gated on sessionUser.corpusReuseConsented (the
      // request-time snapshot) purely to avoid creating a pointless row for
      // every non-consenting upload — the actual admission work, run
      // below, always re-checks consent fresh regardless of this snapshot.
      let pendingAdmissionJobId: string | null = null;
      if (rawText && isFirstSaveOfThisReport && userId !== null && sessionUser?.corpusReuseConsented) {
        // Device Passport (Phase 2): the verified upload passport is copied
        // onto the job here, from the verified upload context — never
        // re-derived later. processReportAdmissionJob reads it back from the
        // job row and, on ACCEPT, records
        // corpus_admission_decision_device_provenance.
        const created = await createPendingReportAdmissionJob(client, {
          accountId: userId,
          deviceKey,
          reportId: id,
          verifiedDevicePassportId,
        });
        pendingAdmissionJobId = created?.jobId ?? null;
      }

      // Phase E8F: gated on isFirstSaveOfThisReport (see above) — an update
      // to an already-saved report (id already existed) must not create a
      // second document identity or a second corpus submission reference
      // for what is, from the corpus's perspective, still the same single
      // upload. A genuinely new upload always gets a new id from the
      // client, so this never suppresses a real new submission.
      if (rawText && isFirstSaveOfThisReport) {
        // Privacy hardening: captured as a plain local (not `sessionUser`)
        // for the same reason app/api/reports/[id]/route.ts's own
        // runAfterResponse callback captures plain locals — keeps the
        // deferred closure independent of the outer request's object.
        const reportDeviceKey = deviceKey;
        const reportId = id;
        const capturedAcademicDiagnosticsId = academicDiagnosticsId;
        const capturedPendingAdmissionJobId = pendingAdmissionJobId;
        await runAfterResponse(async () => {
          const deferredClient = await getReportsDbClient();
          try {
            const captured = await captureDocumentIdentityAndFamily(deferredClient, { accountId: userId, title, author: null, rawText });
            // Privacy hardening: records the exact link this report's
            // identity/shingle/family/corpus data lives under — see
            // db/schema.ts's saved_reports.document_identity_id comment and
            // lib/report-deletion.ts, which is what actually uses this link
            // when the report is later deleted. Written in the same
            // deferred callback, right after the identity row is created,
            // so it can never point at an identity that failed to be
            // created (the catch below still fires first in that case).
            await deferredClient.execute({
              sql: 'UPDATE saved_reports SET document_identity_id = ? WHERE device_key = ? AND id = ?',
              args: [captured.documentIdentityId, reportDeviceKey, reportId],
            });
            // Developer-diagnostics addition: links the diagnostics row
            // /api/academic-evidence/route.ts already persisted (queries,
            // ranked candidates, per-candidate retrieval/comparison outcome,
            // provider errors, stage timings) to this document identity and
            // report, for later inspection via /api/developer/*. This route
            // never sees the raw diagnostic content itself — only the id —
            // see that route's own header comment. Independent of userId/
            // corpus-reuse-consent (unlike corpus indexing below): it is not
            // the cross-account matching corpus, only a record of what this
            // one run saw. A failure here is caught on its own, distinct
            // from identity-capture and corpus-indexing failures, and never
            // re-thrown.
            if (capturedAcademicDiagnosticsId !== null) {
              try {
                await linkAcademicSearchRunDiagnosticsToReport(deferredClient, capturedAcademicDiagnosticsId, {
                  documentIdentityId: captured.documentIdentityId,
                  reportDeviceKey,
                  reportId,
                });
              } catch (err) {
                console.error('linkAcademicSearchRunDiagnosticsToReport failed (non-fatal):', err instanceof Error ? err.message : String(err));
              }
            }
            // Corpus-admission hardening: this route no longer calls
            // lib/user-submission-corpus.ts's indexDocumentSubmissionIntoCorpus
            // directly (Phase E8D's original activation, removed) — that
            // specific, account-linked live-indexing path stays out of scope
            // here, still enforced by tests/corpus-admission-privacy.test.mjs's
            // structural proof that no file under app/ can reach it.
            //
            // Controlled ADMISSION is wired below: processReportAdmissionJob
            // runs the full corpus-admission gate (lib/corpus-admission-
            // gate.ts — English-only, 3000-word minimum, quality scoring,
            // retention/consent, "first accepted sample wins" family-
            // duplicate checks) against the job row already created
            // SYNCHRONOUSLY above (before this deferred callback ever
            // started — see that call site's own comment for why), and
            // records its own audit trail, entirely behind
            // CORPUS_ADMISSION_ENABLED (off by default) and a fresh,
            // request-time-independent re-check of
            // users.corpus_reuse_consented_at — see
            // lib/corpus-admission-report-integration.ts's own header
            // comment for why sessionUser.corpusReuseConsented (captured
            // earlier in this same request) is deliberately never trusted
            // for the actual admission decision. As of the automatic-
            // promotion fix, processReportAdmissionJob also immediately
            // stages and attempts to promote a fresh ACCEPT into the real
            // reusable corpus (never the account-linked
            // indexDocumentSubmissionIntoCorpus path above — a separate,
            // narrower mechanism via lib/corpus-admission-promotion.ts, see
            // that module's own header comment), behind its own
            // CORPUS_PROMOTION_ENABLED flag.
            if (capturedPendingAdmissionJobId !== null) {
              try {
                await processReportAdmissionJob(deferredClient, {
                  jobId: capturedPendingAdmissionJobId,
                  openConnection: () => getReportsDbClient(),
                });
              } catch (err) {
                // processReportAdmissionJob's own contract is "never
                // throws" (every real outcome, including a gate failure, is
                // persisted to corpus_admission_report_jobs and returned as
                // a value) — this catch is only a defensive second layer,
                // matching every other best-effort step in this callback.
                console.error('processReportAdmissionJob failed unexpectedly (non-fatal):', err instanceof Error ? err.message : String(err));
              }
            }
          } catch (err) {
            console.error('captureDocumentIdentityAndFamily failed (non-fatal):', err instanceof Error ? err.message : String(err));
          } finally {
            deferredClient.close();
          }
        });
      }

      // Shadow-telemetry handoff for write-time-finalized reports: the
      // report row is now durably persisted (including any verified upload
      // passport, written inside the same transaction as the insert by
      // insertReportWithRoomCheck), so schedule the SAME measurement-only
      // evaluators the GET /api/reports/[id] route runs — the historical-
      // match shadow (lib/e8p-shadow-evaluation.ts) and the device-
      // provenance shadow (lib/device-provenance-shadow.ts) — through the
      // one shared lib/report-shadow-evaluations.ts helper so the two
      // trigger sites cannot drift. Required because a report whose unified
      // similarity finalizes here at write time (and whose AI is already
      // done) is frequently never fetched through that GET route at all, so
      // its telemetry would otherwise never be recorded. Reuses
      // productionResult from write-time finalization above verbatim — never
      // recomputes or touches the score — is deferred via runAfterResponse
      // (never adds response latency), is best-effort (a telemetry failure
      // never fails this save), and is idempotent: both evaluators UPSERT
      // one row per (device_key, id, policy_version), so a later GET on the
      // same report converges on that row rather than duplicating it.
      // Skipped when write-time finalization produced no result to hand over
      // (no text, or an unexpected throw) — GET remains the fallback there.
      if (historicalSubmissionMatchForShadow !== null) {
        await scheduleReportShadowEvaluations({
          reportDeviceKey: deviceKey,
          reportId: id,
          accountId: userId,
          rawText: reportPayload.text,
          productionResult: historicalSubmissionMatchForShadow,
        });
      }
    } finally {
      client.close();
    }

    return new NextResponse(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    // Room-status polling (app/reports/rooms/[room]/room-page-shell.tsx's
    // own 3-second interval while a check is "processing") gets its own,
    // isolated bucket — production bug fix. Sharing a bucket with anything
    // else meant a normal poll window alone could exhaust the SAME budget
    // other ordinary browsing/upload/auth action on this account also draws
    // from. The room param is parsed once here, up front, purely to pick
    // the right bucket; the authenticated/room-scoped branch below
    // re-validates it for real. The non-room-scoped branch (the
    // authenticated top-50 list and the anonymous device-key list) is
    // ordinary read/navigation traffic, not a write/auth action — it uses
    // checkReadRate (see lib/rate-limit.ts), never the strict bucket.
    const isRoomScopedPoll = new URL(request.url).searchParams.get('room') !== null;
    const rate = isRoomScopedPoll ? await checkPollRate(clientIpFrom(request)) : await checkReadRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const client = await getReportsDbClient();
    let rows;
    try {
      const sessionUser = await getSessionUser(request, client);
      if (sessionUser) {
        // Authenticated: cross-device, scoped by account rather than by
        // whichever browser happens to be asking.
        //
        // Room/slot architecture: `room` scopes this query to one specific
        // slot, which holds AT MOST one CURRENT report — see
        // lib/report-rooms.ts's own header comment. Unlike the old id%10
        // grouping, room_number is a stored, explicit fact (set once at
        // upload time), so this is a plain equality lookup, not a modulo
        // scan — idx_saved_reports_user_room covers it directly. Absent
        // `room` preserves the original, pre-rooms behavior (top 50 across
        // the whole account) for any other existing caller.
        const url = new URL(request.url);
        const roomParam = url.searchParams.get('room');
        if (roomParam !== null) {
          const roomCount = getRoomCountForRole(sessionUser.role);
          const room = Number(roomParam);
          if (!Number.isInteger(room) || room < 0 || room >= roomCount) {
            return new NextResponse(JSON.stringify({ error: `room must be an integer 0-${roomCount - 1}` }), { status: 400 });
          }
          // A room whose only occupant's cycle has ended reports itself as
          // "empty" here too, exactly like the index (app/api/reports/rooms/
          // route.ts) — the expired report is never deleted, only no longer
          // this room's CURRENT occupant. "processing" (occupied, ai_score
          // not recorded yet) is a real, expected window, not a bug — see
          // lib/report-rooms.ts's own header comment. findRoomOccupant is
          // the same lookup app/reports/rooms/[room]/page.tsx's Server
          // Component uses, so both agree by construction.
          const occupant = await findRoomOccupant(client, sessionUser.id, room);
          return new NextResponse(JSON.stringify(occupant), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        const result = await client.execute({
          sql: `SELECT id, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_score, ai_tone
                FROM saved_reports WHERE user_id = ? ORDER BY report_created_at DESC LIMIT ?`,
          args: [sessionUser.id, MAX_LISTED_REPORTS],
        });
        rows = result.rows;
      } else {
        const url = new URL(request.url);
        const deviceKey = url.searchParams.get('deviceKey');
        if (!isNonEmptyString(deviceKey) || deviceKey.length > MAX_DEVICE_KEY_LENGTH) {
          return new NextResponse(JSON.stringify({ error: 'deviceKey is required' }), { status: 400 });
        }
        // user_id IS NULL excludes reports already claimed by an account —
        // without this, a report claimed while signed in would still be
        // visible/deletable via the raw device_key on a shared computer.
        const result = await client.execute({
          sql: `SELECT id, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_score, ai_tone
                FROM saved_reports WHERE device_key = ? AND user_id IS NULL ORDER BY report_created_at DESC LIMIT ?`,
          args: [deviceKey, MAX_LISTED_REPORTS],
        });
        rows = result.rows;
      }
    } finally {
      client.close();
    }

    const reports = rows.map((row) => ({
      id: String(row.id),
      submissionId: String(row.submission_id),
      title: String(row.title),
      createdAt: String(row.report_created_at),
      wordCount: Number(row.word_count),
      archiveScore: Number(row.archive_score),
      scoreBand: String(row.score_band),
      aiScore: row.ai_score === null ? null : Number(row.ai_score),
      aiTone: row.ai_tone === null ? null : String(row.ai_tone),
    }));

    return new NextResponse(JSON.stringify({ reports }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
