import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fork } from "node:child_process";
import { createClient } from "@libsql/client";
import JSZip from "jszip";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { evaluateCorpusAdmissionCandidate, _runThroughAcceptSerializationQueueForTesting } from "../lib/corpus-admission-gate.ts";

/**
 * CROSS-PROCESS verification of the concurrency/idempotency fix.
 *
 * tests/corpus-admission-concurrency.test.mjs proves correctness under
 * same-process concurrency (many Promise.all-driven calls sharing one
 * Client and, since the fix, one in-process acceptSerializationQueue). That
 * queue is a same-process scheduling optimization only — see its own
 * comment in lib/corpus-admission-gate.ts — and correctness under real
 * concurrency was always meant to rest on the database transaction itself,
 * not on that queue. This file is the test that actually removes the queue
 * from the picture: every candidate here is evaluated inside its own
 * independent `node --import tsx` OS process (tests/helpers/corpus-
 * admission-cross-process-worker.mjs, launched via node:child_process.fork),
 * each with its own fresh module registry (so its own, entirely separate
 * acceptSerializationQueue instance — nothing in-process is shared with any
 * sibling or with this parent process) and its own @libsql/client
 * connection. The only thing genuinely shared across every worker is the
 * on-disk SQLite database file itself.
 *
 * TRANSACTION / ISOLATION MECHANISM THAT MAKES THIS SAFE ACROSS PROCESSES:
 * lib/corpus-admission-gate.ts's acceptWithAtomicDedup(Critical Section)
 * opens its transaction via client.transaction("write"), which
 * @libsql/client's local-file (sqlite3) driver maps directly to SQLite's
 * `BEGIN IMMEDIATE` (see node_modules/@libsql/client's use of
 * transactionModeToBegin("write") -> "BEGIN IMMEDIATE", and
 * @libsql/core/util.js's transactionModeToBegin). BEGIN IMMEDIATE acquires
 * SQLite's RESERVED lock on the database file up front, before any write
 * statement runs — and that lock is enforced by SQLite's own file-level
 * locking (POSIX advisory locks / Windows LockFileEx under the hood, not
 * any in-memory or in-process structure), so it is inherently effective
 * across completely separate OS processes, not just separate connections in
 * one process. Only one process's write transaction can hold that RESERVED
 * lock at a time; every other concurrent client.transaction("write") call —
 * in this process, or a totally different one — blocks/retries until it
 * commits or rolls back. The in-transaction re-check (exact-hash lookup via
 * findAcceptedRepresentationByHash, near-duplicate lookup via
 * findAcceptedFamilyCandidates + resolveCorpusArticleFamily) runs while
 * holding that lock, so no other process can interleave a competing accept
 * between the re-check read and this transaction's own insert — and the
 * UNIQUE index on corpus_admission_accepted_representations.canonical_sha256
 * remains the authoritative backstop for the exact-hash case specifically,
 * catching anything that a re-check race could theoretically still slip
 * past (e.g. two transactions both starting their re-check before either
 * held the RESERVED lock).
 *
 * Every fixture here is synthetic; no part of the real 770-article set or
 * the 180-sample blinded evaluation set is used or referenced.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_admission_cross_process.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
const dbUrl = `file:${dbFile}`;
const setupClient = createClient({ url: dbUrl });
await setupClient.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(setupClient, drizzleDir);

function openConnection() {
  return createClient({ url: dbUrl });
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-admission-cross-process-"));

test.after(() => {
  setupClient.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const WORD_BANK = [
  "research", "analysis", "population", "sample", "variable", "hypothesis", "method", "outcome", "region",
  "temperature", "pressure", "reaction", "material", "structure", "process", "signal", "pattern", "network",
  "sediment", "species", "habitat", "climate", "growth", "measurement", "instrument", "observation", "protocol",
  "significant", "distinct", "gradual", "consistent", "notable", "substantial", "minor", "extensive", "localized",
  "documented", "identified", "recorded", "analyzed", "examined", "compared", "measured", "observed", "reported",
];

function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0xffffffff;
  };
}

function plausibleArticleText(seed, targetWords = 3300) {
  const rng = seededRandom(seed);
  const paragraphs = [];
  let wordCount = 0;
  while (wordCount < targetWords) {
    const sentence = `The ${Array.from({ length: 10 + Math.floor(rng() * 18) }, () => WORD_BANK[Math.floor(rng() * WORD_BANK.length)]).join(" ")}.`;
    const paragraph = Array.from({ length: 5 + Math.floor(rng() * 4) }, () => sentence).join(" ");
    paragraphs.push(paragraph);
    wordCount += paragraph.split(/\s+/).length;
  }
  return paragraphs.join("\n\n");
}

const RESOLVED_PROVENANCE = (sourceUrl) => ({
  kind: "BULK_IMPORT_PROVENANCE",
  provenance: { sourceUrl, acquisitionMethod: "BULK_IMPORT_DOWNLOAD", licenseOrPermission: "CC-BY-4.0", retentionBasis: "LICENSED_REUSE", retentionRightsResolved: true, notes: null },
});

function xmlEscape(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function buildDocxContaining(text) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  const paragraphs = text.split("\n\n").map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`).join("");
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

let tmpFileCounter = 0;
function writeTempBytes(label, bytes) {
  tmpFileCounter += 1;
  const p = path.join(tmpDir, `${tmpFileCounter}-${label}`);
  fs.writeFileSync(p, bytes);
  return p;
}

async function contentStoreCount(canonicalSha256) {
  const result = await setupClient.execute({ sql: "SELECT COUNT(*) AS c FROM corpus_admission_content_store WHERE canonical_sha256 = ?", args: [canonicalSha256] });
  return Number(result.rows[0].c);
}

// --- cross-process orchestration --------------------------------------------

const WORKER_SCRIPT = path.join(repoRoot, "tests/helpers/corpus-admission-cross-process-worker.mjs");

function spawnWorker() {
  return fork(WORKER_SCRIPT, [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "inherit", "inherit", "ipc"] });
}

function waitForMessage(child, predicate) {
  return new Promise((resolve, reject) => {
    function onMessage(msg) {
      if (!predicate(msg)) return;
      cleanup();
      resolve(msg);
    }
    function onError(err) {
      cleanup();
      reject(err);
    }
    function onExit(code, signal) {
      cleanup();
      reject(new Error(`cross-process worker exited (code=${code}, signal=${signal}) before sending the expected message`));
    }
    function cleanup() {
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    }
    child.on("message", onMessage);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

/**
 * Runs one candidate per independent OS process, synchronized by a real
 * barrier: every worker is sent its config and must open its own db client
 * and reply "ready" before ANY worker is told to proceed; only once every
 * worker is ready does the parent broadcast a single shared future
 * timestamp, which each worker sleeps until before calling
 * evaluateCorpusAdmissionCandidate. This absorbs per-process spawn/import/
 * connect jitter so the race actually starts together.
 */
