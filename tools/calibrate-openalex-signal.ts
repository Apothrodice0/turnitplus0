import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { preflightOpenAlexApiKey, runOpenAlexCheck } from "../lib/openalex-check";
import { loadCorpus } from "./calibration-utils";
import type { OpenAlexObservation, OpenAlexObservationFile } from "./openalex-signal";

const CACHE_PATH = "corpus/openalex-similarity-observations.json";
const PHRASE_COUNT = 20;
const API_KEY = process.env.OPENALEX_API_KEY?.trim() ?? "";
const MAILTO = process.env.OPENALEX_MAILTO?.trim() ?? "";
const DELAY_MS = Math.max(100, Number(process.env.OPENALEX_CALIBRATION_DELAY_MS ?? 150));
const textHash = (text: string) => createHash("sha256").update(text).digest("hex");

if (!API_KEY) {
  throw new Error(
    "OPENALEX_API_KEY is required. Create a free OpenAlex key and set it in the local environment; do not paste it into source or browser code.",
  );
}

function emptyFile(): OpenAlexObservationFile {
  return {
    schema: "turnitplus-openalex-similarity-observations",
    version: 1,
    provider: "OpenAlex",
    phraseCount: PHRASE_COUNT,
    generatedAt: new Date(0).toISOString(),
    observations: [],
  };
}

function loadCache() {
  if (!existsSync(CACHE_PATH)) return emptyFile();
  const value = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as OpenAlexObservationFile;
  if (
    value.schema !== "turnitplus-openalex-similarity-observations"
    || value.version !== 1
    || value.provider !== "OpenAlex"
    || value.phraseCount !== PHRASE_COUNT
    || !Array.isArray(value.observations)
  ) {
    throw new Error(`Unsupported OpenAlex observation cache: ${CACHE_PATH}`);
  }
  return value;
}

function saveCache(observations: OpenAlexObservation[]) {
  const output: OpenAlexObservationFile = {
    ...emptyFile(),
    generatedAt: new Date().toISOString(),
    observations: [...observations].sort((left, right) => left.id.localeCompare(right.id)),
  };
  mkdirSync("corpus", { recursive: true });
  writeFileSync(CACHE_PATH, `${JSON.stringify(output, null, 2)}\n`);
}

const documents = loadCorpus("similarity-calibration");
console.log("Checking OpenAlex API key and allowance...");
await preflightOpenAlexApiKey(API_KEY);
console.log("OpenAlex preflight passed. Starting resumable collection.");
const cache = loadCache();
const byId = new Map(cache.observations.map((observation) => [observation.id, observation]));
const pending = documents.filter((document) => {
  const cached = byId.get(document.id);
  return !cached
    || cached.queryMethod !== "openalex-fulltext-search-exact-v1"
    || cached.textSha256 !== textHash(document.text)
    || cached.result.status !== "complete"
    || cached.result.errorCount !== 0
    || cached.result.phrasesSampled !== PHRASE_COUNT;
});

console.log(`OpenAlex calibration: ${documents.length - pending.length} cached, ${pending.length} pending.`);
for (let index = 0; index < pending.length; index += 1) {
  const document = pending[index];
  const result = await runOpenAlexCheck(document.text, {
    count: PHRASE_COUNT,
    delayMs: DELAY_MS,
    timeoutMs: 20_000,
    apiKey: API_KEY,
    mailto: MAILTO || undefined,
    onProgress: (_current, _total, _label, latest) => {
      if (latest) process.stdout.write(`${latest.outcome} `);
    },
  });
  process.stdout.write("\n");
  const observation: OpenAlexObservation = {
    id: document.id,
    textSha256: textHash(document.text),
    checkedAt: result.checkedAt,
    queryMethod: "openalex-fulltext-search-exact-v1",
    result,
  };
  byId.set(document.id, observation);
  saveCache([...byId.values()]);
  console.log(
    `[${index + 1}/${pending.length}] ${document.id}: ${result.phrasesMatched}/${result.phrasesSampled}; `
    + `matched=${result.outcomes.matched}, no-match=${result.outcomes["no-match"]}, `
    + `throttled=${result.outcomes.throttled}, timed-out=${result.outcomes["timed-out"]}, failed=${result.outcomes.failed}`,
  );
  if (result.status !== "complete") {
    throw new Error(
      `OpenAlex collection stopped after ${document.id} with status ${result.status}. The partial result was cached; rerun later to resume.`,
    );
  }
}

const selected = documents.map((document) => byId.get(document.id));
if (selected.some((observation) => !observation)) {
  throw new Error("OpenAlex observation cache is incomplete after collection.");
}
saveCache(selected as OpenAlexObservation[]);
console.log(`Saved ${selected.length} complete OpenAlex observations to ${CACHE_PATH}.`);
