import { NextResponse } from "next/server";
import mammoth from "mammoth";
import type { Client } from "@libsql/client";
import { getSessionUser } from "@/lib/auth-session";
import { getReportsDbClient } from "@/lib/reports-db";
import { reportAccessRefusalFor, sqliteTimestampMs } from "@/lib/account-entitlements";
import { canonicalSha256 } from "@/lib/document-identity";
import { extractDocxTextDocument } from "@/lib/docx-text-extraction";
import { normalizeExtractedText } from "@/lib/extracted-text-normalization";
import { resolveSystem2Access, type System2AccessReason } from "@/lib/system2-access";
import {
  PERSIST_SYSTEM2_ESTIMATE_SQL,
  SYSTEM2_ESTIMATE_PAYLOAD_KEY,
  acceptedSystem2Estimate,
  type System2EstimateRecord,
} from "@/lib/system2-estimate-record";
import {
  SYSTEM2_CONSENT_HEADER,
  SYSTEM2_CONSENT_VALUE,
  SYSTEM2_MAX_UPLOAD_BYTES,
  SYSTEM2_NOT_SENT_HEADER,
  SYSTEM2_NOT_SENT_STATES,
  SYSTEM2_REQUEST_WINDOW_MS,
  isClearlyEnglishResult,
  localSystem2Refusal,
  requestSystem2Inference,
  system2Config,
} from "@/lib/system2-research";

/**
 * POST /api/reports/[id]/system2 — the English System 2 estimate for one of the caller's OWN reports, requested once by
 * the room right after the report is saved.
 *
 * Gate (all server-side, in this order; every failure here is a plain 404 so the route's existence is never confirmed
 * to anyone else): feature configured for this deployment → signed-in session → the report belongs to that account →
 * the account may run System 2 for that report's room (lib/system2-access.ts: administrator, owner allowlist, or a
 * verified customer with an active subscription and the room inside the plan).
 *
 * Then, for the eligible account: consent header (sent automatically) → a file the browser did not send (not a Word
 * document, too large) is only recorded as ineligible → one estimate per report (an accepted one is never replaced),
 * only within SYSTEM2_REQUEST_WINDOW_MS of the report's first save → size / type / format checks (refused locally,
 * nothing transmitted) → the uploaded Word document must be the report's own: its text, extracted here with the same
 * shared extractor the browser uses, must have the same canonical hash as the saved report's text, so no estimate of
 * another document can ever be attached to a report → the DOCX bytes are sent server-to-server to the private
 * inference backend → only whitelisted result fields are returned. A result for text that is not clearly English is
 * not used at all (no number is returned): the document keeps System 1's result.
 *
 * An ACCEPTED estimate (shown, integer 0–20, clearly English) is then stored with this report, in place, at `$.system2Estimate`
 * (lib/system2-estimate-record.ts): one json_set on the row's current payload, only while none is stored, so a
 * concurrent AI-result save is never overwritten (and SAVE_REPORT_SQL carries the estimate across any later resave).
 * `persisted` in the response says whether it was stored; the browser shows the unified percentage only then, so every
 * view agrees with the server copy. A refusal or failure stores nothing. The document is never stored or logged; each
 * eligible request writes one internal outcome line (SUCCEEDED / FAILED / INELIGIBLE / REFUSED, a code, the access
 * cohort, the report id) with no document content, score or account detail. System 1 scores, AI results and the
 * report's history are untouched. `updated_at` is deliberately left as it is.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: NO_STORE });
const notFound = () => json({ error: "Not found" }, 404);
const noEstimate = (state: string, final_text: string) => ({ state, estimate_shown: false, research_only: true, final_text });

type Outcome = "SUCCEEDED" | "FAILED" | "INELIGIBLE" | "REFUSED";
/** The internal record of what happened to one request (runtime logs). Never content, scores or account details. */
function logOutcome(outcome: Outcome, code: string, cohort: System2AccessReason, reportId: string) {
  console.info(JSON.stringify({ event: "system2_outcome", outcome, code, cohort, reportId }));
}

type TargetRow = { deviceKey: string; room: number | null; text: string | null; savedAtMs: number | null; hasEstimate: boolean };

async function findTargetRow(client: Client, id: string, userId: string): Promise<TargetRow | null> {
  const result = await client.execute({
    sql: `SELECT device_key, room_number, saved_at,
                 CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.text') END AS text,
                 CASE WHEN json_valid(payload_json) THEN json_type(payload_json, '$.${SYSTEM2_ESTIMATE_PAYLOAD_KEY}') END AS estimate_type
            FROM saved_reports WHERE id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 1`,
    args: [id, userId],
  });
  const row = result.rows[0] as unknown as
    | { device_key: string; room_number: number | bigint | null; saved_at: string | null; text: unknown; estimate_type: string | null }
    | undefined;
  if (!row) return null;
  return {
    deviceKey: row.device_key,
    room: row.room_number === null ? null : Number(row.room_number),
    text: typeof row.text === "string" ? row.text : null,
    savedAtMs: sqliteTimestampMs(row.saved_at),
    hasEstimate: row.estimate_type !== null,
  };
}

/** The canonical hash of a Word document's text, extracted exactly as the browser extracts it for a report. Null if unreadable. */
async function docxTextHash(bytes: Uint8Array): Promise<string | null> {
  try {
    const text = normalizeExtractedText(await extractDocxTextDocument(mammoth.convertToHtml, { buffer: Buffer.from(bytes) }));
    return text.length > 0 ? canonicalSha256(text) : null;
  } catch {
    return null;
  }
}

