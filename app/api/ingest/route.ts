import { NextResponse } from 'next/server';

/**
 * Closed (release-hardening audit finding INGEST-01): this endpoint had no
 * authentication, no real schema validation (`body as any`), and a
 * rate limiter that read the attacker-controlled first X-Forwarded-For hop
 * instead of lib/client-ip.ts's hardened resolver — while being reachable
 * by any anonymous caller to write into the production database.
 *
 * No legitimate runtime caller was found anywhere in this codebase before
 * this change: a Graphify call-graph query and an exhaustive grep for any
 * fetch to "/api/ingest" both returned nothing beyond this route's own test
 * file, README documentation, and unrelated comments. The corpus-
 * contribution library this route wrapped (lib/ingest.ts —
 * applyMigrations/ingestDocument/ingestDocumentLibsql) is untouched and
 * remains fully usable directly by offline tooling (tools/build-index.ts
 * and friends); only the public HTTP surface is closed.
 *
 * Every method returns a bare 404 with no body — matching this codebase's
 * own "don't reveal this endpoint exists" convention already used for a
 * failed cron-secret check (see app/api/internal/*-sweep/route.ts) — and
 * this file imports nothing DB-related, so a request here can never reach
 * a database regardless of method, body, or headers.
 */
function closed(): Response {
  return new NextResponse(null, { status: 404 });
}

export async function GET() { return closed(); }
export async function POST() { return closed(); }
export async function PUT() { return closed(); }
export async function PATCH() { return closed(); }
export async function DELETE() { return closed(); }
