import type { GeneratedEmailVerificationChallenge } from "./email-verification";
import { getEmailDeliveryProvider } from "./mail/email-delivery";
import { emailVerificationUrl } from "./request-origin";

/**
 * A3 — hand a freshly generated challenge to the mail-delivery layer. This is
 * the ONLY place the raw token becomes a URL, and it is passed straight to the
 * provider without being logged or returned.
 *
 * Throws whatever the provider throws — in A3 the default provider always
 * throws EmailDeliveryUnavailableError (fail-closed; no real mail is sent).
 * Callers translate a throw into a generic "couldn't send right now" response
 * and MUST NOT treat it as success.
 */
export async function dispatchEmailVerificationMessage(
  challenge: GeneratedEmailVerificationChallenge,
  toEmail: string,
  baseUrl: string,
): Promise<void> {
  const provider = getEmailDeliveryProvider();
  await provider.sendEmailVerification({
    to: toEmail,
    verificationUrl: emailVerificationUrl(baseUrl, challenge.rawToken),
    expiresAt: challenge.expiresAt,
  });
}
