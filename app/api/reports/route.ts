import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../lib/reports-db';
import { checkRate } from '../../../lib/rate-limit';
import { getSessionUser } from '../../../lib/auth-session';

// Reports carry derived data (AI passages, matched phrases, extracted text)
// on top of the ingest pipeline's raw text, so this cap is larger than
// /api/ingest's 200KB — sized generously pending real-world calibration.
const MAX_BYTES = 2_000_000;
const MAX_DEVICE_KEY_LENGTH = 200;
const MAX_LISTED_REPORTS = 50;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function clientIpFrom(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  return forwarded.split(',')[0].trim();
}

export async function POST(request: Request) {
  try {
    const rate = checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const contentLength = request.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_BYTES) {
      return new NextResponse(JSON.stringify({ error: 'Payload too large' }), { status: 413 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return new NextResponse(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });

    const { deviceKey, id, submissionId, title, createdAt, wordCount, archiveScore, scoreBand, aiScore, aiTone, payload } = body as Record<string, unknown>;

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
    if (payload === undefined) return new NextResponse(JSON.stringify({ error: 'payload is required' }), { status: 400 });

    const payloadJson = JSON.stringify(payload);
    if (payloadJson.length > MAX_BYTES) {
      return new NextResponse(JSON.stringify({ error: 'Payload too large' }), { status: 413 });
    }

    const client = await getReportsDbClient();
    try {
      const sessionUser = await getSessionUser(request, client);
      const userId = sessionUser ? sessionUser.id : null;
      await client.execute({
        sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_score, ai_tone, payload_json, user_id, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
              ON CONFLICT(device_key, id) DO UPDATE SET
                submission_id = excluded.submission_id,
                title = excluded.title,
                report_created_at = excluded.report_created_at,
                word_count = excluded.word_count,
                archive_score = excluded.archive_score,
                score_band = excluded.score_band,
                ai_score = excluded.ai_score,
                ai_tone = excluded.ai_tone,
                payload_json = excluded.payload_json,
                user_id = COALESCE(excluded.user_id, saved_reports.user_id),
                updated_at = CURRENT_TIMESTAMP`,
        args: [id, deviceKey, submissionId, title, createdAt, wordCount, archiveScore, scoreBand, aiScore ?? null, aiTone ?? null, payloadJson, userId],
      });
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
    const rate = checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const client = await getReportsDbClient();
    let rows;
    try {
      const sessionUser = await getSessionUser(request, client);
      if (sessionUser) {
        // Authenticated: cross-device list, scoped by account rather than
        // by whichever browser happens to be asking.
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
