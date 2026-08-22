import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Production audit fix: both receipt-download call sites silently did
 * nothing when the report couldn't be found anywhere (local + remote both
 * miss) or when downloadReceipt itself threw (its own font-loading fetch
 * failing, most realistically) — the button just flipped back to its
 * resting label with zero feedback. Source-text wiring tests, matching the
 * convention used throughout this suite for logic with no React test
 * harness to exercise directly.
 */

test("components/reports/report-history-row.tsx surfaces both failure modes — not-found and a thrown error — instead of failing silently", async () => {
  const source = await readFile(new URL("../components/reports/report-history-row.tsx", import.meta.url), "utf8");

  const fnMatch = source.match(/async function handleDownloadReceipt\(\) \{[\s\S]*?\n {2}\}/);
  assert.ok(fnMatch, "handleDownloadReceipt must be found");
  const body = fnMatch[0];

  assert.match(body, /if \(full\) \{\s*\n\s*await onDownloadReceipt\(full\);\s*\n\s*\} else \{\s*\n\s*setDownloadError\(true\);\s*\n\s*\}/, "the report-not-found case must set a real error flag, not just silently do nothing");
  assert.match(body, /\} catch \{\s*\n\s*setDownloadError\(true\);\s*\n\s*\}/, "a thrown error from onDownloadReceipt must be caught and surfaced, not left as an unhandled rejection");

  // The error must actually be visible, not just tracked in state no one renders.
  assert.match(source, /downloadError \? "Failed — retry" : "Receipt"/, "the button's own label must change on failure, giving real visible feedback");
});

test("app/reports/rooms/[room]/room-page-shell.tsx surfaces both failure modes via its own existing toast (notify), instead of failing silently", async () => {
  const source = await readFile(new URL("../app/reports/rooms/[room]/room-page-shell.tsx", import.meta.url), "utf8");

  const fnMatch = source.match(/async function handleDownloadReceipt\(reportId: string\) \{[\s\S]*?\n {2}\}/);
  assert.ok(fnMatch, "handleDownloadReceipt must be found");
  const body = fnMatch[0];

  assert.match(body, /if \(full\) \{\s*\n\s*await downloadReceipt\(full\);\s*\n\s*\} else \{\s*\n\s*notify\(/, "the report-not-found case must notify the user, not just silently do nothing");
  assert.match(body, /\} catch \{\s*\n\s*notify\(/, "a thrown error from downloadReceipt must be caught and surfaced via the same toast mechanism the rest of this component already uses");
});
