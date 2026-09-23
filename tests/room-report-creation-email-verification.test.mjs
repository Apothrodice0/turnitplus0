import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * A3 COMPLETION — ROOM UX GAP (follow-up to the report-gate task in
 * tests/report-creation-auth-required.test.mjs). That task's server gate
 * (app/api/reports/route.ts's EMAIL VERIFICATION GATE) and app/page.tsx's own
 * client handling are unaffected and untouched by this file.
 *
 * The REAL, day-to-day report-creation surface for a signed-in account is
 * app/reports/rooms/[room]/room-page-shell.tsx's runCheck() — a separate
 * Next.js route tree from app/page.tsx with no shared React state/context, so
 * it could not reuse app/page.tsx's verification MODAL directly. This file
 * proves runCheck()'s save-result handling now recognizes the server's 403
 * EMAIL_VERIFICATION_REQUIRED and routes into the existing account-page
 * verification UI (via useRouter/router.push("/#account") — the same
 * standard Next.js imperative-navigation hook the sibling
 * app/reports/[id]/report-detail-shell.tsx already uses), while every other
 * save-rejection branch (quotaExceeded/roomOccupied/roomReuseNotReady/
 * generic) is untouched.
 *
 * Source-text structural tests, matching this component's own established
 * convention for a "use client" component with no React test harness (see
 * tests/room-processing-navigation.test.mjs's and
 * tests/room-lifecycle-reconciliation.test.mjs's own header comments).
 * runCheck() itself is a large, effectful async function closing over many
 * hooks/refs — not a pure function like isFullyRevealed/evaluateReconciliation
 * — so its save-result branch is the smallest available seam, exactly like
 * this same fix's app/page.tsx counterpart
 * (tests/report-creation-auth-required.test.mjs's own generateReport() test).
 */

// This checkout stores room-page-shell.tsx with CRLF line endings — normalize
// to LF so every structural regex below can use a plain \n, matching
// tests/report-creation-auth-required.test.mjs's own readPage() convention
// for the exact same situation (this file's sibling tests instead route
// around it with \s*\n\s*-shaped patterns; normalizing here is simpler for
// the multi-line block this file extracts).
async function readRoomShell() {
  const raw = await readFile(new URL("../app/reports/rooms/[room]/room-page-shell.tsx", import.meta.url), "utf8");
  return raw.replace(/\r\n/g, "\n");
}

/** Extracts the whole `if (!saveResult.ok) { ... } ... return;` block runCheck() uses to branch on every save-rejection shape. */
function extractSaveResultBlock(shell) {
  const match = shell.match(/if \(!saveResult\.ok\) \{[\s\S]*?\n {8}\}\n {8}return;\n {6}\}/);
  assert.ok(match, "the if (!saveResult.ok) { ... } return; block must be found in room-page-shell.tsx's runCheck()");
  return match[0];
}

test("room report creation: useRouter is imported and instantiated (the standard Next.js imperative-navigation hook, matching app/reports/[id]/report-detail-shell.tsx's own existing usage)", async () => {
  const shell = await readRoomShell();
  assert.match(shell, /import \{ useRouter \} from "next\/navigation";/, "useRouter must be imported from next/navigation");
  assert.match(shell, /const router = useRouter\(\);/, "the router instance must be created inside RoomPageShell");
});

test("room report creation: a 403 EMAIL_VERIFICATION_REQUIRED save result routes to the EXISTING account-page verification experience, never a generic failure message", async () => {
  const shell = await readRoomShell();
  const block = extractSaveResultBlock(shell);

  const branchMatch = block.match(/\} else if \(saveResult\.emailVerificationRequired\) \{[\s\S]*?\n {8}\} else \{/);
  assert.ok(branchMatch, "an emailVerificationRequired branch must exist, positioned before the final generic else");
  const branch = branchMatch[0];

  assert.match(branch, /router\.push\("\/#account"\);/, "REQUIRED: must navigate into the existing account page, where the verification UI already lives");
  assert.match(branch, /notify\(/, "must give the user a clear, distinct notice, not a silent redirect");
  assert.doesNotMatch(branch, /Your report was generated but could not be saved/, "must NOT show the generic save-failure message for this specific, actionable rejection");

  // Do NOT duplicate the verification form/modal, and do NOT auto-send a
  // verification email from report creation — the account page's own
  // existing "Verify email" control is the one place that ever does that.
  assert.doesNotMatch(branch, /email-verification\/send/, "REQUIRED: must not call the send-code endpoint from report creation — no auto-send");
  assert.doesNotMatch(branch, /EmailVerificationModal|emailVerifyModalOpen|setEmailVerifyModalOpen/, "REQUIRED: must not construct or reference a second/duplicate verification modal implementation in this component tree");
});

test("room report creation: an unrelated 403/rejection is never reclassified as verification-required — quotaExceeded/roomOccupied/roomReuseNotReady and the generic fallback all keep their existing, distinct behavior", async () => {
  const shell = await readRoomShell();
  const block = extractSaveResultBlock(shell);

  // The pre-existing branches must still exist, in their original order,
  // completely unmodified by this fix.
  assert.match(block, /if \(saveResult\.quotaExceeded\) \{/);
  assert.match(block, /\} else if \(saveResult\.roomOccupied\) \{/);
  assert.match(block, /\} else if \(saveResult\.roomReuseNotReady\) \{/);
  assert.match(block, /notify\(saveResult\.error \?\? `Daily upload limit reached\. This report is saved on this device only until the limit resets at \$\{resetLabel\}\.`\);/);
  assert.match(block, /notify\(saveResult\.error \?\? "This room already has an active check\. Refresh to see it, or wait for it to reset\."\);/);
  assert.match(block, /notify\(saveResult\.error \?\? "This room is finishing its previous check\. Please try again shortly\."\);/);

  // The order matters: emailVerificationRequired must be checked (and so
  // handled) BEFORE the generic catch-all, so a real, unrecognized rejection
  // still falls through to the untouched generic message — never the other
  // way around.
  const emailBranchIndex = block.indexOf("saveResult.emailVerificationRequired");
  const genericElseIndex = block.indexOf('notify("Your report was generated but could not be saved. Please try again.");');
  assert.ok(emailBranchIndex > -1 && genericElseIndex > -1, "both the new branch and the pre-existing generic fallback must be found");
  assert.ok(emailBranchIndex < genericElseIndex, "the emailVerificationRequired check must be evaluated before the generic catch-all, never reordered after it");

  // router.push must appear ONLY inside the emailVerificationRequired branch
  // — none of the other rejection branches navigate away.
  const pushOccurrences = block.match(/router\.push\(/g) ?? [];
  assert.equal(pushOccurrences.length, 1, "REQUIRED: router.push must be called from exactly one place in this block — the emailVerificationRequired branch alone");
});

test("room report creation: exactly one return statement closes the whole save-rejection block, so routing into the verification experience can never fall through into the success path or submit a duplicate report", async () => {
  const shell = await readRoomShell();
  const block = extractSaveResultBlock(shell);

  // The block is `if (!saveResult.ok) { <branches> } return;` — ONE shared
  // return after the if/else-if chain, not a per-branch return. No branch
  // (including the new one) may call saveReportRemote/runCheck again, and
  // the success-path code (invalidateRoomCache, setOccupant, etc.) sits
  // strictly after this whole block and is therefore unreachable from any
  // rejection branch.
  const returnOccurrences = block.match(/\breturn;/g) ?? [];
  assert.equal(returnOccurrences.length, 1, "REQUIRED: exactly one return statement must close this entire if/else-if chain — no branch, including emailVerificationRequired, may have its own separate return or fall through");
  assert.doesNotMatch(block, /saveReportRemote\(/, "REQUIRED: no rejection branch may re-invoke saveReportRemote — routing to verification must never itself attempt (or duplicate) a save");

  assert.match(shell, /invalidateRoomCache\(accountEmail, room\);/, "the existing success path (unchanged, run only when saveResult.ok) must still exist immediately after this block");
});
