import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

/**
 * Static wiring guarantees for the bounded archive-read-retry layer
 * (lib/archive-read-retry.ts):
 *
 *   - the RETRY BEHAVIOUR (createArchiveReadRetryClient) is constructed in
 *     exactly one place — lib/archive-server-analysis.ts — and nowhere else;
 *   - no write / rate-limit / seed / rebuild / migration path imports it;
 *   - GET /api/archive/match stays DB-independent (hardening #1 intact);
 *   - POST /api/archive/match still rate-limits with checkRate OUTSIDE any
 *     retry layer, and hands the matcher the retry wrapper only for reads;
 *   - the matcher + its read helpers take the narrow ArchiveReadClient.
 *
 * The ArchiveReadClient *type* is imported by the matcher read helpers — that
 * is only a structural type (execute() only) and carries no retry behaviour;
 * this file checks the behaviour, not the type import.
 */

const repo = path.resolve(".");
const read = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");

function walkTs(dirs, visit) {
  const stack = [...dirs];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(path.join(repo, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) stack.push(rel);
      else if (/\.(ts|tsx)$/.test(entry.name)) visit(rel, read(rel));
    }
  }
}

test("createArchiveReadRetryClient (the retry behaviour) is constructed ONLY in lib/archive-server-analysis.ts", () => {
  const constructors = [];
  walkTs(["lib", "app"], (rel, src) => {
    if (rel === "lib/archive-read-retry.ts") return;
    if (/\bcreateArchiveReadRetryClient\s*\(/.test(stripComments(src))) constructors.push(rel);
  });
  assert.deepEqual(constructors.sort(), ["lib/archive-server-analysis.ts"]);
});

test("no write / rate-limit / seed / rebuild / migration / report path references the archive read-retry layer at all", () => {
  const forbidden = [
    "lib/rate-limit.ts",
    "lib/reports-db.ts",
    "lib/ingest.ts",
    "lib/archive-corpus-seed.ts",
    "lib/archive-index-build.ts",
    "lib/archive-df-bands.ts",       // build fn buildDfBandTable writes; only the type may appear, never the retry ctor/behaviour
    "lib/corpus-admission-gate.ts",
    "lib/corpus-admission-promotion.ts",
    "app/api/archive/match/route.ts",
    "app/api/reports/route.ts",
  ];
  for (const rel of forbidden) {
    const src = stripComments(read(rel));
    assert.doesNotMatch(src, /createArchiveReadRetryClient|summarizeArchiveReadRetry/, `${rel} must not construct or summarise the retry layer`);
  }
  // rate-limit / reports-db / seed / rebuild must not even import the module.
  for (const rel of ["lib/rate-limit.ts", "lib/reports-db.ts", "lib/archive-corpus-seed.ts", "lib/archive-index-build.ts", "app/api/reports/route.ts"]) {
    assert.doesNotMatch(read(rel), /from ["'][^"']*archive-read-retry["']/, `${rel} must not import lib/archive-read-retry`);
  }
});

test("archive-df-bands.ts: only the request-time loadDfBandMap uses the narrow client; buildDfBandTable still takes a full Client and writes", () => {
  const src = read("lib/archive-df-bands.ts");
  assert.match(src, /export async function loadDfBandMap\(\s*\n?\s*client: ArchiveReadClient/);
  assert.match(src, /export async function buildDfBandTable\(\s*\n?\s*client: Client/);
  assert.match(src, /client\.batch\(batch, "write"\)/, "the build path still batches writes on a full Client");
});

test("GET /api/archive/match stays DB-independent — the retry work did not touch it", () => {
  const src = read("app/api/archive/match/route.ts");
  const getBody = src.slice(src.indexOf("export async function GET"), src.indexOf("export async function POST"));
  for (const banned of ["checkRate", "checkReadRate", "clientIpFrom", "getReportsDbClient", "createArchiveReadRetryClient", "archive-read-retry", "analyzeArchiveOnServer"]) {
    assert.equal(getBody.includes(banned), false, `GET must not reference ${banned}`);
  }
  assert.match(getBody, /isArchiveServerSideEnabled\(\)/);
});

test("POST /api/archive/match: checkRate runs directly (outside any retry layer); the matcher gets the raw client and wraps reads internally", () => {
  const src = read("app/api/archive/match/route.ts");
  const postBody = src.slice(src.indexOf("export async function POST"));
  assert.match(postBody, /const rate = await checkRate\(clientIpFrom\(request\)\)/, "POST still rate-limits by client IP, directly");
  assert.doesNotMatch(postBody, /createArchiveReadRetryClient/, "the route does not build the retry wrapper — analyzeArchiveOnServer does, for reads only");
  assert.match(postBody, /await analyzeArchiveOnServer\(client, text\)/, "POST hands analyzeArchiveOnServer the raw client");
  assert.match(postBody, /client\.close\(\)/, "POST still owns client.close()");
});

test("archive-server-analysis builds ONE retry wrapper and runs the matcher on it, never on the raw client", () => {
  const src = stripComments(read("lib/archive-server-analysis.ts"));
  assert.match(src, /createArchiveReadRetryClient\(client, options\.readRetry\)/);
  assert.match(src, /matchAgainstArchiveCorpus\(readClient,/);
  assert.doesNotMatch(src, /matchAgainstArchiveCorpus\(client,/, "the raw client must not reach the matcher");
});

test("the matcher and every read helper it calls take the narrow ArchiveReadClient, not a full Client", () => {
  const targets = [
    ["lib/archive-corpus-matching.ts", ["matchAgainstArchiveCorpus", "compactDiscovery", "scoreOverCandidates"]],
    ["lib/archive-phrase-fallback.ts", ["phraseFallbackDiscovery", "runPhraseProbes", "resolveQueryGramDf"]],
    ["lib/archive-phrase-index.ts", ["phraseSearch", "phraseFanOut"]],
    ["lib/archive-df-bands.ts", ["loadDfBandMap"]],
    ["lib/archive-cosource.ts", ["loadCosources"]],
  ];
  for (const [rel, fns] of targets) {
    const src = read(rel);
    for (const fn of fns) {
      assert.match(src, new RegExp(`function ${fn}\\(\\s*client: ArchiveReadClient`), `${rel}: ${fn} must take client: ArchiveReadClient`);
    }
  }
});

test("lib/archive-read-retry.ts imports nothing but @libsql/client types — it is a leaf, reusable by no write path", () => {
  const src = read("lib/archive-read-retry.ts");
  const imports = [...src.matchAll(/^import\s.*?from\s+["']([^"']+)["'];?$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["@libsql/client"], `unexpected imports: ${imports.join(", ")}`);
  assert.match(src, /import type \{/, "the only import is type-only");
});
