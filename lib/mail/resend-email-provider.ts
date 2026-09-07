import type { EmailDeliveryProvider, EmailVerificationMessage } from "./email-delivery";
import { EmailDeliveryUnavailableError } from "./email-delivery";

/**
 * A3b — Resend HTTP delivery for the email-verification code
 * (https://resend.com/docs/api-reference/emails/send-email). A direct
 * server-side fetch, not the `resend` SDK: the request is one small, static
 * JSON POST, so a dependency buys nothing here (matches lib/ror-client.ts /
 * lib/openalex-check.ts, which also call public HTTP APIs directly).
 *
 * Configuration is read from process.env at CALL time, not module load —
 * same discipline as lib/email-verification.ts's
 * emailVerificationCodeSecretConfigured() — so a test can flip env vars
 * between calls and a cold-started serverless instance never caches a
 * stale/missing value. Both RESEND_API_KEY and
 * EMAIL_VERIFICATION_FROM_ADDRESS are server-only: never referenced from any
 * "use client" file, never returned in a response body.
 *
 * Fails closed: any missing config, network error, timeout, or non-2xx
 * response throws EmailDeliveryUnavailableError — never the underlying
 * provider error (which could carry the API key's owning account, request
 * ids, or other Resend-internal detail) — and is never treated as success by
 * a caller.
 */

const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_TIMEOUT_MS = 8_000;

export function isResendConfigured(): boolean {
  return !!process.env.RESEND_API_KEY && !!process.env.EMAIL_VERIFICATION_FROM_ADDRESS;
}

// Test seam — mirrors lib/ror-client.ts's __setRorClientFetchForTest. Only a
// test ever sets this; no production code path does.
let fetchImplForTest: typeof fetch | null = null;
export function __setResendFetchForTest(impl: typeof fetch | null): void {
  fetchImplForTest = impl;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Simple branded TurnitPlus verification email: the code prominently, plain
 * expiry wording, no raw internal ids, no link, no token. `expiresAt` is
 * rendered as a relative minute count rather than an absolute timestamp so
 * the message never needs the recipient's timezone.
 */
function renderVerificationEmail(code: string, expiresAt: number): { subject: string; html: string; text: string } {
  const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
  const safeCode = escapeHtml(code);
  const subject = "Your TurnitPlus verification code";
  const text = `Your TurnitPlus verification code is ${code}.\n\nThis code expires in ${minutes} minutes. If you didn't request this, you can safely ignore this email.`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#1c2a30;">
<p style="font-weight:700;font-size:15px;margin:0 0 18px;">TurnitPlus</p>
<p style="margin:0 0 8px;font-size:13px;">Your verification code is:</p>
<p style="font-size:32px;font-weight:800;letter-spacing:6px;margin:0 0 16px;">${safeCode}</p>
<p style="margin:0;font-size:12px;color:#5b6b72;">This code expires in ${minutes} minutes. If you didn't request this, you can safely ignore this email.</p>
</div>`;
  return { subject, html, text };
}

export const resendEmailDeliveryProvider: EmailDeliveryProvider = {
  async sendEmailVerification(message: EmailVerificationMessage): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_VERIFICATION_FROM_ADDRESS;
    if (!apiKey || !from) throw new EmailDeliveryUnavailableError();

    const { subject, html, text } = renderVerificationEmail(message.code, message.expiresAt);
    const fetchImpl = fetchImplForTest ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetchImpl(RESEND_API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: message.to, subject, html, text }),
        signal: controller.signal,
      });
      if (!response.ok) {
        console.error(`resend email delivery failed: HTTP ${response.status}`);
        throw new EmailDeliveryUnavailableError();
      }
    } catch (err) {
      if (err instanceof EmailDeliveryUnavailableError) throw err;
      if (!isAbortError(err)) {
        console.error("resend email delivery failed (non-fatal, translated):", err instanceof Error ? err.message : String(err));
      }
      throw new EmailDeliveryUnavailableError();
    } finally {
      clearTimeout(timer);
    }
  },
};
