import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createHash } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { tokens } from "../lib/similarity-core.ts";
import { runWithScoringNormalization } from "../lib/scoring-normalization-scope.ts";
import {
  indexDocumentSubmissionIntoCorpus,
  CORPUS_ACTIVATION_DELAY_DAYS,
  CORPUS_FINGERPRINT_VERSION,
  CANONICALIZATION_VERSION,
} from "../lib/user-submission-corpus.ts";
import { matchAgainstUserSubmissionCorpus, USER_SUBMISSION_MATCHER_VERSION, USER_SUBMISSION_MATCH_THRESHOLDS } from "../lib/user-submission-matching.ts";
import { getOrComputeHistoricalMatchSnapshot, getCurrentCorpusMatchGeneration, SNAPSHOT_MATCHER_VERSION, snapshotMatcherVersion } from "../lib/report-historical-match.ts";
import { resolvePrimarySimilaritySummary } from "../lib/report-primary-similarity.ts";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";

/**
 * Prior-submission canonical-to-raw position drift regression.
 *
 * The prior-submission matcher runs on canonicalizeText(raw), which DELETES
 * zero-width formatting marks (U+200B/C/D, U+FEFF), while every unified
 * similarity position (wordCount, archive positions, the union) lives in
 * tokens(raw) space, where lib/similarity-core.ts's normalize() turns those
 * same marks into word boundaries. One in-word mark therefore splits one
 * canonical token into two raw tokens, and every canonical position after it
 * used to be read one raw token too early — crediting raw words that were
 * never verified against the source.
 *
 * Every fixture below is built from separately-tokenized parts so the raw
 * token range of the genuinely copied text is known independently of the
 * code under test: novel intro/outro words are never in the source, so any
 * credited raw position outside the copied range is a non-source token.
 *
 * That drift is a property of scoring normalization v1 — the contract of
 * every report saved so far, and of any v1 report resolved by any build. So
 * these tests run under v1 by name (testV1), not under whichever contract the
 * build computes new checks under. Under v2 the same marks are deleted by the
 * tokenizer on both sides and there is nothing to drift; the v2 counterparts
 * are at the end of the file.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_prior_submission_raw_position_mapping.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

const ZWSP = String.fromCharCode(0x200b);
const ZWNJ = String.fromCharCode(0x200c);
const ZWJ = String.fromCharCode(0x200d);
const BOM = String.fromCharCode(0xfeff);
const NBSP = String.fromCharCode(0xa0);
const SOFT_HYPHEN = String.fromCharCode(0xad);
const WORD_JOINER = String.fromCharCode(0x2060);

const testV1 = (name, body) => test(name, () => runWithScoringNormalization(1, body));
const testV2 = (name, body) => test(name, () => runWithScoringNormalization(2, body));

const knownUsers = new Set();
async function ensureUser(accountId) {
  if (knownUsers.has(accountId)) return;
  knownUsers.add(accountId);
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash"],
  });
}
async function ensureSavedReport(deviceKey, reportId, accountId) {
  await ensureUser(accountId);
  await client.execute({
    sql: `INSERT OR IGNORE INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, deviceKey, "sub-" + reportId, "Fixture Report", new Date().toISOString(), 100, 0, "Low", "{}", accountId],
  });
}
async function indexSource(accountId, rawText) {
  await ensureUser(accountId);
  const identity = await createDocumentIdentity(client, { accountId, title: "Source", author: null, rawText });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  await matureCorpusBackings(client);
}

let reportCounter = 0;
/** `scoringNormalizationVersion` is the report's contract; omitted is v1, as for every report with no stamp. */
async function snapshotFor(viewerAccountId, rawText, scoringNormalizationVersion) {
  reportCounter += 1;
  const deviceKey = `device-raw-pos-${reportCounter}`;
  const reportId = `report-raw-pos-${reportCounter}`;
  await ensureSavedReport(deviceKey, reportId, viewerAccountId);
  return getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: viewerAccountId, rawText, ...(scoringNormalizationVersion ? { scoringNormalizationVersion } : {}) });
}

/** Unified similarity for the prior channel alone, in tokens(raw) space — exactly how the save path calls it. */
function unifiedFor(rawText, snapshot) {
  return computeUnifiedSimilarity({ wordCount: tokens(rawText).length, archiveMatchedPositions: [], historicalSubmissionMatch: snapshot });
}

/** Inserts `mark` after the second character of the first `count` words of length >= 4 (so it always lands INSIDE a word). */
function markInsideWords(text, count, mark = ZWSP) {
  let remaining = count;
  return text.split(" ").map((word) => {
    if (remaining === 0 || word.length < 4) return word;
    remaining -= 1;
    return word.slice(0, 2) + mark + word.slice(2);
  }).join(" ");
}

/** Builds a submission from parts and returns the raw-token range each part occupies, computed per part (independent of the matcher). */
function compose(parts) {
  const ranges = [];
  let cursor = 0;
  for (const part of parts) {
    const count = tokens(part.text).length;
    ranges.push({ copied: part.copied, start: cursor, end: cursor + count - 1 });
    cursor += count;
  }
  const rawText = parts.map((part) => part.text).join(" ");
  assert.equal(tokens(rawText).length, cursor, "fixture sanity: parts must tokenize independently");
  const copiedPositions = new Set();
  for (const range of ranges) if (range.copied) for (let p = range.start; p <= range.end; p += 1) copiedPositions.add(p);
  return { rawText, ranges, copiedPositions };
}