async function runCrossProcessBarrier(configs, { barrierDelayMs = 400 } = {}) {
  const children = configs.map(() => spawnWorker());
  try {
    const readyPromises = children.map((child, i) => {
      const readyPromise = waitForMessage(child, (m) => m.type === "ready");
      child.send({ type: "start", config: configs[i] });
      return readyPromise;
    });
    await Promise.all(readyPromises);

    const startAtEpochMs = Date.now() + barrierDelayMs;
    const resultPromises = children.map((child) => waitForMessage(child, (m) => m.type === "result" || m.type === "error"));
    for (const child of children) child.send({ type: "go", startAtEpochMs });

    const messages = await Promise.all(resultPromises);
    return messages.map((m, i) => {
      if (m.type === "error") {
        throw new Error(`cross-process worker ${i} (sourceRef=${configs[i].sourceRef}) failed: ${m.message}\n${m.stack ?? ""}`);
      }
      return m.decision;
    });
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }
}

// --- CROSS-PROCESS: identical content ---------------------------------------

test("CROSS-PROCESS: independent OS processes submitting identical content resolve to exactly one ACCEPT and one content-store row", async () => {
  const N = 5;
  const text = plausibleArticleText(50001);
  const bytesPath = writeTempBytes("identical.txt", Buffer.from(text, "utf8"));

  const configs = Array.from({ length: N }, (_, i) => ({
    dbUrl,
    sourceRef: `cross-process-identical-${i}`,
    filename: `identical-${i}.txt`,
    bytesFilePath: bytesPath,
    consent: RESOLVED_PROVENANCE(`https://example.test/cross-process-identical-${i}`),
    dryRun: false,
  }));

  const decisions = await runCrossProcessBarrier(configs);
  const acceptCount = decisions.filter((d) => d.decision === "ACCEPT").length;
  const rejectCount = decisions.filter((d) => d.decision === "REJECT").length;
  console.log(`[CROSS-PROCESS] identical content: ${acceptCount} ACCEPT, ${rejectCount} REJECT of ${N}`);

  assert.equal(acceptCount, 1, `exactly one of ${N} independent OS processes may reach ACCEPT for identical content, got ${acceptCount}`);
  assert.equal(rejectCount, N - 1);
  for (const d of decisions.filter((d) => d.decision === "REJECT")) {
    assert.ok(d.reasonCodes.includes("DUPLICATE_ALREADY_REPRESENTED"));
    assert.equal(d.contentStoreId, null, "a rejected cross-process duplicate must store no content");
  }

  const canonicalHash = decisions.find((d) => d.canonicalSha256)?.canonicalSha256;
  assert.equal(await contentStoreCount(canonicalHash), 1);
});

