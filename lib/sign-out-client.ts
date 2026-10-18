import type { AccountHydrationResult } from "./local-report-session";

// Truthful browser sign-out (security fix). app/page.tsx's signOutAccount()
// used to clear the page, fire POST /api/auth/logout without awaiting it,
// swallow every error and always announce "You have signed out." — so a 429,
// a 5xx, a network failure or a Deployment Protection redirect all looked
// exactly like a real sign-out while the server session stayed valid. The
// decision logic lives here, free of React, so it can be tested directly.

export type ServerSignOutResult =
  | { status: "signed-out"; revoked: boolean }
  | { status: "failed"; reason: "rate-limited" | "server" | "network"; retryAfterSeconds: number | null };

export type SignOutOutcome = "signed-out" | "still-signed-in" | "unknown";

export type SignOutDeps = {
  request: () => Promise<ServerSignOutResult>;
  /** GET /api/auth/me, classified (lib/local-report-session.ts's fetchAccountHydration — never throws). */
  recheck: () => Promise<AccountHydrationResult>;
  /** Clears this tab's account state, purges its local report copies and only THEN tells other tabs. */
  completeSignOut: () => void;
  keepSignedIn: (state: Extract<AccountHydrationResult, { status: "signed-in" }>) => void;
  notify: (message: string) => void;
};

export const SIGN_OUT_REQUEST_TIMEOUT_MS = 15_000;

export const SIGN_OUT_MESSAGES = {
  revoked: "You have signed out.",
  noActiveSession: "You are signed out. No active session was found for this browser on this site.",
  confirmedByRecheck: "You are signed out.",
  unconfirmed: "Sign-out could not be confirmed. You may still be signed in — please try again.",
} as const;

export function signOutFailureMessage(result: Extract<ServerSignOutResult, { status: "failed" }>): string {
  if (result.reason === "rate-limited") {
    const wait = result.retryAfterSeconds !== null ? ` in ${result.retryAfterSeconds} seconds` : " shortly";
    return `Sign-out did not complete — you are still signed in. Please try again${wait}.`;
  }
  if (result.reason === "network") return "Sign-out could not reach the server — you are still signed in. Please try again.";
  return "Sign-out did not complete — you are still signed in. Please try again.";
}

/**
 * POST /api/auth/logout, classified. "signed-out" ONLY for a 200 whose JSON
 * body is the route's own confirmation ({ok:true, revoked:boolean}); anything
 * else — 429, 5xx, a non-JSON page (e.g. a Deployment Protection sign-in
 * page after a redirect), a timeout or a network error — is a failure.
 */
export async function requestServerSignOut(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = SIGN_OUT_REQUEST_TIMEOUT_MS,
): Promise<ServerSignOutResult> {
  let response: Response;
  try {
    response = await fetchImpl("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { status: "failed", reason: "network", retryAfterSeconds: null };
  }
  if (response.status === 429) {
    const retryAfter = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
    return { status: "failed", reason: "rate-limited", retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null };
  }
  if (response.status !== 200) return { status: "failed", reason: "server", retryAfterSeconds: null };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "failed", reason: "server", retryAfterSeconds: null };
  }
  if (body && typeof body === "object" && (body as { ok?: unknown }).ok === true && typeof (body as { revoked?: unknown }).revoked === "boolean") {
    return { status: "signed-out", revoked: (body as { revoked: boolean }).revoked };
  }
  return { status: "failed", reason: "server", retryAfterSeconds: null };
}

/**
 * Success is announced, and other tabs are told, only after the server
 * confirmed the sign-out — or, when the logout request failed, after
 * /api/auth/me confirmed this browser no longer has a valid session. On a
 * failure the real state is rechecked: a still-valid session keeps the page
 * signed in with a truthful error; an indeterminate recheck changes nothing.
 */
export async function performSignOut(deps: SignOutDeps): Promise<SignOutOutcome> {
  const result = await deps.request();
  if (result.status === "signed-out") {
    deps.completeSignOut();
    deps.notify(result.revoked ? SIGN_OUT_MESSAGES.revoked : SIGN_OUT_MESSAGES.noActiveSession);
    return "signed-out";
  }
  const state = await deps.recheck();
  if (state.status === "signed-out") {
    deps.completeSignOut();
    deps.notify(SIGN_OUT_MESSAGES.confirmedByRecheck);
    return "signed-out";
  }
  if (state.status === "signed-in") {
    deps.keepSignedIn(state);
    deps.notify(signOutFailureMessage(result));
    return "still-signed-in";
  }
  deps.notify(SIGN_OUT_MESSAGES.unconfirmed);
  return "unknown";
}

/** At most one sign-out in flight: a repeated click joins the running attempt instead of sending a second request. */
export function createSignOutRunner() {
  let inFlight: Promise<SignOutOutcome> | null = null;
  return {
    run(deps: SignOutDeps): Promise<SignOutOutcome> {
      if (!inFlight) {
        inFlight = performSignOut(deps).finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
    isRunning(): boolean {
      return inFlight !== null;
    },
  };
}