function passagePositions(passages) {
  const positions = new Set();
  for (const passage of passages) for (let p = passage.submittedWordStart; p <= passage.submittedWordEnd; p += 1) positions.add(p);
  return positions;
}

function sorted(set) {
  return [...set].sort((a, b) => a - b);
}

// --- Fixture vocabulary: every scenario uses its own topic so no scenario's
// source can become a candidate for another scenario's submission. ---------

const GLACIER_COPIED = "Glaciologists drilling through the Taku icefield recovered a continuous core whose volcanic ash layers aligned precisely with documented eruptions of Mount Katmai, allowing researchers to calibrate annual accumulation rates across four centuries of snowfall with unprecedented stratigraphic confidence and minimal dating uncertainty.";
const GLACIER_INTRO = "Beekeepers monitoring orchard pollination throughout springtime noticed hives near hedgerows produced noticeably heavier honey yields compared against colonies positioned beside plowed fields during several consecutive seasons.";
const GLACIER_OUTRO = "Ferry operators subsequently rescheduled timetables because tidal currents intensified unexpectedly during autumn storms.";
// Shared by the repro, determinism and score-attribution tests — indexed
// before any test() is registered (see tests/archive-scalable-index.test.mjs's
// top-level-await ordering note).
await indexSource("zw-source-account", GLACIER_COPIED);

// --- 1. Baseline ordinary behaviour must remain identical --------------------

testV1("PLAIN TEXT: a prior-submission STRONG match without zero-width marks stores exactly the canonical passages, on exactly the copied raw tokens", async () => {
  const copied = "Horologists restoring an eighteenth-century marine chronometer discovered that its brass escapement had been hand-filed to compensate for thermal expansion, a refinement previously attributed only to later Parisian workshops operating under royal patronage.";
  const intro = "Volunteer lifeguards patrolling crowded municipal beaches recorded jellyfish sightings every morning before opening designated swimming zones.";
  const { rawText, copiedPositions } = compose([{ text: intro, copied: false }, { text: copied, copied: true }]);
  await indexSource("plain-source-account", copied);

  const snapshot = await snapshotFor("plain-viewer-account", rawText);
  assert.equal(snapshot.status, "MATCHED");
  const [match] = snapshot.matches;
  assert.equal(match.relationshipType, "PRIOR_SUBMISSION");
  assert.equal(match.matchType, "STRONG_TEXT_MATCH");

  // Identity: plain text has identical raw and canonical token streams, so the
  // stored passages must be byte-identical to the matcher's canonical output.
  const direct = await matchAgainstUserSubmissionCorpus(client, { accountId: "plain-viewer-account", canonicalText: canonicalizeText(rawText) });
  const canonicalPassages = direct.matches[0].passages.map(({ externalWordStart, ...rest }) => rest);
  assert.deepEqual(match.passages, canonicalPassages);
  assert.deepEqual(sorted(passagePositions(match.passages)), sorted(copiedPositions));
  assert.deepEqual(unifiedFor(rawText, snapshot).previousUploadPositions, sorted(copiedPositions));
});

testV1("EXACT MATCH: an exact canonical prior-submission match keeps its exact-match entry shape and full-document credit", async () => {
  const text = "Numismatists cataloguing a hoard of Byzantine gold solidi unearthed beneath a collapsed Anatolian granary dated the burial by die-linking obverse portraits to a short-lived regional mint.";
  await indexSource("exact-source-account", text);

  const snapshot = await snapshotFor("exact-viewer-account", text);
  assert.equal(snapshot.status, "MATCHED");
  const [match] = snapshot.matches;
  assert.equal(match.matchType, "EXACT_CANONICAL_MATCH");
  assert.equal(match.relationshipType, "PRIOR_SUBMISSION");
  assert.deepEqual(match.passages, []);
  assert.equal(match.passageCount, 0);
  assert.equal(match.matchedWordCount, tokens(text).length);
  const unified = unifiedFor(text, snapshot);
  assert.equal(unified.unifiedScore, 100);
  assert.equal(unified.uniqueMatchedWords, tokens(text).length);

  // The same document with in-word zero-width marks is still an exact
  // canonical duplicate: every raw fragment belongs to the identical
  // verified document, so the unchanged full-range fallback stays correct.
  const marked = markInsideWords(text, 6);
  assert.ok(tokens(marked).length > tokens(text).length);
  const markedSnapshot = await snapshotFor("exact-viewer-account", marked);
  assert.equal(markedSnapshot.matches[0].matchType, "EXACT_CANONICAL_MATCH");
  assert.deepEqual(markedSnapshot.matches[0].passages, []);
  const markedUnified = unifiedFor(marked, markedSnapshot);
  assert.equal(markedUnified.unifiedScore, 100);
  assert.equal(markedUnified.uniqueMatchedWords, tokens(marked).length);
});

// --- 2. The zero-width drift repro ------------------------------------------

