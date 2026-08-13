/**
 * Phase E6A: the source-class vocabulary the Phase E3 design document
 * proposed but never encoded — E3 was a design-only phase, and neither E4
 * nor E5 needed a typed source-class enum (E4's SOURCE_CLASS evidence
 * payload only ever needed a free-form `sourceClass: string`). Discovery
 * candidates DO need one (a discovery provider's result should be
 * classifiable the moment it's found, before any evidence is ever
 * gathered), so it is created here, operationalizing E3's design list
 * exactly.
 *
 * This module does NOT decide eligibility — see lib/provenance-verification-
 * policy.ts (E4) and lib/provenance-verification-workflow.ts (E5) for the
 * only code allowed to make that determination. A candidate's sourceClass
 * here is descriptive only: "what kind of thing did we find," never "is
 * this an acceptable source."
 */

export const SOURCE_CLASSES = [
  "UNKNOWN",
  "JOURNAL_PUBLISHER",
  "INSTITUTIONAL_REPOSITORY",
  "GOVERNMENT",
  "PUBLIC_ARCHIVE",
  "THESIS_REPOSITORY",
  "OFFICIAL_ORGANIZATION",
  "PUBLIC_WEBPAGE",
  "WIKIPEDIA",
  "AGGREGATOR",
  "BLOG",
  "FORUM",
  "SOCIAL_MEDIA",
  "OTHER",
] as const;

export type SourceClass = (typeof SOURCE_CLASSES)[number];

const SOURCE_CLASS_SET: ReadonlySet<string> = new Set(SOURCE_CLASSES);

export function isSourceClass(value: unknown): value is SourceClass {
  return typeof value === "string" && SOURCE_CLASS_SET.has(value);
}
