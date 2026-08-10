#!/usr/bin/env python3
"""Build the canonical document corpus and its browser-ready shingle index."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import re
import subprocess
import tempfile
import unicodedata
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Iterable

import pdfplumber

SCHEMA = "tplus-document-corpus"
VERSION = 3
SHINGLE_SIZE = 5
DEDUP_CONTAINMENT = 0.80
MIN_OCR_QUALITY = 72
COMMON_WORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "de", "des", "du", "en",
    "et", "for", "from", "in", "is", "la", "le", "les", "of", "on", "or", "the",
    "to", "un", "une", "was", "were", "with", "that", "this", "which",
}
OCR_REPAIRS = {
    "@gmmittee": "committee",
    "chairpersongpf": "chairperson of",
    "esgablished": "established",
    "ggplacement": "replacement",
    "membggship": "membership",
    "progagures": "procedures",
}


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKD", value).casefold()
    value = "".join(character for character in value if not unicodedata.combining(character))
    value = "".join(
        character if character.isalnum() or character.isspace() else " "
        for character in value
    )
    return re.sub(r"\s+", " ", value).strip()


def words(value: str) -> list[str]:
    return normalize(value).split()


def shingles(value: str) -> set[str]:
    tokens = words(value)
    return {
        " ".join(tokens[index:index + SHINGLE_SIZE])
        for index in range(len(tokens) - SHINGLE_SIZE + 1)
    }


def informative(shingle: str) -> bool:
    return sum(len(word) >= 4 and word not in COMMON_WORDS for word in shingle.split()) >= 2


def gram_hash(value: str) -> str:
    first = 0x811C9DC5
    second = 5381
    for code in map(ord, value):
        first = ((first ^ code) * 0x01000193) & 0xFFFFFFFF
        second = ((second * 33) ^ code) & 0xFFFFFFFF
    return f"{first:08x}{second:08x}"


def report_layout(pdf: Path) -> tuple[list[int], str, int | None]:
    info = subprocess.run(
        ["pdfinfo", str(pdf)], check=True, capture_output=True, text=True
    ).stdout
    count = int(re.search(r"^Pages:\s+(\d+)", info, re.M).group(1))
    texts: dict[int, str] = {}
    for page in range(1, count + 1):
        texts[page] = subprocess.run(
            ["pdftotext", "-f", str(page), "-l", str(page), "-layout", str(pdf), "-"],
            check=True, capture_output=True, text=True,
        ).stdout
    submission = [
        page for page, text in texts.items() if re.search(r"Integrity Submission", text, re.I)
    ]
    if submission:
        cover = re.split(r"Document Details", texts.get(1, ""), maxsplit=1, flags=re.I)[0]
        candidates = [
            re.sub(r"\s+", " ", line).strip()
            for line in cover.splitlines()
            if len(re.findall(r"\b\w+\b", line, re.UNICODE)) >= 4
            and not re.search(
                r"Cover Page|Submission ID|Academic Translation|Page \d+ of",
                line,
                re.I,
            )
        ]
        report_title = max(
            candidates,
            key=lambda line: len(re.findall(r"\b\w+\b", line, re.UNICODE)),
            default=pdf.stem,
        )[:240]
        combined = "\n".join(texts.values())
        score_match = re.search(r"(\d{1,3})\s*%\s*Overall Similarity", combined, re.I)
        similarity = min(100, int(score_match.group(1))) if score_match else None
        return submission, report_title, similarity
    selected: list[int] = []
    report_title = pdf.stem
    similarity: int | None = None
    for page in range(1, count + 1):
        if re.search(r"ORIGINALITY REPORT|PRIMARY SOURCES", texts[page], re.I):
            before_report = re.split(r"ORIGINALITY REPORT", texts[page], maxsplit=1, flags=re.I)[0]
            title_lines = [
                re.sub(r"\s+", " ", line).strip()
                for line in before_report.splitlines()
                if len(re.findall(r"\b\w+\b", line, re.UNICODE)) >= 2
            ]
            if title_lines:
                report_title = " ".join(title_lines)[:240]
            match = re.search(
                r"(\d{1,3})\s*%?\s*SIMILARITY INDEX",
                texts[page],
                re.I | re.S,
            )
            if match:
                similarity = min(100, int(match.group(1)))
            break
        selected.append(page)
    return selected, report_title, similarity


def ocr_page(pdf: Path, page: int, folder: Path) -> str:
    prefix = folder / f"page-{page}"
    subprocess.run(
        [
            "pdftoppm", "-f", str(page), "-l", str(page), "-png", "-r", "220",
            "-gray", "-singlefile", str(pdf), str(prefix),
        ],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return subprocess.run(
        [
            "tesseract", str(prefix.with_suffix(".png")), "stdout", "--psm", "6",
            "-c", "preserve_interword_spaces=1",
        ],
        check=True, capture_output=True, text=True,
    ).stdout


def line_quality(line: str) -> bool:
    tokens = re.findall(r"\b[\w'-]+\b", line, re.UNICODE)
    if len(tokens) < 3:
        return False
    alpha = sum(any(character.isalpha() for character in token) for token in tokens)
    suspicious = sum(
        len(token) == 1 and not token.isalpha()
        or bool(re.search(r"\d", token) and re.search(r"[A-Za-z]", token))
        for token in tokens
    )
    return alpha / len(tokens) >= 0.78 and suspicious / len(tokens) <= 0.12


def clean_text(text: str) -> str:
    lines: list[str] = []
    for line in text.splitlines():
        clean = re.sub(r"\s+", " ", line).strip()
        if not clean or re.fullmatch(r"(?:Page\s+)?\d+(?:\s+of\s+\d+)?", clean, re.I):
            continue
        if re.fullmatch(r"\d+(?:\s+\d+)*", clean) or not line_quality(clean):
            continue
        lines.append(clean)
    joined = "\n".join(lines)
    cleaned = re.split(
        r"\n\s*(?:references|bibliography|works cited)\s*:?\s*\n",
        joined, maxsplit=1, flags=re.I,
    )[0].strip()
    return repair_ocr_text(cleaned)


def repair_ocr_text(text: str) -> str:
    repaired = text
    for noisy, replacement in OCR_REPAIRS.items():
        repaired = re.sub(
            rf"(?<!\w){re.escape(noisy)}(?!\w)",
            replacement,
            repaired,
            flags=re.I,
        )
    return repaired


def quality_metrics(text: str) -> dict[str, object]:
    tokens = re.findall(r"\b[\w@'-]+\b", text, re.UNICODE)
    if not tokens:
        return {"score": 0, "suspiciousTokenRatio": 1.0, "examples": []}
    mixed = [
        token for token in tokens
        if bool(re.search(r"[A-Za-z]", token) and re.search(r"\d", token))
        or len(token) > 35
        or "�" in token
        or token.startswith("@")
    ]
    alpha = sum(any(character.isalpha() for character in token) for token in tokens)
    suspicious_ratio = len(mixed) / len(tokens)
    alpha_ratio = alpha / len(tokens)
    score = round(max(0, min(100, 100 - suspicious_ratio * 500 - max(0, 0.82 - alpha_ratio) * 160)))
    return {
        "score": score,
        "suspiciousTokenRatio": round(suspicious_ratio, 5),
        "examples": sorted(set(mixed), key=str.casefold)[:12],
    }


def fallback_title(text: str, default: str) -> str:
    candidates = []
    for line in text.splitlines()[:20]:
        clean = re.sub(r"\s+", " ", line).strip(" -")
        word_count = len(re.findall(r"\b\w+\b", clean, re.UNICODE))
        if (
            6 <= word_count <= 30
            and not re.search(
                r"ISSN|journal|volume|author|department|university|abstract|https?://|@",
                clean,
                re.I,
            )
        ):
            candidates.append(clean)
    return candidates[0][:240] if candidates else default


def extract(pdf: Path) -> dict[str, object]:
    chunks: list[str] = []
    pages, report_title, original_similarity = report_layout(pdf)
    with tempfile.TemporaryDirectory(prefix="document-pages-") as temp_name:
        temp = Path(temp_name)
        with pdfplumber.open(pdf) as document:
            for page_number in pages:
                text = document.pages[page_number - 1].extract_text(
                    x_tolerance=1.5, y_tolerance=3,
                ) or ""
                tokens = re.findall(r"\b[\w'-]+\b", text, re.UNICODE)
                if len(tokens) < 100 or sum(token.isalpha() for token in tokens) / max(1, len(tokens)) < 0.75:
                    text = ocr_page(pdf, page_number, temp)
                chunks.append(text)
    text = clean_text("\n\n".join(chunks))
    if report_title == pdf.stem:
        report_title = fallback_title(text, report_title)
    digest = hashlib.sha256(normalize(text).encode()).hexdigest()[:16]
    return {
        "id": f"{pdf.stem.lower().replace(' ', '-')}-{digest}",
        "title": report_title,
        "sourceType": "Publication",
        "originalSimilarity": original_similarity,
        "text": text,
        "wordCount": len(words(text)),
        "quality": quality_metrics(text),
    }


def migrate_articles(payload: dict[str, object]) -> list[dict[str, object]]:
    articles: list[dict[str, object]] = []
    for raw in payload.get("articles", []):
        article = dict(raw)
        text = repair_ocr_text(str(article.get("text", "")))
        if not text:
            continue
        digest = hashlib.sha256(normalize(text).encode()).hexdigest()[:16]
        article["id"] = f"{Path(str(article.get('title', 'document'))).stem.lower().replace(' ', '-')}-{digest}"
        article["sourceType"] = "Publication"
        article["text"] = text
        article["wordCount"] = len(words(text))
        article["quality"] = quality_metrics(text)
        article.setdefault("originalSimilarity", None)
        articles.append(article)
    return articles


def deduplicate(articles: Iterable[dict[str, object]]) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    kept: list[dict[str, object]] = []
    kept_grams: list[set[str]] = []
    gram_documents: dict[str, set[int]] = defaultdict(set)
    removed: list[dict[str, object]] = []

    for article in articles:
        grams = shingles(str(article["text"]))
        if len(grams) < 20:
            continue
        overlaps: dict[int, int] = defaultdict(int)
        for gram in grams:
            for index in gram_documents.get(gram, ()):
                overlaps[index] += 1
        duplicate_index = next(
            (
                index for index, shared in overlaps.items()
                if shared / max(1, min(len(grams), len(kept_grams[index]))) >= DEDUP_CONTAINMENT
            ),
            None,
        )
        if duplicate_index is not None:
            removed.append({
                "id": article["id"],
                "duplicateOf": kept[duplicate_index]["id"],
                "containment": round(
                    overlaps[duplicate_index] / min(len(grams), len(kept_grams[duplicate_index])), 4
                ),
            })
            continue
        index = len(kept)
        kept.append(article)
        kept_grams.append(grams)
        for gram in grams:
            gram_documents[gram].add(index)
    return kept, removed


def corpus_version(articles: list[dict[str, object]]) -> str:
    fingerprint = hashlib.sha256(
        "\n".join(sorted(str(article["id"]) for article in articles)).encode()
    ).hexdigest()[:10]
    return f"archive-v{VERSION}-{len(articles)}-{fingerprint}"


def build_index(articles: list[dict[str, object]], archive_version: str | None = None) -> dict[str, object]:
    inverted: dict[str, list[int]] = defaultdict(list)
    metadata: list[dict[str, object]] = []
    for index, article in enumerate(articles):
        grams = shingles(str(article["text"]))
        metadata.append({
            "id": article["id"],
            "title": article["title"],
            "sourceType": "Publication",
            "originalSimilarity": article.get("originalSimilarity"),
            "wordCount": article["wordCount"],
            "uniqueShingleCount": 0,
        })
        for gram in grams:
            inverted[gram].append(index)
    maximum_frequency = max(2, min(12, math.ceil(math.sqrt(max(1, len(articles))))))
    inverted = {
        gram_hash(gram): source_indexes
        for gram, source_indexes in inverted.items()
        if len(source_indexes) <= maximum_frequency
    }
    searchable_counts = [0] * len(articles)
    for source_indexes in inverted.values():
        for source_index in source_indexes:
            searchable_counts[source_index] += 1
    for source_index, count in enumerate(searchable_counts):
        metadata[source_index]["uniqueShingleCount"] = count
    return {
        "schema": "tplus-search-index",
        "version": VERSION,
        "keyEncoding": "fnv1a32-djb2-hex",
        "shingleSize": SHINGLE_SIZE,
        "documentCount": len(articles),
        "totalWords": sum(int(article["wordCount"]) for article in articles),
        "corpusVersion": archive_version or corpus_version(articles),
        "maximumDocumentFrequency": maximum_frequency,
        "scoreBands": [
            {"label": "Low", "minimum": 0, "maximum": 5},
            {"label": "Moderate", "minimum": 6, "maximum": 15},
            {"label": "High", "minimum": 16, "maximum": 100},
        ],
        "articles": metadata,
        "invertedIndex": inverted,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf_dir", type=Path)
    parser.add_argument("corpus_output", type=Path)
    parser.add_argument("--index-output", type=Path, required=True)
    parser.add_argument("--compressed-index-output", type=Path)
    parser.add_argument("--existing", type=Path)
    parser.add_argument("--quarantine-output", type=Path)
    parser.add_argument("--report-output", type=Path)
    args = parser.parse_args()

    articles: list[dict[str, object]] = []
    if args.existing and args.existing.exists():
        articles.extend(migrate_articles(json.loads(args.existing.read_text(encoding="utf-8"))))
    pdfs = sorted(args.pdf_dir.glob("*.pdf"))
    if pdfs:
        with ThreadPoolExecutor(max_workers=min(3, len(pdfs))) as pool:
            for article in pool.map(extract, pdfs):
                articles.append(article)
                print(
                    f"extracted {article['title']}: {article['wordCount']} words",
                    flush=True,
                )
    quarantine: list[dict[str, object]] = []
    accepted: list[dict[str, object]] = []
    for article in articles:
        quality = dict(article.get("quality", quality_metrics(str(article.get("text", "")))))
        reasons: list[str] = []
        if int(article["wordCount"]) < 100:
            reasons.append("fewer-than-100-words")
        if int(quality["score"]) < MIN_OCR_QUALITY:
            reasons.append("ocr-quality-below-threshold")
        if reasons:
            quarantine.append({
                "id": article["id"],
                "title": article["title"],
                "wordCount": article["wordCount"],
                "quality": quality,
                "reasons": reasons,
            })
        else:
            accepted.append(article)
    unique, removed = deduplicate(accepted)
    archive_version = corpus_version(unique)

    corpus = {
        "schema": SCHEMA,
        "version": VERSION,
        "shingleSize": SHINGLE_SIZE,
        "articleCount": len(unique),
        "totalWords": sum(int(article["wordCount"]) for article in unique),
        "corpusVersion": archive_version,
        "qualityThreshold": MIN_OCR_QUALITY,
        "deduplication": {
            "method": "five-gram-containment",
            "threshold": DEDUP_CONTAINMENT,
            "removed": removed,
        },
        "articles": unique,
    }
    index = build_index(unique, archive_version)
    for path, payload in ((args.corpus_output, corpus), (args.index_output, index)):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
    compressed_output = args.compressed_index_output or args.index_output.with_suffix(args.index_output.suffix + ".gz")
    compressed_output.parent.mkdir(parents=True, exist_ok=True)
    with gzip.GzipFile(filename=str(compressed_output), mode="wb", mtime=0) as stream:
        stream.write(args.index_output.read_bytes())
    quarantine_output = args.quarantine_output or args.corpus_output.with_name("quarantine.json")
    report_output = args.report_output or args.corpus_output.with_name("database-report.json")
    quarantine_output.write_text(
        json.dumps(
            {
                "schema": "turnitplus-ocr-quarantine",
                "version": VERSION,
                "qualityThreshold": MIN_OCR_QUALITY,
                "documents": quarantine,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    report_output.write_text(
        json.dumps(
            {
                "schema": "turnitplus-database-report",
                "version": VERSION,
                "corpusVersion": archive_version,
                "pdfsReceived": len(pdfs),
                "candidatesProcessed": len(articles),
                "documentsAccepted": len(unique),
                "duplicatesRemoved": len(removed),
                "documentsQuarantined": len(quarantine),
                "labeledDocuments": sum(
                    article.get("originalSimilarity") is not None for article in unique
                ),
                "totalWords": corpus["totalWords"],
                "indexedShingles": len(index["invertedIndex"]),
                "maximumDocumentFrequency": index["maximumDocumentFrequency"],
                "scoreBands": index["scoreBands"],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(
        f"{len(unique)} documents / {corpus['totalWords']} words / "
        f"{len(removed)} near-duplicates removed / {len(index['invertedIndex'])} indexed shingles"
    )


if __name__ == "__main__":
    main()
