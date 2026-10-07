import { computeQueryFingerprints, normalizeForCorpus } from "../../lib/corpus-engine/fingerprints";
import { docIdFromDecimal, fingerprintFromHex } from "../../lib/corpus-engine/ids";
import { openGeneration, type BenchmarkQuery, type CatalogEntry } from "./benchmark-common";
import { logLine, parseArguments, percentile, readJson, requireArgument, writeJson } from "./common";

/**
 * COMMON-TEXT CONTROLS: submissions made of original prose with the corpus's
 * own most widely held passages dropped in.
 *
 *   build-common-text-controls.ts --root R --generation G --catalog catalog.json --queries queries.json --out controls.json
 *                                 [--sample 400] [--passages 4] [--passage-words 80]
 *
 * A known-source benchmark cannot say whether a family rule lets common text
 * through, because every passage in it was copied from somewhere on purpose.
 * These controls ask the opposite question. For each dataset of the corpus, a
 * deterministic sample of its documents is scanned for the stretches whose
 * fingerprints are held by the most documents (ranked by the MEDIAN document
 * frequency of the stretch's fingerprints, from the generation's own df
 * artifact), and the most widely held ones are placed inside the benchmark's
 * existing nothing-copied prose of the same language.
 *
 * The selection uses the generation and nothing else: no query of the
 * known-source benchmark, no admission policy, no label. What each policy then
 * does with these controls is measured by compare-family-policies.ts.
 */

type Stretch = { docId: string; start: number; words: string[]; medianDf: number; minimumDf: number; fingerprints: string[] };

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const sampleSize = Number(args.sample ?? 400);
  const passagesPerControl = Number(args.passages ?? 4);
  const passageWords = Number(args["passage-words"] ?? 80);
  const { queries } = readJson<{ queries: BenchmarkQuery[] }>(requireArgument(args, "queries"));
  const entries = readJson<{ catalog: CatalogEntry[] }>(requireArgument(args, "catalog")).catalog.filter((entry) => !entry.syntheticLoadOnly);
  const { store, reader } = await openGeneration(requireArgument(args, "root"), requireArgument(args, "generation"));
  if (!reader.highDf) throw new Error(`document-frequency artifact unavailable: ${reader.highDfFailure}`);
  const highDf = reader.highDf;
  try {
    const hostOf = (language: string) => {
      const host = queries.find((query) => query.expectation === "negative" && query.language === language && query.intendedSources.length === 0);
      if (!host) throw new Error(`the query file has no nothing-copied submission in ${language}`);
      return host;
    };
    const byDataset = new Map<string, CatalogEntry[]>();
    for (const entry of entries) {
      const list = byDataset.get(entry.dataset) ?? [];
      list.push(entry);
      byDataset.set(entry.dataset, list);
    }
    const controls: BenchmarkQuery[] = [];
    const selections: Array<Record<string, unknown>> = [];
    for (const [dataset, documents] of [...byDataset.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1))) {
      if (documents.length < 1000) continue;
      documents.sort((left, right) => (left.docId.length - right.docId.length) || (left.docId < right.docId ? -1 : 1));
      const step = Math.max(1, Math.floor(documents.length / sampleSize));
      const stretches: Stretch[] = [];
      for (let index = 0; index < documents.length && stretches.length < sampleSize * 50; index += step) {
        const entry = documents[index];
        const fetched = await reader.fetchText(docIdFromDecimal(entry.docId));
        if (fetched.state !== "OK") continue;
        const words = normalizeForCorpus(fetched.text).tokens;
        const selected = computeQueryFingerprints(fetched.text, 200).fingerprints
          .flatMap((fingerprint) => fingerprint.positions.map((position) => ({ position, hex: fingerprint.hex, df: highDf.get(fingerprintFromHex(fingerprint.hex)) })))
          .sort((left, right) => left.position - right.position);
        // the best stretch of this document: the passageWords-wide window with the highest median df
        let best: Stretch | null = null;
        let low = 0;
        for (let high = 0; high < selected.length; high += 1) {
          while (selected[high].position - selected[low].position > passageWords - 5) low += 1;
          const window = selected.slice(low, high + 1);
          if (window.length < 5) continue;
          const dfs = window.map((item) => item.df);
          const medianDf = percentile(dfs, 0.5);
          if (!best || medianDf > best.medianDf) {
            const start = Math.max(0, Math.min(window[0].position, words.length - passageWords));
            best = { docId: entry.docId, start, words: words.slice(start, start + passageWords), medianDf, minimumDf: Math.min(...dfs), fingerprints: window.map((item) => item.hex) };
          }
        }
        if (best && best.words.length === passageWords) stretches.push(best);
      }
      stretches.sort((left, right) => right.medianDf - left.medianDf || right.minimumDf - left.minimumDf || (left.docId < right.docId ? -1 : 1));
      const chosen: Stretch[] = [];
      const seen = new Set<string>();
      for (const stretch of stretches) {
        if (chosen.length >= passagesPerControl) break;
        if (stretch.fingerprints.some((hex) => seen.has(hex))) continue;
        for (const hex of stretch.fingerprints) seen.add(hex);
        chosen.push(stretch);
      }
      if (chosen.length < passagesPerControl) continue;
      const language = documents[0].language === "fr" || documents[0].language === "ar" ? documents[0].language : "en";
      const host = hostOf(language).text.split(/\s+/).filter(Boolean);
      const gap = Math.floor(host.length / (chosen.length + 1));
      const parts: string[] = [];
      chosen.forEach((stretch, index) => {
        parts.push(host.slice(index * gap, (index + 1) * gap).join(" "), stretch.words.join(" "));
      });
      parts.push(host.slice(chosen.length * gap).join(" "));
      const id = `common-text-${dataset.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
      controls.push({
        id,
        category: "common-language-negative",
        language: language as BenchmarkQuery["language"],
        description: `${host.length} words of original prose with the ${chosen.length} most widely held ${passageWords}-word stretches found in a ${sampleSize}-document sample of ${dataset} (median fingerprint df ${chosen.map((stretch) => stretch.medianDf).join(", ")})`,
        // Nothing here is a source the text was "copied from" in the benchmark's sense: these stretches are corpus-wide common text.
        intendedSources: [],
        expectation: "negative",
        text: parts.join(" "),
      });
      selections.push({ id, dataset, documentsInDataset: documents.length, documentsScanned: Math.ceil(documents.length / step), stretches: chosen.map((stretch) => ({ docId: stretch.docId, start: stretch.start, medianDf: stretch.medianDf, minimumDf: stretch.minimumDf, text: stretch.words.join(" ") })) });
      logLine(`${id.padEnd(48)} ${chosen.length} stretches, median df ${chosen.map((stretch) => stretch.medianDf).join(" / ")}`);
    }
    writeJson(requireArgument(args, "out"), { identity: reader.identity(), documentCount: reader.manifest.documentCount, selections, queries: controls });
    logLine(`${controls.length} common-text controls`);
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
