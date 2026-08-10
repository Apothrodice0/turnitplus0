#!/usr/bin/env python3
"""Extract visibly highlighted passages from similarity-report PDFs."""

from __future__ import annotations

import csv
import io
import json
import re
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pdfplumber
from PIL import Image

STOPWORDS = {
    "a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of",
    "on", "or", "the", "to", "with",
}
BENCHMARK_SCHEMA = "tplus-highlight-benchmark"
BENCHMARK_VERSION = 3


def command(*args: str) -> str:
    return subprocess.run(
        args, check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True
    ).stdout


def page_count(pdf: Path) -> int:
    info = command("pdfinfo", str(pdf))
    return int(re.search(r"^Pages:\s+(\d+)", info, re.M).group(1))


def page_text(pdf: Path, page: int) -> str:
    return command("pdftotext", "-f", str(page), "-l", str(page), "-layout", str(pdf), "-")


def article_pages(pdf: Path) -> list[int]:
    pages = range(1, page_count(pdf) + 1)
    texts = {page: page_text(pdf, page) for page in pages}
    submission = [
        page for page, text in texts.items() if re.search(r"Integrity Submission", text, re.I)
    ]
    if submission:
        return submission

    selected: list[int] = []
    for page in range(2, page_count(pdf) + 1):
        text = texts[page]
        if re.search(r"ORIGINALITY REPORT|PRIMARY SOURCES", text, re.I):
            break
        selected.append(page)
    return selected


def colored_fraction(image: Image.Image, box: tuple[int, int, int, int]) -> float:
    x, y, width, height = box
    crop = image.crop(
        (
            max(0, x - 2),
            max(0, y - 2),
            min(image.width, x + width + 2),
            min(image.height, y + height + 2),
        )
    )
    pixels = list(crop.get_flattened_data())
    colored = sum(
        1
        for red, green, blue in pixels
        if max(red, green, blue) - min(red, green, blue) > 10
        and min(red, green, blue) > 145
        and max(red, green, blue) < 254
    )
    return colored / max(1, len(pixels))


def normalize_passage(words: list[str]) -> str:
    text = " ".join(words)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    return re.sub(r"\s+", " ", text).strip(" -")


def extract_runs(lines: dict[tuple[object, ...], list[tuple[str, bool]]]) -> list[str]:
    passages: list[str] = []
    for line in lines.values():
        index = 0
        while index < len(line):
            if not line[index][1]:
                index += 1
                continue
            run = [line[index][0]]
            index += 1
            while index < len(line):
                word, highlighted = line[index]
                if highlighted:
                    run.append(word)
                    index += 1
                    continue
                if (
                    word.lower().strip(".,;:!?()[]{}") in STOPWORDS
                    and index + 1 < len(line)
                    and line[index + 1][1]
                ):
                    run.append(word)
                    index += 1
                    continue
                break
            passage = normalize_passage(run)
            tokens = re.findall(r"\b[\w'-]+\b", passage, re.UNICODE)
            alphabetic = sum(any(character.isalpha() for character in token) for token in tokens)
            suspicious = sum(
                len(token) == 1 and not token.isalpha()
                or bool(re.search(r"\d", token) and re.search(r"[A-Za-z]", token))
                or len(re.findall(r"[^A-Za-zÀ-ÖØ-öø-ÿ'-]", token)) > len(token) * 0.25
                for token in tokens
            )
            if (
                len(tokens) >= 6
                and alphabetic / max(1, len(tokens)) >= 0.85
                and suspicious / max(1, len(tokens)) <= 0.10
            ):
                passages.append(passage)
    return passages


def extract_pdf_words(image: Image.Image, pdf_page: pdfplumber.page.Page) -> list[str]:
    words = pdf_page.extract_words(
        x_tolerance=1.5,
        y_tolerance=2,
        keep_blank_chars=False,
        use_text_flow=True,
    )
    if len(words) < 80:
        return []
    scale_x = image.width / float(pdf_page.width)
    scale_y = image.height / float(pdf_page.height)
    lines: dict[tuple[object, ...], list[tuple[str, bool]]] = {}
    for word in words:
        box = (
            round(float(word["x0"]) * scale_x),
            round(float(word["top"]) * scale_y),
            max(1, round((float(word["x1"]) - float(word["x0"])) * scale_x)),
            max(1, round((float(word["bottom"]) - float(word["top"])) * scale_y)),
        )
        highlighted = colored_fraction(image, box) >= 0.16
        line_key = (round(float(word["top"]) / 3) * 3,)
        lines.setdefault(line_key, []).append((str(word["text"]), highlighted))
    return extract_runs(lines)


