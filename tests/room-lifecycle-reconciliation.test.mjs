import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  evaluatePollTick,
  evaluateReconciliation,
  isFullyRevealed,
  MAX_POLL_ATTEMPTS,
} from "../app/reports/rooms/[room]/room-page-shell.tsx";

/**
 * Room/client lifecycle defects fix: three confirmed, independent client-
 * side defects in app/reports/rooms/[room]/room-page-shell.tsx and its
 * page.tsx wrapper, none of which touch scoring, corpus admission,
 * retention, AI computation, unified-similarity freshness rules, or PDF
 * extraction:
 *   1. RoomPageShell had no key tied to `room`, so client-side navigation
 *      between rooms could leave occupant/isGeneratingReport/progress/
 *      processingLabel/generationLockRef/poll state from a PREVIOUS room
 *      mounted in the same slot.
 *   2. The completion-poll effect's own attempt counter lived in a
 *      per-effect-instance closure, reset to 0 every time the effect was
 *      torn down and re-run by React because of the SAME poll's own
 *      setOccupant call (occupant is one of the effect's dependencies) —
 *      permanently defeating MAX_POLL_ATTEMPTS.
 *   3. isGeneratingReport/generationLockRef/the progress overlay had
 *      exactly one writer (runCheck()'s own finally) and no reconciliation
 *      against what the server already knows about the room while a check
 *      is believed to still be running locally. Deliberately conservative:
 *      reconciliation is restricted to an exact match on the report id THIS
 *      session's own check is for — an earlier version compared a server
 *      timestamp against a local Date.now() snapshot to also recognize a
 *      genuinely newer, independent report, but that comparison is unsafe
 *      across tabs/devices with potentially skewed clocks (a skewed clock
 *      could make an unrelated OLDER report look newer, letting it wrongly
 *      cancel an active run) and was removed; see evaluateReconciliation's
 *      own comment for the full reasoning and what a safe future version
 *      would need (a server-issued, clock-independent ordering key).
 *
 * Behavioral coverage below calls the extracted pure decision functions
 * directly (evaluatePollTick, evaluateReconciliation, isFullyRevealed) —
 * the same "extract for testability, no React render needed" convention
 * this file already used for completeAiAnalysisWithRecovery/runAiAnalysis
 * (see tests/room-processing-navigation.test.mjs's own header comment for
 * why this codebase has no React test harness). Everything else is
 * structural source-text wiring, matching every other test file for this
 * component.
 */

async function readRoomShell() {
  return readFile(new URL("../app/reports/rooms/[room]/room-page-shell.tsx", import.meta.url), "utf8");
}
async function readRoomPage() {
  return readFile(new URL("../app/reports/rooms/[room]/page.tsx", import.meta.url), "utf8");
}

function reportFixture(overrides = {}) {
  return {
    id: "report-1",
    submissionId: "sub-1",
    title: "fixture.pdf",
    createdAt: new Date().toISOString(),
    wordCount: 500,
    archiveScore: 10,
    primaryScore: 10,
    isUnified: true,
    similarityStatus: "resolved",
    scoreBand: "Low",
    aiScore: 3,
    aiTone: "low",
    ...overrides,
  };
}
function readyResolvedContents(overrides = {}) {
  return { status: "ready", report: reportFixture(overrides), cycleEndsAt: new Date(Date.now() + 1000).toISOString() };
}
function readyPendingContents() {
  // A FRESH object every call, matching what fetchReportRoomContents
  // (lib/reports-remote.ts) actually returns on every real network poll —
  // deliberately never the same reference twice, which is exactly the
  // condition that used to defeat the old closure-local attempt counter.
  return { status: "ready", report: reportFixture({ similarityStatus: "pending" }), cycleEndsAt: new Date(Date.now() + 1000).toISOString() };
}
function processingContents() {
  return { status: "processing", report: reportFixture({ aiScore: null, aiTone: null }), cycleEndsAt: new Date(Date.now() + 1000).toISOString() };
}

// ============================================================================
// Defect #1: navigation between rooms must remount, never leak state
// ============================================================================

