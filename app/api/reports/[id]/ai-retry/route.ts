import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../../lib/reports-db';
import { checkRate } from '../../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../../lib/client-ip';
import { getSessionUser } from '../../../../../lib/auth-session';
import { INTERPRETATION_TO_VERIFY_SQL } from '../../../../../lib/reports-repo';
import { isEvidenceInterpretationCustomerReadable } from '../../../../../lib/report-persistence';
import { MAX_REPORT_SAVE_REQUEST_BYTES, persistedFitFromSqlBounds, persistedPayloadSize } from '../../../../../lib/report-transport-limits';
import { isCompactAiAnalysis, validateCompactAiAnalysis } from '../../../../../lib/ai-passage-table';
import { deriveRoomStatus } from '../../../../../lib/report-rooms';
import {
  AI_SAVE_OUTCOME_SIZE_UNAVAILABLE,
  AI_UNAVAILABLE_REASON_REPORT_SIZE,
  buildSizeUnavailableAiAnalysis,
  withoutClientAiUnavailableReason,
} from '../../../../../lib/ai-unavailable-state';
import { logAiSizeUnavailableTelemetry } from '../../../../../lib/ai-size-unavailable-telemetry';

/**
 * G2 — POST /api/reports/[id]/ai-retry: persist the result of a manual AI-analysis RETRY onto an
 * ALREADY-SAVED report, changing ONLY the AI half of that report.
 *
 * WHY THIS ROUTE EXISTS. A retry used to re-POST the whole report through POST /api/reports (the
 * ordinary save route). When the browser had no local copy it re-POSTed the GET-EXPANDED report —
 * `unifiedSimilarity` and `evidenceInterpretation` back in their full runtime shape — which for a
 * large report exceeds MAX_REPORT_SAVE_REQUEST_BYTES even though its compact PERSISTED form fits
 * (a deterministic 413, on a report that had saved and opened perfectly). Worse, that route treats
 * the client's copy as merely the INPUT to a full server-side re-finalization, so a retry could also
 * re-run the similarity pipeline and rewrite similarity state — which a retry (documented as "the
 * similarity result is already saved and unaffected; this only re-attempts the AI half") must not.
 *
 * WHAT IT TAKES. Only the AI result the browser just computed (the model runs in a browser Worker;
 * the server can never produce it): the flat columns (`aiStatus`, `aiScore`, `aiTone`) and the two
 * AI-owned payload fields (`payload.aiScore`, `payload.aiAnalysis`). Nothing else in the body is ever
 * read — a client that echoes a whole report (or a forged `unifiedSimilarity`, `evidenceInterpretation`,
 * `text`, `deviceKey`, owner, room …) has every one of those ignored. The request therefore scales
 * with the AI result (which lists the analysed passages), never with the similarity evidence.
 *
 * WHAT IT CHANGES. Exactly `ai_score`, `ai_tone`, `ai_status`, `payload_json.aiAnalysis`,
 * `payload_json.aiScore` and `updated_at` — via one atomic `json_set` on the CURRENT persisted payload,
 * the same primitive SAVE_REPORT_SQL already uses to merge AI fields into a retained authoritative
 * payload. The persisted similarity/evidence/completion/provenance fields, title, word count, scores,
 * room, owner and device key are never written, so a stale (or hostile) browser copy can never overwrite
 * them. Report identity, ownership and room association come from the SERVER row, found by
 * (id, session user) exactly as DELETE /api/reports/[id] does — a report owned by anyone else, an
 * anonymous/legacy row (no claim-by-retry) and a missing id are all the same generic 404.
 *
 * SAFETY PROPERTIES.
 *  - Auth: an authenticated session only (401 otherwise); ownership is never taken from the body.
 *  - R2 fail-closed: a report whose persisted evidence interpretation cannot be decoded for a customer
 *    is refused with the SAME generic 503 GET returns and is not touched at all — a retry can never
 *    "repair" it, or turn it into a normal score-bearing report.
 *  - Persisted-size ceiling: the size of the payload AFTER the merge (measured, not projected — see the G2 size policy below) is checked against
 *    MAX_REPORT_SAVE_REQUEST_BYTES (the same ceiling every other persistence check uses — not raised). Check and write
 *    share one write transaction. What happens OVER the ceiling is the G2 size policy, next.
 *  - G2 SIZE POLICY (POLICY_B_KEEP_REPORT_AI_UNAVAILABLE_FOR_SIZE, lib/ai-unavailable-state.ts). AI is enrichment on a report
 *    that is already valid; a report must not be left `processing` forever because its AI result does not fit beside it. THIS
 *    route is the one place that can decide, exactly, from the SERVER's own stored row. The question it answers is "what would
 *    the persisted report be after replacing its AI half with this candidate?" — so it asks the database: the candidate is
 *    applied inside the write transaction and the size of the ACTUAL merged payload is measured in the canonical persisted-size
 *    unit (persistedPayloadSize, lib/report-transport-limits.ts: UTF-16 code units of the serialized JSON — precisely what
 *    POST /api/reports' persisted-size checks measure). No arithmetic on separately-measured pieces: SQLite's own `length()`
 *    counts code points (an astral character is 1, not 2) and SQLite renders a bound integer-valued score as `7.0` where
 *    JSON.stringify writes `7`, so any sum of SQL lengths, JS lengths and a guessed overhead can be wrong by the number of
 *    astral characters plus a few units at the boundary. Two cheap SQL measurements (code points, UTF-8 bytes) bound the
 *    UTF-16 length from both sides and settle every ASCII payload, and every payload clearly under or over the ceiling, without
 *    moving it; only a non-ASCII payload straddling the ceiling is read back and measured in JS. Never a manuscript-length
 *    threshold, never anything the browser declares. Fits -> the real result is persisted, as always. Does not fit -> the
 *    report's similarity half is left EXACTLY as it is and a tiny, server-authored terminal state (existing `failed` +
 *    `aiAnalysis.unavailableReason:"REPORT_SIZE"`, buildSizeUnavailableAiAnalysis) is written in the same statement and
 *    answered 200 `{ ok:true, aiOutcome:"SIZE_UNAVAILABLE" }`, with one closed-allowlist log line. Consequences held here:
 *      * A stored 'ready' (or legacy complete) result is NEVER displaced — not by a failed result (LIFECYCLE-02), not by an
 *        oversized one (answered 200, nothing written).
 *      * The reason is server-authored only: an `unavailableReason` in what the browser sent is dropped at parse time (a compact
 *        table, which is validated strictly, refuses any unknown key outright — 400, nothing written), so a client can neither
 *        hide a legitimate AI result nor suppress its own Retry by claiming "too large".
 *      * Idempotent: a report already terminally size-unavailable answers 200 with the same terminal state and writes nothing
 *        for an ordinary failed result or for a result that still does not fit (a stale bundle's Retry is a wasted model run,
 *        never a 413 loop); a result that DOES fit now is persisted normally and replaces the marker.
 *      * The one remaining 413 is a marker that cannot itself fit — only a legacy row saved before POST /api/reports reserved
 *        TERMINAL_AI_RESERVE_CHARS for exactly this. A request body over the ceiling is still refused before it is read
 *        (the size of an unread body proves nothing the server could safely record).
 *  - Same AI-column semantics as SAVE_REPORT_SQL (LIFECYCLE-02): once a report is 'ready', an incoming
 *    'failed' leaves it exactly as it was.
 *  - Never scheduled: no similarity finalization, no shadow evaluation, no corpus admission, no
 *    document-identity capture runs here — none of them is part of an AI retry.
 *  - Compact AI passages (ai-compact-v1, lib/ai-passage-table.ts): a result may arrive with its per-window list as a
 *    compact table that points into the manuscript instead of a copy of every window's text (~0.08x the manuscript
 *    instead of ~2.4x — the difference between a large report's Retry fitting the ceiling and not). It is accepted
 *    whatever the client-side writer flag says (reader-first rollout: the server can never know what a stale or newer
 *    bundle was built with), but only after validation — structurally when the body is parsed, then EXACTLY against
 *    the manuscript THIS report stores, inside the write transaction (a table computed on some other text is refused
 *    400 and nothing is written). What is validated is what is persisted, as is: the table is never expanded here.
 *  - Concurrency: two near-simultaneous retries on one report race for SQLite's single write lock; the loser used to get
 *    a bare 500. Every decision above is made INSIDE the one write transaction, so re-running the whole transaction on a
 *    FRESH connection re-reads current state and lands on last-writer-wins — the outcome the old whole-report path
 *    always had. Bounded (MAX_AI_RETRY_BUSY_RETRIES, backoff + jitter); anything that is not SQLITE_BUSY is never retried.
 */

