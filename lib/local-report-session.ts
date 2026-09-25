import {
  ANONYMOUS_LOCAL_REPORT_OWNER,
  accountLocalReportOwner,
  loadStoredReports,
  purgeStoredReportsExcept,
  storeReport,
} from "./report-store";
import { clearAllAccountsReportRoomCaches } from "./report-rooms-cache";
import { fetchAnonymousDeviceReport, listAnonymousDeviceReportSummaries } from "./reports-remote";

/**
 * Auth-report local-history isolation (browser side).
 *
 * INVARIANT
 *  1. Signed out, this browser shows only local reports explicitly owned by the
 *     anonymous scope (lib/report-store.ts's LocalReportOwner).
 *  2. Signed in, an account sees its server reports and only local records
 *     tagged with its own account key.
 *  3. Account A's local records are never readable as account B or anonymous.
 *  4. Account-owned local records do not survive sign-out, cross-tab sign-out,
 *     account deletion or an account switch (purged here), and readers refuse
 *     them regardless (lib/report-store.ts).
 *  5. Untagged legacy records are never trusted (purged by the v3 upgrade,
 *     refused by every reader).
 *
 * Only a DEFINITIVE signed-out answer from /api/auth/me may enter the
 * anonymous path. A network failure, a non-2xx, or an unreadable body is
 * "indeterminate" and fails closed: no anonymous history, no restore, no
 * purge, and no sign-out either (the session cookie is left untouched).
 */

export type AccountHydrationUser = { username: string; email: string };
export type AccountHydrationEmailVerification = { status: "verified" | "unverified" };

export type AccountHydrationResult =
  | { status: "signed-in"; user: AccountHydrationUser; emailVerification: AccountHydrationEmailVerification | null }
  | { status: "signed-out" }
  | { status: "error" };

/** GET /api/auth/me, classified. `signed-out` ONLY for a 2xx whose body explicitly says `user: null`. */
export async function fetchAccountHydration(fetchImpl: typeof fetch = fetch): Promise<AccountHydrationResult> {
  let body: unknown;
  try {
    const response = await fetchImpl("/api/auth/me");
    if (!response.ok) return { status: "error" };
    body = await response.json();
  } catch {
    return { status: "error" };
  }
  if (!body || typeof body !== "object" || !("user" in body)) return { status: "error" };
  const { user, emailVerification } = body as { user: unknown; emailVerification?: unknown };
  if (user === null) return { status: "signed-out" };
  if (
    user && typeof user === "object" &&
    typeof (user as AccountHydrationUser).email === "string" && (user as AccountHydrationUser).email.length > 0 &&
    typeof (user as AccountHydrationUser).username === "string"
  ) {
    const verification =
      emailVerification && typeof emailVerification === "object" &&
      ((emailVerification as AccountHydrationEmailVerification).status === "verified" || (emailVerification as AccountHydrationEmailVerification).status === "unverified")
        ? (emailVerification as AccountHydrationEmailVerification)
        : null;
    return { status: "signed-in", user: user as AccountHydrationUser, emailVerification: verification };
  }
  return { status: "error" };
}

export type LocalReportPurgeDeps = {
  purgeStoredReportsExcept: typeof purgeStoredReportsExcept;
  clearAllAccountsReportRoomCaches: typeof clearAllAccountsReportRoomCaches;
};
const defaultPurgeDeps: LocalReportPurgeDeps = { purgeStoredReportsExcept, clearAllAccountsReportRoomCaches };

/**
 * Sign-out (this tab or another), account deletion, or a definitive signed-out
 * hydration: every account-owned (and untagged) local record and every
 * account's room cache is removed; only anonymous records remain. Never throws.
 */
export async function purgeLocalReportStateForSignedOut(deps: LocalReportPurgeDeps = defaultPurgeDeps): Promise<void> {
  try {
    deps.clearAllAccountsReportRoomCaches();
  } catch {
    // best-effort
  }
  try {
    await deps.purgeStoredReportsExcept(ANONYMOUS_LOCAL_REPORT_OWNER);
  } catch (error) {
    console.error("Local report purge on sign-out failed (non-fatal):", error instanceof Error ? error.message : String(error));
  }
}

/**
 * A definitive signed-in hydration or a fresh login/signup as `accountEmail`:
 * every local record not owned by this account is removed — other accounts'
 * AND anonymous ones (the login/signup routes claim this device's anonymous
 * server reports for the account, so their anonymous local copies must not
 * outlive the claim) — along with every other account's room cache. Never throws.
 */
