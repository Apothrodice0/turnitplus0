import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../../lib/ingest.js";
import * as reportsRoute from "../../app/api/reports/route.ts";
import * as reportIdRoute from "../../app/api/reports/[id]/route.ts";
import * as signupRoute from "../../app/api/auth/signup/route.ts";
import { resetRateForTest, resetAuthRateForTest } from "../../lib/rate-limit.ts";
import { canonicalSha256 } from "../../lib/document-identity.ts";
import { runCorpusAdmissionPromotionSweep } from "../../lib/corpus-admission-promotion.ts";
import { AI_COMPACT_PASSAGES_WRITE_FLAG } from "../../lib/ai-compact-passages-flag.ts";
import { matureCorpusBackings } from "./corpus-maturity.mjs";
import { withTestIdentity } from "./test-signup.mjs";
import { buildRealisticAiAnalysis, pseudoBpeTokenizer } from "./real-ai-windows.mjs";

/**
 * G2 fixture — a SYNTHETIC large report whose GET-expanded form exceeds the
 * report-save request ceiling (MAX_REPORT_SAVE_REQUEST_BYTES) while its compact
 * PERSISTED form fits under it, plus the plumbing to drive the REAL route
 * handlers end to end through the REAL client helpers (saveReportRemote /
 * fetchRemoteReport) via a fetch stub.
 *
 * Everything here is invented text (never SEALED, never customer content, never
 * the real 293-unit package) and the database lives in a throwaway file. The
 * directory it lives in defaults to the repo root (the same convention every
 * other DB-backed test uses, .gitignore'd via *.db) and can be redirected with
 * TURNITPLUS_TEST_DB_DIR.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// --- synthetic, distinctive, non-generic seed passages (one per promoted corpus source) ---
const SEED_PASSAGES = [
  "Hydrologists instrumenting a braided alpine river observed that sediment pulses arrived in quasi-periodic bursts unrelated to rainfall timing, which led the survey team to attribute the rhythm to intermittent upstream bank collapse rather than to any seasonal discharge cycle recorded at the gauging stations.",
  "Acousticians calibrating a converted grain silo for choral recording measured an unexpectedly long low-frequency decay tail and traced it to a resonant cavity behind the loading hatch, after which a modest baffle installation reduced the reverberation time far more than the broadband absorption originally proposed.",
  "Archaeobotanists sieving a waterlogged medieval latrine deposit recovered an unusually diverse assemblage of imported seeds, implying that the household maintained trade contacts far beyond the regional market network documented in the surviving ledgers of the period.",
  "Geneticists sequencing a landlocked population of freshwater snails found a striking haplotype cluster confined to a single spring-fed pool, suggesting an ancient founder event followed by prolonged isolation rather than the recent dispersal that earlier mitochondrial surveys had assumed.",
  "Cartographers digitizing a nineteenth-century harbour survey noticed systematic soundings offsets along one transect, and after comparing the tide tables they concluded the surveyors had applied a fixed correction where a time-varying adjustment would have been appropriate for that estuary.",
  "Metallurgists annealing a nickel-based superalloy at graduated temperatures documented a narrow window in which grain boundary carbides coarsened without embrittling the matrix, a behaviour that permitted a shorter heat treatment schedule than the manufacturer specification recommended.",
  "Ornithologists ringing migratory waders on a tidal flat recorded a consistent departure delay among birds carrying the heaviest fuel loads, a counterintuitive pattern the team explained through a wind-assisted departure threshold rather than through any difference in body condition alone.",
  "Rheologists testing a dense suspension of cornstarch under oscillatory shear identified a hysteresis loop whose area scaled with the imposed strain rate, indicating that shear thickening in this system is history dependent rather than a purely instantaneous response of the fluid.",
  "Speleologists mapping a flooded limestone passage found that a submerged chamber discharged cold water in pulses timed to distant barometric changes, an observation that supported a siphon mechanism instead of the continuous conduit flow assumed in the earlier hydrological model.",
  "Restoration chemists analysing the pigment layers of a fresco fragment detected a copper-based green overlaid on a lead-tin ground, a sequence that contradicted the attributed workshop and pointed instead to a later campaign of repainting carried out with a different palette.",
];

/** Deterministically extends a seed to roughly `targetWords` words by rotating its own words (no RNG, topically coherent, non-generic). */
function extendSeed(seed, targetWords) {
  const seedWords = seed.replace(/[.,]/g, "").split(/\s+/).filter(Boolean);
  const sentences = [seed];
  let total = seedWords.length;
  let shift = 0;
  while (total < targetWords) {
    shift += 7;
    const rotated = [...seedWords.slice(shift % seedWords.length), ...seedWords.slice(0, shift % seedWords.length)];
    sentences.push(rotated.join(" ") + ".");
    total += rotated.length;
  }
  return sentences.join(" ");
}

