#!/usr/bin/env python3
"""Run repeatable leave-one-out and highlighted-passage checks for TurnitPlus."""

from __future__ import annotations

import argparse
import json
import math
import re
import unicodedata
from pathlib import Path


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


def grams(tokens: list[str], size: int) -> list[str]:
    return [
        " ".join(tokens[index:index + size])
        for index in range(len(tokens) - size + 1)
    ]


def gram_hash(value: str) -> str:
    first = 0x811C9DC5
    second = 5381
    for code in map(ord, value):
        first = ((first ^ code) * 0x01000193) & 0xFFFFFFFF
        second = ((second * 33) ^ code) & 0xFFFFFFFF
    return f"{first:08x}{second:08x}"


def band(score: int) -> str:
    if score <= 5:
        return "Low"
    if score <= 15:
        return "Moderate"
    return "High"


def archive_band(score: int, bands: list[dict[str, object]]) -> str:
    return next(
        (
            str(candidate["label"])
            for candidate in bands
            if int(candidate["minimum"]) <= score <= int(candidate["maximum"])
        ),
        "High",
    )


def title_similarity(left: str, right: str) -> float:
    left_tokens = {token for token in words(Path(left).stem) if len(token) >= 3}
    right_tokens = {token for token in words(Path(right).stem) if len(token) >= 3}
    return len(left_tokens & right_tokens) / max(1, len(left_tokens | right_tokens))


def leave_one_out(
    article_index: int,
    text: str,
    search_index: dict[str, object],
) -> int:
    size = int(search_index["shingleSize"])
    tokens = words(text)
    matched: set[int] = set()
    inverted = search_index["invertedIndex"]
    cap = int(search_index["maximumDocumentFrequency"])
    excluded = {article_index}
    for position, gram in enumerate(grams(tokens, size)):
        sources = [
            source for source in inverted.get(gram_hash(gram), [])
            if source not in excluded
        ]
        if not sources or len(sources) > cap:
            continue
        matched.update(range(position, min(len(tokens), position + size)))
    return min(100, round(len(matched) / max(1, len(tokens)) * 100))


def auc_for_threshold(results: list[dict[str, object]], target: int) -> float:
    positives = [row for row in results if int(row["referenceScore"]) > target]
    negatives = [row for row in results if int(row["referenceScore"]) <= target]
    if not positives or not negatives:
        return 0.0
    favorable = 0.0
    for positive in positives:
        for negative in negatives:
            left = int(positive["archiveScore"])
            right = int(negative["archiveScore"])
            favorable += 1 if left > right else 0.5 if left == right else 0
    return round(favorable / (len(positives) * len(negatives)), 4)


def operating_point(results: list[dict[str, object]], target: int) -> dict[str, object]:
    best: tuple[float, int, int, int, int, int, float, float] | None = None
    for cutoff in range(0, 101):
        tp = sum(int(row["referenceScore"]) > target and int(row["archiveScore"]) >= cutoff for row in results)
        fp = sum(int(row["referenceScore"]) <= target and int(row["archiveScore"]) >= cutoff for row in results)
        fn = sum(int(row["referenceScore"]) > target and int(row["archiveScore"]) < cutoff for row in results)
        tn = sum(int(row["referenceScore"]) <= target and int(row["archiveScore"]) < cutoff for row in results)
        precision = tp / max(1, tp + fp)
        recall = tp / max(1, tp + fn)
        f2 = 5 * precision * recall / max(1e-12, 4 * precision + recall)
        candidate = (f2, -cutoff, tp, fp, fn, tn, precision, recall)
        if best is None or candidate > best:
            best = candidate
    assert best is not None
    _, negative_cutoff, tp, fp, fn, tn, precision, recall = best
    return {
        "targetThreshold": target,
        "archiveCutoff": -negative_cutoff,
        "auc": auc_for_threshold(results, target),
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "truePositives": tp,
        "falsePositives": fp,
        "falseNegatives": fn,
        "trueNegatives": tn,
        "selectionMetric": "F2",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("corpus", type=Path)
    parser.add_argument("index", type=Path)
    parser.add_argument("benchmark", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--risk-output", type=Path)
    args = parser.parse_args()

    corpus = json.loads(args.corpus.read_text(encoding="utf-8"))
    search_index = json.loads(args.index.read_text(encoding="utf-8"))
    benchmark = json.loads(args.benchmark.read_text(encoding="utf-8"))
    results = []
    for article_index, article in enumerate(corpus["articles"]):
        actual = article.get("originalSimilarity")
        if actual is None:
            continue
        predicted = leave_one_out(article_index, article["text"], search_index)
        results.append({
            "id": article["id"],
            "title": article["title"],
            "referenceScore": actual,
            "archiveScore": predicted,
            "absoluteError": abs(actual - predicted),
            "referenceBand": band(actual),
            "archiveBand": archive_band(predicted, search_index["scoreBands"]),
        })

    indexed = search_index["invertedIndex"]
    passage_total = 0
    passage_hits = 0
    for report in benchmark.get("reports", []):
        for passage in report.get("passages", []):
            passage_total += 1
            passage_tokens = words(passage)
            if any(gram_hash(gram) in indexed for gram in grams(passage_tokens, int(search_index["shingleSize"]))):
                passage_hits += 1

    mean_reference = sum(int(row["referenceScore"]) for row in results) / max(1, len(results))
    mean_rmse = math.sqrt(sum((int(row["referenceScore"]) - mean_reference) ** 2 for row in results) / max(1, len(results)))
    zero_rmse = math.sqrt(sum(int(row["referenceScore"]) ** 2 for row in results) / max(1, len(results)))
    risk_points = [operating_point(results, target) for target in (10, 15, 20)]
    selected_risk = next(point for point in risk_points if point["targetThreshold"] == 15)

    payload = {
        "schema": "turnitplus-evaluation",
        "version": 1,
        "corpusVersion": search_index["corpusVersion"],
        "scoreBands": search_index["scoreBands"],
        "scoreCalibration": {
            "labeledDocuments": len(results),
            "meanAbsoluteError": round(
                sum(result["absoluteError"] for result in results) / max(1, len(results)),
                2,
            ),
            "bandAgreement": round(
                sum(result["referenceBand"] == result["archiveBand"] for result in results)
                / max(1, len(results)),
                4,
            ),
            "baselines": {
                "predictMeanRmse": round(mean_rmse, 2),
                "predictZeroRmse": round(zero_rmse, 2),
            },
            "results": results,
        },
        "thresholdScreening": {
            "selected": selected_risk,
            "allTargets": risk_points,
            "note": "The operating point maximizes F2, weighting recall more heavily than precision for screening.",
        },
        "highlightBenchmark": {
            "passages": passage_total,
            "passagesWithArchiveMatch": passage_hits,
            "archiveCoverage": round(passage_hits / max(1, passage_total), 4),
            "note": "Coverage measures whether a labeled passage exists in the private archive; it is not precision.",
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.risk_output:
        args.risk_output.parent.mkdir(parents=True, exist_ok=True)
        args.risk_output.write_text(
            json.dumps(
                {
                    "schema": "turnitplus-risk-calibration",
                    "version": 1,
                    "corpusVersion": search_index["corpusVersion"],
                    "sampleSize": len(results),
                    **selected_risk,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
    print(
        f"{len(results)} labeled documents, MAE {payload['scoreCalibration']['meanAbsoluteError']}, "
        f"band agreement {payload['scoreCalibration']['bandAgreement']:.1%}, "
        f"highlight coverage {payload['highlightBenchmark']['archiveCoverage']:.1%}"
    )


if __name__ == "__main__":
    main()
