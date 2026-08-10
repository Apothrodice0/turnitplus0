import {
  selectPhrases,
  type WebCheckResult,
  type WebPhraseOutcome,
  type WebCheckSource,
} from "./web-check-core";
import { comparisonText, normalize } from "./similarity-core";

type WikipediaSearchResult = {
  pageid?: number;
  title?: string;
};

type WikipediaResponse = {
  query?: { search?: WikipediaSearchResult[] };
};

export type WikipediaCheckOptions = {
  count?: number;
  delayMs?: number;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  submissionTitle?: string | null;
  onProgress?: (current: number, total: number, label: string) => void;
};

function articleUrl(title: string) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`;
}

export async function runWikipediaCheck(
  text: string,
  options: WikipediaCheckOptions = {},
): Promise<WebCheckResult> {
  const count = options.count ?? 20;
  const delayMs = options.delayMs ?? 120;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fetcher = options.fetcher ?? fetch;
  const bodyText = comparisonText(text);
  const phrases = selectPhrases(bodyText, bodyText, count);
  const referenceSectionRemoved = bodyText.trim().length < text.trim().length;
  const normalizedSubmissionTitle = normalize(
    (options.submissionTitle ?? "").replace(/\.[a-z0-9]{1,8}$/i, ""),
  );
  if (phrases.length === 0) {
    return {
      status: "insufficient",
      provider: "Wikipedia",
      phrasesSampled: 0,
      phrasesMatched: 0,
      matches: [],
      checkedAt: new Date().toISOString(),
      errorCount: 0,
      referenceSectionRemoved,
      selfMatchesExcluded: 0,
      phrasesWithSelfMatchesExcluded: 0,
      outcomes: { matched: 0, "no-match": 0, throttled: 0, "timed-out": 0, failed: 0 },
    };
  }

  const matches: WebCheckResult["matches"] = [];
  for (let index = 0; index < phrases.length; index += 1) {
    const phrase = phrases[index];
    options.onProgress?.(index + 1, phrases.length, `Checking phrase ${index + 1} of ${phrases.length}`);
    try {
      const url = new URL("https://en.wikipedia.org/w/api.php");
      url.searchParams.set("action", "query");
      url.searchParams.set("list", "search");
      url.searchParams.set("srsearch", `\"${phrase.text}\"`);
      url.searchParams.set("srwhat", "text");
      url.searchParams.set("srnamespace", "0");
      url.searchParams.set("srlimit", "3");
      url.searchParams.set("format", "json");
      url.searchParams.set("origin", "*");
      const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        const outcome: WebPhraseOutcome = response.status === 429
          ? "throttled"
          : [408, 504].includes(response.status) ? "timed-out" : "failed";
        matches.push({
          phrase: phrase.text,
          normalizedPhrase: phrase.normalized,
          wordStart: phrase.wordStart,
          wordEnd: phrase.wordEnd,
          matched: false,
          outcome,
          sources: [],
          excludedSelfSources: [],
          error: `Wikipedia returned ${response.status}.`,
        });
        if (index < phrases.length - 1 && delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        continue;
      }
      const payload = await response.json() as WikipediaResponse;
      const candidates: WebCheckSource[] = (payload.query?.search ?? [])
        .filter((item): item is Required<Pick<WikipediaSearchResult, "pageid" | "title">> => (
          typeof item.pageid === "number" && typeof item.title === "string"
        ))
        .map((item) => ({ title: item.title, pageId: item.pageid, url: articleUrl(item.title) }));
      const excludedSelfSources = normalizedSubmissionTitle
        ? candidates.filter((source) => normalize(source.title) === normalizedSubmissionTitle)
        : [];
      const sources = candidates.filter((source) => !excludedSelfSources.includes(source));
      matches.push({
        phrase: phrase.text,
        normalizedPhrase: phrase.normalized,
        wordStart: phrase.wordStart,
        wordEnd: phrase.wordEnd,
        matched: sources.length > 0,
        outcome: sources.length > 0 ? "matched" : "no-match",
        sources,
        excludedSelfSources,
      });
    } catch (error) {
      const isTimeout = error instanceof DOMException
        && (error.name === "TimeoutError" || error.name === "AbortError");
      matches.push({
        phrase: phrase.text,
        normalizedPhrase: phrase.normalized,
        wordStart: phrase.wordStart,
        wordEnd: phrase.wordEnd,
        matched: false,
        outcome: isTimeout ? "timed-out" : "failed",
        sources: [],
        excludedSelfSources: [],
        error: error instanceof Error ? error.message : "Wikipedia lookup failed.",
      });
    }
    if (index < phrases.length - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const errorCount = matches.filter((match) => Boolean(match.error)).length;
  const selfMatchesExcluded = matches.reduce(
    (total, match) => total + (match.excludedSelfSources?.length ?? 0),
    0,
  );
  const outcomes = matches.reduce<Record<WebPhraseOutcome, number>>((totals, match) => {
    totals[match.outcome ?? (match.matched ? "matched" : "failed")] += 1;
    return totals;
  }, { matched: 0, "no-match": 0, throttled: 0, "timed-out": 0, failed: 0 });
  const incompleteCount = outcomes.throttled + outcomes["timed-out"] + outcomes.failed;
  return {
    status: incompleteCount === matches.length ? "error" : incompleteCount > 0 ? "partial" : "complete",
    provider: "Wikipedia",
    phrasesSampled: matches.length,
    phrasesMatched: matches.filter((match) => match.matched).length,
    matches,
    checkedAt: new Date().toISOString(),
    errorCount,
    referenceSectionRemoved,
    selfMatchesExcluded,
    phrasesWithSelfMatchesExcluded: matches.filter(
      (match) => (match.excludedSelfSources?.length ?? 0) > 0,
    ).length,
    outcomes,
  };
}
