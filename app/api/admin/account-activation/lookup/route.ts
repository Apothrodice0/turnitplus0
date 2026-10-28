import { adminJsonResponse } from '../../../../../lib/admin-http';
import { openAccountActivationRequest } from '../../../../../lib/account-activation-http';
import { canonicalizeAccountEmail, isValidAccountEmail, lookupCustomerAccount, MAX_EMAIL_LENGTH } from '../../../../../lib/account-activation-admin';
import { accountActivationEnforced } from '../../../../../lib/account-entitlements';

/**
 * Admin-only: find ONE customer account by its exact, canonical email (trim + lowercase, the signup/login rule) and
 * return what the admin must see before granting anything — identity, registration date, email verification, current
 * plan, busy rooms and recent plan history. Never a password hash, session, device key or manuscript. POST (not GET)
 * so a customer's email never appears in a URL or access log.
 */
export async function POST(request: Request) {
  try {
    const opened = await openAccountActivationRequest(request, { stateChanging: true });
    if ('response' in opened) return opened.response;
    const { client } = opened;
    try {
      const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
      if (!body || typeof body.email !== 'string' || body.email.length > MAX_EMAIL_LENGTH) {
        return adminJsonResponse({ error: 'Enter the customer’s email address.' }, 400);
      }
      const email = canonicalizeAccountEmail(body.email);
      if (!isValidAccountEmail(email)) return adminJsonResponse({ error: 'Enter a valid email address, like customer@example.com.' }, 400);

      const lookup = await lookupCustomerAccount(client, email);
      if ('conflict' in lookup) return adminJsonResponse({ error: 'More than one account has this email — refusing to guess.' }, 409);
      return adminJsonResponse({ ...lookup, enforcement: accountActivationEnforced() }, 200);
    } finally {
      client.close();
    }
  } catch (err) {
    return adminJsonResponse({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
}