test("Defect #1 (structural): RoomPageShell is rendered with an explicit room-derived key, forcing a fresh instance whenever the account navigates to a different room", async () => {
  const page = await readRoomPage();
  assert.match(
    page,
    /<RoomPageShell key=\{result\.room\} room=\{result\.room\} accountEmail=\{result\.accountEmail\} initialOccupant=\{result\.occupant\} \/>/,
    "REQUIRED: key must be the same raw room number already threaded through save/read/poll — without it, React can reconcile consecutive renders at this JSX position as the SAME component instance across a room change, carrying over occupant/isGeneratingReport/progress/refs from whichever room was previously mounted here",
  );
});

test("Defect #1 (structural): occupant state initializes directly from the initialOccupant prop, and isGeneratingReport/progress default to a fresh, idle state — the state a genuine remount (via the key above) actually produces", async () => {
  const shell = await readRoomShell();
  assert.match(shell, /const \[occupant, setOccupant\] = useState<RoomContents>\(initialOccupant\);/);
  assert.match(shell, /const \[isGeneratingReport, setIsGeneratingReport\] = useState\(false\);/);
  assert.match(shell, /const \[progress, setProgress\] = useState\(0\);/);
  assert.match(shell, /const \[processingLabel, setProcessingLabel\] = useState\("Reading document content"\);/);
  assert.match(shell, /const \[pollExhausted, setPollExhausted\] = useState\(false\);/);
  assert.match(shell, /const generationLockRef = useRef\(false\);/);
  assert.match(shell, /const pollAttemptsRef = useRef\(0\);/);
});

// ============================================================================
// Defect #2: the poll attempt budget must survive occupant churn
// ============================================================================

test("Defect #2 (BEHAVIORAL): a sequence of fresh, distinct, non-terminal 'ready/pending' responses still exhausts after exactly MAX_POLL_ATTEMPTS", () => {
  let attempts = 0;
  let lastOutcome;
  for (let i = 1; i <= MAX_POLL_ATTEMPTS; i += 1) {
    attempts += 1;
    // A brand-new object every tick — the exact condition
    // (fetchReportRoomContents never returns the same reference twice)
    // that used to silently reset a closure-local counter to 0.
    const freshResult = { ok: true, contents: readyPendingContents() };
    lastOutcome = evaluatePollTick(freshResult, attempts, MAX_POLL_ATTEMPTS);
    if (i < MAX_POLL_ATTEMPTS) {
      assert.equal(lastOutcome.outcome, "continue", `tick ${i} must continue, not exhaust early`);
    }
  }
  assert.equal(lastOutcome.outcome, "exhausted", "REQUIRED: the budget must actually be enforceable — this is the direct regression test for the confirmed-live Preview bug (indefinite polling despite an already-terminal server row)");
});

test("Defect #2 (BEHAVIORAL): the exhausting tick still carries the freshest known non-terminal occupant, matching the pre-fix behavior of updating the room card right up to the moment 'Check again' is offered", () => {
  const contents = readyPendingContents();
  const outcome = evaluatePollTick({ ok: true, contents }, MAX_POLL_ATTEMPTS, MAX_POLL_ATTEMPTS);
  assert.equal(outcome.outcome, "exhausted");
  assert.equal(outcome.occupant, contents);
});

test("Defect #2 (BEHAVIORAL): a fully-revealed response stops immediately — 'revealed' wins over the attempt count regardless of how many attempts remain", () => {
  const outcome = evaluatePollTick({ ok: true, contents: readyResolvedContents() }, 1, MAX_POLL_ATTEMPTS);
  assert.equal(outcome.outcome, "revealed");
});

test("Defect #2 (BEHAVIORAL): a 'processing' response never counts toward revealing and is inconclusive like a failed request — both still count toward the attempt budget", () => {
  assert.equal(evaluatePollTick({ ok: true, contents: processingContents() }, 1, MAX_POLL_ATTEMPTS).outcome, "continue");
  assert.equal(evaluatePollTick({ ok: false, status: 500 }, 1, MAX_POLL_ATTEMPTS).outcome, "continue");
  assert.equal(evaluatePollTick({ ok: false, status: 500 }, MAX_POLL_ATTEMPTS, MAX_POLL_ATTEMPTS).outcome, "exhausted");
});