testV1("ZERO-WIDTH REPRO: in-word zero-width marks before and inside a copied passage never shift credit onto non-copied raw tokens", async () => {
  // 17 in-word marks in the novel intro, plus marks (including a repeated run
  // and every stripped code point) inside copied words.
  const intro = markInsideWords(GLACIER_INTRO, 17);
  const copied = GLACIER_COPIED
    .replace("Glaciologists", `Glacio${ZWSP}logists`)
    .replace("volcanic", `vol${ZWNJ}canic`)
    .replace("stratigraphic", `strati${ZWSP}${ZWSP}gra${ZWJ}phic`)
    .replace("uncertainty", `uncer${BOM}tainty`);
  const { rawText, ranges, copiedPositions } = compose([
    { text: intro, copied: false },
    { text: copied, copied: true },
    { text: GLACIER_OUTRO, copied: false },
  ]);

  const snapshot = await snapshotFor("zw-viewer-account", rawText);
  // Correspondence still recognizes the source-backed text.
  assert.equal(snapshot.status, "MATCHED");
  const [match] = snapshot.matches;
  assert.equal(match.relationshipType, "PRIOR_SUBMISSION");
  assert.equal(match.matchType, "STRONG_TEXT_MATCH");

  const rawTokens = tokens(rawText);
  const credited = passagePositions(match.passages);
  const nonSource = sorted(credited).filter((p) => !copiedPositions.has(p));
  assert.deepEqual(
    nonSource.map((p) => `${p}:${rawTokens[p]}`),
    [],
    "no credited raw position may land on a raw token outside the genuinely copied text",
  );
  assert.deepEqual(sorted(credited), sorted(copiedPositions), "every raw token of the copied passage (including zero-width-split fragments) is credited");
  assert.deepEqual(match.passages.map((p) => [p.submittedWordStart, p.submittedWordEnd]), [[ranges[1].start, ranges[1].end]]);
  assert.equal(match.passages[0].matchedWordCount, ranges[1].end - ranges[1].start + 1);

  const unified = unifiedFor(rawText, snapshot);
  assert.deepEqual(unified.previousUploadPositions, sorted(copiedPositions));
  assert.equal(unified.uniqueMatchedWords, copiedPositions.size);
});

