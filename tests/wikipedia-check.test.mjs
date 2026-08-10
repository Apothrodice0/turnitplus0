import assert from "node:assert/strict";
import test from "node:test";
import { combineMatchedWordPositions } from "../lib/similarity-enrichment.ts";
import { selectPhrases } from "../lib/web-check-core.ts";
import { runWikipediaCheck } from "../lib/wikipedia-check.ts";

const text = Array.from({ length: 18 }, (_, index) => (
  `Passage ${index} explores photosynthetic biochemical transformation through unusually distinctive `
  + `chlorophyll mechanisms and reproducible cellular respiration evidence in complex ecosystems.`
)).join("\n\n");

test("queries exact raw phrases and returns linked Wikipedia sources", async () => {
  const chosen = selectPhrases(text, text, 2);
  const queries = [];
  const result = await runWikipediaCheck(text, {
    count: 2,
    delayMs: 0,
    fetcher: async (input) => {
      const url = new URL(String(input));
      queries.push(url.searchParams.get("srsearch"));
      return new Response(JSON.stringify({ query: { search: [{ pageid: 42, title: "Photosynthesis" }] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(queries[0], `"${chosen[0].text}"`);
  assert.equal(result.status, "complete");
  assert.equal(result.phrasesMatched, 2);
  assert.deepEqual(result.matches[0].sources[0], {
    title: "Photosynthesis",
    pageId: 42,
    url: "https://en.wikipedia.org/wiki/Photosynthesis",
  });
});

test("keeps completed lookups when one Wikipedia request fails", async () => {
  let request = 0;
  const result = await runWikipediaCheck(text, {
    count: 3,
    delayMs: 0,
    fetcher: async () => {
      request += 1;
      if (request === 2) throw new Error("temporary failure");
      return new Response(JSON.stringify({ query: { search: [] } }), { status: 200 });
    },
  });
  assert.equal(result.status, "partial");
  assert.equal(result.errorCount, 1);
  assert.equal(result.matches.length, 3);
});

test("returns an insufficient result for text too short to sample", async () => {
  const result = await runWikipediaCheck("A short sentence.", { delayMs: 0 });
  assert.equal(result.status, "insufficient");
  assert.equal(result.phrasesSampled, 0);
});

test("records throttling instead of treating it as a no-match", async () => {
  const result = await runWikipediaCheck(text, {
    count: 1,
    delayMs: 0,
    fetcher: async () => new Response("", { status: 429 }),
  });
  assert.equal(result.phrasesMatched, 0);
  assert.equal(result.outcomes.throttled, 1);
  assert.equal(result.outcomes["no-match"], 0);
});

test("background enrichment adds only unique Wikipedia word positions", () => {
  const result = combineMatchedWordPositions(
    [0, 1, 2, 3, 4],
    [{ wordStart: 3, wordEnd: 10 }, { wordStart: 12, wordEnd: 15 }],
    20,
  );
  assert.equal(result.matchedWordCount, 13);
  assert.equal(result.externalMatchedWordCount, 8);
  assert.equal(result.score, 65);
});
