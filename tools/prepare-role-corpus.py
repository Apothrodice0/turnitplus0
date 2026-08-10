#!/usr/bin/env python3
"""Create physically separated similarity and AI-negative text samples.

No missing metadata is defaulted. AI PDFs that cannot prove every required
field are recorded in corpus/import-report.json and excluded from the manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import unicodedata
from pathlib import Path
from urllib.parse import quote, unquote

from pypdf import PdfReader


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def normalized_text_hash(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return sha256(normalized.encode("utf-8"))


def write_text(path: Path, text: str) -> str:
    clean = text.replace("\x00", "").strip() + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(clean, encoding="utf-8")
    return sha256(clean.encode("utf-8"))


def similarity_entries(project: Path) -> list[dict[str, object]]:
    payload = json.loads((project / "data/document-corpus.json").read_text(encoding="utf-8"))
    entries: list[dict[str, object]] = []
    for article in payload["articles"]:
        document_id = str(article["id"])
        relative = Path("similarity/text") / f"{document_id}.txt"
        text = str(article["text"])
        digest = write_text(project / "corpus" / relative, text)
        score = article.get("originalSimilarity")
        roles = ["index-source"]
        if score is not None:
            roles.append("similarity-calibration")
        entries.append({
            "id": document_id,
            "roles": roles,
            "textPath": relative.as_posix(),
            "title": article.get("title"),
            "language": None,
            "publishedYear": None,
            "turnitinScore": score,
            "writerPopulation": None,
            "genre": None,
            "discipline": None,
            "provenance": {
                "source": "data/document-corpus.json",
                "url": None,
                "journal": None,
                "retrievedAt": None,
                "sha256": digest,
            },
        })
    return entries


def first_pages(reader: PdfReader, count: int = 2) -> str:
    return "\n".join((page.extract_text() or "") for page in reader.pages[:count])


def full_text(reader: PdfReader) -> str:
    return "\n\n".join((page.extract_text() or "") for page in reader.pages)


def published_year_from_header(head: str) -> int | None:
    match = re.search(
        r"Published(?:\s+online)?\s*:\s*(?:\d{1,2}(?:st|nd|rd|th)?\s+)?"
        r"(?:January|February|March|April|May|June|July|August|September|October|November|December)?"
        r"\s*((?:19|20)\d{2})",
        head[:5000],
        re.IGNORECASE,
    )
    return int(match.group(1)) if match else None


def ai_entries(
    project: Path,
    pdf_dir: Path,
    source_uri: str,
    existing_ai: list[dict[str, object]],
    population: str,
    native_review: dict[str, dict[str, object]],
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    entries: list[dict[str, object]] = []
    rejected: list[dict[str, object]] = []
    seen_text: dict[str, str] = {}
    for entry in existing_ai:
        text_path = project / "corpus" / str(entry["textPath"])
        seen_text[normalized_text_hash(text_path.read_text(encoding="utf-8"))] = str(entry["id"])

    for pdf in sorted(pdf_dir.glob("*.pdf"), key=lambda path: path.name.casefold()):
        reasons: list[str] = []
        review = native_review.get(pdf.name) if population == "native-english" else None
        try:
            reader = PdfReader(str(pdf))
            metadata = reader.metadata or {}
            head = first_pages(reader)
            text = full_text(reader).replace("\x00", "").strip()
        except Exception as error:
            rejected.append({"file": pdf.name, "reasons": [f"pdf-read-error: {error}"]})
            continue

        creation = str(metadata.get("/CreationDate", ""))
        if review is not None:
            reviewed_year = review.get("publishedYear")
            year = int(reviewed_year) if isinstance(reviewed_year, int) else None
            publication_year_evidence = str(review.get("publicationDateEvidence") or "")
            if year is not None and not re.search(rf"(?<!\d){year}(?!\d)", head[:5000]):
                reasons.append("reviewed-publication-year-not-found-on-first-pages")
        elif population == "native-english":
            year = published_year_from_header(head)
            publication_year_evidence = ""
        else:
            year_match = re.search(r"D:((?:19|20)\d{2})", creation)
            year = int(year_match.group(1)) if year_match else None
            publication_year_evidence = (
                f"PDF CreationDate {creation}; the same year appears in the article header."
            )
        if year is None:
            reasons.append("missing-verifiable-publication-year")
        elif year >= 2022:
            reasons.append("publication-year-not-before-2022")
        elif population == "L2-algerian" and not re.search(rf"(?<!\d){year}(?!\d)", head[:2500]):
            reasons.append("metadata-year-not-confirmed-in-article-header")

        if population == "L2-algerian":
            affiliation = bool(re.search(
                r"(?:university|universit.|centre universitaire|higher school|school|laboratory|faculty|department)"
                r"[^\n]{0,160}(?:algeria|alg.rie)|\(\s*Algeria\s*\)",
                head[:4000], re.IGNORECASE,
            ))
            writer_population_basis = (
                "At least one author affiliation on the first two pages names Algeria; "
                "this is a proxy, not the writer's verified first language."
            )
            if not affiliation:
                reasons.append("no-algerian-author-affiliation-evidence")
        else:
            writer_population_basis = str(review.get("writerPopulationBasis") or "") if review else ""
            if review is None or not writer_population_basis:
                reasons.append("native-speaker-affiliation-proxy-not-approved")

        english_signals = sum(
            len(re.findall(rf"\b{word}\b", head[:6000], re.IGNORECASE))
            for word in ("the", "and", "of", "in", "to", "is", "for", "this")
        )
        if english_signals < 20:
            reasons.append("english-language-not-verified")
        if len(re.findall(r"\b[A-Za-z]+\b", text)) < 300:
            reasons.append("fewer-than-300-english-words")

        text_fingerprint = normalized_text_hash(text) if text else ""
        if text_fingerprint in seen_text:
            reasons.append(f"duplicate-text-of:{seen_text[text_fingerprint]}")

        if reasons:
            rejected.append({"file": pdf.name, "reasons": reasons})
            continue

        document_id = f"ai-{text_fingerprint[:16]}"
        seen_text[text_fingerprint] = document_id
        relative = Path("ai-negative/text") / f"{document_id}.txt"
        digest = write_text(project / "corpus" / relative, text)
        reviewed_title = str(review.get("title") or "").strip() if review else ""
        title = reviewed_title or str(metadata.get("/Title") or pdf.stem).strip() or pdf.stem
        entries.append({
            "id": document_id,
            "roles": ["ai-negative"],
            "textPath": relative.as_posix(),
            "title": title,
            "language": "English",
            "publishedYear": year,
            "turnitinScore": None,
            "writerPopulation": population,
            "writerPopulationBasis": writer_population_basis,
            "genre": "published-article",
            "discipline": None,
            "provenance": {
                "source": f"user-supplied {unquote(source_uri.rsplit('/', 1)[-1])}",
                "url": f"{source_uri}#{quote(pdf.name)}",
                "journal": None,
                "retrievedAt": "2026-08-07",
                "sha256": digest,
                "pdfSha256": sha256(pdf.read_bytes()),
                "publicationYearEvidence": publication_year_evidence,
            },
        })
    return entries, rejected


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", type=Path, default=Path("."))
    parser.add_argument("--ai-pdf-dir", type=Path, required=True)
    parser.add_argument("--source-uri", required=True)
    parser.add_argument("--population", choices=("L2-algerian", "native-english"), default="L2-algerian")
    parser.add_argument("--native-review", type=Path)
    args = parser.parse_args()
    project = args.project.resolve()
    corpus = project / "corpus"
    labels = corpus / "labels.json"
    if labels.exists():
        raise SystemExit("corpus/labels.json exists; migrate it explicitly rather than overwriting it.")

    manifest_path = corpus / "manifest.json"
    if manifest_path.exists():
        existing_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(existing_manifest, list):
            raise SystemExit("corpus/manifest.json must contain an array.")
    else:
        existing_manifest = similarity_entries(project)
    existing_ai = [entry for entry in existing_manifest if "ai-negative" in entry.get("roles", [])]
    native_review: dict[str, dict[str, object]] = {}
    if args.population == "native-english":
        if args.native_review is None:
            raise SystemExit("--native-review is required for native-english imports.")
        review_payload = json.loads(args.native_review.read_text(encoding="utf-8"))
        if review_payload.get("sourceUri") != args.source_uri:
            raise SystemExit("The native review sourceUri does not match --source-uri.")
        approved = review_payload.get("approved")
        if not isinstance(approved, list):
            raise SystemExit("The native review must contain an approved array.")
        native_review = {str(entry["file"]): entry for entry in approved}
        if len(native_review) != len(approved):
            raise SystemExit("The native review contains duplicate filenames.")
    ai, rejected = ai_entries(
        project,
        args.ai_pdf_dir.resolve(),
        args.source_uri,
        existing_ai,
        args.population,
        native_review,
    )
    existing_ids = {str(entry["id"]) for entry in existing_manifest}
    collisions = [entry for entry in ai if str(entry["id"]) in existing_ids]
    if collisions:
        raise SystemExit(f"Generated {len(collisions)} ids already present in the manifest.")
    manifest = sorted(existing_manifest + ai, key=lambda entry: str(entry["id"]))
    (corpus / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    report_path = corpus / "import-report.json"
    prior_batches: list[dict[str, object]] = []
    if report_path.exists():
        prior_report = json.loads(report_path.read_text(encoding="utf-8"))
        if isinstance(prior_report.get("batches"), list):
            prior_batches = prior_report["batches"]
        elif prior_report.get("version") == 1:
            prior_batches = [{
                "batchId": "initial-import",
                "sourceUri": None,
                "acceptedCount": prior_report.get("aiNegativeDocuments"),
                "rejectedCount": prior_report.get("rejectedAiDocuments"),
                "rejected": prior_report.get("rejected", []),
            }]
    batch_id = sha256(args.source_uri.encode("utf-8"))[:12]
    if any(batch.get("batchId") == batch_id for batch in prior_batches):
        raise SystemExit(f"Source batch {batch_id} has already been imported.")
    batch = {
        "batchId": batch_id,
        "sourceUri": args.source_uri,
        "writerPopulation": args.population,
        "inputDocuments": len(list(args.ai_pdf_dir.resolve().glob("*.pdf"))),
        "acceptedCount": len(ai),
        "rejectedCount": len(rejected),
        "rejected": rejected,
    }
    all_ai = [entry for entry in manifest if "ai-negative" in entry.get("roles", [])]
    similarity_count = len([entry for entry in manifest if "index-source" in entry.get("roles", [])])
    report_path.write_text(json.dumps({
        "schema": "turnitplus-corpus-import-report",
        "version": 2,
        "similarityDocuments": similarity_count,
        "aiNegativeDocuments": len(all_ai),
        "batches": prior_batches + [batch],
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"similarity={similarity_count} existing-ai-negative={len(existing_ai)} "
        f"accepted-new-ai={len(ai)} rejected-new-ai={len(rejected)} total-ai-negative={len(all_ai)}"
    )


if __name__ == "__main__":
    main()
