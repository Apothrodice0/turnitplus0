import { getVercelOidcToken } from "@vercel/oidc";
import type { SessionUser } from "./auth-session";

/**
 * ENGLISH SYSTEM 2 — owner-only RESEARCH preview (server-side only).
 *
 * A research-only, conservative statistical estimate of Turnitin-like similarity (0–20%) produced by the frozen
 * Model A + the accepted fixed −4.5-point conservative postprocessor v1. It is NOT similarity evidence, never
 * changes System 1 scores, AI results, persisted reports or source attribution, and is never stored.
 *
 * The model artifacts are NOT part of this (public) repository or of this deployment: inference runs in a separate,
 * protected private backend reached server-to-server. Everything below is configured through server-only
 * environment variables — none of them is ever sent to the browser:
 *
 *   S2_RESEARCH_ENABLED      "1" to enable. Anything else (or unset) = feature off everywhere.
 *   S2_RESEARCH_OWNER_EMAILS comma-separated allowlist of account emails (case-insensitive). Empty = nobody.
 *   S2_INFERENCE_URL         https URL of the private inference endpoint (…/api/analyze).
 *   S2_INFERENCE_KEY         bearer key the inference endpoint requires (>= 32 chars).
 *   S2_INFERENCE_BYPASS      optional fallback only (owner approval required): the backend's "protection bypass for
 *                            automation" secret. Not needed when Trusted Sources is configured.
 *
 * Reaching the protected backend: Vercel Trusted Sources. The backend project lists this project as a trusted Vercel
 * project (Preview → Preview only), and every call carries this deployment's short-lived Vercel OIDC token in the
 * documented `x-vercel-trusted-oidc-idp-token` header. The backend's own bearer key is still required on top.
 *
 * The feature is ALWAYS off in the production environment (VERCEL_ENV=production): this research preview is
 * only for protected Preview deployments.
 */

export const SYSTEM2_MAX_UPLOAD_BYTES = 4_000_000; // below Vercel's 4.5 MB request-body limit
export const SYSTEM2_CONSENT_HEADER = "x-s2-consent";
export const SYSTEM2_CONSENT_VALUE = "granted";
const INFERENCE_TIMEOUT_MS = 30_000;

export type System2Config = {
  enabled: boolean;
  ownerEmails: string[];
  inferenceUrl: string | null;
  inferenceKey: string | null;
  bypassSecret: string | null;
};

export function system2Config(env: NodeJS.ProcessEnv = process.env): System2Config {
  const enabledFlag = env.S2_RESEARCH_ENABLED === "1" && env.VERCEL_ENV !== "production";
  const ownerEmails = (env.S2_RESEARCH_OWNER_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 3 && e.includes("@"));
  const url = (env.S2_INFERENCE_URL ?? "").trim();
  const inferenceUrl = /^https:\/\/[^\s]+$/.test(url) || /^http:\/\/127\.0\.0\.1:\d+\/[^\s]*$/.test(url) ? url : null;
  const key = (env.S2_INFERENCE_KEY ?? "").trim();
  const bypass = (env.S2_INFERENCE_BYPASS ?? "").trim();
  return {
    enabled: enabledFlag && ownerEmails.length > 0 && inferenceUrl !== null && key.length >= 32,
    ownerEmails,
    inferenceUrl,
    inferenceKey: key.length >= 32 ? key : null,
    bypassSecret: bypass.length > 0 ? bypass : null,
  };
}

/** True only for an authenticated account on the explicit owner allowlist, with the feature fully configured. */
export function isSystem2ResearchUser(user: Pick<SessionUser, "email"> | null | undefined, config: System2Config = system2Config()): boolean {
  if (!config.enabled || !user || typeof user.email !== "string") return false;
  return config.ownerEmails.includes(user.email.trim().toLowerCase());
}

/** The only fields ever returned to the browser (the backend's full response is never passed through). */
const RESULT_FIELDS = [
  "state", "estimate_shown", "research_only", "label", "conservative_estimate_percent", "final_text", "warnings",
  "language_check", "report_category", "report_signals", "analyzable_words", "diagnostics",
] as const;