def extract_ocr_words(image: Image.Image, image_path: Path) -> list[str]:
    image = Image.open(image_path).convert("RGB")
    tsv = subprocess.run(
        ["tesseract", str(image_path), "stdout", "--psm", "6", "tsv"],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    ).stdout
    words = [
        row
        for row in csv.DictReader(io.StringIO(tsv), delimiter="\t")
        if row.get("level") == "5" and row.get("text", "").strip()
    ]

    lines: dict[tuple[str, str, str], list[tuple[str, bool]]] = {}
    for row in words:
        confidence = float(row.get("conf", "-1"))
        if confidence < 75:
            continue
        box = tuple(int(row[key]) for key in ("left", "top", "width", "height"))
        highlighted = colored_fraction(image, box) >= 0.16
        key = (row["block_num"], row["par_num"], row["line_num"])
        lines.setdefault(key, []).append((row["text"], highlighted))

    return extract_runs(lines)


def extract_page(image_path: Path, pdf_page: pdfplumber.page.Page) -> tuple[list[str], str]:
    image = Image.open(image_path).convert("RGB")
    text_layer_passages = extract_pdf_words(image, pdf_page)
    if text_layer_passages:
        return text_layer_passages, "text-layer"
    return extract_ocr_words(image, image_path), "ocr-fallback"


def extract_report(pdf: Path) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="highlight-pages-") as folder:
        temp = Path(folder)
        pages = article_pages(pdf)
        passages: list[str] = []
        extraction_methods = {"text-layer": 0, "ocr-fallback": 0}
        with pdfplumber.open(pdf) as document:
            for page in pages:
                prefix = temp / f"page-{page}"
                subprocess.run(
                    [
                        "pdftoppm", "-f", str(page), "-l", str(page), "-jpeg",
                        "-r", "150", "-singlefile", str(pdf), str(prefix),
                    ],
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                extracted, method = extract_page(
                    prefix.with_suffix(".jpg"), document.pages[page - 1]
                )
                passages.extend(extracted)
                extraction_methods[method] += 1

    unique: list[str] = []
    seen: set[str] = set()
    for passage in passages:
        key = re.sub(r"\W+", " ", passage.lower()).strip()
        if key and key not in seen:
            unique.append(passage)
            seen.add(key)
    return {
        "id": pdf.stem.lower().replace(" ", "-"),
        "title": pdf.stem.title(),
        "passages": unique,
        "passageCount": len(unique),
        "wordCount": sum(len(re.findall(r"\b[\w'-]+\b", item)) for item in unique),
        "extractionMethods": extraction_methods,
    }


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: extract-highlight-corpus.py PDF_DIR OUTPUT_JSON")
    pdf_dir = Path(sys.argv[1])
    output = Path(sys.argv[2])
    pdfs = sorted(pdf_dir.glob("*.pdf"))
    reports: list[dict[str, object]] = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(extract_report, pdf): pdf for pdf in pdfs}
        for future in as_completed(futures):
            report = future.result()
            reports.append(report)
            print(f"{report['id']}: {report['passageCount']} passages", flush=True)
    reports.sort(key=lambda report: str(report["id"]))
    payload = {
        "schema": BENCHMARK_SCHEMA,
        "version": BENCHMARK_VERSION,
        "reportCount": len(reports),
        "passageCount": sum(int(report["passageCount"]) for report in reports),
        "totalWords": sum(int(report["wordCount"]) for report in reports),
        "reports": reports,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"wrote {payload['reportCount']} reports / {payload['passageCount']} passages "
        f"/ {payload['totalWords']} highlighted words"
    )


if __name__ == "__main__":
    main()
