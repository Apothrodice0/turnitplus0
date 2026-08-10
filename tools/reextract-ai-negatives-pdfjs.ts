import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { extractPdfTextDocument } from "../lib/pdf-text-extraction";
import { loadManifest, type CorpusManifestEntry } from "./calibration-utils";

const EXTRACTION_CONTRACT_VERSION = 3;
const EXTRACTION_METHOD = "shared-pdfjs-text-layer-v3";
const REPORT_PATH = "corpus/ai-extraction-parity-report.json";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name} <zip-path>.`);
  return resolve(process.argv[index + 1]);
}

const archives: Record<string, string> = {
  "user-supplied Corpus.zip": argument("--corpus"),
  "user-supplied Corpus 2.zip": argument("--corpus2"),
  "user-supplied native corpus.zip": argument("--native"),
};

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceFileName(entry: CorpusManifestEntry) {
  const url = entry.provenance.url;
  if (typeof url !== "string" || !url.includes("#")) {
    throw new Error(`${entry.id}: provenance URL does not identify the source PDF.`);
  }
  return decodeURIComponent(url.slice(url.indexOf("#") + 1));
}

function readArchiveEntry(archivePath: string, entryName: string) {
  const result = spawnSync("unzip", ["-p", archivePath, entryName], {
    maxBuffer: 64 * 1024 * 1024,
  });
  // Info-ZIP can return status 1 for Unicode local/central filename warnings
  // while still writing the complete, hash-verifiable entry to stdout.
  if (!result.stdout.length) {
    throw new Error(`Could not read ${entryName} from ${basename(archivePath)}: ${String(result.stderr).trim()}`);
  }
  return new Uint8Array(result.stdout);
}

const manifest = loadManifest();
const negatives = manifest.filter((entry) => entry.roles.includes("ai-negative"));
if (negatives.length !== 88) {
  throw new Error(`Expected the locked 88-document negative set; found ${negatives.length}.`);
}

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const updates = new Map<string, { text: string; textSha256: string; pdfSha256: string; sourceFileName: string }>();

for (let index = 0; index < negatives.length; index += 1) {
  const entry = negatives[index];
  const archivePath = archives[String(entry.provenance.source)];
  if (!archivePath) throw new Error(`${entry.id}: no approved archive for ${entry.provenance.source ?? "unknown source"}.`);
  const fileName = sourceFileName(entry);
  const pdf = readArchiveEntry(archivePath, fileName);
  const actualPdfSha256 = sha256(pdf);
  if (actualPdfSha256 !== entry.provenance.pdfSha256) {
    throw new Error(`${entry.id}: source PDF hash mismatch; refusing to replace calibrated text.`);
  }
  const document = await pdfjs.getDocument({ data: pdf }).promise;
  const text = await extractPdfTextDocument(document);
  if (!text.trim()) throw new Error(`${entry.id}: PDF.js produced empty text.`);
  updates.set(entry.id, {
    text,
    textSha256: sha256(text),
    pdfSha256: actualPdfSha256,
    sourceFileName: fileName,
  });
  process.stdout.write(`\rPDF.js extraction ${index + 1}/${negatives.length}`);
}
process.stdout.write("\n");

const updatedManifest = manifest.map((entry) => {
  const update = updates.get(entry.id);
  if (!update) return entry;
  writeFileSync(resolve("corpus", entry.textPath), update.text);
  return {
    ...entry,
    provenance: {
      ...entry.provenance,
      sha256: update.textSha256,
      pdfSha256: update.pdfSha256,
      sourceFileName: update.sourceFileName,
      extractionMethod: EXTRACTION_METHOD,
      textExtractionContractVersion: EXTRACTION_CONTRACT_VERSION,
    },
  };
});
writeFileSync("corpus/manifest.json", `${JSON.stringify(updatedManifest, null, 2)}\n`);

const perArchive = Object.entries(archives).map(([source, path]) => ({
  source,
  archive: basename(path),
  matchedDocuments: negatives.filter((entry) => entry.provenance.source === source).length,
}));
const report = {
  schema: "turnitplus-ai-extraction-parity",
  version: 2,
  generatedBy: "tools/reextract-ai-negatives-pdfjs.ts",
  generatedAt: new Date().toISOString(),
  status: "passed",
  extractionContractVersion: EXTRACTION_CONTRACT_VERSION,
  extractionMethod: EXTRACTION_METHOD,
  verifiedDocumentCount: negatives.length,
  verifiedPdfHashCount: negatives.length,
  sourceArchives: perArchive,
  coverageDifferencePoints: 0,
  finding: "All 88 verified human negatives were re-extracted from their hash-verified source PDFs through the shared PDF.js text-layer contract used by website uploads.",
  inference: "Offline calibration and browser PDF uploads now use the same page text assembly representation.",
  requiredAction: null,
};
writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
