import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { normalize } from "../lib/similarity-core";
import { selectPhrases, type WebCheckResult, type WebCheckSource } from "../lib/web-check-core";
import { loadCorpus } from "./calibration-utils";

const CACHE_PATH = "corpus/wikipedia-similarity-observations.json";
const PHRASE_COUNT = 20;
const CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.WIKIPEDIA_CALIBRATION_CONCURRENCY ?? 4)));
type Observation = { id: string; textSha256: string; checkedAt: string; queryMethod: "wikimedia-rest-exact-or-v1"; result: WebCheckResult };
type ObservationFile = { schema: "turnitplus-wikipedia-similarity-observations"; version: 1; provider: "Wikipedia"; phraseCount: number; generatedAt: string; observations: Observation[] };

const textHash = (text: string) => createHash("sha256").update(text).digest("hex");
function loadCache(): ObservationFile {
  if (!existsSync(CACHE_PATH)) return { schema: "turnitplus-wikipedia-similarity-observations", version: 1, provider: "Wikipedia", phraseCount: PHRASE_COUNT, generatedAt: new Date(0).toISOString(), observations: [] };
  const value = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as ObservationFile;
  if (value.schema !== "turnitplus-wikipedia-similarity-observations" || value.version !== 1 || value.phraseCount !== PHRASE_COUNT) throw new Error(`Unsupported Wikipedia observation cache: ${CACHE_PATH}`);
  return value;
}
function saveCache(observations: Observation[]) {
  const output: ObservationFile = { schema: "turnitplus-wikipedia-similarity-observations", version: 1, provider: "Wikipedia", phraseCount: PHRASE_COUNT, generatedAt: new Date().toISOString(), observations: [...observations].sort((a, b) => a.id.localeCompare(b.id)) };
  mkdirSync("corpus", { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(output, null, 2));
}
async function respectfulFetch(input: URL | RequestInfo, init?: RequestInit) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const response = await fetch(input, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(20_000),
        headers: {
          ...Object.fromEntries(new Headers(init?.headers).entries()),
          "User-Agent": "TurnitPlus-thesis-calibration/1.0",
        },
      });
      if (response.status !== 429 || attempt === 8) return response;
      const retryAfter = Number(response.headers.get("retry-after") ?? 8);
      await new Promise((resolve) => setTimeout(resolve, Math.max(8, retryAfter) * 1000));
    } catch (error) {
      if (attempt === 8) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
    }
  }
  throw new Error("Wikipedia retry loop ended unexpectedly.");
}

function decodeHtml(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'");
}
async function batchedWikipediaCheck(text: string): Promise<WebCheckResult> {
  const phrases = selectPhrases(text, text, PHRASE_COUNT);
  if (phrases.length !== PHRASE_COUNT) throw new Error(`Expected ${PHRASE_COUNT} phrases, selected ${phrases.length}.`);
  const groups: typeof phrases[] = [];
  let group: typeof phrases = [];
  for (const phrase of phrases) {
    const candidate = [...group, phrase];
    const candidateQuery = candidate.map((item) => `\"${item.text}\"`).join(" OR ");
    if (group.length && candidateQuery.length > 285) {
      groups.push(group);
      group = [phrase];
    } else group = candidate;
  }
  if (group.length) groups.push(group);
  const sourcesByPhrase = new Map<string,WebCheckSource[]>();
  await Promise.all(groups.map(async (phraseGroup) => {
    const searchUrl = new URL("https://api.wikimedia.org/core/v1/wikipedia/en/search/page");
    const query = phraseGroup.map((phrase) => `\"${phrase.text}\"`).join(" OR ");
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("limit", "50");
    const searchResponse = await respectfulFetch(searchUrl);
    if (!searchResponse.ok) throw new Error(`Wikipedia search returned ${searchResponse.status}.`);
    const payload = await searchResponse.json() as { pages?:Array<{id?:number;key?:string;title?:string;excerpt?:string}> };
    for (const phrase of phraseGroup) {
      const sources = (payload.pages ?? []).filter((page) => normalize(decodeHtml(page.excerpt ?? "")).includes(phrase.normalized)).filter((page):page is {id:number;key:string;title:string;excerpt?:string} => typeof page.id === "number" && typeof page.key === "string" && typeof page.title === "string").map((page) => ({title:page.title,pageId:page.id,url:`https://en.wikipedia.org/wiki/${encodeURIComponent(page.key)}`}));
      if (sources.length) sourcesByPhrase.set(phrase.normalized, sources);
    }
  }));
  const matches = phrases.map((phrase) => {
    const sources = sourcesByPhrase.get(phrase.normalized) ?? [];
    return { phrase:phrase.text, normalizedPhrase:phrase.normalized, matched:sources.length>0, sources };
  });
  return { status:"complete", provider:"Wikipedia", phrasesSampled:phrases.length, phrasesMatched:matches.filter((match)=>match.matched).length, matches, checkedAt:new Date().toISOString(), errorCount:0 };
}

const documents = loadCorpus("similarity-calibration");
const cache = loadCache();
const byId = new Map(cache.observations.map((row) => [row.id, row]));
const pending = documents.filter((document) => {
  const cached = byId.get(document.id);
  return !cached || cached.queryMethod !== "wikimedia-rest-exact-or-v1" || cached.textSha256 !== textHash(document.text) || cached.result.status !== "complete" || cached.result.phrasesSampled !== PHRASE_COUNT;
});
console.log(`Wikipedia calibration: ${documents.length - pending.length} cached, ${pending.length} pending, concurrency ${CONCURRENCY}.`);
let cursor = 0;
let completed = 0;
async function worker(workerNumber: number) {
  for (;;) {
    const document = pending[cursor++];
    if (!document) return;
    const result = await batchedWikipediaCheck(document.text);
    byId.set(document.id, { id: document.id, textSha256: textHash(document.text), checkedAt: result.checkedAt, queryMethod:"wikimedia-rest-exact-or-v1", result });
    completed += 1;
    saveCache([...byId.values()]);
    console.log(`[${completed}/${pending.length}] worker ${workerNumber}: ${document.id} -> ${result.phrasesMatched}/${result.phrasesSampled}`);
    await new Promise((resolve) => setTimeout(resolve, 8_500));
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, pending.length)) }, (_, index) => worker(index + 1)));
const selected = documents.map((document) => byId.get(document.id));
if (selected.some((row) => !row)) throw new Error("Wikipedia observation cache is incomplete after collection.");
saveCache(selected as Observation[]);
console.log(`Saved ${selected.length} complete Wikipedia observations to ${CACHE_PATH}.`);
