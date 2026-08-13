/**
 * E7B — pure, local, bounded publication-signal extraction.
 *
 * Not part of E1-E6D or E6A discovery. This module never makes a network
 * call and never returns full document text — only short, bounded matches
 * (an ISSN string, a DOI string, an already-short journal-name-shaped
 * phrase capped at MAX_HINT_LENGTH) extracted from an already-resolved
 * document's text, the same "bounded passages, not full text" discipline
 * lib/document-correspondence.ts and lib/discovery-signals.ts already use.
 *
 * Purpose: distinguish, using only text already present in the document
 * itself, documents that carry a plausible external-publication signal
 * (an ISSN/DOI/journal masthead — evidence the PDF that was run through
 * Turnitin already carried a journal's own typesetting) from documents
 * that show no such signal at all (more likely a raw, never-separately-
 * published thesis/manuscript). This is descriptive triage, not proof of
 * publication and not a provenance decision — see E7OutcomeClass /
 * lib/provenance-verification-policy.ts for the actual verification gate,
 * which this module does not touch.
 */

const MAX_HINT_LENGTH = 70;
const MAX_HINTS = 5;

function normalizeIssn(raw: string): string {
  const digits = raw.replace(/[^0-9Xx]/g, "").toUpperCase();
  return `${digits.slice(0, 4)}-${digits.slice(4, 8)}`;
}

const LABELLED_ISSN_PATTERN = /\bE?-?ISSN\b[\s:.-]*([0-9]{4}[\s-]?[0-9]{3}[0-9Xx])/gi;
const BARE_ISSN_SHAPE_PATTERN = /\b([0-9]{4}-[0-9]{3}[0-9Xx])\b/g;
const DOI_PATTERN = /\b10\.\d{4,9}\/[^\s"'<>)]+/gi;
const ASJP_MENTION_PATTERN = /\basjp\b|cerist\.dz|asjp\.cerist\.dz/gi;
// Deliberately conservative: only phrases that look like an actual
// masthead/journal-title line, not any sentence containing the word
// "journal" (e.g. "in the Journal of Sport Science" inside a citation is
// excluded on purpose — see JOURNAL_NAME_PATTERN's word-count cap).
const JOURNAL_NAME_PATTERN = /\b((?:[A-Z][a-zA-Z'-]*\s){0,4}(?:Journal|Revue|Review)\s(?:of|des|de|d')\s(?:[A-Z][a-zA-Z'-]*\s?){1,5})/g;
const ARABIC_JOURNAL_PATTERN = /مجلة\s[؀-ۿ\s]{2,30}/g;

export type PublicationSignalStrength = "STRONG" | "WEAK" | "NONE";

export type PublicationSignals = {
  issns: string[];
  bareIssnShapedHits: string[];
  dois: string[];
  journalNameHints: string[];
  asjpMentioned: boolean;
  strength: PublicationSignalStrength;
};

function dedupeBounded(values: string[], max: number): string[] {
  return [...new Set(values)].slice(0, max);
}

/** Pure. No I/O. Input is a document's already-resolved text; output never echoes more than MAX_HINT_LENGTH chars of it per hint, and only MAX_HINTS hints total. */
export function extractPublicationSignals(text: string): PublicationSignals {
  const labelledIssns = [...text.matchAll(LABELLED_ISSN_PATTERN)].map((m) => normalizeIssn(m[1]));
  const bareIssnShaped = [...text.matchAll(BARE_ISSN_SHAPE_PATTERN)].map((m) => normalizeIssn(m[1]));
  const dois = [...text.matchAll(DOI_PATTERN)].map((m) => m[0].replace(/[.,;]+$/, ""));
  const asjpMentioned = ASJP_MENTION_PATTERN.test(text);

  const journalHints = [
    ...[...text.matchAll(JOURNAL_NAME_PATTERN)].map((m) => m[0].trim()),
    ...[...text.matchAll(ARABIC_JOURNAL_PATTERN)].map((m) => m[0].trim()),
  ].map((hint) => (hint.length > MAX_HINT_LENGTH ? `${hint.slice(0, MAX_HINT_LENGTH)}…` : hint));

  const issns = dedupeBounded(labelledIssns, MAX_HINTS);
  const bareIssnShapedHits = dedupeBounded(
    bareIssnShaped.filter((v) => !issns.includes(v)),
    MAX_HINTS,
  );
  const journalNameHints = dedupeBounded(journalHints, MAX_HINTS);
  const dedupedDois = dedupeBounded(dois, MAX_HINTS);

  let strength: PublicationSignalStrength = "NONE";
  if (issns.length > 0 || dedupedDois.length > 0) strength = "STRONG";
  else if (bareIssnShapedHits.length > 0 || journalNameHints.length > 0 || asjpMentioned) strength = "WEAK";

  return { issns, bareIssnShapedHits, dois: dedupedDois, journalNameHints, asjpMentioned, strength };
}