export async function GET() {
  return notFound();
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const config = system2Config();
  if (!config.enabled) return notFound();
  const { id } = await context.params;
  if (typeof id !== "string" || id.length === 0 || id.length > 200) return notFound();

  let target: TargetRow;
  let userId: string;
  let cohort: System2AccessReason;
  const client = await getReportsDbClient();
  try {
    const user = await getSessionUser(request, client);
    if (!user) return notFound();
    // Manual subscriptions (lib/account-entitlements.ts REPORT ACCESS): no report, so no estimate — an allowlisted account included.
    if (await reportAccessRefusalFor(client, user)) return notFound();
    const row = await findTargetRow(client, id, user.id);
    if (!row) return notFound();
    const access = await resolveSystem2Access(client, user, { room: row.room, config });
    if (!access.allowed) {
      logOutcome("INELIGIBLE", access.reason, access.reason, id);
      return notFound();
    }
    target = row;
    userId = user.id;
    cohort = access.reason;
  } finally {
    client.close();
  }

  if (request.headers.get(SYSTEM2_CONSENT_HEADER) !== SYSTEM2_CONSENT_VALUE) {
    logOutcome("REFUSED", "CONSENT_REQUIRED", cohort, id);
    return json(noEstimate("CONSENT_REQUIRED", "Consent is required before the document is sent to the System 2 research service."), 400);
  }
  // A file the browser kept (not a Word document, or too large): recorded as ineligible; System 1 stays the result.
  const notSent = (request.headers.get(SYSTEM2_NOT_SENT_HEADER) ?? "").trim();
  if (notSent) {
    const state = (SYSTEM2_NOT_SENT_STATES as readonly string[]).includes(notSent) ? notSent : "UNSUPPORTED_FILE_TYPE";
    logOutcome("INELIGIBLE", state, cohort, id);
    return json(noEstimate(state, "The document was not sent. No estimate."), 200);
  }
  if (target.hasEstimate) {
    logOutcome("REFUSED", "ALREADY_RECORDED", cohort, id);
    return json(noEstimate("ALREADY_RECORDED", "This report already has its estimate."), 409);
  }
  if (target.savedAtMs === null || Date.now() - target.savedAtMs > SYSTEM2_REQUEST_WINDOW_MS) {
    logOutcome("REFUSED", "REQUEST_WINDOW_CLOSED", cohort, id);
    return json(noEstimate("REQUEST_WINDOW_CLOSED", "An estimate can only be made right after the report is saved."), 409);
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > SYSTEM2_MAX_UPLOAD_BYTES) {
    logOutcome("INELIGIBLE", "TOO_LARGE", cohort, id);
    return json(localSystem2Refusal(".docx", declared, new Uint8Array()), 413);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  const extension = (request.headers.get("x-file-extension") ?? "").trim().toLowerCase();
  const refusal = localSystem2Refusal(extension, bytes.byteLength, bytes.subarray(0, 4));
  if (refusal) {
    logOutcome("INELIGIBLE", refusal.state, cohort, id);
    return json(refusal, refusal.state === "TOO_LARGE" ? 413 : 200);
  }
  const uploadedHash = await docxTextHash(bytes);
  if (uploadedHash === null || target.text === null || uploadedHash !== canonicalSha256(target.text)) {
    logOutcome("REFUSED", uploadedHash === null ? "NOT_READABLE" : "DOCUMENT_MISMATCH", cohort, id);
    return json(noEstimate("DOCUMENT_MISMATCH", "This file is not the document of this report. No estimate."), 422);
  }

  const result = await requestSystem2Inference(bytes, config);
  if (!result) {
    logOutcome("FAILED", "UNAVAILABLE", cohort, id);
    return json(noEstimate("UNAVAILABLE", "The System 2 research service is unavailable right now. No estimate."), 502);
  }
  if (result.estimate_shown && !isClearlyEnglishResult(result)) {
    logOutcome("INELIGIBLE", "NOT_CLEARLY_ENGLISH", cohort, id);
    return json({ ...noEstimate("NOT_CLEARLY_ENGLISH", "This document is not clearly English. No estimate."), persisted: false }, 200);
  }
  const accepted = acceptedSystem2Estimate(result as System2EstimateRecord, new Date().toISOString());
  if (!accepted) {
    // The backend answered without an estimate (for instance a similarity report, or too short).
    logOutcome("INELIGIBLE", String(result.state).slice(0, 64), cohort, id);
    return json({ ...result, persisted: false }, 200);
  }
  const store = await persistAcceptedEstimate(id, { userId, deviceKey: target.deviceKey }, accepted);
  if (store === "STORED") logOutcome("SUCCEEDED", "STORED", cohort, id);
  else if (store === "ALREADY_RECORDED") logOutcome("REFUSED", "ALREADY_RECORDED", cohort, id); // a simultaneous request stored first
  else logOutcome("FAILED", "NOT_STORED", cohort, id);
  return json({ ...result, persisted: store === "STORED" }, 200);
}

/** Stores the accepted estimate on the owner's own report row, in place, only while none is stored. Anything but STORED leaves System 1's result. */
async function persistAcceptedEstimate(id: string, owner: { userId: string; deviceKey: string }, accepted: object): Promise<"STORED" | "ALREADY_RECORDED" | "ERROR"> {
  const client = await getReportsDbClient();
  try {
    const res = await client.execute({
      sql: PERSIST_SYSTEM2_ESTIMATE_SQL,
      args: [JSON.stringify(accepted), owner.deviceKey, id, owner.userId],
    });
    return res.rowsAffected === 1 ? "STORED" : "ALREADY_RECORDED";
  } catch (err) {
    console.error("system2 estimate persist failed:", err instanceof Error ? err.name : "unknown");
    return "ERROR";
  } finally {
    client.close();
  }
}
