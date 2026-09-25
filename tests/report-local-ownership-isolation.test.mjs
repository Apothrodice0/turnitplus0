import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createMemoryIndexedDb, createMemoryLocalStorage } from "./helpers/memory-indexeddb.mjs";

// Auth-report local-history isolation (privacy fix). Before it, account-owned
// reports reached the browser's IndexedDB `turnitplus` stores (no owner field),
// logout never purged them, and the signed-out "ON THIS DEVICE" history, the
// signed-out /reports/[id] local fallback and the receipt fallback all read
// them back — manuscript, evidence and AI passages included, across accounts.
//
// These tests drive the REAL modules (lib/report-store.ts, lib/report-rooms-
// cache.ts, lib/reports-remote.ts, lib/report-ai-completion.ts, lib/local-
// report-session.ts) against a deterministic in-memory IndexedDB and a server
// emulator that applies the production routes' own scoping rules
// (app/api/reports/route.ts GET, app/api/reports/[id]/route.ts GET,
// app/api/auth/me/route.ts GET): a request that carries the session cookie is
// answered from the ACCOUNT branch (deviceKey ignored); one without it only
// from `device_key = ? AND user_id IS NULL`. Component wiring (app/page.tsx,
// the report/room shells) has no render harness here, so — like the rest of
// this suite — it is pinned by source assertions.

const idb = createMemoryIndexedDb();
globalThis.indexedDB = idb.factory;
const localStorage = createMemoryLocalStorage();
globalThis.window = { localStorage };

const DEVICE_KEY = "device-under-test";
localStorage.setItem("tp_device_key_v1", DEVICE_KEY);

const server = {
  rows: [],
  cookieSessionUser: null, // the browser's cookie jar: which account's session cookie it holds
  authMe: "ok", // "ok" | "500" | "throw" | "malformed"
  requests: [],
};
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: () => null } };
}
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), "https://turnitplus.test");
  const sendsCookie = init.credentials !== "omit";
  const session = sendsCookie ? server.cookieSessionUser : null;
  server.requests.push({ path: url.pathname, credentials: init.credentials ?? "same-origin", session });
  if (url.pathname === "/api/auth/me") {
    if (server.authMe === "throw") throw new TypeError("Failed to fetch");
    if (server.authMe === "500") return jsonResponse(500, { error: "Internal error" });
    if (server.authMe === "malformed") return jsonResponse(200, { unexpected: true });
    return jsonResponse(200, session ? { user: { username: session, email: `${session}@example.test` }, emailVerification: { status: "verified" } } : { user: null });
  }
  if (url.pathname === "/api/reports") {
    const rows = session
      ? server.rows.filter((row) => row.userId === session)
      : server.rows.filter((row) => row.deviceKey === url.searchParams.get("deviceKey") && row.userId === null);
    return jsonResponse(200, { reports: rows.map((row) => ({ id: row.id, title: row.payload.title, createdAt: row.payload.created })) });
  }
  const match = /^\/api\/reports\/([^/]+)$/.exec(url.pathname);
  if (match) {
    const row = session
      ? server.rows.find((candidate) => candidate.id === match[1] && candidate.userId === session)
      : server.rows.find((candidate) => candidate.id === match[1] && candidate.deviceKey === url.searchParams.get("deviceKey") && candidate.userId === null);
    return row ? jsonResponse(200, { payload: structuredClone(row.payload) }) : jsonResponse(404, { error: "Report not found" });
  }
  return jsonResponse(404, {});
};

const store = await import("../lib/report-store.ts");
const roomsCache = await import("../lib/report-rooms-cache.ts");
const remote = await import("../lib/reports-remote.ts");
const aiCompletion = await import("../lib/report-ai-completion.ts");
const session = await import("../lib/local-report-session.ts");

const { ANONYMOUS_LOCAL_REPORT_OWNER: ANON, accountLocalReportOwner } = store;
const A_EMAIL = "Alice.Admin@Example.test";
const B_EMAIL = "bob@example.test";
const OWNER_A = accountLocalReportOwner(A_EMAIL);
const OWNER_B = accountLocalReportOwner(B_EMAIL);

