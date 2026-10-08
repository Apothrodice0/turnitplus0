import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUNDLE_EXTRACTORS } from "../../lib/corpus-engine/source-adapter";
import { logLine, parseArguments, requireArgument, wordsOf, writeJson } from "./common";

/**
 * Stages United States Federal Register documents (rules, proposed rules,
 * notices, presidential documents) from the Government Publishing Office's
 * bulk-data repository into a JSON-lines bundle.
 *
 *   node --import tsx scripts/corpus-engine/stage-federal-register.ts \
 *     --from 2024-01-01 --to 2024-12-31 --count 16000 \
 *     --downloads D:\...\downloads\federal-register --out D:\...\staging\federal-register.jsonl
 *
 * One XML file per daily issue (https://www.govinfo.gov/bulkdata/FR), a few
 * hundred requests in all; a day with no issue (weekend, federal holiday)
 * answers 404 and is skipped. Issue files are kept in `--downloads`, so a
 * re-run fetches nothing it already has.
 *
 * A document is one RULE / PRORULE / NOTICE / PRESDOCU element. Its identity is
 * the issue date plus its position in the issue (the FR document number is
 * recorded too, but corrections reuse numbers and presidential documents have
 * none). Selection: documents of at least `--min-words` words, ordered by
 * sha256 of the identity, first `--count`. Written sorted by externalId.
 */

const ELEMENT = /<(RULE|PRORULE|NOTICE|PRESDOCU)>[\s\S]*?<\/\1>/g;
const EXTRACTION = "govinfo-fr-xml-text-v1";
const SOURCE_TYPE: Record<string, string> = { RULE: "federal-rule", PRORULE: "federal-proposed-rule", NOTICE: "federal-notice", PRESDOCU: "presidential-document" };

function issueDates(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let day = new Date(`${from}T00:00:00Z`); day <= new Date(`${to}T00:00:00Z`); day = new Date(day.getTime() + 86_400_000)) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) dates.push(day.toISOString().slice(0, 10));
  }
  return dates;
}

async function fetchIssue(date: string, directory: string): Promise<string | null> {
  const file = path.join(directory, `FR-${date}.xml`);
  const absent = path.join(directory, `FR-${date}.absent`);
  if (existsSync(file)) return file;
  if (existsSync(absent)) return null;
  const url = `https://www.govinfo.gov/bulkdata/FR/${date.slice(0, 4)}/${date.slice(5, 7)}/FR-${date}.xml`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: "application/xml" } });
      if (response.status === 404) {
        writeFileSync(absent, "");
        return null;
      }
      if (response.ok) {
        const body = Buffer.from(await response.arrayBuffer());
        if (!body.subarray(0, 200).toString("utf8").includes("<?xml")) throw new Error("not an XML body");
        writeFileSync(`${file}.part`, body);
        // rename only a complete download into place
        renameSync(`${file}.part`, file);
        return file;
      }
      if (attempt >= 6) throw new Error(`HTTP ${response.status} for ${url}`);
    } catch (error) {
      if (attempt >= 6) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
  }
}