// --- CROSS-PROCESS: near-duplicates, distinct SHA-256 -----------------------

test("CROSS-PROCESS: independent OS processes submitting mutually near-duplicate (distinct SHA-256) minor-edit variants resolve to exactly one family winner", async () => {
  const N = 5;
  const base = plausibleArticleText(50002);

  const configs = Array.from({ length: N }, (_, i) => {
    const variantText = `${base}\n\nA brief supplementary paragraph appended by way of minor revision number ${i} only, changing very little of the substantive content overall.`;
    const bytesPath = writeTempBytes(`minor-edit-${i}.txt`, Buffer.from(variantText, "utf8"));
    return {
      dbUrl,
      sourceRef: `cross-process-minor-edit-${i}`,
      filename: `minor-edit-${i}.txt`,
      bytesFilePath: bytesPath,
      consent: RESOLVED_PROVENANCE(`https://example.test/cross-process-minor-edit-${i}`),
      dryRun: false,
    };
  });

  const decisions = await runCrossProcessBarrier(configs);
  const hashes = new Set(decisions.map((d) => d.canonicalSha256).filter(Boolean));
  assert.equal(hashes.size, N, "sanity: every minor-edit variant must have a genuinely distinct canonical_sha256");

  const acceptCount = decisions.filter((d) => d.decision === "ACCEPT").length;
  console.log(`[CROSS-PROCESS] near-duplicates (distinct hashes): ${acceptCount} ACCEPT of ${N}, families: ${decisions.map((d) => d.familyRelation).join(",")}`);
  assert.equal(acceptCount, 1, `mutually near-duplicate variants submitted from independent OS processes must resolve to exactly one family winner, got ${acceptCount}`);

  const accepted = decisions.find((d) => d.decision === "ACCEPT");
  for (const d of decisions.filter((d) => d.decision === "REJECT")) {
    assert.ok(["EXACT_DUPLICATE", "EDITED_VERSION"].includes(d.familyRelation), `expected a family match, got ${d.familyRelation}`);
    assert.equal(d.contentStoreId, null);
  }
  assert.equal(await contentStoreCount(accepted.canonicalSha256), 1);
});

// --- CROSS-PROCESS: PDF vs DOCX, same underlying text -----------------------

test("CROSS-PROCESS: independent OS processes submitting PDF and DOCX versions of the SAME underlying text resolve to exactly one family winner", async () => {
  const { extractCorpusCandidateText } = await import("../lib/corpus-text-extraction.ts");
  const pdfBytes = fs.readFileSync(path.join(repoRoot, "tests/fixtures/attention-is-all-you-need.pdf"));
  const pdfExtraction = await extractCorpusCandidateText("pdf", pdfBytes);
  assert.equal(pdfExtraction.ok, true, "sanity: the real PDF fixture must extract successfully");
  const docxBytes = await buildDocxContaining(pdfExtraction.rawText);

  const pdfPath = writeTempBytes("cross-process.pdf", pdfBytes);
  const docxPath = writeTempBytes("cross-process.docx", docxBytes);

  const configs = [
    { dbUrl, sourceRef: "cross-process-pdf-0", filename: "attention-0.pdf", bytesFilePath: pdfPath, consent: RESOLVED_PROVENANCE("https://example.test/cross-process-pdf-0"), dryRun: false },
    { dbUrl, sourceRef: "cross-process-pdf-1", filename: "attention-1.pdf", bytesFilePath: pdfPath, consent: RESOLVED_PROVENANCE("https://example.test/cross-process-pdf-1"), dryRun: false },
    { dbUrl, sourceRef: "cross-process-docx-0", filename: "attention-0.docx", bytesFilePath: docxPath, consent: RESOLVED_PROVENANCE("https://example.test/cross-process-docx-0"), dryRun: false },
    { dbUrl, sourceRef: "cross-process-docx-1", filename: "attention-1.docx", bytesFilePath: docxPath, consent: RESOLVED_PROVENANCE("https://example.test/cross-process-docx-1"), dryRun: false },
  ];

  const decisions = await runCrossProcessBarrier(configs);
  const acceptCount = decisions.filter((d) => d.decision === "ACCEPT").length;
  console.log(`[CROSS-PROCESS] PDF/DOCX same-text: ${acceptCount} ACCEPT of ${configs.length}, families: ${decisions.map((d) => d.familyRelation).join(",")}`);
  assert.equal(acceptCount, 1, `format alone must never let the same underlying text be independently accepted twice across processes, got ${acceptCount}`);

  const accepted = decisions.find((d) => d.decision === "ACCEPT");
  for (const d of decisions.filter((d) => d.decision === "REJECT")) {
    assert.ok(["EXACT_DUPLICATE", "EDITED_VERSION"].includes(d.familyRelation));
    assert.equal(d.contentStoreId, null);
  }
  assert.equal(await contentStoreCount(accepted.canonicalSha256), 1);
});