const FILLER_WORDS = [
  "analysis", "framework", "observed", "context", "outcome", "variable", "structure", "approach", "evidence", "pattern",
  "process", "measure", "sample", "result", "method", "factor", "detail", "region", "system", "model",
  "signal", "response", "feature", "domain", "element", "sequence", "record", "report", "summary", "section",
];

function fillerWords(count, offset) {
  const parts = [];
  for (let i = 0; i < count; i += 1) parts.push(FILLER_WORDS[(i + offset) % FILLER_WORDS.length] + String((i + offset) % 89));
  return parts.join(" ");
}

/** The ten corpus passages (`passageWords` words each) — the promoted, server-trusted evidence sources. */
export function buildCorpusPassages(passageWords) {
  return SEED_PASSAGES.map((seed) => extendSeed(seed, passageWords));
}

const LATE_SEED =
  "Tephrochronologists correlating ash layers across three lake cores identified a previously unrecognised eruption whose dispersal axis ran perpendicular to the prevailing winds, a finding that forced a revision of the regional chronology built on the older core sequences and raised new questions about the reliability of single-site dating.";

/** An eleventh, distinct passage — used to make the server's similarity move on AFTER a report was saved (promote it, then re-finalize). */
export function buildLateSourcePassage(words) {
  return extendSeed(LATE_SEED, words);
}

/** A manuscript that embeds every corpus passage verbatim between short runs of filler prose. */
export function buildMatchedManuscript(passages, fillerPerSegment = 40) {
  const chunks = [];
  passages.forEach((passage, index) => {
    chunks.push(fillerWords(fillerPerSegment, index * 13));
    chunks.push(passage);
  });
  chunks.push(fillerWords(fillerPerSegment, 999));
  return chunks.join(" ");
}

const wordCountOf = (text) => text.split(/\s+/).filter(Boolean).length;

const standInTokenizer = pseudoBpeTokenizer();
const completeAnalysisCache = new Map();

/**
 * A REALISTIC AiAnalysis. The windows come from the REAL `buildAiTokenChunks` — 240-token windows at a 120-token stride
 * (~50 % overlap), an anchored last window, decode + clean-up + trim, no cap, 13 fields per window — over a deterministic
 * BPE-like stand-in tokenizer, and the result is assembled exactly the way app/ai-detector-worker.ts assembles its
 * `complete` result (only the per-window model outputs are simulated). Its size therefore scales like production's:
 * ~2.4x the manuscript, of which the copied window text is ~84 %.
 *
 * The fixture this replaces listed NON-overlapping 180-word chunks (~1.18x the manuscript) — half the real size — so
 * every G2 size in these tests was optimistic by 2x, and the automatic-save failure on ~600k-character reports could not
 * show up here at all. A fresh deep copy is returned on every call (callers mutate freely); the windows are cached per text.
 */
export function syntheticAiAnalysis(text, { status = "complete", seed = 900 } = {}) {
  if (status !== "complete") {
    return { status, score: null, model: "synthetic-test-model", engine: null, threshold: 0.7, eligibleWordCount: 0, analyzedWordCount: 0, passages: [], ...(status === "error" ? { error: "synthetic failure" } : {}) };
  }
  let bySeed = completeAnalysisCache.get(text);
  if (!bySeed) {
    bySeed = new Map();
    completeAnalysisCache.set(text, bySeed);
  }
  let analysis = bySeed.get(seed);
  if (!analysis) {
    analysis = buildRealisticAiAnalysis(text, standInTokenizer, { seed });
    bySeed.set(seed, analysis);
  }
  return structuredClone(analysis);
}

export const COMPACT_GATE = "REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED";

