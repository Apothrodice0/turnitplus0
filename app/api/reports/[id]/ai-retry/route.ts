import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../../lib/reports-db';
import { checkRate } from '../../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../../lib/client-ip';
import { getSessionUser } from '../../../../../lib/auth-session';
import { INTERPRETATION_TO_VERIFY_SQL } from '../../../../../lib/reports-repo';
import { isEvidenceInterpretationCustomerReadable } from '../../../../../lib/report-persistence';
import { MAX_REPORT_SAVE_REQUEST_BYTES } from '../../../../../lib/report-transport-limits';
import { isCompactAiAnalysis, validateCompactAiAnalysis } from '../../../../../lib/ai-passage-table';

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
 *  - Persisted-size ceiling: the projected size of the payload after the merge is checked against
 *    MAX_REPORT_SAVE_REQUEST_BYTES (the same ceiling every other persistence check uses — not raised);
 *    over it, 413 and nothing is written. Check and write share one write transaction.
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
// The JSON keys/punctuation a first-time `aiAnalysis` + `aiScore` add to a payload that has neither yet.
const MERGE_OVERHEAD_CHARS = 64;
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
  return { aiStatus, aiScore, aiTone, rawAiScore, aiAnalysis };
}

type ReportsDbClient = Awaited<ReturnType<typeof getReportsDbClient>>;
type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>;

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
      sql: `SELECT device_key, ai_status,
                   length(payload_json) AS payload_chars,
                   length(json_extract(payload_json, '$.aiAnalysis')) AS existing_ai_chars,
                   ${INTERPRETATION_TO_VERIFY_SQL} AS interpretation_to_verify
            FROM saved_reports WHERE id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 1`,
      args: [id, sessionUser.id],
    });
    const row = found.rows[0] as unknown as
      | { device_key: string; ai_status: string | null; payload_chars: number | bigint; existing_ai_chars: number | bigint | null; interpretation_to_verify: string | null }
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

    const aiAnalysisJson = JSON.stringify(retry.aiAnalysis);
    const projectedChars = Number(row.payload_chars) - Number(row.existing_ai_chars ?? 0) + aiAnalysisJson.length + MERGE_OVERHEAD_CHARS;
    if (projectedChars > MAX_BYTES) {
      await tx.rollback().catch(() => {});
      return json(413, { error: 'Payload too large' });
    }

    await tx.execute({
      sql: `UPDATE saved_reports
               SET ai_score = ?, ai_tone = ?, ai_status = ?,
                   payload_json = json_set(payload_json, '$.aiAnalysis', json(?), '$.aiScore', ?),
                   updated_at = CURRENT_TIMESTAMP
             WHERE device_key = ? AND id = ? AND user_id = ?`,
      args: [retry.aiScore, retry.aiTone, retry.aiStatus, aiAnalysisJson, retry.rawAiScore, row.device_key, id, sessionUser.id],
    });
    await tx.commit();
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