// --- CROSS-PROCESS: genuinely unrelated documents ---------------------------

test("CROSS-PROCESS: independent OS processes submitting genuinely unrelated documents are each independently accepted", async () => {
  const N = 5;
  const configs = Array.from({ length: N }, (_, i) => {
    const text = plausibleArticleText(600000 + i * 173);
    const bytesPath = writeTempBytes(`distinct-${i}.txt`, Buffer.from(text, "utf8"));
    return {
      dbUrl,
      sourceRef: `cross-process-distinct-${i}`,
      filename: `distinct-${i}.txt`,
      bytesFilePath: bytesPath,
      consent: RESOLVED_PROVENANCE(`https://example.test/cross-process-distinct-${i}`),
      dryRun: false,
    };
  });

  const decisions = await runCrossProcessBarrier(configs);
  const acceptCount = decisions.filter((d) => d.decision === "ACCEPT").length;
  console.log(`[CROSS-PROCESS] unrelated documents: ${acceptCount} ACCEPT of ${N}`);
  assert.equal(acceptCount, N, `genuinely unrelated documents submitted from independent OS processes must all be accepted independently, got ${acceptCount} of ${N}`);

  const hashes = decisions.map((d) => d.canonicalSha256);
  assert.equal(new Set(hashes).size, N, "every independently-accepted document must have a distinct canonical hash");
  for (const hash of hashes) {
    assert.equal(await contentStoreCount(hash), 1);
  }
});

// --- failed transaction does not poison the (inherently process-local) queue ---

test("a failed accept-transaction critical section does not poison the same-process serialization queue — the next admission still completes normally", async () => {
  await assert.rejects(
    () => _runThroughAcceptSerializationQueueForTesting(async () => { throw new Error("simulated transaction failure"); }),
    /simulated transaction failure/,
  );
  const stillAlive = await _runThroughAcceptSerializationQueueForTesting(async () => "queue still alive");
  assert.equal(stillAlive, "queue still alive", "the queue's continuation must always resolve regardless of a prior failure, never getting stuck behind a rejected link");
});

test("end-to-end: one admission failing outright (closed client) does not prevent the very next admission on the same process from completing normally", async () => {
  const doomedClient = createClient({ url: dbUrl });
  doomedClient.close();

  const failingText = plausibleArticleText(50099);
  await assert.rejects(() =>
    evaluateCorpusAdmissionCandidate(doomedClient, {
      sourceRef: "doomed-closed-client",
      filename: "doomed.txt",
      bytes: Buffer.from(failingText, "utf8"),
      consent: RESOLVED_PROVENANCE("https://example.test/doomed-closed-client"),
      dryRun: false,
      // A genuinely valid factory — the point of this test is that the
      // failure comes from the closed `client` (used for the pre-check
      // reads), not from a missing openConnection.
      openConnection,
    }),
  );

  const healthyText = plausibleArticleText(50098);
  const healthy = await evaluateCorpusAdmissionCandidate(setupClient, {
    sourceRef: "healthy-after-doomed",
    filename: "healthy.txt",
    bytes: Buffer.from(healthyText, "utf8"),
    consent: RESOLVED_PROVENANCE("https://example.test/healthy-after-doomed"),
    dryRun: false,
    openConnection,
  });
  assert.equal(healthy.decision, "ACCEPT", `a normal admission right after an unrelated failed one must still succeed, got ${healthy.decision}: ${healthy.reasonCodes.join(",")}`);
});
