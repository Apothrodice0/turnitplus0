import { appendFileSync, closeSync, createReadStream, createWriteStream, existsSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { BUNDLE_EXTRACTORS } from "../../lib/corpus-engine/source-adapter";
import { logLine, parseArguments, requireArgument, wordsOf, writeJson } from "./common";

/**
 * Stages openly licensed PubMed Central articles from the NIH/NLM "PMC Article
 * Datasets" open-data bucket (https://registry.opendata.aws/ncbi-pmc) into a
 * JSON-lines bundle.
 *
 *   node --import tsx scripts/corpus-engine/stage-pmc-oa.ts \
 *     --anchors PMC3000000,PMC5000000,PMC7000000 --per-anchor 5000 \
 *     --work D:\...\downloads\pmc --out D:\...\staging\pmc-oa.jsonl
 *
 * The bucket holds, per article version, a metadata JSON (with the licence
 * code) and a plain-text rendering. For each anchor the metadata keys are
 * listed in key order from that accession onward, and an article version is
 * taken only when ALL of these hold — anything else is skipped, never guessed:
 *
 *   is_pmc_openaccess = true, is_retracted = false, is_manuscript = false,
 *   is_historical_ocr = false, license_code is exactly "CC BY" or "CC0",
 *   and the article body has at least `--min-words` words.
 *
 * "CC BY-NC*", "TDM" (text mining only) and a missing licence code are not
 * taken: they do not clearly permit storing the text in a commercial corpus.
 * Only the latest version of an article in a listing page is examined; earlier
 * versions are recorded as SKIP_SUPERSEDED_VERSION, so one article never
 * supplies two near-identical documents.
 *
 * Resumable: every accepted article is appended to `<work>/accepted.jsonl` and
 * every examined key to `<work>/examined.log` as it completes; a re-run skips
 * examined keys. The bundle is written at the end, sorted by externalId.
 */

const BUCKET = "https://pmc-oa-opendata.s3.amazonaws.com";
const ACCEPTED_LICENSES = new Set(["CC BY", "CC0"]);
const EXTRACTION = "pmc-oa-txt-body-v1";

async function get(url: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.text();
      if (response.status === 404) throw Object.assign(new Error("404"), { notFound: true });
      if (attempt >= 6) throw new Error(`HTTP ${response.status} for ${url}`);
    } catch (error) {
      if ((error as { notFound?: boolean }).notFound || attempt >= 6) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
  }
}

async function listMetadataKeys(startAfter: string, maximum: number): Promise<string[]> {
  const body = await get(`${BUCKET}/?list-type=2&max-keys=${maximum}&prefix=metadata/&start-after=${encodeURIComponent(startAfter)}`);
  return [...body.matchAll(/<Key>([^<]+)<\/Key>/g)].map((match) => match[1]);
}

/** `metadata/PMC123.2.json` -> ["PMC123", 2]. */
function articleVersionOf(key: string): [string, number] {
  const match = /^metadata\/(PMC\d+)\.(\d+)\.json$/.exec(key);
  return match ? [match[1], Number(match[2])] : [key, 0];
}