function fullReport(id, label) {
  return {
    id,
    version: 11,
    submissionId: `sub-${id}`,
    title: `${label} PRIVATE THESIS ${id}`,
    created: `2026-09-2${id % 10}T10:00:00.000Z`,
    score: 37,
    archiveScore: 37,
    aiScore: 62,
    wordCount: 8123,
    scoreBand: "Moderate",
    text: `CONFIDENTIAL MANUSCRIPT OF ${label}`,
    sources: [{ title: `${label} SOURCE CARD`, passages: [{ text: `${label} EVIDENCE PASSAGE` }] }],
    evidenceInterpretation: { passages: [{ text: `${label} INTERPRETED EVIDENCE` }] },
    aiAnalysis: { status: "complete", passages: [{ text: `${label} AI PASSAGE` }] },
  };
}

async function freshProfile() {
  idb.reset();
  for (const key of localStorage.keys()) if (key !== "tp_device_key_v1") localStorage.removeItem(key);
  server.rows = [];
  server.cookieSessionUser = null;
  server.authMe = "ok";
  server.requests = [];
}

function rawText() {
  return JSON.stringify(idb.dump("turnitplus"));
}

test("owner model: anonymous vs normalized account key; no owner fails closed (never defaults to anonymous)", async () => {
  await freshProfile();
  assert.equal(store.localReportOwnerTag(ANON), "anonymous");
  assert.equal(store.localReportOwnerTag(OWNER_A), "account:alice.admin@example.test");
  assert.equal(accountLocalReportOwner("  "), null);
  assert.equal(accountLocalReportOwner(undefined), null);
  await assert.rejects(store.storeReport(fullReport(1, "X"), undefined), /owner is required/);
  await assert.rejects(store.loadStoredReports(11, undefined), /owner is required/);
  await assert.rejects(store.getStoredReportById("1", null), /owner is required/);
  // storeReportBestEffort with no owner writes nothing at all.
  await store.storeReportBestEffort(fullReport(2, "X"), null);
  assert.deepEqual(idb.dump("turnitplus"), {}, "rejected before IndexedDB is even opened");
});

test("1. account A's local copy is readable by A while signed in", async () => {
  await freshProfile();
  await store.storeReport(fullReport(1001, "ACCOUNT_A"), OWNER_A);
  const listed = await store.loadStoredReports(11, OWNER_A);
  assert.deepEqual(listed.map((entry) => entry.title), ["ACCOUNT_A PRIVATE THESIS 1001"]);
  assert.equal("localOwner" in listed[0], false, "the owner tag is storage metadata, never handed to the UI");
  const full = await store.getStoredReportById("1001", OWNER_A);
  assert.equal(full.text, "CONFIDENTIAL MANUSCRIPT OF ACCOUNT_A");
  assert.equal("localOwner" in full, false);
});

test("2/3/4/5. after A signs out: not listed anonymously; direct detail and receipt fallbacks refuse it; manuscript/evidence/AI passages gone", async () => {
  await freshProfile();
  await store.storeReport(fullReport(1001, "ACCOUNT_A"), OWNER_A);
  // Storage-layer filter alone (before any purge): anonymous readers never see A.
  assert.deepEqual(await store.loadStoredReports(11, ANON), []);
  assert.equal(await store.getStoredReportById("1001", ANON), null);

  await session.purgeLocalReportStateForSignedOut();
  assert.deepEqual(await store.loadStoredReports(11, ANON), [], "2: anonymous list");
  assert.equal(await store.getStoredReportById("1001", ANON), null, "3: /reports/[id] signed-out local fallback");
  // 4: the receipt fallback is `remote ?? local`; signed out, the server refuses an account row (404)...
  assert.equal(await remote.fetchRemoteReport("1001"), null);
  // ...and the local half, scoped to the anonymous list's owner, refuses too.
  assert.equal(await store.getStoredReportById("1001", ANON), null, "4: receipt local fallback");
  assert.equal(await store.getStoredReportById("1001", OWNER_A), null, "purged, not merely hidden");
  const raw = rawText();
  for (const secret of ["CONFIDENTIAL MANUSCRIPT OF ACCOUNT_A", "ACCOUNT_A EVIDENCE PASSAGE", "ACCOUNT_A INTERPRETED EVIDENCE", "ACCOUNT_A AI PASSAGE", "ACCOUNT_A PRIVATE THESIS"]) {
    assert.equal(raw.includes(secret), false, `5: "${secret}" must not remain anywhere in this browser's report storage`);
  }
});

