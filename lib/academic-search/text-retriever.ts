import { createHttpContentRetriever } from "../http-content-retriever";
import type { RetrievalStatus, SourceContentRetriever } from "../retrieval-types";
import type { AcademicSearchProvider } from "./provider";
import type { AcademicSearchCandidate } from "./types";

/**
 * Stage 6 of the pipeline: obtains whatever text is available for a ranked
 * candidate. Tries the cheapest path first — asking the contributing
 * provider(s) directly via getText(), which for a provider like CORE can
 * mean an already-extracted fullText field with no extra network hop — and
 * only falls back to fetching the candidate's own URL when no provider
 * could supply text. The HTTP fallback reuses lib/http-content-retriever.ts
 * as-is (SSRF-safe, timeout-bounded, size-capped) rather than reimplementing
 * retrieval; see this directory's types.ts header comment.
 *
 * Never throws: a provider's getText() failing, or the HTTP fallback
 * returning any non-SUCCESS lib/retrieval-types.ts status, both resolve to
 * `text: null` / `source: "unavailable"` rather than propagating — text
 * unavailability is a normal, expected outcome (STEP 7's "unavailable full
 * text" case), not a pipeline failure.
 */

export type TextRetrievalResult = {
  text: string | null;
  source: "provider" | "http-fallback" | "unavailable";
  /** Which provider actually supplied the text, when source is "provider". */
  providerId: string | null;
  latencyMs: number;
  /** Only set when source is "http-fallback" or the fallback was attempted and failed. */
  httpRetrievalStatus?: RetrievalStatus;
};

export async function retrieveCandidateText(
  candidate: AcademicSearchCandidate,
  providers: Record<string, AcademicSearchProvider>,
  contentRetriever: SourceContentRetriever = createHttpContentRetriever(),
): Promise<TextRetrievalResult> {
  const start = Date.now();

  for (const contributor of candidate.contributors) {
    const provider = providers[contributor.providerId];
    if (!provider?.getText) continue;
    try {
      const text = await provider.getText(contributor.externalId);
      if (text && text.trim()) {
        return { text, source: "provider", providerId: contributor.providerId, latencyMs: Date.now() - start };
      }
    } catch {
      // Not fatal: fall through to the next contributing provider, or the HTTP fallback below.
    }
  }

  if (candidate.url) {
    const retrieved = await contentRetriever.retrieve({ url: candidate.url });
    if (retrieved.status === "SUCCESS" && retrieved.extractedText) {
      return {
        text: retrieved.extractedText,
        source: "http-fallback",
        providerId: null,
        latencyMs: Date.now() - start,
        httpRetrievalStatus: retrieved.status,
      };
    }
    return { text: null, source: "unavailable", providerId: null, latencyMs: Date.now() - start, httpRetrievalStatus: retrieved.status };
  }

  return { text: null, source: "unavailable", providerId: null, latencyMs: Date.now() - start };
}
