import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate, checkReadRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { findReportRowForDeviceKey, findReportRowForUser } from '../../../../lib/reports-repo';
import { classifyReportMatches } from '../../../../lib/report-classification';
import { deleteHistoricalMatchSnapshot, getPersistedHistoricalMatchSnapshot } from '../../../../lib/report-historical-match';
import { stripClientEvidenceInterpretation, refreshSelectiveCorpusCompletionSignal } from '../../../../lib/report-evidence-interpretation';
import { sanitizeExtractionDiagnostic } from '../../../../lib/evidence-interpretation';
import { deleteReportDocumentData } from '../../../../lib/report-deletion';
import { deleteReportCorpusAdmissionData } from '../../../../lib/corpus-admission-report-integration';
import { getSessionUser } from '../../../../lib/auth-session';
import { stripServerInternalReportFields, type SimilarityReport } from '../../../../lib/report-types';
import { tryDecodeReportFromPersistence } from '../../../../lib/report-persistence';

// This response is per-session personalized (viewerIsAdmin and admin-gated
// historical-match data) and MUST NOT be shared-cached. Every response from
// this file is Cache-Control: no-store; the route is force-dynamic so
// Next/Vercel never attempts to cache the handler itself.
export const dynamic = 'force-dynamic';

const MAX_DEVICE_KEY_LENGTH = 200;
const NO_STORE_JSON = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } as const;

