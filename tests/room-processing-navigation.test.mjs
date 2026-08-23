import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Production bug fix: a room showing "Report ready · finishing AI
 * analysis" still let a user click "Open full report" or the Similarity
 * tile and navigate to /reports/[id] while the AI check was genuinely
 * still processing — the room's own "processing" branch rendered the real
 * archiveScore as a clickable number and an unconditional "Open full
 * report" link. Source-text wiring tests, matching the convention used
 * throughout this suite for React components with no test harness (see
 * tests/report-detail-route.test.mjs's own header comment).
 */

async function readRoomShell() {
  return readFile(new URL("../app/reports/rooms/[room]/room-page-shell.tsx", import.meta.url), "utf8");
}

function extractBranch(source, statusLiteral) {
  const startNeedle = `{occupant.status === "${statusLiteral}" && occupant.report && (`;
  const start = source.indexOf(startNeedle);
  assert.ok(start > -1, `the "${statusLiteral}" branch must be found`);
  // Each branch is one of three sibling JSX blocks inside the same parent;
  // slicing to the next branch's start (or end of return) isolates it.
  const nextBranchNeedles = ['{occupant.status === "processing"', '{occupant.status === "ready"', '{occupant.status === "failed"']
    .filter((needle) => !needle.startsWith(`{occupant.status === "${statusLiteral}"`));
  const nextStarts = nextBranchNeedles.map((needle) => source.indexOf(needle, start + startNeedle.length)).filter((i) => i > -1);
  const end = nextStarts.length > 0 ? Math.min(...nextStarts) : source.indexOf("</div>\n    </div>\n  );\n}", start);
  return source.slice(start, end);
}

test("PROCESSING: no numeric similarity is ever rendered — both AI and Similarity show the same 'Analyzing…' placeholder", async () => {
  const branch = extractBranch(await readRoomShell(), "processing");
  assert.doesNotMatch(branch, /\{occupant\.report\.archiveScore\}%/, "the real similarity percentage must never render while processing");
  const analyzingCount = (branch.match(/Analyzing…/g) ?? []).length;
  assert.equal(analyzingCount, 2, "both AI Detection and Similarity must show 'Analyzing…' — found a different count");
  assert.match(branch, /<span className="room-metric-label">AI Detection<\/span>/);
  assert.match(branch, /<span className="room-metric-label">Similarity<\/span>/);
});

test("PROCESSING: the 'Open full report' link does not exist anywhere in this branch", async () => {
  const branch = extractBranch(await readRoomShell(), "processing");
  // Checks for the actual rendered link (its CSS class and its href
  // pattern into /reports/[id]), not the bare phrase — which legitimately
  // still appears in this branch's own explanatory JSX comment about why
  // the link was removed.
  assert.doesNotMatch(branch, /room-open-full/, "there must be no way to reach /reports/[id] while the room is still processing");
  assert.doesNotMatch(branch, /<Link href=\{`\/reports\/\$\{occupant\.report\.id\}/, "no Link into /reports/[id] of any kind may exist in the processing branch");
});

test("PROCESSING: the Similarity tile is not a link (or any other clickable navigation) — it is inert while processing", async () => {
  const branch = extractBranch(await readRoomShell(), "processing");
  // The Similarity label must appear inside a plain, non-interactive
  // element, not inside a <Link>/<a> that would navigate to the report.
  const similarityBlockMatch = branch.match(/<[^>]+>\s*<span className="room-metric-label">Similarity<\/span>[\s\S]*?<\/(?:div|Link)>/);
  assert.ok(similarityBlockMatch, "the Similarity tile block must be found");
  assert.doesNotMatch(similarityBlockMatch[0], /<Link\b/, "the processing-state Similarity tile must not be a Link");
  assert.doesNotMatch(similarityBlockMatch[0], /href=/, "the processing-state Similarity tile must carry no navigable href at all");

  // Receipt must be genuinely disabled (a plain `disabled` attribute — not
  // conditionally tied to a client-only download-in-flight flag, since the
  // room itself isn't ready yet regardless of that state).
  assert.match(branch, /<button className="room-metric" type="button" disabled>\s*\n\s*<span className="room-metric-label">Receipt<\/span>/);
  assert.match(branch, /<span className="room-metric-sub">Preparing…<\/span>/);
});

test("READY: both the real AI score and the real similarity score are shown, each as a working link into the full report", async () => {
  const branch = extractBranch(await readRoomShell(), "ready");
  assert.match(branch, /<strong className="room-metric-value">\{occupant\.report\.aiScore \?\? "—"\}%<\/strong>/, "the ready branch must reveal the real AI score");
  // Release-hardening audit finding SIM-01: prefers occupant.report.primaryScore
  // (the combined result, set by buildReportSummary whenever the caller
  // already had a full report in hand — see ReportSummary's own comment)
  // and falls back to archiveScore only when primaryScore is absent (the
  // lightweight, DB-only room fetch path) — still always the real value
  // either way, never a fabricated one.
  assert.match(branch, /<strong className="room-metric-value">\{occupant\.report\.primaryScore \?\? occupant\.report\.archiveScore\}%<\/strong>/, "the ready branch must reveal the real similarity score");
  assert.match(branch, /<Link href=\{`\/reports\/\$\{occupant\.report\.id\}\?mode=ai&room=\$\{room\}`\}/, "the AI tile must link into the full AI report");
  assert.match(branch, /<Link href=\{`\/reports\/\$\{occupant\.report\.id\}\?room=\$\{room\}`\}/, "the Similarity tile must link into the full report");
});

test("FAILED: shows 'AI analysis unavailable' framing and a real retry action, never a fabricated score", async () => {
  const branch = extractBranch(await readRoomShell(), "failed");
  assert.doesNotMatch(branch, /\{occupant\.report\.aiScore/, "a failed check must never render occupant.report.aiScore, fabricated or otherwise");
  assert.match(branch, /AI-writing analysis was unavailable for this document\./);
  assert.match(branch, /onClick=\{\(\) => retryAiCheck\(occupant\.report!\.id\)\}/, "a real retry action, wired to retryAiCheck, must be present");
  assert.match(branch, /\{retryingAi \? "Checking…" : "Retry AI check"\}/);
  // The similarity result is real and unaffected by an AI failure — this
  // branch's own real primaryScore (or archiveScore fallback — see SIM-01)
  // must still render.
  assert.match(branch, /<strong className="room-metric-value">\{occupant\.report\.primaryScore \?\? occupant\.report\.archiveScore\}%<\/strong>/);
});

test("DIRECT REPORT URL: the report page derives its own real AI-lifecycle status server-side and shows an explicit in-progress/unavailable state instead of pretending the page is fully done", async () => {
  const page = await readFile(new URL("../app/reports/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /import \{ deriveRoomStatus \} from "@\/lib\/report-rooms";/);
  assert.match(page, /const aiStatus = deriveRoomStatus\(row\.ai_score, row\.ai_status\);/);
  assert.match(page, /return \{ status: "found", payload, aiStatus \};/);
  assert.match(page, /initialAiStatus=\{result\.status === "found" \? result\.aiStatus : null\}/);

  const shell = await readFile(new URL("../app/reports/[id]/report-detail-shell.tsx", import.meta.url), "utf8");
  assert.match(shell, /initialAiStatus: "processing" \| "ready" \| "failed" \| null;/, "the shell must accept the real status as a typed prop");
  assert.match(shell, /\{aiStatus === "processing" && \(/, "an explicit in-progress banner must render when the report's AI check is still running");
  assert.match(shell, /AI-writing analysis is still in progress for this report\./);
  assert.match(shell, /\{aiStatus === "failed" && \(/, "an explicit unavailable banner must render when the AI check genuinely failed");
  assert.match(shell, /AI-writing analysis was unavailable for this document\./);
  // Both banners must offer real navigation back (to the room when known,
  // to My Reports otherwise) — never a dead end.
  const processingBanner = shell.match(/\{aiStatus === "processing" && \([\s\S]*?\)\}/)?.[0] ?? "";
  assert.match(processingBanner, /<Link href=\{backHref\} className="button secondary">\{backLabel\}<\/Link>/);
});
