/**
 * Phase E7D — ASJP network transport + pilot orchestrator. Not part of
 * E1-E6D, not registered in lib/source-discovery-registries.ts, not
 * reachable from lib/source-discovery-workflow.ts — this is a standalone
 * pilot, exactly like lib/e7-observation.ts is for the Crossref/E6D path.
 *
 * TLS safety (this phase's own task description, section 3 and test L):
 * this file never sets `rejectUnauthorized: false`, never references
 * `NODE_TLS_REJECT_UNAUTHORIZED`, and never constructs a custom
 * https.Agent that weakens certificate validation. Every fetch() call
 * uses Node's default, fully-verified TLS behavior. A verification
 * failure (observed live against asjp.cerist.dz during E7C/E7D research:
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE`) is caught and classified as a
 * transport failure, never retried, never bypassed.
 *
 * Correspondence reuses lib/document-correspondence.ts's
 * computeDocumentCorrespondence unmodified — no new similarity algorithm.
 * PDF text extraction reuses lib/pdf-text-extraction.ts's
 * extractPdfTextDocument unmodified (the same shared PDF text-layer
 * contract tools/reextract-ai-negatives-pdfjs.ts already uses), wired to
 * pdfjs-dist exactly as that existing tool already does.
 *
 * This module never imports lib/provenance-verification-workflow.ts and
 * never creates a VERIFIED_SOURCE — see tests/e7-asjp-client.test.mjs's
 * structural checks (mirroring every prior E7 phase's own convention).
 */
import { extractPdfTextDocument } from "./pdf-text-extraction";
import { ensurePdfjsNodePolyfills } from "./pdfjs-node-polyfill";
import { computeDocumentCorrespondence, DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS, type DocumentCorrespondenceResult } from "./document-correspondence";
import {
  ASJP_ADVANCED_SEARCH_ACTION_URL,
  ASJP_ADVANCED_SEARCH_FORM_URL,
  extractCsrfToken,
  parseSearchResultCandidates,
  deduplicateCandidatesByArticleId,
  parseAsjpArticleMetadata,
  issnMatchesExpected,
  buildAdvancedSearchRequestBody,
  type AsjpSearchSignals,
  type AsjpArticleMetadata,
} from "./e7-asjp-interface";

const USER_AGENT = "TurnitPlus-E7D-AsjpPilot/1.0 (bounded research pilot; no mailto configured)";
const REQUEST_TIMEOUT_MS = 10_000;
const MIN_USABLE_EXTRACTED_TEXT_LENGTH = 200;
export const MAX_CANDIDATES_CHECKED_PER_DOCUMENT = 5;

export type AsjpTransportResult<T> = { ok: true; value: T } | { ok: false; errorClassification: string };

export interface AsjpTransport {
  fetchSearchForm(): Promise<AsjpTransportResult<{ html: string }>>;
  submitAdvancedSearch(token: string, body: URLSearchParams): Promise<AsjpTransportResult<{ html: string }>>;
  fetchArticlePage(url: string): Promise<AsjpTransportResult<{ html: string }>>;
  fetchPdf(url: string): Promise<AsjpTransportResult<{ bytes: Uint8Array; contentType: string | null; httpStatus: number }>>;
}