/** Pins the ai-compact-v1 WRITER gate (NEXT_PUBLIC_AI_COMPACT_PASSAGES_WRITE_ENABLED) for the current process; returns the restore function. */
export function pinAiCompactWrites(value) {
  const previous = process.env[AI_COMPACT_PASSAGES_WRITE_FLAG];
  if (value === undefined) delete process.env[AI_COMPACT_PASSAGES_WRITE_FLAG];
  else process.env[AI_COMPACT_PASSAGES_WRITE_FLAG] = value;
  return () => {
    if (previous === undefined) delete process.env[AI_COMPACT_PASSAGES_WRITE_FLAG];
    else process.env[AI_COMPACT_PASSAGES_WRITE_FLAG] = previous;
  };
}

/** Runs `fn` with the ai-compact-v1 writer gate pinned to `value` (undefined = the default, OFF), restoring it afterwards. */
export async function withAiCompactWrites(value, fn) {
  const restore = pinAiCompactWrites(value);
  try {
    return await fn();
  } finally {
    restore();
  }
}

/** Pins the compact-write flag for the current process; returns the restore function. */
export function pinCompactWrites(value) {
  const previous = process.env[COMPACT_GATE];
  if (value === undefined) delete process.env[COMPACT_GATE];
  else process.env[COMPACT_GATE] = value;
  return () => {
    if (previous === undefined) delete process.env[COMPACT_GATE];
    else process.env[COMPACT_GATE] = previous;
  };
}

/** A minimal in-memory `window.localStorage` so lib/device-key.ts's getDeviceKey() runs in Node. Returns the restore function. */
export function stubBrowserWindow() {
  const originalWindow = globalThis.window;
  const store = new Map();
  globalThis.window = {
    localStorage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); } },
  };
  return () => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  };
}

/**
 * Creates the throwaway migrated DB and points the route handlers at it.
 * `dispose()` restores every env var it touched and deletes the DB files.
 */