test("Defect #2 (structural): the poll effect's attempt counter lives in pollAttemptsRef, is incremented at the top of poll(), and is never reassigned to 0 anywhere inside the effect body except on a genuinely revealed tick", async () => {
  const shell = await readRoomShell();
  assert.match(shell, /async function poll\(\) \{\s*\n\s*pollAttemptsRef\.current \+= 1;/, "REQUIRED: no closure-local 'let attempts = 0' may exist inside the poll effect");
  assert.doesNotMatch(shell, /let attempts = 0;/, "REQUIRED: the old closure-local counter must be fully removed");
  const pollEffectMatch = shell.match(/useEffect\(\(\) => \{\s*\n\s*if \(isFullyRevealed\(occupant\) \|\| isGeneratingReport \|\| pollExhausted\) return;[\s\S]*?\}, \[occupant, room, isGeneratingReport, pollExhausted\]\);/);
  assert.ok(pollEffectMatch, "the completion-poll effect must be found");
  const effect = pollEffectMatch[0];
  assert.match(effect, /const tick = evaluatePollTick\(result, pollAttemptsRef\.current, MAX_POLL_ATTEMPTS\);/, "REQUIRED: the poll effect must delegate its per-tick decision to the shared, independently-tested evaluatePollTick, never a re-implemented inline check");
  assert.match(effect, /if \(tick\.outcome === "revealed"\) \{\s*\n\s*pollAttemptsRef\.current = 0;/, "the ref resets on a genuine reveal — hygiene for any later, unrelated polling lifecycle in this same mounted instance");
});

test("Defect #2 (structural): pollAttemptsRef is reset at the specific, intentional 'new polling lifecycle' points — a new check's own first save succeeding, and checkAgain() — never anywhere else", async () => {
  const shell = await readRoomShell();
  const resetOccurrences = shell.match(/pollAttemptsRef\.current = 0;/g) ?? [];
  // Exactly 3: the poll effect's own reveal branch (tested above), the
  // "new report/check generation starts" point in runCheck(), and
  // checkAgain(). Not the watchdog's own reset (see Defect #3 below) —
  // wait, the watchdog ALSO resets it on adopt, so 4 total.
  assert.equal(resetOccurrences.length, 4, `expected exactly 4 reset points (poll-reveal, runCheck's new-generation point, checkAgain, watchdog-adopt), found ${resetOccurrences.length}`);
  assert.match(shell, /pollAttemptsRef\.current = 0;\s*\n\s*setPollExhausted\(false\);\s*\n\s*\/\/ We know the true state directly/, "REQUIRED: runCheck() must reset the attempt budget right where it starts tracking a new report/check generation (immediately before/around the first setOccupant('processing') call)");
  assert.match(shell, /function checkAgain\(\) \{[\s\S]*?pollAttemptsRef\.current = 0;/, "REQUIRED: checkAgain must grant a genuinely fresh attempt budget — see tests/room-processing-navigation.test.mjs for the full structural proof of this function's exact body");
});

// ============================================================================
// Defect #3: authoritative server result must reconcile stale local state
// ============================================================================

test("Defect #3 (BEHAVIORAL): a terminal report matching the session's own tracked in-flight check id -> adopt", () => {
  const decision = evaluateReconciliation({ ok: true, contents: readyResolvedContents({ id: "own-report-1" }) }, "own-report-1");
  assert.equal(decision.action, "adopt");
});

test("Defect #3 (BEHAVIORAL, SAFETY-CRITICAL): a DIFFERENT report — even one whose createdAt is set arbitrarily far in the FUTURE relative to now — never adopts. Cross-client clock skew makes any createdAt-vs-local-clock comparison unsafe (a skewed clock could make an unrelated, older report look newer than it really is, letting it wrongly cancel an active run) — this restricts reconciliation to an exact report-id match only, with no timestamp-based ordering of any kind", () => {
  const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const decision = evaluateReconciliation({ ok: true, contents: readyResolvedContents({ id: "other-report", createdAt: farFuture }) }, "own-report-1");
  assert.equal(decision.action, "wait", "REQUIRED: an unrelated report must never cancel the current check regardless of how its createdAt compares to any local clock reading — createdAt must not be read by this function's decision at all");
});

test("Defect #3 (BEHAVIORAL): a DIFFERENT report with a createdAt clearly in the past also never adopts — the same 'any other id -> wait' rule applies uniformly, not just to future-looking timestamps", () => {
  const decision = evaluateReconciliation(
    { ok: true, contents: readyResolvedContents({ id: "other-report", createdAt: new Date(Date.now() - 60_000).toISOString() }) },
    "own-report-1",
  );
  assert.equal(decision.action, "wait");
});

test("Defect #3 (BEHAVIORAL): never adopts from an inconclusive (not ok) or not-yet-fully-revealed read — never manufactures a terminal result client-side", () => {
  assert.equal(evaluateReconciliation({ ok: false, status: 500 }, "own-report-1").action, "wait");
  assert.equal(evaluateReconciliation({ ok: true, contents: processingContents() }, "own-report-1").action, "wait");
  assert.equal(evaluateReconciliation({ ok: true, contents: readyPendingContents() }, "own-report-1").action, "wait", "ready-but-similarity-pending is not yet fully revealed — must not adopt");
  assert.equal(evaluateReconciliation({ ok: true, contents: { status: "empty", report: null, cycleEndsAt: null } }, "own-report-1").action, "wait");
});

test("Defect #3 (BEHAVIORAL): with no tracked report id yet (a check that hasn't reached analyzeText() yet), any terminal report never adopts", () => {
  const decision = evaluateReconciliation({ ok: true, contents: readyResolvedContents({ id: "other-report" }) }, null);
  assert.equal(decision.action, "wait");
});

test("Defect #3 (structural): evaluateReconciliation's own signature takes a plain reportId, never a startedAt/timestamp parameter — the unsafe comparison cannot silently creep back in", async () => {
  const shell = await readRoomShell();
  assert.match(shell, /export function evaluateReconciliation\(result: RoomContentsFetchResult, trackedReportId: string \| null\): ReconciliationDecision \{/, "REQUIRED: the function signature itself must make a timestamp parameter impossible to pass");
  assert.doesNotMatch(shell, /\bcheckStartedAtRef\b.*=.*Date\.now\(\)/, "REQUIRED: no ref may capture a local Date.now() for use in reconciliation");
  assert.doesNotMatch(shell, /Date\.parse\(serverReport\.createdAt\)/, "REQUIRED: serverReport.createdAt must never be parsed for a cross-client ordering decision");
});

test("Defect #3 (structural): the reconciliation watchdog effect runs only while isGeneratingReport is true, delegates to evaluateReconciliation with only the tracked report id, and on 'adopt' tears down every piece of local processing state plus adopts the server occupant", async () => {
  const shell = await readRoomShell();
  const watchdogMatch = shell.match(/useEffect\(\(\) => \{\s*\n\s*if \(!isGeneratingReport\) return;[\s\S]*?\}, \[isGeneratingReport, room\]\);/);
  assert.ok(watchdogMatch, "the reconciliation watchdog effect must be found, guarded on isGeneratingReport and depending on [isGeneratingReport, room]");
  const effect = watchdogMatch[0];
  assert.match(effect, /const decision = evaluateReconciliation\(result, currentCheckReportIdRef\.current\);/, "REQUIRED: must delegate to the shared, independently-tested evaluateReconciliation with just the tracked id — never a re-implemented inline own/newer/older check, never a timestamp argument");
  assert.match(effect, /if \(decision\.action === "adopt"\) \{/);
  for (const requiredTeardown of [
    "window.clearInterval(progressTimerRef.current);",
    "generationLockRef.current = false;",
    "setIsGeneratingReport(false);",
    "setProgress(0);",
    'setProcessingLabel("Reading document content");',
    "pollAttemptsRef.current = 0;",
    "setOccupant(decision.occupant);",
  ]) {
    assert.ok(effect.includes(requiredTeardown), `REQUIRED teardown step missing from the adopt branch: ${requiredTeardown}`);
  }
});

test("Defect #3 (structural): the completion-poll effect and the reconciliation watchdog have mutually exclusive guard conditions — they can never both be actively polling the same room at once", async () => {
  const shell = await readRoomShell();
  assert.match(shell, /if \(isFullyRevealed\(occupant\) \|\| isGeneratingReport \|\| pollExhausted\) return;/, "the completion poll must stay guarded out while isGeneratingReport is true");
  assert.match(shell, /if \(!isGeneratingReport\) return;/, "the watchdog must stay guarded out while isGeneratingReport is false");
});

test("Defect #3 (structural): runCheck() tracks its own check's identity — currentCheckReportIdRef reset to null right after the generation lock is taken, then filled in once analyzeText() produces a real report, before the academic-evidence step", async () => {
  const shell = await readRoomShell();
  const lockIndex = shell.indexOf("generationLockRef.current = true;");
  const resetIdIndex = shell.indexOf("currentCheckReportIdRef.current = null;");
  const progressTimerSetupIndex = shell.indexOf("progressTimerRef.current = window.setInterval(");
  assert.ok(lockIndex > -1 && resetIdIndex > lockIndex, "currentCheckReportIdRef must be reset to null after the generation lock is taken");
  assert.ok(progressTimerSetupIndex > -1 && progressTimerSetupIndex > resetIdIndex, "REQUIRED: the ref must be initialized before any async work (extraction/analysis) begins");
  assert.match(shell, /currentCheckReportIdRef\.current = String\(report\.id\);/, "REQUIRED: must normalize to the same String(id) shape ReportSummary.id already uses (buildReportSummary), so the watchdog's own === comparison is meaningful");
  // The id must be filled in strictly AFTER analyzeText() succeeds (report
  // exists) and BEFORE the academic-evidence/Promise.all step the earlier
  // investigation identified as the most likely hang point — otherwise the
  // watchdog would have no id to match against while a check is stuck there.
  const idAssignmentIndex = shell.indexOf("currentCheckReportIdRef.current = String(report.id);");
  const analyzeTextIndex = shell.indexOf("report = await analyzeText(text, submittedFile.name, submittedFile.size,");
  const academicEvidenceAwaitIndex = shell.indexOf('setProcessingLabel("Checking external academic sources");');
  assert.ok(analyzeTextIndex > -1 && idAssignmentIndex > analyzeTextIndex, "id must be assigned after analyzeText() produces the report");
  assert.ok(academicEvidenceAwaitIndex > -1 && idAssignmentIndex < academicEvidenceAwaitIndex, "id must be assigned before the academic-evidence step, so the watchdog can already match on it if that step hangs");
});

// ============================================================================
// Room-number mapping (unchanged, zero-based, end to end)
// ============================================================================

test("Room-number mapping: the raw, zero-based `room` value is used identically for save, poll, and reconciliation — the +1 offset exists ONLY in display text, never in a query/save argument", async () => {
  const shell = await readRoomShell();
  assert.match(shell, /saveReportRemote\(report, summary, academicResult\.academicSearchDiagnosticsId, room\)/, "the save must pass the raw room prop");
  assert.match(shell, /fetchReportRoomContents\(room\)/, "must appear for both the completion poll and the reconciliation watchdog");
  const fetchOccurrences = shell.match(/fetchReportRoomContents\(room\)/g) ?? [];
  assert.equal(fetchOccurrences.length, 2, "expected exactly 2 call sites: the completion poll and the reconciliation watchdog");

  // Every `room + 1` (or equivalent) occurrence must be inside literal
  // display text, never passed as an argument to a save/fetch/key.
  const plusOneOccurrences = [...shell.matchAll(/room \+ 1/g)];
  assert.ok(plusOneOccurrences.length >= 1, "sanity: the display convention must still exist somewhere");
  for (const match of plusOneOccurrences) {
    const context = shell.slice(Math.max(0, match.index - 40), match.index + 20);
    assert.match(context, /Room \{room \+ 1\}|`Room \$\{room \+ 1\}/, `REQUIRED: every "room + 1" occurrence must be literal display text, found in context: ${JSON.stringify(context)}`);
  }

  const page = await readRoomPage();
  assert.match(page, /const room = Number\(roomParam\);/, "the persisted room number is parsed directly from the URL param, never offset");
  assert.match(page, /findRoomOccupant\(client, sessionUser\.id, room\)/, "SSR must query with the same raw, unoffset room number");
  assert.match(page, /title: Number\.isInteger\(roomNumber\) \? `Room \$\{roomNumber \+ 1\}/, "the +1 in generateMetadata is display-only, in the page <title>, never in the DB query above it");
});

// ============================================================================
// Hard reload / SSR
// ============================================================================

test("Hard reload / SSR: a fresh terminal initialOccupant renders immediately with no local processing overlay — the overlay only ever renders when occupant.status is 'empty', and isGeneratingReport starts false on every fresh mount", async () => {
  const shell = await readRoomShell();
  assert.match(shell, /\{occupant\.status === "empty" && \(\s*\n\s*<div className="room-empty-slot">\s*\n\s*<DocumentUploadPanel/, "REQUIRED: the upload panel (where the progress overlay lives) is structurally gated on occupant.status === 'empty' — a fresh, terminal SSR occupant ('ready'/'failed') can never render it regardless of any other local state");
  // isGeneratingReport defaults to false (asserted in the Defect #1 test
  // above) and occupant is seeded directly from the fresh, per-request
  // initialOccupant prop (findRoomOccupant, self-heal included) with no
  // async gate before first paint — so a hard reload's fresh SSR read is
  // what the client shows immediately, never a stale intermediate state.
  const page = await readRoomPage();
  assert.match(page, /const loadRoom = cache\(async \(roomParam: string\): Promise<RoomPageResult> => \{/, "loadRoom must be a real per-request async computation");
  assert.match(page, /const occupant = await findRoomOccupant\(client, sessionUser\.id, room\);/, "SSR must call the same canonical, self-healing resolver the poll uses — never a separately-cached value");
});

// ============================================================================
// Scope check: nothing here touches scoring/corpus/retention/AI/PDF paths
// ============================================================================

test("Scope check: this fix adds no new import of any scoring/corpus-admission/retention/AI-computation/PDF-extraction module — comments may still name those systems to explain the relationship (e.g. the watchdog's own header comment references resolvePersistedSimilarityDisplay/findRoomOccupant), but the import list itself is the real boundary", async () => {
  const shell = await readRoomShell();
  // Matches every import's trailing `from "module";` regardless of whether
  // the import itself is single- or multi-line — this exact literal shape
  // (semicolon-terminated `from "...";`) does not otherwise occur in this
  // file (no dynamic import() calls, no JSX text matching it).
  const importedModules = [...shell.matchAll(/from "([^"]+)";/g)].map((m) => m[1]).sort();
  for (const forbidden of ["corpus-admission-", "corpus-match-generation", "unified-similarity", "http-content-retriever", "pdfjs", "corpus-retention"]) {
    assert.ok(!importedModules.some((m) => m.includes(forbidden)), `room-page-shell.tsx must not IMPORT anything from ${forbidden} — this fix is scoped to client lifecycle state only`);
  }
  // The full set of imports must be unchanged in kind (same modules), not
  // just absent of the forbidden ones — proves nothing new was pulled in at
  // all, not merely that the specific forbidden names weren't chosen.
  assert.deepEqual(importedModules, [
    "@/components/reports/document-upload-panel",
    "@/lib/ai-core",
    "@/lib/ai-core",
    // AI score / pending-state consistency fix: the room card's AI tile now
    // resolves through the one shared display-state interpreter every
    // surface uses (room card, My Reports list row, report detail page), so
    // they can never disagree the way the production "0% AI" vs "AI report
    // pending" split did. Pure presentation logic — no scoring, corpus,
    // retention, or PDF work — so it does not cross this scope check's
    // actual boundary (the forbidden-substring list above).
    "@/lib/ai-display-state",
    "@/lib/ai-model-prep",
    "@/lib/document-check-pipeline",
    "@/lib/extracted-text-normalization",
    "@/lib/report-ai-completion",
    "@/lib/report-rooms",
    "@/lib/report-rooms-cache",
    "@/lib/report-store",
    "@/lib/report-types",
    "@/lib/reports-remote",
    // Mixed-language misclassification fix: retryAiAnalysisWithFreshLanguage
    // needs detectLanguage to recompute language fresh from the report's own
    // text, rather than trusting a persisted (possibly stale) value. This is
    // the pure label/confidence detector itself — not scoring, corpus
    // admission, retention, or PDF extraction — so it does not violate this
    // scope check's actual boundary (the forbidden-substring list above).
    "@/lib/similarity-core",
    "lucide-react",
    "next/link",
    "react",
  ].sort(), "REQUIRED: the import module list must be exactly the pre-existing set — no new dependency on any other subsystem");
});
