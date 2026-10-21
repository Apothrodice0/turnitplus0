/**
 * SAVED DOCUMENT LAYOUT (2026-10-21) — the original document's formatting, captured during the upload and stored
 * privately with the report (drizzle/0055, lib/report-document-layout*.ts, app/api/reports/[id]/document-layout).
 *
 * Pins: owner-only access on every route (another account and no session never see it); a layout is accepted only
 * for its own report's text; size/type limits; cross-origin writes refused; removal with the report; a database
 * without migration 0055 never breaks a report (reads say "none", deletes are no-ops); the stored format validates.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createClient } from "@libsql/client";

import { applyMigrationsLibsql } from "../lib/ingest.js";
import { resetAuthRateForTest, resetRateForTest, resetReadRateForTest } from "../lib/rate-limit.ts";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as reportIdRoute from "../app/api/reports/[id]/route.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import * as layoutRoute from "../app/api/reports/[id]/document-layout/route.ts";
import * as mediaRoute from "../app/api/reports/[id]/document-layout/media/[index]/route.ts";
import { withTestIdentity } from "./helpers/test-signup.mjs";
import {
  DOCUMENT_LAYOUT_LIMITS,
  fromStoredDocumentLayout,
  parseStoredDocumentLayout,
  toStoredDocumentLayout,
} from "../lib/report-document-layout.ts";
import {
  deleteReportDocumentLayout,
  deleteReportDocumentLayoutsForUser,
  readReportDocumentLayout,
  saveReportDocumentLayout,
} from "../lib/report-document-layout-repo.ts";

// ── harness ──────────────────────────────────────────────────────────────
const dbFile = path.join(path.resolve("."), "test_report_document_layout.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
const db = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(db, path.join(path.resolve("."), "drizzle"));
test.after(() => {
  db.close();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore (Windows EBUSY) */ } }
});

const cookieOf = (res) => (res.headers.get("set-cookie")?.match(/tp_session_v1=([^;]*)/) ?? [])[1] ?? null;
let accounts = 0;
async function account() {
  accounts += 1;
  const tag = `rdl-${accounts}`;
  await resetAuthRateForTest(`${tag}-signup`);
  const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `${tag}-signup` },
    body: JSON.stringify(withTestIdentity({ email: `${tag}@example.test`, password: "rdl-pw-123456", username: `rdlu${accounts}`, deviceKey: `rdl-dev-${accounts}` })),
  }));
  assert.equal(res.status, 201);
  return { deviceKey: `rdl-dev-${accounts}`, cookie: cookieOf(res), tag };
}

const TEXT = "Centred Title Of The Study\nA justified paragraph of the manuscript with enough words to analyse.\nFigure 01: caption";
async function saveReport(acc, id, room = 0) {
  await resetRateForTest(`${acc.tag}-post`);
  const created = new Date().toISOString();
  const res = await reportsRoute.POST(new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `${acc.tag}-post`, cookie: `tp_session_v1=${acc.cookie}` },
    body: JSON.stringify({
      deviceKey: acc.deviceKey, id, submissionId: `sub-${id}`, title: "layout fixture.docx", createdAt: created,
      wordCount: 20, archiveScore: 0, scoreBand: "Low", aiScore: null, aiTone: null, aiStatus: "processing", room,
      payload: { version: 11, id, submissionId: `sub-${id}`, title: "layout fixture.docx", author: "", assignment: "", created, score: 0, archiveScore: 0, wordCount: 20, scoreBand: "Low", matchedWordCount: 0, archiveMatchedPositions: [], sources: [], repeats: [], text: TEXT },
    }),
  }));
  assert.ok(res.status === 200 || res.status === 201, `report saved (${res.status})`);
}

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"));
const para = (text, extra = {}) => ({ kind: "paragraph", align: "justify", rtl: false, indentLeftPx: 0, indentRightPx: 0, firstLinePx: 48, spaceBeforePx: 0, spaceAfterPx: 8, lineHeight: null, heading: null, listLabel: null, inlines: [{ kind: "text", text, style: { bold: false } }], ...extra });
function layoutFor(text = TEXT) {
  const doc = {
    blocks: [
      para("Centred Title Of The Study", { align: "center" }),
      para("A justified paragraph of the manuscript with enough words to analyse."),
      { ...para(""), inlines: [{ kind: "image", mediaPath: "word/media/image1.png", widthPx: 100, heightPx: 50, alt: "Figure" }] },
      para("Figure 01: caption"),
    ],
    layout: { contentWidthPx: 600, baseSizePt: 12 },
    media: new Map([["word/media/image1.png", { bytes: PNG, contentType: "image/png" }]]),
    warnings: [],
  };
  return toStoredDocumentLayout(doc, sha(text), [{ path: "word/media/image1.png", contentType: "image/png" }]);
}

