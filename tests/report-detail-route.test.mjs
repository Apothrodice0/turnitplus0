import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Source-text wiring test for the /reports/[id] saved-report detail page,
// matching the convention used by tests/ai-model-prep.test.mjs and
// tests/report-persistence-wiring.test.mjs.

test("the reports list links to the routable detail page instead of calling openReport", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /import Link from "next\/link";/);
  assert.match(page, /<Link href=\{`\/reports\/\$\{report\.id\}\?mode=ai`\}[\s\S]*?>/);
  assert.match(page, /<Link href=\{`\/reports\/\$\{report\.id\}`\}[\s\S]*?>/);
  assert.doesNotMatch(page, /openReport\(/);
  assert.doesNotMatch(page, /function openReport/);
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
  assert.match(bodyMatch[0], /if \(result\.status === "not-found-for-session"\) \{\s*\n\s*notFound\(\);/);
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
