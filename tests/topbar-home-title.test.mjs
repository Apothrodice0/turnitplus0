import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Production audit fix: the topbar <h1> was a chain of one condition per
 * view (dashboard/reports/about/account/welcome/legal) with no case for
 * "home" — the actual default a fresh visit lands on (viewFromHash("")
 * resolves to "home"). The topbar itself still renders unconditionally for
 * every view except "processing", so the result was a real, empty <h1>
 * sitting above the landing hero on the single most common entry point.
 */
test("the topbar <h1> has a case for every non-processing view, including the default 'home' view", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  const h1Match = page.match(/<h1>\s*\n(?:\s*\{view === "\w+" && [\s\S]*?\}\s*\n)+\s*<\/h1>/);
  assert.ok(h1Match, "the topbar <h1> conditional chain must be found");
  const h1 = h1Match[0];

  for (const view of ["home", "dashboard", "reports", "about", "account", "welcome", "legal"]) {
    assert.match(h1, new RegExp(`\\{view === "${view}" &&`), `the topbar <h1> must have its own case for view === "${view}"`);
  }
});
