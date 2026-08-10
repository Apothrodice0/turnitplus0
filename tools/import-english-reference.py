#!/usr/bin/env python3
"""Import a dated English-language corpus as an isolated AI reference group.

This importer deliberately does not infer a writer's first language or native
speaker status. Accepted documents receive only the ``ai-benchmark`` role and
can never affect AI calibration thresholds, false-positive rates, confidence
intervals, or the similarity index.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import tempfile
from collections import Counter
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from urllib.parse import quote, unquote

from pypdf import PdfReader


CUTOFF = "2022-11"
MINIMUM_ENGLISH_WORDS = 300
NEAR_DUPLICATE_CONTAINMENT = 0.80
BENCHMARK_STATUS = "human-reference-proxy"
REFERENCE_STATUS = "unverified-population-proxy"
BENCHMARK_ASSUMPTION = (
    "English-language academic writing published before the November 2022 cutoff and "
    "supplied by the corpus owner as a human-writing reference. Human-only authorship "
    "was not independently verified, and English publication does not establish a "
    "writer's first language or native-speaker status."
)
BENCHMARK_EXCLUSION = "reference-only: not verified AI-negative ground truth"

ENGLISH_FUNCTION_WORDS = {
    "a", "about", "after", "all", "also", "an", "and", "are", "as", "at",
    "be", "been", "between", "both", "but", "by", "can", "could", "for",
    "from", "had", "has", "have", "however", "if", "in", "into", "is", "it",
    "its", "may", "more", "most", "not", "of", "on", "or", "our", "such",
    "than", "that", "the", "their", "these", "this", "those", "through", "to",
    "using", "was", "were", "which", "while", "with", "within", "would",
}
FRENCH_FUNCTION_WORDS = {
    "alors", "au", "aux", "avec", "ce", "ces", "cette", "comme", "dans",
    "de", "des", "du", "elle", "en", "est", "et", "être", "il", "la", "le",
    "les", "leur", "mais", "nous", "ou", "par", "pas", "plus", "pour", "que",
    "qui", "sans", "ses", "sont", "sur", "une", "vers",
}
INDONESIAN_FUNCTION_WORDS = {
    "adalah", "akan", "atau", "dalam", "dan", "dari", "dengan", "ini", "itu",
    "juga", "karena", "pada", "sebagai", "tidak", "untuk", "yang",
}
MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5,
    "june": 6, "july": 7, "august": 8, "september": 9, "october": 10,
    "november": 11, "december": 12,
}


@dataclass
class Extracted:
    text: str
    method: str
    metadata: dict[str, object]
    failed_pages: list[str]


@dataclass
class PublicationEvidence:
    year: int
    value: str
    precision: str
    evidence: str


@dataclass
class Candidate:
    pdf: Path
    pdf_sha256: str
    text: str
    text_bytes: bytes
    text_sha256: str
    extraction_method: str
    failed_pages: list[str]
    metadata: dict[str, object]
    title: str
    publication: PublicationEvidence
    language_evidence: dict[str, object]
    gram_set: set[int]


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def clean_text(text: str) -> str:
    text = text.replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    return text.strip()


def latin_words(text: str) -> list[str]:
    return re.findall(r"[A-Za-zÀ-ÖØ-öø-ÿ]+(?:['’-][A-Za-zÀ-ÖØ-öø-ÿ]+)?", text.lower())


def english_words(text: str) -> list[str]:
    return re.findall(r"[A-Za-z]+(?:['’-][A-Za-z]+)?", text.lower())


def language_evidence(text: str) -> dict[str, object]:
    latin = latin_words(text)
    ascii_words = english_words(text)
    english_signals = sum(word in ENGLISH_FUNCTION_WORDS for word in latin)
    french_signals = sum(word in FRENCH_FUNCTION_WORDS for word in latin)
    indonesian_signals = sum(word in INDONESIAN_FUNCTION_WORDS for word in latin)
    arabic_words = len(re.findall(r"[\u0600-\u06ff]{2,}", text))
    cyrillic_words = len(re.findall(r"[\u0400-\u04ff]{2,}", text))
    signal_density = english_signals / max(1, len(latin))
    verified = (
        len(ascii_words) >= MINIMUM_ENGLISH_WORDS
        and english_signals >= 20
        and signal_density >= 0.08
        and english_signals >= 1.5 * max(1, french_signals)
        and english_signals >= 2.0 * max(1, indonesian_signals)
        and arabic_words <= max(25, int(len(latin) * 0.20))
        and cyrillic_words <= max(25, int(len(latin) * 0.20))
    )
    return {
        "verifiedEnglishFullText": verified,
        "latinWordCount": len(latin),
        "asciiEnglishWordCount": len(ascii_words),
        "englishFunctionWordCount": english_signals,
        "frenchFunctionWordCount": french_signals,
        "indonesianFunctionWordCount": indonesian_signals,
        "arabicWordCount": arabic_words,
        "cyrillicWordCount": cyrillic_words,
        "englishFunctionWordDensity": round(signal_density, 6),
    }


def extract_text(pdf: Path, temporary_root: Path) -> Extracted:
    reader = PdfReader(str(pdf), strict=False)
    metadata = dict(reader.metadata or {})
    text_layer = clean_text("\n\n".join((page.extract_text() or "") for page in reader.pages))
    if len(english_words(text_layer)) >= MINIMUM_ENGLISH_WORDS:
        return Extracted(text_layer, "pdf-text-layer", metadata, [])

    with tempfile.TemporaryDirectory(prefix="english-reference-", dir=temporary_root) as temporary:
        text_target = Path(temporary) / "pdftotext.txt"
        completed = subprocess.run(
            ["/usr/bin/pdftotext", "-layout", str(pdf), str(text_target)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        if completed.returncode == 0 and text_target.is_file():
            poppler_text = clean_text(text_target.read_text(encoding="utf-8", errors="replace"))
            if len(english_words(poppler_text)) > len(english_words(text_layer)):
                text_layer = poppler_text
                if len(english_words(text_layer)) >= MINIMUM_ENGLISH_WORDS:
                    return Extracted(text_layer, "pdftotext-layout", metadata, [])

        prefix = Path(temporary) / "page"
        subprocess.run(
            ["/usr/bin/pdftoppm", "-r", "150", "-png", str(pdf), str(prefix)],
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
    if len(english_words(ocr_text)) > len(english_words(text_layer)):
        return Extracted(ocr_text, "ocr-tesseract-5.3.4-150dpi", metadata, failed_pages)
    return Extracted(text_layer, "pdf-text-layer-low-confidence", metadata, failed_pages)


def evidence_line(text: str, start: int, end: int) -> str:
    line_start = text.rfind("\n", 0, start) + 1
    line_end = text.find("\n", end)
    if line_end < 0:
        line_end = min(len(text), end + 220)
    return re.sub(r"\s+", " ", text[line_start:line_end]).strip()[:400]


def publication_evidence(text: str) -> PublicationEvidence | None:
    head = text[:30000]
    month_names = "|".join(MONTHS)
    dated_patterns = [
        rf"(?:published(?:[ \t]+online)?|publication[ \t]+date)[ \t]*:?[ \t,]*(?:\n[ \t]*)?(\d{{1,2}})?(?:st|nd|rd|th)?[ \t,/-]*({month_names})[ \t,/-]+((?:19|20)\d{{2}})",
        rf"(?:published(?:[ \t]+online)?|publication[ \t]+date)[ \t]*:?[ \t,]*(?:\n[ \t]*)?({month_names})[ \t,/-]+(\d{{1,2}})?(?:st|nd|rd|th)?[ \t,/-]*((?:19|20)\d{{2}})",
        rf"\barXiv:(?:[a-z.-]+/)?(\d{{2}})(\d{{2}})\d*(?:\.\d+)?(?:v\d+)?\b",
    ]
    for index, pattern in enumerate(dated_patterns):
        match = re.search(pattern, head, re.IGNORECASE)
        if not match:
            continue
        if index == 0:
            day_text, month_text, year_text = match.groups()
            month = MONTHS[month_text.lower()]
            day = int(day_text) if day_text else None
        elif index == 1:
            month_text, day_text, year_text = match.groups()
            month = MONTHS[month_text.lower()]
            day = int(day_text) if day_text else None
        else:
            short_year, short_month = match.groups()
            short = int(short_year)
            year_text = str(2000 + short if short < 70 else 1900 + short)
            month = int(short_month)
            day = None
        year = int(year_text)
        value = f"{year:04d}-{month:02d}" + (f"-{day:02d}" if day else "")
        return PublicationEvidence(year, value, "day" if day else "month", evidence_line(head, match.start(), match.end()))

    # Only publication headers are accepted here. Broad searches for a journal-
    # sounding word followed by a year can silently pick a cited work from the
    # article body, which is precisely what provenance validation must prevent.
    year_patterns = [
        r"(?:©|Copyright|The Author\(s\))\s*(?:The Author\(s\)\s*)?\b((?:19|20)\d{2})\b",
        r"\b(?:Vol(?:ume)?\.?|Issue|No\.?)\s*\d+[^\n]{0,80}?\b((?:19|20)\d{2})\b",
        r"\b(?:TAXON|A&A|MNRAS|The Astrophysical Journal|Ann\. Hum\. Genet\.|Twin Research(?: and Human Genetics)?|JCO Global Oncol|Hepat Mon\.|Earth Syst\. Sci\. Data|Open Journal of [A-Za-z ]+|International Business Research|Journal of Intelligence Studies in Business|Revue de Traduction et Langues|OUTLINES OF GLOBAL TRANSFORMATIONS|European Psychiatry|Oral Health Dental Sci)[^\n]{0,120}?\b((?:19|20)\d{2})\b",
        r"\b(?:DIIS|Technical|Research)\s+Report\s+((?:19|20)\d{2})(?::|\b)",
        r"\bPreprint\s+((?:19|20)\d{2})\b",
        r"^\s*ntq\s+\d+:\d+\s+\([^)]*?((?:19|20)\d{2})\)[^\n]*$",
        r"^\s*[A-Z][A-Z ]{3,40}\s*\|\s*((?:19|20)\d{2})\s*\|",
        r"^\s*\d{1,2}-\d{1,2}-((?:19|20)\d{2})\s*$",
    ]
    publication_head = text[:12000]
    for pattern in year_patterns:
        match = re.search(pattern, publication_head, re.IGNORECASE | re.MULTILINE)
        if match:
            year = int(match.group(1))
            return PublicationEvidence(
                year, str(year), "year", evidence_line(publication_head, match.start(), match.end())
            )
    return None


def before_cutoff(publication: PublicationEvidence) -> bool:
    if publication.year < 2022:
        return True
    if publication.year > 2022 or publication.precision == "year":
        return False
    return publication.value[:7] < CUTOFF


def title_from(extracted: Extracted, pdf: Path) -> str:
    metadata_title = str(extracted.metadata.get("/Title") or "").strip()
    if 8 <= len(metadata_title) <= 300 and metadata_title.lower() not in {"untitled", "microsoft word"}:
        return re.sub(r"\s+", " ", metadata_title)
    for line in extracted.text[:7000].splitlines():
        candidate = re.sub(r"\s+", " ", line).strip(" -–—")
        lower = candidate.lower()
        if not 18 <= len(candidate) <= 220:
            continue
        if any(token in lower for token in ("issn", "doi:", "http://", "https://", "received", "published", "volume", "journal of")):
            continue
        if sum(char.isalpha() for char in candidate) < 12:
            continue
        return candidate
    return pdf.stem


def normalized_words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


def gram_set(text: str, size: int = 5) -> set[int]:
    words = normalized_words(text)
    result: set[int] = set()
    for index in range(max(0, len(words) - size + 1)):
        digest = hashlib.blake2b(" ".join(words[index:index + size]).encode("utf-8"), digest_size=8).digest()
        result.add(int.from_bytes(digest, "big"))
    return result


def add_to_inverted(inverted: dict[int, list[int]], grams: set[int], index: int) -> None:
    for gram in grams:
        inverted.setdefault(gram, []).append(index)


def highest_containment(
    grams: set[int], document_sets: list[set[int]], inverted: dict[int, list[int]], ids: list[str]
) -> tuple[float, str | None]:
    shared = Counter(index for gram in grams for index in inverted.get(gram, []))
    best_score = 0.0
    best_id: str | None = None
    for index, count in shared.items():
        score = count / max(1, min(len(grams), len(document_sets[index])))
        if score > best_score:
            best_score = score
            best_id = ids[index]
    return best_score, best_id


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", type=Path, default=Path("."))
    parser.add_argument("--pdf-dir", type=Path, required=True)
    parser.add_argument("--source-uri", required=True)
    parser.add_argument("--reference-group", required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--replace-existing", action="store_true")
    args = parser.parse_args()

    project = args.project.resolve()
    pdf_dir = args.pdf_dir.resolve()
    corpus = project / "corpus"
    manifest_path = corpus / "manifest.json"
    report_path = corpus / "import-report.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    report = json.loads(report_path.read_text(encoding="utf-8"))
    pdfs = sorted(pdf_dir.glob("*.pdf"), key=lambda value: value.name.casefold())
    if not pdfs:
        raise SystemExit(f"No PDFs found in {pdf_dir}")

    previous_entries = [entry for entry in manifest if entry.get("referenceGroup") == args.reference_group]
    if previous_entries and not args.replace_existing:
        raise SystemExit("This reference group already exists; pass --replace-existing to rebuild it.")
    base_manifest = [entry for entry in manifest if entry.get("referenceGroup") != args.reference_group]
    existing_ids = {str(entry["id"]) for entry in base_manifest}
    existing_pdf_hashes = {
        str(entry.get("provenance", {}).get("pdfSha256")): str(entry["id"])
        for entry in base_manifest if entry.get("provenance", {}).get("pdfSha256")
    }
    existing_text_hashes = {
        str(entry.get("provenance", {}).get("sha256")): str(entry["id"])
        for entry in base_manifest if entry.get("provenance", {}).get("sha256")
    }
    evaluation_entries = [
        entry for entry in base_manifest
        if any(role in {"ai-negative", "ai-benchmark", "ai-positive", "ai-hybrid"} for role in entry.get("roles", []))
    ]
    comparison_sets: list[set[int]] = []
    comparison_ids: list[str] = []
    inverted: dict[int, list[int]] = {}
    for entry in evaluation_entries:
        path = corpus / str(entry["textPath"])
        grams = gram_set(path.read_text(encoding="utf-8"))
        index = len(comparison_sets)
        comparison_sets.append(grams)
        comparison_ids.append(str(entry["id"]))
        add_to_inverted(inverted, grams, index)

    temporary_root = project / "tmp"
    temporary_root.mkdir(parents=True, exist_ok=True)
    rejected: list[dict[str, object]] = []
    candidates: list[Candidate] = []
    for position, pdf in enumerate(pdfs, start=1):
        reasons: list[str] = []
        pdf_digest = sha256(pdf.read_bytes())
        if duplicate_id := existing_pdf_hashes.get(pdf_digest):
            rejected.append({"file": pdf.name, "reasons": ["exact-pdf-duplicate"], "duplicateOf": duplicate_id})
            print(f"[{position:03d}/{len(pdfs):03d}] reject exact PDF duplicate: {pdf.name}", flush=True)
            continue
        try:
            extracted = extract_text(pdf, temporary_root)
        except Exception as error:  # preserve the concrete parser failure in the report
            rejected.append({"file": pdf.name, "reasons": ["full-text-extraction-failed"], "detail": str(error)[:500]})
            print(f"[{position:03d}/{len(pdfs):03d}] reject extraction failure: {pdf.name}", flush=True)
            continue
        evidence = language_evidence(extracted.text)
        if not evidence["verifiedEnglishFullText"]:
            reasons.append("english-full-text-not-verified")
        publication = publication_evidence(extracted.text)
        if publication is None:
            reasons.append("publication-date-not-verified")
        elif not before_cutoff(publication):
            reasons.append("publication-not-before-2022-11")
        clean = f"{extracted.text}\n".encode("utf-8")
        text_digest = sha256(clean)
        if duplicate_id := existing_text_hashes.get(text_digest):
            reasons.append("exact-text-duplicate")
        if reasons:
            record: dict[str, object] = {
                "file": pdf.name,
                "reasons": reasons,
                "publicationEvidence": publication.__dict__ if publication else None,
                "languageEvidence": evidence,
                "extractionMethod": extracted.method,
            }
            if duplicate_id := existing_text_hashes.get(text_digest):
                record["duplicateOf"] = duplicate_id
            rejected.append(record)
            print(f"[{position:03d}/{len(pdfs):03d}] reject {', '.join(reasons)}: {pdf.name}", flush=True)
            continue
        assert publication is not None
        candidates.append(Candidate(
            pdf=pdf,
            pdf_sha256=pdf_digest,
            text=extracted.text,
            text_bytes=clean,
            text_sha256=text_digest,
            extraction_method=extracted.method,
            failed_pages=extracted.failed_pages,
            metadata=extracted.metadata,
            title=title_from(extracted, pdf),
            publication=publication,
            language_evidence=evidence,
            gram_set=gram_set(extracted.text),
        ))
        print(f"[{position:03d}/{len(pdfs):03d}] candidate: {pdf.name}", flush=True)

    accepted: list[Candidate] = []
    for candidate in sorted(candidates, key=lambda value: (len(value.gram_set), value.pdf.name.casefold())):
        score, duplicate_id = highest_containment(candidate.gram_set, comparison_sets, inverted, comparison_ids)
        if score >= NEAR_DUPLICATE_CONTAINMENT:
            rejected.append({
                "file": candidate.pdf.name,
                "reasons": ["near-duplicate-text"],
                "duplicateOf": duplicate_id,
                "fiveGramContainment": round(score, 6),
            })
            continue
        index = len(comparison_sets)
        comparison_sets.append(candidate.gram_set)
        comparison_ids.append(f"pending:{candidate.pdf.name}")
        add_to_inverted(inverted, candidate.gram_set, index)
        accepted.append(candidate)

    entries: list[dict[str, object]] = []
    for candidate in accepted:
        name_digest = sha256(candidate.pdf.name.encode("utf-8"))
        document_id = f"english-reference-{candidate.pdf_sha256[:12]}-{name_digest[:6]}"
        if document_id in existing_ids:
            raise SystemExit(f"Document id collision: {document_id}")
        relative = Path("ai-benchmark/text") / f"{document_id}.txt"
        entries.append({
            "id": document_id,
            "roles": ["ai-benchmark"],
            "textPath": relative.as_posix(),
            "title": candidate.title,
            "language": "English",
            "publishedYear": candidate.publication.year,
            "turnitinScore": None,
            "writerPopulation": None,
            "writerPopulationBasis": None,
            "benchmarkStatus": BENCHMARK_STATUS,
            "referenceStatus": REFERENCE_STATUS,
            "referenceGroup": args.reference_group,
            "benchmarkAssumption": BENCHMARK_ASSUMPTION,
            "benchmarkExclusionReasons": [BENCHMARK_EXCLUSION],
            "genre": "published-article",
            "discipline": None,
            "provenance": {
                "source": f"user-supplied {unquote(args.source_uri.rsplit('/', 1)[-1])}",
                "url": f"{args.source_uri}#{quote(candidate.pdf.name)}",
                "journal": None,
                "retrievedAt": str(date.today()),
                "sha256": candidate.text_sha256,
                "pdfSha256": candidate.pdf_sha256,
                "extractionMethod": candidate.extraction_method,
                "ocrFailedPages": candidate.failed_pages,
                "publicationDateValue": candidate.publication.value,
                "publicationDatePrecision": candidate.publication.precision,
                "publicationDateEvidence": candidate.publication.evidence,
                "languageEvidence": candidate.language_evidence,
            },
        })
        existing_ids.add(document_id)

    reason_counts = Counter(reason for record in rejected for reason in record["reasons"])
    batch = {
        "sourceUri": args.source_uri,
        "referenceGroup": args.reference_group,
        "role": "ai-benchmark",
        "referenceStatus": REFERENCE_STATUS,
        "inputDocuments": len(pdfs),
        "acceptedCount": len(entries),
        "rejectedCount": len(rejected),
        "rejectionReasonCounts": dict(sorted(reason_counts.items())),
        "minimumEnglishWords": MINIMUM_ENGLISH_WORDS,
        "publicationCutoff": CUTOFF,
        "nearDuplicateContainmentThreshold": NEAR_DUPLICATE_CONTAINMENT,
        "decisionUse": "Exploratory English-language human-reference score distribution only.",
        "excludedUse": "Does not affect calibration negatives, FPR, thresholds, confidence intervals, or similarity indexing.",
        "acceptedIds": [entry["id"] for entry in entries],
        "rejected": sorted(rejected, key=lambda record: str(record["file"]).casefold()),
    }
    print(json.dumps({key: batch[key] for key in (
        "inputDocuments", "acceptedCount", "rejectedCount", "rejectionReasonCounts"
    )}, indent=2))
    if args.dry_run:
        print("Dry run: corpus files were not changed.")
        return

    for previous in previous_entries:
        previous_path = corpus / str(previous["textPath"])
        if previous_path.is_file():
            previous_path.unlink()
    for entry, candidate in zip(entries, accepted, strict=True):
        target = corpus / str(entry["textPath"])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(candidate.text_bytes)
    manifest_path.write_text(
        json.dumps(sorted(base_manifest + entries, key=lambda entry: str(entry["id"])), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    batches = [item for item in report.setdefault("batches", []) if item.get("referenceGroup") != args.reference_group]
    report["batches"] = batches
    batches.append(batch)
    report["aiBenchmarkDocuments"] = len([
        entry for entry in base_manifest + entries if "ai-benchmark" in entry.get("roles", [])
    ])
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Imported {len(entries)} English reference documents; rejected {len(rejected)}.")


if __name__ == "__main__":
    main()
