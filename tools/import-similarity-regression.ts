import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import mammoth from "mammoth";

type Fixture = {
  fileName: string;
  turnitinScore: number;
  previousTurnitPlusScore: number;
};

const FIXTURES: Fixture[] = [
  { fileName: "From Innovation to Competitive Resilience The Reality of Startups between Support Mechanisms and the Risks of Economic Dominance.docx", turnitinScore: 1, previousTurnitPlusScore: 16 },
  { fileName: "The Organic Framework of the Constitutional Court in Algeria.docx", turnitinScore: 16, previousTurnitPlusScore: 21 },
  { fileName: "The Algerian University and the Entrepreneurship Challenge(1).docx", turnitinScore: 2, previousTurnitPlusScore: 7 },
  { fileName: "The Impact of Operational Financing Constraints on Inventory Sustainability and Supply Chain Efficiency.docx", turnitinScore: 1, previousTurnitPlusScore: 10 },
  { fileName: "Operationalising Strategic Vision Through the SVAM Model to Enhance Competitive Advantage.docx", turnitinScore: 3, previousTurnitPlusScore: 6 },
  { fileName: "E-Administration as a Mechanism for Combating Administrative Corruption(3).docx", turnitinScore: 5, previousTurnitPlusScore: 11 },
  { fileName: "Legal Mechanisms for Combating Political Nomadism in Algeria(2).docx", turnitinScore: 17, previousTurnitPlusScore: 15 },
  { fileName: "Cybersecurity in the Age of Digital Transformation Civil Society Approaches to Promoting a Culture of General Mobilization in Algeria.docx", turnitinScore: 3, previousTurnitPlusScore: 17 },
];

function arg(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}.`);
  return process.argv[index + 1];
}

const inputDir = resolve(arg("--input-dir"));
const outputRoot = resolve("corpus/similarity-regression");
const textRoot = join(outputRoot, "text");
mkdirSync(textRoot, { recursive: true });
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const slug = (value: string) => value.toLowerCase().replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 82);
const rows = [];
for (const fixture of FIXTURES) {
  const inputPath = join(inputDir, fixture.fileName);
  const bytes = readFileSync(inputPath);
  const extraction = await mammoth.extractRawText({ buffer: bytes });
  const text = extraction.value.replace(/\r\n?/g, "\n").trim();
  if (text.split(/\s+/).length < 300) throw new Error(`${fixture.fileName} extracted fewer than 300 words.`);
  const originalSha256 = sha256(bytes);
  const id = `${slug(fixture.fileName)}-${originalSha256.slice(0, 10)}`;
  const textPath = `text/${id}.txt`;
  writeFileSync(join(outputRoot, textPath), `${text}\n`);
  const normalizedBytes = readFileSync(join(outputRoot, textPath));
  rows.push({
    id,
    title: basename(fixture.fileName, ".docx").replace(/\(\d+\)$/, ""),
    textPath,
    originalFileName: fixture.fileName,
    originalSha256,
    textSha256: sha256(normalizedBytes),
    wordCount: text.split(/\s+/).length,
    turnitinScore: fixture.turnitinScore,
    previousTurnitPlusScore: fixture.previousTurnitPlusScore,
  });
}
const manifest = {
  schema: "turnitplus-similarity-heldout-regression",
  version: 1,
  generatedBy: "tools/import-similarity-regression.ts",
  generatedAt: new Date().toISOString(),
  inputContract: "mammoth-raw-text-v1",
  role: "held-out-original-document-regression-only",
  exclusion: "Never used for index building, parameter selection, threshold fitting, or calibration.",
  documents: rows,
};
writeFileSync(join(outputRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`Imported ${rows.length} held-out originals into ${outputRoot}.`);
