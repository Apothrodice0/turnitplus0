/**
 * A3 — the narrow outbound-mail interface for email verification.
 *
 * SCOPE: this phase establishes the interface and a FAIL-CLOSED default. It
 * ships NO provider SDK (no Resend / SendGrid / Postmark / SES), sends NO real
 * mail, and — critically — the default/production implementation THROWS rather
 * than pretending a message was delivered. A real provider is chosen and wired
 * in a separate, separately-reviewed step so that no secret or environment
 * change happens as a side effect of this foundation.
 *
 * PRIVACY: no implementation here (default or test) may log the verification
 * URL, the raw token it carries, or the recipient address. The raw token is a
 * bearer credential; a log line containing it is a credential leak.
 */

/** The only message kind A3 defines. `expiresAt` is epoch-ms. */
export type EmailVerificationMessage = {
  /** The recipient — always the account's own current, lowercased users.email. */
  to: string;
  /** Absolute URL the recipient opens to prove mailbox control. Carries the raw token. */
  verificationUrl: string;
  /** When the challenge behind `verificationUrl` stops being valid (epoch-ms). */
  expiresAt: number;
};

/** The narrow interface a real provider will implement later. */
export interface EmailDeliveryProvider {
  sendEmailVerification(message: EmailVerificationMessage): Promise<void>;
}

/**
 * Thrown by the default provider. Callers translate this into a generic
 * "couldn't send right now" response — they must NOT surface "no provider
 * configured" to end users, and must NOT treat a throw as success.
 */
export class EmailDeliveryUnavailableError extends Error {
  constructor(message = "No email delivery provider is configured.") {
    super(message);
    this.name = "EmailDeliveryUnavailableError";
  }
}

/**
 * The default. Fails closed: every send throws. This is deliberate — an A3
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

/** TEST ONLY: inject a fake provider (or pass null to restore the fail-closed default). */
export function __setEmailDeliveryProviderForTest(provider: EmailDeliveryProvider | null): void {
  testProvider = provider;
}

/**
 * Resolve the active provider. Returns the injected test provider when one is
 * set, otherwise the fail-closed default. There is intentionally no env-var
 * branch here yet — provider selection is the separate, later step.
 */
export function getEmailDeliveryProvider(): EmailDeliveryProvider {
  return testProvider ?? unconfiguredProvider;
}