test("6/7. A -> sign out -> B signs in: B cannot read A; B signs out: anonymous sees neither", async () => {
  await freshProfile();
  await store.storeReport(fullReport(1001, "ACCOUNT_A"), OWNER_A);
  await session.purgeLocalReportStateForSignedOut();
  await session.purgeLocalReportStateForAccount(B_EMAIL);
  await store.storeReport(fullReport(2002, "ACCOUNT_B"), OWNER_B);
  assert.deepEqual((await store.loadStoredReports(11, OWNER_B)).map((entry) => entry.id), [2002]);
  assert.equal(await store.getStoredReportById("1001", OWNER_B), null);

  await session.purgeLocalReportStateForSignedOut();
  assert.deepEqual(await store.loadStoredReports(11, ANON), []);
  assert.equal(await store.getStoredReportById("1001", ANON), null);
  assert.equal(await store.getStoredReportById("2002", ANON), null);
  assert.equal(rawText().includes("CONFIDENTIAL MANUSCRIPT"), false);
});

test("6b. account switch with NO explicit sign-out (A's session simply expired): B's sign-in purge still removes A's records", async () => {
  await freshProfile();
  await store.storeReport(fullReport(1001, "ACCOUNT_A"), OWNER_A);
  await store.storeReport(fullReport(3003, "ANON"), ANON);
  await session.purgeLocalReportStateForAccount(B_EMAIL);
  assert.equal(await store.getStoredReportById("1001", OWNER_A), null);
  assert.equal(await store.getStoredReportById("1001", OWNER_B), null);
  // Anonymous records are claimed server-side by the login — their local copies go too.
  assert.equal(await store.getStoredReportById("3003", ANON), null);
  assert.equal(rawText().includes("ACCOUNT_A"), false);
});

test("8. /api/auth/me failure with a VALID session: no anonymous restore, nothing copied locally", async () => {
  for (const failure of ["500", "throw", "malformed"]) {
    await freshProfile();
    server.rows.push({ id: "1001", deviceKey: "other-device", userId: "alice", payload: fullReport(1001, "ACCOUNT_A") });
    server.cookieSessionUser = "alice"; // the session cookie is still perfectly valid
    server.authMe = failure;

    const hydration = await session.fetchAccountHydration();
    assert.equal(hydration.status, "error", `${failure} must be indeterminate, never signed-out`);

    const calls = [];
    const status = await session.hydrateHomeReports({
      hydrate: () => session.fetchAccountHydration(),
      loadAccountReports: async () => { calls.push("account"); },
      loadAnonymousReports: async () => { calls.push("anonymous"); },
      onIndeterminate: () => { calls.push("indeterminate"); },
      purgeForAccount: async () => { calls.push("purge-account"); },
      purgeForSignedOut: async () => { calls.push("purge-signed-out"); },
    });
    assert.equal(status, "error");
    assert.deepEqual(calls, ["indeterminate"], `${failure}: no anonymous restore, no purge, no account load`);
    assert.deepEqual(idb.dump("turnitplus"), {}, `${failure}: IndexedDB never even opened`);
  }
  // A thrown hydrate is indeterminate too — never a fallback into anonymous loading.
  const thrownCalls = [];
  await session.hydrateHomeReports({
    hydrate: async () => { throw new Error("boom"); },
    loadAccountReports: async () => { thrownCalls.push("account"); },
    loadAnonymousReports: async () => { thrownCalls.push("anonymous"); },
    onIndeterminate: () => { thrownCalls.push("indeterminate"); },
  });
  assert.deepEqual(thrownCalls, ["indeterminate"]);
});

test("8b. even if the anonymous restore ran with a valid session cookie, it is credential-less: the server can only return unclaimed device reports", async () => {
  await freshProfile();
  server.rows.push({ id: "1001", deviceKey: DEVICE_KEY, userId: "alice", payload: fullReport(1001, "ACCOUNT_A") });
  server.rows.push({ id: "4004", deviceKey: DEVICE_KEY, userId: null, payload: fullReport(4004, "UNCLAIMED_ANON") });
  server.cookieSessionUser = "alice";
  // Pre-fix twin, for contrast: the cookie-carrying list returns the ACCOUNT's reports.
  assert.deepEqual((await remote.listRemoteReportSummaries()).map((summary) => summary.id), ["1001"]);

  const history = await session.loadAnonymousLocalHistory();
  assert.equal(history.kind, "restored");
  assert.deepEqual(history.reports.map((report) => report.id), [4004]);
  const restoreRequests = server.requests.filter((request) => request.path.startsWith("/api/reports") && request.credentials === "omit");
  assert.ok(restoreRequests.length >= 2 && restoreRequests.every((request) => request.session === null), "list + fetch sent without credentials");
  assert.deepEqual((await store.loadStoredReports(11, ANON)).map((entry) => entry.id), [4004]);
  assert.equal(rawText().includes("ACCOUNT_A"), false, "no account report copied into anonymous storage");
});

