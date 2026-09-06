import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { loadArchiveSourceEntries, seedArchiveCorpus } from "../lib/archive-corpus-seed.ts";
import { rebuildArchiveScalableIndex } from "../lib/archive-index-build.ts";
import { analyzeArchiveOnServer } from "../lib/archive-server-analysis.ts";
import { __resetArchiveMatchConfigCacheForTests } from "../lib/archive-static-config.ts";

/**
 * Slice 2E, Phase 7 — the server analysis service (lib/archive-server-analysis.ts)
 * run directly against the real local 321-document archive fixture with
 *   ARCHIVE_COSOURCE_EXPANSION_ENABLED=true
 *   ARCHIVE_SERVER_SIDE_ENABLED=true
 * (process-local), proving the committed matcher's locked co-source numbers
 * survive the 2E wiring untouched. Requires corpus/ (gitignored); SKIPS
 * entirely when absent, exactly like tests/archive-corpus-real.local.test.mjs.
 */

const CORPUS_ROOT = path.join(process.cwd(), "corpus");
const META_PATH = path.join(process.cwd(), "public", "data", "document-index.meta.json");
const RISK_PATH = path.join(process.cwd(), "public", "data", "risk-calibration.json");
const HAVE_CORPUS = fs.existsSync(path.join(CORPUS_ROOT, "manifest.json")) && fs.existsSync(META_PATH) && fs.existsSync(RISK_PATH);

if (!HAVE_CORPUS) {
  test("slice 2E server analysis — real 321-corpus parity (SKIPPED — corpus/ not present)", { skip: true }, () => {});
}

