import { NextResponse } from "next/server";
import { checkRate } from "../../../../lib/rate-limit";
import { clientIpFrom } from "../../../../lib/client-ip";
import { getReportsDbClient } from "../../../../lib/reports-db";
import { isArchiveServerSideEnabled } from "../../../../lib/archive-server-flag";
import { analyzeArchiveOnServer } from "../../../../lib/archive-server-analysis";

/**
 * 100k-scale architecture, slice 2E — the one server endpoint the real
 * document-analysis flow reaches archive matching through when
 * ARCHIVE_SERVER_SIDE_ENABLED is on.
 *
 *   GET  -> { archiveServerSide: boolean }
 *           A pure, DB-independent read of ARCHIVE_SERVER_SIDE_ENABLED — no
 *           libsql client, no rate-limit bucket, no DB dependency of any kind
 *           (see the GET handler's own comment). The client
 *           (lib/archive-analysis-runtime.ts) reads this ONCE per session to
 *           decide engine: false => keep the browser static-index worker
 *           (app/similarity-worker.ts); true => POST here instead. Default OFF
 *           when the env var is absent/malformed.
 *
 *   POST { text } -> { result: ArchiveAnalysisResult }
 *           Runs the committed server matcher (compact + FTS + G1s co-source)
 *           and re-frames its result with the SAME risk/quotation/reference/
 *           repeated-phrase rules the browser worker uses
 *           (lib/archive-result-framing.ts). 404 when the flag is off — the
 *           route is inert unless explicitly enabled (defence in depth; the
 *           client never POSTs here unless GET said true).
 *
 * No auth requirement — mirrors /api/academic-evidence exactly: this never
 * touches a user's saved-report data, only the raw submission text the client
 * already holds. Enforces the same MAX_TEXT_LENGTH ceiling
 * (/api/academic-evidence's 1_000_000). Accepts normalized text, never file
 * bytes.
 *
 * The response carries ONLY fields a user already legitimately receives from
 * archive analysis (score / band / matched positions / public source
 * handles+titles / risk framing). It never exposes representation_id,
 * co-source neighbour ids, adjacency policy internals, DB ids, fingerprint
 * hashes, provenance/passport data, or the matcher's internal discovery
 * diagnostics — analyzeArchiveOnServer keeps those in `diagnostics`, which is
 * not serialised here.
 */

const MAX_TEXT_LENGTH = 1_000_000;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Engine discovery — a pure read of the process-level flag
 * (lib/archive-server-flag.ts). No client IP parsing, no rate-limit bucket,
 * no libsql/Turso client, no DB access of any kind: with
 * ARCHIVE_SERVER_SIDE_ENABLED off (the default) the browser-engine path must
 * not inherit a server/DB failure mode it has no need for.
 *
 * There is deliberately NO try/catch here downgrading a failure to
 * `{ archiveServerSide: false }` — the handler has no failure path to catch.
 * If the HTTP layer itself ever fails, the client's discovery
 * (lib/archive-analysis-runtime.ts) still THROWS on the network error /
 * non-2xx / malformed body exactly as before: fail closed, never a silent
 * browser fallback.
 */
export async function GET() {
  return new NextResponse(
    JSON.stringify({ archiveServerSide: isArchiveServerSideEnabled() }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

export async function POST(request: Request) {
  try {
    const rate = await checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: "Too many requests" }), { status: 429, headers: { "Retry-After": String(rate.retryAfter) } });
    }

    // Inert unless explicitly enabled. The client only POSTs here after GET
    // returned true, but the route must not depend on that.
    if (!isArchiveServerSideEnabled()) {
      return new NextResponse(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return new NextResponse(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
    }
    const { text } = body as Record<string, unknown>;
    if (!isNonEmptyString(text)) {
      return new NextResponse(JSON.stringify({ error: "text is required" }), { status: 400 });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return new NextResponse(JSON.stringify({ error: "text is too long" }), { status: 413 });
    }

    const client = await getReportsDbClient();
    try {
      const { result } = await analyzeArchiveOnServer(client, text);
      return new NextResponse(JSON.stringify({ result }), { status: 200, headers: { "Content-Type": "application/json" } });
    } finally {
      client.close();
    }
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }), { status: 500 });
  }
}