function form(layout, media = [new Blob([PNG], { type: "image/png" })]) {
  const f = new FormData();
  f.append("layout", new Blob([typeof layout === "string" ? layout : JSON.stringify(layout)], { type: "application/json" }), "layout.json");
  media.forEach((m, i) => f.append("media", m, `image-${i}`));
  return f;
}
const ctx = (id, index) => ({ params: Promise.resolve(index === undefined ? { id } : { id, index: String(index) }) });
async function put(acc, id, body, headers = {}) {
  await resetRateForTest(`${acc?.tag ?? "anon"}-layout`);
  return layoutRoute.PUT(new Request(`http://localhost/api/reports/${id}/document-layout`, {
    method: "PUT", body, headers: { "x-forwarded-for": `${acc?.tag ?? "anon"}-layout`, ...(acc ? { cookie: `tp_session_v1=${acc.cookie}` } : {}), ...headers },
  }), ctx(id));
}
async function getLayout(acc, id) {
  await resetReadRateForTest(`${acc?.tag ?? "anon"}-read`);
  return layoutRoute.GET(new Request(`http://localhost/api/reports/${id}/document-layout`, { headers: { "x-forwarded-for": `${acc?.tag ?? "anon"}-read`, ...(acc ? { cookie: `tp_session_v1=${acc.cookie}` } : {}) } }), ctx(id));
}
async function getMedia(acc, id, index) {
  await resetReadRateForTest(`${acc?.tag ?? "anon"}-read`);
  return mediaRoute.GET(new Request(`http://localhost/api/reports/${id}/document-layout/media/${index}`, { headers: { "x-forwarded-for": `${acc?.tag ?? "anon"}-read`, ...(acc ? { cookie: `tp_session_v1=${acc.cookie}` } : {}) } }), ctx(id, index));
}

// ── tests ────────────────────────────────────────────────────────────────
test("OWNER: the layout and its image are stored with the report and read back by the owner, privately", async () => {
  const a = await account();
  await saveReport(a, "9100000000001");
  const saved = await put(a, "9100000000001", form(layoutFor()));
  assert.equal(saved.status, 204);
  const res = await getLayout(a, "9100000000001");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("cache-control"), /private, no-store/);
  const body = await res.json();
  const stored = parseStoredDocumentLayout(body.layout);
  assert.ok(stored, "a valid stored layout comes back");
  assert.deepEqual(body.mediaIndexes, [0]);
  assert.equal(stored.blocks[0].align, "center");
  assert.equal(stored.blocks[2].inlines[0].mediaPath, "media:0", "image references never carry the .docx's own paths");
  const img = await getMedia(a, "9100000000001", 0);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.match(img.headers.get("cache-control"), /private, no-store/);
  assert.equal(img.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await img.arrayBuffer()), PNG);
});