test("8c. the definitive signed-out path purges account/legacy records, then loads the anonymous history", async () => {
  await freshProfile();
  await store.storeReport(fullReport(1001, "ACCOUNT_A"), OWNER_A);
  localStorage.setItem("tp_report_rooms_v1:alice@example.test:index", "{}");
  const calls = [];
  const status = await session.hydrateHomeReports({
    hydrate: () => session.fetchAccountHydration(),
    loadAccountReports: async () => { calls.push("account"); },
    loadAnonymousReports: async () => { calls.push("anonymous"); },
    onIndeterminate: () => { calls.push("indeterminate"); },
  });
  assert.equal(status, "signed-out");
  assert.deepEqual(calls, ["anonymous"]);
  assert.equal(await store.getStoredReportById("1001", OWNER_A), null);
  assert.equal(localStorage.getItem("tp_report_rooms_v1:alice@example.test:index"), null);
});

test("8d. a definitive signed-in hydration keeps only that account's records", async () => {
  await freshProfile();
  server.cookieSessionUser = "bob";
  await store.storeReport(fullReport(1001, "ACCOUNT_A"), OWNER_A);
  await store.storeReport(fullReport(2002, "ACCOUNT_B"), accountLocalReportOwner("bob@example.test"));
  const calls = [];
  const status = await session.hydrateHomeReports({
    hydrate: () => session.fetchAccountHydration(),
    loadAccountReports: async () => { calls.push("account"); },
    loadAnonymousReports: async () => { calls.push("anonymous"); },
    onIndeterminate: () => { calls.push("indeterminate"); },
  });
  assert.equal(status, "signed-in");
  assert.deepEqual(calls, ["account"]);
  assert.equal(await store.getStoredReportById("1001", OWNER_A), null);
  assert.equal((await store.getStoredReportById("2002", accountLocalReportOwner("bob@example.test"))).id, 2002);
});

