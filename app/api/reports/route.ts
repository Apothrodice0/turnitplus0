import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../lib/reports-db';
import { checkRate } from '../../../lib/rate-limit';
import { getSessionUser } from '../../../lib/auth-session';
import { captureDocumentIdentityAndFamily } from '../../../lib/document-family';
import { indexDocumentSubmissionIntoCorpus } from '../../../lib/user-submission-corpus';
import { runAfterResponse } from '../../../lib/run-after-response';

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
        sql: `SELECT 1 FROM saved_reports WHERE device_key = ? AND id = ?`,
        args: [deviceKey, id],
      });
      const isFirstSaveOfThisReport = existingReportRow.rows.length === 0;

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
        // Indexing consent defaults to false (no consent row = not opted
        // in) for a signed-in user and is always false for anonymous saves,
        // matching indexDocumentSubmissionIntoCorpus's own existing
        // SKIPPED_ANONYMOUS eligibility rule.
        const hasCorpusReuseConsent = sessionUser?.corpusReuseConsented === true;
        const reportDeviceKey = deviceKey;
        const reportId = id;
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
            // Phase E8D: activation. Reuses lib/user-submission-corpus.ts's
            // indexDocumentSubmissionIntoCorpus exactly as E8A already
            // defined it (no logic duplicated here) — the same
            // account_id != null eligibility rule that function already
            // enforces (SKIPPED_ANONYMOUS otherwise) means this call is
            // technically safe to make unconditionally, but userId is
            // checked here too so an anonymous save's log line never even
            // mentions indexing, matching this route's own existing
            // "no behavior for anonymous" discipline. Runs only after
            // identity capture above succeeded (needs its documentIdentityId)
            // and only inside this same deferred callback — see this
            // route's own already-existing comment on why runAfterResponse
            // keeps this off the response's critical path. A failure here
            // is caught separately from identity-capture failures so the
            // two are distinguishable in logs, and never re-thrown: the
            // saved report and the identity/family capture above are
            // already durable regardless of whether indexing succeeds.
            // Retry/reconciliation (this phase's own task description,
            // section 11): no queue is introduced; a document_identities
            // row with no corresponding corpus_submission_references row
            // is itself the recoverable "needs indexing" signal a future
            // maintenance pass could query for — see the E8D report's own
            // "unresolved decisions" for why that pass is not built here.
            //
            // Privacy hardening: additionally requires hasCorpusReuseConsent
            // — a signed-in user whose account has not explicitly opted in
            // (users.corpus_reuse_consented_at IS NULL, the default) is
            // never indexed into the cross-account matching corpus, exactly
            // like an anonymous submission is not. This does not change
            // indexDocumentSubmissionIntoCorpus, findCandidateCorpusRepresentations,
            // or matchAgainstUserSubmissionCorpus themselves — only whether
            // this route ever calls the entry point at all.
            if (userId !== null && hasCorpusReuseConsent) {
              const indexStartedAt = Date.now();
              try {
                const indexResult = await indexDocumentSubmissionIntoCorpus(deferredClient, {
                  documentIdentityId: captured.documentIdentityId,
                  rawText,
                });
                console.log(
                  `corpus indexing ${indexResult.status} for documentIdentity=${captured.documentIdentityId} (${Date.now() - indexStartedAt}ms)`,
                );
              } catch (err) {
                console.error(
                  `indexDocumentSubmissionIntoCorpus failed (non-fatal) for documentIdentity=${captured.documentIdentityId} (${Date.now() - indexStartedAt}ms):`,
                  err instanceof Error ? err.message : String(err),
                );
              }
            }
          } catch (err) {
            console.error('captureDocumentIdentityAndFamily failed (non-fatal):', err instanceof Error ? err.message : String(err));
          } finally {
            deferredClient.close();
          }
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