function classifyFetchError(error: unknown): string {
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const causeCode = cause && typeof cause === "object" && "code" in cause ? String((cause as { code: unknown }).code) : null;
  if (causeCode === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || causeCode === "CERT_HAS_EXPIRED" || causeCode === "DEPTH_ZERO_SELF_SIGNED_CERT") {
    return `TLS_CERTIFICATE_VERIFICATION_FAILED: ${causeCode}`;
  }
  if (error instanceof Error && error.name === "AbortError") return "TIMEOUT";
  return `NETWORK_ERROR: ${error instanceof Error ? error.message : String(error)}`;
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The real, network-calling transport. Standard TLS validation only — see
 * this file's own header comment. Exactly one request per method call;
 * callers (runAsjpDiscoveryForDocument) are responsible for the "one
 * search submission per document" and "bounded candidates" budgets.
 */
export function createLiveAsjpTransport(): AsjpTransport {
  return {
    async fetchSearchForm() {
      try {
        const response = await timedFetch(ASJP_ADVANCED_SEARCH_FORM_URL, { method: "GET", headers: { "User-Agent": USER_AGENT } });
        if (!response.ok) return { ok: false, errorClassification: `HTTP_ERROR_${response.status}` };
        return { ok: true, value: { html: await response.text() } };
      } catch (error) {
        return { ok: false, errorClassification: classifyFetchError(error) };
      }
    },
    async submitAdvancedSearch(token, body) {
      try {
        const response = await timedFetch(ASJP_ADVANCED_SEARCH_ACTION_URL, {
          method: "POST",
          headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded", "X-CSRF-TOKEN": token },
          body: body.toString(),
        });
        if (!response.ok) return { ok: false, errorClassification: `HTTP_ERROR_${response.status}` };
        return { ok: true, value: { html: await response.text() } };
      } catch (error) {
        return { ok: false, errorClassification: classifyFetchError(error) };
      }
    },
    async fetchArticlePage(url) {
      try {
        const response = await timedFetch(url, { method: "GET", headers: { "User-Agent": USER_AGENT } });
        if (!response.ok) return { ok: false, errorClassification: `HTTP_ERROR_${response.status}` };
        return { ok: true, value: { html: await response.text() } };
      } catch (error) {
        return { ok: false, errorClassification: classifyFetchError(error) };
      }
    },
    async fetchPdf(url) {
      try {
        const response = await timedFetch(url, { method: "GET", headers: { "User-Agent": USER_AGENT } });
        if (!response.ok) return { ok: false, errorClassification: `HTTP_ERROR_${response.status}` };
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { ok: true, value: { bytes, contentType: response.headers.get("content-type"), httpStatus: response.status } };
      } catch (error) {
        return { ok: false, errorClassification: classifyFetchError(error) };
      }
    },
  };
}

/** Reuses lib/pdf-text-extraction.ts's shared contract — the same one tools/reextract-ai-negatives-pdfjs.ts already uses. */
export async function extractTextFromPdfBytes(bytes: Uint8Array): Promise<string> {
  await ensurePdfjsNodePolyfills();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: bytes }).promise;
  return extractPdfTextDocument(document);
}

export const ASJP_PILOT_CLASSIFICATIONS = [
  "ASJP_MATCH_CONFIRMED",
  "ASJP_CANDIDATE_NO_TEXT",
  "ASJP_CANDIDATE_UNRELATED",
  "ASJP_ISSN_MISMATCH",
  "ASJP_SEARCH_NO_RESULT",
  "ASJP_SEARCH_FAILED",
  "ASJP_PDF_UNAVAILABLE",
  "ASJP_PDF_EXTRACTION_FAILED",
  "ASJP_CORRESPONDENCE_WEAK",
] as const;
export type AsjpPilotClassification = (typeof ASJP_PILOT_CLASSIFICATIONS)[number];

// Most-informative-first — see lib/e7-observation.ts's summarizeDocumentE7Outcome
// for why this must be a priority rank, not "first candidate processed":
// a later candidate reaching a stronger outcome must never be masked by an
// earlier, weaker one.
const CANDIDATE_OUTCOME_RANK: AsjpPilotClassification[] = [
  "ASJP_MATCH_CONFIRMED",
  "ASJP_CORRESPONDENCE_WEAK",
  "ASJP_CANDIDATE_UNRELATED",
  "ASJP_CANDIDATE_NO_TEXT",
  "ASJP_PDF_EXTRACTION_FAILED",
  "ASJP_PDF_UNAVAILABLE",
  "ASJP_ISSN_MISMATCH",
];

