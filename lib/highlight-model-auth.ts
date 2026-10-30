import { createSign } from "node:crypto";

/**
 * HIGHLIGHT MODEL SERVICE IDENTITY — a Google-signed ID token for a private Cloud Run service, sent in
 * X-Serverless-Authorization so Google turns strangers away before an instance starts. Our own bearer key still travels
 * in Authorization, untouched, and the service checks it too.
 *
 * Off unless HIGHLIGHT_MODEL_AUDIENCE (the service URL, no path) and HIGHLIGHT_MODEL_SERVICE_ACCOUNT (the service
 * account's JSON key, plain or base64) are both set; a local sidecar needs neither. The account should hold only
 * roles/run.invoker on that one service. The token is minted with the account's key (RS256 JWT exchanged at Google's
 * token endpoint) and kept until five minutes before it expires; neither the key nor the token is ever logged.
 */
export type ServiceIdentity = { audience: string; clientEmail: string; privateKey: string; tokenUri: string };

const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
const TOKEN_LIFETIME_S = 3600;
const REFRESH_MARGIN_MS = 5 * 60_000;

/** null when unset; "INVALID" when set but unusable, which keeps the model off rather than calling it without identity. */
export function serviceIdentityFromEnv(env: NodeJS.ProcessEnv = process.env): ServiceIdentity | null | "INVALID" {
  const audience = (env.HIGHLIGHT_MODEL_AUDIENCE ?? "").trim();
  const raw = (env.HIGHLIGHT_MODEL_SERVICE_ACCOUNT ?? "").trim();
  if (!audience && !raw) return null;
  if (!/^https:\/\/[^/\s]+$/.test(audience) || !raw) return "INVALID";
  try {
    const json = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8")) as Record<string, unknown>;
    const clientEmail = json.client_email, privateKey = json.private_key;
    if (typeof clientEmail !== "string" || typeof privateKey !== "string" || !privateKey.includes("PRIVATE KEY")) return "INVALID";
    const tokenUri = typeof json.token_uri === "string" && json.token_uri.startsWith("https://") ? json.token_uri : GOOGLE_TOKEN_URI;
    return { audience, clientEmail, privateKey, tokenUri };
  } catch {
    return "INVALID";
  }
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

let cached: { audience: string; clientEmail: string; token: string; expiresAtMs: number } | null = null;

export function forgetServiceIdentityToken(): void {
  cached = null;
}

/** Throws { retryable } errors like the model client: Google refusing the key cannot be fixed by asking again. */
export async function serviceIdentityToken(identity: ServiceIdentity, fetchImpl: typeof fetch, nowMs = Date.now()): Promise<string> {
  if (cached && cached.audience === identity.audience && cached.clientEmail === identity.clientEmail && cached.expiresAtMs - REFRESH_MARGIN_MS > nowMs) return cached.token;
  const iat = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: identity.clientEmail, sub: identity.clientEmail, aud: identity.tokenUri, iat, exp: iat + TOKEN_LIFETIME_S, target_audience: identity.audience }));
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(identity.privateKey, "base64url");
  const response = await fetchImpl(identity.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${signature}` }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw Object.assign(new Error(`ID_TOKEN_HTTP_${response.status}`), { retryable: response.status === 429 || response.status >= 500 });
  const token = ((await response.json().catch(() => null)) as { id_token?: unknown } | null)?.id_token;
  if (typeof token !== "string" || token.split(".").length !== 3) throw Object.assign(new Error("ID_TOKEN_BAD_RESPONSE"), { retryable: true });
  cached = { audience: identity.audience, clientEmail: identity.clientEmail, token, expiresAtMs: nowMs + TOKEN_LIFETIME_S * 1000 };
  return token;
}