const MAX_BYTES = MAX_REPORT_SAVE_REQUEST_BYTES;
const NO_STORE_JSON = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } as const;
const MAX_TONE_LENGTH = 64;
// Same bound and backoff as insertReportWithRoomCheck in POST /api/reports (the repo's convention for this exact race —
// a Next.js route module cannot export helpers, so the small idiom is kept local here as it is in lib/corpus-admission-*).
const MAX_AI_RETRY_BUSY_RETRIES = 5;

function isSqliteBusyError(err: unknown): boolean {
  return err instanceof Error && /SQLITE_BUSY/i.test(err.message);
}

// Same generic body GET /api/reports/[id] returns for a stored report whose explanation cannot be decoded (R2).
const REPORT_UNAVAILABLE_BODY = JSON.stringify({ error: 'Report temporarily unavailable', code: 'REPORT_TEMPORARILY_UNAVAILABLE' });

function json(status: number, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  return new NextResponse(JSON.stringify(body), { status, headers: { ...NO_STORE_JSON, ...extraHeaders } });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type AiRetryRequest = {
  aiStatus: 'ready' | 'failed';
  aiScore: number | null;
  aiTone: string | null;
  rawAiScore: number | null;
  aiAnalysis: Record<string, unknown>;
};

/** Reads ONLY the five AI-owned values out of the body; anything else the client sent is never looked at again. Null = malformed. */
function parseAiRetryRequest(body: unknown): AiRetryRequest | null {
  if (!isPlainObject(body)) return null;
  const { aiStatus, aiScore, aiTone, payload } = body;
  if (aiStatus !== 'ready' && aiStatus !== 'failed') return null;
  if (aiScore !== null && (typeof aiScore !== 'number' || !Number.isFinite(aiScore))) return null;
  if (aiTone !== null && (typeof aiTone !== 'string' || aiTone.length > MAX_TONE_LENGTH)) return null;
  if (!isPlainObject(payload)) return null;
  const { aiScore: rawAiScore, aiAnalysis } = payload;
  if (rawAiScore !== null && (typeof rawAiScore !== 'number' || !Number.isFinite(rawAiScore))) return null;
  if (!isPlainObject(aiAnalysis)) return null;
  const analysisStatus = aiAnalysis.status;
  if (analysisStatus !== 'complete' && analysisStatus !== 'unsupported' && analysisStatus !== 'error') return null;
  if (aiAnalysis.passages !== undefined && !Array.isArray(aiAnalysis.passages)) return null;
  // The exact mapping the client applies (lib/reports-remote.ts / room-page-shell.tsx): only a completed analysis is 'ready'.
  if ((aiStatus === 'ready') !== (analysisStatus === 'complete')) return null;
  // ai-compact-v1: a compact table is checked structurally here (cheap, no database); the exact check against the stored
  // manuscript happens inside the write transaction below.
  if (isCompactAiAnalysis(aiAnalysis) && !validateCompactAiAnalysis(aiAnalysis).ok) return null;
  // G2 TRUST BOUNDARY: `unavailableReason` records a decision only THIS route makes (below). Whatever the browser put there —
  // a forged "too large" on a report whose real result fits, an echo of a stored marker — is dropped, so the size-unavailable
  // state can never be declared by a client.
  return { aiStatus, aiScore, aiTone, rawAiScore, aiAnalysis: withoutClientAiUnavailableReason(aiAnalysis) };
}

type ReportsDbClient = Awaited<ReturnType<typeof getReportsDbClient>>;
type ReportsTx = Awaited<ReturnType<ReportsDbClient['transaction']>>;
type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>;

/** The AI half of one write: the flat columns plus the two AI-owned payload fields. */
type AiWrite = { aiStatus: 'ready' | 'failed'; aiScore: number | null; aiTone: string | null; rawAiScore: number | null; aiAnalysisJson: string };

/**
 * Does the payload this transaction CURRENTLY holds for the report fit the persisted ceiling, measured in the canonical unit
 * (persistedPayloadSize: UTF-16 code units of the serialized JSON — exactly what POST /api/reports' persisted-size checks measure)?
 *
 * Bounded: two SQL measurements that move no payload (code points, UTF-8 bytes) bound the UTF-16 length from below and above
 * (persistedFitFromSqlBounds) and settle every ASCII payload and every payload clearly under/over the ceiling. Only a non-ASCII
 * payload whose code points are under the ceiling while its UTF-8 bytes are over it is read back, once, and measured in JS. The
 * payload is never parsed, re-serialized or decoded — compact similarity/AI evidence stays exactly as stored.
 */
async function storedPayloadFitsCeiling(tx: ReportsTx, deviceKey: string, id: string, userId: string): Promise<boolean> {
  const sized = await tx.execute({
    sql: `SELECT length(payload_json) AS code_points, length(CAST(payload_json AS BLOB)) AS utf8_bytes
            FROM saved_reports WHERE device_key = ? AND id = ? AND user_id = ?`,
    args: [deviceKey, id, userId],
  });
  const measured = sized.rows[0] as unknown as { code_points: number | bigint; utf8_bytes: number | bigint } | undefined;
  const verdict = persistedFitFromSqlBounds(Number(measured?.code_points ?? 0), Number(measured?.utf8_bytes ?? 0), MAX_BYTES);
  if (verdict !== 'AMBIGUOUS') return verdict === 'FITS';
  const text = await tx.execute({ sql: `SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ? AND user_id = ?`, args: [deviceKey, id, userId] });
  return persistedPayloadSize(String((text.rows[0] as unknown as { payload_json?: unknown } | undefined)?.payload_json ?? '')) <= MAX_BYTES;
}

/**
 * ONE attempt of the write: a write transaction on the caller's OWN connection (the same shape insertReportWithRoomCheck
 * uses) in which the ownership read, the readability / validity / size decisions and the UPDATE all see one consistent
 * row. Returns the response to send; throws only on an infrastructure error (the caller retries SQLITE_BUSY on a fresh
 * connection and turns anything else into the generic 500). Everything it does is idempotent up to its commit.
 */
async function persistAiRetry(txClient: ReportsDbClient, sessionUser: SessionUser, id: string, retry: AiRetryRequest): Promise<NextResponse> {
  const tx = await txClient.transaction('write');
  try {
    // Ownership from the session, never the body — id + user_id, exactly like DELETE /api/reports/[id]. The
    // device key is read back from the row rather than trusted from the client.
    const found = await tx.execute({
      sql: `SELECT device_key, ai_status, ai_score,
                   json_extract(payload_json, '$.aiAnalysis.unavailableReason') AS stored_unavailable_reason,
                   ${INTERPRETATION_TO_VERIFY_SQL} AS interpretation_to_verify
            FROM saved_reports WHERE id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 1`,
      args: [id, sessionUser.id],
    });
    const row = found.rows[0] as unknown as
      | { device_key: string; ai_status: string | null; ai_score: number | bigint | null; stored_unavailable_reason: string | null; interpretation_to_verify: string | null }
      | undefined;
    if (!row) {
      await tx.rollback().catch(() => {});
      return json(404, { error: 'Report not found' });
    }

    // R2 — the same readability decision GET (owner) and the room poll use, from the same decoder. An unreadable
    // report is refused untouched: never "repaired" from anything the browser holds.
    if (!isEvidenceInterpretationCustomerReadable(row.interpretation_to_verify)) {
      await tx.rollback().catch(() => {});
      return new NextResponse(REPORT_UNAVAILABLE_BODY, { status: 503, headers: NO_STORE_JSON });
    }

    // LIFECYCLE-02 parity with SAVE_REPORT_SQL: a genuine 'ready' result is never displaced by a late 'failed' one.
    if (row.ai_status === 'ready' && retry.aiStatus === 'failed') {
      await tx.rollback().catch(() => {});
      return json(200, { ok: true });
    }

    // G2 — what the stored row already IS, from the server's own row. "Ready" is the repo's own derived definition
    // (a legacy row with no ai_status but a score is complete too), so the size policy can never displace a legitimate result.
    const storedIsReady = deriveRoomStatus(row.ai_score === null ? null : Number(row.ai_score), row.ai_status) === 'ready';
    const storedIsSizeUnavailable = row.ai_status === 'failed' && row.stored_unavailable_reason === AI_UNAVAILABLE_REASON_REPORT_SIZE;
    // Already terminally "AI unavailable for this document": an ordinary failure adds nothing and must not erase that
    // determination (a stale bundle's Retry that failed again) — idempotent, the same terminal answer, nothing written.
    if (storedIsSizeUnavailable && retry.aiStatus === 'failed') {
      await tx.rollback().catch(() => {});
      return json(200, { ok: true, aiOutcome: AI_SAVE_OUTCOME_SIZE_UNAVAILABLE });
    }

    // ai-compact-v1: a compact table is only valid for the exact manuscript it was computed on — check it against the one
    // THIS report stores (length + hash, and every range/layout rule), read in the same transaction as the write.
    //
    // The stored manuscript is read by parsing the payload IN JAVASCRIPT — exactly as GET decodes it — and NOT with SQL
    // `json_extract(payload_json, '$.text')`: SQLite holds the full string, but the driver hands a TEXT value containing an
    // embedded NUL back to JS truncated at the NUL (a manuscript extracted from a PDF can legitimately contain U+0000; one
    // real 1M-character document did, at index 873,772, and every compact Retry on it was refused). One extra read of a
    // payload that is at most MAX_BYTES, on a rare manual action that only ever carries a compact table.
    if (isCompactAiAnalysis(retry.aiAnalysis)) {
      const stored = await tx.execute({
        sql: `SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ? AND user_id = ?`,
        args: [row.device_key, id, sessionUser.id],
      });
      let storedText: unknown = null;
      try {
        storedText = (JSON.parse(String((stored.rows[0] as unknown as { payload_json?: unknown } | undefined)?.payload_json)) as { text?: unknown }).text;
      } catch {
        storedText = null;
      }
      if (typeof storedText !== 'string' || !validateCompactAiAnalysis(retry.aiAnalysis, { text: storedText }).ok) {
        await tx.rollback().catch(() => {});
        return json(400, { error: 'Invalid AI result' });
      }
    }

    // G2 — THE EXACT SIZE DECISION, in the canonical persisted-size unit (see the header): apply the candidate inside this write
    // transaction, then measure the payload the report WOULD have. Nothing is committed until it is known to fit.
    const applyWrite = (w: AiWrite) =>
      tx.execute({
        sql: `UPDATE saved_reports
                 SET ai_score = ?, ai_tone = ?, ai_status = ?,
                     payload_json = json_set(payload_json, '$.aiAnalysis', json(?), '$.aiScore', ?),
                     updated_at = CURRENT_TIMESTAMP
               WHERE device_key = ? AND id = ? AND user_id = ?`,
        args: [w.aiScore, w.aiTone, w.aiStatus, w.aiAnalysisJson, w.rawAiScore, row.device_key, id, sessionUser.id],
      });
    let sizeUnavailable = false;
    await applyWrite({ aiStatus: retry.aiStatus, aiScore: retry.aiScore, aiTone: retry.aiTone, rawAiScore: retry.rawAiScore, aiAnalysisJson: JSON.stringify(retry.aiAnalysis) });
    if (!(await storedPayloadFitsCeiling(tx, row.device_key, id, sessionUser.id))) {
      // The real result cannot be stored next to this report. Never at the expense of a legitimate stored result, and never as
      // a 413 the customer could only hit again: a stored 'ready' stays exactly as it is; a report already marked keeps its mark.
      // (Rolling back discards the tentative write above: the row is exactly as it was.)
      if (storedIsReady || storedIsSizeUnavailable) {
        await tx.rollback().catch(() => {});
        return json(200, storedIsSizeUnavailable ? { ok: true, aiOutcome: AI_SAVE_OUTCOME_SIZE_UNAVAILABLE } : { ok: true });
      }
      // Replace the tentative candidate with the server-authored marker (same statement, same transaction, still uncommitted) and
      // measure THAT the same way — the marker is held to exactly the same unit and rule as any other result.
      await applyWrite({ aiStatus: 'failed', aiScore: null, aiTone: 'unavailable', rawAiScore: null, aiAnalysisJson: JSON.stringify(buildSizeUnavailableAiAnalysis()) });
      // Only a legacy row saved before the first-save reserve can be too full for even the marker: the unchanged 413.
      if (!(await storedPayloadFitsCeiling(tx, row.device_key, id, sessionUser.id))) {
        await tx.rollback().catch(() => {});
        return json(413, { error: 'Payload too large' });
      }
      sizeUnavailable = true;
    }
    await tx.commit();
    if (sizeUnavailable) {
      logAiSizeUnavailableTelemetry();
      return json(200, { ok: true, aiOutcome: AI_SAVE_OUTCOME_SIZE_UNAVAILABLE });
    }
    return json(200, { ok: true });
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  } finally {
    tx.close();
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const rate = await checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return json(429, { error: 'Too many requests' }, { 'Retry-After': String(rate.retryAfter) });
    }

    const contentLength = request.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_BYTES) return json(413, { error: 'Payload too large' });

    const { id } = await params;
    if (!isNonEmptyString(id)) return json(400, { error: 'id is required' });

    // Also enforced on the body actually read, for a client that omits Content-Length (chunked).
    const rawBody = await request.text().catch(() => null);
    if (rawBody === null) return json(400, { error: 'Invalid JSON' });
    if (rawBody.length > MAX_BYTES) return json(413, { error: 'Payload too large' });
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return json(400, { error: 'Invalid JSON' });
    }
    const retry = parseAiRetryRequest(parsedBody);
    if (!retry) return json(400, { error: 'Invalid AI result' });

    const client = await getReportsDbClient();
    try {
      const sessionUser = await getSessionUser(request, client);
      if (!sessionUser) return json(401, { error: 'Log in to continue.' });

      // The write transaction runs on its OWN connection, a FRESH one per attempt (lib/reports-db.ts: busy_timeout does
      // not help with this driver — only a new connection recovers from a lost write-lock race). Bounded, with backoff +
      // jitter; the final attempt's error, or any error that is not SQLITE_BUSY, propagates to the generic 500 below.
      for (let attempt = 1; ; attempt += 1) {
        const txClient = await getReportsDbClient();
        try {
          return await persistAiRetry(txClient, sessionUser, id, retry);
        } catch (err) {
          if (!isSqliteBusyError(err) || attempt >= MAX_AI_RETRY_BUSY_RETRIES) throw err;
          await new Promise((resolve) => setTimeout(resolve, 30 * attempt + Math.floor(Math.random() * 30)));
        } finally {
          txClient.close();
        }
      }
    } finally {
      client.close();
    }
  } catch {
    // Generic and truthful — never an internal Error.message (see POST /api/reports' own catch for why).
    return json(500, { error: 'Unable to save the AI result. Please try again.' });
  }
}
