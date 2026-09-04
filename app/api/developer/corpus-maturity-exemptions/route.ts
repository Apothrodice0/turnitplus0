import { NextResponse } from "next/server";
import { getReportsDbClient } from "../../../../lib/reports-db";
import { checkRate } from "../../../../lib/rate-limit";
import { clientIpFrom } from "../../../../lib/client-ip";
import { getAdminSessionUser } from "../../../../lib/auth-session";
import {
  listCorpusMaturityExemptions,
  addCorpusMaturityExemption,
  removeCorpusMaturityExemption,
} from "../../../../lib/developer-corpus-maturity-exemptions";

/**
 * Developer control — "Corpus maturity exemptions". Lets an authenticated
 * admin exempt one account's corpus sources from the 7-day maturity gate
 * (lib/user-submission-corpus.ts's admissionEligibilitySql /
 * CORPUS_ACTIVATION_DELAY_DAYS). This affects ONLY maturity — never same-
 * Passport SELF, exact/strong matching, duplicate suppression, archive/web/
 * scholarly evidence, corpus admission, scoring, or owner-link logic.
 *
 * Authorization identical to every other /api/developer/* route:
 * getAdminSessionUser collapses "not signed in" and "signed in but not an
 * admin" into the same plain 404 (never 401/403, never a body), checked
 * BEFORE any body validation.
 *
 * The email in the POST body is a LOOKUP KEY ONLY — resolved server-side to
 * users.id, and ONLY that id is ever persisted (lib/developer-corpus-
 * maturity-exemptions.ts). DELETE removes by userId (never re-resolves an
 * email), since the dashboard already has the id from the GET list.
 */

function jsonResponse(body: unknown, status: number): NextResponse {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function notFound(): NextResponse {
  return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  try {
    const rate = await checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: "Too many requests" }), { status: 429, headers: { "Retry-After": String(rate.retryAfter) } });
    }
    const client = await getReportsDbClient();
    try {
      const admin = await getAdminSessionUser(request, client);
      if (!admin) return notFound();
      const exemptions = await listCorpusMaturityExemptions(client);
      return jsonResponse({ exemptions }, 200);
    } finally {
      client.close();
    }
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
}

type AddBody = { email?: unknown };

export async function POST(request: Request) {
  try {
    const rate = await checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: "Too many requests" }), { status: 429, headers: { "Retry-After": String(rate.retryAfter) } });
    }
    const client = await getReportsDbClient();
    try {
      const admin = await getAdminSessionUser(request, client);
      if (!admin) return notFound();

      const body = (await request.json().catch(() => null)) as AddBody | null;
      if (!body || typeof body.email !== "string" || body.email.trim().length === 0) {
        return jsonResponse({ error: "A valid account email is required." }, 400);
      }

      const result = await addCorpusMaturityExemption(client, { email: body.email, createdByUserId: admin.id });
      if (result.kind === "invalid_email") {
        return jsonResponse({ error: "A valid account email is required." }, 400);
      }
      if (result.kind === "not_found") {
        return jsonResponse({ error: "No account found for that email.", found: false }, 200);
      }
      return jsonResponse({ found: true, userId: result.userId, email: result.email }, 200);
    } finally {
      client.close();
    }
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
}

type RemoveBody = { userId?: unknown };

export async function DELETE(request: Request) {
  try {
    const rate = await checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: "Too many requests" }), { status: 429, headers: { "Retry-After": String(rate.retryAfter) } });
    }
    const client = await getReportsDbClient();
    try {
      const admin = await getAdminSessionUser(request, client);
      if (!admin) return notFound();

      const body = (await request.json().catch(() => null)) as RemoveBody | null;
      if (!body || typeof body.userId !== "string" || body.userId.trim().length === 0) {
        return jsonResponse({ error: "userId is required." }, 400);
      }

      await removeCorpusMaturityExemption(client, body.userId);
      return jsonResponse({ removed: true }, 200);
    } finally {
      client.close();
    }
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
}
