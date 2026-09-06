import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { tokens } from "../lib/similarity-core.ts";
import { archiveShingleHashes } from "../lib/archive-fingerprint.ts";
import { loadArchiveSourceEntries, seedArchiveCorpus } from "../lib/archive-corpus-seed.ts";
import { matchAgainstArchiveCorpus } from "../lib/archive-corpus-matching.ts";

/**
 * slice 2D.4 — the FULL acceptance suite: the identical 2,462 deterministic
 * probes from Slices 2D/2D.1/2D.3, run against the ACTUAL in-repo
 * matchAgainstArchiveCorpus with ARCHIVE_COSOURCE_EXPANSION_ENABLED on, must
 * agree with the locked Slice 2D.3 M2/K24 prototype. Requires corpus/ +
 * public/data — SKIPS when absent (CI stays green; a local run gates it).
 * Slow (~6 min): seeds the real 321-doc archive, then 2,462 full matcher runs.
 */

const CORPUS_ROOT = path.join(process.cwd(), "corpus");
const META_PATH = path.join(process.cwd(), "public", "data", "document-index.meta.json");
const RISK_PATH = path.join(process.cwd(), "public", "data", "risk-calibration.json");
const BASELINE_ROWS_PATH = path.join(process.cwd(), "tests", "fixtures", "slice-2d-baseline-rows.json");
const HAVE = fs.existsSync(path.join(CORPUS_ROOT, "manifest.json")) && fs.existsSync(META_PATH) && fs.existsSync(RISK_PATH) && fs.existsSync(BASELINE_ROWS_PATH);

if (!HAVE) {
  test("slice 2D.4 full acceptance suite (SKIPPED — corpus/ or the Slice-2D baseline fixture is not present)", { skip: true }, () => {});
}