export async function purgeLocalReportStateForAccount(accountEmail: string, deps: LocalReportPurgeDeps = defaultPurgeDeps): Promise<void> {
  try {
    deps.clearAllAccountsReportRoomCaches(accountEmail);
  } catch {
    // best-effort
  }
  try {
    await deps.purgeStoredReportsExcept(accountLocalReportOwner(accountEmail));
  } catch (error) {
    console.error("Local report purge on sign-in failed (non-fatal):", error instanceof Error ? error.message : String(error));
  }
}

export type HomeReportHydrationDeps = {
  hydrate: () => Promise<AccountHydrationResult>;
  loadAccountReports: () => Promise<void>;
  loadAnonymousReports: () => Promise<void>;
  onIndeterminate: () => void;
  purgeForAccount?: (accountEmail: string) => Promise<void>;
  purgeForSignedOut?: () => Promise<void>;
};

/**
 * The Home mount's auth -> report-source state machine. Exactly one source,
 * and the anonymous one only after a definitive signed-out answer. Any thrown
 * error is indeterminate too — never a fallback into anonymous loading (the
 * pre-fix behavior, which let a still-valid session's reports be restored
 * into the anonymous history).
 */
export async function hydrateHomeReports(deps: HomeReportHydrationDeps): Promise<AccountHydrationResult["status"]> {
  const purgeForAccount = deps.purgeForAccount ?? ((email: string) => purgeLocalReportStateForAccount(email));
  const purgeForSignedOut = deps.purgeForSignedOut ?? (() => purgeLocalReportStateForSignedOut());
  let result: AccountHydrationResult;
  try {
    result = await deps.hydrate();
  } catch {
    result = { status: "error" };
  }
  try {
    if (result.status === "signed-in") {
      await purgeForAccount(result.user.email);
      await deps.loadAccountReports();
      return "signed-in";
    }
    if (result.status === "signed-out") {
      await purgeForSignedOut();
      await deps.loadAnonymousReports();
      return "signed-out";
    }
  } catch {
    // fall through to fail closed
  }
  deps.onIndeterminate();
  return "error";
}

export type AnonymousHistoryDeps<TEntry, TReport> = {
  loadLocal: () => Promise<TEntry[]>;
  listRemote: () => Promise<Array<{ id: string }>>;
  fetchRemote: (id: string) => Promise<TReport | null>;
  storeLocal: (report: TReport) => Promise<void>;
};

export type AnonymousHistoryResult<TEntry, TReport> =
  | { kind: "local"; entries: TEntry[] }
  | { kind: "restored"; reports: TReport[] };

function defaultAnonymousHistoryDeps<TEntry, TReport>(): AnonymousHistoryDeps<TEntry, TReport> {
  return {
    loadLocal: () => loadStoredReports<TEntry>(11, ANONYMOUS_LOCAL_REPORT_OWNER),
    listRemote: () => listAnonymousDeviceReportSummaries(),
    fetchRemote: (id) => fetchAnonymousDeviceReport<TReport>(id),
    storeLocal: (report) => storeReport(report, ANONYMOUS_LOCAL_REPORT_OWNER),
  };
}

/**
 * The signed-out "ON THIS DEVICE" history: this browser's anonymous-owned
 * local summaries, or — only when there are none — a one-time restore of this
 * device key's still-unclaimed server reports, fetched WITHOUT credentials
 * (so an account's reports can never come back even if a session cookie is
 * still valid) and stored as anonymous-owned. Call only after a definitive
 * signed-out hydration.
 */
export async function loadAnonymousLocalHistory<TEntry, TReport>(
  deps: AnonymousHistoryDeps<TEntry, TReport> = defaultAnonymousHistoryDeps<TEntry, TReport>(),
): Promise<AnonymousHistoryResult<TEntry, TReport>> {
  const entries = await deps.loadLocal();
  if (entries.length > 0) return { kind: "local", entries };
  const summaries = await deps.listRemote();
  const restored: TReport[] = [];
  for (const summary of summaries) {
    const full = await deps.fetchRemote(summary.id);
    if (full) restored.push(full);
  }
  for (const report of restored) {
    try {
      await deps.storeLocal(report);
    } catch (error) {
      console.error("Local anonymous report restore save failed (non-fatal):", error instanceof Error ? error.message : String(error));
    }
  }
  return { kind: "restored", reports: restored };
}