export type AsjpCandidateOutcome = {
  articleId: string;
  articleUrl: string;
  metadata: AsjpArticleMetadata | null;
  classification: AsjpPilotClassification;
  correspondence: DocumentCorrespondenceResult | null;
  detail: string | null;
};

export type AsjpDocumentPilotResult = {
  documentId: string;
  expectedIssns: string[];
  searchSignalsUsed: AsjpSearchSignals;
  requestCount: number;
  candidatesFound: number;
  candidatesChecked: number;
  candidateOutcomes: AsjpCandidateOutcome[];
  documentClassification: AsjpPilotClassification | "ASJP_SEARCH_NO_RESULT" | "ASJP_SEARCH_FAILED";
  failureDetail: string | null;
};

/**
 * The full search -> candidate -> ISSN-check -> retrieve -> extract ->
 * correspond pipeline for exactly one document. Exactly one search
 * submission (this phase's own task description, section 16); candidates
 * are checked in result order up to MAX_CANDIDATES_CHECKED_PER_DOCUMENT,
 * and only ISSN-matching candidates are ever retrieved (PDF fetch/extract
 * only happens after a passing ISSN check).
 */
export async function runAsjpDiscoveryForDocument(
  transport: AsjpTransport,
  params: { documentId: string; expectedIssns: string[]; searchSignals: AsjpSearchSignals; submittedText: string },
): Promise<AsjpDocumentPilotResult> {
  let requestCount = 0;

  const formResult = await transport.fetchSearchForm();
  requestCount += 1;
  if (!formResult.ok) {
    return {
      documentId: params.documentId, expectedIssns: params.expectedIssns, searchSignalsUsed: params.searchSignals,
      requestCount, candidatesFound: 0, candidatesChecked: 0, candidateOutcomes: [],
      documentClassification: "ASJP_SEARCH_FAILED", failureDetail: formResult.errorClassification,
    };
  }

  const token = extractCsrfToken(formResult.value.html);
  if (!token) {
    return {
      documentId: params.documentId, expectedIssns: params.expectedIssns, searchSignalsUsed: params.searchSignals,
      requestCount, candidatesFound: 0, candidatesChecked: 0, candidateOutcomes: [],
      documentClassification: "ASJP_SEARCH_FAILED", failureDetail: "no CSRF token found in search form page",
    };
  }

  const searchBody = buildAdvancedSearchRequestBody(token, params.searchSignals);
  const searchResult = await transport.submitAdvancedSearch(token, searchBody);
  requestCount += 1;
  if (!searchResult.ok) {
    return {
      documentId: params.documentId, expectedIssns: params.expectedIssns, searchSignalsUsed: params.searchSignals,
      requestCount, candidatesFound: 0, candidatesChecked: 0, candidateOutcomes: [],
      documentClassification: "ASJP_SEARCH_FAILED", failureDetail: searchResult.errorClassification,
    };
  }

  const allCandidates = deduplicateCandidatesByArticleId(parseSearchResultCandidates(searchResult.value.html));
  if (allCandidates.length === 0) {
    return {
      documentId: params.documentId, expectedIssns: params.expectedIssns, searchSignalsUsed: params.searchSignals,
      requestCount, candidatesFound: 0, candidatesChecked: 0, candidateOutcomes: [],
      documentClassification: "ASJP_SEARCH_NO_RESULT", failureDetail: null,
    };
  }

  const candidatesToCheck = allCandidates.slice(0, MAX_CANDIDATES_CHECKED_PER_DOCUMENT);
  const candidateOutcomes: AsjpCandidateOutcome[] = [];

  for (const candidate of candidatesToCheck) {
    const articleResult = await transport.fetchArticlePage(candidate.articleUrl);
    requestCount += 1;
    if (!articleResult.ok) {
      candidateOutcomes.push({ articleId: candidate.articleId, articleUrl: candidate.articleUrl, metadata: null, classification: "ASJP_ISSN_MISMATCH", correspondence: null, detail: `article page fetch failed: ${articleResult.errorClassification}` });
      continue;
    }

    const metadata = parseAsjpArticleMetadata(articleResult.value.html);
    if (!metadata || !issnMatchesExpected(metadata, params.expectedIssns)) {
      candidateOutcomes.push({ articleId: candidate.articleId, articleUrl: candidate.articleUrl, metadata, classification: "ASJP_ISSN_MISMATCH", correspondence: null, detail: metadata ? `citation_issn "${metadata.issn}" not in expected set` : "no citation_title/metadata found on page" });
      continue;
    }

    if (!metadata.pdfUrl) {
      candidateOutcomes.push({ articleId: candidate.articleId, articleUrl: candidate.articleUrl, metadata, classification: "ASJP_PDF_UNAVAILABLE", correspondence: null, detail: "ISSN matched but no citation_pdf_url present" });
      continue;
    }

    const pdfResult = await transport.fetchPdf(metadata.pdfUrl);
    requestCount += 1;
    if (!pdfResult.ok) {
      candidateOutcomes.push({ articleId: candidate.articleId, articleUrl: candidate.articleUrl, metadata, classification: "ASJP_PDF_UNAVAILABLE", correspondence: null, detail: pdfResult.errorClassification });
      continue;
    }

    let extractedText: string;
    try {
      extractedText = await extractTextFromPdfBytes(pdfResult.value.bytes);
    } catch (error) {
      candidateOutcomes.push({ articleId: candidate.articleId, articleUrl: candidate.articleUrl, metadata, classification: "ASJP_PDF_EXTRACTION_FAILED", correspondence: null, detail: error instanceof Error ? error.message : String(error) });
      continue;
    }

    if (extractedText.trim().length < MIN_USABLE_EXTRACTED_TEXT_LENGTH) {
      candidateOutcomes.push({ articleId: candidate.articleId, articleUrl: candidate.articleUrl, metadata, classification: "ASJP_CANDIDATE_NO_TEXT", correspondence: null, detail: `extracted only ${extractedText.trim().length} usable characters` });
      continue;
    }

    // The correspondence step is entirely local (lib/document-correspondence.ts,
    // pure/no I/O) — params.submittedText never reaches the transport layer
    // or any network call; it is only ever compared here, in memory.
    const { correspondence, classification } = classifyAsjpCorrespondence(params.submittedText, extractedText);
    candidateOutcomes.push({ articleId: candidate.articleId, articleUrl: candidate.articleUrl, metadata, classification, correspondence, detail: null });
  }

  const documentClassification = pickBestOutcome(candidateOutcomes);
  return {
    documentId: params.documentId, expectedIssns: params.expectedIssns, searchSignalsUsed: params.searchSignals,
    requestCount, candidatesFound: allCandidates.length, candidatesChecked: candidateOutcomes.length,
    candidateOutcomes, documentClassification, failureDetail: null,
  };
}

function pickBestOutcome(outcomes: AsjpCandidateOutcome[]): AsjpPilotClassification {
  for (const rank of CANDIDATE_OUTCOME_RANK) {
    if (outcomes.some((o) => o.classification === rank)) return rank;
  }
  return outcomes[0]?.classification ?? "ASJP_ISSN_MISMATCH";
}

/** Applies the correspondence step (E6C's own engine, unmodified) once a PDF's text has already been extracted. Kept separate from runAsjpDiscoveryForDocument so the pilot's own submittedText is only ever passed here, never through the transport layer. */
export function classifyAsjpCorrespondence(submittedText: string, extractedArticleText: string) {
  const correspondence = computeDocumentCorrespondence(submittedText, extractedArticleText, DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS);
  const classification: AsjpPilotClassification =
    correspondence.exactCanonicalMatch || correspondence.strongCorrespondence
      ? "ASJP_MATCH_CONFIRMED"
      : correspondence.matchedWordCount === 0
        ? "ASJP_CANDIDATE_UNRELATED"
        : "ASJP_CORRESPONDENCE_WEAK";
  return { correspondence, classification };
}
