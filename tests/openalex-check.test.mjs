import assert from "node:assert/strict";
import test from "node:test";
import {
  preflightOpenAlexApiKey,
  runOpenAlexCheck,
  sanitizeOpenAlexExactPhrase,
  summarizeOpenAlexCheck,
} from "../lib/openalex-check.ts";
import { selectPhrases } from "../lib/web-check-core.ts";

const text = Array.from({ length: 18 }, (_, index) => (
  `Section ${index} examines transnational regulatory accountability through unusually distinctive `
  + `institutional governance mechanisms and reproducible economic evidence across jurisdictions.`
)).join("\n\n");

test("preflights one authenticated full-text request before collection", async () => {
  let request;
  const result = await preflightOpenAlexApiKey("free-test-key", {
    fetcher: async (input) => {
      request = new URL(String(input));
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(result.status, "ready");
  assert.equal(request.searchParams.get("api_key"), "free-test-key");
  assert.equal(request.searchParams.get("filter"), 'fulltext.search:"academic research"');
});

test("preflight rejects a throttled key before corpus requests start", async () => {
  await assert.rejects(
    preflightOpenAlexApiKey("limited-test-key", {
      fetcher: async () => new Response("rate limited", { status: 429 }),
    }),
    /No corpus requests were started/,
  );
});

test("removes OpenAlex filter syntax without changing phrase word order", () => {
  assert.equal(
    sanitizeOpenAlexExactPhrase(
      "compensation options? Responsibility Deployment | Are there continuous monitoring techniques",
    ),
    "compensation options Responsibility Deployment Are there continuous monitoring techniques",
  );
  assert.equal(
    sanitizeOpenAlexExactPhrase("l’éthique: مسؤولية الباحث / 2024"),
    "l éthique مسؤولية الباحث 2024",
  );
});

test("queries exact sampled phrases and maps OpenAlex works", async () => {
  const chosen = selectPhrases(text, text, 2);
  const requests = [];
  const result = await runOpenAlexCheck(text, {
    count: 2,
    delayMs: 0,
    apiKey: "free-test-key",
    mailto: "researcher@example.org",
    fetcher: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      return new Response(JSON.stringify({
        results: [{
          id: "https://openalex.org/W123",
          display_name: "Regulatory accountability",
          doi: "https://doi.org/10.1000/example",
          publication_year: 2020,
          primary_location: { landing_page_url: "https://example.org/article" },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(requests[0].searchParams.get("filter"), `fulltext.search:\"${chosen[0].text}\"`);
  assert.equal(requests[0].searchParams.get("per-page"), "3");
  assert.equal(requests[0].searchParams.get("api_key"), "free-test-key");
  assert.equal(requests[0].searchParams.get("mailto"), "researcher@example.org");
  assert.equal(result.status, "complete");
  assert.equal(result.phrasesMatched, 2);
  assert.equal(result.outcomes.matched, 2);
  assert.deepEqual(
    {
      sampleIndex: result.matches[0].sampleIndex,
      wordStart: result.matches[0].wordStart,
      wordEnd: result.matches[0].wordEnd,
    },
    { sampleIndex: 1, wordStart: chosen[0].wordStart, wordEnd: chosen[0].wordEnd },
  );
  assert.deepEqual(result.matches[0].sources[0], {
    title: "Regulatory accountability",
    url: "https://example.org/article",
    workId: "W123",
    doi: "https://doi.org/10.1000/example",
    publicationYear: 2020,
  });
});

test("records no-match separately from throttled and failed lookups", async () => {
  let request = 0;
  const observed = [];
  const result = await runOpenAlexCheck(text, {
    count: 3,
    delayMs: 0,
    fetcher: async () => {
      request += 1;
      if (request === 1) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      if (request === 2) return new Response("rate limited", { status: 429 });
      return new Response("server error", { status: 503 });
    },
    onProgress: (_current, _total, _label, latest) => {
      if (latest) observed.push(latest.outcome);
    },
  });

  assert.equal(result.status, "partial");
  assert.equal(result.phrasesMatched, 0);
  assert.deepEqual(result.matches.map((match) => match.outcome), ["no-match", "throttled", "failed"]);
  assert.deepEqual(observed, ["no-match", "throttled", "failed"]);
  assert.equal(result.outcomes["no-match"], 1);
  assert.equal(result.outcomes.throttled, 1);
  assert.equal(result.outcomes.failed, 1);
  assert.equal(result.errorCount, 2);
  assert.match(summarizeOpenAlexCheck(result), /2 lookup errors reported separately/);
});

test("records an aborted lookup as timed-out rather than no-match", async () => {
  const result = await runOpenAlexCheck(text, {
    count: 1,
    delayMs: 0,
    timeoutMs: 5,
    fetcher: async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  });

  assert.equal(result.status, "error");
  assert.equal(result.matches[0].outcome, "timed-out");
  assert.equal(result.outcomes["timed-out"], 1);
  assert.equal(result.outcomes["no-match"], 0);
});

test("returns an insufficient result before making network requests", async () => {
  let fetched = false;
  const result = await runOpenAlexCheck("A short sentence.", {
    fetcher: async () => {
      fetched = true;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    },
  });
  assert.equal(result.status, "insufficient");
  assert.equal(result.phrasesSampled, 0);
  assert.equal(fetched, false);
});