export async function createFixtureEnvironment(label) {
  const dbDir = process.env.TURNITPLUS_TEST_DB_DIR || REPO_ROOT;
  fs.mkdirSync(dbDir, { recursive: true });
  const dbFile = path.join(dbDir, `test_${label}.db`);
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* not there */ }
  }
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousMatching = process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
  process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
  const client = createClient({ url: `file:${dbFile}` });
  await applyMigrationsLibsql(client, path.join(REPO_ROOT, "drizzle"));
  const openConnection = () => createClient({ url: `file:${dbFile}` });
  let accountCounter = 0;

  async function promoteDocumentIntoCorpus(text) {
    const hash = canonicalSha256(text);
    const decisionId = randomUUID();
    await client.execute({
      sql: `INSERT INTO corpus_admission_decisions
            (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
             detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
             content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
             corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
             consent_metadata, dry_run, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
      args: [
        decisionId, null, `${label}-${randomUUID()}`, "v1", "ACCEPT", "[]", 1, "[]",
        "txt", 150, "English", 0.95, hash, "v1", null, 80, "v1",
        "{}", "{}", "v1", 0.9, "v1", "NONE", null, null,
        JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
      ],
    });
    await client.execute({
      sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
            VALUES (?,?,?,?,?,NULL,CURRENT_TIMESTAMP)`,
      args: [randomUUID(), decisionId, hash, 150, "v1"],
    });
    await client.execute({
      sql: `INSERT INTO corpus_admission_content_store (id, decision_id, canonical_sha256, canonical_text, extractor_version, retention_basis, stored_at)
            VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
      args: [randomUUID(), decisionId, hash, text, "v1", "LICENSED_REUSE"],
    });
    const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
    assert.equal(sweep.results.find((r) => r.decisionId === decisionId)?.outcome, "indexed", "fixture sanity: promotion must succeed");
    await matureCorpusBackings(client);
  }

  async function signUpAccount() {
    accountCounter += 1;
    const tag = `${label}-user-${accountCounter}`;
    const email = `${tag}@example.test`;
    const deviceKey = `${tag}-device`;
    await resetAuthRateForTest(`${tag}-signup`);
    const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `${tag}-signup` },
      body: JSON.stringify(withTestIdentity({ email, password: `${label}-pw-1234`, username: `${label.slice(0, 8)}${accountCounter}`, deviceKey })),
    }));
    assert.equal(res.status, 201, "fixture sanity: signup must succeed");
    const cookie = res.headers.get("set-cookie")?.match(/tp_session_v1=([^;]*)/)?.[1] ?? null;
    assert.ok(cookie, "fixture sanity: signup must issue a session cookie");
    const row = await client.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [email] });
    const userId = String(row.rows[0].id);
    await client.execute({ sql: "UPDATE users SET corpus_reuse_consented_at = CURRENT_TIMESTAMP WHERE id = ?", args: [userId] });
    return { userId, deviceKey, cookie, tag, email };
  }

  function dispose() {
    client.close();
    if (previousUrl === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = previousUrl;
    if (previousMatching === undefined) delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
    else process.env.CORPUS_SOURCE_MATCHING_ENABLED = previousMatching;
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
    }
  }

  return { dbFile, client, openConnection, promoteDocumentIntoCorpus, signUpAccount, dispose };
}

let callCounter = 0;

/**
 * Routes `fetch` to the REAL route handlers for one signed-in account, recording every request's method, path and body bytes.
 * Sets an explicit `content-length` (a real browser's fetch does; a bare `new Request(url, {body})` does not), so the route's
 * RAW_CONTENT_LENGTH guard sees exactly what production sees. `extraRoutes` maps `<METHOD> <pathPattern>` -> async (req, ctx) => Response.
 * Returns { requests, restore }.
 */
export function installRouteFetch(account, extraRoutes = {}) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, "http://localhost");
    const method = String(init.method ?? "GET").toUpperCase();
    const body = init.body === undefined ? undefined : String(init.body);
    const bytes = body === undefined ? 0 : Buffer.byteLength(body, "utf8");
    callCounter += 1;
    const ip = `${account.tag}-fetch-${callCounter}`;
    await resetRateForTest(ip);
    const headers = {
      ...(init.headers ?? {}),
      "x-forwarded-for": ip,
      cookie: `tp_session_v1=${account.cookie}`,
      ...(body !== undefined ? { "content-length": String(bytes) } : {}),
    };
    const request = new Request(`http://localhost${url.pathname}${url.search}`, { method, headers, body });
    let response;
    const segments = url.pathname.split("/").filter(Boolean); // ["api","reports",":id"?, "ai-retry"?]
    const extra = extraRoutes[`${method} ${url.pathname.replace(/^\/api\/reports\/[^/]+/, "/api/reports/:id")}`];
    if (extra) {
      response = await extra(request, { params: Promise.resolve({ id: decodeURIComponent(segments[2] ?? "") }) });
    } else if (url.pathname === "/api/reports" && method === "POST") {
      response = await reportsRoute.POST(request);
    } else if (url.pathname === "/api/reports" && method === "GET") {
      response = await reportsRoute.GET(request);
    } else if (segments.length === 3 && segments[0] === "api" && segments[1] === "reports" && method === "GET") {
      response = await reportIdRoute.GET(request, { params: Promise.resolve({ id: decodeURIComponent(segments[2]) }) });
    } else {
      response = new Response(JSON.stringify({ error: "not stubbed" }), { status: 404 });
    }
    requests.push({ method, path: url.pathname, bytes, status: response.status });
    return response;
  };
  return { requests, restore: () => { globalThis.fetch = originalFetch; } };
}

/** The body a real first save POSTs for a report the client has just analysed (client-side score fields only; the server computes similarity). */
export function buildFirstSaveBody({ deviceKey, id, text, room = 0, title = "G2 large report fixture" }) {
  const wordCount = wordCountOf(text);
  const created = new Date().toISOString();
  return {
    deviceKey, id, submissionId: `sub-${id}`, title, createdAt: created, wordCount,
    archiveScore: 0, scoreBand: "Low", aiScore: null, aiTone: null, aiStatus: "processing", room,
    payload: {
      version: 11, id, submissionId: `sub-${id}`, title, author: "", assignment: "", created,
      score: 0, archiveScore: 0, wordCount, scoreBand: "Low", matchedWordCount: 0, sources: [], repeats: [], text,
    },
  };
}

export { reportsRoute, reportIdRoute, resetRateForTest, wordCountOf };
