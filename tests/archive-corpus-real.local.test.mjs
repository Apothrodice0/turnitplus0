import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { tokens } from "../lib/similarity-core.ts";
import { ARCHIVE_COMPACT_FINGERPRINT_VERSION } from "../lib/archive-fingerprint.ts";
import { loadArchiveSourceEntries, seedArchiveCorpus, seedArchiveDocument, ARCHIVE_FINGERPRINT_VERSION } from "../lib/archive-corpus-seed.ts";
import { rebuildArchiveDfBands } from "../lib/archive-index-build.ts";
import { optimizePhraseIndex } from "../lib/archive-phrase-index.ts";
import { matchAgainstArchiveCorpus, ARCHIVE_MATCH_POLICY } from "../lib/archive-corpus-matching.ts";
import { PHRASE_FALLBACK_BUDGET, PHRASE_FALLBACK_FANOUT_GATE } from "../lib/archive-phrase-fallback.ts";
import { baselineB, normalizeArchiveResult } from "./helpers/archive-baseline-b.mjs";

/**
 * 100k-scale architecture, slice 2B — the REAL 321-document Baseline-B parity
 * suite (Slice 2A.4 / 2A.5 acceptance: 11/11 parity, 7/7 secondary-miss
 * recovery, 14/14 short-span stress). Requires corpus/ (gitignored, restored
 * locally from the archive build tree) — SKIPS entirely when it is absent, so
 * CI stays green while a local run still gates every real-corpus regression.
 */

const CORPUS_ROOT = path.join(process.cwd(), "corpus");
const META_PATH = path.join(process.cwd(), "public", "data", "document-index.meta.json");
const RISK_PATH = path.join(process.cwd(), "public", "data", "risk-calibration.json");
const HAVE_CORPUS = fs.existsSync(path.join(CORPUS_ROOT, "manifest.json")) && fs.existsSync(META_PATH) && fs.existsSync(RISK_PATH);

if (!HAVE_CORPUS) {
  test("real 321-document archive parity suite (SKIPPED — corpus/ not present)", { skip: true }, () => {});
}

// Module-level seeding so every test() below shares one migrated, seeded db —
// node:test does not guarantee a "setup" test's side-effects on module state
// are visible to sibling top-level tests.
let client = null;
let meta = null;
let risk = null;
let entryByArticleIndex = null;
let seedFpRows = 0;
let seedOldShingleRows = 0;

if (HAVE_CORPUS) {
  meta = JSON.parse(fs.readFileSync(META_PATH, "utf8"));
  risk = JSON.parse(fs.readFileSync(RISK_PATH, "utf8"));
  const entries = loadArchiveSourceEntries(CORPUS_ROOT, META_PATH);
  entryByArticleIndex = meta.articles.map((a) => entries.find((e) => e.archiveArticleId === a.id));

  const dbFile = path.join(process.cwd(), "test_archive_corpus_real_local.db");
  for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch {} }
  client = createClient({ url: `file:${dbFile}` });
  await client.execute("PRAGMA foreign_keys = ON");
  await applyMigrationsLibsql(client, path.join(process.cwd(), "drizzle"));
  test.after(() => {
    client?.close();
    for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch {} }
  });

  const firstSeenAt = String(risk.generatedAt).replace("T", " ").slice(0, 19);
  const seedResults = await seedArchiveCorpus(client, entries, { corpusVersion: meta.corpusVersion ?? "archive-real", firstSeenAt });
  assert.equal(seedResults.filter((r) => r.status === "SEEDED").length, entries.length, "every real archive document must seed");
  seedFpRows = Number((await client.execute({ sql: "SELECT COUNT(*) c FROM archive_document_fingerprints WHERE fingerprint_version = ?", args: [ARCHIVE_COMPACT_FINGERPRINT_VERSION] })).rows[0].c) / entries.length;
  seedOldShingleRows = Number((await client.execute({ sql: "SELECT COUNT(*) c FROM corpus_document_shingles WHERE fingerprint_version = ?", args: [ARCHIVE_FINGERPRINT_VERSION] })).rows[0].c);

  test("seed shape: ~120 compact fingerprint rows per document, ZERO old archive full-shingle rows", () => {
    assert.ok(seedFpRows > 50 && seedFpRows < 200, `~120 fingerprint rows/doc, got ${seedFpRows.toFixed(1)}`);
    assert.equal(seedOldShingleRows, 0, "the real seed path must write ZERO old archive full-shingle rows");
  });
}

const SKIP = !HAVE_CORPUS;

// ── the 6 fixed correctness probes (from the Slice 2A prototype's probes.mjs) ──
const wrap = (p) => `An unrelated introduction on a different subject precedes this excerpt entirely. ${p} A separate, unrelated closing remark follows this excerpt in a longer submitted document today.`;
const PASSAGE_EXACT =
  "A furniture manufacturing plant retooled its lacquer curing line after an internal quality " +
  "audit flagged inconsistent finish adhesion on export-grade cabinet doors, replacing the older " +
  "infrared curing tunnel with a forced-air convection unit calibrated to a narrower temperature " +
  "band across every production shift for the remainder of the fiscal year at that single facility.";
