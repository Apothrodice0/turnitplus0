#!/usr/bin/env python3
"""Import labelled Turnitin reports without collapsing genuine revisions.

Every report remains an auditable observation. Reports for substantially the
same article share ``revisionGroupId`` so calibration excludes the whole group
when scoring any member. Only one representative per group enters the search
index, preventing revisions from inflating document frequency or appearing as
several indistinguishable sources in the product.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import unicodedata
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


REVISION_CONTAINMENT = 0.50
SAME_TITLE_MINIMUM_CONTAINMENT = 0.15
GENERIC_TITLES = {"article", "article docx", "paper", "document", "manuscript"}


def load_extractor(project: Path):
    script = project / "scripts" / "build-document-corpus.py"
    spec = importlib.util.spec_from_file_location("turnitplus_document_builder", script)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {script}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    raster_fallback = module.ocr_page

    def ocr_embedded_page(pdf: Path, page: int, folder: Path) -> str:
        prefix = folder / f"embedded-{page}"
        subprocess.run(
            ["pdfimages", "-f", str(page), "-l", str(page), "-png", str(pdf), str(prefix)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=60,
        )
        candidates = sorted(folder.glob(f"embedded-{page}-*.png"), key=lambda path: path.stat().st_size, reverse=True)
        if not candidates:
            return raster_fallback(pdf, page, folder)
        environment = dict(os.environ)
        environment["OMP_THREAD_LIMIT"] = "1"
        return subprocess.run(
            [
                "tesseract",
                str(candidates[0]),
                "stdout",
                "--psm",
                "6",
                "-c",
                "preserve_interword_spaces=1",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=120,
            env=environment,
        ).stdout

    module.ocr_page = ocr_embedded_page
    return module


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def clean_title(value: str) -> str:
    value = re.sub(r"\.(?:docx?|pdf)\s*$", "", value.strip(), flags=re.I)
    value = re.sub(r"\s+", " ", value).strip(" -_")
    return value


def normalized_title(value: str) -> str:
    value = unicodedata.normalize("NFKD", clean_title(value)).casefold()
    value = "".join(character for character in value if not unicodedata.combining(character))
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def slug(value: str) -> str:
    normalized = normalized_title(value)
    return re.sub(r"[^a-z0-9]+", "-", normalized).strip("-")[:96] or "document"


def report_cover_text(pdf: Path) -> str:
    import subprocess

    return subprocess.run(
        ["pdftotext", "-f", "1", "-l", "1", "-layout", str(pdf), "-"],
        check=True,
        capture_output=True,
        text=True,
        timeout=45,
    ).stdout


def report_metadata(pdf: Path, text: str) -> dict[str, object]:
    submission_id = re.search(r"Submission ID:\s*([0-9]+)", text, re.I)
    submission_date = re.search(r"Submission date:\s*([^\n\r]+)", text, re.I)
    return {
        "sourceFile": pdf.name,
        "reportSha256": sha256_bytes(pdf.read_bytes()),
        "submissionId": submission_id.group(1) if submission_id else None,
        "submissionDate": submission_date.group(1).strip() if submission_date else None,
    }


def write_text(path: Path, text: str) -> str:
    payload = text.replace("\x00", "").strip() + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload, encoding="utf-8")
    return sha256_bytes(payload.encode("utf-8"))


def containment(left: set[str], right: set[str]) -> float:
    small, large = (left, right) if len(left) <= len(right) else (right, left)
    return sum(gram in large for gram in small) / max(1, len(small))


class UnionFind:
    def __init__(self, size: int):
        self.parent = list(range(size))

    def find(self, value: int) -> int:
        if self.parent[value] != value:
            self.parent[value] = self.find(self.parent[value])
        return self.parent[value]

    def join(self, left: int, right: int) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root != right_root:
            self.parent[right_root] = left_root


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf_dir", type=Path)
    parser.add_argument("--project", type=Path, default=Path("."))
    parser.add_argument("--source-name", required=True)
    parser.add_argument("--retrieved-at", required=True)
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()

    project = args.project.resolve()
    pdf_dir = args.pdf_dir.resolve()
    extractor = load_extractor(project)
    manifest_path = project / "corpus" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, list):
        raise SystemExit("corpus/manifest.json must contain an array")

    existing_ids = {str(entry["id"]) for entry in manifest}
    existing_similarity = [
        entry for entry in manifest if "similarity-calibration" in entry.get("roles", [])
    ]
    existing_index_ids = {
        str(entry["id"]) for entry in manifest if "index-source" in entry.get("roles", [])
    }

    pdfs = sorted(
        pdf_dir.glob("*.pdf"),
        key=lambda path: int(re.sub(r"\D", "", path.stem) or 0),
    )
    audit_rows: list[dict[str, object]] = []
    eligible: list[tuple[Path, dict[str, object], dict[str, object]]] = []
    for scan_index, pdf in enumerate(pdfs, start=1):
        print(f"[scan {scan_index}/{len(pdfs)}] {pdf.name}", flush=True)
        cover_text = report_cover_text(pdf)
        pages, title, score = extractor.report_layout(pdf)
        metadata = report_metadata(pdf, cover_text)
        reasons: list[str] = []
        if score is None:
            reasons.append("not-a-turnitin-similarity-report-or-score-missing")
        if not pages:
            reasons.append("missing-submission-pages")
        if reasons:
            audit_rows.append({**metadata, "status": "quarantined", "reasons": reasons})
            continue
        eligible.append((pdf, {"pages": pages, "title": title, "score": score}, metadata))

    extracted: list[dict[str, object]] = []
    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, len(eligible)))) as pool:
        futures = {pool.submit(extractor.extract, pdf): (pdf, layout, metadata) for pdf, layout, metadata in eligible}
        for completed, future in enumerate(as_completed(futures), start=1):
            pdf, layout, metadata = futures[future]
            try:
                article = future.result()
            except Exception as error:  # pragma: no cover - operational audit path
                audit_rows.append({**metadata, "status": "quarantined", "reasons": [f"extraction-error:{error}"]})
                continue
            article["title"] = clean_title(str(article["title"]))
            if normalized_title(str(article["title"])) in GENERIC_TITLES:
                article["title"] = extractor.fallback_title(str(article["text"]), str(article["title"]))
            article["turnitinScore"] = int(layout["score"])
            article["sourceFile"] = pdf.name
            article["reportMetadata"] = metadata
            article["textSha256Normalized"] = sha256_bytes(
                extractor.normalize(str(article["text"])).encode("utf-8")
            )
            extracted.append(article)
            print(
                f"[{completed}/{len(eligible)}] {pdf.name}: {article['wordCount']} words, "
                f"quality {article['quality']['score']}, Turnitin {article['turnitinScore']}%",
                flush=True,
            )

    extracted.sort(key=lambda article: int(re.sub(r"\D", "", str(article["sourceFile"])) or 0))
    accepted: list[dict[str, object]] = []
    for article in extracted:
        reasons: list[str] = []
        if int(article["wordCount"]) < 100:
            reasons.append("fewer-than-100-words")
        if int(article["quality"]["score"]) < extractor.MIN_OCR_QUALITY:
            reasons.append("ocr-quality-below-threshold")
        if reasons:
            audit_rows.append({
                **article["reportMetadata"],
                "status": "quarantined",
                "title": article["title"],
                "turnitinScore": article["turnitinScore"],
                "wordCount": article["wordCount"],
                "quality": article["quality"],
                "reasons": reasons,
            })
        else:
            accepted.append(article)

    # Build revision groups across prior and new labelled samples. Existing
    # near-duplicate groups are preserved by their current revisionGroupId.
    nodes: list[dict[str, object]] = []
    for entry in existing_similarity:
        text = (project / "corpus" / str(entry["textPath"])).read_text(encoding="utf-8")
        nodes.append({
            "kind": "existing",
            "id": str(entry["id"]),
            "title": str(entry.get("title") or entry["id"]),
            "text": text,
            "grams": extractor.shingles(text),
            "revisionGroupId": entry.get("revisionGroupId"),
        })
    for article in accepted:
        document_id = f"turnitin-{slug(str(article['title']))}-{article['textSha256Normalized'][:12]}"
        suffix = 2
        base_id = document_id
        while document_id in existing_ids or any(node["id"] == document_id for node in nodes):
            document_id = f"{base_id}-{suffix}"
            suffix += 1
        article["id"] = document_id
        nodes.append({
            "kind": "new",
            "id": document_id,
            "title": article["title"],
            "text": article["text"],
            "grams": extractor.shingles(str(article["text"])),
            "article": article,
            "revisionGroupId": None,
        })

    union = UnionFind(len(nodes))
    pair_evidence: list[dict[str, object]] = []
    for left in range(len(nodes)):
        for right in range(left + 1, len(nodes)):
            left_node = nodes[left]
            right_node = nodes[right]
            # Existing unrelated rows need not be re-clustered here; their
            # validated duplicate map remains the authority for the old set.
            if left_node["kind"] == right_node["kind"] == "existing":
                if left_node.get("revisionGroupId") and left_node["revisionGroupId"] == right_node.get("revisionGroupId"):
                    union.join(left, right)
                continue
            score = containment(left_node["grams"], right_node["grams"])
            same_title = (
                normalized_title(str(left_node["title"])) == normalized_title(str(right_node["title"]))
                and normalized_title(str(left_node["title"])) not in GENERIC_TITLES
            )
            grouped = score >= REVISION_CONTAINMENT or (
                same_title and score >= SAME_TITLE_MINIMUM_CONTAINMENT
            )
            if grouped:
                union.join(left, right)
                pair_evidence.append({
                    "leftId": left_node["id"],
                    "rightId": right_node["id"],
                    "containment": round(score, 4),
                    "sameNormalizedTitle": same_title,
                })

    components: dict[int, list[int]] = defaultdict(list)
    for index in range(len(nodes)):
        components[union.find(index)].append(index)

    revision_groups: list[dict[str, object]] = []
    new_entries: list[dict[str, object]] = []
    for members in components.values():
        new_members = [index for index in members if nodes[index]["kind"] == "new"]
        if not new_members:
            continue
        inherited = sorted({
            str(nodes[index]["revisionGroupId"])
            for index in members
            if nodes[index].get("revisionGroupId")
        })
        leader_id = str(nodes[members[0]]["id"])
        group_id = inherited[0] if inherited else f"revision-{sha256_bytes(leader_id.encode())[:12]}"
        has_existing_index_source = any(str(nodes[index]["id"]) in existing_index_ids for index in members)
        representative_index = max(
            new_members,
            key=lambda index: (
                int(nodes[index]["article"]["quality"]["score"]),
                int(nodes[index]["article"]["wordCount"]),
            ),
        )
        normalized_hashes: dict[str, list[int]] = defaultdict(list)
        for index in new_members:
            normalized_hashes[str(nodes[index]["article"]["textSha256Normalized"])].append(index)

        revision_groups.append({
            "revisionGroupId": group_id,
            "memberIds": [str(nodes[index]["id"]) for index in members],
            "newMemberCount": len(new_members),
            "representativeId": None if has_existing_index_source else str(nodes[representative_index]["id"]),
        })
        for ordinal, index in enumerate(new_members, start=1):
            article = nodes[index]["article"]
            duplicate_indexes = normalized_hashes[str(article["textSha256Normalized"])]
            calibration_independent = index == duplicate_indexes[0]
            roles = ["similarity-calibration"]
            if not has_existing_index_source and index == representative_index:
                roles.insert(0, "index-source")
            relative = Path("similarity/text") / f"{article['id']}.txt"
            digest = write_text(project / "corpus" / relative, str(article["text"]))
            metadata = article["reportMetadata"]
            entry = {
                "id": article["id"],
                "roles": roles,
                "textPath": relative.as_posix(),
                "title": article["title"],
                "language": None,
                "publishedYear": None,
                "turnitinScore": article["turnitinScore"],
                "writerPopulation": None,
                "genre": None,
                "discipline": None,
                "revisionGroupId": group_id,
                "revisionOrdinal": ordinal,
                "calibrationIndependent": calibration_independent,
                "provenance": {
                    "source": f"user-supplied {args.source_name}",
                    "url": None,
                    "journal": None,
                    "retrievedAt": args.retrieved_at,
                    "sha256": digest,
                    "reportFile": metadata["sourceFile"],
                    "reportSha256": metadata["reportSha256"],
                    "submissionId": metadata["submissionId"],
                    "submissionDate": metadata["submissionDate"],
                    "extractionMethod": "turnitin-embedded-page-image-tesseract-5.3.4",
                    "scoreEvidence": "Turnitin ORIGINALITY REPORT / SIMILARITY INDEX",
                },
            }
            new_entries.append(entry)
            audit_rows.append({
                **metadata,
                "status": "accepted",
                "id": article["id"],
                "title": article["title"],
                "turnitinScore": article["turnitinScore"],
                "wordCount": article["wordCount"],
                "quality": article["quality"],
                "revisionGroupId": group_id,
                "revisionOrdinal": ordinal,
                "calibrationIndependent": calibration_independent,
                "includedInIndex": "index-source" in roles,
            })

    # Backfill a stable group on legacy calibration rows. The pre-existing
    # duplicate-cluster file remains a second, independent leakage safeguard.
    for entry in manifest:
        if "similarity-calibration" not in entry.get("roles", []):
            continue
        if not entry.get("revisionGroupId"):
            entry["revisionGroupId"] = f"revision-{sha256_bytes(str(entry['id']).encode())[:12]}"
        if "calibrationIndependent" not in entry:
            entry["calibrationIndependent"] = True

    all_ids = {str(entry["id"]) for entry in manifest}
    collisions = [entry["id"] for entry in new_entries if str(entry["id"]) in all_ids]
    if collisions:
        raise SystemExit(f"Generated duplicate corpus ids: {collisions[:5]}")
    merged = sorted(manifest + new_entries, key=lambda entry: str(entry["id"]))
    manifest_path.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    scores = [int(entry["turnitinScore"]) for entry in new_entries]
    accepted_groups = [group for group in revision_groups if group["newMemberCount"] > 1]
    audit = {
        "schema": "turnitplus-turnitin-report-import",
        "version": 1,
        "source": args.source_name,
        "retrievedAt": args.retrieved_at,
        "pdfsReceived": len(pdfs),
        "turnitinReportsAccepted": len(new_entries),
        "filesQuarantined": len([row for row in audit_rows if row["status"] == "quarantined"]),
        "independentCalibrationRows": len([entry for entry in new_entries if entry["calibrationIndependent"]]),
        "indexRepresentativesAdded": len([entry for entry in new_entries if "index-source" in entry["roles"]]),
        "revisionGroupsWithMultipleNewReports": len(accepted_groups),
        "revisionPolicy": {
            "preserveReports": True,
            "evaluation": "exclude every member of revisionGroupId when scoring one member",
            "index": "one highest-quality representative per revision group",
            "exactText": "preserve provenance but only one independent calibration row per normalized text hash",
            "containmentThreshold": REVISION_CONTAINMENT,
            "sameTitleMinimumContainment": SAME_TITLE_MINIMUM_CONTAINMENT,
        },
        "scoreRange": {"minimum": min(scores) if scores else None, "maximum": max(scores) if scores else None},
        "revisionPairEvidence": pair_evidence,
        "revisionGroups": revision_groups,
        "documents": sorted(audit_rows, key=lambda row: int(re.sub(r"\D", "", str(row["sourceFile"])) or 0)),
    }
    # Keep every batch audit instead of overwriting an earlier import made on
    # the same day. The source label is already required and is therefore the
    # stable, user-supplied discriminator between volumes.
    audit_label = slug(args.source_name)
    audit_path = project / "corpus" / f"turnitin-import-{args.retrieved_at}-{audit_label}.json"
    audit_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: audit[key] for key in (
        "pdfsReceived",
        "turnitinReportsAccepted",
        "filesQuarantined",
        "independentCalibrationRows",
        "indexRepresentativesAdded",
        "revisionGroupsWithMultipleNewReports",
        "scoreRange",
    )}, indent=2))


if __name__ == "__main__":
    main()
