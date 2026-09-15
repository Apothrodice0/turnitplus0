import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkAuthRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { runSelectiveCorpusShadowEvaluation } from '../../../../lib/selective-corpus/shadow-evaluation';
import {
  claimStaleSelectiveCorpusAuthoritativePendingReports,
  finalizeSelectiveCorpusAuthoritativeReport,
} from '../../../../lib/selective-corpus-authoritative';

/**
 * Selective Corpus V4 AUTHORITATIVE PROMOTION — durability backstop.
 *
 * runAfterResponse (the deferred POST-triggered path) is best-effort, backed
 * by Vercel's waitUntil in production — it is NOT a durable queue (see
 * lib/run-after-response.ts's own header comment). If that deferred callback
 * never starts, is killed mid-flight, or throws before finalizing, a report
 * persisted as selectiveCorpusAuthoritativeStatus:"pending" would otherwise
 * stay pending forever, since GET is deliberately guarded to never resolve
 * it either (see lib/report-primary-similarity.ts's selfHealUnifiedSimilarity
 * short-circuit). This route is the recovery mechanism: a scheduled sweep
 * that atomically claims genuinely stale-pending reports and finalizes them
 * exactly once, using the SAME canonical finalizer the deferred path uses —
 * never a second implementation.
 *
 * Directly modeled on app/api/internal/corpus-admission-sweep/route.ts —
 * same CRON_SECRET bearer-token auth, same fail-closed-404 discipline, same
 * checkAuthRate limiter, same GET+POST dual handler (Vercel Cron always
 * issues GET; POST is available for any other trusted internal caller with
 * the same secret). Reuses the ALREADY-CONFIGURED CRON_SECRET — no new
 * secret is created or required.
 */

/**
 * Release-hardening audit finding (DB transport-timeout audit): bounds every
 * underlying libSQL HTTP request this route's DB client(s) make — a
 * DIFFERENT, independent concern from lib/user-submission-matching.ts's own
 * dbQueryTimeoutMs (1500ms, deliberately unchanged by this constant), which
 * is a semantic "how long is the matcher willing to wait for the whole
 * candidate-discovery operation" product decision made of several HTTP
 * requests, not a transport-level bound on any ONE of them.
 *
 * 4000ms, fixed, not env-configurable, opt-in only via
 * getReportsDbClient({ requestTimeoutMs }) — see that function's own
 * comment. Evidence (release-hardening audit, DB transport-timeout turns):
 * measured real HTTP round trips against Preview (SELECT 1 max 386.61ms;
 * a real application read max 106.70ms) and two user-approved Production
 * COUNT(*) queries (corpus_document_representations 467.33ms;
 * corpus_document_shingles 1388.36ms) — all comfortably inside 4000ms.
 * Production's current corpus scale (365 representations / 185,053 shingle
 * rows) sits far below the code-documented ~8,000-representation /
 * ~11.8M-shingle calibration point where the matcher's own 1500ms deadline
 * is known to be exercised — evidence about risk proximity, not a proof this
 * transport bound can never be hit, hence a materially larger margin here
 * than the semantic deadline it deliberately does not touch.
 */
const SELECTIVE_CORPUS_DB_REQUEST_TIMEOUT_MS = 4000;

function isAuthorizedSweepRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = request.headers.get('authorization');
  const prefix = 'Bearer ';
  if (!header || !header.startsWith(prefix)) return false;
  const provided = header.slice(prefix.length);

  const providedBuf = Buffer.from(provided);
  const secretBuf = Buffer.from(secret);
  if (providedBuf.length !== secretBuf.length) return false;
  return timingSafeEqual(providedBuf, secretBuf);
}

type ReportTextRow = { user_id: string | null; text: string | null };

async function handleSweepRequest(request: Request): Promise<Response> {
  try {
    const rate = await checkAuthRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    if (!isAuthorizedSweepRequest(request)) {
      return new NextResponse(null, { status: 404 });
    }

    const client = await getReportsDbClient({ requestTimeoutMs: SELECTIVE_CORPUS_DB_REQUEST_TIMEOUT_MS });
    try {
      // Atomic claim — see lib/selective-corpus-authoritative.ts's own header
      // comment for exactly why this must be a real write transaction, and
      // why it uses SQLite's own datetime('now', ...) rather than a
      // JS-computed threshold.
      const claimed = await claimStaleSelectiveCorpusAuthoritativePendingReports({
        openConnection: () => getReportsDbClient({ requestTimeoutMs: SELECTIVE_CORPUS_DB_REQUEST_TIMEOUT_MS }),
      });

      const outcomeSummary: Record<string, number> = {};
      for (const report of claimed) {
        try {
          const row = await client.execute({
            sql: `SELECT user_id, json_extract(payload_json, '$.text') AS text FROM saved_reports WHERE device_key = ? AND id = ?`,
            args: [report.reportDeviceKey, report.reportId],
          });
          const raw = row.rows[0] as unknown as ReportTextRow | undefined;
          if (!raw || typeof raw.text !== 'string') {
            outcomeSummary['row-missing'] = (outcomeSummary['row-missing'] ?? 0) + 1;
            continue;
          }
          const accountId = raw.user_id ?? null;

          // Only Selective Corpus itself runs here — the sibling shadow
          // evaluators (historical-match, device-provenance, corpus-
          // duplicate-suppression, PMC-coverage) already ran (or will run
          // via their own existing triggers) for this report independently;
          // this sweep exists solely to recover an abandoned V4 AUTHORITATIVE
          // finalization, never to re-run unrelated telemetry.
          const shadowResult = await runSelectiveCorpusShadowEvaluation({
            reportId: report.reportId,
            rawText: raw.text,
            authoritativeUnifiedSimilarity: null,
            // See this option's own doc comment in lib/selective-corpus/
            // shadow.ts — only this sweep and the deferred POST-triggered
            // finalizer may ever set it true.
            requiredForAuthoritativePendingReport: true,
          });

          const result = await finalizeSelectiveCorpusAuthoritativeReport(client, {
            reportDeviceKey: report.reportDeviceKey,
            reportId: report.reportId,
            accountId,
            shadowResult,
          });
          outcomeSummary[result.outcome] = (outcomeSummary[result.outcome] ?? 0) + 1;
        } catch (err) {
          // Best-effort, per-report — one report's unexpected failure must
          // never abort the rest of the claimed batch. The report itself
          // remains claimed until the claim ages past the stale-claim
          // threshold, at which point a later sweep run reclaims and retries
          // it — never a permanent lease.
          outcomeSummary['unexpected-error'] = (outcomeSummary['unexpected-error'] ?? 0) + 1;
          console.error(
            'selective-corpus-authoritative-sweep: unexpected error finalizing a claimed report (non-fatal, remaining claimed reports still processed):',
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      return new NextResponse(
        JSON.stringify({ ok: true, claimedCount: claimed.length, outcomeSummary }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    } finally {
      client.close();
    }
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}

export async function GET(request: Request) {
  return handleSweepRequest(request);
}

export async function POST(request: Request) {
  return handleSweepRequest(request);
}
