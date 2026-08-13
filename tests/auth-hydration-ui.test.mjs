import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression coverage for a follow-up to the /reports/[id] -> /reports
// navigation flash fix. That fix made `view` resolve to "reports"
// immediately, but the CONTENT rendered within that view — the sidebar
// account widget and the reports list — still treated `!account` as
// "signed out" without first checking `accountLoaded`, so an authenticated
// user still briefly saw the anonymous sidebar copy ("Log in or create
// account") and a false "No reports yet" empty state while /api/auth/me was
// in flight. Same bug class also reachable directly on the "account" view,
// since the sidebar trigger isn't disabled while pending.
//
// Source-text wiring test, matching the convention used elsewhere in this
// suite (no React rendering harness in this repo — see
// tests/reports-view-auth-flash.test.mjs, tests/ai-model-prep.test.mjs).

test("the sidebar account widget shows a pending state, never the signed-out copy, while auth is unresolved", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /\$\{!accountLoaded \? "account-pending" : ""\}/);
  assert.match(page, /aria-busy=\{!accountLoaded\}/);
  // The signed-out copy must be reachable only behind a resolved !account —
  // an unconditional `account ? "Signed in" : "Log in or create account"`
  // would render the signed-out branch immediately on every mount.
  assert.match(page, /<span>\{!accountLoaded \? "Checking session…" : \(account \? "Signed in" : "Log in or create account"\)\}<\/span>/);
  assert.doesNotMatch(page, /<span>\{account \? "Signed in" : "Log in or create account"\}<\/span>/);
});

test("the reports list shows a loading state, never the false empty state, until the report source has loaded", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  // reports.length === 0 is true both "genuinely empty" and "not loaded
  // yet" — the pending branch must be checked first (and be the one that
  // wins) so "No reports yet" can never render before accountLoaded.
  const reportsSectionMatch = page.match(/\{!accountLoaded \? \([\s\S]*?Loading your reports…[\s\S]*?\) : reports\.length === 0 && !isGeneratingReport \? \([\s\S]*?No reports yet[\s\S]*?\) : \(/);
  assert.ok(reportsSectionMatch, "the reports list must check !accountLoaded before the reports.length === 0 empty state, in that order");
});

test("the account page's own content shows a pending panel, never the login/signup form, while auth is unresolved", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  // The sidebar trigger is clickable while pending (not disabled), so this
  // view is directly reachable before accountLoaded resolves — it must not
  // assume signed-out either.
  const accountSectionMatch = page.match(/\{view === "account" && \(\s*\n\s*<section className="account-page">\s*\n\s*\{!accountLoaded \? \([\s\S]*?Checking your session[\s\S]*?\) : account \? \(/);
  assert.ok(accountSectionMatch, "the account view must check !accountLoaded before branching on account, so the login form never renders before the session check resolves");

  assert.match(page, /\{view === "account" && \(!accountLoaded \|\| account \? "Your account" : "Log in or create your account"\)\}/);
  assert.match(page, /view === "account" && accountLoaded && !account \? "OPTIONAL ACCOUNT"/);
});

test("existing account/report loading and authorization logic is unchanged — only what's shown while it resolves was fixed", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  // Same auth-then-exactly-one-loader sequencing as before; still the only
  // place accountLoaded/account/reports get set from the network.
  assert.match(
    page,
    /fetch\("\/api\/auth\/me"\)\s*\n\s*\.then\(\(response\) => \(response\.ok \? response\.json\(\) : Promise\.resolve\(\{ user: null \}\)\)\)/,
  );
  assert.match(page, /await loadAccountReports\(\);/);
  assert.match(page, /await loadAnonymousReports\(\);/);
  assert.match(page, /\.finally\(\(\) => setAccountLoaded\(true\)\);/);
});
