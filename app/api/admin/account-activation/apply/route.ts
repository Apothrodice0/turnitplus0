import { adminJsonResponse } from '../../../../../lib/admin-http';
import { getReportsDbClient } from '../../../../../lib/reports-db';
import { openAccountActivationRequest } from '../../../../../lib/account-activation-http';
import {
  actionGrantsAccess,
  applyActivationAction,
  canonicalizeAccountEmail,
  countBusyRoomsAtOrAbove,
  isActivationAction,
  isValidAccountEmail,
  isValidOperationId,
  lookupCustomerAccount,
  MAX_EMAIL_LENGTH,
  planActivationChange,
  resolveAccountId,
  UNVERIFIED_EMAIL_ERROR,
} from '../../../../../lib/account-activation-admin';
import { planStateOf } from '../../../../../lib/account-plan';

/**
 * Admin-only: preview (dryRun: true) or apply one plan change — activate, renew, adjust_rooms, suspend, reactivate —
 * to ONE customer account named by its exact email. Authority is the admin session alone (lib/account-activation-http.ts);
 * the body only selects the target and the change, and every value in it is validated here and re-validated inside the
 * transaction (lib/account-activation-admin.ts).
 *
 *  - dryRun: true  -> the exact change the server would make right now (server clock), with the plan version to
 *                     confirm against. Zero writes.
 *  - dryRun: false -> requires operationId (a UUID the console generates once per confirmation), expectedVersion and
 *                     expectedUserId (both from the preview): the change applies only to the account that was reviewed. Answered 200 only after the plan and its audit row have committed; a repeat
 *                     of the same operationId is answered from the stored result ("replayed") and changes nothing.
 */
export async function POST(request: Request) {
  try {
    const opened = await openAccountActivationRequest(request, { stateChanging: true });
    if ('response' in opened) return opened.response;
    const { admin, client } = opened;
    try {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') return adminJsonResponse({ error: 'Invalid JSON' }, 400);
      if (typeof body.email !== 'string' || body.email.length > MAX_EMAIL_LENGTH) return adminJsonResponse({ error: 'Enter the customer’s email address.' }, 400);
      const email = canonicalizeAccountEmail(body.email);
      if (!isValidAccountEmail(email)) return adminJsonResponse({ error: 'Enter a valid email address, like customer@example.com.' }, 400);
      if (!isActivationAction(body.action)) return adminJsonResponse({ error: 'Unknown action.' }, 400);
      if (typeof body.dryRun !== 'boolean') return adminJsonResponse({ error: 'dryRun must be true or false.' }, 400);
      const input = { action: body.action, planDays: body.planDays, rooms: body.rooms, reason: body.reason };

      if (body.dryRun) {
        const now = Date.now();
        const lookup = await lookupCustomerAccount(client, email, now);
        if ('conflict' in lookup) return adminJsonResponse({ error: 'More than one account has this email — refusing to guess.' }, 409);
        if (!lookup.found) return adminJsonResponse({ error: 'No account found for this email. Ask the customer to register first.', code: 'NOT_FOUND' }, 404);
        if (lookup.account.isAdmin) return adminJsonResponse({ error: 'Administrator accounts are never restricted and do not need activation.', code: 'ADMIN_ACCOUNT' }, 409);
        if (actionGrantsAccess(body.action) && lookup.account.emailVerified !== true) {
          return adminJsonResponse({ error: UNVERIFIED_EMAIL_ERROR, code: 'UNVERIFIED_EMAIL' }, 409);
        }
        const planned = planActivationChange(lookup.entitlement, input, now);
        if (!planned.ok) return adminJsonResponse({ error: planned.error }, planned.status);
        let busyRoomsAboveNewCount = 0;
        if (planned.previous && planned.next.rooms < planned.previous.rooms) {
          const accountId = await resolveAccountId(client, email);
          if (accountId) busyRoomsAboveNewCount = await countBusyRoomsAtOrAbove(client, accountId, planned.next.rooms, now);
        }
        return adminJsonResponse(
          {
            preview: {
              action: planned.action,
              account: lookup.account,
              previous: planned.previous,
              previousState: lookup.state,
              next: planned.next,
              nextState: planStateOf(planned.next, now),
              extensionStartsAt: planned.extensionStartsAt,
              reason: planned.reason,
              busyRoomsAboveNewCount,
              expectedVersion: lookup.entitlement?.version ?? 0,
              expectedUserId: lookup.account.userId,
              serverNow: now,
            },
          },
          200,
        );
      }

      if (!isValidOperationId(body.operationId)) return adminJsonResponse({ error: 'operationId must be a UUID.' }, 400);
      if (typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 0) {
        return adminJsonResponse({ error: 'expectedVersion is required — review the change first.' }, 400);
      }
      if (typeof body.expectedUserId !== 'string' || body.expectedUserId.length === 0 || body.expectedUserId.length > 64) {
        return adminJsonResponse({ error: 'expectedUserId is required — review the change first.' }, 400);
      }
      const result = await applyActivationAction(() => getReportsDbClient(), admin, {
        ...input,
        email,
        expectedUserId: body.expectedUserId,
        operationId: body.operationId,
        expectedVersion: body.expectedVersion,
      });
      if (result.outcome === 'rejected') {
        return adminJsonResponse({ error: result.error, ...(result.code ? { code: result.code } : {}) }, result.status);
      }
      return adminJsonResponse(result, 200);
    } finally {
      client.close();
    }
  } catch (err) {
    return adminJsonResponse({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
}
