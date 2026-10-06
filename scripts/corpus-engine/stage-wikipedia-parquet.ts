import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { logLine, parseArguments, requireArgument, wordsOf, writeJson } from "./common";

/**
 * Stages a deterministic sample of one Wikipedia language edition, from the
 * Wikimedia Foundation's own plain-text export (the `wikimedia/wikipedia`
 * dataset: one parquet shard holds ~150k articles as id, url, title, text),
 * into a JSON-lines bundle the JsonLinesBundleSourceAdapter reads.
 *
 *   node --import tsx scripts/corpus-engine/stage-wikipedia-parquet.ts \
 *     --parquet D:\...\20231101.fr_train-00000-of-00017.parquet --language fr --count 20000 \
 *     --dump 20231101 --shard 20231101.fr/train-00000-of-00017.parquet --revision <dataset commit> \
 *     --hyparquet-dir D:\...\tools --out D:\...\staging\wikipedia-fr.jsonl
 *
 * The shard is downloaded beforehand (one bulk file, no per-article request).
 * The parquet reader is not a repository dependency: it is loaded from
 * `--hyparquet-dir`, a folder outside the repository with hyparquet installed.
 *
 * Selection: articles of at least `--min-words` whitespace words, ordered by
 * sha256(language + ":" + page id), first `--count`. So the sample does not
 * depend on row order and is not the shard's first N (which are the oldest,
 * longest articles). The bundle is written sorted by externalId.
 */

type Row = { id: string; url: string; title: string; text: string };

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const parquet = requireArgument(args, "parquet");
  const language = requireArgument(args, "language");
  const count = Number(requireArgument(args, "count"));
  const dump = requireArgument(args, "dump");
  const shard = requireArgument(args, "shard");
  const revision = requireArgument(args, "revision");
  const out = requireArgument(args, "out");
  const minimumWords = Number(args["min-words"] ?? 300);
  const toolDirectory = requireArgument(args, "hyparquet-dir");
  const load = (name: string, entry: string) => import(pathToFileURL(path.join(toolDirectory, "node_modules", name, entry)).href);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hyparquet: any = await load("hyparquet", "src/node.js");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { compressors }: any = await load("hyparquet-compressors", "src/index.js");

  const file = await hyparquet.asyncBufferFromFile(parquet);
  const metadata = await hyparquet.parquetMetadataAsync(file);
  const groupRows: number[] = metadata.row_groups.map((group: { num_rows: bigint }) => Number(group.num_rows));
  const readGroup = async (group: number): Promise<Row[]> => {
    const rowStart = groupRows.slice(0, group).reduce((total, rows) => total + rows, 0);
    let rows: Row[] = [];
    await hyparquet.parquetRead({ file, metadata, compressors, rowStart, rowEnd: rowStart + groupRows[group], rowFormat: "object", onComplete: (result: Row[]) => { rows = result; } });
    return rows;
  };

  const eligible: Array<{ rank: string; group: number; index: number }> = [];
  let total = 0;
  for (let group = 0; group < groupRows.length; group += 1) {
    const rows = await readGroup(group);
    rows.forEach((row, index) => {
      total += 1;
      if (wordsOf(row.text).length < minimumWords) return;
      eligible.push({ rank: createHash("sha256").update(`${language}:${row.id}`).digest("hex"), group, index });
    });
    if (group % 25 === 0) logLine(`${language}: scanned ${total} articles, ${eligible.length} eligible`);
  }
  eligible.sort((left, right) => (left.rank < right.rank ? -1 : left.rank > right.rank ? 1 : 0));
  const chosen = new Map<number, Set<number>>();
  for (const item of eligible.slice(0, count)) {
    if (!chosen.has(item.group)) chosen.set(item.group, new Set());
    (chosen.get(item.group) as Set<number>).add(item.index);
  }

  const retrievedAt = new Date().toISOString();
  const lines: Array<{ externalId: string; line: string }> = [];
  let words = 0;
  for (const group of [...chosen.keys()].sort((left, right) => left - right)) {
    const rows = await readGroup(group);
    for (const index of chosen.get(group) as Set<number>) {
      const row = rows[index];
      words += wordsOf(row.text).length;
      lines.push({
        externalId: String(row.id),
        line: JSON.stringify({
          provider: "wikimedia",
          dataset: `wikipedia-${dump}.${language}`,
          datasetVersion: dump,
          externalId: String(row.id),
          canonicalUrl: row.url,
          title: row.title,
          authors: null,
          publishedDate: null,
          sourceType: "encyclopedia-article",
          language,
          rights: {
            license: "CC BY-SA 4.0",
            licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
            usage: "Wikipedia text is licensed CC BY-SA 4.0 (and GFDL); the dataset card states cc-by-sa-3.0 and gfdl. Copying, storing and indexing are permitted with attribution and share-alike.",
            attribution: `Wikipedia contributors, ${row.url}`,
          },
          provenance: {
            acquisitionSource: `huggingface.co/datasets/wikimedia/wikipedia:${shard}`,
            retrievedAt,
            sourceVersion: `dump:${dump}; dataset-revision:${revision}; page-id:${row.id}`,
            notes: `bulk parquet shard; articles of >= ${minimumWords} words ordered by sha256("${language}:" + page id), first ${count}`,
          },
          extraction: "utf8-text-v1",
          raw: row.text,
        }),
      });
    }
  }
  lines.sort((left, right) => (left.externalId < right.externalId ? -1 : left.externalId > right.externalId ? 1 : 0));
  const stream = createWriteStream(out, { encoding: "utf8" });
  for (const item of lines) if (!stream.write(`${item.line}\n`)) await new Promise<void>((resolve) => stream.once("drain", () => resolve()));
  await new Promise<void>((resolve) => stream.end(() => resolve()));
  const report = { language, parquet, shard, dump, revision, articlesInShard: total, eligible: eligible.length, minimumWords, staged: lines.length, words, out, retrievedAt };
  writeJson(`${out}.stats.json`, report);
  logLine(`${language}: staged ${lines.length} of ${eligible.length} eligible (${total} in the shard), ${words} words -> ${out}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