if (HAVE) {
  const META = JSON.parse(fs.readFileSync(META_PATH, "utf8"));
  const RISK = JSON.parse(fs.readFileSync(RISK_PATH, "utf8"));
  const MP = RISK.matchingParameters;
  const MDF = META.maximumDocumentFrequency;
  const CUTOFF = RISK.archiveCutoff;
  // Baseline A (exhaustive) + committed B(16) for the exact 2,462-probe set —
  // produced once by the Slice-2D characterization harness, checked in as a
  // fixture (id -> {aScore, bScore}). This suite compares the FLAG-ON in-repo
  // matcher against those, never recomputes them.
  const baseById = new Map(JSON.parse(fs.readFileSync(BASELINE_ROWS_PATH, "utf8")).map((r) => [r.id, r]));

  const dbFile = path.join(process.cwd(), "test_archive_cosource_acceptance.db");
  for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch {} }
  const client = createClient({ url: `file:${dbFile}` });
  await client.execute("PRAGMA foreign_keys = ON");
  await applyMigrationsLibsql(client, path.join(process.cwd(), "drizzle"));
  test.after(() => { client.close(); for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch {} } });

  const entries = loadArchiveSourceEntries(CORPUS_ROOT, META_PATH);
  await seedArchiveCorpus(client, entries, { corpusVersion: META.corpusVersion ?? "archive-real", firstSeenAt: String(RISK.generatedAt).replace("T", " ").slice(0, 19) });

  // ── rebuild the byte-identical 2,462-probe eval set ──────────────────────
  const mulberry32 = (seed) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const rnd = mulberry32(20260906);
  const HOST = Array.from({ length: 4200 }, (_, i) => `hq${(i * 2654435761 % 46656).toString(36)}z`).join(" ");
  const FA = "An unrelated framing sentence about a wholly different subject precedes this excerpt in the submitted document.";
  const FB = "A separate and unrelated closing remark about another matter follows this excerpt in the same document today.";
  const wordsOf = (t) => t.split(/\s+/).filter(Boolean);
  const excerpt = (t, s, l) => wordsOf(t).slice(s, s + l).join(" ");
  const midOffset = (t, len) => { let h = 0; for (let i = 0; i < Math.min(t.length, 400); i++) h = (h * 31 + t.charCodeAt(i)) | 0; return Math.max(0, Math.min(wordsOf(t).length - len - 20, 150 + (Math.abs(h) % 400))); };
  const byOrder = new Map(entries.map((e) => [e.archiveOrder, e]));
  const dbDocs = (await client.execute("SELECT a.archive_order o, c.canonical_text t FROM archive_document_representations a JOIN corpus_document_representations c ON c.id=a.representation_id ORDER BY a.archive_order")).rows.map((r) => ({ o: Number(r.o), t: String(r.t) }));
  const orders = dbDocs.map((d) => d.o);
  const overlapByOrder = new Map();
  {
    const hs = new Map(dbDocs.map((d) => [d.o, archiveShingleHashes(d.t)]));
    const ho = new Map();
    for (const [o, set] of hs) for (const h of set) { let s = ho.get(h); if (!s) ho.set(h, (s = new Set())); s.add(o); }
    for (const [o, set] of hs) { const co = new Map(); for (const h of set) { const ow = ho.get(h); if (ow && ow.size >= 2 && ow.size <= 40) for (const oo of ow) if (oo !== o) co.set(oo, (co.get(oo) || 0) + 1); } let dn = 0; for (const v of co.values()) if (v >= 8) dn++; overlapByOrder.set(o, dn); }
  }
  const denseOrders = [...overlapByOrder.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([o]) => o);
  const probes = [];
  const addp = (category, id, text) => probes.push({ category, id, text });
  for (const o of orders) { const t = byOrder.get(o).text; for (const len of [40, 80, 120]) { const off = midOffset(t, len); if (wordsOf(t).length < off + len + 5) continue; addp(`verbatim-${len}`, `v${len}-o${o}`, `${FA} ${excerpt(t, off, len)} ${FB}`); } }
  for (const o of orders) { const t = byOrder.get(o).text; for (const len of [250, 500]) { const off = midOffset(t, len); if (wordsOf(t).length < off + len + 5) continue; addp(`long-${len}`, `L${len}-o${o}`, `${FA} ${excerpt(t, off, len)} ${FB}`); } }
  for (const o of denseOrders) { const t = byOrder.get(o).text; for (const len of [150, 300]) { const off = Math.max(0, Math.min(wordsOf(t).length - len - 20, 400)); addp(`dense-${len}`, `D${len}-o${o}`, `${FA} ${excerpt(t, off, len)} ${FB}`); } }
  const spanOrders = orders.filter((_, i) => i % 5 === 0).slice(0, 64);
  for (const o of spanOrders) { const t = byOrder.get(o).text; for (const len of [5, 10, 20, 37]) { const off = 300 + (o % 200); const span = excerpt(t, off, len); if (wordsOf(span).length < len) continue; const hw = wordsOf(HOST); addp(`span-${len}`, `s${len}-o${o}`, hw.slice(0, 2000).join(" ") + " " + span + " " + hw.slice(2000, 4000).join(" ")); } }
  for (let k = 0; k < 90; k++) { const a = orders[Math.floor(rnd() * orders.length)]; let b = orders[Math.floor(rnd() * orders.length)]; if (b === a) b = orders[(orders.indexOf(b) + 1) % orders.length]; addp("mix-2", `m2-${k}`, `${FA} ${excerpt(byOrder.get(a).text, 200, 70)} A short connecting sentence joins two unrelated excerpts here. ${excerpt(byOrder.get(b).text, 200, 70)} ${FB}`); }
  for (let k = 0; k < 30; k++) { const os = [0, 0, 0].map(() => orders[Math.floor(rnd() * orders.length)]); const p = os.map((o) => excerpt(byOrder.get(o).text, 250, 55)); addp("mix-3", `m3-${k}`, `${FA} ${p[0]} connecting one. ${p[1]} connecting two. ${p[2]} ${FB}`); }
  for (const o of orders) addp("exact-reupload", `x-o${o}`, byOrder.get(o).text);
  for (let k = 0; k < 80; k++) { const len = [60, 120, 240, 400][k % 4]; addp("no-match", `n-${k}`, Array.from({ length: len }, (_, i) => `nomz${k}x${(i * 48271 % 1000000).toString(36)}q`).join(" ")); }

  const NEAR_DUP = ["v120-o44", "v120-o45", "L250-o44", "L250-o45"];
  const OVERSHOOT8 = ["x-o2", "x-o53", "x-o54", "x-o74", "x-o134", "x-o167", "x-o176", "x-o219"];

  test("the eval set is the exact 2,462-probe Slice 2D set", () => {
    assert.equal(probes.length, 2462);
    for (const p of probes) assert.ok(baseById.has(p.id), `probe ${p.id} must be in the Slice-2D baseline fixture`);
  });

  // One test owns the whole flag-ON pass so node:test never closes the client
  // (test.after) while matcher queries are still in flight.
  test("flag ON acceptance — the in-repo matcher agrees with the locked Slice 2D.3 M2/K24 prototype over all 2,462 probes", async () => {
    const prevFlag = process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED;
    process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED = "true";
    const rows = [];
    try {
      for (const p of probes) {
        const b0 = baseById.get(p.id);
        const m = await matchAgainstArchiveCorpus(client, p.text, { maximumDocumentFrequency: MDF, matchingParameters: MP });
        rows.push({ id: p.id, category: p.category, aScore: b0.aScore, bScore: b0.bScore, fixScore: m.score });
      }
    } finally {
      if (prevFlag === undefined) delete process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED; else process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED = prevFlag;
    }
    const R = new Map(rows.map((r) => [r.id, r]));

    const materialFN_vsA = rows.filter((r) => r.aScore >= CUTOFF && r.fixScore < CUTOFF);
    const newMaterialFN_vsB = materialFN_vsA.filter((r) => r.bScore >= CUTOFF);
    const genuineNewOvershoot = rows.filter((r) => r.aScore < CUTOFF && r.fixScore >= CUTOFF && r.bScore < CUTOFF);
    const downwardReg_vsB = rows.filter((r) => r.bScore >= CUTOFF && r.fixScore < CUTOFF && r.aScore >= CUTOFF);
    const noMatchPos = rows.filter((r) => r.category === "no-match" && r.fixScore > 0);
    const erNewReg = rows.filter((r) => r.category === "exact-reupload" && r.aScore < CUTOFF && r.fixScore >= CUTOFF && r.bScore < CUTOFF);

    assert.equal(genuineNewOvershoot.length, 0, `genuine new cutoff overshoots vs A must be 0 — got ${JSON.stringify(genuineNewOvershoot.map((r) => `${r.id}(A${r.aScore},B${r.bScore}->${r.fixScore})`))}`);
    assert.equal(newMaterialFN_vsB.length, 0, `new material FN vs committed B must be 0 — got ${JSON.stringify(newMaterialFN_vsB.map((r) => r.id))}`);
    assert.equal(downwardReg_vsB.length, 0, `downward cutoff regressions vs B must be 0 — got ${JSON.stringify(downwardReg_vsB.map((r) => r.id))}`);
    assert.equal(noMatchPos.length, 0, "no-match positives must be 0");
    assert.equal(erNewReg.length, 0, "exact-reupload new material regressions must be 0");
    assert.ok(materialFN_vsA.length <= 32, `material FN vs exhaustive A must be <= 32 (2D.3 M2/K24) — got ${materialFN_vsA.length}`);
    assert.equal(NEAR_DUP.filter((id) => R.get(id).fixScore >= CUTOFF).length, 4, "all 4 near-duplicate catastrophes recovered above the cutoff");

    // watch probes
    for (const id of OVERSHOOT8) {
      const r = R.get(id);
      if (r.aScore < CUTOFF) assert.ok(r.fixScore < CUTOFF, `${id}: A=${r.aScore} < 7, so FIX (${r.fixScore}) must also stay < 7`);
    }
    for (const id of ["L500-o311", "L500-o314"]) {
      const r = R.get(id);
      assert.ok(r.fixScore >= r.bScore, `${id}: FIX (${r.fixScore}) must not regress below committed B (${r.bScore})`);
    }
    for (const id of NEAR_DUP) assert.ok(R.get(id).fixScore >= CUTOFF, `${id}: FIX (${R.get(id).fixScore}) must be >= 7`);
  });
}
