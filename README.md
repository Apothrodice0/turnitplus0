# TurnitPlus

TurnitPlus is a private, browser-based review screener. It identifies papers
worth reviewing against the local archive, then shows the matched passages
driving that result. Archive Similarity remains an explanatory, archive-relative
signal rather than a prediction of a percentage from an external database.

## Run locally

### Windows

Install the current Node.js LTS release, extract the complete release ZIP, and
double-click `START-WINDOWS.bat`. On first launch, package installation can take
several minutes. Open the Local address printed in the terminal.

### Development

```sh
npm install
npm run dev
```

`npm run dev` runs the Cloudflare Workers-emulated Vite dev server. It serves
the static UI, but every DB-backed route (`/api/auth/*`, `/api/reports`,
`/api/ingest`, `/api/academic-evidence`) will 500 under it: with
`TURSO_DATABASE_URL` unset, `lib/reports-db.ts` falls back to a local SQLite
file via a `file:` URL, and the Workers-runtime libsql client rejects `file:`
URLs outright (only `libsql:`/`https:`/`http:`/`ws:`/`wss:` are supported in
that runtime). To exercise those routes locally, run the real Next.js dev
server instead:

```sh
npx next dev
```

The first request against a fresh or older local database will also 500 with
`SQLITE_ERROR: no such table: rate_limit_buckets` (or similar) until the
Phase A-E8/privacy/rate-limiting/developer-role/diagnostics migrations
(0012-0026) are applied. Apply them once, against the exact file
`lib/reports-db.ts` falls back to:

```sh
node --import tsx tools/apply-e8-tables-migration.ts --env=local --db-file=./data/reports-dev.db --execute
```

This is safe to re-run — it dry-runs by default without `--execute`, skips
migrations already applied, and refuses any migration file containing a
destructive statement or one that doesn't match its reviewed checksum.

## Archive Similarity

Archive Similarity is the percentage of eligible submission words assigned to
matching passages in the indexed archive after boilerplate suppression. The
document-frequency cap and minimum accepted span are selected by a recorded
parameter sweep; scattered evidence that does not form an accepted span does
not contribute to the percentage.

- Low: 0-5%
- Moderate: 6-15%
- High: 16-100%

It is archive-relative rather than a universal plagiarism judgment. Every saved
report records the archive version used. Probable self-matches are excluded only
when document content reaches the configured containment threshold; filenames
never cause exclusion.

## Threshold screening

The selected operating point screens for exceeding 15% and maximizes F2, which
weights recall more heavily than precision. Calibration is generated from the
labeled leave-one-out evaluation and is pinned to the same corpus version as
every result. TurnitPlus refuses to analyze when the calibration and archive
versions do not match.

Current cluster- and revision-aware strict leave-one-out calibration uses 284
independent rows from 294 labelled reports across 229 article-level revision
groups and searches 230 index sources. AUC is 0.784 with a revision-group
bootstrap 95% interval of 0.708-0.848. At the precision-constrained F2
operating point, the archive cutoff is 7%, precision is 0.458, and recall is
0.775. Mean error is -4.120 percentage points, MAE is 5.747, and RMSE is
8.293. The selected matching configuration accepts five-word-or-longer
continuous spans, suppresses grams found in more than six eligible archive
documents, and excludes sources contributing less than 0.25% of a document.
The output remains a review screener, not a finding of misconduct.

For transparency, self-only exclusion scores AUC 0.804 and is retained only as
a leakage sensitivity. Removing all six members of the three legacy clusters
produces a 278-report sensitivity result of AUC 0.789.
The legacy clusters were selected at 0.25 five-gram containment: after the
index expansion, the top pairwise values remain 0.710, 0.689, 0.315, then
0.041. A one-row-per-revision-group sensitivity gives AUC 0.812. The naive,
cluster-corrected, and revision-level sensitivity results are retained in
`risk-calibration.json`.

Source aggregation was selected without reading a separate set of eight
original documents. On that locked held-out regression set, the prior exact-
original configuration had MAE 6.875 and RMSE 8.178; the selected 0.25%
per-source floor reduced these to MAE 3.875 and RMSE 4.783, with mean error
moving from +6.125 to +0.375 percentage points. The originals, their hashes,
and the one-time evaluation are stored separately under
`corpus/similarity-regression/` and `corpus/audit/` and never enter the index or
parameter sweep.

## Privacy and storage

Document extraction and matching run locally in a Web Worker. Reports are stored
in IndexedDB instead of localStorage, allowing thesis-length reports without the
small localStorage quota. The browser receives a packed typed-array index whose
five-gram keys are one-way encoded rather than readable source phrases. This
avoids the memory spike caused by parsing more than a million JSON properties.
The canonical source corpus is not included in the downloadable release.