if (HAVE_CORPUS) {
  process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED = "true";
  process.env.ARCHIVE_SERVER_SIDE_ENABLED = "true";
  __resetArchiveMatchConfigCacheForTests();

  const meta = JSON.parse(fs.readFileSync(META_PATH, "utf8"));
  const risk = JSON.parse(fs.readFileSync(RISK_PATH, "utf8"));
  const CUTOFF = risk.archiveCutoff;

  const entries = loadArchiveSourceEntries(CORPUS_ROOT, META_PATH);
  const byOrder = new Map(entries.map((e) => [e.archiveOrder, e]));
  const orders = [...byOrder.keys()].sort((a, b) => a - b);

  const dbFile = path.join(process.cwd(), "test_archive_server_analysis_local.db");
  for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch {} }
  const client = createClient({ url: `file:${dbFile}` });
  await client.execute("PRAGMA foreign_keys = ON");
  await applyMigrationsLibsql(client, path.join(process.cwd(), "drizzle"));
  await seedArchiveCorpus(client, entries, {
    corpusVersion: meta.corpusVersion,
    firstSeenAt: String(risk.generatedAt).replace("T", " ").slice(0, 19),
  });
  const rebuild = await rebuildArchiveScalableIndex(client);

  test.after(() => {
    client.close();
    delete process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED;
    delete process.env.ARCHIVE_SERVER_SIDE_ENABLED;
    for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch {} }
  });

  // ── deterministic probe reconstruction (test scaffolding, identical to the
  //    committed acceptance harness generator; NOT the adjacency algorithm) ──
  const FA = "An unrelated framing sentence about a wholly different subject precedes this excerpt in the submitted document.";
  const FB = "A separate and unrelated closing remark about another matter follows this excerpt in the same document today.";
  const HOST = Array.from({ length: 4200 }, (_, i) => `hq${(i * 2654435761 % 46656).toString(36)}z`).join(" ");
  const wordsOf = (t) => t.split(/\s+/).filter(Boolean);
  const excerpt = (t, s, l) => wordsOf(t).slice(s, s + l).join(" ");
  function midOffset(t, len) {
    let h = 0;
    for (let i = 0; i < Math.min(t.length, 400); i++) h = (h * 31 + t.charCodeAt(i)) | 0;
    return Math.max(0, Math.min(wordsOf(t).length - len - 20, 150 + (Math.abs(h) % 400)));
  }
  const verbatim = (len, o) => {
    const t = byOrder.get(o).text;
    const off = midOffset(t, len);
    if (wordsOf(t).length < off + len + 5) return null;
    return `${FA} ${excerpt(t, off, len)} ${FB}`;
  };
  const spanProbe = (len, o) => {
    const t = byOrder.get(o).text;
    const off = 300 + (o % 200);
    const span = excerpt(t, off, len);
    if (wordsOf(span).length < len) return null;
    const hw = wordsOf(HOST);
    return `${hw.slice(0, 2000).join(" ")} ${span} ${hw.slice(2000, 4000).join(" ")}`;
  };

  const score = async (text) => (await analyzeArchiveOnServer(client, text)).result.score;

  test("Phase 7: seed + rebuild sanity", () => {
    assert.equal(entries.length, 321);
    assert.equal(orders.length, 321);
    assert.equal(orders.every((o, i) => o === i), true);
    assert.equal(rebuild.cosources.edgeRows, 6871, "co-source adjacency reproduces the locked M2/K24 lock");
  });

  test("Phase 7: near-duplicate watch cases — locked co-source recovery scores", async () => {
    assert.equal(await score(verbatim(120, 44)), 8, "v120-o44");
    assert.equal(await score(verbatim(120, 45)), 8, "v120-o45");
    assert.equal(await score(verbatim(250, 44)), 19, "L250-o44");
    assert.equal(await score(verbatim(250, 45)), 15, "L250-o45");
    // all four recovered above the archive cutoff
    for (const [len, o] of [[120, 44], [120, 45], [250, 44], [250, 45]]) {
      assert.ok((await score(verbatim(len, o))) >= CUTOFF, `near-dup ${len}-o${o} recovered`);
    }
  });

  test("Phase 7: exact-reupload watch probes — locked (== committed B, all < 7)", async () => {
    const expected = { 2: 3, 53: 1, 54: 5, 74: 4, 134: 6, 167: 2, 176: 5, 219: 6 };
    for (const [o, want] of Object.entries(expected)) {
      const got = await score(byOrder.get(Number(o)).text);
      assert.equal(got, want, `x-o${o}`);
      assert.ok(got < CUTOFF, `x-o${o} stays below the cutoff`);
    }
  });

  test("Phase 7: L500-o311 / L500-o314 — locked at 8", async () => {
    assert.equal(await score(verbatim(500, 311)), 8, "L500-o311");
    assert.equal(await score(verbatim(500, 314)), 8, "L500-o314");
  });

  test("Phase 7: ordinary partial copy, exact self-excluded re-upload, isolated short phrase, multi-source, no-match", async () => {
    // ordinary partial copy — a 40-word verbatim excerpt matches its source
    assert.ok((await score(verbatim(40, 0))) > 0, "v40-o0 partial copy scores > 0");
    // exact/self-excluded re-upload — the whole document; its own source self-excludes
    const exact = await analyzeArchiveOnServer(client, byOrder.get(0).text);
    assert.ok(exact.result.excludedDocuments >= 1, "a full re-upload self-excludes at least its own source");
    // isolated short 5-word phrase in a large host — the min-match floor path still runs cleanly
    assert.equal(typeof (await score(spanProbe(5, 0))), "number");
    // multi-source — two unrelated excerpts joined
    const multi = `${FA} ${excerpt(byOrder.get(10).text, 200, 70)} A short connecting sentence joins two unrelated excerpts here. ${excerpt(byOrder.get(60).text, 200, 70)} ${FB}`;
    assert.ok((await score(multi)) > 0, "multi-source excerpt scores > 0");
    // no-match control
    assert.equal(await score(Array.from({ length: 60 }, (_, i) => `nomz0x${(i * 48271 % 1000000).toString(36)}q`).join(" ")), 0, "no-match control is 0");
  });

  test("Phase 7: archive_order determinism — identical text yields the identical framed result", async () => {
    const t = verbatim(120, 44);
    const a = await analyzeArchiveOnServer(client, t);
    const b = await analyzeArchiveOnServer(client, t);
    assert.deepEqual(a.result, b.result);
  });

  test("Phase 7: diagnostics stay server-side on the service return, never in result", async () => {
    const out = await analyzeArchiveOnServer(client, verbatim(120, 44));
    assert.ok(out.diagnostics, "the service exposes discovery diagnostics to its server caller");
    assert.ok(out.diagnostics.cosource, "co-source (G1s) diagnostics present when the flag is on");
    assert.equal(out.diagnostics.cosource.applied, true, "G1s applied for the near-dup case");
    assert.equal("archiveDiscovery" in out.result, false);
    assert.equal("cosource" in out.result, false);
  });
}