function headerField(raw: string, name: string): string | null {
  const match = new RegExp(`^${name}: (.+)$`, "m").exec(raw.slice(0, 20000));
  return match ? match[1].trim() : null;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const anchors = requireArgument(args, "anchors").split(",");
  const perAnchor = Number(requireArgument(args, "per-anchor"));
  const work = requireArgument(args, "work");
  const out = requireArgument(args, "out");
  const minimumWords = Number(args["min-words"] ?? 500);
  const concurrency = Number(args.concurrency ?? 24);
  mkdirSync(work, { recursive: true });
  const acceptedFile = path.join(work, "accepted.jsonl");
  const examinedFile = path.join(work, "examined.log");

  const examined = new Map<string, string>();
  if (existsSync(examinedFile)) {
    for await (const line of createInterface({ input: createReadStream(examinedFile, { encoding: "utf8" }), crlfDelay: Infinity })) {
      const [key, outcome] = line.split("\t");
      if (key && outcome) examined.set(key, outcome);
    }
  }
  const outcomes: Record<string, number> = {};
  const acceptedPerAnchor: Record<string, number> = {};
  const record = (anchor: string, key: string, outcome: string, replay = false) => {
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    if (outcome === "ACCEPTED") acceptedPerAnchor[anchor] = (acceptedPerAnchor[anchor] ?? 0) + 1;
    if (!replay) {
      examined.set(key, outcome);
      appendFileSync(examinedFile, `${key}\t${outcome}\n`);
    }
  };

  const examine = async (anchor: string, key: string) => {
    const metadata = JSON.parse(await get(`${BUCKET}/${key}`)) as Record<string, unknown>;
    const license = metadata.license_code === null ? "none" : String(metadata.license_code);
    if (metadata.is_pmc_openaccess !== true) return record(anchor, key, "SKIP_NOT_OPEN_ACCESS");
    if (metadata.is_retracted === true) return record(anchor, key, "SKIP_RETRACTED");
    if (metadata.is_manuscript === true) return record(anchor, key, "SKIP_MANUSCRIPT");
    if (metadata.is_historical_ocr === true) return record(anchor, key, "SKIP_HISTORICAL_OCR");
    if (!ACCEPTED_LICENSES.has(license)) return record(anchor, key, `SKIP_LICENSE_${license.replace(/[^A-Za-z0-9]+/g, "_")}`);
    const articleVersion = path.basename(key, ".json");
    let raw: string;
    try {
      raw = await get(`${BUCKET}/${articleVersion}/${articleVersion}.txt`);
    } catch (error) {
      if ((error as { notFound?: boolean }).notFound) return record(anchor, key, "SKIP_NO_TEXT_OBJECT");
      throw error;
    }
    const text = BUNDLE_EXTRACTORS[EXTRACTION](raw);
    if (text === null) return record(anchor, key, "SKIP_UNEXPECTED_TEXT_LAYOUT");
    if (wordsOf(text).length < minimumWords) return record(anchor, key, "SKIP_TOO_SHORT");
    if ((acceptedPerAnchor[anchor] ?? 0) >= perAnchor) return undefined;
    const pmcid = String(metadata.pmcid);
    appendFileSync(acceptedFile, `${JSON.stringify({
      provider: "nih-nlm-pmc",
      dataset: "pmc-article-datasets-oa",
      datasetVersion: null,
      externalId: articleVersion,
      canonicalUrl: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`,
      title: typeof metadata.title === "string" ? metadata.title : null,
      authors: null,
      publishedDate: null,
      sourceType: "scholarly-article",
      language: null,
      rights: {
        license,
        licenseUrl: headerField(raw, "License URL"),
        usage: "PMC Open Access Subset article whose licence code permits reuse including commercial use; storing and indexing the text is permitted with attribution. NLM asks to be acknowledged as the source of the data.",
        attribution: `${typeof metadata.citation === "string" ? metadata.citation : pmcid}. Source: NIH NLM PubMed Central (PMC) Article Datasets, https://registry.opendata.aws/ncbi-pmc`,
      },
      provenance: {
        acquisitionSource: `s3://pmc-oa-opendata/${articleVersion}/${articleVersion}.txt`,
        retrievedAt: new Date().toISOString(),
        sourceVersion: `article-version:${articleVersion}; ${String(metadata.text_url ?? "").split("?")[1] ?? "md5:unknown"}`,
        notes: `anchor=${anchor}; pmid=${String(metadata.pmid ?? "none")}; doi=${String(metadata.doi ?? "none")}`,
      },
      extraction: EXTRACTION,
      raw,
    })}\n`);
    return record(anchor, key, "ACCEPTED");
  };

  // An anchor's accepted count is rebuilt from the log, so a re-run continues instead of over-collecting.
  const anchorOfKey = (key: string) => [...anchors].sort().reverse().find((anchor) => `metadata/${anchor}` <= key) ?? anchors[0];
  for (const [key, outcome] of examined) record(anchorOfKey(key), key, outcome, true);

  for (const anchor of anchors) {
    let cursor = `metadata/${anchor}`;
    while ((acceptedPerAnchor[anchor] ?? 0) < perAnchor) {
      const keys = await listMetadataKeys(cursor, 1000);
      if (keys.length === 0) break;
      cursor = keys[keys.length - 1];
      // One version per article: a key is superseded when the same listing page holds a later version of its PMCID.
      const latestVersion = new Map<string, number>();
      for (const key of keys) {
        const [pmcid, version] = articleVersionOf(key);
        latestVersion.set(pmcid, Math.max(latestVersion.get(pmcid) ?? 0, version));
      }
      for (const key of keys) {
        const [pmcid, version] = articleVersionOf(key);
        if (!examined.has(key) && version < (latestVersion.get(pmcid) as number)) record(anchor, key, "SKIP_SUPERSEDED_VERSION");
      }
      const pending = keys.filter((key) => !examined.has(key));
      let next = 0;
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (next < pending.length && (acceptedPerAnchor[anchor] ?? 0) < perAnchor) {
          const key = pending[next];
          next += 1;
          await examine(anchor, key);
        }
      }));
      logLine(`${anchor}: ${acceptedPerAnchor[anchor] ?? 0} / ${perAnchor} accepted, cursor ${cursor}`);
    }
  }

  // The bundle is assembled by position: only (externalId, offset, length) is held, never the articles.
  const rows: Array<{ externalId: string; offset: number; length: number }> = [];
  const seen = new Set<string>();
  const accepted = openSync(acceptedFile, "r");
  const acceptedBytes = fstatSync(accepted).size;
  const chunk = Buffer.allocUnsafe(8 << 20);
  let lineStart = 0;
  let head = "";
  for (let position = 0; position < acceptedBytes; ) {
    const read = readSync(accepted, chunk, 0, chunk.length, position);
    for (let index = 0; index < read; index += 1) {
      if (head.length < 400 && position + index - lineStart < 400) head += String.fromCharCode(chunk[index]);
      if (chunk[index] !== 0x0a) continue;
      const externalId = /"externalId":"([^"]+)"/.exec(head)?.[1];
      if (externalId && !seen.has(externalId)) {
        seen.add(externalId);
        rows.push({ externalId, offset: lineStart, length: position + index + 1 - lineStart });
      }
      lineStart = position + index + 1;
      head = "";
    }
    position += read;
  }
  rows.sort((left, right) => (left.externalId < right.externalId ? -1 : left.externalId > right.externalId ? 1 : 0));
  const stream = createWriteStream(out);
  for (const row of rows) {
    const line = Buffer.allocUnsafe(row.length);
    readSync(accepted, line, 0, row.length, row.offset);
    if (!stream.write(line)) await new Promise<void>((resolve) => stream.once("drain", () => resolve()));
  }
  await new Promise<void>((resolve) => stream.end(() => resolve()));
  closeSync(accepted);
  // A version split across two listing pages would leave two versions of one article: count them, never hide them.
  const articles = new Set(rows.map((row) => row.externalId.replace(/\.\d+$/, "")));
  writeJson(`${out}.stats.json`, { anchors, perAnchor, minimumWords, acceptedLicenses: [...ACCEPTED_LICENSES], staged: rows.length, distinctArticles: articles.size, articlesWithTwoStagedVersions: rows.length - articles.size, acceptedPerAnchor, outcomes, out });
  logLine(`staged ${rows.length} articles -> ${out}; outcomes ${JSON.stringify(outcomes)}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