Only index material that you are permitted to distribute should be used in a
shared build.

## English AI report

Eligible English documents are analyzed locally in a separate Web Worker using
a full-precision ModernBERT ONNX model. WebGPU is used when available, with a CPU
fallback. The first AI check downloads about 600 MB and the browser caches the
model for later checks. Documents are not uploaded for AI analysis. The larger
model is deliberate: the q8 conversion failed the permanent human negative
control and is no longer accepted by the application.

The detector tokenizes before chunking, then analyzes the full eligible document
in 240-token windows with a 120-token stride. The 16-token reserve keeps every
window within the model's 256-token limit after special tokens are added. Live
inference refuses an oversized window instead of silently truncating it, and
each saved passage records its token count and truncation status. The model
contract uses machine class at logit index 1 and temperature
1.3017339706420898.

PDF uploads and the 88 verified-human calibration papers now share one PDF.js
text-layer extraction function. Every calibration source PDF is checked against
its stored SHA-256 before extraction. This removed the earlier representation
mismatch between browser uploads and offline calibration; the parity report is
stored in `corpus/ai-extraction-parity-report.json`.

Raw temperature-scaled log-odds are retained alongside display probabilities,
and the mean of the three strongest passages is recorded as a separate
concentration feature. Log-odds preserve numerical resolution but are a
monotonic transform, so they cannot improve AUC by themselves. No live decision
rule uses the top-three feature until a controlled positive set demonstrates an
improvement on held-out data. Headline coverage and passage verdicts now share
one full-precision log-odds decision path; each saved passage carries its review
status so rounded display values can never change the result later.

The human-side calibration uses 88 verified pre-2022 English papers,
including 84 from the L2-Algerian population. The headline compares the
document's median passage signal with that verified-human distribution. Below
the median reads `Consistent with human writing`; the 50th–95th band reads
`Within human range`; the 95th–99th band reads `Above typical human range`;
and a signal above every reference reads `Well above human range`. A percentile
is shown only for the upper two bands. A document within 0.05 log-odds of any
band boundary returns `Inconclusive` with no number. Passage-window coverage is
supporting evidence, not an AI-authorship percentage. This does not activate an
authorship verdict: a controlled AI-positive evaluation must also produce
held-out recall and AUC. The 95%
Wilson target is 5% because 88 negatives cannot mathematically support a 1%
upper confidence bound.

The report also compares document medians with the verified-human score
distribution. A separate 240-document English-reference benchmark remains
outside calibration. Date evidence admits 188 pre-November-2022 documents to
exploratory comparison curves; 52 later documents are scored for diagnostics
but excluded from every comparison distribution. The completed legacy curve
currently contains 100 documents; the separate 88-document Corpus 3 group
stays out of plots until all 88 scores are available. None contributes to
verified false-positive or accuracy claims.
Only four documents currently meet the stricter native-English negative-control
requirements, so the cross-population FPR gap is withheld until each population
has at least 30 verified documents.
If the model fails the verified-human negative control, the interface identifies
the detector as unavailable instead of implying that collecting more samples
alone will make the current model reliable.

## Reproducible calibration

The manifest and the physically separated samples are documented in
`corpus/README.md`. Validate before building or measuring:

The 88 verified human PDFs must first be extracted through the same PDF.js
text-layer contract used by browser uploads:

```sh
npm run reextract:ai-negatives -- \
  --corpus /path/to/Corpus.zip \
  --corpus2 /path/to/Corpus-2.zip \
  --native /path/to/native-corpus.zip
```

This command refuses any source PDF whose SHA-256 differs from the manifest and
writes `corpus/ai-extraction-parity-report.json` before calibration continues.

```sh
npm run validate:corpus
npm run build:index
npm run collect:wikipedia-calibration
npm run collect:openalex-calibration
npm run calibrate:similarity
npm run check:ai-model
npm run calibrate:ai
npm run split:ai-benchmark-dates
npm run summarize:ai-benchmark
npm run benchmark:ai-model
npm run evaluate:ai
```

The Wikipedia calibration samples 20 distinctive phrases from each of the 60 labeled similarity papers, fits `actual = intercept + b·archiveScore + c·wikipediaMatches`, and evaluates the combined prediction with leave-one-out AUC. The combined number is eligible to ship only when it beats the cluster-aware archive-only baseline. Otherwise Wikipedia remains separate review evidence and never changes the Archive Similarity percentage.

