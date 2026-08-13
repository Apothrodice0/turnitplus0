/**
 * Phase E7D — pure ASJP page-parsing/interface logic. Not part of E1-E6D.
 * No fetch, no fs, no database — every function here takes already-fetched
 * HTML/text and returns structured data, or takes already-structured data
 * and makes a bounded decision. The network-calling side lives in
 * lib/e7-asjp-client.ts, kept separate so this module stays testable with
 * plain string fixtures.
 *
 * Every field/pattern below (the CSRF token field name `_token`, the
 * advanced-search form action and its field names, the `citation_*`
 * meta-tag vocabulary, the `/en/article/{id}` and
 * `/en/downArticle/{journalId}/{volume}/{issue}/{articleId}` URL shapes)
 * was verified against real, live-fetched ASJP pages during E7C/E7D
 * research (via Wayback Machine snapshots, since direct TLS access from
 * this environment fails — see lib/e7-asjp-client.ts's own header) — none
 * of it is guessed.
 */

export const ASJP_ORIGIN = "https://www.asjp.cerist.dz";
export const ASJP_ADVANCED_SEARCH_FORM_URL = `${ASJP_ORIGIN}/en/advancedResearch`;
export const ASJP_ADVANCED_SEARCH_ACTION_URL = `${ASJP_ORIGIN}/en/articleAdvancedResearch`;

/** The advanced-search form's hidden CSRF field, read verbatim from an already-fetched form page. Never hardcoded, never reused across requests. */
export function extractCsrfToken(formHtml: string): string | null {
  const match = formHtml.match(/<input[^>]*name=["']_token["'][^>]*value=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

export type AsjpSearchSignals = {
  /** The single most useful ASJP-searchable signal — see this phase's own task description, section 5: title first. */
  title: string;
  /** Optional secondary journal-name clue; only sent if the caller already resolved a journal name (this pilot does not resolve journal IDs — see the E7D report's "unresolved" section). */
  journalNameHint?: string;
};

/** Builds the POST body for /en/articleAdvancedResearch. Only bounded, already-known-safe fields are ever sent — never full document text. */
export function buildAdvancedSearchRequestBody(token: string, signals: AsjpSearchSignals): URLSearchParams {
  const body = new URLSearchParams();
  body.set("_token", token);
  body.set("titreArticle", signals.title);
  if (signals.journalNameHint) body.set("listeRevue[]", signals.journalNameHint);
  return body;
}

export type AsjpSearchResultCandidate = {
  articleId: string;
  articleUrl: string;
  titleSnippet: string;
};

const ARTICLE_LINK_PATTERN = /<a\s+[^>]*href=["']([^"']*\/en\/article\/(\d+))["'][^>]*>([\s\S]{0,300}?)<\/a>/gi;

/** Parses a results/listing page for article links — verified against a real ASJP article-listing page's actual markup shape (E7C/E7D research), not an assumed one. Bounded: only the anchor's own inner text is kept, never surrounding page content. */
export function parseSearchResultCandidates(resultHtml: string): AsjpSearchResultCandidate[] {
  const matches = [...resultHtml.matchAll(ARTICLE_LINK_PATTERN)];
  return matches.map((m) => ({
    articleId: m[2],
    articleUrl: m[1],
    titleSnippet: m[3].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200),
  }));
}

/** By articleId — a results page can legitimately link the same article more than once (e.g. a thumbnail and a title both linking to it). */
export function deduplicateCandidatesByArticleId(candidates: AsjpSearchResultCandidate[]): AsjpSearchResultCandidate[] {
  const seen = new Set<string>();
  const result: AsjpSearchResultCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.articleId)) continue;
    seen.add(candidate.articleId);
    result.push(candidate);
  }
  return result;
}

export type AsjpArticleMetadata = {
  articleId: string | null;
  title: string | null;
  authors: string[];
  journalTitle: string | null;
  issn: string | null;
  doi: string | null;
  volume: string | null;
  issue: string | null;
  firstPage: string | null;
  lastPage: string | null;
  publicationDate: string | null;
  pdfUrl: string | null;
  abstractUrl: string | null;
};

function metaContent(html: string, name: string): string | null {
  const match = html.match(new RegExp(`<meta\\s+name=["']${name}["'][^>]*content=["']([^"']*)["']`, "i"));
  const value = match ? match[1].trim() : "";
  return value.length > 0 ? value : null;
}

function allMetaContent(html: string, name: string): string[] {
  const pattern = new RegExp(`<meta\\s+name=["']${name}["'][^>]*content=["']([^"']*)["']`, "gi");
  return [...html.matchAll(pattern)].map((m) => m[1].trim()).filter((v) => v.length > 0);
}

/**
 * Parses the standard Google-Scholar-style citation_* meta tags an ASJP
 * article page carries (verified live during E7C — see that phase's own
 * report). Returns null only if the page carries no citation_title at all
 * (i.e. this isn't a real article page), never fabricates a missing field.
 */
export function parseAsjpArticleMetadata(articleHtml: string): AsjpArticleMetadata | null {
  const title = metaContent(articleHtml, "citation_title");
  if (!title) return null;

  const idMatch = articleHtml.match(/\/en\/article\/(\d+)/);
  const pdfUrl = metaContent(articleHtml, "citation_pdf_url");

  return {
    articleId: idMatch ? idMatch[1] : null,
    title,
    authors: allMetaContent(articleHtml, "citation_author"),
    journalTitle: metaContent(articleHtml, "citation_journal_title"),
    issn: metaContent(articleHtml, "citation_issn"),
    doi: metaContent(articleHtml, "citation_doi"),
    volume: metaContent(articleHtml, "citation_volume"),
    issue: metaContent(articleHtml, "citation_issue"),
    firstPage: metaContent(articleHtml, "citation_firstpage"),
    lastPage: metaContent(articleHtml, "citation_lastpage"),
    publicationDate: metaContent(articleHtml, "citation_publication_date"),
    pdfUrl,
    abstractUrl: metaContent(articleHtml, "citation_abstract_html_url"),
  };
}

/**
 * The pilot's actual acceptance gate (this phase's own task description,
 * section 6): a candidate is only useful if its citation_issn matches one
 * of the document's own known ISSNs. Title similarity is never sufficient
 * by itself.
 */
export function issnMatchesExpected(metadata: AsjpArticleMetadata, expectedIssns: string[]): boolean {
  if (!metadata.issn) return false;
  const normalized = metadata.issn.trim().toUpperCase();
  return expectedIssns.some((expected) => expected.trim().toUpperCase() === normalized);
}

/** Deterministic, reproducible: sorted-ascending id order, first N. Reads an already-computed cluster (e.g. from corpus/e7/publication-signal-analysis.json) — never re-derives ISSNs itself. */
export function selectIssnClusterSample(
  documents: Array<{ id: string; issns: string[] }>,
  targetIssn: string,
  sampleSize: number,
): string[] {
  return documents
    .filter((d) => d.issns.includes(targetIssn))
    .map((d) => d.id)
    .sort()
    .slice(0, sampleSize);
}
