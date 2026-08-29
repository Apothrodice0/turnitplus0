import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { isSameOriginRequest } from '../../../../lib/same-origin';
import {
  isDevicePassportEnabled,
  parseAndValidateSpki,
  derivePassportId,
  DEVICE_PASSPORT_ALGORITHM,
  MAX_SPKI_BASE64_LENGTH,
} from '../../../../lib/device-passport-server';
import { isDurableActorTrackingAvailable } from '../../../../lib/device-passport-actor-ledger';

/**
 * Device Passport — Phase 2. POST /api/device-passport/register: a browser
 * registers its ECDSA P-256 public key once, on first visit. Idempotent
 * (device_passports.id = sha256(SPKI DER), ON CONFLICT DO NOTHING). The
 * private key never leaves the browser; only the raw SPKI DER is stored,
 * solely to verify signatures later.
 *
 * Fails closed / inert when DEVICE_PASSPORT_ENABLED is not "true": a generic
 * 404, identical to a non-existent route, so a probe cannot tell the feature
 * apart from "not deployed". Same 404 for a cross-origin request. Never
 * returns the derived passport id (the client does not need it — the server
 * re-derives it from the key on every verification).
 *
 * last_seen_at is NOT touched here — it is set only on a fully verified
 * attestation (lib/device-passport-server.ts's verifyDevicePassportAttestation),
 * so it reflects genuine use, not arbitrary registration.
 *
 * actor_usage_tracking_version (drizzle/0041): a BRAND-NEW passport is born at
 * 1 only when durable actor tracking is available right now (the dedicated
 * actor HMAC key is set — isDurableActorTrackingAvailable()); otherwise it is
 * born at 0 and can never later be treated as complete evidence. An EXISTING
 * passport reached via ON CONFLICT(id) DO NOTHING keeps its stored tracking
 * version EXACTLY — re-registration never promotes 0 -> 1.
 */

export const dynamic = 'force-dynamic';

function notFound() {
  return new NextResponse(JSON.stringify({ error: 'Not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(request: Request) {
  try {
    if (!isDevicePassportEnabled()) return notFound();
    if (!isSameOriginRequest(request)) return notFound();

    const rate = await checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return new NextResponse(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
    }
    const { publicKeySpki } = body as Record<string, unknown>;
    if (typeof publicKeySpki !== 'string' || publicKeySpki.length === 0 || publicKeySpki.length > MAX_SPKI_BASE64_LENGTH) {
      return new NextResponse(JSON.stringify({ error: 'publicKeySpki is required' }), { status: 400 });
    }
    const parsed = parseAndValidateSpki(publicKeySpki);
    if (!parsed) {
      return new NextResponse(JSON.stringify({ error: 'publicKeySpki is not a valid EC P-256 SubjectPublicKeyInfo' }), { status: 400 });
    }

    const client = await getReportsDbClient();
    try {
      await client.execute({
        sql: `INSERT INTO device_passports (id, public_key_spki, algorithm, created_at, last_seen_at, revoked_at, provenance_generation, actor_usage_tracking_version)
              VALUES (?,?,?,?,NULL,NULL,0,?)
              ON CONFLICT(id) DO NOTHING`,
        args: [
          derivePassportId(parsed.spkiDer),
          parsed.spkiDer,
          DEVICE_PASSPORT_ALGORITHM,
          Date.now(),
          isDurableActorTrackingAvailable() ? 1 : 0,
        ],
      });
    } finally {
      client.close();
    }

    return new NextResponse(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
