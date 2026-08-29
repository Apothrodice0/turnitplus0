import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate, checkReadRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { getSessionUser } from '../../../../lib/auth-session';
import { findReportRowForDeviceKey, findReportRowForUser } from '../../../../lib/reports-repo';
import { classifyReportMatches } from '../../../../lib/report-classification';
import { deleteHistoricalMatchSnapshot } from '../../../../lib/report-historical-match';
import { resolvePrimarySimilaritySummary, persistRefreshedSimilarity } from '../../../../lib/report-primary-similarity';
import { deleteReportDocumentData } from '../../../../lib/report-deletion';
import { deleteReportCorpusAdmissionData } from '../../../../lib/corpus-admission-report-integration';
import { scheduleReportShadowEvaluations } from '../../../../lib/report-shadow-evaluations';
import { getExperimentalHistoricalMatchForDisplay } from '../../../../lib/e8p-visibility';
import { getReuseContextEligibility } from '../../../../lib/e8s-report-integration';
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
      // Task A correction: an explicit, unconditional authorization signal —
      // set here, once, directly from the authenticated session's own real
      // `role` column, independent of whether any admin-only DATA field
      // below (matchClassification, historicalSubmissionMatch) actually
      // ends up populated. Detailed source-channel/debug UI must gate on
      // THIS field, never on the presence of a data field that could be
      // absent for an admin too (e.g. a report with no historical match at
      // all) — see SimilarityReport's own comment.
      payload.viewerIsAdmin = sessionUser?.role === 'admin';
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
        // Release-hardening audit finding UI-02: historicalSubmissionMatch
        // carries the same class of internal diagnostic information as
        // matchClassification just above (relationshipType,
        // matchedRepresentationId, matcher/fingerprint/canonicalization
        // versions, raw passage text) — never previously gated at all, so
        // every viewer of their own report, ordinary or not, received it in
        // the raw JSON response. Gated here the identical way: the
        // AUTHENTICATED session's own `role` column, decided server-side,
        // before this field is ever assigned onto `payload` — for every
        // other viewer it is simply never set, so there is nothing on the
        // response to strip or hide, matching matchClassification's own
        // comment above. The local `historicalSubmissionMatch` variable
        // itself stays fully populated regardless of role — it is still the
        // required input to computeUnifiedSimilarity above (already run,
        // via resolution) and to experimentalHistoricalMatch/reuseContext/
        // the shadow-evaluation callback below; only whether it is ever
        // SERIALIZED onto `payload` for THIS response is role-gated.
        if (sessionUser?.role === 'admin') {
          payload.historicalSubmissionMatch = historicalSubmissionMatch;
        }
        if (resolution.unifiedSimilarity) {
          payload.unifiedSimilarity = resolution.unifiedSimilarity;
          payload.corpusSourceMatchingEnabledAtComputation = resolution.corpusSourceMatchingEnabled;
          payload.unifiedSimilarityGeneration = resolution.corpusGeneration;
          payload.unifiedSimilarityFailed = false;
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
          // Fresh-report aiAnalysis-loss fix (Room 5): persistRefreshedSimilarity
          // applies json_set to only the four similarity-owned keys of the
          // row's CURRENT payload_json, in one atomic statement — never a
          // wholesale rebuild from a stale in-memory copy. That copy (built
          // from row.payload_json read at the TOP of this handler, before
          // classification/historical-match/etc. ran) can be arbitrarily
          // behind by the time this write executes: a concurrent
          // AI-completion SAVE_REPORT_SQL write could have added
          // $.aiAnalysis/$.aiScore in the meantime, which a wholesale
          // `SET payload_json = ?` would then erase while the flat ai_*
          // columns (untouched here) stay 'ready' + numeric — exactly the
          // Room-5 UI. json_set reads $.aiAnalysis back live and preserves
          // it. The generation guard is unchanged (COALESCE(...,-1) <=
          // resolution.corpusGeneration), so a newer-generation result a
          // concurrent write already persisted still wins. matchClassification/
          // experimentalHistoricalMatch/reuseContext (read-time-only display
          // fields on the in-memory `payload`) were never persistable and
          // still are not — json_set never touches them.
          try {
            await persistRefreshedSimilarity(client, { reportDeviceKey: row.device_key, reportId: id }, resolution);
          } catch (err) {
            console.error('persisting the refreshed similarity result failed (non-fatal, this response still reflects it):', err instanceof Error ? err.message : String(err));
          }
        } else if (resolution.failed) {
          // Release-hardening audit finding LIFECYCLE-06 (corrected): the
          // GET-side mirror of app/api/reports/route.ts's own POST-time
          // failure persistence — a genuine, reproducible
          // computeUnifiedSimilarity failure for this report's own data
          // (resolution.failed's own comment), persisted here too so a
          // report that was never resaved (only ever viewed) still gets an
          // honest, actionable terminal state instead of polling forever.
          // Same generation-guard discipline as the success branch above,
          // for the same reason.
          //
          // Release-hardening audit finding LIFECYCLE-06 (approval-pass
          // fix): unifiedSimilarity is explicitly cleared on BOTH the
          // in-memory `payload` (built from row.payload_json at the top of
          // this handler — already carries a PREVIOUS successful result if
          // one was ever persisted) and the re-read `persistedPayload`
          // below, for the identical reason app/api/reports/route.ts's own
          // POST-time failure branch does — without this, a stale success
          // would silently linger alongside the fresh failure marker, and
          // resolvePersistedSimilarityDisplay's own hasUnifiedSimilarity
          // check (deliberately prioritized so a REAL result always wins
          // over a stale failure marker) would then mask this genuinely
          // fresh failure behind that stale "resolved" score.
          payload.unifiedSimilarity = undefined;
          payload.unifiedSimilarityFailed = true;
          payload.corpusSourceMatchingEnabledAtComputation = resolution.corpusSourceMatchingEnabled;
          payload.unifiedSimilarityGeneration = resolution.corpusGeneration;
          try {
            // Same targeted-write reasoning as the success branch above:
            // json_remove drops only $.unifiedSimilarity, json_set stamps the
            // three failure-marker keys, on the current row — $.aiAnalysis/
            // $.aiScore and every other field survive untouched.
            await persistRefreshedSimilarity(client, { reportDeviceKey: row.device_key, reportId: id }, resolution);
          } catch (err) {
            console.error('persisting the terminal similarity failure marker failed (non-fatal, this response still reflects it):', err instanceof Error ? err.message : String(err));
          }
        }
        // Release-hardening audit finding UI-02 (continued): unlike
        // historicalSubmissionMatch above, unifiedSimilarity itself is NEVER
        // gated — it is the finalized aggregate result (score, word counts,
        // pass/fail evidence totals) every viewer must keep seeing
        // immediately, admin or not. But contributions[] — a per-passage
        // breakdown carrying the same internal representation id
        // (sourceId) and relationshipType-shaped label
        // (contributions[].relationship) as historicalSubmissionMatch's own
        // matches[] — is not rendered by any production UI (see
        // components/report/similarity-report-papers.tsx's own
        // unifiedEvidenceBreakdown, which reads the flat archiveOnlyWords/
        // liveAcademicOnlyWords/previousUploadOnlyWords/overlapWords
        // counters, never contributions) and exists purely for internal/
        // shadow-evaluation use. Stripped here for the same non-admin
        // audience and the same reason as historicalSubmissionMatch — an
        // ordinary viewer must never receive the internal id even nested
        // inside the object this fix otherwise preserves untouched. Handles
        // both the freshly-resolved case just above AND the passthrough
        // case (resolution.unifiedSimilarity was falsy this request, so
        // payload.unifiedSimilarity is whatever an earlier successful save
        // already persisted).
        if (payload.unifiedSimilarity && sessionUser?.role !== 'admin') {
          payload.unifiedSimilarity = { ...payload.unifiedSimilarity, contributions: [] };
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
        // Phase E8P + Device Passport Phase 4: production shadow telemetry —
        // measurement only, never changes historicalSubmissionMatch above
        // (already resolved and reused as-is, never recomputed) or the
        // unified score. This is the SELF-HEAL / FALLBACK trigger: the same
        // scheduling now also runs on the successful POST /api/reports
        // lifecycle (see lib/report-shadow-evaluations.ts and
        // app/api/reports/route.ts) for reports whose similarity finalizes
        // at write time and are then never fetched through this route. The
        // shared helper defers via runAfterResponse on its own DB connection
        // (this route's `client` is closed in `finally` before after()
        // fires), is best-effort (a telemetry failure never fails this
        // response), and is idempotent — both evaluators UPSERT their row per
        // (device_key, id, policy_version), so a POST-scheduled run and a
        // later GET-scheduled run converge on the same row. Local values (not
        // `payload`) are passed so the deferred closure never retains the
        // outer request's own object.
        await scheduleReportShadowEvaluations({
          reportDeviceKey: row.device_key,
          reportId: id,
          accountId,
          rawText: payload.text,
          productionResult: historicalSubmissionMatch,
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
