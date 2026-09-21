import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isFullyRevealed } from "../app/reports/rooms/[room]/room-page-shell.tsx";

/**
 * Production bug fix: a room showing "Report ready · finishing AI
 * analysis" still let a user click "Open full report" and navigate to
 * /reports/[id] while the AI check was genuinely still processing — the
 * room's own "processing" branch rendered the real archiveScore as a
 * clickable number and an unconditional "Open full report" link.
 *
 * Release-hardening audit finding LIFECYCLE-05: AI-writing detection and
 * unified similarity are independent PIPELINES, but this room card
 * deliberately presents their completion as one atomic REVEAL — "reveal AI
 * score, unified similarity score, and receipt together," never a
 * patchwork of some-tiles-done-some-not. `isFullyRevealed(occupant)`
 * (app/reports/rooms/[room]/room-page-shell.tsx) is the ONE gate deciding
 * this: true only once ai_status is terminal (ready OR failed — an AI
 * failure is still a final, revealable answer, "Unavailable," never a
 * reason to keep waiting) AND similarity's own status is resolved (or
 * absent, the legacy-summary convention). Whenever that gate is false —
 * whether occupant.status itself is "processing," or already "ready"/
 * "failed" but similarity is still "stale"/"pending" — every tile stays
 * uniformly neutral and non-clickable; there is no in-between reveal.
 * Source-text wiring tests, matching the convention used throughout this
 * suite for React components with no test harness (see
 * tests/report-detail-route.test.mjs's own header comment).
 */

async function readRoomShell() {
  return readFile(new URL("../app/reports/rooms/[room]/room-page-shell.tsx", import.meta.url), "utf8");
}

const NOT_REVEALED_NEEDLE = '{!isFullyRevealed(occupant) && occupant.report && (';
const READY_NEEDLE = '{occupant.status === "ready" && isFullyRevealed(occupant) && occupant.report && (';
const FAILED_NEEDLE = '{occupant.status === "failed" && isFullyRevealed(occupant) && occupant.report && (';

function extractBranch(source, needle) {
  const start = source.indexOf(needle);
  assert.ok(start > -1, `the branch starting with ${JSON.stringify(needle)} must be found`);
  // Each branch is one of three sibling JSX blocks inside the same parent;
  // slicing to the next branch's start (or end of return) isolates it.
  const nextStarts = [NOT_REVEALED_NEEDLE, READY_NEEDLE, FAILED_NEEDLE]
    .filter((candidate) => candidate !== needle)
    .map((candidate) => source.indexOf(candidate, start + needle.length))
    .filter((i) => i > -1);
  const end = nextStarts.length > 0 ? Math.min(...nextStarts) : source.indexOf("</div>\n    </div>\n  );\n}", start);
  return source.slice(start, end);
}