test("ACCESS: another account and an anonymous request can neither read nor write someone else's layout or images", async () => {
  const a = await account();
  const b = await account();
  await saveReport(a, "9100000000002");
  assert.equal((await put(a, "9100000000002", form(layoutFor()))).status, 204);
  assert.equal((await getLayout(b, "9100000000002")).status, 404);
  assert.equal((await getMedia(b, "9100000000002", 0)).status, 404);
  assert.equal((await put(b, "9100000000002", form(layoutFor()))).status, 404, "cannot overwrite it either");
  assert.equal((await getLayout(null, "9100000000002")).status, 401);
  assert.equal((await getMedia(null, "9100000000002", 0)).status, 401);
  assert.equal((await put(null, "9100000000002", form(layoutFor()))).status, 401);
  // the same report id under another account is a different report: B's own copy never mixes with A's
  await saveReport(b, "9100000000002", 1);
  assert.equal((await getLayout(b, "9100000000002")).status, 404, "B has no layout for its own report with the same id");
  assert.equal((await getLayout(a, "9100000000002")).status, 200);
});

test("INTEGRITY: only a well-formed layout of this report's own text is accepted; image types and sizes are limited; cross-site writes refused", async () => {
  const a = await account();
  await saveReport(a, "9100000000003");
  assert.equal((await put(a, "9100000000003", form(layoutFor("some other text")))).status, 409, "a layout of different text");
  assert.equal((await put(a, "9100000000003", form("{\"version\":1}"))).status, 400, "malformed layout");
  assert.equal((await put(a, "9100000000003", form(layoutFor(), [new Blob([PNG], { type: "image/svg+xml" })]))).status, 415, "only raster image types");
  assert.equal((await put(a, "9100000000003", form(layoutFor(), []))).status, 400, "images must match the layout");
  assert.equal((await put(a, "9100000000003", form(layoutFor()), { "content-length": String(DOCUMENT_LAYOUT_LIMITS.requestBytes + 1) })).status, 413);
  assert.equal((await put(a, "9100000000003", form(layoutFor()), { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await getLayout(a, "9100000000003")).status, 404, "nothing was stored by the refused requests");
});

test("CLEANUP: deleting the report removes its layout and images; account cleanup removes all of an account's", async () => {
  const a = await account();
  await saveReport(a, "9100000000004");
  assert.equal((await put(a, "9100000000004", form(layoutFor()))).status, 204);
  await resetRateForTest(`${a.tag}-del`);
  const del = await reportIdRoute.DELETE(new Request("http://localhost/api/reports/9100000000004", { method: "DELETE", headers: { "x-forwarded-for": `${a.tag}-del`, cookie: `tp_session_v1=${a.cookie}` } }), ctx("9100000000004"));
  assert.ok(del.status < 300, `report deleted (${del.status})`);
  const left = await db.execute({ sql: "SELECT (SELECT COUNT(*) FROM report_document_layouts WHERE report_id = ?) AS l, (SELECT COUNT(*) FROM report_document_media WHERE report_id = ?) AS m", args: ["9100000000004", "9100000000004"] });
  assert.deepEqual([Number(left.rows[0].l), Number(left.rows[0].m)], [0, 0]);

  const userId = "rdl-user-direct";
  await saveReportDocumentLayout(db, { reportId: "r1", userId, layoutVersion: 1, textSha256: "0".repeat(64), layoutJson: "{}", media: [{ contentType: "image/png", bytes: PNG }] });
  await saveReportDocumentLayout(db, { reportId: "r2", userId, layoutVersion: 1, textSha256: "0".repeat(64), layoutJson: "{}", media: [] });
  await deleteReportDocumentLayoutsForUser(db, userId);
  assert.equal(await readReportDocumentLayout(db, "r1", userId), null);
  assert.equal(await readReportDocumentLayout(db, "r2", userId), null);
});

test("NOT YET MIGRATED: without migration 0055 a report is unaffected — reads say 'no layout', deletes do nothing, a save is refused cleanly", async () => {
  const bare = path.join(path.resolve("."), "test_report_document_layout_bare.db");
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${bare}${s}`); } catch { /* ignore */ } }
  const c = createClient({ url: `file:${bare}` });
  try {
    assert.equal(await readReportDocumentLayout(c, "x", "u"), null);
    await deleteReportDocumentLayout(c, "x", "u");
    await deleteReportDocumentLayoutsForUser(c, "u");
    await assert.rejects(() => saveReportDocumentLayout(c, { reportId: "x", userId: "u", layoutVersion: 1, textSha256: "0".repeat(64), layoutJson: "{}", media: [] }), /no such table/);
  } finally {
    c.close();
    for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${bare}${s}`); } catch { /* ignore */ } }
  }
});

