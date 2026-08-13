import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { viewFromHash } from "../app/page.tsx";

// Regression coverage for a bug where navigating from /reports/[id] "Back to
// reports" (or any client-side mount of Home() with #reports already in the
// URL) briefly rendered the signed-out account/login page. Home() fully
// remounts on that navigation (it's a different route than /reports/[id]),
// resetting `view` to its SSR-safe default ("account") every time; the view
// used to only get corrected to match the URL hash once an async session
// check (`accountLoaded`) finished, so any authenticated user saw the
// logged-out account page flash for as long as that fetch took.

test("viewFromHash resolves which view to show from the URL alone — it takes no session/account parameter, so it cannot depend on auth state", () => {
  assert.equal(viewFromHash("#reports"), "reports");
  assert.equal(viewFromHash("#account"), "account");
  assert.equal(viewFromHash("#welcome"), "welcome");
  assert.equal(viewFromHash(""), "home");
  // Signature-level proof: a caller cannot gate this on account/accountLoaded
  // even if it wanted to — there's nowhere to pass them.
  assert.equal(viewFromHash.length, 1, "viewFromHash must take only the hash, never an auth/loading flag");
});

test("the initial view sync runs in a layout effect, unconditionally on mount, never gated on the account session check", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /import \{ useEffect, useLayoutEffect, useMemo, useRef, useState \} from "react";/);
  // Isomorphic wrapper: useLayoutEffect on the client (no paint-timing flash),
  // useEffect during the server prerender of "/" (no DOM there to schedule
  // against — using bare useLayoutEffect there just logs a harmless but
  // avoidable dev warning).
  assert.match(page, /const useIsomorphicLayoutEffect = typeof window === "undefined" \? useEffect : useLayoutEffect;/);

  // Isolate the hash-sync effect specifically (identified by its call to
  // syncViewFromLocation/viewFromHash), not just any effect in the file.
  const syncEffectMatch = page.match(/useIsomorphicLayoutEffect\(\(\) => \{\s*\n\s*const syncViewFromLocation[\s\S]*?\n {2}\}, \[\]\);/);
  assert.ok(syncEffectMatch, "the hash-sync effect must be the isomorphic layout effect with an empty dependency array, found on its own (unconditional) initial call");

  const effectBody = syncEffectMatch[0];
  // The exact bug pattern: must never again gate this sync behind the
  // session/account load flag.
  assert.doesNotMatch(effectBody, /accountLoaded/);
  assert.doesNotMatch(effectBody, /if \(!accountLoaded\) return;/);
  assert.match(effectBody, /syncViewFromLocation\(\);/, "must call the sync function immediately on mount, not just register listeners for later");

  // The session-loading effect (separate, unmodified) must still exist and
  // still be what decides *which report set* loads — auth/security behavior
  // is unchanged, only the page shown while it resolves is fixed.
  assert.match(
    page,
    /fetch\("\/api\/auth\/me"\)\s*\n\s*\.then\(\(response\) => \(response\.ok \? response\.json\(\) : Promise\.resolve\(\{ user: null \}\)\)\)/,
  );
  assert.match(page, /await loadAccountReports\(\);/);
  assert.match(page, /await loadAnonymousReports\(\);/);
});

test("the report detail page's back-to-reports control uses client-side Next navigation, not a full page reload", async () => {
  const shell = await readFile(new URL("../app/reports/[id]/report-detail-shell.tsx", import.meta.url), "utf8");
  assert.match(shell, /import Link from "next\/link";/);
  assert.match(shell, /<Link href="\/#reports" className="back-button">/);
  // A plain <a> here would force a full browser navigation, discarding the
  // whole app bundle and defeating any client-side fix to the mount flash.
  assert.doesNotMatch(shell, /<a href="\/#reports"/);
});