test("9/10/11. sign-out, cross-tab sign-out and account deletion share one purge: local records AND every account's room caches (all 40 admin rooms)", async () => {
  await freshProfile();
  await store.storeReport(fullReport(1001, "ACCOUNT_A"), OWNER_A);
  await store.storeReport(fullReport(3003, "ANON"), ANON);
  for (let room = 0; room < 40; room++) roomsCache.setCachedRoom("alice.admin@example.test", room, { status: "empty", report: null, cycleEndsAt: null });
  roomsCache.setCachedRoomIndex("alice.admin@example.test", []);
  roomsCache.setCachedRoomIndex("bob@example.test", []);
  localStorage.setItem("tp_sidebar_collapsed", "true");

  await session.purgeLocalReportStateForSignedOut();
  assert.equal(await store.getStoredReportById("1001", OWNER_A), null);
  assert.equal((await store.getStoredReportById("3003", ANON)).id, 3003, "anonymous history is not the account's to purge");
  assert.deepEqual(localStorage.keys().filter((key) => key.startsWith("tp_report_rooms_v")), [], "every room cache, every account, rooms 10-39 included");
  assert.equal(localStorage.getItem("tp_sidebar_collapsed"), "true", "unrelated keys untouched");
  assert.equal(localStorage.getItem("tp_device_key_v1"), DEVICE_KEY);

  // The page wires that one purge into all three transitions.
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const body = (name) => page.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n {2}\\}`))?.[0] ?? "";
  assert.match(body("signOutAccount"), /clearAccountDisplayState\(\);[\s\S]*?void purgeLocalReportStateForSignedOut\(\);[\s\S]*?fetch\("\/api\/auth\/logout"/, "10: explicit sign-out");
  assert.match(body("completeAccountDeletion"), /void purgeLocalReportStateForSignedOut\(\);/, "9: account deletion");
  assert.match(page, /function handleStorage\(event: StorageEvent\) \{[\s\S]*?clearAccountDisplayState\(\);\s*\n\s*void purgeLocalReportStateForSignedOut\(\);/, "11: another tab's sign-out");
});

test("clearAllReportRoomCaches (Clear history) now reaches every room of the account, not just 0-9", () => {
  localStorage.clear();
  for (let room = 0; room < 40; room++) roomsCache.setCachedRoom("admin@example.test", room, { status: "empty", report: null, cycleEndsAt: null });
  roomsCache.setCachedRoomIndex("other@example.test", []);
  roomsCache.clearAllReportRoomCaches("admin@example.test");
  assert.deepEqual(localStorage.keys(), ["tp_report_rooms_v1:other@example.test:index"]);
  roomsCache.clearAllAccountsReportRoomCaches("other@example.test");
  assert.deepEqual(localStorage.keys(), ["tp_report_rooms_v1:other@example.test:index"], "the signing-in account's own cache may be kept");
  roomsCache.clearAllAccountsReportRoomCaches();
  assert.deepEqual(localStorage.keys(), []);
  localStorage.setItem("tp_device_key_v1", DEVICE_KEY);
});

test("12. legacy (pre-ownership) records: the v2 -> v3 upgrade purges them; any untagged record that still appears is refused by every reader", async () => {
  await freshProfile();
  const legacy = fullReport(5005, "LEGACY");
  idb.seed("turnitplus", 2, {
    reports: { keyPath: "id", records: [legacy] },
    report_summaries: { keyPath: "id", records: [{ ...legacy, __summaryOnly: true, text: "" }] },
  });
  assert.deepEqual(await store.loadStoredReports(11, ANON), []);
  assert.equal(idb.version("turnitplus"), 3);
  assert.deepEqual(idb.dump("turnitplus"), { reports: [], report_summaries: [] }, "PURGED at upgrade, ownership never guessed");

  // A stale pre-v3 tab could still write the old untagged shape afterwards.
  idb.putRaw("turnitplus", "reports", legacy);
  idb.putRaw("turnitplus", "report_summaries", { ...legacy, __summaryOnly: true, text: "" });
  for (const owner of [ANON, OWNER_A]) {
    assert.deepEqual(await store.loadStoredReports(11, owner), []);
    assert.equal(await store.getStoredReportById("5005", owner), null);
  }
  await session.purgeLocalReportStateForSignedOut();
  assert.equal(rawText().includes("LEGACY"), false, "untagged records are purged by every auth transition too");
});

test("13. explicitly anonymous-owned history (the signed-out restore of this device's unclaimed reports) stays visible anonymously", async () => {
  await freshProfile();
  server.rows.push({ id: "4004", deviceKey: DEVICE_KEY, userId: null, payload: fullReport(4004, "UNCLAIMED_ANON") });
  const first = await session.loadAnonymousLocalHistory();
  assert.equal(first.kind, "restored");
  const second = await session.loadAnonymousLocalHistory();
  assert.equal(second.kind, "local");
  assert.deepEqual(second.entries.map((entry) => entry.id), [4004]);
  assert.equal((await store.getStoredReportById("4004", ANON)).text, "CONFIDENTIAL MANUSCRIPT OF UNCLAIMED_ANON");
  assert.equal(await store.getStoredReportById("4004", OWNER_A), null, "an account never reads anonymous-owned local records");
});

test("14. AI completion / AI retry: the shared persist helpers never write locally; the room writes its local copy as the ACCOUNT", async () => {
  await freshProfile();
  const enriched = fullReport(6006, "ACCOUNT_A");
  const summary = { id: "6006", aiStatus: "ready", aiScore: 62, aiTone: "high" };
  await aiCompletion.persistAiCompletion(enriched, summary, 0, async () => ({ ok: true }));
  await aiCompletion.persistAiRetryResult(enriched, summary, async () => ({ ok: true }));
  assert.deepEqual(idb.dump("turnitplus"), {}, "no local write at all from the shared helpers");

  const shell = await readFile(new URL("../app/reports/rooms/[room]/room-page-shell.tsx", import.meta.url), "utf8");
  assert.match(shell, /const localOwner = accountLocalReportOwner\(accountEmail\);/);
  const saveEnriched = shell.match(/async function saveEnrichedAiResult\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(saveEnriched, /await storeReportBestEffort\(enriched, localOwner\);\s*\n\s*const enrichedSaveResult = await persistAiCompletion\(enriched, enrichedSummary, room\);/);
  const saveRetried = shell.match(/async function saveRetriedAiResult\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(saveRetried, /await storeReportBestEffort\(enriched, localOwner\);\s*\n\s*const retrySaveResult = await persistAiRetryResult\(enriched, enrichedSummary\);/);
  const retry = shell.match(/async function retryAiCheck\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(retry, /getStoredReportById<SimilarityReport>\(reportId, localOwner\)/);
  const receipt = shell.match(/async function handleDownloadReceipt\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(receipt, /getStoredReportById<SimilarityReport>\(reportId, localOwner\)/);

  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /await storeReportBestEffort\(enriched, localOwner\);\s*\n\s*await persistAiCompletion\(enriched, enrichedSummary\);/, "dashboard AI completion");
  assert.match(page, /const localOwner = accountLocalReportOwner\(account\.email\);/);
});

test("15. room upload and dashboard save write as the ACCOUNT; the anonymous owner is used only by the signed-out history paths", async () => {
  const shell = await readFile(new URL("../app/reports/rooms/[room]/room-page-shell.tsx", import.meta.url), "utf8");
  assert.match(shell, /await storeReportBestEffort\(report, localOwner\);\s*\n\s*const reportForRemote =/, "room upload");
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /await storeReportBestEffort\(report, accountLocalReportOwner\(account\?\.email\)\);\s*\n\s*const reportForRemote =/, "dashboard save");

  // Every storeReport/storeReportBestEffort call site names an owner, and
  // none of the account flows names the anonymous one.
  for (const [file, source] of [["page", page], ["room", shell]]) {
    for (const call of source.match(/storeReport(?:BestEffort)?\([^)]*\)/g) ?? []) {
      assert.match(call, /,\s*\S/, `${file}: ${call} must pass an owner`);
      assert.doesNotMatch(call, /ANONYMOUS_LOCAL_REPORT_OWNER/, `${file}: ${call} must never write an account report as anonymous`);
    }
  }
  const sessionSource = await readFile(new URL("../lib/local-report-session.ts", import.meta.url), "utf8");
  assert.match(sessionSource, /storeLocal: \(report\) => storeReport\(report, ANONYMOUS_LOCAL_REPORT_OWNER\)/, "the one anonymous writer: the credential-less signed-out restore");
  assert.match(sessionSource, /listRemote: \(\) => listAnonymousDeviceReportSummaries\(\)/);
  assert.match(sessionSource, /fetchRemote: \(id\) => fetchAnonymousDeviceReport<TReport>\(id\)/);
});

test("readers: the signed-out detail page and the ON THIS DEVICE receipt fallback are pinned to the anonymous owner", async () => {
  const detail = await readFile(new URL("../app/reports/[id]/report-detail-shell.tsx", import.meta.url), "utf8");
  assert.match(detail, /await getStoredReportById<SimilarityReport>\(id, ANONYMOUS_LOCAL_REPORT_OWNER\)/);
  const row = await readFile(new URL("../components/reports/report-history-row.tsx", import.meta.url), "utf8");
  assert.match(row, /localOwner \? await getStoredReportById<SimilarityReport>\(report\.id, localOwner\)/);
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /<ReportHistoryRow key=\{report\.id\} report=\{report\} localOwner=\{ANONYMOUS_LOCAL_REPORT_OWNER\}/);
});

test("the Home mount fails closed on an indeterminate auth state and offers a retry instead of the anonymous history", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const resolver = page.match(/async function resolveAuthAndReports\(\) \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(resolver, /await hydrateHomeReports\(\{/);
  assert.match(resolver, /onIndeterminate: \(\) => \{\s*\n\s*setReports\(\[\]\);\s*\n\s*setAuthHydrationFailed\(true\);/);
  assert.doesNotMatch(page, /catch \{\s*\n\s*await loadAnonymousReports\(\);/, "the pre-fix catch -> anonymous fallback is gone");
  assert.match(page, /\) : authHydrationFailed \? \(/);
  assert.match(page, /onClick=\{\(\) => void resolveAuthAndReports\(\)\}>Try again<\/button>/);
  // A fresh login purges every other owner's local records before the account view loads.
  assert.match(page, /await purgeLocalReportStateForAccount\(\(data\.user as LocalAccount\)\.email\);\s*\n\s*await loadAccountReports\(\);/);
});
