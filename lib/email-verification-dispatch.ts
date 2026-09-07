import type { GeneratedEmailVerificationChallenge } from "./email-verification";
import { getEmailDeliveryProvider } from "./mail/email-delivery";

/**
 * A3 / A3b — hand a freshly generated challenge to the mail-delivery layer.
 * This is the ONLY place the raw code is read off a challenge and passed to
 * the provider, and it is passed straight through without being logged or
 * returned.
 *
 * Throws whatever the provider throws (in practice always
 * EmailDeliveryUnavailableError — see lib/mail/email-delivery.ts). Callers
 * translate a throw into a generic "couldn't send right now" response and
 * MUST NOT treat it as success.
 */
export async function dispatchEmailVerificationMessage(
  challenge: GeneratedEmailVerificationChallenge,
  toEmail: string,
): Promise<void> {
  const provider = getEmailDeliveryProvider();
  await provider.sendEmailVerification({
    to: toEmail,
    code: challenge.rawCode,
    expiresAt: challenge.expiresAt,
  });
}
