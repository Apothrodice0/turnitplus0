import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const CONTAINMENT_THRESHOLD = 0.25;

type Article = {
  id: string;
  title: string;
  originalSimilarity: number | null;
  wordCount: number;
};

type SearchIndex = {
  schema: "tplus-search-index";
  version: 3;
  corpusVersion: string;
  articles: Article[];
  invertedIndex: Record<string, number[]>;
};

const index = JSON.parse(
  gunzipSync(readFileSync("public/data/document-index.json.gz")).toString("utf8"),
) as SearchIndex;
if (index.schema !== "tplus-search-index" || index.version !== 3) {
  throw new Error("Unsupported similarity index schema.");
}

const shingleSets: Array<Set<string>> = Array.from(
  { length: index.articles.length },
  () => new Set<string>(),
);
for (const [hash, documentIndexes] of Object.entries(index.invertedIndex)) {
  for (const documentIndex of documentIndexes) shingleSets[documentIndex]?.add(hash);
}

function containment(leftIndex: number, rightIndex: number) {
  const left = shingleSets[leftIndex];
  const right = shingleSets[rightIndex];
  const small = left.size <= right.size ? left : right;
  const large = left.size <= right.size ? right : left;
  let shared = 0;
  for (const hash of small) if (large.has(hash)) shared += 1;
  return shared / Math.max(1, small.size);
}

const pairs: Array<{ left: number; right: number; containment: number }> = [];
for (let left = 0; left < index.articles.length; left += 1) {
  for (let right = left + 1; right < index.articles.length; right += 1) {
    pairs.push({ left, right, containment: containment(left, right) });
  }
}
pairs.sort((a, b) => b.containment - a.containment);
const duplicateEdges = pairs.filter((pair) => pair.containment >= CONTAINMENT_THRESHOLD);

const parent = Array.from({ length: index.articles.length }, (_, articleIndex) => articleIndex);
function find(articleIndex: number): number {
  if (parent[articleIndex] !== articleIndex) parent[articleIndex] = find(parent[articleIndex]);
  return parent[articleIndex];
}
for (const edge of duplicateEdges) parent[find(edge.left)] = find(edge.right);

const groups = new Map<number, number[]>();
for (let articleIndex = 0; articleIndex < index.articles.length; articleIndex += 1) {
  const root = find(articleIndex);
  groups.set(root, [...(groups.get(root) ?? []), articleIndex]);
}

const clusters = [...groups.values()]
  .filter((members) => members.length > 1)
  .map((members, clusterIndex) => ({
    clusterId: `dup-${clusterIndex + 1}`,
    maximumPairContainment: Number(Math.max(
      ...duplicateEdges
        .filter((edge) => members.includes(edge.left) && members.includes(edge.right))
        .map((edge) => edge.containment),
    ).toFixed(4)),
    members: members.map((memberIndex) => ({
      index: memberIndex,
      id: index.articles[memberIndex].id,
      title: index.articles[memberIndex].title,
      turnitinScore: index.articles[memberIndex].originalSimilarity,
      wordCount: index.articles[memberIndex].wordCount,
    })),
  }));

const exclusionMap = Object.fromEntries(clusters.flatMap((cluster) =>
  cluster.members.map((member) => [
    member.id,
    cluster.members.filter((candidate) => candidate.id !== member.id).map((candidate) => candidate.id),
  ]),
));
const firstBelowThreshold = pairs.find((pair) => pair.containment < CONTAINMENT_THRESHOLD)?.containment ?? 0;
const weakestDuplicate = duplicateEdges.at(-1)?.containment ?? 0;
const output = {
  schema: "turnitplus-duplicate-clusters",
  version: 1,
  generatedBy: "tools/detect-duplicates.ts",
  generatedAt: new Date().toISOString(),
  corpusVersion: index.corpusVersion,
  containmentThreshold: CONTAINMENT_THRESHOLD,
  metric: "containment of the smaller searchable five-gram set in the larger set",
  pairsExamined: pairs.length,
  topContainments: pairs.slice(0, 10).map((pair) => Number(pair.containment.toFixed(4))),
  separationEvidence: {
    weakestIncludedPair: Number(weakestDuplicate.toFixed(4)),
    strongestExcludedPair: Number(firstBelowThreshold.toFixed(4)),
    gapRatio: firstBelowThreshold > 0
      ? Number((weakestDuplicate / firstBelowThreshold).toFixed(2))
      : null,
  },
  clusters,
  exclusionMap,
};
writeFileSync("corpus/duplicate-clusters.json", JSON.stringify(output, null, 2));
console.log(`pairs examined: ${pairs.length}`);
console.log(`top containments: ${output.topContainments.slice(0, 5).join(", ")}`);
console.log(`clusters found: ${clusters.length}`);
for (const cluster of clusters) {
  console.log(`\n${cluster.clusterId} (${cluster.maximumPairContainment})`);
  for (const member of cluster.members) console.log(`  ${member.id} [${member.turnitinScore ?? "unlabelled"}%]`);
}
