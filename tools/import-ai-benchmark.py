#!/usr/bin/env python3
"""Preserve AI-negative rejections as an explicitly unverified human benchmark.

The benchmark is intentionally separate from verified AI negatives. It records
the user's human-authorship assumption and every reason that prevented a file
from entering the stricter false-positive calibration set.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import quote, unquote

from pypdf import PdfReader


BENCHMARK_ASSUMPTION = (
    "Published academic writing supplied by the corpus owner as the closest available "
    "human-writing reference. Human-only authorship was not independently verified, and "
    "post-2021 publications may contain AI assistance."
)
POPULATION_BASIS = (
    "The corpus owner supplied this as a native-English-speaker batch. This is a population "
    "proxy and was not independently verified from every author's first-language history."
)


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def clean_text(text: str) -> str:
    return re.sub(r"[ \t]+\n", "\n", text.replace("\x00", "")).strip()


def english_word_count(text: str) -> int:
    return len(re.findall(r"\b[A-Za-z]+(?:['’-][A-Za-z]+)?\b", text))


def english_signals(text: str) -> int:
    sample = text[:12000]
    return sum(
        len(re.findall(rf"\b{word}\b", sample, re.IGNORECASE))
        for word in ("the", "and", "of", "in", "to", "is", "for", "this")
    )


def extract_text(pdf: Path, temporary_root: Path) -> tuple[str, str, dict[str, object], list[str]]:
    reader = PdfReader(str(pdf))
    text_layer = clean_text("\n\n".join((page.extract_text() or "") for page in reader.pages))
    metadata = dict(reader.metadata or {})
    if english_word_count(text_layer) >= 300 and english_signals(text_layer) >= 20:
        return text_layer, "pdf-text-layer", metadata, []

    with tempfile.TemporaryDirectory(prefix="benchmark-ocr-", dir=temporary_root) as temporary:
        prefix = Path(temporary) / "page"
        subprocess.run(
            ["/usr/bin/pdftoppm", "-r", "170", "-png", str(pdf), str(prefix)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        ocr_pages: list[str] = []
        failed_pages: list[str] = []
        for image in sorted(Path(temporary).glob("page-*.png")):
            try:
                completed = subprocess.run(
                    ["/usr/bin/tesseract", str(image), "stdout", "-l", "eng", "--psm", "6"],
                    check=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    text=True,
                )
                ocr_pages.append(completed.stdout)
            except subprocess.CalledProcessError:
                failed_pages.append(image.name)
        ocr_text = clean_text("\n\n".join(ocr_pages))
    if english_word_count(ocr_text) > english_word_count(text_layer):
        method = "ocr-fallback-tesseract-5.3.4-170dpi"
        if failed_pages:
            method += "-partial"
        return ocr_text, method, metadata, failed_pages
    return text_layer, "pdf-text-layer-low-confidence", metadata, failed_pages


def publication_year(text: str) -> tuple[int | None, str | None]:
    head = text[:12000]
    patterns = [
        r"Published(?:\s+online)?\s*:?\s*(?:\d{1,2}(?:st|nd|rd|th)?[\s,/-]+)?"
        r"(?:January|February|March|April|May|June|July|August|September|October|November|December)?"
        r"[\s,/-]*((?:19|20)\d{2})",
        r"(?:Volume|Vol\.?|Issue|No\.?)\s*[^\n]{0,100}?\b((?:19|20)\d{2})\b",
        r"(?:Copyright|©)\s*[^\n]{0,100}?\b((?:19|20)\d{2})\b",
    ]
    for pattern in patterns:
        match = re.search(pattern, head, re.IGNORECASE)
        if match:
            line_start = head.rfind("\n", 0, match.start()) + 1
            line_end = head.find("\n", match.end())
            evidence = head[line_start:line_end if line_end >= 0 else match.end() + 80].strip()
            return int(match.group(1)), re.sub(r"\s+", " ", evidence)[:300]
    return None, None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", type=Path, default=Path("."))
    parser.add_argument("--pdf-dir", type=Path, required=True)
    parser.add_argument("--source-uri", required=True)
    args = parser.parse_args()

    project = args.project.resolve()
    pdf_dir = args.pdf_dir.resolve()
    corpus = project / "corpus"
    report_path = corpus / "import-report.json"
    manifest_path = corpus / "manifest.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    batches = report.get("batches")
    if not isinstance(batches, list):
        raise SystemExit("Import report has no batches array.")
    batch = next((item for item in reversed(batches) if item.get("sourceUri") == args.source_uri), None)
    if batch is None:
        raise SystemExit("No import-report batch matches --source-uri.")
    if batch.get("benchmarkAcceptedCount") is not None:
        raise SystemExit("This rejected batch has already been preserved as an AI benchmark.")
    rejected = batch.get("rejected")
    if not isinstance(rejected, list) or not rejected:
        raise SystemExit("The matching batch has no rejected documents to preserve.")

    expected = {str(item["file"]): item for item in rejected}
    missing = sorted(name for name in expected if not (pdf_dir / name).is_file())
    if missing:
        raise SystemExit(f"Missing {len(missing)} rejected PDFs; first missing: {missing[0]}")

    existing_ids = {str(entry["id"]) for entry in manifest}
    temporary_root = project / "tmp"
    temporary_root.mkdir(parents=True, exist_ok=True)
    entries: list[dict[str, object]] = []
    for position, name in enumerate(sorted(expected, key=str.casefold), start=1):
        pdf = pdf_dir / name
        pdf_digest = sha256(pdf.read_bytes())
        name_digest = sha256(name.encode("utf-8"))
        document_id = f"ai-benchmark-{pdf_digest[:12]}-{name_digest[:6]}"
        if document_id in existing_ids:
            raise SystemExit(f"Benchmark id collision: {document_id}")
        reasons = [str(reason) for reason in expected[name].get("reasons", [])]
        relative = Path("ai-benchmark/text") / f"{document_id}.txt"
        target = corpus / relative
        if target.is_file():
            text = clean_text(target.read_text(encoding="utf-8"))
            metadata = dict(PdfReader(str(pdf)).metadata or {})
            was_low_text = any(reason in reasons for reason in (
                "english-language-not-verified", "fewer-than-300-english-words"
            ))
            extraction_method = "ocr-fallback-tesseract-5.3.4-170dpi" if was_low_text else "pdf-text-layer"
            failed_pages: list[str] = []
        else:
            text, extraction_method, metadata, failed_pages = extract_text(pdf, temporary_root)
        if not text:
            raise SystemExit(f"No text could be extracted from {name}")
        year, year_evidence = publication_year(text)
        word_count = english_word_count(text)
        language = "English" if word_count >= 300 and english_signals(text) >= 20 else None
        clean = f"{text}\n".encode("utf-8")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(clean)
        title = str(metadata.get("/Title") or "").strip() or pdf.stem
        entries.append({
            "id": document_id,
            "roles": ["ai-benchmark"],
            "textPath": relative.as_posix(),
            "title": title,
            "language": language,
            "publishedYear": year,
            "turnitinScore": None,
            "writerPopulation": "native-english",
            "writerPopulationBasis": POPULATION_BASIS,
            "benchmarkStatus": "human-reference-proxy",
            "benchmarkAssumption": BENCHMARK_ASSUMPTION,
            "benchmarkExclusionReasons": reasons,
            "genre": "published-article",
            "discipline": None,
            "provenance": {
                "source": f"user-supplied {unquote(args.source_uri.rsplit('/', 1)[-1])}",
                "url": f"{args.source_uri}#{quote(name)}",
                "journal": None,
                "retrievedAt": "2026-08-07",
                "sha256": sha256(clean),
                "pdfSha256": pdf_digest,
                "extractionMethod": extraction_method,
                "ocrFailedPages": failed_pages,
                "publicationYearEvidence": year_evidence,
                "originalAiNegativeExclusionReasons": reasons,
            },
        })
        existing_ids.add(document_id)
        print(f"[{position:03d}/{len(expected):03d}] {extraction_method}: {name}", flush=True)

    manifest = sorted(manifest + entries, key=lambda entry: str(entry["id"]))
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    batch["benchmarkRole"] = "ai-benchmark"
    batch["benchmarkStatus"] = "human-reference-proxy"
    batch["benchmarkAcceptedCount"] = len(entries)
    batch["benchmarkUnassignedCount"] = 0
    batch["benchmarkIds"] = [entry["id"] for entry in entries]
    report["aiBenchmarkDocuments"] = len([
        entry for entry in manifest if "ai-benchmark" in entry.get("roles", [])
    ])
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Preserved {len(entries)} documents as ai-benchmark; none remain unassigned.")


if __name__ == "__main__":
    main()
