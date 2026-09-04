import { isResendConfigured, resendEmailDeliveryProvider } from "./resend-email-provider";

/**
 * A3 / A3b — the narrow outbound-mail interface for email verification.
 *
 * A3 shipped NO provider and a FAIL-CLOSED default (the default/production
 * implementation THROWS rather than pretending a message was delivered). A3b
 * wires a real provider (Resend, lib/mail/resend-email-provider.ts) behind
 * this same interface, selected only when its configuration is present —
 * absent configuration still falls back to the fail-closed default, so a
 * deployment with no Resend credentials behaves exactly like base A3 did.
 *
 * PRIVACY: no implementation here (default, Resend, or test) may log the
 * raw 6-digit code or the recipient address. The raw code is a bearer
 * credential; a log line containing it is a credential leak.
 */

/** The only message kind A3/A3b defines. `expiresAt` is epoch-ms. */
export type EmailVerificationMessage = {
  /** The recipient — always the account's own current, lowercased users.email. */
  to: string;
  /** The raw, never-persisted 6-digit code (see lib/email-verification.ts). Handed to the provider ONLY. */
  code: string;
  /** When this code stops being valid (epoch-ms). */
  expiresAt: number;
};

/** The narrow interface a real provider implements. */
export interface EmailDeliveryProvider {
  sendEmailVerification(message: EmailVerificationMessage): Promise<void>;
}

/**
 * Thrown by the default provider (and translated to by a failing real
 * provider). Callers translate this into a generic "couldn't send right now"
 * response — they must NOT surface "no provider configured" to end users, and
 * must NOT treat a throw as success.
 */
export class EmailDeliveryUnavailableError extends Error {
  constructor(message = "No email delivery provider is configured.") {
    super(message);
    this.name = "EmailDeliveryUnavailableError";
  }
}

/**
 * The fallback. Fails closed: every send throws. This is deliberate — a
 * deployment with no provider configured must be unable to complete an email
 * verification, not silently "succeed" with a message that went nowhere.
 */
const unconfiguredProvider: EmailDeliveryProvider = {
  async sendEmailVerification(): Promise<void> {
    throw new EmailDeliveryUnavailableError();
  },
};

// Test seam — mirrors lib/ror-client.ts's __setRorClientFetchForTest. Only a
// test ever sets this; no production code path does.
let testProvider: EmailDeliveryProvider | null = null;

/** TEST ONLY: inject a fake provider (or pass null to restore the fail-closed default / real-provider resolution). */
export function __setEmailDeliveryProviderForTest(provider: EmailDeliveryProvider | null): void {
  testProvider = provider;
}

/**
 * Resolve the active provider. Returns the injected test provider when one is
 * set; otherwise Resend when it's configured (RESEND_API_KEY +
 * EMAIL_VERIFICATION_FROM_ADDRESS both present); otherwise the fail-closed
 * default. Re-checked on every call (not cached) so env changes and the test
 * seam both take effect immediately — deliberately the same "read at call
 * time" discipline as lib/email-verification.ts's
 * emailVerificationCodeSecretConfigured().
 */
export function getEmailDeliveryProvider(): EmailDeliveryProvider {
  if (testProvider) return testProvider;
  return isResendConfigured() ? resendEmailDeliveryProvider : unconfiguredProvider;
}