testV1("MULTIPLE ZERO-WIDTH MARKS: marks between two copied passages cannot move the later passage's credit", async () => {
  const first = "Archivists digitizing wartime telegraph ledgers reconstructed a coded convoy schedule by correlating operator initials with surviving harbor manifests from Halifax and Liverpool shipping offices.";
  const second = "Conservators stabilizing the waterlogged ledgers froze each volume before vacuum sublimation, preventing iron-gall ink from bleeding through fragile rag paper during the lengthy drying process.";
  const between = markInsideWords("Orchestra musicians rehearsing unfamiliar contemporary compositions requested additional sectional practice sessions before the premiere concert, citing complicated rhythmic transitions throughout movements.", 12);
  const between2 = between.split(" ").map((word) => (word.length >= 6 ? `${word.slice(0, 3)}${ZWSP}${ZWJ}${word.slice(3)}` : word)).join(" ");
  const { rawText, ranges, copiedPositions } = compose([
    { text: first, copied: true },
    { text: between2, copied: false },
    { text: second, copied: true },
  ]);
  await indexSource("multi-source-account", `${first} ${second}`);

  const snapshot = await snapshotFor("multi-viewer-account", rawText);
  assert.equal(snapshot.status, "MATCHED");
  const [match] = snapshot.matches;
  assert.equal(match.relationshipType, "PRIOR_SUBMISSION");
  const stored = match.passages.map((p) => [p.submittedWordStart, p.submittedWordEnd]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(stored, [[ranges[0].start, ranges[0].end], [ranges[2].start, ranges[2].end]]);
  assert.deepEqual(unifiedFor(rawText, snapshot).previousUploadPositions, sorted(copiedPositions));
});

testV1("SUBSTITUTED / INSERTED TOKENS: a substituted word and an inserted word inside the copied passage are never credited, even with zero-width marks before them", async () => {
  const words = "Volcanologists sampling fumarole gases on the flanks of Mount Erebus measured sulfur dioxide fluxes that doubled within hours of each lava-lake overturn, suggesting convective magma pulses rather than episodic degassing drive the persistent Antarctic plume observed from orbit since the late seventies.".split(" ");
  // Three in-word marks before the passage: on the pre-fix reading, the
  // canonical span right after each edit would have been read 3 raw tokens
  // early — onto the substituted/inserted word itself.
  const intro = markInsideWords("Librarians relocating fragile periodicals catalogued mildew damage.", 3, ZWJ);
  const { rawText, ranges, copiedPositions } = compose([
    { text: intro, copied: false },
    { text: words.slice(0, 15).join(" "), copied: true },
    { text: "zeppelin", copied: false }, // substitutes words[15]
    { text: words.slice(16, 29).join(" "), copied: true },
    { text: "marmalade", copied: false }, // inserted after words[28]
    { text: words.slice(29).join(" "), copied: true },
  ]);
  await indexSource("edit-source-account", words.join(" "));

  const snapshot = await snapshotFor("edit-viewer-account", rawText);
  assert.equal(snapshot.status, "MATCHED");
  const [match] = snapshot.matches;
  assert.equal(match.relationshipType, "PRIOR_SUBMISSION");
  const credited = passagePositions(match.passages);
  const substituted = ranges[2].start;
  const inserted = ranges[4].start;
  assert.ok(!credited.has(substituted), `substituted raw token ${substituted} must not be credited`);
  assert.ok(!credited.has(inserted), `inserted raw token ${inserted} must not be credited`);
  assert.deepEqual(sorted(credited), sorted(copiedPositions));
  assert.deepEqual(unifiedFor(rawText, snapshot).previousUploadPositions, sorted(copiedPositions));
});

// --- 4. Punctuation / whitespace normalization keeps raw identity ------------

testV1("PUNCTUATION / WHITESPACE / NBSP / SOFT HYPHEN / BETWEEN-WORD ZERO-WIDTH: raw position identity is unchanged", async () => {
  const copied = "Mycologists surveying old-growth hemlock stands documented a previously undescribed truffle species whose spores germinated only after passing through the digestive tract of northern flying squirrels.";
  const copiedFormatted = copied
    .replace("hemlock stands", `hemlock${NBSP}${NBSP}stands`)
    .replace("previously undescribed", "previously\r\n\r\n\r\n\r\nundescribed")
    .replace("truffle species", `truffle ${ZWSP} species`)
    .replace("spores germinated", `spores${ZWSP} germinated`)
    .replace("digestive tract", "digestive\t\t tract")
    .replace("flying squirrels", "flying — squirrels");
  const intro = `Railway${SOFT_HYPHEN}enthusiasts photographing  vintage locomotives, gathered beside ${ZWSP}signal boxes; "chatting" enthusiastically (about restoration) budgets!`;
  const { rawText, ranges, copiedPositions } = compose([{ text: intro, copied: false }, { text: copiedFormatted, copied: true }]);
  // Both spaces tokenize identically here, so position identity must hold.
  assert.deepEqual(tokens(rawText), tokens(canonicalizeText(rawText)));
  await indexSource("format-source-account", copied);

  const snapshot = await snapshotFor("format-viewer-account", rawText);
  assert.equal(snapshot.status, "MATCHED");
  const [match] = snapshot.matches;
  const direct = await matchAgainstUserSubmissionCorpus(client, { accountId: "format-viewer-account", canonicalText: canonicalizeText(rawText) });
  assert.deepEqual(match.passages, direct.matches[0].passages.map(({ externalWordStart, ...rest }) => rest));
  assert.deepEqual(match.passages.map((p) => [p.submittedWordStart, p.submittedWordEnd]), [[ranges[1].start, ranges[1].end]]);
  assert.deepEqual(unifiedFor(rawText, snapshot).previousUploadPositions, sorted(copiedPositions));
});

// --- 5. Only verified raw positions ------------------------------------------

testV1("ONLY VERIFIED: every stored raw run spells exactly the verified canonical words, fragment for fragment", async () => {
  const copied = "Paleobotanists examining amber inclusions from Myanmar identified pollen grains clinging to a beetle's mandibles, the earliest direct evidence of insect pollination among cycad-like gymnosperms of the mid-Cretaceous.";
  const intro = markInsideWords("Commuters waiting beneath flickering platform lights complained loudly about delayed trains and overcrowded carriages yesterday.", 9, ZWJ);
  const copiedMarked = markInsideWords(copied, 7, ZWSP);
  const { rawText, copiedPositions } = compose([{ text: intro, copied: false }, { text: copiedMarked, copied: true }]);
  await indexSource("verified-source-account", copied);

  const snapshot = await snapshotFor("verified-viewer-account", rawText);
  assert.equal(snapshot.status, "MATCHED");
  const rawTokens = tokens(rawText);
  const direct = await matchAgainstUserSubmissionCorpus(client, { accountId: "verified-viewer-account", canonicalText: canonicalizeText(rawText) });
  const canonicalTokens = tokens(canonicalizeText(rawText));
  const canonicalBySize = [...direct.matches[0].passages].sort((a, b) => a.submittedWordStart - b.submittedWordStart);
  const storedBySize = [...snapshot.matches[0].passages].sort((a, b) => a.submittedWordStart - b.submittedWordStart);
  assert.equal(storedBySize.length, canonicalBySize.length);
  storedBySize.forEach((stored, index) => {
    const canonical = canonicalBySize[index];
    const rawSpelling = rawTokens.slice(stored.submittedWordStart, stored.submittedWordEnd + 1).join("");
    const verifiedSpelling = canonicalTokens.slice(canonical.submittedWordStart, canonical.submittedWordEnd + 1).join("");
    assert.equal(rawSpelling, verifiedSpelling, "a stored raw run must consist of exactly the verified canonical words' raw fragments");
    for (let p = stored.submittedWordStart; p <= stored.submittedWordEnd; p += 1) assert.ok(copiedPositions.has(p), `raw position ${p} (${rawTokens[p]}) is not copied text`);
  });
});

// --- 6. Overlapping mapped runs deduplicate downstream -----------------------

testV1("OVERLAP: two prior sources covering overlapping parts of one copied passage are unioned once per raw position", async () => {
  const words = "Ornithologists banding migrating warblers along the Gulf coast recorded individuals carrying radio transmitters that revealed nonstop overwater flights exceeding eighty hours, challenging assumptions about fat reserves and navigation during spring migration across open ocean.".split(" ");
  const sourceOne = words.slice(0, 24).join(" ");
  const sourceTwo = words.slice(12).join(" ");
  const intro = markInsideWords("Carpenters renovating the parish hall replaced rotten floorboards and repainted weathered window frames last summer.", 10);
  const copied = markInsideWords(words.join(" "), 6, ZWNJ);
  const { rawText, copiedPositions } = compose([{ text: intro, copied: false }, { text: copied, copied: true }]);
  await indexSource("overlap-source-account-one", sourceOne);
  await indexSource("overlap-source-account-two", sourceTwo);

  const snapshot = await snapshotFor("overlap-viewer-account", rawText);
  assert.equal(snapshot.status, "MATCHED");
  assert.equal(snapshot.matches.length, 2);
  const perMatch = snapshot.matches.map((m) => passagePositions(m.passages));
  const expectedUnion = new Set([...perMatch[0], ...perMatch[1]]);
  const overlap = [...perMatch[0]].filter((p) => perMatch[1].has(p));
  assert.ok(overlap.length > 0, "fixture sanity: the two mapped runs must overlap");
  for (const p of expectedUnion) assert.ok(copiedPositions.has(p), `raw position ${p} is not copied text`);

  const unified = unifiedFor(rawText, snapshot);
  assert.equal(unified.uniqueMatchedWords, expectedUnion.size, "overlapping raw runs are counted once");
  assert.deepEqual(unified.previousUploadPositions, sorted(expectedUnion));
  assert.equal(new Set(unified.previousUploadPositions).size, unified.previousUploadPositions.length);
});

// --- 7. Determinism ------------------------------------------------------------

testV1("DETERMINISM: recomputing the zero-width fixture yields identical raw passages and positions", async () => {
  const intro = markInsideWords(GLACIER_INTRO, 17);
  const { rawText } = compose([{ text: intro, copied: false }, { text: GLACIER_COPIED, copied: true }, { text: GLACIER_OUTRO, copied: false }]);
  const first = await snapshotFor("zw-viewer-account", rawText);
  const second = await snapshotFor("zw-viewer-account", rawText);
  assert.equal(first.status, "MATCHED");
  assert.deepEqual(first.matches, second.matches);
  assert.deepEqual(unifiedFor(rawText, first), unifiedFor(rawText, second));
});

// --- 8. Score changes only where the old projection credited wrong tokens ----

testV1("SCORE ATTRIBUTION: the unified score moves only by positions the canonical-as-raw reading got wrong", async () => {
  const intro = markInsideWords(GLACIER_INTRO, 17);
  const { rawText, copiedPositions } = compose([{ text: intro, copied: false }, { text: GLACIER_COPIED, copied: true }, { text: GLACIER_OUTRO, copied: false }]);
  const snapshot = await snapshotFor("zw-viewer-account", rawText);
  const fixed = new Set(unifiedFor(rawText, snapshot).previousUploadPositions);

  // The pre-fix reading: canonical passage positions used verbatim as raw positions.
  const direct = await matchAgainstUserSubmissionCorpus(client, { accountId: "zw-viewer-account", canonicalText: canonicalizeText(rawText) });
  const legacySnapshot = { ...snapshot, matches: direct.matches.map((m) => ({ ...m, passages: m.passages.map(({ externalWordStart, ...rest }) => rest) })) };
  const legacy = new Set(unifiedFor(rawText, legacySnapshot).previousUploadPositions);

  const removed = [...legacy].filter((p) => !fixed.has(p));
  const added = [...fixed].filter((p) => !legacy.has(p));
  assert.equal(removed.length, 17, "one wrongly credited raw token per in-word zero-width mark before the passage");
  for (const p of removed) assert.ok(!copiedPositions.has(p), `removed position ${p} must be a non-copied token`);
  for (const p of added) assert.ok(copiedPositions.has(p), `added position ${p} must be a copied token`);
  assert.equal(added.length, removed.length, "the copied tail the drift used to miss is exactly as long as the misplaced head");

  // No zero-width marks: the old and new readings are identical.
  const plainRaw = compose([{ text: GLACIER_INTRO, copied: false }, { text: GLACIER_COPIED, copied: true }, { text: GLACIER_OUTRO, copied: false }]).rawText;
  const plainSnapshot = await snapshotFor("zw-viewer-account", plainRaw);
  const plainDirect = await matchAgainstUserSubmissionCorpus(client, { accountId: "zw-viewer-account", canonicalText: canonicalizeText(plainRaw) });
  const plainLegacy = { ...plainSnapshot, matches: plainDirect.matches.map((m) => ({ ...m, passages: m.passages.map(({ externalWordStart, ...rest }) => rest) })) };
  assert.deepEqual(unifiedFor(plainRaw, plainSnapshot), unifiedFor(plainRaw, plainLegacy));
});

// --- 9. Snapshots cached before the fix are recomputed, not reused ----------

// The tag every snapshot row written before this fix carries: the unchanged
// matcher label plus the unchanged config digest, with no position-space
// segment. Rebuilt here from the inputs lib/report-historical-match.ts
// digests (same stable key order), independently of SNAPSHOT_MATCHER_VERSION.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
const PRE_FIX_SNAPSHOT_MATCHER_VERSION = `${USER_SUBMISSION_MATCHER_VERSION}+cfg.${createHash("sha256")
  .update(stableStringify({ thresholds: USER_SUBMISSION_MATCH_THRESHOLDS, corpusActivationDelayDays: CORPUS_ACTIVATION_DELAY_DAYS }))
  .digest("hex")
  .slice(0, 12)}`;

async function snapshotRow(deviceKey, reportId) {
  const rows = await client.execute({
    sql: "SELECT rowid, * FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?",
    args: [deviceKey, reportId],
  });
  assert.equal(rows.rows.length, 1, "exactly one snapshot row per report");
  return rows.rows[0];
}
async function snapshotColumns() {
  const info = await client.execute("PRAGMA table_info(report_historical_match_snapshots)");
  return info.rows.map((row) => `${row.name}:${row.type}`);
}

/**
 * Writes the row the pre-fix code stored for this report: the matcher's
 * canonical-index passages serialized verbatim (the pre-fix
 * serializeMatchesForStorage field set), current in every respect except
 * `matcherVersion`.
 */
async function seedPreFixSnapshot({ deviceKey, reportId, viewerAccountId, rawText, matcherVersion, computedAt }) {
  const direct = await matchAgainstUserSubmissionCorpus(client, { accountId: viewerAccountId, canonicalText: canonicalizeText(rawText) });
  assert.equal(direct.status, "MATCHED");
  const matches = direct.matches.map((m) => ({
    relationshipType: m.relationshipType,
    matchedRepresentationId: m.matchedRepresentationId,
    matchType: m.matchType,
    containment: m.containment,
    matchedWordCount: m.matchedWordCount,
    passageCount: m.passageCount,
    longestMatchWords: m.longestMatchWords,
    passages: m.passages.map((p) => ({ submittedText: p.submittedText, submittedWordStart: p.submittedWordStart, submittedWordEnd: p.submittedWordEnd, matchedWordCount: p.matchedWordCount })),
    historicalSubmissionCount: m.historicalSubmissionCount,
  }));
  await client.execute({
    sql: `INSERT INTO report_historical_match_snapshots
            (report_device_key, report_id, status, matcher_version, fingerprint_version, canonicalization_version, result_json, candidate_count, processing_duration_ms, error_message, computed_at, is_partial, corpus_generation, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [deviceKey, reportId, "MATCHED", matcherVersion, CORPUS_FINGERPRINT_VERSION, CANONICALIZATION_VERSION, JSON.stringify(matches), matches.length, 7, null, computedAt, 0, await getCurrentCorpusMatchGeneration(client)],
  });
  return matches;
}

/** The zero-width repro fixture, attached to a fresh saved report. */
async function zeroWidthReport(label) {
  const fixture = compose([
    { text: markInsideWords(GLACIER_INTRO, 17), copied: false },
    { text: GLACIER_COPIED, copied: true },
    { text: GLACIER_OUTRO, copied: false },
  ]);
  const deviceKey = `device-raw-pos-version-${label}`;
  const reportId = `report-raw-pos-version-${label}`;
  await ensureSavedReport(deviceKey, reportId, "zw-viewer-account");
  return { ...fixture, deviceKey, reportId, viewerAccountId: "zw-viewer-account" };
}

testV1("SNAPSHOT VERSION: the new tag differs from the pre-fix tag only by the position-space segment", () => {
  // The matcher label itself has since moved (v1 -> v2, when the candidate and
  // verified-source caps were removed); what this section pins is the tag
  // WITHOUT a position-space segment, whatever the label.
  assert.match(PRE_FIX_SNAPSHOT_MATCHER_VERSION, /^user-submission-match-v\d+\+cfg\.[0-9a-f]{12}$/);
  assert.notEqual(SNAPSHOT_MATCHER_VERSION, PRE_FIX_SNAPSHOT_MATCHER_VERSION);
  // Same matcher label, same thresholds/maturity config digest: no threshold,
  // scoring or discovery config moved — only the stored position space.
  assert.equal(SNAPSHOT_MATCHER_VERSION.replace("+pos.raw-token-v1", ""), PRE_FIX_SNAPSHOT_MATCHER_VERSION);
});

testV1("SNAPSHOT VERSION: a pre-fix snapshot is not reused — it is recomputed with raw positions and persisted in place under the new version", async () => {
  const fx = await zeroWidthReport("stale");
  const sentinelComputedAt = new Date(Date.now() - 60_000).toISOString();
  const columnsBefore = await snapshotColumns();
  const preFix = await seedPreFixSnapshot({ ...fx, matcherVersion: PRE_FIX_SNAPSHOT_MATCHER_VERSION, computedAt: sentinelComputedAt });
  const seededRow = await snapshotRow(fx.deviceKey, fx.reportId);

  // Fixture sanity: the seeded row really carries the drift — 17 credited raw tokens outside the copied text.
  const rawTokens = tokens(fx.rawText);
  assert.equal(sorted(passagePositions(preFix[0].passages)).filter((p) => !fx.copiedPositions.has(p)).length, 17);

  const snapshot = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: fx.deviceKey, reportId: fx.reportId, accountId: fx.viewerAccountId, rawText: fx.rawText });

  // Not reused.
  assert.notEqual(snapshot.computedAt, sentinelComputedAt, "the pre-fix row must not be served from cache");
  assert.equal(snapshot.matcherVersion, SNAPSHOT_MATCHER_VERSION);
  // Recomputed through the corrected canonical->raw mapping.
  assert.equal(snapshot.status, "MATCHED");
  const [match] = snapshot.matches;
  assert.equal(match.relationshipType, "PRIOR_SUBMISSION");
  assert.equal(match.matchType, "STRONG_TEXT_MATCH");
  assert.deepEqual(match.passages.map((p) => [p.submittedWordStart, p.submittedWordEnd]), [[fx.ranges[1].start, fx.ranges[1].end]]);
  const credited = passagePositions(match.passages);
  assert.deepEqual(sorted(credited).filter((p) => !fx.copiedPositions.has(p)).map((p) => `${p}:${rawTokens[p]}`), []);
  assert.deepEqual(sorted(credited), sorted(fx.copiedPositions));
  // The matcher's own match-level statistics are unchanged by the recompute.
  for (const key of ["relationshipType", "matchedRepresentationId", "matchType", "containment", "matchedWordCount", "passageCount", "longestMatchWords", "historicalSubmissionCount"]) {
    assert.deepEqual(match[key], preFix[0][key], key);
  }

  // Persisted under the new version, upserted in place, identical to what was returned.
  const row = await snapshotRow(fx.deviceKey, fx.reportId);
  assert.equal(row.matcher_version, SNAPSHOT_MATCHER_VERSION);
  assert.equal(row.computed_at, snapshot.computedAt);
  assert.equal(Number(row.rowid), Number(seededRow.rowid), "recompute overwrites the same row, never appends");
  assert.deepEqual(JSON.parse(row.result_json), snapshot.matches);

  // No extra score positions: exactly the copied raw tokens, where the pre-fix row scored 17 non-source ones.
  const unified = unifiedFor(fx.rawText, snapshot);
  assert.deepEqual(unified.previousUploadPositions, sorted(fx.copiedPositions));
  assert.equal(unified.uniqueMatchedWords, fx.copiedPositions.size);
  const preFixUnified = unifiedFor(fx.rawText, { ...snapshot, matches: preFix });
  assert.equal(preFixUnified.previousUploadPositions.filter((p) => !fx.copiedPositions.has(p)).length, 17);

  // No DB migration: the invalidation lives in the existing matcher_version TEXT column.
  assert.deepEqual(await snapshotColumns(), columnsBefore);
});

testV1("SNAPSHOT VERSION: a version-current row is reused as-is — why pre-fix rows needed a new version to stop being trusted", async () => {
  const fx = await zeroWidthReport("current-tag-control");
  const sentinelComputedAt = new Date(Date.now() - 60_000).toISOString();
  // The same pre-fix row, stamped with the tag the running code writes — what
  // every pre-fix row looked like to the code before the version moved.
  const preFix = await seedPreFixSnapshot({ ...fx, matcherVersion: SNAPSHOT_MATCHER_VERSION, computedAt: sentinelComputedAt });
  const snapshot = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: fx.deviceKey, reportId: fx.reportId, accountId: fx.viewerAccountId, rawText: fx.rawText });
  assert.equal(snapshot.computedAt, sentinelComputedAt, "a version-current row is a cache hit; nothing else invalidates it");
  assert.deepEqual(snapshot.matches, preFix);
});

testV1("SNAPSHOT VERSION: a corrected snapshot is then reused without recompute, and repeated reads are deterministic", async () => {
  const fx = await zeroWidthReport("reuse");
  await seedPreFixSnapshot({ ...fx, matcherVersion: PRE_FIX_SNAPSHOT_MATCHER_VERSION, computedAt: new Date(Date.now() - 60_000).toISOString() });
  const params = { reportDeviceKey: fx.deviceKey, reportId: fx.reportId, accountId: fx.viewerAccountId, rawText: fx.rawText };
  const recomputed = await getOrComputeHistoricalMatchSnapshot(client, params);
  const rowAfterRecompute = await snapshotRow(fx.deviceKey, fx.reportId);

  for (let i = 0; i < 3; i += 1) {
    const read = await getOrComputeHistoricalMatchSnapshot(client, params);
    assert.equal(read.computedAt, recomputed.computedAt, "a version-current corrected row is a cache hit");
    assert.deepEqual(read, recomputed, "repeated reads are identical");
    assert.deepEqual(unifiedFor(fx.rawText, read), unifiedFor(fx.rawText, recomputed));
  }
  assert.deepEqual(await snapshotRow(fx.deviceKey, fx.reportId), rowAfterRecompute, "a cache hit never rewrites the row");
  // The lazy recompute equals a first-ever computation of the same text.
  const fresh = await snapshotFor(fx.viewerAccountId, fx.rawText);
  assert.deepEqual(fresh.matches, recomputed.matches);
});

testV1("SNAPSHOT VERSION: the score-resolution write path cannot consume a pre-fix snapshot", async () => {
  const fx = await zeroWidthReport("resolution");
  await seedPreFixSnapshot({ ...fx, matcherVersion: PRE_FIX_SNAPSHOT_MATCHER_VERSION, computedAt: new Date(Date.now() - 60_000).toISOString() });
  const resolution = await resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: fx.deviceKey,
    reportId: fx.reportId,
    accountId: fx.viewerAccountId,
    rawText: fx.rawText,
    wordCount: tokens(fx.rawText).length,
    archiveMatchedPositions: [],
    externalAcademicEvidence: [],
    archiveScore: 0,
  });
  assert.equal(resolution.historicalSubmissionMatch.matcherVersion, SNAPSHOT_MATCHER_VERSION);
  assert.ok(resolution.unifiedSimilarity);
  assert.deepEqual(resolution.unifiedSimilarity.previousUploadPositions, sorted(fx.copiedPositions));
  assert.deepEqual(resolution.unifiedSimilarity.matchedPositions, sorted(fx.copiedPositions));
  assert.equal((await snapshotRow(fx.deviceKey, fx.reportId)).matcher_version, SNAPSHOT_MATCHER_VERSION);
});

// --- scoring normalization v2 ------------------------------------------------
// The same kind of manuscript resolved as a v2 report. The tokenizer deletes the invisible characters on both sides, so
// raw and canonical positions coincide, and marks v1 could never see through (soft hyphen, word joiner) no longer hide a
// copied word from the matcher.

const V2_INTRO = markInsideWords(GLACIER_INTRO, 17);
const V2_COPIED = GLACIER_COPIED
  .replace("Glaciologists", `Glacio${ZWSP}logists`)
  .replace("volcanic", `vol${SOFT_HYPHEN}canic`)
  .replace("stratigraphic", `strati${ZWSP}${ZWSP}gra${ZWJ}phic`)
  .replace("uncertainty", `uncer${WORD_JOINER}tainty`);
const V2_PARTS = [
  { text: V2_INTRO, copied: false },
  { text: V2_COPIED, copied: true },
  { text: GLACIER_OUTRO, copied: false },
];

testV2("V2 ZERO-WIDTH REPRO: resolved as a v2 report, the marked passage is credited as exactly the words it reads as — no fragment, no neighbour", async () => {
  const { rawText, ranges, copiedPositions } = compose(V2_PARTS);
  // v2 reads the marked passage as the clean one: the same number of words as the source passage.
  assert.deepEqual(tokens(V2_COPIED), tokens(GLACIER_COPIED));
  assert.deepEqual(tokens(rawText), tokens(canonicalizeText(rawText)), "raw and canonical positions coincide under v2");

  const snapshot = await snapshotFor("zw-v2-viewer-account", rawText, 2);
  assert.equal(snapshot.status, "MATCHED");
  assert.equal(snapshot.matcherVersion, snapshotMatcherVersion(2), "computed under, and tagged with, the report's contract");
  const [match] = snapshot.matches;
  assert.equal(match.relationshipType, "PRIOR_SUBMISSION");
  assert.equal(match.matchType, "STRONG_TEXT_MATCH");
  assert.deepEqual(match.passages.map((p) => [p.submittedWordStart, p.submittedWordEnd]), [[ranges[1].start, ranges[1].end]]);
  assert.equal(match.passages[0].matchedWordCount, tokens(GLACIER_COPIED).length);
  assert.deepEqual(sorted(passagePositions(match.passages)), sorted(copiedPositions));
  const unified = unifiedFor(rawText, snapshot);
  assert.deepEqual(unified.previousUploadPositions, sorted(copiedPositions));
  assert.equal(unified.uniqueMatchedWords, copiedPositions.size);
});

test("V1 vs V2: one manuscript resolved under each contract — two position spaces, each credited only on copied words, v2 seeing the words v1 cannot", async () => {
  const resolve = (version, viewer) => runWithScoringNormalization(version, async () => {
    const composed = compose(V2_PARTS);
    const snapshot = await snapshotFor(viewer, composed.rawText, version);
    assert.equal(snapshot.status, "MATCHED", `v${version}`);
    assert.equal(snapshot.matcherVersion, snapshotMatcherVersion(version), `v${version}`);
    const credited = passagePositions(snapshot.matches[0].passages);
    const rawTokens = tokens(composed.rawText);
    assert.deepEqual(sorted(credited).filter((p) => !composed.copiedPositions.has(p)).map((p) => `${p}:${rawTokens[p]}`), [], `v${version}: nothing credited outside the copied text`);
    // A stored passage's own words are spelled by the raw words at its positions (v1: a zero-width-split word is two
    // raw fragments of one verified word, so the spelling is compared without the fragment boundaries).
    for (const passage of snapshot.matches[0].passages) {
      assert.equal(rawTokens.slice(passage.submittedWordStart, passage.submittedWordEnd + 1).join(""), passage.submittedText.replace(/ /g, ""), `v${version}: a stored passage's words are the words at its positions`);
    }
    return { credited, copied: composed.copiedPositions, range: composed.ranges[1] };
  });
  const v1 = await resolve(1, "contrast-v1-viewer-account");
  const v2 = await resolve(2, "contrast-v2-viewer-account");
  // 17 in-word marks in the intro: the passage starts 17 words later in v1 space.
  assert.equal(v1.range.start, v2.range.start + 17);
  // v2 credits the whole passage. v1 cannot verify the two words a soft hyphen / word joiner still splits.
  assert.deepEqual(sorted(v2.credited), sorted(v2.copied));
  assert.ok(v1.credited.size < v1.copied.size, "v1 leaves the soft-hyphen and word-joiner fragments uncredited");
});