function first(element: string, tag: string): string | null {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(element);
  if (!match) return null;
  const text = (BUNDLE_EXTRACTORS[EXTRACTION](match[1]) ?? "").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const from = requireArgument(args, "from");
  const to = requireArgument(args, "to");
  const count = Number(requireArgument(args, "count"));
  const downloads = requireArgument(args, "downloads");
  const out = requireArgument(args, "out");
  const minimumWords = Number(args["min-words"] ?? 150);
  mkdirSync(downloads, { recursive: true });

  const dates = issueDates(from, to);
  const issues: Array<{ date: string; file: string }> = [];
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < dates.length) {
      const date = dates[next];
      next += 1;
      const file = await fetchIssue(date, downloads);
      if (file) issues.push({ date, file });
    }
  }));
  issues.sort((left, right) => (left.date < right.date ? -1 : 1));
  logLine(`${issues.length} issues between ${from} and ${to}`);

  const eligible: Array<{ rank: string; date: string; index: number }> = [];
  const byType: Record<string, number> = {};
  let total = 0;
  const elementsOf = (file: string) => readFileSync(file, "utf8").match(ELEMENT) ?? [];
  for (const issue of issues) {
    elementsOf(issue.file).forEach((element, index) => {
      total += 1;
      const text = BUNDLE_EXTRACTORS[EXTRACTION](element) ?? "";
      if (wordsOf(text).length < minimumWords) return;
      eligible.push({ rank: createHash("sha256").update(`FR-${issue.date}:${index}`).digest("hex"), date: issue.date, index });
    });
  }
  eligible.sort((left, right) => (left.rank < right.rank ? -1 : left.rank > right.rank ? 1 : 0));
  const chosen = new Map<string, Set<number>>();
  for (const item of eligible.slice(0, count)) {
    if (!chosen.has(item.date)) chosen.set(item.date, new Set());
    (chosen.get(item.date) as Set<number>).add(item.index);
  }

  // Rows are streamed in (issue date, element index) order, which is exactly externalId order
  // (`FR-<date>-<4-digit index>`), so the bundle is sorted without holding it in memory.
  const retrievedAt = new Date().toISOString();
  const stream = createWriteStream(out, { encoding: "utf8" });
  let staged = 0;
  for (const issue of issues) {
    const wanted = chosen.get(issue.date);
    if (!wanted) continue;
    const elements = elementsOf(issue.file);
    for (const index of [...wanted].sort((left, right) => left - right)) {
      const element = elements[index];
      const type = /^<([A-Z]+)>/.exec(element)?.[1] ?? "NOTICE";
      byType[type] = (byType[type] ?? 0) + 1;
      const documentNumber = /<FRDOC>\[FR Doc\.\s*([A-Za-z0-9-]+)/.exec(element)?.[1] ?? null;
      const externalId = `FR-${issue.date}-${String(index).padStart(4, "0")}`;
      const line = JSON.stringify({
        provider: "us-gpo-govinfo",
        dataset: "federal-register-bulk-xml",
        datasetVersion: null,
        externalId,
        canonicalUrl: documentNumber && /^\d{4}-\d+$/.test(documentNumber) ? `https://www.federalregister.gov/d/${documentNumber}` : `https://www.govinfo.gov/app/details/FR-${issue.date}`,
        title: first(element, "SUBJECT"),
        authors: first(element, "AGENCY") ? [first(element, "AGENCY") as string] : null,
        publishedDate: issue.date,
        sourceType: SOURCE_TYPE[type] ?? "federal-notice",
        language: "en",
        rights: {
          license: "Public domain (United States Government work)",
          licenseUrl: "https://www.govinfo.gov/about/policies",
          usage: "Federal Register documents are works of the United States Government (17 U.S.C. 105) published by GPO as bulk data for reuse; storing and indexing the text is unrestricted.",
          attribution: `Federal Register, ${issue.date}${documentNumber ? `, FR Doc. ${documentNumber}` : ""}; U.S. Government Publishing Office, govinfo.gov`,
        },
        provenance: {
          acquisitionSource: `https://www.govinfo.gov/bulkdata/FR/${issue.date.slice(0, 4)}/${issue.date.slice(5, 7)}/FR-${issue.date}.xml`,
          retrievedAt,
          sourceVersion: `issue:FR-${issue.date}; element:${type}#${index}; fr-doc:${documentNumber ?? "none"}`,
          notes: `documents of >= ${minimumWords} words ordered by sha256("FR-<date>:<element index>"), first ${count}`,
        },
        extraction: EXTRACTION,
        raw: element,
      });
      staged += 1;
      if (!stream.write(`${line}\n`)) await new Promise<void>((resolve) => stream.once("drain", () => resolve()));
    }
  }
  await new Promise<void>((resolve) => stream.end(() => resolve()));
  writeJson(`${out}.stats.json`, { from, to, issues: issues.length, documentsInIssues: total, eligible: eligible.length, minimumWords, staged, byType, out, retrievedAt });
  logLine(`staged ${staged} of ${eligible.length} eligible (${total} documents in ${issues.length} issues) -> ${out}; ${JSON.stringify(byType)}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
