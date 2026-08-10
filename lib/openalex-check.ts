import { selectPhrases } from "./web-check-core";

export type OpenAlexPhraseOutcome =
  | "matched"
  | "no-match"
  | "throttled"
  | "timed-out"
  | "failed";

export type OpenAlexCheckSource = {
  title: string;
  url: string;
  workId: string;
  doi: string | null;
  publicationYear: number | null;
};

export type OpenAlexPhraseMatch = {
  phrase: string;
  normalizedPhrase: string;
  sampleIndex: number;
  wordStart: number;
  wordEnd: number;
  outcome: OpenAlexPhraseOutcome;
  matched: boolean;
  sources: OpenAlexCheckSource[];
  httpStatus?: number;
  error?: string;
};

export type OpenAlexOutcomeCounts = Record<OpenAlexPhraseOutcome, number>;

export type OpenAlexCheckResult = {
  status: "complete" | "partial" | "error" | "insufficient";
  provider: "OpenAlex";
  phrasesSampled: number;
  phrasesMatched: number;
  matches: OpenAlexPhraseMatch[];
  checkedAt: string;
  errorCount: number;
  outcomes: OpenAlexOutcomeCounts;
};

type OpenAlexWork = {
  id?: string;
  display_name?: string;
  title?: string;
  doi?: string | null;
  publication_year?: number | null;
  primary_location?: { landing_page_url?: string | null } | null;
};

type OpenAlexResponse = {
  results?: OpenAlexWork[];
};

export type OpenAlexCheckOptions = {
  count?: number;
  delayMs?: number;
  timeoutMs?: number;
  /**
   * OpenAlex currently uses free API keys. Supplying one is optional here so
   * callers can still record an explicit HTTP failure instead of crashing.
   */
  apiKey?: string;
  /**
   * Retained for compatibility with older OpenAlex clients. OpenAlex has
   * deprecated the polite-pool mailto parameter and may ignore this value.
   */
  mailto?: string;
  fetcher?: typeof fetch;
  onProgress?: (
    current: number,
    total: number,
    label: string,
    latest?: OpenAlexPhraseMatch,
  ) => void;
};

export type OpenAlexPreflightOptions = {
  timeoutMs?: number;
  fetcher?: typeof fetch;
};

function emptyOutcomeCounts(): OpenAlexOutcomeCounts {
  return {
    matched: 0,
    "no-match": 0,
    throttled: 0,
    "timed-out": 0,
    failed: 0,
  };
}

