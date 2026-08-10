import { readFileSync, writeFileSync } from "node:fs";

const MANIFEST_PATH = "corpus/manifest.json";
const LEGACY_SOURCE = "user-supplied native corpus.zip";
const CUTOFF = "2022-11";

type Entry = {
  id: string;
  roles: string[];
  language: string | null;
  publishedYear: number | null;
  referenceStatus?: "unverified-population-proxy" | "date-ineligible" | null;
  referenceGroup?: string | null;
  benchmarkAssumption?: string | null;
  benchmarkExclusionReasons?: string[] | null;
  provenance: {
    source?: string | null;
    publicationYearEvidence?: string | null;
    publicationDateValue?: string | null;
    publicationDateEvidence?: string | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

function publicationDate(entry: Entry) {
  if (!Number.isInteger(entry.publishedYear)) {
    throw new Error(`${entry.id}: publishedYear is required for the legacy date split.`);
  }
  const year = Number(entry.publishedYear);
  const evidence = entry.provenance.publicationYearEvidence;
  if (typeof evidence !== "string" || !evidence.trim()) {
    throw new Error(`${entry.id}: publicationYearEvidence is required for the legacy date split.`);
  }
  if (year !== 2022) return { value: String(year), evidence };
  const monthName = Object.keys(MONTHS).find((candidate) => new RegExp(`\\b${candidate}\\b`, "i").test(evidence));
  if (!monthName) {
    throw new Error(`${entry.id}: 2022 row lacks month evidence; it cannot be classified around ${CUTOFF}.`);
  }
  const month = MONTHS[monthName];
  const dayMatch = evidence.match(/\b([0-3]?\d)(?:st|nd|rd|th)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+2022\b/i);
  const day = dayMatch ? Number(dayMatch[1]) : null;
  const value = day
    ? `2022-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    : `2022-${String(month).padStart(2, "0")}`;
  return { value, evidence };
}

function beforeCutoff(value: string) {
  if (value.length === 4) return Number(value) < 2022;
  return value.slice(0, 7) < CUTOFF;
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Entry[];
let eligible = 0;
let ineligible = 0;
for (const entry of manifest) {
  if (!entry.roles.includes("ai-benchmark") || entry.provenance.source !== LEGACY_SOURCE) continue;
  if (entry.language !== "English") throw new Error(`${entry.id}: the legacy English reference batch must remain English.`);
  const date = publicationDate(entry);
  const eligibleForComparison = beforeCutoff(date.value);
  entry.provenance.publicationDateValue = date.value;
  entry.provenance.publicationDateEvidence = date.evidence;
  entry.referenceStatus = eligibleForComparison ? "unverified-population-proxy" : "date-ineligible";
  entry.referenceGroup = eligibleForComparison
    ? "legacy-pre-2022-11-english-reference"
    : "legacy-date-ineligible-post-2022-10";
  entry.benchmarkAssumption = eligibleForComparison
    ? "Published English academic writing dated before November 2022 and supplied as an exploratory human-reference proxy; authorship and first-language status were not independently verified."
    : "Published English academic writing dated November 2022 or later. It may be scored for diagnostics but is excluded from every human-reference comparison distribution.";
  const reasons = new Set(entry.benchmarkExclusionReasons ?? []);
  if (eligibleForComparison) {
    reasons.delete("date-ineligible-post-2022-10");
    eligible += 1;
  } else {
    reasons.add("date-ineligible-post-2022-10");
    ineligible += 1;
  }
  entry.benchmarkExclusionReasons = [...reasons];
}

writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ source: LEGACY_SOURCE, eligibleForComparison: eligible, dateIneligible: ineligible }, null, 2));