test("SNAPSHOT CONTRACT: a stored snapshot is reused only for the contract it was computed under, and recomputed in place for the other", async () => {
  const { rawText } = runWithScoringNormalization(1, () => compose(V2_PARTS));
  const deviceKey = "device-raw-pos-contract";
  const reportId = "report-raw-pos-contract";
  await ensureSavedReport(deviceKey, reportId, "contract-viewer-account");
  const ask = (scoringNormalizationVersion) => getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "contract-viewer-account", rawText, scoringNormalizationVersion });
  const stored = async () => {
    const row = (await client.execute({ sql: "SELECT matcher_version, result_json, computed_at FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?", args: [deviceKey, reportId] })).rows[0];
    return { tag: String(row.matcher_version), start: Math.min(...JSON.parse(String(row.result_json))[0].passages.map((p) => p.submittedWordStart)) };
  };

  const first = await ask(1);
  assert.equal(first.matcherVersion, SNAPSHOT_MATCHER_VERSION);
  const v1Row = await stored();
  assert.equal(v1Row.tag, snapshotMatcherVersion(1));

  // The same call again is a cache hit: the row is returned as it is.
  assert.deepEqual(await ask(1), first);

  // Asked for as a v2 report, the v1 row is not current: recomputed under v2 and replaced.
  const second = await ask(2);
  assert.equal(second.matcherVersion, snapshotMatcherVersion(2));
  const v2Row = await stored();
  assert.equal(v2Row.tag, snapshotMatcherVersion(2));
  assert.equal(v2Row.start, v1Row.start - 17, "the passage starts 17 words earlier in v2 space");

  // …and the other way round.
  const third = await ask(1);
  assert.equal(third.matcherVersion, snapshotMatcherVersion(1));
  assert.deepEqual((await stored()).start, v1Row.start);
  assert.deepEqual(third.matches, first.matches);
});