function cleanIdentifier(value: string | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

function workIdentifier(id: string) {
  const tail = id.split("/").at(-1);
  return tail || id;
}

function sourceUrl(work: OpenAlexWork, id: string) {
  const landingPage = cleanIdentifier(work.primary_location?.landing_page_url ?? undefined);
  if (landingPage) return landingPage;
  const doi = cleanIdentifier(work.doi ?? undefined);
  if (doi) return doi.startsWith("http") ? doi : `https://doi.org/${doi.replace(/^doi:/i, "")}`;
  return id;
}

function sourcesFromResponse(payload: OpenAlexResponse): OpenAlexCheckSource[] {
  const seen = new Set<string>();
  const sources: OpenAlexCheckSource[] = [];
  for (const work of payload.results ?? []) {
    const id = cleanIdentifier(work.id);
    const title = cleanIdentifier(work.display_name ?? work.title);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const doi = cleanIdentifier(work.doi ?? undefined);
    sources.push({
      title,
      url: sourceUrl(work, id),
      workId: workIdentifier(id),
      doi: doi || null,
      publicationYear: Number.isInteger(work.publication_year) ? work.publication_year! : null,
    });
  }
  return sources;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function summarizeStatus(matches: OpenAlexPhraseMatch[]): OpenAlexCheckResult["status"] {
  const failed = matches.filter((match) => (
    match.outcome === "throttled"
    || match.outcome === "timed-out"
    || match.outcome === "failed"
  )).length;
  if (failed === matches.length) return "error";
  if (failed > 0) return "partial";
  return "complete";
}

/**
 * OpenAlex parses the `filter` value with its own punctuation-sensitive
 * grammar. Keep only Unicode letters and numbers in sampled exact phrases so
 * characters such as `?`, `|`, `:`, and quotes cannot turn document text into
 * invalid filter syntax. The words and their order remain unchanged.
 */
export function sanitizeOpenAlexExactPhrase(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Checks one authenticated full-text request before the 1,200-request corpus
 * run. A rejected key, exhausted allowance, or unavailable endpoint therefore
 * cannot consume a partial day of collection work.
 */
export async function preflightOpenAlexApiKey(
  apiKey: string,
  options: OpenAlexPreflightOptions = {},
) {
  const key = cleanIdentifier(apiKey);
  if (!key) throw new Error("OpenAlex preflight requires OPENALEX_API_KEY.");
  const timeoutMs = options.timeoutMs ?? 20_000;
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("filter", 'fulltext.search:"academic research"');
    url.searchParams.set("per-page", "1");
    url.searchParams.set("api_key", key);
    const response = await fetcher(url, { signal: controller.signal });
    if (response.status === 401 || response.status === 403) {
      throw new Error(`OpenAlex rejected the API key (HTTP ${response.status}). Check the value in .env.`);
    }
    if (response.status === 429) {
      throw new Error("OpenAlex rate limit or daily allowance reached (HTTP 429). No corpus requests were started.");
    }
    if (!response.ok) {
      throw new Error(`OpenAlex preflight failed with HTTP ${response.status}. No corpus requests were started.`);
    }
    await response.json();
    return { status: "ready" as const, httpStatus: response.status };
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      throw new Error(`OpenAlex preflight timed out after ${timeoutMs} ms. No corpus requests were started.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runOpenAlexCheck(
  text: string,
  options: OpenAlexCheckOptions = {},
): Promise<OpenAlexCheckResult> {
  const count = options.count ?? 20;
  const delayMs = options.delayMs ?? 120;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const fetcher = options.fetcher ?? fetch;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("OpenAlex timeout must be a positive number of milliseconds.");
  }
  const phrases = selectPhrases(text, text, count);
  if (phrases.length === 0) {
    return {
      status: "insufficient",
      provider: "OpenAlex",
      phrasesSampled: 0,
      phrasesMatched: 0,
      matches: [],
      checkedAt: new Date().toISOString(),
      errorCount: 0,
      outcomes: emptyOutcomeCounts(),
    };
  }

  const matches: OpenAlexPhraseMatch[] = [];
  for (let index = 0; index < phrases.length; index += 1) {
    const phrase = phrases[index];
    const phrasePosition = {
      sampleIndex: index + 1,
      wordStart: phrase.wordStart,
      wordEnd: phrase.wordEnd,
    };
    options.onProgress?.(
      index + 1,
      phrases.length,
      `Checking scholarly phrase ${index + 1} of ${phrases.length}`,
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let match: OpenAlexPhraseMatch;
    try {
      const url = new URL("https://api.openalex.org/works");
      url.searchParams.set("filter", `fulltext.search:\"${sanitizeOpenAlexExactPhrase(phrase.text)}\"`);
      url.searchParams.set("per-page", "3");
      if (cleanIdentifier(options.apiKey)) url.searchParams.set("api_key", options.apiKey!.trim());
      if (cleanIdentifier(options.mailto)) url.searchParams.set("mailto", options.mailto!.trim());
      const response = await fetcher(url, { signal: controller.signal });
      if (response.status === 429) {
        match = {
          phrase: phrase.text,
          normalizedPhrase: phrase.normalized,
          ...phrasePosition,
          outcome: "throttled",
          matched: false,
          sources: [],
          httpStatus: 429,
          error: "OpenAlex rate limit reached.",
        };
      } else if (!response.ok) {
        match = {
          phrase: phrase.text,
          normalizedPhrase: phrase.normalized,
          ...phrasePosition,
          outcome: "failed",
          matched: false,
          sources: [],
          httpStatus: response.status,
          error: `OpenAlex returned ${response.status}.`,
        };
      } else {
        const payload = await response.json() as OpenAlexResponse;
        const sources = sourcesFromResponse(payload);
        match = {
          phrase: phrase.text,
          normalizedPhrase: phrase.normalized,
          ...phrasePosition,
          outcome: sources.length > 0 ? "matched" : "no-match",
          matched: sources.length > 0,
          sources,
        };
      }
    } catch (error) {
      const timedOut = controller.signal.aborted || isAbortError(error);
      match = {
        phrase: phrase.text,
        normalizedPhrase: phrase.normalized,
        ...phrasePosition,
        outcome: timedOut ? "timed-out" : "failed",
        matched: false,
        sources: [],
        error: timedOut
          ? `OpenAlex lookup timed out after ${timeoutMs} ms.`
          : error instanceof Error ? error.message : "OpenAlex lookup failed.",
      };
    } finally {
      clearTimeout(timeout);
    }
    matches.push(match);
    options.onProgress?.(
      index + 1,
      phrases.length,
      `OpenAlex: ${match.outcome}`,
      match,
    );
    if (index < phrases.length - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const outcomes = emptyOutcomeCounts();
  for (const match of matches) outcomes[match.outcome] += 1;
  const errorCount = outcomes.throttled + outcomes["timed-out"] + outcomes.failed;
  return {
    status: summarizeStatus(matches),
    provider: "OpenAlex",
    phrasesSampled: matches.length,
    phrasesMatched: outcomes.matched,
    matches,
    checkedAt: new Date().toISOString(),
    errorCount,
    outcomes,
  };
}

export function summarizeOpenAlexCheck(result: OpenAlexCheckResult) {
  if (result.status === "insufficient") return "Not enough text to sample distinctive phrases.";
  if (result.status === "error") return "OpenAlex could not complete any sampled phrase lookup.";
  const suffix = result.errorCount > 0 ? `; ${result.errorCount} lookup errors reported separately` : "";
  return `${result.phrasesMatched} of ${result.phrasesSampled} sampled phrases found in OpenAlex${suffix}`;
}