const PASSAGE_EXACT_FILLER =
  "Supplementary appendix tables list every raw measurement underlying the headline figures " +
  "reported above, alongside instrument calibration notes and the sampling protocol followed " +
  "at each monitoring station during the observation period described in this document, " +
  "including equipment serial numbers and the exact calendar dates each reading was logged.";
const PASSAGE_PARTIAL =
  "Cooperative credit unions in the Kabylie highlands adopted a tiered collateral model in " +
  "response to repeated harvest failures, allowing smallholder farmers to pledge future olive " +
  "press output rather than land titles, a shift that reduced default rates within two seasons. " +
  "Board minutes from three participating cooperatives were archived separately alongside a " +
  "glossary of regional lending terminology compiled for external auditors reviewing the pilot " +
  "program during its second full fiscal year of operation across every participating branch office.";
const PASSAGE_MIXED_A =
  "A newly commissioned desalination pilot near Oran began testing a reduced-brine discharge " +
  "protocol in partnership with three coastal municipalities, aiming to cut membrane " +
  "replacement costs while maintaining potable output within the original five-year budget. " +
  "Independent monitoring reports filed with the regional water authority described the " +
  "pilot's early operating parameters in detail across the first full year of continuous data.";
const PASSAGE_MIXED_B =
  "A localized aquaculture cooperative near Annaba restructured its shellfish export contracts " +
  "after a prolonged coastal algae bloom disrupted three consecutive harvest cycles, shifting " +
  "distribution toward inland processing partners under a renegotiated supply agreement. " +
  "Subsequent correspondence between the cooperative's board and its financing partners outlined " +
  "contingency terms for a second bloom event across the following two full operating seasons.";
const TIE_PASSAGE =
  "A coastal aquaculture monitoring initiative recorded shellfish density across nineteen " +
  "sampling stations over four consecutive quarters, correlating salinity fluctuation with " +
  "juvenile mortality and publishing station-level results for use by regional fisheries " +
  "cooperatives planning future harvest quotas and rotation schedules across the entire province, " +
  "with each station's raw sensor logs retained for at least five years after initial collection " +
  "for later reanalysis by independent auditors under the regional environmental oversight board.";
const BOILERPLATE_PASSAGE =
  "This paper presents a general discussion of the findings and results of the present study. " +
  "The following section outlines the broader research approach used throughout this work. " +
  "Additional analysis is presented in the discussion section above, consistent with prior research.";
const NOMATCH_QUERY_TEXT =
  "Zebrafish larvae raised under intermittent violet light exhibited a distinct circadian " +
  "shift in feeding latency that had never been documented in any prior published aquaculture " +
  "behavioral study of this particular species anywhere in the existing literature.";

const FIXED_MP = { maximumDocumentFrequency: 12, minimumMatchedWords: 5 };
const FIXED_PROBES = [
  { key: "exact", text: `${PASSAGE_EXACT} ${PASSAGE_EXACT_FILLER}` },
  { key: "partial", text: wrap(PASSAGE_PARTIAL) },
  { key: "mixed", text: `An unrelated introduction precedes both excerpts. ${PASSAGE_MIXED_A} A short connecting sentence links the two unrelated excerpts together here. ${PASSAGE_MIXED_B} A separate, unrelated closing remark follows both excerpts today.` },
  { key: "boilerplate", text: BOILERPLATE_PASSAGE },
  { key: "nomatch", text: NOMATCH_QUERY_TEXT },
  { key: "tie", text: wrap(TIE_PASSAGE) },
];

const EXCERPT_INDEXES = [0, 10, 50, 150, 300];
const SEVEN_MISS_TITLES = {
  0: ["Internal Mechanisms for the Settlement of Medical Disputes in", "The Outcome of Empowerment on the Development of Intellectual Capital A Case Study of the Algerian Electricity and Gas Company (Sonelgaz)"],
  50: ["Conditions Governing the Authority of the Criminal Judge to", "Environmental Governance Performance of Local Authorities"],
  150: ["A study of Economic market demand from the view of various behavioral social personal and economic transformation Empirical evidence from a developed country", "The impact of electronic management on the financial performance of Algerian municipality- Studying a sample of Bouira municipalities using simple linear regression"],
  300: ["Medical journal article (Med (41).pdf)"],
};

function excerptQuery(articleIndex) {
  const entry = entryByArticleIndex[articleIndex];
  const words = entry.text.split(/\s+/).filter(Boolean).slice(40, 120).join(" ");
  return `An unrelated framing sentence about a different subject precedes this excerpt entirely. ${words} A separate, unrelated closing remark about another matter follows this excerpt today.`;
}

let parityPass = 0;
let parityTotal = 0;

