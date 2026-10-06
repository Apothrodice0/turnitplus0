import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { logLine, parseArguments, requireArgument } from "./common";

/**
 * Stages a SMALL, bounded set of featured Wikipedia articles in one language
 * as plain-text files plus a manifest the LocalFixtureSourceAdapter reads.
 *
 *   node --import tsx scripts/corpus-engine/stage-wikipedia-featured.ts \
 *     --language fr --count 150 --out D:\TurnitPlusTemp\corpus-engine-v1\staging\wikipedia-fr
 *
 * Why it exists: the 10k checkpoint must exercise French and Arabic, and no
 * safe local French/Arabic corpus material exists (the Archive's sources are
 * also evaluation submissions). Wikipedia text is CC BY-SA 4.0. This is a
 * staging step, not a provider integration: it writes local files, and the
 * engine then consumes them through the ordinary local-file adapter.
 *
 * Deterministic selection: the featured-article category in sort-key order,
 * first `count` pages. Every row records the page id, the revision id and its
 * timestamp, the URL and the retrieval instant, so the exact content is
 * identifiable later.
 *
 * Polite and resumable: one request at a time with a pause between requests,
 * HTTP 429 / 503 honoured with the server's Retry-After, and each page's
 * manifest row appended as soon as its text is on disk — so an interrupted run
 * continues where it stopped and never leaves a text file without its row.
 */

const FEATURED_CATEGORY: Record<string, string> = {
  fr: "Catégorie:Article de qualité",
  ar: "تصنيف:مقالات مختارة",
};
const USER_AGENT = "TurnitPlusCorpusEngineCheckpoint/0.1 (local engineering benchmark; bounded fetch)";
const EXTRACTION_VERSION = "mediawiki-textextracts-explaintext-v1";

async function api(language: string, parameters: Record<string, string>): Promise<Record<string, unknown>> {
  const url = new URL(`https://${language}.wikipedia.org/w/api.php`);
  for (const [key, value] of Object.entries({ format: "json", formatversion: "2", ...parameters })) url.searchParams.set(key, value);
  url.searchParams.set("maxlag", "5");
  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
    } catch (error) {
      // A dropped connection is as retryable as a 429.
      if (attempt >= 7) throw error;
      logLine(`${language}: network error (${error instanceof Error ? error.message : String(error)}); waiting 20 s (attempt ${attempt})`);
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      continue;
    }
    if (response.ok) return (await response.json()) as Record<string, unknown>;
    if (attempt >= 7) throw new Error(`MediaWiki API ${response.status} for ${url.pathname}?${url.searchParams.get("action")}`);
    const retryAfter = Number(response.headers.get("retry-after"));
    const waitSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 120) : Math.min(15 * 2 ** (attempt - 1), 120);
    logLine(`${language}: HTTP ${response.status}; waiting ${waitSeconds} s (attempt ${attempt})`);
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const language = requireArgument(args, "language");
  const count = Number(requireArgument(args, "count"));
  const outputDirectory = requireArgument(args, "out");
  const category = FEATURED_CATEGORY[language];
  if (!category) throw new Error(`no featured-article category configured for language ${language}`);
  if (!Number.isInteger(count) || count < 1 || count > 400) throw new Error("--count must be 1..400 (this is a bounded staging fetch)");
  const pauseMs = args["pause-ms"] ? Number(args["pause-ms"]) : 1500;

  mkdirSync(path.join(outputDirectory, "text"), { recursive: true });
  const manifestFile = path.join(outputDirectory, "manifest.jsonl");
  const staged = new Map<string, Record<string, unknown>>();
  if (existsSync(manifestFile)) {
    for (const line of readFileSync(manifestFile, "utf8").split("\n").filter(Boolean)) {
      const row = JSON.parse(line) as Record<string, unknown>;
      staged.set(String(row.externalId), row);
    }
  }

  const members: Array<{ pageid: number; title: string }> = [];
  let continuation: string | undefined;
  while (members.length < count * 2) {
    const page = await api(language, {
      action: "query", list: "categorymembers", cmtitle: category, cmnamespace: "0", cmlimit: "200", cmsort: "sortkey",
      ...(continuation ? { cmcontinue: continuation } : {}),
    });
    members.push(...((page.query as { categorymembers: Array<{ pageid: number; title: string }> }).categorymembers));
    continuation = (page.continue as { cmcontinue?: string } | undefined)?.cmcontinue;
    if (!continuation) break;
  }
  logLine(`${language}: ${members.length} featured articles listed; staging up to ${count}`);

  let fetched = 0;
  for (const member of members) {
    if (staged.size >= count) break;
    const externalId = `${language}wiki-${member.pageid}`;
    if (staged.has(externalId)) continue;
    const page = await api(language, {
      action: "query", pageids: String(member.pageid), prop: "extracts|revisions|info", explaintext: "1", exsectionformat: "plain",
      rvprop: "ids|timestamp", inprop: "url",
    });
    if (!page.query) {
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
      continue; // a lagged or empty reply: skip this page rather than guess
    }
    const detail = (page.query as { pages: Array<Record<string, unknown>> }).pages[0];
    const text = typeof detail.extract === "string" ? detail.extract : "";
    const revision = (detail.revisions as Array<{ revid: number; timestamp: string }> | undefined)?.[0];
    if (text.length < 4000 || !revision) continue; // too short to be useful, or no revision recorded
    const textPath = `text/${externalId}.txt`;
    writeFileSync(path.join(outputDirectory, textPath), text, "utf8");
    const row = {
      provider: `${language}.wikipedia.org`,
      dataset: `wikipedia-${language}-featured-checkpoint`,
      datasetVersion: "corpus-engine-v1-10k",
      externalId,
      textPath,
      canonicalUrl: typeof detail.canonicalurl === "string" ? detail.canonicalurl : null,
      title: member.title,
      sourceType: "encyclopedia-article",
      language,
      rights: { license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/", usage: null, attribution: null },
      provenance: {
        acquisitionSource: `${language}.wikipedia.org:action=query&prop=extracts&explaintext`,
        retrievedAt: new Date().toISOString(),
        sourceVersion: `revid:${revision.revid}`,
        notes: `pageid=${member.pageid}; revisionTimestamp=${revision.timestamp}; category=${category}`,
      },
      extractionVersion: EXTRACTION_VERSION,
      syntheticLoadOnly: false,
    };
    staged.set(externalId, row);
    appendFileSync(manifestFile, `${JSON.stringify(row)}\n`);
    fetched += 1;
    if (fetched % 25 === 0) logLine(`${language}: ${staged.size}/${count} staged`);
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  logLine(`${language}: done — ${staged.size} articles staged in ${outputDirectory}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
