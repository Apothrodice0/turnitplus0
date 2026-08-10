#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output_root="${1:-$project_root/release}"
mkdir -p "$output_root"
output_root="$(cd "$output_root" && pwd)"
temp_base="${TMPDIR:-${TEMP:-$output_root}}"
mkdir -p "$temp_base"
temp_root="$(mktemp -d "$temp_base/turnitplus-package.XXXXXX")"
trap 'rm -rf "$temp_root"' EXIT
stage="$temp_root/turnitplus-windows"
mkdir -p "$stage/app" "$stage/lib" "$stage/public/data" "$stage/types" "$stage/tools" "$stage/corpus"

cp "$project_root"/START-WINDOWS.bat "$project_root"/START-HERE.txt "$project_root"/README.md "$stage/"
cp "$project_root"/.env.example "$stage/"
cp "$project_root"/CALIBRATION-EXPORT.md "$stage/"
cp "$project_root"/corpus/PROVENANCE-AND-ETHICS.md "$stage/PROVENANCE.md"
cp "$project_root"/windows/package.json "$project_root"/windows/vite.config.ts "$stage/"
cp "$project_root"/tsconfig.json "$project_root"/next.config.ts "$project_root"/postcss.config.mjs "$stage/"
cp "$project_root"/app/page.tsx "$project_root"/app/layout.tsx "$project_root"/app/globals.css "$project_root"/app/similarity-worker.ts "$project_root"/app/ai-detector-worker.ts "$project_root"/app/web-check-worker.ts "$stage/app/"
cp "$project_root"/lib/*.ts "$stage/lib/"
cp "$project_root"/public/favicon.svg "$project_root"/public/receipt-font.ttf "$project_root"/public/receipt-font-bold.ttf "$stage/public/"
cp "$project_root"/public/data/document-index.json.gz "$stage/public/data/"
cp "$project_root"/public/data/document-index.meta.json "$stage/public/data/"
cp "$project_root"/public/data/document-index.*.bin "$stage/public/data/"
cp "$project_root"/public/data/risk-calibration.json "$stage/public/data/"
cp "$project_root"/public/data/ai-calibration.json "$stage/public/data/"
cp "$project_root"/public/data/ai-evaluation.json "$stage/public/data/"
cp "$project_root"/types/assets.d.ts "$stage/types/"
cp "$project_root"/tools/*.ts "$project_root"/tools/*.py "$stage/tools/"
cp "$project_root"/corpus/README.md "$project_root"/corpus/MANIFEST-SCHEMA.md "$project_root"/corpus/AI-POSITIVE-README.md "$project_root"/corpus/PROVENANCE-AND-ETHICS.md "$stage/corpus/"
cp "$project_root"/corpus/manifest.json "$project_root"/corpus/duplicate-clusters.json "$project_root"/corpus/import-report.json "$project_root"/corpus/native-corpus-review.json "$project_root"/corpus/ai-benchmark-summary.json "$project_root"/corpus/ai-benchmark-model-report.json "$project_root"/corpus/ai-positive-evaluation.json "$project_root"/corpus/ai-extraction-parity-report.json "$stage/corpus/"
cp -R "$project_root"/corpus/ai-positive-benchmark "$stage/corpus/"
cp -R "$project_root"/corpus/similarity "$project_root"/corpus/ai-negative "$project_root"/corpus/ai-benchmark "$project_root"/corpus/ai-positive "$project_root"/corpus/ai-hybrid "$stage/corpus/"

# Windows cannot extract filenames containing characters such as ':' or '?'.
# Rewrite only the packaged filenames to deterministic hashes and update the
# packaged manifest. Source corpus paths and hashes remain unchanged.
node --input-type=module - "$stage/corpus" <<'NODE'
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { extname, join, posix } from "node:path";

const corpusRoot = process.argv[2];
const manifestPath = join(corpusRoot, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const unsafeSegment = (segment) => /[<>:"\\|?*\u0000-\u001f]|[. ]$/.test(segment)
  || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment);

for (const entry of manifest) {
  const segments = entry.textPath.split("/");
  if (!segments.some(unsafeSegment)) continue;
  const oldPath = join(corpusRoot, ...segments);
  if (!existsSync(oldPath)) throw new Error(`Missing corpus file before Windows sanitization: ${entry.textPath}`);
  const extension = extname(segments.at(-1)) || ".txt";
  const safeName = `${createHash("sha256").update(entry.id).digest("hex")}${extension}`;
  const safeRelativePath = posix.join(...segments.slice(0, -1), safeName);
  const safePath = join(corpusRoot, ...safeRelativePath.split("/"));
  if (existsSync(safePath)) throw new Error(`Windows-safe corpus filename collision: ${safeRelativePath}`);
  renameSync(oldPath, safePath);
  entry.textPath = safeRelativePath;
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

source_similarity_texts="$(find "$project_root/corpus/similarity/text" -type f -name '*.txt' | wc -l | tr -d ' ')"
packaged_similarity_texts="$(find "$stage/corpus/similarity/text" -type f -name '*.txt' | wc -l | tr -d ' ')"
if [[ "$source_similarity_texts" -eq 0 || "$packaged_similarity_texts" -ne "$source_similarity_texts" ]]; then
  echo "Windows package validation failed: expected $source_similarity_texts similarity text files, found $packaged_similarity_texts." >&2
  exit 1
fi

if [[ ! -f "$stage/.env.example" || -f "$stage/.env" ]]; then
  echo "Windows package validation failed: expected a blank .env.example and no .env secrets." >&2
  exit 1
fi

node --input-type=module - "$stage/package.json" <<'NODE'
import { readFileSync } from "node:fs";

const packagePath = process.argv[2];
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
const requiredScripts = [
  "collect:openalex-calibration",
  "calibrate:similarity",
  "calibrate:ai",
];
const missing = requiredScripts.filter((name) => typeof packageJson.scripts?.[name] !== "string");
if (missing.length) {
  throw new Error(`Windows package is missing npm scripts: ${missing.join(", ")}`);
}
NODE

node --input-type=module - "$stage/corpus" <<'NODE'
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const corpusRoot = process.argv[2];
const manifest = JSON.parse(readFileSync(join(corpusRoot, "manifest.json"), "utf8"));
const unsafeSegment = (segment) => /[<>:"\\|?*\u0000-\u001f]|[. ]$/.test(segment)
  || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment);
for (const entry of manifest) {
  if (entry.textPath.split("/").some(unsafeSegment)) {
    throw new Error(`Windows package contains an unsafe corpus path: ${entry.textPath}`);
  }
  const filePath = join(corpusRoot, ...entry.textPath.split("/"));
  if (!existsSync(filePath)) throw new Error(`Windows package is missing corpus text: ${entry.textPath}`);
  const digest = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  if (digest !== entry.provenance?.sha256) throw new Error(`Windows package corpus hash mismatch: ${entry.id}`);
}
NODE

(
  cd "$stage"
  npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null
)

(
  cd "$temp_root"
  archive_name="${TPLUS_ARCHIVE_NAME:-turnitplus-windows}"
  archive_path="$output_root/${archive_name}.zip"
  rm -f "$archive_path"
  zip -9qr "$archive_path" turnitplus-windows
  unzip -tq "$archive_path"
)

echo "$output_root/${TPLUS_ARCHIVE_NAME:-turnitplus-windows}.zip"