// R2 — the response for a stored report whose persisted explanation cannot be
// decoded safely (unsupported compact version, corrupt interpretation, or —
// only for a viewer who is served them — corrupt admin contributions). A 503 with
// a generic code: NEVER the score without its explanation, never a decoder
// internal (the bounded reason is logged server-side by the decoder, not sent).
// Same `{ error, code }` 503 shape POST /api/reports already uses for
// ROOM_REUSE_NOT_READY.
const REPORT_UNAVAILABLE_BODY = JSON.stringify({ error: 'Report temporarily unavailable', code: 'REPORT_TEMPORARILY_UNAVAILABLE' });

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const rate = await checkReadRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { ...NO_STORE_JSON, 'Retry-After': String(rate.retryAfter) } });
    }

    const { id } = await params;
    if (!isNonEmptyString(id)) return new NextResponse(JSON.stringify({ error: 'id is required' }), { status: 400, headers: NO_STORE_JSON });

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
          return new NextResponse(JSON.stringify({ error: 'deviceKey is required' }), { status: 400, headers: NO_STORE_JSON });
        }
        row = await findReportRowForDeviceKey(client, id, deviceKey);
      }

      if (!row) {
        return new NextResponse(JSON.stringify({ error: 'Report not found' }), { status: 404, headers: NO_STORE_JSON });
      }

      // C2 — the ONE decode boundary: immediately expand the report's
      // compact persisted forms (unifiedSimilarity's previousUploadPositions
      // elision + compact contributions, and the compact evidenceInterpretation)
      // back to the full public shape every downstream consumer in this
      // handler already expects (evidence interpretation restore, report-
      // completion, non-admin contributions redaction, response serialization)
      // — BEFORE any of them run, so nothing below (and no customer response)
      // ever sees a compact tuple or format marker. A row with no compact form
      // anywhere (every pre-existing report, permanently) round-trips through
      // this as a no-op.
      //
      // R2 — FAIL CLOSED. A persisted interpretation that is unknown/corrupt is
      // NOT dropped any more (that served the score with no cards and no
      // highlights as a normal 200): the decode result says so and this route
      // refuses with a generic 503 — never the score without its explanation,
      // never a recompute. Admin contributions are diagnostics, not the customer
      // explanation, so they are only REQUIRED for a viewer who is actually served
      // them (an admin session); for everyone else a damaged `contributions` is
      // moot (they are replaced by [] below regardless). See lib/report-persistence.ts.
      const decoded = tryDecodeReportFromPersistence(JSON.parse(String(row.payload_json)), {
        requireContributions: sessionUser?.role === 'admin',
      });
      if (!decoded.ok) {
        return new NextResponse(REPORT_UNAVAILABLE_BODY, { status: 503, headers: NO_STORE_JSON });
      }
      payload = decoded.report;
      // DOCUMENT EXTRACTION V2 — capture the persisted extraction diagnostic
      // BEFORE the strip below. Unlike evidenceInterpretation / reportCompletion
      // (recomputed from the server's authoritative matched-position data),
      // extraction completeness can only be observed at upload time in the
      // browser — the server never had the bytes — so the value written by THIS
      // report's own save (already server-sanitised then) is re-sanitised
      // defensively and carried through the recompute below. A pre-V2 report
      // simply has none and stays completeness UNKNOWN.
      const persistedExtractionDiagnostic = sanitizeExtractionDiagnostic(
        (payload as Record<string, unknown>).extractionDiagnostic,
      );
      // USER-SUPPLIED REFERENCES V1 — capture the persisted, server-verified
      // reference evidence + channel BEFORE the strip below. Written by THIS
      // report's own save (already server-verified then, from the actual
      // reference text — the raw text is never persisted), so it is trusted
      // as-is on read and restored verbatim below (report-lifecycle
      // correctness fix — a GET must never recompute anything, so this is no
      // longer re-threaded through any scoring/interpretation recompute,
      // only restored exactly as saved). A pre-V1 report simply has none.
      const persistedReferenceEvidence = Array.isArray(payload.userSuppliedReferenceEvidence)
        ? payload.userSuppliedReferenceEvidence
        : null;
      const persistedReferenceChannel = payload.userSuppliedReferenceChannel ?? null;
      // AUTHORITATIVE PROMOTION — capture the persisted, already-server-computed
      // evidenceInterpretation/reportCompletion BEFORE the strip below, for the
      // SAME reason persistedExtractionDiagnostic captures extractionDiagnostic
      // just above: a pending/completed/incomplete authoritative report skips
      // the recompute block entirely (see that block's own guard comment), so
      // without this capture the strip below would remove these two
      // explanation-only fields and nothing would ever restore them — not a
      // "stale value," since this report is never recomputed again, just the
      // one, final, correct value silently going missing. Restored (never
      // recomputed) after the guarded block, only when it was skipped.
      const persistedEvidenceInterpretationForAuthoritativeReport =
        (payload as Record<string, unknown>).evidenceInterpretation;
      const persistedReportCompletionForAuthoritativeReport =
        (payload as Record<string, unknown>).reportCompletion;
      // Report V2 trust boundary: drop any persisted/forged
      // evidenceInterpretation / reportCompletion / extractionDiagnostic
      // immediately after parsing — restored below (report-lifecycle
      // correctness fix: from the already-captured PERSISTED value only,
      // never recomputed) so a client can never smuggle a forged one past
      // this route by round-tripping it back in.
      payload = stripClientEvidenceInterpretation(payload);
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
      // REPORT-LIFECYCLE CORRECTNESS FIX (customer historical-GET purity):
      // this route used to call resolvePrimarySimilaritySummary and
      // persistRefreshedSimilarity on EVERY request — recomputing against
      // whatever the live corpus generation / CORPUS_SOURCE_MATCHING_ENABLED
      // flag / scholarly-evidence state happens to be RIGHT NOW, and
      // persisting the refreshed result back over the saved row whenever it
      // differed. That is reachable from an ordinary customer via the
      // detail page's own client poll, "Download receipt"
      // (room-page-shell.tsx's handleDownloadReceipt), and retryAiCheck's
      // local-copy-fallback fetch — none of which is "opening a room," but
      // all of which are "reading an existing, possibly long-completed
      // report." That is exactly the same class of bug findRoomOccupant
      // (lib/reports-repo.ts) was fixed to stop: a completed historical
      // report's similarity generation drifting behind a later corpus
      // admission/promotion must never cause a bare GET to silently
      // recompute and rewrite it.
      //
      // A saved report is a snapshot. Everything below only RESTORES the
      // already-computed, already-persisted values that
      // stripClientEvidenceInterpretation dropped above —
      // evidenceInterpretation / reportCompletion / extractionDiagnostic /
      // userSuppliedReferenceEvidence / userSuppliedReferenceChannel are all
      // genuinely computed and persisted at POST time
      // (app/api/reports/route.ts's own finalizeReportJson /
      // withEvidenceInterpretation call, inside the SAME write that
      // persists unifiedSimilarity) — never recomputed a second time here.
      // unifiedSimilarity / unifiedSimilarityGeneration /
      // corpusSourceMatchingEnabledAtComputation / unifiedSimilarityFailed
      // are already correct on `payload` straight from the initial
      // JSON.parse (already expanded from its compact persisted shape
      // above) — nothing here ever reinterprets them against today's
      // corpus generation or the live flag. A legacy report saved before
      // Report V2 existed simply has none of the interpretation fields,
      // exactly as it always did before ever being GET'd. Only the same
      // non-admin contributions[] redaction still applies, operating on
      // the persisted value directly instead of a freshly resolved one.
      // The admin-only matchClassification enrichment above is untouched
      // (independently read-only, no dependency on anything recomputed
      // here).
      //
      // The Selective-Corpus-authoritative-promotion distinction this block
      // used to make (pending/completed/incomplete never recompute; every
      // other report does) is now moot — nothing recomputes any more, so
      // every report, authoritative-tracked or not, is simply restored the
      // same way.
      if (persistedEvidenceInterpretationForAuthoritativeReport !== undefined) {
        payload.evidenceInterpretation = persistedEvidenceInterpretationForAuthoritativeReport as SimilarityReport['evidenceInterpretation'];
      }
      if (persistedReportCompletionForAuthoritativeReport !== undefined) {
        payload.reportCompletion = persistedReportCompletionForAuthoritativeReport as SimilarityReport['reportCompletion'];
      }
      if (persistedExtractionDiagnostic) {
        payload.extractionDiagnostic = persistedExtractionDiagnostic;
      }
      if (persistedReferenceEvidence) {
        payload.userSuppliedReferenceEvidence = persistedReferenceEvidence;
      }
      if (persistedReferenceChannel) {
        payload.userSuppliedReferenceChannel = persistedReferenceChannel;
      }
      // Release-hardening audit finding UI-02: admin-only, exactly as
      // before — but sourced from getPersistedHistoricalMatchSnapshot
      // (lib/report-historical-match.ts), the pure read-only twin of
      // getOrComputeHistoricalMatchSnapshot added for this same fix: it
      // returns the already-persisted snapshot exactly as it is on file —
      // whatever generation/corpus state it was computed under — or
      // `undefined` only when no snapshot has ever been computed for this
      // report at all, and never computes or writes anything itself either
      // way. Same "shown as-is, never blocked by its own age" rule this
      // whole fix applies to unifiedSimilarity: a plain GET shows exactly
      // what is currently, genuinely on file, never a fresher answer it
      // would have to compute to produce.
      if (sessionUser?.role === 'admin') {
        try {
          const persistedHistoricalSubmissionMatch = await getPersistedHistoricalMatchSnapshot(client, {
            reportDeviceKey: row.device_key,
            reportId: id,
          });
          if (persistedHistoricalSubmissionMatch) {
            payload.historicalSubmissionMatch = persistedHistoricalSubmissionMatch;
          }
        } catch (err) {
          console.error('getPersistedHistoricalMatchSnapshot failed (non-fatal):', err instanceof Error ? err.message : String(err));
        }
      }
      // Release-hardening audit finding UI-02 (continued): unifiedSimilarity
      // itself is never gated — it is the finalized aggregate result every
      // viewer must keep seeing, admin or not — but contributions[] (an
      // internal per-passage representation id, not rendered by any
      // production UI) is stripped for non-admins, exactly as before, now
      // operating on the persisted value directly.
      if (payload.unifiedSimilarity && sessionUser?.role !== 'admin') {
        payload.unifiedSimilarity = { ...payload.unifiedSimilarity, contributions: [] };
      }
    } finally {
      client.close();
    }

    // Scholarly evidence server trust boundary (drizzle/0052): verifiedAcademicSearchDiagnosticsId
    // is an INTERNAL re-lookup handle — POST stamps it into payload_json purely so a resave (POST)
    // can re-resolve the server-owned evidence_json by (id + canonical text hash) at write time. No
    // UI ever renders it, admin or otherwise. It must not reach any client, so it is stripped from
    // the response here, only from this outbound copy — the stored payload_json keeps it
    // (SAVE_REPORT_SQL's own write never removes it, so a client that never sees it still round-trips
    // fine on its next resave).
    if (payload) delete payload.verifiedAcademicSearchDiagnosticsId;

    // AUTHORITATIVE PROMOTION — response hygiene. Runs for EVERY response
    // (marker-less, pending, completed, incomplete alike) since it is purely
    // additive/idempotent for the cases where it does nothing (see each
    // function's own doc comment): refresh reportCompletion's selectiveCorpus
    // signal from the persisted status FIRST (it needs to read
    // selectiveCorpusAuthoritativeStatus), then strip the two server-internal
    // fields from this outbound copy — the stored payload_json keeps them,
    // exactly like verifiedAcademicSearchDiagnosticsId above.
    if (payload) {
      refreshSelectiveCorpusCompletionSignal(payload);
      stripServerInternalReportFields(payload);
    }

    return new NextResponse(JSON.stringify({ payload }), { status: 200, headers: NO_STORE_JSON });
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500, headers: NO_STORE_JSON });
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
