// Builds a six-word positional index from a lane-token store (read only).
// usage (cwd = worktree): node --import tsx scripts/asjp-sixword/build-index.mts --tokens <laneTokensDir> --out <dir>
//   [--tmp <dir>] [--generation <id>] [--manifest <sha256>] [--partitions 64] [--exclude <file of docIds>] [--only <file>]
import { readFileSync } from "node:fs";
import { buildSixwordIndex } from "../../lib/asjp-sixword-index";

const arg = (name: string) => { const k = process.argv.indexOf(`--${name}`); return k > 0 ? process.argv[k + 1] : undefined; };
const idsOf = (file: string | undefined) => (file ? new Set<string>(JSON.parse(readFileSync(file, "utf8")).map(String)) : undefined);
const tokens = arg("tokens"), out = arg("out");
if (!tokens || !out) throw new Error("--tokens and --out are required");
const started = Date.now();
const identity = await buildSixwordIndex({
  laneTokensDir: tokens, outDir: out, tmpDir: arg("tmp") ?? `${out}.tmp`, generationId: arg("generation") ?? null, logicalManifestSha256: arg("manifest") ?? null,
  partitions: Number(arg("partitions") ?? 64), exclude: idsOf(arg("exclude")), only: idsOf(arg("only")),
  log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
});
const rss = process.memoryUsage();
console.log(JSON.stringify({ ...identity, wallMs: Date.now() - started, peakRssMb: Math.round(rss.rss / 2 ** 20), resourceUsage: process.resourceUsage() }, null, 1));