for (const probe of FIXED_PROBES) {
  test(`Baseline-B parity — fixed probe: ${probe.key}`, { skip: SKIP }, async () => {
    parityTotal += 1;
    const b = await baselineB(client, probe.text, { maximumDocumentFrequency: 12, matchingParameters: FIXED_MP });
    const m = await matchAgainstArchiveCorpus(client, probe.text, { maximumDocumentFrequency: 12, matchingParameters: FIXED_MP });
    assert.deepEqual(normalizeArchiveResult(m), normalizeArchiveResult(b), `fixed probe ${probe.key}: matcher must reproduce Baseline B`);
    assert.ok(m.archiveDiscovery.phraseProbeCount <= PHRASE_FALLBACK_BUDGET);
    assert.ok(m.archiveDiscovery.maxAdmittedPhraseFanOut <= PHRASE_FALLBACK_FANOUT_GATE);
    parityPass += 1;
  });
}

for (const i of EXCERPT_INDEXES) {
  test(`Baseline-B parity — real excerpt #${i} (words 40-120)`, { skip: SKIP }, async () => {
    parityTotal += 1;
    const text = excerptQuery(i);
    const mp = risk.matchingParameters;
    const mdf = meta.maximumDocumentFrequency;
    const b = await baselineB(client, text, { maximumDocumentFrequency: mdf, matchingParameters: mp });
    const m = await matchAgainstArchiveCorpus(client, text, { maximumDocumentFrequency: mdf, matchingParameters: mp });
    assert.deepEqual(normalizeArchiveResult(m), normalizeArchiveResult(b), `excerpt #${i}: matcher must reproduce Baseline B`);
    assert.ok(m.archiveDiscovery.phraseProbeCount <= PHRASE_FALLBACK_BUDGET);
    // 7-miss recovery: every previously-missed scoring-relevant co-source that B
    // surfaces must ALSO be a matcher source (guaranteed by the parity above,
    // asserted explicitly here for the acceptance record).
    for (const title of SEVEN_MISS_TITLES[i] ?? []) {
      const inB = b.sources.some((s) => s.name === title);
      if (inB) assert.ok(m.sources.some((s) => s.name === title), `excerpt #${i}: previously-missed co-source "${title}" must be recovered`);
    }
    parityPass += 1;
  });
}

test("short-span stress on the real archive: planted 5/6/10/20/37/50/89-word passages in a normal and a >10k-word host, matcher == Baseline B", { skip: SKIP }, async () => {
  const uniq = (ns, i) => `zx${ns}q${i.toString(36)}w`;
  const dd = (ns, n) => Array.from({ length: n }, (_, i) => uniq(ns, i)).join(" ");
  const fillerBank = tokens(entryByArticleIndex[7].text).slice(0, 4000);
  const filler = (n, off) => fillerBank.slice(off % 3000, (off % 3000) + n).join(" ") + " " + dd(9000 + off, Math.max(0, n - Math.min(n, 3000 - (off % 3000))));

  let order = 100000;
  const planted = [];
  for (const host of [{ k: "normal", w: 5500 }, { k: "long10k", w: 10500 }]) {
    for (const span of [5, 6, 10, 20, 37, 50, 89]) {
      const ns = 700 + planted.length;
      const passage = dd(ns, span);
      const half = Math.floor((host.w - span) / 2);
      const body = `${filler(half, ns)} ${passage} ${filler(host.w - span - half, ns + 900)}`;
      const id = `planted-${host.k}-${span}`;
      const r = await seedArchiveDocument(client, { archiveArticleId: id, title: `Planted ${host.k} span=${span}`, originalSimilarity: null, text: body, archiveOrder: order++ }, {
        corpusVersion: "planted", firstSeenAt: "2020-01-01 00:00:00",
      });
      assert.equal(r.status, "SEEDED");
      planted.push({ id, host: host.k, span, passage, title: `Planted ${host.k} span=${span}` });
    }
  }
  await rebuildArchiveDfBands(client);
  await optimizePhraseIndex(client);

  let ok = 0;
  for (const p of planted) {
    const text = `An entirely unrelated opening remark about a different topic precedes this passage. ${p.passage} A separate and unrelated closing note about another subject follows this passage today.`;
    const b = await baselineB(client, text, { maximumDocumentFrequency: 12, matchingParameters: FIXED_MP });
    const m = await matchAgainstArchiveCorpus(client, text, { maximumDocumentFrequency: 12, matchingParameters: FIXED_MP });
    assert.deepEqual(normalizeArchiveResult(m), normalizeArchiveResult(b), `planted ${p.host} span=${p.span}: matcher must reproduce Baseline B`);
    assert.ok(m.archiveDiscovery.phraseProbeCount <= PHRASE_FALLBACK_BUDGET);
    ok += 1;
  }
  assert.equal(ok, 14, "all 14 short-span stress probes reached Baseline-B parity");
});

test("acceptance summary — Baseline-B parity across all 11 fixed + excerpt cases", { skip: SKIP }, () => {
  assert.equal(parityTotal, 11, "11 parity cases (6 fixed probes + 5 real excerpts)");
  assert.equal(parityPass, 11, `${parityPass}/11 Baseline-B parity`);
  // policy constants are internal + versioned, not user settings
  assert.equal(ARCHIVE_MATCH_POLICY.phraseFallbackBudget, 16);
  assert.equal(typeof ARCHIVE_MATCH_POLICY.dfBandPolicyVersion, "string");
});
