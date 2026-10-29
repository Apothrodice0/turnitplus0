import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth-session";
import { getReportsDbClient } from "@/lib/reports-db";
import { findReportRowForUser } from "@/lib/reports-repo";
import {
  SYSTEM2_CONSENT_HEADER,
  SYSTEM2_CONSENT_VALUE,
  SYSTEM2_MAX_UPLOAD_BYTES,
  isSystem2ResearchUser,
  localSystem2Refusal,
  requestSystem2Inference,
  system2Config,
} from "@/lib/system2-research";

/**
 * POST /api/reports/[id]/system2 — owner-only English System 2 RESEARCH estimate for one of the caller's OWN reports.
 *
 * Gate (all server-side, in this order; every failure before the consent check is a plain 404 so the route's existence
 * is never confirmed to anyone else): feature enabled for this deployment (never in production) → signed-in session →
 * account on the owner allowlist → the report belongs to that account. Then: explicit consent header → size / type /
 * format checks (refused locally, nothing transmitted) → the DOCX bytes are sent server-to-server to the private
 * inference backend → only whitelisted result fields are returned.
 *
 * Nothing is persisted, logged or cached: System 1 scores, AI results, the saved report and its history are untouched.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: NO_STORE });
const notFound = () => json({ error: "Not found" }, 404);

export async function GET() {
  return notFound();
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const config = system2Config();
  if (!config.enabled) return notFound();
  const { id } = await context.params;
  if (typeof id !== "string" || id.length === 0 || id.length > 200) return notFound();

  const client = await getReportsDbClient();
  try {
    const user = await getSessionUser(request, client);
    if (!user || !isSystem2ResearchUser(user, config)) return notFound();
    const row = await findReportRowForUser(client, id, user.id);
    if (!row) return notFound();
  } finally {
    client.close();
  }

  if (request.headers.get(SYSTEM2_CONSENT_HEADER) !== SYSTEM2_CONSENT_VALUE) {
    return json({ state: "CONSENT_REQUIRED", estimate_shown: false, research_only: true, final_text: "Consent is required before the document is sent to the System 2 research service." }, 400);
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > SYSTEM2_MAX_UPLOAD_BYTES) {
    return json(localSystem2Refusal(".docx", declared, new Uint8Array()), 413);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  const extension = (request.headers.get("x-file-extension") ?? "").trim().toLowerCase();
  const refusal = localSystem2Refusal(extension, bytes.byteLength, bytes.subarray(0, 4));
  if (refusal) return json(refusal, refusal.state === "TOO_LARGE" ? 413 : 200);

  const result = await requestSystem2Inference(bytes, config);
  if (!result) {
    return json({ state: "UNAVAILABLE", estimate_shown: false, research_only: true, final_text: "The System 2 research service is unavailable right now. No estimate." }, 502);
  }
  return json(result, 200);
}