test('isFullyRevealed (structural, report-lifecycle correctness fix): gates on ai_status terminal (ready OR failed) AND similarity NOT genuinely pending — a "stale" similarity (corpus/generation drift since this report was scored) no longer blocks reveal, since lib/reports-repo.ts\'s findRoomOccupant already resolves it to a displayable saved score before this ever runs; only "pending" (nothing was ever computed at all) still does', async () => {
  const shell = await readRoomShell();
  assert.match(shell, /export function isFullyRevealed\(occupant: RoomContents\): boolean \{/);
  assert.match(shell, /if \(occupant\.status !== "ready" && occupant\.status !== "failed"\) return false;/, 'must require ai_status to be terminal (ready or failed) — never reveal while genuinely processing');
  assert.match(shell, /return similarityStatus !== "pending";/, 'REQUIRED: "stale" must no longer block reveal (a historical report\'s saved similarity displays on reopen, never a perpetual "Updating…") — only genuinely "pending" similarity still does');
});

/**
 * BEHAVIORAL (release-hardening audit finding LIFECYCLE-06, approval-pass
 * addition): isFullyRevealed is a plain, exported pure function (no hooks —
 * unlike the rest of this "use client" component, it needed no export
 * before now) — these tests call it directly with real RoomContents-shaped
 * fixtures, mirroring the rigor tests/report-detail-poll.test.mjs already
 * applies to computeDetailRevealState, rather than only asserting on its
 * source text. Covers the room-card side of the exact 6 atomic-gate cases
 * verified for the detail page.
 */
function roomFixture(status, similarityStatus) {
  return {
    status,
    cycleEndsAt: new Date(Date.now() + 1000).toISOString(),
    report: {
      id: "behavioral-fixture-1", submissionId: "sub-behavioral-1", title: "behavioral.pdf",
      createdAt: new Date().toISOString(), wordCount: 500, archiveScore: 10,
      scoreBand: "Low", aiScore: status === "ready" ? 42 : null, aiTone: status === "ready" ? "low" : null,
      similarityStatus,
    },
  };
}

test("isFullyRevealed (BEHAVIORAL): AI processing + similarity resolved -> NOT revealed (Analysis in progress; no score/receipt reveal)", () => {
  assert.equal(isFullyRevealed(roomFixture("processing", "resolved")), false);
});

test("isFullyRevealed (BEHAVIORAL): AI ready + similarity pending -> NOT revealed (Analysis in progress)", () => {
  assert.equal(isFullyRevealed(roomFixture("ready", "pending")), false);
});

test("isFullyRevealed (BEHAVIORAL): AI ready + similarity resolved -> revealed (AI + similarity + receipt together)", () => {
  assert.equal(isFullyRevealed(roomFixture("ready", "resolved")), true);
});

test("isFullyRevealed (BEHAVIORAL): AI failed + similarity resolved -> revealed together; AI Unavailable (see the FAILED structural test below for the actual 'Unavailable' render proof)", () => {
  assert.equal(isFullyRevealed(roomFixture("failed", "resolved")), true);
});

test("isFullyRevealed (BEHAVIORAL, proves the headline room-card case): AI ready + similarity failed -> revealed together; Similarity Unavailable (see the LIFECYCLE-06 ROOM TILE render test in tests/similarity-result-consistency.test.mjs for the actual 'Unavailable' tile proof — SimilarityMetricTile only ever renders once this gate is true)", () => {
  assert.equal(isFullyRevealed(roomFixture("ready", "failed")), true);
});

test("isFullyRevealed (BEHAVIORAL): AI failed + similarity failed -> revealed together with both Unavailable", () => {
  assert.equal(isFullyRevealed(roomFixture("failed", "failed")), true);
});

test("isFullyRevealed (BEHAVIORAL, report-lifecycle correctness fix — the exact Room 4 reproducer): AI ready + similarity stale -> revealed (a completed historical report displays its saved result on reopen; 'stale' relative to today's corpus is not a reason to keep it hidden or to imply active recomputation)", () => {
  assert.equal(isFullyRevealed(roomFixture("ready", "stale")), true);
});

test("isFullyRevealed (BEHAVIORAL, proves the poll-exhaustion case — item 6): similarity pending after the poll budget exhausts remains NOT revealed — pollExhausted is a purely client-side flag that never touches occupant.status/similarityStatus (see checkAgain's own body below), so exhaustion can only ever route to the 'Retry analysis' sub-view within the SAME not-revealed branch, never to Unavailable or a reveal", async () => {
  assert.equal(isFullyRevealed(roomFixture("ready", "pending")), false, "exhaustion never changes the underlying occupant data — this fixture is identical whether or not pollExhausted is true");
  const shell = await readRoomShell();
  // Defect #2 fix: checkAgain also resets pollAttemptsRef.current so the
  // poll effect gets a genuinely fresh attempt budget (see that ref's own
  // comment) — still touches neither occupant nor similarityStatus, which
  // is the actual invariant this test proves.
  assert.match(shell, /function checkAgain\(\) \{[\s\S]*?pollAttemptsRef\.current = 0;\s*\n\s*setPollExhausted\(false\);\s*\n\s*\}/, "REQUIRED: checkAgain must reset the poll-attempt budget and the poll-exhaustion flag — and touch nothing else, never occupant, never similarityStatus");
  // The two poll-exhaustion sub-views (the "Check again"/"Retry analysis"
  // message vs. the plain "Analysis in progress" message) live INSIDE the
  // same not-revealed branch. Report-lifecycle correctness fix: the AI tile
  // in this branch now independently reflects occupant.status, so a GENUINE
  // ai_status "failed" (a real, persisted terminal state, not the exhaustion
  // flag) legitimately renders "Unavailable" for the AI tile even while
  // similarity is still pending — pollExhausted itself must never be the
  // thing that manufactures that text. Isolate just the pollExhausted
  // message block (never the whole branch, which now legitimately can
  // contain "Unavailable" via the independent AI tile) to prove exhaustion
  // alone adds no fabricated terminal state.
  const notRevealedBranch = extractBranch(shell, NOT_REVEALED_NEEDLE);
  const pollExhaustedMessage = notRevealedBranch.match(/<div className="ai-analysis-message" role="status">[\s\S]*?<\/div>\s*\) : \(/)?.[0] ?? "";
  assert.ok(pollExhaustedMessage, "the pollExhausted message block must be found");
  assert.doesNotMatch(pollExhaustedMessage, /Unavailable/, "REQUIRED: the pollExhausted message block itself must never render 'Unavailable' — a merely-exhausted poll is not a terminal failure; any 'Unavailable' text in this branch must come only from a real, independent ai_status \"failed\" tile, never from pollExhausted");
  assert.match(notRevealedBranch, /Analysis is taking longer than usual\./, "sanity: the pollExhausted sub-view (Retry analysis) is within this same branch");
});

test('NOT REVEALED (report-lifecycle correctness fix — invariant B): AI Detection and Similarity are rendered INDEPENDENTLY here — an occupant reaching this branch is, by construction (isFullyRevealed\'s own new formula), always similarity-pending, but AI may independently be "processing" (neutral placeholder), "ready" (real score, real link), or "failed" ("Unavailable"). AI must never show a neutral "Analyzing…" placeholder merely because similarity has not finished.', async () => {
  const branch = extractBranch(await readRoomShell(), NOT_REVEALED_NEEDLE);
  // The AI tile delegates to the SAME shared aiMetricDisplay helper the
  // fully-revealed READY branch uses — one interpreter, never a second,
  // possibly-drifting inline formula — conditioned on occupant.status, not
  // hardcoded neutral.
  assert.match(branch, /occupant\.status === "ready" \?/, "the AI tile must branch on occupant.status independently of similarity");
  assert.match(branch, /const ai = aiMetricDisplay\(occupant\.report\);/, "when AI is ready, the tile must resolve through the same shared aiMetricDisplay helper the fully-revealed branch uses — never a duplicated formula");
  assert.match(branch, /<Link href=\{`\/reports\/\$\{occupant\.report\.id\}\?mode=ai&room=\$\{room\}`\} className=\{`room-metric room-metric-\$\{ai\.toneClass\}`\}>/, "REQUIRED: an already-ready AI result must be a real, clickable link here too — never masked as non-clickable 'Analyzing…'");
  assert.match(branch, /occupant\.status === "failed" \?/, "a genuine AI failure must be its own independent branch");
  assert.match(branch, /<span className="room-metric-sub">Unavailable<\/span>/, "a genuine AI failure must render Unavailable here, exactly like the fully-revealed FAILED branch");

  // Similarity delegates entirely to the shared, resolved-aware
  // SimilarityMetricTile — the same component the fully-revealed branches
  // use — so a persisted-but-"stale" saved score (which lib/reports-repo.ts's
  // findRoomOccupant already resolves to "resolved" before this ever runs)
  // renders as a real, clickable number here too, never a hardcoded neutral
  // placeholder.
  assert.match(branch, /<SimilarityMetricTile report=\{occupant\.report\} room=\{room\} \/>/, "REQUIRED: Similarity must delegate to the same shared, resolved-aware component the fully-revealed branches use");

  // The genuinely-processing AI sub-case (occupant.status === "processing")
  // still falls back to the original neutral, non-clickable placeholder —
  // there is truly nothing to reveal yet on that side.
  const processingAiTile = branch.match(/<div className="room-metric room-metric-pending">\s*<span className="room-metric-label">AI Detection<\/span>[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.ok(processingAiTile, "the genuinely-processing AI Detection placeholder must still exist for occupant.status === \"processing\"");
  assert.match(processingAiTile, /<strong className="room-metric-value">···<\/strong>/);
  assert.match(processingAiTile, /<span className="room-metric-sub">Analyzing…<\/span>/);
  assert.doesNotMatch(processingAiTile, /<Link\b|href=/, "the genuinely-processing AI placeholder must not be a link");
});

/**
 * REPORT-LIFECYCLE CORRECTNESS FIX — task spec §14 (INDEPENDENT-STAGE UI):
 * the two explicit combinations the fix must handle correctly. Combines the
 * data-layer gate (isFullyRevealed) with the JSX rendering it feeds, in one
 * place, so each combo is verifiable end to end without cross-referencing
 * several other test files.
 */
test('INDEPENDENT-STAGE UI (§14, combo 1): AI = ready, Similarity = processing -> AI tile shows the saved score (real link, not "Analyzing…"), Similarity tile shows "Calculating…", Receipt stays "Preparing…", and Retry analysis is ABSENT (there is nothing wrong with AI to retry)', async () => {
  assert.equal(isFullyRevealed(roomFixture("ready", "pending")), false, "similarity genuinely pending still keeps the room as a whole not-yet-settled");

  const shell = await readRoomShell();
  const branch = extractBranch(shell, NOT_REVEALED_NEEDLE);
  // AI tile: real score, real link (occupant.status === "ready" branch).
  assert.match(branch, /occupant\.status === "ready" \?[\s\S]*?const ai = aiMetricDisplay\(occupant\.report\);/, "AI must resolve through the shared aiMetricDisplay helper when ready");
  assert.match(branch, /<Link href=\{`\/reports\/\$\{occupant\.report\.id\}\?mode=ai&room=\$\{room\}`\}/, "AI must be a real link when ready, even though similarity is still processing");
  // Similarity tile: delegates to SimilarityMetricTile, which itself renders
  // "Calculating…" for a genuinely "pending" similarityStatus (see
  // tests/similarity-result-consistency.test.mjs for that component's own
  // render proof).
  assert.match(branch, /<SimilarityMetricTile report=\{occupant\.report\} room=\{room\} \/>/);
  // Receipt: still Preparing.
  assert.match(branch, /<span className="room-metric-label">Receipt<\/span>[\s\S]*?<span className="room-metric-sub">Preparing…<\/span>/);
  // Retry analysis must be ABSENT when occupant.status is "ready" — the
  // pollExhausted sub-view's own guard.
  const pollExhaustedMessage = branch.match(/<div className="ai-analysis-message" role="status">[\s\S]*?<\/div>\s*\) : \(/)?.[0] ?? "";
  assert.match(pollExhaustedMessage, /\{occupant\.status !== "ready" && \(/, "REQUIRED (READY_AI_CAN_BE_RETRIED = NO): the Retry analysis button must be conditioned on occupant.status !== \"ready\"");
});

test('INDEPENDENT-STAGE UI (§14, combo 2): AI = failed, Similarity = ready -> AI shows failed/retryable ("Unavailable" + Retry analysis available), Similarity displays its real, ready saved result', () => {
  // This combination is already fully revealed (a genuine AI failure is
  // terminal — see isFullyRevealed's own formula) — the FAILED branch (not
  // the not-revealed branch) is what actually renders it; covered
  // structurally by the pre-existing 'FAILED (fully revealed)' test above.
  // This assertion pins the data-layer half of the same combination.
  assert.equal(isFullyRevealed(roomFixture("failed", "resolved")), true, "an AI failure is terminal — the room reveals, with AI shown as Unavailable/retryable and similarity shown as its real, ready result");
});

test('NOT REVEALED: Receipt shows "Preparing…", genuinely disabled — its own independent state, untouched by the AI/similarity reveal gate', async () => {
  const branch = extractBranch(await readRoomShell(), NOT_REVEALED_NEEDLE);
  assert.match(branch, /<button className="room-metric" type="button" disabled>\s*\n\s*<span className="room-metric-label">Receipt<\/span>/);
  assert.match(branch, /<span className="room-metric-sub">Preparing…<\/span>/);
});

test('NOT REVEALED: no separate, full-width "Open full report" escape hatch exists in this branch — a customer can only ever open the full report through a tile that itself already represents a real, terminal result (report-lifecycle correctness fix: the AI/Similarity tiles themselves may now legitimately link out once THEIR OWN piece is done — see the independent-tile test above — but there is still no separate blanket link that bypasses per-tile state)', async () => {
  const branch = extractBranch(await readRoomShell(), NOT_REVEALED_NEEDLE);
  assert.doesNotMatch(branch, /room-open-full/, "there must be no full-width 'Open full report' link");
});

test('NOT REVEALED: the loading message is pipeline-agnostic — "Analysis in progress," never claiming only AI is the reason', async () => {
  const branch = extractBranch(await readRoomShell(), NOT_REVEALED_NEEDLE);
  assert.match(branch, /<strong>Analysis in progress<\/strong>/);
  assert.match(branch, /Your AI-writing and similarity results will appear here together as soon as both are ready\./);
});

test('READY (fully revealed): both the real AI score and the real similarity score are shown, the AI tile as a working link into the full report', async () => {
  const branch = extractBranch(await readRoomShell(), READY_NEEDLE);
  // The AI tile resolves through the one shared interpreter
  // (lib/ai-display-state.ts, via aiMetricDisplay) so it can never disagree
  // with the My Reports list row or the report detail page — the exact
  // production split this fixes (room card "0% AI" vs detail "AI report
  // pending" for the same report).
  assert.match(branch, /const ai = aiMetricDisplay\(occupant\.report\);/, "the ready branch must resolve its AI tile through the shared aiMetricDisplay helper");
  assert.match(branch, /<strong className="room-metric-value">\{ai\.value\}<\/strong>/, "the ready branch must reveal the resolved AI score");
  // Release-hardening audit finding SIM-01, extracted into its own component
  // by SIM-04 (acceptance-check hardening — see room-page-shell.tsx's own
  // SimilarityMetricTile comment for why): the ready branch delegates its
  // Similarity tile entirely to that shared component. By construction
  // (isFullyRevealed gates this whole branch), that component's own
  // similarityStatus is always resolved here — SimilarityMetricTile's OWN
  // render tests (tests/similarity-result-consistency.test.mjs) cover its
  // actual score/link rendering.
  assert.match(branch, /<SimilarityMetricTile report=\{occupant\.report\} room=\{room\} \/>/, "the ready branch must render its Similarity tile through the shared SimilarityMetricTile component");
  assert.match(branch, /<Link href=\{`\/reports\/\$\{occupant\.report\.id\}\?mode=ai&room=\$\{room\}`\}/, "the AI tile must link into the full AI report");
});

test('FAILED (fully revealed): shows "AI analysis unavailable" framing and a real retry action, never a fabricated AI score — while still revealing the completed similarity result', async () => {
  const branch = extractBranch(await readRoomShell(), FAILED_NEEDLE);
  assert.doesNotMatch(branch, /\{occupant\.report\.aiScore/, "a failed check must never render occupant.report.aiScore, fabricated or otherwise");
  assert.match(branch, /<span className="room-metric-sub">Unavailable<\/span>/);
  assert.match(branch, /AI-writing analysis was unavailable for this document\./);
  assert.match(branch, /onClick=\{\(\) => retryAiCheck\(occupant\.report!\.id\)\}/, "a real retry action, wired to retryAiCheck, must be present");
  assert.match(branch, /\{retryingAi \? "Checking…" : "Retry analysis"\}/, 'renamed from "Retry AI check" — release-hardening audit finding LIFECYCLE-06: either AI or similarity may be the stuck pipeline, so the label must not imply AI-only');
  // REQUIRED: "AI failure counts as terminal... while still revealing the
  // completed similarity result" — this branch only ever renders once
  // isFullyRevealed is true, which already guarantees similarity is
  // resolved, so the Similarity tile here is the exact same real,
  // clickable component the "ready" branch uses, never held back by the
  // AI failure sitting right next to it.
  assert.match(branch, /<SimilarityMetricTile report=\{occupant\.report\} room=\{room\} \/>/);
});

test('READY-AI RETRY PROTECTION (§15, structural, second defensive layer): retryAiCheck itself refuses to re-run AI analysis when the freshly-fetched report is already ai_status "ready" ("complete"), checked BEFORE calling the model — independent of, and in addition to, the room card\'s own occupant.status !== "ready" UI gate on the Retry button', async () => {
  const shell = await readRoomShell();
  const retryFnMatch = shell.match(/async function retryAiCheck\(reportId: string\) \{[\s\S]*?\n {2}\}/);
  assert.ok(retryFnMatch, "retryAiCheck must be found");
  const retryFn = retryFnMatch[0];

  const guardIndex = retryFn.search(/if \(full\.aiAnalysis\?\.status === "complete"\) \{/);
  assert.ok(guardIndex > -1, "REQUIRED (READY_AI_OVERWRITE_VIA_RETRY_BLOCKED = YES): retryAiCheck must refuse to proceed when the report's own already-fetched AI result is complete");

  const modelCallIndex = retryFn.indexOf("await retryAiAnalysisWithFreshLanguage(full.text)");
  assert.ok(modelCallIndex > -1, "the model call itself must still exist for the genuine-recovery case");
  assert.ok(guardIndex < modelCallIndex, "REQUIRED: the ready-AI guard must run BEFORE the model is ever invoked, not after — this must be a refusal to start, never a discard-the-result-after-computing-it check");

  // G2: the retry persists through saveRetriedAiResult (saveEnrichedAiResult's AI-only twin); the guard-before-save invariant is unchanged.
  const saveCallIndex = retryFn.indexOf("await saveRetriedAiResult(full, aiResult)");
  assert.ok(saveCallIndex > -1, "the retry's save call must exist");
  assert.ok(guardIndex < saveCallIndex, "REQUIRED: the guard must also precede the save — an already-ready result must never reach saveRetriedAiResult at all via this path");

  // The guard condition itself is keyed on the report's OWN already-fetched
  // AI status, never on room number — "Do not key this by room number"
  // (task requirement).
  const guardCondition = retryFn.match(/if \(full\.aiAnalysis\?\.status === "complete"\) \{[\s\S]*?\n {6}\}/)?.[0] ?? "";
  assert.ok(guardCondition, "the guard's own if-block must be found");
  assert.doesNotMatch(guardCondition, /\broom\b/i, "REQUIRED: the guard condition/body must not reference room number — it protects the report itself, not a room slot");
});

/**
 * RECEIPT ATOMICITY (release-hardening audit finding LIFECYCLE-06,
 * approval-pass addition): Receipt must obey the SAME reveal boundary as
 * the AI/similarity tiles — Preparing/disabled while either pipeline is
 * non-terminal, available in the SAME state transition once both are
 * terminal, and never permanently stuck Preparing after a genuine failure
 * on either side. The "NOT REVEALED: Receipt shows 'Preparing…'" test above
 * already proves the first half; these prove the second and third.
 */
test('RECEIPT (fully revealed, AI ready): Receipt is present, wired to a real download handler, and only ever disabled transiently (an active download in flight) — never permanently stuck Preparing', async () => {
  const branch = extractBranch(await readRoomShell(), READY_NEEDLE);
  assert.match(branch, /<button className="room-metric" type="button" onClick=\{\(\) => handleDownloadReceipt\(occupant\.report!\.id\)\} disabled=\{downloadingReceipt\}>/, "REQUIRED: Receipt must become available in the SAME branch (same reveal) as the AI/similarity tiles, never a separate/delayed gate");
  assert.match(branch, /<span className="room-metric-sub">\{downloadingReceipt \? "Preparing…" : "Download"\}<\/span>/, "REQUIRED: 'Preparing…' here means only 'a download is actively in flight', not 'waiting on analysis' — it flips back to 'Download' the instant the in-flight request settles, never permanently stuck");
});

test('RECEIPT (fully revealed, AI failed): Receipt is STILL present and enabled — a genuine AI failure does not leave the receipt permanently stuck Preparing, since it bundles the similarity result that IS complete', async () => {
  const branch = extractBranch(await readRoomShell(), FAILED_NEEDLE);
  assert.match(branch, /<button className="room-metric" type="button" onClick=\{\(\) => handleDownloadReceipt\(occupant\.report!\.id\)\} disabled=\{downloadingReceipt\}>/, "REQUIRED: the FAILED branch's own Receipt button must be the exact same live, clickable control as the READY branch's — a real ai_status \"failed\" must never also disable Receipt");
  assert.match(branch, /<span className="room-metric-sub">\{downloadingReceipt \? "Preparing…" : "Download"\}<\/span>/);
});

test('RECEIPT (proves the room-card mirror of the headline LIFECYCLE-06 scenario): AI ready + similarity failed still reveals Receipt — isFullyRevealed(occupant) is the ONLY gate the READY branch (which owns the Receipt button) checks, and it is already proven BEHAVIORAL-ly true for this exact combination above, so a genuine similarity failure cannot leave Receipt stuck Preparing either', () => {
  assert.equal(isFullyRevealed(roomFixture("ready", "failed")), true, "REQUIRED: this is the exact gate the READY branch (and its Receipt button) checks before rendering at all — see the READY_NEEDLE branch's own literal condition, \"occupant.status === 'ready' && isFullyRevealed(occupant)\"");
});

test('statusLine (structural): "Analysis in progress" for any not-yet-fully-revealed occupant, regardless of whether ai_status itself is "processing" or already terminal', async () => {
  const shell = await readRoomShell();
  assert.match(shell, /isFullyRevealed\(occupant\) && occupant\.status === "ready"/, 'the "Report ready · Last checked" message must require full reveal, not just ai_status "ready"');
  assert.match(shell, /isFullyRevealed\(occupant\) && occupant\.status === "failed"/, 'the "AI analysis unavailable" message must also require full reveal');
  assert.match(shell, /occupant\.report \? "Analysis in progress"/, 'REQUIRED: any occupant with a report that is not yet fully revealed must show "Analysis in progress"');
});

test('SIM-04/LIFECYCLE-05/report-lifecycle-correctness ROOM CARD (structural): the "ready" and "failed" (fully-revealed) branches AND the not-revealed branch (invariant B — similarity must render independently of AI) all render Similarity through the ONE shared SimilarityMetricTile component — never a second, hand-duplicated formula anywhere', async () => {
  const shell = await readRoomShell();
  const occurrences = shell.match(/<SimilarityMetricTile report=\{occupant\.report\} room=\{room\} \/>/g) ?? [];
  assert.equal(occurrences.length, 3, 'expected exactly 3 call sites: the "ready" and "failed" fully-revealed branches, plus the not-revealed branch (report-lifecycle correctness fix — similarity must be able to show its own real, resolved-or-stale saved result even while AI is still genuinely processing)');
  assert.doesNotMatch(shell, /occupant\.report\.primaryScore \?\? occupant\.report\.archiveScore/, 'the raw fallback expression must never appear inline at any call site');
});

test("DIRECT REPORT URL: the report page derives its own real AI-lifecycle status and similarity status server-side, and the detail shell gates its entire render on both being terminal (via lib/report-detail-poll.ts's computeDetailRevealState) — never presenting the page as fully done while either is still partial", async () => {
  const page = await readFile(new URL("../app/reports/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /import \{ deriveRoomStatus \} from "@\/lib\/report-rooms";/);
  assert.match(page, /const aiStatus = deriveRoomStatus\(row\.ai_score, row\.ai_status\);/);
  // The AI-lifecycle status still drives the reveal gate; the flat
  // ai_score/ai_tone columns are now ALSO passed through, verbatim, as the
  // authoritative AI headline signal (see lib/ai-display-state.ts) so the
  // detail page can never disagree with the room card that reads the same
  // columns.
  assert.match(page, /return \{ status: "found", payload, aiStatus, aiScore: row\.ai_score, aiTone: row\.ai_tone, similarityStatus: display\.status \};/);
  assert.match(page, /initialAiStatus=\{result\.status === "found" \? result\.aiStatus : null\}/);
  assert.match(page, /initialAiScore=\{result\.status === "found" \? result\.aiScore : null\}/);
  assert.match(page, /initialAiTone=\{result\.status === "found" \? result\.aiTone : null\}/);

  const shell = await readFile(new URL("../app/reports/[id]/report-detail-shell.tsx", import.meta.url), "utf8");
  assert.match(shell, /initialAiStatus: DetailAiStatus;/, "the shell must accept the real status as a typed prop");
  // Release-hardening audit finding LIFECYCLE-04: the old per-status
  // "processing" banner (shown alongside an already-fully-rendered report)
  // is gone — it is structurally unreachable once bothReady gates the
  // entire return, so it was removed rather than left as dead code. The
  // combined loading screen below now owns that entire window.
  assert.doesNotMatch(shell, /\{aiStatus === "processing" && \(/, "the old per-status in-progress banner must no longer exist — the combined loading screen replaces it");

  // Release-hardening audit finding LIFECYCLE-06 (corrected): the reveal
  // decision itself is imported from lib/report-detail-poll.ts, not
  // reimplemented inline — see tests/report-detail-poll.test.mjs for the
  // deterministic behavioral proof of computeDetailRevealState/
  // startBoundedPoll themselves. This file only checks that the component
  // actually wires into that shared logic, never a parallel copy of it.
  assert.match(shell, /import \{\s*\n\s*computeDetailRevealState,\s*\n\s*startBoundedPoll,\s*\n\s*type DetailAiStatus,\s*\n\s*type DetailSimilarityStatus,\s*\n\s*\} from "@\/lib\/report-detail-poll";/);
  assert.match(shell, /const revealState = computeDetailRevealState\(\{ aiStatus, similarityStatus: effectiveSimilarityStatus, pollExhausted \}\);/, "REQUIRED: the reveal decision must come from the shared, independently-tested function, not a local reimplementation");
  assert.match(shell, /const bothReady = revealState\.screen === "revealed";/);
  assert.match(shell, /if \(revealState\.screen === "still-processing"\) \{/);
  assert.match(shell, /if \(revealState\.screen === "loading"\) \{/);
  assert.match(shell, /<strong>Analysis in progress<\/strong>/);
  assert.match(shell, /This report is still being analyzed\. It will appear here automatically as soon as everything is ready — no need to refresh\./);

  // The AI-unavailable banner reads revealState.aiUnavailable directly —
  // computeDetailRevealState's own return value, never a locally
  // recomputed condition that could drift from it (and, per LIFECYCLE-06's
  // correction, never a condition that also fires from pollExhausted —
  // see tests/report-detail-poll.test.mjs's own exhaustive proof that
  // aiUnavailable is only ever true for a genuine ai_status "failed").
  assert.match(shell, /\{revealState\.aiUnavailable && \(/);
  assert.match(shell, /AI-writing analysis was unavailable for this document\./);
  const failedBanner = shell.match(/\{revealState\.aiUnavailable && \([\s\S]*?\)\}/)?.[0] ?? "";
  assert.match(failedBanner, /<Link href=\{backHref\} className="button secondary">\{backLabel\}<\/Link>/);
});

test("LIFECYCLE-06 POLL WIRING (structural): the detail page's poll effect delegates to startBoundedPoll (imported from lib/report-detail-poll.ts, whose own bounded-attempt/exhaustion/cancellation behavior is proven behaviorally in tests/report-detail-poll.test.mjs) rather than reimplementing a loop inline", async () => {
  const shell = await readFile(new URL("../app/reports/[id]/report-detail-shell.tsx", import.meta.url), "utf8");
  // REQUIRED: no local loop()/attempts counter/setTimeout-based poll
  // mechanics may exist in this component any more — that logic (and its
  // exhaustion budget, request-shape, and cancellation guarantees) now
  // lives entirely in the shared, independently-tested lib/report-detail-poll.ts.
  assert.doesNotMatch(shell, /async function loop\(\)/, "the bounded-poll loop must not be reimplemented inline — it must come from startBoundedPoll");
  assert.doesNotMatch(shell, /window\.setTimeout\(/, "no raw setTimeout scheduling may exist in this component — startBoundedPoll owns that");
  assert.doesNotMatch(shell, /\bMAX_POLL_ATTEMPTS\b/, "the attempt budget must not be redeclared locally — it comes from lib/report-detail-poll.ts's DETAIL_MAX_POLL_ATTEMPTS, used only inside startBoundedPoll's own default");

  const effectMatch = shell.match(/useEffect\(\(\) => \{\s*\n\s*if \(!initialReport \|\| requiresClientResolution \|\| bothReady \|\| pollExhausted\) return;[\s\S]*?\n {2}\}, \[id, requiresClientResolution, initialReport, bothReady, pollExhausted\]\);/);
  assert.ok(effectMatch, "the authenticated poll effect must be found");
  const effect = effectMatch[0];
  assert.match(effect, /const handle = startBoundedPoll\(\{\s*\n\s*attempt: checkOnce,\s*\n\s*onExhausted: \(\) => setPollExhausted\(true\),\s*\n\s*\}\);/, "REQUIRED: the effect must wire checkOnce and setPollExhausted(true) into the shared engine, not roll its own");
  assert.match(effect, /return \(\) => \{\s*\n\s*cancelled = true;\s*\n\s*handle\.cancel\(\);\s*\n\s*\};/, "REQUIRED: cleanup must call handle.cancel() (proven in tests/report-detail-poll.test.mjs to stop all further activity) in addition to the local cancelled flag checkOnce itself checks");

  // checkOnce() must itself bail out on `cancelled` before touching any
  // state, so a fetch that was already in flight at unmount/re-run time
  // can't call setAiStatus/setSimilarityStatus/setReport after the fact —
  // this is checkOnce's own guarantee, layered on top of (not a substitute
  // for) startBoundedPoll's own cancel().
  const checkOnceMatch = effect.match(/async function checkOnce\(\): Promise<boolean> \{[\s\S]*?\n {4}\}/);
  assert.ok(checkOnceMatch, "checkOnce must be found");
  assert.match(checkOnceMatch[0], /if \(cancelled\) return true;/, "REQUIRED: an in-flight fetch resolving after unmount must not touch state");
});

test("LIFECYCLE-06 RETRY (structural): retryAnalysis resets pollExhausted, which the poll effect depends on, so the effect re-runs and starts a genuinely fresh startBoundedPoll call (a fresh attempts counter, per tests/report-detail-poll.test.mjs's own proof)", async () => {
  const shell = await readFile(new URL("../app/reports/[id]/report-detail-shell.tsx", import.meta.url), "utf8");
  assert.match(shell, /function retryAnalysis\(\) \{\s*\n\s*setPollExhausted\(false\);\s*\n\s*\}/, "REQUIRED: retry must reset the exhaustion flag, mirroring room-page-shell.tsx's own checkAgain()");
  assert.match(shell, /\[id, requiresClientResolution, initialReport, bothReady, pollExhausted\]/, "REQUIRED: pollExhausted must be a poll-effect dependency — otherwise retryAnalysis's setPollExhausted(false) could never re-trigger the effect and actually restart polling");

  assert.match(shell, /onClick=\{retryAnalysis\}/, "the Retry analysis button must be wired to retryAnalysis");
  assert.match(shell, />Retry analysis</, 'REQUIRED: label text — matches the room-card rename ("either AI or similarity may be stuck")');
});

test("LIFECYCLE-06 STILL PROCESSING SCREEN (structural): rendered exactly when revealState.screen === \"still-processing\" — 'Back to Room' stays available alongside Retry analysis, and this screen never appears while revealState.screen is \"revealed\" or \"loading\"", async () => {
  const shell = await readFile(new URL("../app/reports/[id]/report-detail-shell.tsx", import.meta.url), "utf8");
  const stillProcessingMatch = shell.match(/if \(revealState\.screen === "still-processing"\) \{\s*\n[\s\S]*?\n {2}\}\s*\n\s*\n\s*if \(revealState\.screen === "loading"\)/);
  assert.ok(stillProcessingMatch, "the still-processing branch, immediately followed by the loading branch, must be found");
  const block = stillProcessingMatch[0];
  assert.match(block, /Still processing\. This report is taking longer than usual to analyze\./, 'REQUIRED: literal "Still processing" text');
  assert.match(block, /<button className="button subtle" type="button" onClick=\{retryAnalysis\}>Retry analysis<\/button>/);
  const backLinkOccurrences = block.match(/<Link href=\{backHref\} className="button secondary">\{backLabel\}<\/Link>/g) ?? [];
  assert.ok(backLinkOccurrences.length >= 1, "REQUIRED: Back to Room must remain available in the still-processing screen");

  // The actively-polling ("Analysis in progress"/"loading") screen must
  // ALSO still offer the back link — requirement #1 covers both loading
  // sub-states, not only the exhausted one.
  const loadingMatch = shell.match(/if \(revealState\.screen === "loading"\) \{[\s\S]*?\n {2}\}/);
  assert.ok(loadingMatch, "the loading branch must be found");
  assert.match(loadingMatch[0], /<Link href=\{backHref\} className="button secondary">\{backLabel\}<\/Link>/, "the actively-polling screen must also offer its own Back to Room link");
});

test("LIFECYCLE-06 CORRECTED REVEAL GATE (structural): revealState comes ONLY from computeDetailRevealState — there is no local 'exhaustion unblocks a partial reveal' logic anywhere in this component (release-hardening audit correction: an earlier version of this fix wrongly treated poll exhaustion as terminal failure — see lib/report-detail-poll.ts's own header comment)", async () => {
  const shell = await readFile(new URL("../app/reports/[id]/report-detail-shell.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(shell, /\banyTerminal\b/, "REQUIRED: exhaustion-plus-any-terminal must never be a reveal path — computeDetailRevealState's own bothReady-only gate is the single source of truth");
  assert.doesNotMatch(shell, /pollExhausted && !aiTerminal/, "REQUIRED: pollExhausted must never be combined with aiTerminal to synthesize an AI-unavailable state — a real ai_status \"failed\" is the only source of aiUnavailable");
  assert.doesNotMatch(shell, /pollExhausted && !similarityTerminal/, "REQUIRED: pollExhausted must never be combined with similarityTerminal to synthesize a similarity-unavailable state — a real, persisted unifiedSimilarityFailed is the only source of similarityUnavailable");
  assert.doesNotMatch(shell, /revealed = bothReady \|\|/, "REQUIRED: there must be no 'bothReady OR exhausted-with-something-terminal' formula anywhere in this file");

  // Release-hardening audit finding LIFECYCLE-06 (extended): aiUnavailable
  // AND similarityUnavailable now both reflect real, independently-
  // persisted terminal-failure signals (ai_status "failed",
  // unifiedSimilarityFailed) — computeDetailRevealState's own return value,
  // never a locally recomputed condition. The score chip and inspector
  // card must branch on revealState.similarityUnavailable specifically
  // (never a bare, unconditional render) — "revealed" no longer strictly
  // implies a numeric similarity result, since a genuine terminal failure
  // also reveals.
  // Report-redesign <1% rounding fix: both raw `${primaryScore}%` templates
  // were replaced with formatSimilarityPercent(primaryScore, ...) so a
  // genuine positive overlap that rounds to 0 reads as "<1%" rather than a
  // false "0%" — the "Unavailable"/"—" branches (this assertion's real
  // subject) are untouched.
  assert.match(shell, /revealState\.similarityUnavailable \? "Unavailable" : `\$\{formatSimilarityPercent\(primaryScore, primaryMatchedWordCount\(report\)\)\} \$\{primaryLabel\}`/, "the summary score chip must show literal Unavailable text, never a number, when similarity genuinely, terminally failed");
  assert.match(shell, /revealState\.similarityUnavailable \? "—" : formatSimilarityPercent\(primaryScore, primaryMatchedWordCount\(report\)\)/, "the inspector score card must also suppress the numeric score when similarity genuinely, terminally failed");

  // OverviewReport must be told the real (possibly "failed") similarity
  // status explicitly — "revealed" no longer strictly implies "resolved",
  // so relying on OverviewReport's own "resolved" default would silently
  // show a real-looking score/section run for a report whose similarity
  // genuinely, terminally failed.
  const overviewCalls = shell.match(/<OverviewReport report=\{report\} similarityStatus=\{effectiveSimilarityStatus\} \/>/g) ?? [];
  assert.equal(overviewCalls.length, 3, "expected 3 call sites: full-report-preview, the standalone overview tab, and the print bundle, each passing the real status explicitly");
});