export type System2Result = Partial<Record<(typeof RESULT_FIELDS)[number], unknown>> & { state: string; estimate_shown: boolean; final_text: string };

export function sanitizeSystem2Result(raw: unknown): System2Result | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.state !== "string" || typeof r.final_text !== "string" || typeof r.estimate_shown !== "boolean") return null;
  if (r.estimate_shown) {
    const p = r.conservative_estimate_percent;
    if (typeof p !== "number" || !Number.isInteger(p) || p < 0 || p > 20) return null;
  }
  const out: Record<string, unknown> = {};
  for (const k of RESULT_FIELDS) if (k in r) out[k] = r[k];
  out.research_only = true;
  return out as System2Result;
}

/** Local refusals (identical wording to the accepted local tester) — the document is never transmitted for these. */
export function localSystem2Refusal(extension: string, byteLength: number, firstBytes: Uint8Array): System2Result | null {
  const label = "RESEARCH-ONLY ESTIMATED TURNITIN-LIKE SIMILARITY - not a verified Turnitin result";
  const refuse = (state: string, final_text: string): System2Result => ({ state, final_text, estimate_shown: false, research_only: true, label });
  if (byteLength <= 0) return refuse("NO_FILE", "No readable file was selected.");
  if (byteLength > SYSTEM2_MAX_UPLOAD_BYTES) return refuse("TOO_LARGE", `File too large for this test (${byteLength.toLocaleString("en-US")} bytes; maximum ${SYSTEM2_MAX_UPLOAD_BYTES.toLocaleString("en-US")}). No estimate.`);
  const ext = extension.toLowerCase();
  if (ext === ".pdf") return refuse("REFUSED_PDF", "PDF files are outside the validated English Word (.docx) prediction profile and are not estimated in this local test. Please use the Word version of the manuscript.");
  if (ext !== ".docx") return refuse("UNSUPPORTED_FILE_TYPE", `Unsupported file type '${ext || "(none)"}'. This local test accepts English Word (.docx) manuscripts only.`);
  const isZip = firstBytes.length >= 4 && firstBytes[0] === 0x50 && firstBytes[1] === 0x4b && firstBytes[2] === 0x03 && firstBytes[3] === 0x04;
  if (!isZip) return refuse("NOT_READABLE", "This file could not be processed as a Word manuscript. No estimate.");
  return null;
}

export type OidcTokenProvider = () => Promise<string | null>;

/**
 * This deployment's Vercel OIDC token for Trusted Sources (Vercel docs: getVercelOidcToken from @vercel/oidc). Only
 * requested when running on Vercel (VERCEL=1), where it comes from the function's request context; elsewhere (local
 * tests, builds) it is never requested, so no token refresh is attempted. Never logged, stored or returned.
 */
export const vercelOidcTokenProvider: OidcTokenProvider = async () => {
  if (process.env.VERCEL !== "1") return null;
  try {
    return (await getVercelOidcToken()) || null;
  } catch {
    return null;
  }
};

/** Server-to-server call to the private inference backend. The document bytes are sent only here, only after consent. */
export async function requestSystem2Inference(
  bytes: Uint8Array,
  config: System2Config = system2Config(),
  fetchImpl: typeof fetch = fetch,
  oidcToken: OidcTokenProvider = vercelOidcTokenProvider,
): Promise<System2Result | null> {
  if (!config.enabled || !config.inferenceUrl || !config.inferenceKey) return null;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.inferenceKey}`,
    "X-File-Extension": ".docx",
    "Content-Type": "application/octet-stream",
  };
  const token = await oidcToken();
  if (token) headers["x-vercel-trusted-oidc-idp-token"] = token; // Vercel Trusted Sources (Preview → Preview)
  if (config.bypassSecret) headers["x-vercel-protection-bypass"] = config.bypassSecret; // optional, owner-approved fallback only
  try {
    const body = bytes.slice().buffer; // a plain ArrayBuffer copy (<= 4 MB) satisfies BodyInit for every typed-array backing
    const res = await fetchImpl(config.inferenceUrl, { method: "POST", headers, body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS) });
    if (res.status !== 200) return null;
    return sanitizeSystem2Result(await res.json());
  } catch {
    return null; // never log: the error could carry request details
  }
}
