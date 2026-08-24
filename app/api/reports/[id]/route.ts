import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate, checkReadRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { getSessionUser } from '../../../../lib/auth-session';
import { findReportRowForDeviceKey, findReportRowForUser } from '../../../../lib/reports-repo';
import { classifyReportMatches } from '../../../../lib/report-classification';
import { deleteHistoricalMatchSnapshot } from '../../../../lib/report-historical-match';
import { resolvePrimarySimilaritySummary } from '../../../../lib/report-primary-similarity';
import { deleteReportDocumentData } from '../../../../lib/report-deletion';
import { deleteReportCorpusAdmissionData } from '../../../../lib/corpus-admission-report-integration';
import { runHistoricalMatchShadowEvaluation } from '../../../../lib/e8p-shadow-evaluation';
import { getExperimentalHistoricalMatchForDisplay } from '../../../../lib/e8p-visibility';
import { getReuseContextEligibility } from '../../../../lib/e8s-report-integration';
import { runAfterResponse } from '../../../../lib/run-after-response';
import type { SimilarityReport } from '../../../../lib/report-types';

const MAX_DEVICE_KEY_LENGTH = 200;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const rate = await checkReadRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const { id } = await params;
    if (!isNonEmptyString(id)) return new NextResponse(JSON.stringify({ error: 'id is required' }), { status: 400 });

    const client = await getReportsDbClient();
    let row;
    let payload: SimilarityReport | undefined;
    try {
      const sessionUser = await getSessionUser(request, client);
      const accountId = sessionUser ? sessionUser.id : null;
      if (sessionUser) {
        row = await findReportRowForUser(client, id, sessionUser.id);
      } else {
        const url = new URL(request.url);
        const deviceKey = url.searchParams.get('deviceKey');
        if (!isNonEmptyString(deviceKey) || deviceKey.length > MAX_DEVICE_KEY_LENGTH) {
          return new NextResponse(JSON.stringify({ error: 'deviceKey is required' }), { status: 400 });
        }
        row = await findReportRowForDeviceKey(client, id, deviceKey);
      }

      if (!row) {
        return new NextResponse(JSON.stringify({ error: 'Report not found' }), { status: 404 });
      }

      payload = JSON.parse(String(row.payload_json)) as SimilarityReport;
      // Release-hardening audit finding UI-01 (corrected): matchClassification
      // reveals that a real prior submission exists (possibly under a
      // different account) — information this product has never otherwise
      // surfaced to an ordinary user, even the report's own owner. Gated
      // strictly on the AUTHENTICATED session's own `role` column
      // (sessionUser, resolved server-side above from the session cookie —
      // never ADMIN_EMAIL, a query/header value, or anything else a client
      // could set) so only a real admin session ever receives this field in
      // the response at all. For every other viewer this block never runs,
      // so payload.matchClassification is simply never assigned —
      // JSON.stringify drops an unset key entirely (see
      // ReportMatchClassification's own comment), so there is nothing for a
      // non-admin to find in the response body, HTML, or React payload; this
      // is not a client-side hide. Deliberately does not gate
      // lib/document-family.ts's captureDocumentIdentityAndFamily (save-time
      // capture, unconditional, untouched by this file) or
      // classifyReportMatches itself (still fully callable/correct — see
      // this route's own tests) — only whether THIS response ever calls it
      // for a non-admin viewer, so the underlying signal stays available for
      // a later corpus-enhanced-similarity phase to consume directly from
      // the database rather than through this admin-only debug view.
      if (sessionUser?.role === 'admin') {
        try {
          payload.matchClassification = await classifyReportMatches(client, { rawText: payload.text, accountId });
        } catch (err) {
          console.error('classifyReportMatches failed (non-fatal):', err instanceof Error ? err.message : String(err));
        }
      }
      // Phase E8C: same read-time-enrichment discipline as Phase D just
      // above, and the same non-fatal guarantee — see
      // lib/report-historical-match.ts's own header comment. This one is
      // already internally best-effort (it persists a "FAILED" snapshot
      // rather than throwing), so this try/catch is a second, outer safety
      // net for anything unexpected (e.g. a database error on the snapshot
      // read/write itself), not the primary error handling.
      try {
        // Release-hardening audit finding SIM-02: getOrComputeHistoricalMatchSnapshot
        // + computeUnifiedSimilarity now run through the ONE shared
        // lib/report-primary-similarity.ts helper — the same call
        // lib/reports-repo.ts's findRoomOccupant makes for the room card, so
        // the two surfaces can never disagree. Never touches
        // payload.score/archiveScore/aiScore/E8S/E8P — see
        // lib/unified-similarity.ts's own DECISION 3.
        const resolution = await resolvePrimarySimilaritySummary(client, {
          reportDeviceKey: row.device_key,
          reportId: id,
          accountId,
          rawText: payload.text,
          wordCount: payload.wordCount,
          archiveMatchedPositions: payload.archiveMatchedPositions,
          externalAcademicEvidence: payload.externalAcademicEvidence,
          archiveScore: payload.archiveScore ?? payload.score,
        });
        const historicalSubmissionMatch = resolution.historicalSubmissionMatch;
        payload.historicalSubmissionMatch = historicalSubmissionMatch;
        if (resolution.unifiedSimilarity) {
          payload.unifiedSimilarity = resolution.unifiedSimilarity;
          payload.corpusSourceMatchingEnabledAtComputation = resolution.corpusSourceMatchingEnabled;
          payload.unifiedSimilarityGeneration = resolution.corpusGeneration;
          // Release-hardening audit finding SIM-04: "after the resolver
          // recomputes, persist the refreshed result so room and detail
          // agree." resolvePrimarySimilaritySummary above is cache-first —
          // this write is therefore cheap on the common case (the freshly
          // resolved generation already equals what is stored, so the
          // WHERE clause's own comparison skips the write entirely) and
          // only actually lands a new row when something genuinely
          // changed. Guarded the identical way SAVE_REPORT_SQL's own
          // generation CASE is (app/api/reports/route.ts) — never let an
          // older-generation result stored here regress a newer one a
          // concurrent request already persisted; COALESCE(...,-1) treats
          // "never persisted a generation" as lower than any real one, so
          // the very first successful resolution always writes. Deferred
          // outside this response's own critical path would reintroduce
          // exactly the ordering gap SIM-03's own header comment already
          // rejected runAfterResponse for — so, like write-time
          // finalization itself, this stays synchronous and awaited.
          // Built from the ORIGINAL stored JSON string, re-parsed fresh —
          // never from the in-memory `payload` object this response is
          // building, which may already carry matchClassification
          // (admin-only, see the block above — must never be persisted;
          // it is recomputed fresh on every admin read by design) and
          // will go on to carry experimentalHistoricalMatch/reuseContext
          // (read-time-only display fields, never meant to be durable
          // either). This keeps the persisted row's shape identical to
          // what a normal save already writes, plus only the three
          // similarity fields this fix adds.
          try {
            const persistedPayload = {
              ...(JSON.parse(String(row.payload_json)) as SimilarityReport),
              unifiedSimilarity: resolution.unifiedSimilarity,
              corpusSourceMatchingEnabledAtComputation: resolution.corpusSourceMatchingEnabled,
              unifiedSimilarityGeneration: resolution.corpusGeneration,
            };
            await client.execute({
              sql: `UPDATE saved_reports SET payload_json = ?
                    WHERE device_key = ? AND id = ?
                      AND COALESCE(json_extract(payload_json, '$.unifiedSimilarityGeneration'), -1) <= ?`,
              args: [JSON.stringify(persistedPayload), row.device_key, id, resolution.corpusGeneration],
            });
          } catch (err) {
            console.error('persisting the refreshed similarity result failed (non-fatal, this response still reflects it):', err instanceof Error ? err.message : String(err));
          }
        }
        // Phase E8P.3: the experimental, allowlist-gated display value — see
        // lib/e8p-visibility.ts's own header comment. Synchronous (unlike the
        // shadow telemetry write below) because it must be part of THIS
        // response to render at all; isE8pVisibilityAllowlisted() is checked
        // first inside that function and returns instantly for every
        // non-allowlisted account, so this is a no-op for ordinary traffic.
        // Never throws past this function; best-effort exactly like
        // historicalSubmissionMatch's own read-time enrichment above.
        payload.experimentalHistoricalMatch = await getExperimentalHistoricalMatchForDisplay(client, {
          accountId,
          rawText: payload.text,
          productionResult: historicalSubmissionMatch,
        }) ?? undefined;
        // Phase E8S Step 11: same read-time-enrichment/non-fatal discipline
        // as experimentalHistoricalMatch just above — see
        // lib/e8s-report-integration.ts's own header comment. Never decides
        // what renders; only tells the client which ids (if any) to fetch
        // fresh E8S state for.
        payload.reuseContext = await getReuseContextEligibility(client, {
          accountId,
          rawText: payload.text,
          historicalSubmissionMatch,
        });
        // Phase E8P: production shadow evaluation — measurement only, never
        // changes historicalSubmissionMatch above (already resolved and
        // reused as-is, never recomputed). Deferred via runAfterResponse,
        // same pattern as app/api/reports/route.ts's own corpus-indexing
        // callback, with its own DB connection since `client` here is closed
        // in `finally` before after() fires. Best-effort by construction
        // (lib/e8p-shadow-evaluation.ts never throws), so no try/catch needed
        // around this call itself. Plain local values (not `payload`) are
        // captured into the closure to keep it independent of the outer
        // request's own object.
        const deviceKeyForShadow = row.device_key;
        const rawTextForShadow = payload.text;
        await runAfterResponse(async () => {
          const deferredClient = await getReportsDbClient();
          try {
            await runHistoricalMatchShadowEvaluation(deferredClient, {
              reportDeviceKey: deviceKeyForShadow,
              reportId: id,
              accountId,
              rawText: rawTextForShadow,
              productionResult: historicalSubmissionMatch,
            });
          } finally {
            deferredClient.close();
          }
        });
      } catch (err) {
        console.error('resolvePrimarySimilaritySummary failed (non-fatal):', err instanceof Error ? err.message : String(err));
      }
    } finally {
      client.close();
    }

    return new NextResponse(JSON.stringify({ payload }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const rate = await checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const { id } = await params;
    if (!isNonEmptyString(id)) return new NextResponse(JSON.stringify({ error: 'id is required' }), { status: 400 });

    const client = await getReportsDbClient();
    try {
      const sessionUser = await getSessionUser(request, client);
      if (sessionUser) {
        // Phase E8C: report_historical_match_snapshots has no DB-level
        // FOREIGN KEY (see db/schema.ts's own comment on that table), so its
        // cleanup is this explicit lookup-then-delete instead of an
        // automatic CASCADE. deviceKey is looked up here rather than
        // trusted from the client, matching this route's existing
        // authorization discipline (id + user_id both required either way).
        // document_identity_id is looked up the same way, for the same
        // ownership-verified reason, so a report's own identity/shingle/
        // family/corpus data (see lib/report-deletion.ts) can be cleaned up
        // too, not just its saved_reports row and match snapshot.
        const owned = await client.execute({
          sql: 'SELECT device_key, document_identity_id FROM saved_reports WHERE id = ? AND user_id = ?',
          args: [id, sessionUser.id],
        });
        const deviceKey = owned.rows[0]?.device_key;
        const documentIdentityId = owned.rows[0]?.document_identity_id;
        if (deviceKey) await deleteHistoricalMatchSnapshot(client, { reportDeviceKey: String(deviceKey), reportId: id });
        await client.execute({
          sql: 'DELETE FROM saved_reports WHERE id = ? AND user_id = ?',
          args: [id, sessionUser.id],
        });
        if (documentIdentityId) await deleteReportDocumentData(client, String(documentIdentityId));
        // Corpus-admission cleanup: scoped directly to (account, deviceKey,
        // report id) — see lib/corpus-admission-report-integration.ts's own
        // comment for why this is deliberately independent of
        // documentIdentityId, so it can never reach a different report's
        // retained admission data, including another report owned by this
        // same account. Runs even when deviceKey/documentIdentityId above
        // were never set (e.g. this report predates that column) — the
        // corpus-admission source_ref is deterministic from (id, user_id)
        // alone once deviceKey is known, and a report deleted here always
        // has its own device_key from the SELECT above by construction.
        if (deviceKey) await deleteReportCorpusAdmissionData(client, { accountId: sessionUser.id, deviceKey: String(deviceKey), reportId: id });
      } else {
        const url = new URL(request.url);
        const deviceKey = url.searchParams.get('deviceKey');
        if (!isNonEmptyString(deviceKey) || deviceKey.length > MAX_DEVICE_KEY_LENGTH) {
          return new NextResponse(JSON.stringify({ error: 'deviceKey is required' }), { status: 400 });
        }
        const owned = await client.execute({
          sql: 'SELECT document_identity_id FROM saved_reports WHERE device_key = ? AND id = ? AND user_id IS NULL',
          args: [deviceKey, id],
        });
        const documentIdentityId = owned.rows[0]?.document_identity_id;
        await deleteHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId: id });
        await client.execute({
          sql: 'DELETE FROM saved_reports WHERE device_key = ? AND id = ? AND user_id IS NULL',
          args: [deviceKey, id],
        });
        if (documentIdentityId) await deleteReportDocumentData(client, String(documentIdentityId));
      }
    } finally {
      client.close();
    }

    return new NextResponse(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