test("FORMAT: the stored layout validates strictly and round-trips to the renderer's model", () => {
  const stored = layoutFor();
  const back = fromStoredDocumentLayout(parseStoredDocumentLayout(JSON.parse(JSON.stringify(stored))));
  assert.equal(back.blocks.length, 4);
  assert.equal(back.blocks[2].inlines[0].mediaPath, "media:0");
  for (const bad of [
    { ...stored, version: 2 },
    { ...stored, textSha256: "nothex" },
    { ...stored, blocks: [{ kind: "script" }] },
    { ...stored, blocks: [{ ...stored.blocks[0], inlines: [{ kind: "image", mediaPath: "https://example.org/x.png", widthPx: 1, heightPx: 1, alt: "" }] }] },
    { ...stored, blocks: [{ ...stored.blocks[0], inlines: [{ kind: "text", text: "x", style: { color: "red;background:url(x)" } }] }] },
    { ...stored, media: [{ index: 0, contentType: "text/html" }] },
  ]) assert.equal(parseStoredDocumentLayout(bad), null, JSON.stringify(bad).slice(0, 80));
  let deep = { kind: "textbox", floating: false, heightPx: 0, blocks: [] };
  for (let i = 0; i < 10; i += 1) deep = { kind: "textbox", floating: false, heightPx: 0, blocks: [deep] };
  assert.equal(parseStoredDocumentLayout({ ...stored, blocks: [deep] }), null, "nesting is bounded");
});

test("WIRING: captured once after the upload is saved (no second file selection), loaded automatically for the one Download Report action, cleaned up on room replacement", async () => {
  const room = await readFile(new URL("../app/reports/rooms/[room]/room-page-shell.tsx", import.meta.url), "utf8");
  assert.match(room, /sourceFile: submittedFile,/);
  assert.match(room, /void captureAndSaveDocumentLayout\(String\(report\.id\), pending\.sourceFile, report\.text \?\? ""\);/);
  const shell = await readFile(new URL("../app/reports/[id]/report-detail-shell.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(shell, /type="file"|onDownloadFormattedReport|chooseOriginalDocx/, "no re-attach step anywhere");
  assert.match(shell, /loadSavedFormattedManuscript\(target, similarityPrintHighlights\(target\)\)/);
  assert.match(shell, /onDownloadReport=\{handleDownloadReport\}/);
  const workspace = await readFile(new URL("../components/report/report-v2/report-v2-view.tsx", import.meta.url), "utf8");
  assert.equal((workspace.match(/Download report/g) ?? []).length >= 1, true);
  assert.doesNotMatch(workspace, /original formatting/i, "only one Download Report action");
  const post = await readFile(new URL("../app/api/reports/route.ts", import.meta.url), "utf8");
  assert.match(post, /await tx\.commit\(\);\s*\n\s*if \(replacedReportId && params\.roomOwnerId !== null\) await deleteReportDocumentLayout\(txClient, replacedReportId, params\.roomOwnerId\);/);
  const client = await readFile(new URL("../lib/report-document-layout-client.ts", import.meta.url), "utf8");
  assert.doesNotMatch(client, /append\("file"|form\.append\("original/, "the original file is never uploaded");
});
