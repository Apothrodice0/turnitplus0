import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Source-text wiring test for the /reports/[id] saved-report detail page,
// matching the convention used by tests/ai-model-prep.test.mjs and
// tests/report-persistence-wiring.test.mjs.

test("the reports list links to the routable detail page instead of calling openReport", async () => {
  // 10-room architecture: the actual report row (and its two <Link>s) moved
  // into components/reports/report-history-row.tsx, shared by both the
  // anonymous flat list and ReportRoomsBrowser's per-room list — see that
  // component's own header comment. app/page.tsx itself never had, and
  // still doesn't have, an openReport() function.
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /openReport\(/);
  assert.doesNotMatch(page, /function openReport/);

  const row = await readFile(new URL("../components/reports/report-history-row.tsx", import.meta.url), "utf8");
  assert.match(row, /import Link from "next\/link";/);
  assert.match(row, /<Link href=\{`\/reports\/\$\{report\.id\}\?mode=ai`\}[\s\S]*?>/);
  assert.match(row, /<Link href=\{`\/reports\/\$\{report\.id\}`\}[\s\S]*?>/);
  assert.doesNotMatch(row, /openReport\(/);
});

test("the page-level data loader only calls notFound() when a session definitively does not own the report", async () => {
  const route = await readFile(new URL("../app/reports/[id]/page.tsx", import.meta.url), "utf8");

  assert.match(route, /export const dynamic = "force-dynamic";/);
  assert.match(route, /if \(!token\) return \{ status: "no-session" \};/);
  assert.match(route, /if \(!sessionUser\) return \{ status: "no-session" \};/);
  assert.match(route, /if \(!row\) return \{ status: "not-found-for-session" \};/);

  // notFound() must only be reachable from the definitive-absence branch —
  // never from "no-session", which could still resolve client-side via the
  // browser's own device key (never available during SSR).
  const bodyMatch = route.match(/export default async function ReportDetailPage[\s\S]*$/);
  assert.ok(bodyMatch, "ReportDetailPage function body must be found");
  assert.match(bodyMatch[0], /if \(result\.status === "not-found-for-session"\) notFound\(\);/);
});

test("rate-limit architecture fix: the page's own SSR gate uses the read/navigation bucket, never the strict write/auth bucket", async () => {
  // Production bug fix: this gate used to call checkRate (the same
  // strict/abuse-sensitive bucket uploads, login, and destructive
  // operations depend on) — a session opening this page as part of
  // ordinary browsing could exhaust that shared budget. checkReadRate is a
  // separate, much more generous bucket sized for exactly this traffic
  // (see lib/rate-limit.ts's own header comment and
  // tests/read-rate-limit-bucket.test.mjs for the integration-level proof).
  const route = await readFile(new URL("../app/reports/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(route, /import \{ checkReadRate \} from "@\/lib\/rate-limit";/);
  assert.match(route, /const rate = await checkReadRate\(clientIp\);/);
  assert.doesNotMatch(route, /\bcheckRate\(/, "the strict bucket's checkRate must never be called from this page's own gate");
});

test("report metadata is generic and excludes the page from search indexing", async () => {
  const route = await readFile(new URL("../app/reports/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(route, /robots: \{ index: false, follow: false, nocache: true, googleBot: \{ index: false, follow: false \} \}/);
  // The description must stay a fixed, generic string — never interpolate
  // report content into it, since noindex doesn't hide raw HTML from
  // view-source or crawlers that ignore robots directives.
  assert.match(route, /description: "A saved TurnitPlus AI-writing and similarity report\."/);
});

test("the anonymous client-side resolution path tries the local IndexedDB copy before the remote fetch", async () => {
  const shell = await readFile(new URL("../app/reports/[id]/report-detail-shell.tsx", import.meta.url), "utf8");
  // Call sites specifically, not just identifier occurrence — the import
  // statements alone would put fetchRemoteReport's text first.
  const localCallIndex = shell.indexOf("await getStoredReportById<");
  const remoteCallIndex = shell.indexOf("await fetchRemoteReport<");
  assert.ok(localCallIndex >= 0, "getStoredReportById must be called");
  assert.ok(remoteCallIndex >= 0, "fetchRemoteReport must be called");
  assert.ok(localCallIndex < remoteCallIndex, "the local IndexedDB lookup must be attempted before the remote fetch fallback");
});

test("the local IndexedDB lookup is never left unhandled — a rejection must fall through to the remote fetch, not strand the view on 'Opening report…' forever (production audit fix)", async () => {
  const shell = await readFile(new URL("../app/reports/[id]/report-detail-shell.tsx", import.meta.url), "utf8");
  // getStoredReportById can genuinely reject (storage disabled,
  // private-browsing restrictions, quota/corruption) — unlike the same call
  // at components/reports/report-history-row.tsx and
  // app/reports/rooms/[room]/room-page-shell.tsx (both already wrapped),
  // this call site had no .catch() at all, so a rejection threw out of the
  // effect's IIFE, setStatus was never called, and status stayed "loading"
  // (rendered as "Opening report…") indefinitely, with no error and no way
  // forward.
  assert.match(
    shell,
    /const local = await getStoredReportById<SimilarityReport>\(id\)\.catch\(\(\) => null\);/,
    "getStoredReportById must be wrapped in the same .catch(() => null) used at every other call site of this function",
  );
});

test("delete uses the checked remote-delete variant, not the fail-soft one used by bulk history clearing", async () => {
  const shell = await readFile(new URL("../app/reports/[id]/report-detail-shell.tsx", import.meta.url), "utf8");
  assert.match(shell, /import \{ deleteRemoteReportChecked, fetchRemoteReport \} from "@\/lib\/reports-remote";/);
  assert.match(shell, /import \{ deleteStoredReport, getStoredReportById \} from "@\/lib\/report-store";/);
  assert.match(shell, /await deleteStoredReport\(id\);/);
  assert.match(shell, /const ok = await deleteRemoteReportChecked\(id\);/);
  assert.match(shell, /window\.confirm\(/);
  // Never treated as successful without checking the response.
  assert.doesNotMatch(shell, /await deleteRemoteReport\(/);
});

test("lib/reports-remote.ts keeps the fail-soft delete for its existing bulk-clear caller, alongside the new checked variant", async () => {
  const remote = await readFile(new URL("../lib/reports-remote.ts", import.meta.url), "utf8");
  assert.match(remote, /export async function deleteRemoteReport\(id: string\): Promise<void> \{/);
  assert.match(remote, /export async function deleteRemoteReportChecked\(id: string\): Promise<boolean> \{/);
  assert.match(remote, /return response\.ok;/);
});

test("the report-list links never prefetch — each renders in a loop against a rate-limited, force-dynamic route", async () => {
  // Production audit fix: viewport prefetching every row's links the moment
  // the list is visible (10-40 rooms, or every saved report in the
  // anonymous flat list) burned the account's own rate-limit budget before
  // any room/report was actually opened. See report-rooms.tsx's and this
  // file's own header comments for the full mechanism.
  const row = await readFile(new URL("../components/reports/report-history-row.tsx", import.meta.url), "utf8");
  assert.match(row, /<Link href=\{`\/reports\/\$\{report\.id\}\?mode=ai`\} prefetch=\{false\}/);
  assert.match(row, /<Link href=\{`\/reports\/\$\{report\.id\}`\} prefetch=\{false\}/);

  const rooms = await readFile(new URL("../components/reports/report-rooms.tsx", import.meta.url), "utf8");
  const linkMatch = rooms.match(/<Link[\s\S]*?<\/Link>/);
  assert.ok(linkMatch, "the room row Link must be found");
  assert.match(linkMatch[0], /prefetch=\{false\}/);
});

test("a rate-limited request is never conflated with no-session — an already signed-in owner never sees a false negative", async () => {
  // Production audit fix: the general rate-limit bucket (lib/rate-limit.ts)
  // is keyed by IP, not by session, so it can trip for an account that is
  // genuinely signed in. Before this fix, that case was folded into
  // "no-session", which this page treats as "try the anonymous device-key
  // lookup" (requiresClientResolution below) — an account-owned report can
  // never be found that way, so the owner saw "This report could not be
  // found" for their own report.
  const route = await readFile(new URL("../app/reports/[id]/page.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(
    route,
    /if \(!rate\.allowed\) return \{ status: "no-session" \};/,
    "a rate-limit rejection must never be reported as no-session",
  );
  assert.match(
    route,
    /if \(!rate\.allowed\) return \{ status: "rate-limited", retryAfterSeconds: rate\.retryAfter \};/,
  );

  // The rate-limited branch must return its own response BEFORE
  // ReportDetailShell is ever reached, so requiresClientResolution (and the
  // anonymous fallback it triggers) can never fire for this case.
  const bodyMatch = route.match(/export default async function ReportDetailPage[\s\S]*$/);
  assert.ok(bodyMatch, "ReportDetailPage function body must be found");
  const rateLimitedBranchIndex = bodyMatch[0].indexOf('if (result.status === "rate-limited")');
  const shellRenderIndex = bodyMatch[0].indexOf("<ReportDetailShell");
  assert.ok(rateLimitedBranchIndex >= 0, "a dedicated rate-limited branch must exist");
  assert.ok(rateLimitedBranchIndex < shellRenderIndex, "the rate-limited branch must return before ReportDetailShell renders");
});

test("no loading.tsx exists for this route segment, so notFound() can still produce a real HTTP 404", () => {
  // Verified against a running dev server: a loading.tsx here causes Next to
  // immediately flush a 200 response with the loading fallback before the
  // async page component (which decides notFound()) resolves — once that
  // initial 200 is sent, the eventual notFound() can only patch the DOM
  // client-side, never change the already-sent status code. The SSR fetch
  // itself is one cookie read + one indexed DB query (sub-100ms), not worth
  // a loading skeleton at the cost of correct 404s. (The anonymous client-
  // side resolution loading state is unrelated — that's in-component state
  // inside report-detail-shell.tsx, not this route-segment file.)
  const dir = fileURLToPath(new URL("../app/reports/[id]/", import.meta.url));
  assert.equal(existsSync(`${dir}loading.tsx`), false, "adding loading.tsx back here would silently break notFound()'s HTTP status code");
});