`lib/openalex-check.ts` reuses the same phrase sampler for a separate scholarly-literature lookup. Each phrase records one explicit outcome: `matched`, `no-match`, `throttled`, `timed-out`, or `failed`, plus its sampled index and document word offsets. Rate limits, authentication failures, server errors, and timeouts therefore never count as negative evidence. The offline 60-paper collector requires `OPENALEX_API_KEY`, never persists it, caches each completed document, and resumes safely after a quota or network interruption. Before collection it performs one authenticated full-text request and stops immediately for a rejected key, exhausted allowance, or endpoint failure. Its optional `mailto` parameter is retained only for compatibility with older OpenAlex integrations. The resulting distribution is written beside `wikipediaSignal` as `openAlexSignal`, including top-three-document concentration and early/middle/late phrase-position histograms; it remains separate evidence and does not alter Archive Similarity.

For local key handling, copy `.env.example` to `.env`, open `.env` in Notepad, and place the key after `OPENALEX_API_KEY=` with no quotation marks. The collection command loads `.env` automatically. The completed `.env` file is ignored by Git and omitted from Windows archives; never share or screenshot it.

The 60-paper run makes 1,200 phrase requests. OpenAlex currently prices search at $1 per 1,000 requests and supplies a $1 daily free allowance, so a free-key run may require two daily sessions. The resumable cache prevents already completed documents from being queried again.

The similarity command performs strict leave-one-out evaluation, records the
positive-class definition, and writes an AUC confidence interval. The AI command
measures document- and passage-level false-positive rates on verified pre-2022
English papers using Wilson confidence intervals. It writes the measured
confidence floor and passage threshold directly to the JSON consumed by the app.
The L2-Algerian curve controls suppression conservatively; similarity documents
are never eligible AI negatives, and AI-negative articles never enter the
similarity index. AI-benchmark articles remain a separate human-reference proxy
and never silently enter the verified-negative calculation. The benchmark model
command scores all proxy documents and labels its output as exploratory rather
than reporting the result as a verified false-positive rate.

`evaluate:ai` is the positive-set gate. It refuses to emit validated AUC or recall until
at least 30 controlled machine documents exist with complete generator, prompt,
source-document, and split provenance. It reports held-out and all-sample AUC
for coverage, top-three mean log-odds, maximum, mean, and an OR-style
coverage/top-three rank ablation. Until the controlled positive set is complete,
the website displays an experimental document-median percentile against the 88
verified human papers, plus neutral passage review labels at the human 90th
percentile. It does not display an AI-authorship percentage or authorship
verdict. Human-only calibration cannot establish that the detector catches AI
writing. The separately stored topic-only benchmark currently records 42
generation sessions representing 39 unique documents; the evaluation artifact
preserves its diagnostic results under `preliminaryPositiveControl` without
promoting them into the controlled positive count.

## Corpus pipeline

The PDF builder remains available for importing similarity reports. The shipped
index is rebuilt from manifest entries carrying only the `index-source` role:

```sh
python3 -m pip install -r scripts/requirements-extraction.txt
python3 tools/prepare-role-corpus.py --ai-pdf-dir /path/to/ai-pdfs \
  --source-uri '<stable archive URI>'
npm run validate:corpus
npm run build:index
```

For importing additional similarity reports before regenerating the manifest:

```sh
python3 tools/import-turnitin-reports.py reports/ \
  --source-name 'turnitin-report-batch.zip' \
  --retrieved-at 2026-08-09
npm run build:index
npm run calibrate:similarity
```

The importer preserves genuine article revisions as separate labelled rows,
groups them to prevent evaluation leakage, keeps one search-index
representative per article, quarantines incompatible reports, and records
report/text hashes in a batch audit file.

## Prospective similarity evaluation protocol

Future paired originals and Turnitin reports follow the fixed protocol in
`corpus/protocol/similarity-evaluation-v1.json`. Eligibility is score-blind,
revisions stay grouped, and SHA-256 assignment on `revisionGroupId` creates a
50% calibration, 25% development-validation, and 25% locked-final-test split
before either score is inspected. Natural-stream headline results remain
separate from an independently sourced high-score stress cohort.

The locked cohort is opened once only after reaching 60 documents and after a
candidate clears the development admission gate. Score-band results are
withheld below their predeclared sample counts. The protocol commit lock and
every future admission record make the ordering auditable.

Run the evaluation:

```sh
python3 scripts/evaluate-archive.py \
  data/document-corpus.json \
  data/document-index.json \
  public/data/benchmark-corpus.json \
  data/evaluation-report.json \
  --risk-output public/data/risk-calibration.json
```

## Tests

```sh
npm test
```

Tests cover normalization, multilingual detection, Arabic stopwords, reference
removal, gram generation, informative phrase filtering, encoded keys,
containment, scoring, production rendering, and artifact structure.
TurnitPlus production source.