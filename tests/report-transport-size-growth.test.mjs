import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import { resetRateForTest, resetAuthRateForTest } from '../lib/rate-limit.ts';
import { canonicalSha256 } from '../lib/document-identity.ts';
import { runCorpusAdmissionPromotionSweep } from '../lib/corpus-admission-promotion.ts';
import { matureCorpusBackings } from './helpers/corpus-maturity.mjs';
import { withTestIdentity, markTestAccountEmailVerified } from './helpers/test-signup.mjs';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { MAX_REPORT_SAVE_REQUEST_BYTES } from '../lib/report-transport-limits.ts';
import { resolvePrimarySimilaritySummary, selfHealUnifiedSimilarity } from '../lib/report-primary-similarity.ts';
import { withEvidenceInterpretation } from '../lib/report-evidence-interpretation.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import {
  compactUnifiedSimilarityForPersistence,
  PREVIOUS_UPLOAD_POSITIONS_ENCODING_MATCHED_POSITIONS,
} from '../lib/unified-similarity-persistence.ts';

/**
 * Pre-launch hardening audit follow-up (long-document/2MB-ceiling
 * characterization) — the confirmed coverage gap: no existing test proves a
 * request that is legitimately UNDER MAX_REPORT_SAVE_REQUEST_BYTES as sent
 * can still be rejected with 413 once the REAL server-side write-time
 * finalization (resolvePrimarySimilaritySummary -> computeUnifiedSimilarity,
 * fed by the real historical-submission matcher against real promoted
 * corpus sources) grows the persisted payload past the ceiling. This
 * exercises the REAL app/api/reports/route.ts POST handler (and, for the GET
 * expansion assertions, the REAL app/api/reports/[id]/route.ts GET handler)
 * end to end against a real, isolated, migrated SQLite DB — no standalone
 * fake serializer, no mocked route.
 *
 * Mechanism reused verbatim from tests/report-write-time-finalization.test.mjs
 * (promoteDocumentIntoCorpus / signUpConsentingAccount / real POST): a
 * corpus-admission-promoted document is genuine, server-authoritative
 * evidence the historical-submission matcher
 * (lib/user-submission-matching.ts) finds independently of anything the
 * client sends — the client cannot forge or influence which promoted
 * documents match, only supply the manuscript text being checked.
 *
 * Growth budget note: the real matcher config
 * (lib/user-submission-matching.ts's USER_SUBMISSION_MATCH_THRESHOLDS) caps
 * this channel at maxCandidates=10 matched sources and maxPassages=10
 * passages per source (60 words per passage) — a few tens of KB of real
 * server-computed growth, not megabytes. That is exactly why the incoming
 * request is deliberately built close to (not far below) the ceiling: this
 * test proves the realistic "long document + many independently
 * corroborating sources" failure mode from the audit, not an artificially
 * huge single string.
 *
 * FIX IMPLEMENTED (this revision): lib/unified-similarity-persistence.ts's
 * compactUnifiedSimilarityForPersistence() elides the exact duplicate
 * previousUploadPositions array (proven, for this fixture, to be
 * byte-for-byte identical to matchedPositions) at the PERSISTENCE boundary
 * only — computeUnifiedSimilarity's own in-memory result stays fully
 * expanded, and every customer-facing read path (GET, SSR) transparently
 * re-expands it. The "main case" test below therefore now asserts the
 * DECISIVE PASS outcome (real POST returns 200, not 413) instead of the
 * previously-documented failure; a self-contained UNCOMPACTED-equivalent
 * reconstruction proves what would still happen without this fix, and a
 * real GET proves the expanded, backward-compatible response shape.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_report_transport_size_growth.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = 'true';

const client = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(client, drizzleDir);
const openConnection = () => createClient({ url: `file:${dbFile}` });

test.after(() => {
  client.close();
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

// R2 — compact persisted-report WRITES are an opt-in rollout gate (REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED, default OFF). This file measures
// the 2,000,000-byte persistence ceiling: the decisive near-ceiling save only fits when compact writes are enabled, and with the gate OFF the same
// report must FAIL CLOSED (413, nothing persisted) — never be persisted as a score without its explanation. Returns the restore function.
const COMPACT_GATE = "REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED";
function pinCompactWrites(value) {
  const previous = process.env[COMPACT_GATE];
  if (value === undefined) delete process.env[COMPACT_GATE];
  else process.env[COMPACT_GATE] = value;
  return () => {
    if (previous === undefined) delete process.env[COMPACT_GATE];
    else process.env[COMPACT_GATE] = previous;
  };
}

// -- corpus promotion + account setup, copied verbatim in structure from
// tests/report-write-time-finalization.test.mjs's own helpers (same schema,
// same real promotion pipeline) --

async function insertDecision(hash) {
  const id = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_decisions
          (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
           detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
           content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
           corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
           consent_metadata, dry_run, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [
      id, null, `transport-size-growth-${randomUUID()}`, 'v1', 'ACCEPT', '[]', 1, '[]',
      'txt', 150, 'English', 0.95, hash, 'v1', null, 80, 'v1',
      '{}', '{}', 'v1', 0.9, 'v1', 'NONE', null, null,
      JSON.stringify({ kind: 'PER_USER_CONSENT', consented: true }), 0,
    ],
  });
  return id;
}

async function promoteDocumentIntoCorpus(text) {
  const hash = canonicalSha256(text);
  const decisionId = await insertDecision(hash);
  await client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          VALUES (?,?,?,?,?,NULL,CURRENT_TIMESTAMP)`,
    args: [randomUUID(), decisionId, hash, 150, 'v1'],
  });
  await client.execute({
    sql: `INSERT INTO corpus_admission_content_store (id, decision_id, canonical_sha256, canonical_text, extractor_version, retention_basis, stored_at)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [randomUUID(), decisionId, hash, text, 'v1', 'LICENSED_REUSE'],
  });
  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const outcome = sweep.results.find((r) => r.decisionId === decisionId);
  assert.equal(outcome?.outcome, 'indexed', 'test setup sanity: promotion must succeed');
  await matureCorpusBackings(client);
}

let userCounter = 0;
async function signUpConsentingAccount() {
  userCounter += 1;
  const email = `transport-size-growth-user-${userCounter}@example.test`;
  await resetAuthRateForTest('transport-size-growth-signup-' + userCounter);
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'transport-size-growth-signup-' + userCounter },
    body: JSON.stringify(withTestIdentity({ email, password: 'transport-size-growth-pw-1', username: `tsguser${userCounter}`, deviceKey: `transport-size-growth-device-${userCounter}` })),
  });
  const res = await signupRoute.POST(req);
  assert.equal(res.status, 201, 'test setup sanity: signup must succeed');
  const setCookie = res.headers.get('set-cookie');
  const cookie = setCookie ? setCookie.match(/tp_session_v1=([^;]*)/)?.[1] ?? null : null;
  const row = await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] });
  const userId = row.rows[0].id;
  await client.execute({ sql: "UPDATE users SET corpus_reuse_consented_at = CURRENT_TIMESTAMP WHERE id = ?", args: [userId] });
  await markTestAccountEmailVerified(dbFile, email);
  return { userId, deviceKey: `transport-size-growth-device-${userCounter}`, cookie, tag: `transport-size-growth-${userCounter}` };
}

// -- SYNTHETIC content only (never SEALED20, reserved ~600, or customer
// content). Ten distinctive, non-generic short passages -- comfortably
// above the real matcher's minimumDistinctivePassageWords(30)/
// minimumMatchedWords(15) floors, and distinctive enough (each about an
// unrelated invented technical topic, mirroring DOCUMENT_A_TEXT's own
// style in report-write-time-finalization.test.mjs) not to collide with
// each other's shingles or read as generic academic boilerplate. --
const DISTINCTIVE_PASSAGES = [
  'Marine biologists tracking a newly identified bioluminescent cephalopod species in the Mariana Trench observed a previously unrecorded synchronized flashing pattern among clustered individuals, suggesting a coordinated predator-deterrence signal rather than the solitary defensive flash documented in shallower related species, a behavioral distinction with direct implications for deep-sea conservation zoning.',
  'Materials scientists synthesizing a novel graphene-lattice composite under extreme cryogenic pressure discovered an unexpected superconducting threshold nearly thirty degrees above the previously theorized ceiling, prompting a reexamination of the phonon-coupling models long assumed to govern low-temperature conductivity in two-dimensional carbon structures.',
  'Linguists cataloguing an endangered Andean tonal dialect identified a grammatical marker encoding relative elevation directly into verb morphology, a feature absent from every neighboring language family surveyed, raising new questions about how geographic terrain can shape core syntactic structure rather than merely vocabulary.',
  'Volcanologists monitoring seismic harmonics beneath a long-dormant Icelandic caldera detected a rhythmic subsurface resonance pattern inconsistent with typical magmatic recharge, leading the team to propose an alternative hydrothermal circulation model to explain the anomaly before any renewed eruptive activity could be assumed.',
  'Entomologists studying a rediscovered subterranean beetle population noted an unusual bioluminescent courtship display performed entirely underground, a behavior never previously documented in any related genus, complicating existing assumptions that bioluminescent signaling in beetles evolved exclusively for above-ground visibility.',
  'Climatologists reanalyzing ice-core samples from a remote Antarctic ridge identified a centuries-old dust-deposition spike correlating with a previously unlinked volcanic event on a different continent, suggesting stratospheric transport pathways far more extensive than earlier atmospheric circulation models had accounted for.',
  'Roboticists testing a soft-bodied underwater exploration prototype observed an emergent self-righting behavior that had not been explicitly programmed, tracing the effect to an unanticipated interaction between the buoyancy chambers and the flexible actuator array rather than any deliberate control routine.',
  'Paleontologists examining a newly excavated fossil trackway proposed a revised gait interpretation for a mid-sized theropod, arguing that the irregular stride spacing reflects terrain-adaptive locomotion rather than injury, a reading that would meaningfully shift existing biomechanical reconstructions of the species.',
  'Astrochemists analyzing spectral data from a distant protoplanetary disk detected an unexpected concentration of a complex organic molecule not previously observed outside laboratory synthesis, reopening debate over whether such compounds can form spontaneously in the low-density conditions typical of early planetary formation.',
  'Neuroscientists mapping olfactory response pathways in a nocturnal rodent species identified a secondary neural circuit activated only under specific humidity conditions, a finding that suggests environmental context can gate entire sensory pathways rather than merely modulating the intensity of an already-active one.',
];

/**
 * Extends each seed passage above into a much longer, still-distinctive
 * document by deterministically recombining that SAME seed's own words into
 * new sentences (word-shift + reversal patterns, no RNG) -- this keeps
 * every extended passage topically coherent and non-generic (never
 * FILLER_WORDS/boilerplate vocabulary) while giving the real matcher a
 * genuinely large matched-word span per source, comfortably under
 * lib/user-submission-matching.ts's maxCandidateWordCount(20,000) ceiling.
 * Each source is embedded VERBATIM into the submission below, so containment
 * stays ~1.0 regardless of length -- length only affects matchedWordCount/
 * position-array volume, the actual quantity under test.
 */
function extendDistinctivePassage(seed, targetWords) {
  const seedWords = seed.replace(/[.,]/g, '').split(/\s+/).filter(Boolean);
  const sentences = [seed];
  let totalWords = seedWords.length;
  let shift = 0;
  while (totalWords < targetWords) {
    shift += 7;
    const rotated = [...seedWords.slice(shift % seedWords.length), ...seedWords.slice(0, shift % seedWords.length)];
    const sentence = rotated.join(' ') + '.';
    sentences.push(sentence);
    totalWords += rotated.length;
  }
  return sentences.join(' ');
}

const EXTENDED_PASSAGE_WORDS = 5000;
const EXTENDED_PASSAGES = DISTINCTIVE_PASSAGES.map((seed) => extendDistinctivePassage(seed, EXTENDED_PASSAGE_WORDS));

/** Deterministic filler vocabulary -- varied, plain, tokenizable prose, never a single repeated character/word (so real tokenization/shingling behaves like ordinary text, not degenerate filler). No RNG: the same run always produces byte-identical output. */
const FILLER_WORDS = [
  'analysis', 'framework', 'observed', 'context', 'outcome', 'variable', 'structure', 'approach', 'evidence', 'pattern',
  'process', 'measure', 'sample', 'result', 'method', 'factor', 'detail', 'region', 'system', 'model',
  'signal', 'response', 'feature', 'domain', 'element', 'sequence', 'record', 'report', 'summary', 'section',
  'chapter', 'finding', 'concept', 'theory', 'practice', 'setting', 'source', 'target', 'input', 'output',
];

function buildFillerText(targetChars) {
  const parts = [];
  let length = 0;
  let index = 0;
  while (length < targetChars) {
    const word = FILLER_WORDS[index % FILLER_WORDS.length] + String(index % 97);
    parts.push(word);
    length += word.length + 1;
    index += 1;
  }
  return parts.join(' ');
}

/**
 * Builds a large synthetic manuscript around a target character count.
 * `embedPassages: true` splices all ten EXTENDED_PASSAGES verbatim into
 * the filler at evenly spaced points (giving the real historical matcher
 * genuine, independently-discoverable evidence for up to ten separate
 * corpus sources, each a large matched span, not just a short marker);
 * `embedPassages: false` produces a same-shape document with none of that
 * evidence (the paired below-limit control, section 8).
 */
function buildManuscript(targetChars, embedPassages) {
  if (!embedPassages) return buildFillerText(targetChars);
  const passagesLength = EXTENDED_PASSAGES.join(' ').length;
  const segments = EXTENDED_PASSAGES.length + 1;
  const fillerPerSegment = Math.max(0, Math.floor((targetChars - passagesLength) / segments));
  const chunks = [];
  for (let i = 0; i < EXTENDED_PASSAGES.length; i += 1) {
    chunks.push(buildFillerText(fillerPerSegment));
    chunks.push(EXTENDED_PASSAGES[i]);
  }
  chunks.push(buildFillerText(fillerPerSegment));
  return chunks.join(' ');
}

function buildRequestBody({ deviceKey, id, text, unifiedSimilarityForgery, room }) {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return {
    deviceKey,
    id,
    submissionId: 'sub-' + id,
    title: 'Transport size growth fixture',
    createdAt: new Date().toISOString(),
    wordCount,
    archiveScore: 0,
    scoreBand: 'Low',
    aiScore: null,
    aiTone: null,
    room,
    payload: {
      version: 11, id, submissionId: 'sub-' + id, title: 'Transport size growth fixture',
      author: '', assignment: '', created: new Date().toISOString(),
      score: 0, archiveScore: 0, wordCount,
      scoreBand: 'Low', matchedWordCount: 0, sources: [], repeats: [], text,
      // Trust-boundary check (section 6): a plausible, small, STALE
      // client-computed unifiedSimilarity is submitted alongside the real
      // manuscript -- exactly the shape
      // tests/report-write-time-finalization.test.mjs's own postReport()
      // helper documents ("lets a caller submit exactly what a real client
      // resave would... so a test can prove the SERVER correctly overwrites
      // it"), and that exact overwrite behavior is already the dedicated
      // subject of that file's SIM-03 test (asserting the persisted
      // unifiedScore reflects the server's own computation, never the
      // client's). This test does not duplicate that full suite; it only
      // needs the growth demonstrated below to be attributable to the real
      // server computation regardless of what a client sends here.
      ...(unifiedSimilarityForgery ? { unifiedSimilarity: unifiedSimilarityForgery } : {}),
    },
  };
}

const FORGED_UNIFIED_SIMILARITY = {
  version: 'unified-similarity-v1',
  wordCount: 1,
  unifiedScore: 3,
  uniqueMatchedWords: 1,
  archiveOnlyWords: 0, liveAcademicOnlyWords: 0, previousUploadOnlyWords: 0, overlapWords: 0,
  selfExcludedWords: 0, unknownExcludedWords: 0, deviceSelfExcludedWords: 0,
  userSuppliedReferenceOnlyWords: 0, selectiveCorpusOnlyWords: 0,
  contributions: [],
  matchedPositions: [0],
  previousUploadPositions: [], userSuppliedReferencePositions: [], selectiveCorpusPositions: [],
  archiveMatchedPositions: [],
};

// ~1.85 MB target text -- comfortably inside the task's suggested 1.6-1.9 MB
// safety margin below the 2,000,000-byte ceiling, leaving headroom for the
// real matcher's bounded (tens-of-KB) growth to cross it.
const TARGET_TEXT_CHARS = 1_850_000;

test('REAL SERVER GROWTH: a request under MAX_REPORT_SAVE_REQUEST_BYTES as sent is rejected 413 once real server-side write-time finalization (real historical-submission matcher against real promoted corpus sources) grows the persisted payload past the ceiling', async (t) => {
  // Ten independent, genuine, server-trusted sources -- the client cannot
  // forge or influence which promoted documents the matcher finds.
  for (const passage of EXTENDED_PASSAGES) {
    await promoteDocumentIntoCorpus(passage);
  }
  const account = await signUpConsentingAccount();

  await t.test('main case (DECISIVE PASS): real POST now succeeds (200) because the measured exact-duplicate previousUploadPositions array is compacted at persistence, and GET returns the exact expanded pre-fix shape', async (st) => {
    st.after(pinCompactWrites('true')); // R2: the near-ceiling report only fits with compact writes enabled
    const text = buildManuscript(TARGET_TEXT_CHARS, true);
    const body = buildRequestBody({ deviceKey: account.deviceKey, id: 'growth-main-1', text, unifiedSimilarityForgery: FORGED_UNIFIED_SIMILARITY, room: 0 });
    const serialized = JSON.stringify(body);
    const incomingBytes = Buffer.byteLength(serialized, 'utf8');

    // --- A: incoming request remains under the ceiling ---
    console.log(`[report-transport-size-growth] incoming request bytes: ${incomingBytes} (${(incomingBytes / MAX_REPORT_SAVE_REQUEST_BYTES * 100).toFixed(2)}% of ${MAX_REPORT_SAVE_REQUEST_BYTES})`);
    assert.ok(incomingBytes < MAX_REPORT_SAVE_REQUEST_BYTES, `incoming request (${incomingBytes} bytes) must be under the ${MAX_REPORT_SAVE_REQUEST_BYTES}-byte ceiling before the real POST is even made`);
    assert.ok(incomingBytes > MAX_REPORT_SAVE_REQUEST_BYTES * 0.75, `incoming request should sit in the requested 1.6-1.9MB safety-margin band, not trivially small (${incomingBytes} bytes)`);

    // --- B/C: independently reproduce the SAME real server-trusted evidence
    // (a separate, read-only-relative-to-persistence reportId, deterministic
    // given the same real text + the same real already-promoted corpus) to
    // measure what the UNCOMPACTED equivalent payload would have been --
    // this is exactly finalizeReportJson's own pre-fix construction
    // (withEvidenceInterpretation's output, JSON.stringify'd), just without
    // ever calling compactUnifiedSimilarityForPersistence. ---
    const referenceResolution = await resolvePrimarySimilaritySummary(client, {
      reportDeviceKey: account.deviceKey,
      reportId: 'growth-main-1-uncompacted-reference',
      accountId: account.userId,
      rawText: text,
      wordCount: body.payload.wordCount,
      archiveMatchedPositions: null,
      externalAcademicEvidence: [],
      userSuppliedReferenceEvidence: null,
      archiveScore: 0,
      verifiedDevicePassportId: null,
    });
    assert.ok(referenceResolution.unifiedSimilarity, 'test setup sanity: this fixture must produce a real unifiedSimilarity result, matching the ten promoted sources');
    const uncompactedExpandedReport = withEvidenceInterpretation(
      {
        ...body.payload,
        unifiedSimilarity: referenceResolution.unifiedSimilarity,
        unifiedSimilarityFailed: false,
      },
      { historicalSubmissionMatch: referenceResolution.historicalSubmissionMatch, selectiveCorpusBranch: null },
    );
    const uncompactedBytes = Buffer.byteLength(JSON.stringify(uncompactedExpandedReport), 'utf8');
    console.log(`[report-transport-size-growth] UNCOMPACTED equivalent bytes: ${uncompactedBytes} (${(uncompactedBytes / MAX_REPORT_SAVE_REQUEST_BYTES * 100).toFixed(2)}% of ${MAX_REPORT_SAVE_REQUEST_BYTES})`);
    assert.ok(uncompactedBytes > MAX_REPORT_SAVE_REQUEST_BYTES, `requirement C: the uncompacted equivalent (${uncompactedBytes} bytes) must exceed the ${MAX_REPORT_SAVE_REQUEST_BYTES}-byte ceiling -- this is what CHECK 5 would have measured before this fix, matching the previously-established ~2,053,187-byte finding`);

    // --- D (part 1): the SAME real unifiedSimilarity, compacted, must be
    // smaller than the ceiling on its own terms (the exact function the real
    // route now calls) ---
    const compactedReference = compactUnifiedSimilarityForPersistence(referenceResolution.unifiedSimilarity);
    assert.equal(compactedReference.previousUploadPositionsEncoding, PREVIOUS_UPLOAD_POSITIONS_ENCODING_MATCHED_POSITIONS, 'test setup sanity: this fixture\'s previousUploadPositions must actually be eligible for compaction (byte-identical to matchedPositions)');
    const bytesRecovered = uncompactedBytes - Buffer.byteLength(JSON.stringify({ ...uncompactedExpandedReport, unifiedSimilarity: compactedReference }), 'utf8');
    const percentRecovered = (bytesRecovered / uncompactedBytes) * 100;
    console.log(`[report-transport-size-growth] bytes recovered by compaction: ${bytesRecovered} (${percentRecovered.toFixed(2)}%)`);

    // --- E: the real POST now returns 200, not 413 ---
    await resetRateForTest(account.tag + '-post-main');
    const req = new Request('http://localhost/api/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': account.tag + '-post-main', cookie: `tp_session_v1=${account.cookie}` },
      body: serialized,
    });
    // Content-Length is derived by the Request/undici implementation from
    // the real body string -- the SAME bytes just measured above, not a
    // separately-computed number, so this exercises the real route's real
    // Content-Length gate with the real incoming size.
    const res = await reportsRoute.POST(req);
    const resBodyText = await res.text();
    console.log(`[report-transport-size-growth] POST result: status=${res.status} body=${resBodyText.slice(0, 200)}`);
    assert.equal(res.status, 200, 'requirement E: the real POST must now succeed once the measured exact-duplicate array is compacted at persistence');
    let resBody;
    try { resBody = JSON.parse(resBodyText); } catch { resBody = null; }
    assert.equal(resBody?.ok, true, 'the success response must use the existing production contract');

    // --- F/G/H: the report is actually persisted, and the RAW payload_json
    // (read directly, bypassing every application-level expand path) proves
    // the exact compact shape -- matchedPositions present,
    // previousUploadPositionsEncoding="matchedPositions" present,
    // previousUploadPositions NOT duplicated, and the whole raw row under
    // the ceiling. ---
    const row = await client.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, 'growth-main-1'] });
    assert.equal(row.rows.length, 1, 'requirement F: the report must actually be persisted');
    const rawPayloadJson = String(row.rows[0].payload_json);
    const rawPersistedBytes = Buffer.byteLength(rawPayloadJson, 'utf8');
    console.log(`[report-transport-size-growth] compact CHECK-5 (raw persisted) bytes: ${rawPersistedBytes} (${(rawPersistedBytes / MAX_REPORT_SAVE_REQUEST_BYTES * 100).toFixed(2)}% of ${MAX_REPORT_SAVE_REQUEST_BYTES})`);
    assert.ok(rawPersistedBytes < MAX_REPORT_SAVE_REQUEST_BYTES, `requirement D/H: the persisted raw payload (${rawPersistedBytes} bytes) must be under the ${MAX_REPORT_SAVE_REQUEST_BYTES}-byte ceiling`);
    assert.ok(MAX_REPORT_SAVE_REQUEST_BYTES - rawPersistedBytes > 20_000, `requirement D: the compact size must clear the ceiling with a meaningful safety margin, not by a handful of bytes (margin: ${MAX_REPORT_SAVE_REQUEST_BYTES - rawPersistedBytes})`);

    const rawParsed = JSON.parse(rawPayloadJson);
    assert.ok(Array.isArray(rawParsed.unifiedSimilarity?.matchedPositions), 'requirement G: matchedPositions must remain persisted in full');
    assert.ok(rawParsed.unifiedSimilarity.matchedPositions.length > 0);
    assert.equal(rawParsed.unifiedSimilarity.previousUploadPositionsEncoding, PREVIOUS_UPLOAD_POSITIONS_ENCODING_MATCHED_POSITIONS, 'requirement G: the raw persisted row must carry the compaction marker');
    assert.equal('previousUploadPositions' in rawParsed.unifiedSimilarity, false, 'requirement G: the raw persisted row must NOT also carry the now-redundant duplicate array');

    // --- I: GET of that report returns the EXPANDED legacy shape -- via the
    // REAL GET route handler, not a hand-rolled expansion. ---
    await resetRateForTest(account.tag + '-get-main');
    const getReq = new Request(`http://localhost/api/reports/growth-main-1`, {
      headers: { 'x-forwarded-for': account.tag + '-get-main', cookie: `tp_session_v1=${account.cookie}` },
    });
    const getRes = await reportIdRoute.GET(getReq, { params: Promise.resolve({ id: 'growth-main-1' }) });
    assert.equal(getRes.status, 200, 'the real GET must succeed');
    const getBody = await getRes.json();
    const getUnified = getBody.payload.unifiedSimilarity;
    assert.ok(getUnified, 'requirement I: GET must return a real unifiedSimilarity');
    assert.equal(getUnified.previousUploadPositionsEncoding, undefined, 'requirement I: the customer-facing GET response must NEVER expose the persistence-only encoding marker');
    assert.deepEqual(getUnified.matchedPositions, rawParsed.unifiedSimilarity.matchedPositions, 'requirement I: matchedPositions must be unchanged by expansion');
    assert.ok(Array.isArray(getUnified.previousUploadPositions), 'requirement I: previousUploadPositions must be reconstructed as a real array');
    assert.deepEqual(getUnified.previousUploadPositions, getUnified.matchedPositions, 'requirement I: the reconstructed array must exactly equal matchedPositions -- this fixture\'s compaction was only ever eligible because the two were identical to begin with');

    // --- J: score/matched-position invariance against an independently
    // computed reference (never through the compaction path at all) ---
    assert.equal(getUnified.unifiedScore, referenceResolution.unifiedSimilarity.unifiedScore, 'requirement J: unifiedScore must be byte-identical to the pre-compaction computation');
    assert.equal(getUnified.uniqueMatchedWords, referenceResolution.unifiedSimilarity.uniqueMatchedWords, 'requirement J: uniqueMatchedWords must be byte-identical to the pre-compaction computation');
    assert.equal(getUnified.overlapWords, referenceResolution.unifiedSimilarity.overlapWords, 'requirement J: overlapWords must be byte-identical to the pre-compaction computation');

    // Response-body privacy/safety (unaffected by this fix, reconfirmed):
    // never an echo of manuscript/source content in any error path this
    // fixture could still hit.
    for (const passage of DISTINCTIVE_PASSAGES) {
      assert.ok(!resBodyText.includes(passage.slice(0, 40)), 'the POST response must never echo any source/manuscript excerpt');
    }
  });

  await t.test('R2 GATE OFF (the default): the SAME near-ceiling report FAILS CLOSED -- 413 and nothing persisted -- never saved as a score without its explanation', async (st) => {
    st.after(pinCompactWrites(undefined));
    const offAccount = await signUpConsentingAccount();
    const text = buildManuscript(TARGET_TEXT_CHARS, true);
    const body = buildRequestBody({ deviceKey: offAccount.deviceKey, id: 'growth-gate-off-1', text, unifiedSimilarityForgery: FORGED_UNIFIED_SIMILARITY, room: 0 });
    assert.ok(Buffer.byteLength(JSON.stringify(body), 'utf8') < MAX_REPORT_SAVE_REQUEST_BYTES, 'the request itself passes the transport guard; the PERSISTENCE guard is what rejects it');
    await resetRateForTest(offAccount.tag + '-post-off');
    const res = await reportsRoute.POST(new Request('http://localhost/api/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': offAccount.tag + '-post-off', cookie: `tp_session_v1=${offAccount.cookie}` },
      body: JSON.stringify(body),
    }));
    assert.equal(res.status, 413, 'gate OFF: the legacy explained report exceeds the ceiling -> fail closed');
    assert.deepEqual(await res.json(), { error: 'Payload too large' });
    const row = await client.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?', args: [offAccount.deviceKey, 'growth-gate-off-1'] });
    assert.equal(row.rows.length, 0, 'nothing persisted: no score without its explanation');
  });

  await t.test('TRUST BOUNDARY: a client cannot forge previousUploadPositionsEncoding="matchedPositions" (plus a large fake matchedPositions array) to manufacture trusted previous-upload evidence', async () => {
    // A short, GENUINE document that matches none of the ten promoted
    // sources (so the server's OWN computation has no real previous-upload
    // evidence at all), submitted alongside a FORGED unifiedSimilarity that
    // already carries the compaction marker this fix introduces plus a
    // large, entirely fabricated matchedPositions array -- exactly what an
    // attacker would need to submit to try to trick a naive implementation
    // into treating the marker as trusted input, or into expanding the
    // forged matchedPositions into a false previousUploadPositions match.
    const text = 'A short, genuine, unrelated manuscript about coastal erosion patterns that does not match any of the promoted corpus sources in this test at all.';
    const forgedCompactUnifiedSimilarity = {
      version: 'unified-similarity-v1',
      wordCount: 5000,
      unifiedScore: 97,
      uniqueMatchedWords: 4800,
      archiveOnlyWords: 0, liveAcademicOnlyWords: 0, previousUploadOnlyWords: 4800, overlapWords: 0,
      selfExcludedWords: 0, unknownExcludedWords: 0, deviceSelfExcludedWords: 0,
      userSuppliedReferenceOnlyWords: 0, selectiveCorpusOnlyWords: 0,
      contributions: [{ sourceType: 'previous_upload', sourceId: 'forged-representation-id', submittedWordStart: 0, submittedWordEnd: 4799, matchedWordCount: 4800, evidenceStatus: 'included' }],
      matchedPositions: Array.from({ length: 4800 }, (_, i) => i),
      // The exact forged marker this fix's trust model must reject as an
      // input signal: the client claims previousUploadPositions equals
      // matchedPositions (i.e. "trust me, everything matched is a
      // previous-upload match") without ever sending the array itself.
      previousUploadPositionsEncoding: PREVIOUS_UPLOAD_POSITIONS_ENCODING_MATCHED_POSITIONS,
      userSuppliedReferencePositions: [], selectiveCorpusPositions: [],
      archiveMatchedPositions: [],
    };
    const body = buildRequestBody({ deviceKey: account.deviceKey, id: 'growth-trust-1', text, unifiedSimilarityForgery: forgedCompactUnifiedSimilarity, room: 3 });
    await resetRateForTest(account.tag + '-post-trust');
    const req = new Request('http://localhost/api/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': account.tag + '-post-trust', cookie: `tp_session_v1=${account.cookie}` },
      body: JSON.stringify(body),
    });
    const res = await reportsRoute.POST(req);
    assert.equal(res.status, 200);

    await resetRateForTest(account.tag + '-get-trust');
    const getReq = new Request('http://localhost/api/reports/growth-trust-1', {
      headers: { 'x-forwarded-for': account.tag + '-get-trust', cookie: `tp_session_v1=${account.cookie}` },
    });
    const getRes = await reportIdRoute.GET(getReq, { params: Promise.resolve({ id: 'growth-trust-1' }) });
    const getBody = await getRes.json();
    const persisted = getBody.payload.unifiedSimilarity;
    assert.ok(persisted, 'the server must still compute and persist its OWN real unifiedSimilarity, never simply accept the client-submitted object wholesale');
    assert.notEqual(persisted.unifiedScore, 97, 'the forged score must never survive -- the server-computed score for this unrelated text must win');
    assert.notEqual(persisted.uniqueMatchedWords, 4800, 'the forged match count must never survive');
    assert.ok(!(persisted.contributions ?? []).some((c) => c.sourceId === 'forged-representation-id'), 'the forged contribution must never survive into the persisted/returned result');
    assert.ok((persisted.previousUploadPositions ?? []).length < 100, 'the forged, marker-driven previousUploadPositions must never survive -- this genuine unrelated text has essentially no real previous-upload match');
    // The server's OWN write path may legitimately choose to compact ITS
    // OWN real result if that result happens to be eligible (unrelated to
    // whether the client's forged marker was present) -- but the forged
    // marker itself, and the forged raw matchedPositions array that came
    // with it, must never reach the persisted row un-recomputed.
    const row = await client.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, 'growth-trust-1'] });
    const rawPersisted = JSON.parse(String(row.rows[0].payload_json));
    assert.notDeepEqual(rawPersisted.unifiedSimilarity?.matchedPositions, forgedCompactUnifiedSimilarity.matchedPositions, 'the forged matchedPositions array must never be persisted verbatim');
  });

  await t.test('paired control: same-shape large document with ZERO embedded corroborating sources stays under the ceiling and saves normally (200, not 413) -- proves the trigger is server-side evidence growth, not the route or document size alone', async () => {
    const text = buildManuscript(TARGET_TEXT_CHARS, false);
    const body = buildRequestBody({ deviceKey: account.deviceKey, id: 'growth-control-1', text, room: 1 });
    const serialized = JSON.stringify(body);
    const incomingBytes = Buffer.byteLength(serialized, 'utf8');
    console.log(`[report-transport-size-growth] control incoming request bytes: ${incomingBytes}`);
    assert.ok(incomingBytes < MAX_REPORT_SAVE_REQUEST_BYTES, 'control request must also be under the ceiling as sent');

    await resetRateForTest(account.tag + '-post-control');
    const req = new Request('http://localhost/api/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': account.tag + '-post-control', cookie: `tp_session_v1=${account.cookie}` },
      body: serialized,
    });
    const res = await reportsRoute.POST(req);
    console.log(`[report-transport-size-growth] control POST result: status=${res.status}`);
    assert.equal(res.status, 200, 'the same-size document without independently-corroborating server-side evidence must save normally, not 413 -- proving document size alone is not the trigger');
  });

  await t.test('STAGE ATTRIBUTION (counterfactual): which exact server-side stage would first cross MAX_REPORT_SAVE_REQUEST_BYTES WITHOUT this fix\'s compaction, for the same evidence density', async () => {
    // Reuses the SAME text-building fixture and the SAME already-promoted
    // ten sources / already-signed-up account from the main case above --
    // no redesign, no second corpus, no second account.
    //
    // Deliberately never calls compactUnifiedSimilarityForPersistence --
    // this sub-test exists to prove and document WHERE the crossing would
    // occur in the pre-fix (uncompacted) representation, as a permanent
    // regression guard for the diagnosis itself. The main case above (which
    // exercises the REAL, now-fixed route) is the one that proves actual
    // current production behavior (200, not 413) -- this counterfactual is
    // intentionally a different, lower-level measurement of the SAME real
    // functions, not a description of what the live route now returns.
    //
    // Reconstructs the REAL route stages using the REAL exported production
    // functions the route itself calls (never a reimplementation of
    // computeUnifiedSimilarity/the matcher/evidence-interpretation logic):
    //   - resolvePrimarySimilaritySummary (lib/report-primary-similarity.ts)
    //     -- the EXACT function app/api/reports/route.ts:882 calls, with the
    //     EXACT same argument shape, against the SAME real DB/corpus.
    //   - withEvidenceInterpretation (lib/report-evidence-interpretation.ts)
    //     -- the EXACT function finalizeReportJson (route.ts:827) calls.
    //
    // Stage C (the CHECK 4 input, route.ts:849 `persistedReportPayload`) is
    // NOT independently exported by the route, so it is reconstructed here
    // from the actual client payload this fixture sends: read directly,
    // app/api/reports/route.ts's persistedReportPayload base is "client
    // fields, but externalAcademicEvidence forced to the verified set" plus
    // unifiedSimilarity explicitly cleared -- and this fixture sends no
    // externalAcademicEvidence/academicSearchDiagnosticsId/userSuppliedReferences
    // /devicePassport/extractionCompleteness at all (see buildRequestBody
    // above), so every one of those trust-boundary transformations is a
    // verified no-op for this specific fixture: the server-verified set is
    // an empty array either way. This reconstruction is therefore the real
    // sent payload plus that one explicit, verified-empty correction --
    // flagged here as the one stage not obtained from a route-internal
    // object directly, unlike stages D/E/F below which are 100% real
    // exported-function output.
    const text = buildManuscript(TARGET_TEXT_CHARS, true);
    const clientBody = buildRequestBody({ deviceKey: account.deviceKey, id: 'growth-stage-1', text, room: 2 });
    const clientPayload = clientBody.payload;

    const stageC = {
      ...clientPayload,
      externalAcademicEvidence: [],
      unifiedSimilarity: undefined,
      unifiedSimilarityFailed: undefined,
      unifiedSimilarityGeneration: undefined,
      corpusSourceMatchingEnabledAtComputation: undefined,
    };
    const stageCBytes = Buffer.byteLength(JSON.stringify(stageC), 'utf8');

    // Stage D: the REAL resolvePrimarySimilaritySummary call, same shape as
    // app/api/reports/route.ts:882-905, against the same real DB/corpus.
    const resolution = await resolvePrimarySimilaritySummary(client, {
      reportDeviceKey: account.deviceKey,
      reportId: 'growth-stage-1',
      accountId: account.userId,
      rawText: text,
      wordCount: clientPayload.wordCount,
      archiveMatchedPositions: null,
      externalAcademicEvidence: [],
      userSuppliedReferenceEvidence: null,
      archiveScore: 0,
      verifiedDevicePassportId: null,
    });
    assert.ok(resolution.unifiedSimilarity, 'test setup sanity: this fixture must produce a real unifiedSimilarity result, matching the main case');
    const unifiedSimilarityOnlyBytes = Buffer.byteLength(JSON.stringify(resolution.unifiedSimilarity), 'utf8');

    // Stage E: real unifiedSimilarity spread onto stage C, mirroring
    // route.ts:940-951 -- BEFORE evidenceInterpretation is attempted.
    const stageE = {
      ...stageC,
      unifiedSimilarity: resolution.unifiedSimilarity,
      corpusSourceMatchingEnabledAtComputation: resolution.corpusSourceMatchingEnabled,
      unifiedSimilarityGeneration: resolution.corpusGeneration,
      unifiedSimilarityFailed: false,
    };
    const stageEBytes = Buffer.byteLength(JSON.stringify(stageE), 'utf8');

    // Stage F: the REAL withEvidenceInterpretation call, same shape as
    // finalizeReportJson's own call (route.ts:829-836), fed the REAL
    // resolution.historicalSubmissionMatch -- pre-fix, this is exactly what
    // CHECK 5 (route.ts:952) would have measured via `enriched.length`; the
    // real, current route now compacts this same object before measuring it
    // (see the main case's own requirement-D/H assertions above for the
    // actual, current CHECK-5 value).
    const stageF = withEvidenceInterpretation(stageE, {
      historicalSubmissionMatch: resolution.historicalSubmissionMatch,
      selectiveCorpusBranch: null,
      serverExtractionDiagnostic: null,
      userSuppliedReferenceEvidence: undefined,
      userSuppliedReferenceChannel: undefined,
      userSuppliedReferenceGuard: undefined,
    });
    const stageFBytes = Buffer.byteLength(JSON.stringify(stageF), 'utf8');

    console.log('[report-transport-size-growth] STAGE BYTES:', JSON.stringify({
      stageC_baseBeforeUnifiedSimilarity: stageCBytes,
      stageD_unifiedSimilarityOnly: unifiedSimilarityOnlyBytes,
      stageE_afterUnifiedSimilarityAttach: stageEBytes,
      stageF_afterEvidenceInterpretation: stageFBytes,
      MAX_REPORT_SAVE_REQUEST_BYTES,
    }, null, 2));

    // --- Section 4: first crossing ---
    //
    // PRECISION NOTE on what CHECK 5 (route.ts:952) actually measures:
    // finalizeReportJson (route.ts:827-842) does NOT simply check stageF's
    // own size -- its `if (enriched.length <= MAX_BYTES) return enriched;`
    // means that whenever withEvidenceInterpretation's OWN output (stageF)
    // would itself exceed the ceiling, finalizeReportJson silently REVERTS
    // to `JSON.stringify(obj)` -- i.e. stageE, the object WITHOUT
    // evidenceInterpretation -- and CHECK 5 (`payloadJsonToPersist.length >
    // MAX_BYTES`) is evaluated against THAT reverted value, never stageF.
    // So for a fixture where stageE ALONE already exceeds the ceiling (as
    // asserted below), CHECK 5's real checked value is stageEBytes exactly,
    // and stageF is never the persisted/checked candidate at all -- it only
    // proves evidenceInterpretation would have made things worse, which is
    // why the soft-degrade discards it. This makes "unifiedSimilarity attach
    // alone already crosses the ceiling" the precise, not merely
    // chronological, first-crossing conclusion for this fixture.
    assert.ok(stageCBytes <= MAX_REPORT_SAVE_REQUEST_BYTES, `sanity: stage C (${stageCBytes} bytes) must itself be at or under the ceiling for this fixture -- otherwise CHECK 4 alone would already 413, independent of unifiedSimilarity`);
    const stageECrosses = stageEBytes > MAX_REPORT_SAVE_REQUEST_BYTES;
    const stageFCrosses = stageFBytes > MAX_REPORT_SAVE_REQUEST_BYTES;
    const finalizeReportJsonCheckedBytes = stageFCrosses ? stageEBytes : stageFBytes; // mirrors route.ts:829-841's own soft-degrade fallback
    console.log(`[report-transport-size-growth] FIRST CROSSING: ${
      stageECrosses
        ? `UNIFIED_SIMILARITY_ATTACH_CROSSES_FIRST (stage E already exceeds the ceiling before evidenceInterpretation is even attempted; the real CHECK 5 value, after finalizeReportJson's own soft-degrade, is ${finalizeReportJsonCheckedBytes} bytes -- stage E itself, since stage F would have been even larger)`
        : stageFCrosses
          ? 'EVIDENCE_INTERPRETATION_CROSSES_FIRST (stage E stays under the ceiling; only stage F, after withEvidenceInterpretation, exceeds it)'
          : 'NEITHER STAGE CROSSES (this counterfactual no longer reproduces a would-be failure for this fixture -- investigate)'
    }`);
    assert.ok(stageECrosses || stageFCrosses, 'the reconstructed UNCOMPACTED stages must still show a would-be crossing for this fixture\'s evidence density -- this is the permanent regression guard proving the fix in the main case above is addressing a real, reproducible condition, not a no-op');
    if (stageECrosses) {
      assert.equal(finalizeReportJsonCheckedBytes, stageEBytes, 'when stage E alone already exceeds the ceiling, finalizeReportJson\'s own soft-degrade means CHECK 5 is evaluated against stage E, never stage F');
    }

    // --- Section 5: field breakdown of whichever object first crosses ---
    const crossingObject = stageECrosses ? stageE : stageF;
    const crossingLabel = stageECrosses ? 'stageE (post-unifiedSimilarity, pre-evidenceInterpretation)' : 'stageF (post-evidenceInterpretation)';
    const fieldBytes = (obj, key) => (key in obj && obj[key] !== undefined ? Buffer.byteLength(JSON.stringify(obj[key]), 'utf8') : 0);
    const topLevelBreakdown = {
      features_or_text: fieldBytes(crossingObject, 'text'),
      historicalSubmissionMatch: fieldBytes(crossingObject, 'historicalSubmissionMatch'),
      externalAcademicEvidence: fieldBytes(crossingObject, 'externalAcademicEvidence'),
      unifiedSimilarity: fieldBytes(crossingObject, 'unifiedSimilarity'),
      evidenceInterpretation: fieldBytes(crossingObject, 'evidenceInterpretation'),
      reportCompletion: fieldBytes(crossingObject, 'reportCompletion'),
      extractionDiagnostic: fieldBytes(crossingObject, 'extractionDiagnostic'),
      sources: fieldBytes(crossingObject, 'sources'),
      aiAnalysis: fieldBytes(crossingObject, 'aiAnalysis'),
    };
    console.log(`[report-transport-size-growth] FIELD BREAKDOWN of ${crossingLabel} (bytes):`, JSON.stringify(topLevelBreakdown, null, 2));

    if (crossingObject.unifiedSimilarity) {
      const us = crossingObject.unifiedSimilarity;
      const usBreakdown = {
        matchedPositions: fieldBytes(us, 'matchedPositions'),
        previousUploadPositions: fieldBytes(us, 'previousUploadPositions'),
        userSuppliedReferencePositions: fieldBytes(us, 'userSuppliedReferencePositions'),
        selectiveCorpusPositions: fieldBytes(us, 'selectiveCorpusPositions'),
        archiveMatchedPositions: fieldBytes(us, 'archiveMatchedPositions'),
        contributions: fieldBytes(us, 'contributions'),
      };
      console.log('[report-transport-size-growth] unifiedSimilarity SUBFIELD BREAKDOWN (bytes):', JSON.stringify(usBreakdown, null, 2));
    }

    if (resolution.historicalSubmissionMatch) {
      const hsm = resolution.historicalSubmissionMatch;
      const matchCount = hsm.matches?.length ?? 0;
      const totalPassages = (hsm.matches ?? []).reduce((sum, m) => sum + (m.passages?.length ?? 0), 0);
      const submittedTextBytes = (hsm.matches ?? []).reduce(
        (sum, m) => sum + (m.passages ?? []).reduce((s, p) => s + Buffer.byteLength(p.submittedText ?? '', 'utf8'), 0),
        0,
      );
      const hsmBytes = Buffer.byteLength(JSON.stringify(hsm), 'utf8');
      console.log('[report-transport-size-growth] historicalSubmissionMatch BREAKDOWN:', JSON.stringify({
        totalBytes: hsmBytes,
        matchCount,
        totalPassages,
        submittedTextBytesAcrossAllPassages: submittedTextBytes,
      }, null, 2));

      // --- Section 6: duplication accounting (analysis only, no compaction) ---
      // matchedWordCount summed across every historical-match entry is the
      // same underlying matched span computeUnifiedSimilarity ALSO reports
      // as (a subset of) unifiedSimilarity.matchedPositions -- so
      // submittedTextBytesAcrossAllPassages is real, measured bytes of the
      // submission's OWN text duplicated inside historicalSubmissionMatch on
      // top of the identical content already present once in `text`, and
      // the position arrays above (matchedPositions +
      // previousUploadPositions, both containing the same integers for a
      // corpus-source match) are a second, smaller duplication of the same
      // underlying positions.
      console.log(`[report-transport-size-growth] DUPLICATION: submittedText excerpt bytes (${submittedTextBytes}) vs. matchedPositions+previousUploadPositions combined bytes (${crossingObject.unifiedSimilarity ? fieldBytes(crossingObject.unifiedSimilarity, 'matchedPositions') + fieldBytes(crossingObject.unifiedSimilarity, 'previousUploadPositions') : 'n/a'})`);
    }
  });
});

// -- Section 14 (self-heal safety): a small, fast, independent fixture --
// deliberately NOT the 1.85MB main fixture, since this only needs to prove
// the MECHANISM (lib/report-primary-similarity.ts's persistRefreshedSimilarity
// writes the compact representation when it self-heals a stale row, and a
// subsequent GET still expands it correctly), not re-prove the 2MB crossing.
//
// REPORT-LIFECYCLE CORRECTNESS FIX (customer historical-GET purity): GET no
// longer self-heals a stale row on its own — a corpus-generation bump no
// longer forces GET to recompute anything (see tests/report-write-time-
// finalization.test.mjs's own header comment for the full rationale). This
// test now drives the SAME persistRefreshedSimilarity write path directly
// via selfHealUnifiedSimilarity (the explicit write-time-finalization/
// maintenance recovery action), which is the real, current way a stale row
// ever gets re-resolved — then proves GET still expands whatever is on file
// correctly, whether that is the original or the healed representation.
test('SELF-HEAL COMPACTION: persistRefreshedSimilarity writes the compact representation when a stale row self-heals, and GET still expands it correctly', async (t) => {
  const SELF_HEAL_PASSAGE =
    'Ecologists surveying a recovering wetland habitat documented an unusually rapid return of native amphibian populations following a targeted invasive-species removal program, a recovery timeline substantially shorter than comparable restoration efforts elsewhere reported in the literature, prompting new interest in whether the removal method itself accelerated the surrounding food web relative to passive-recovery baselines used in prior comparable studies.';

  await promoteDocumentIntoCorpus(SELF_HEAL_PASSAGE);
  const account = await signUpConsentingAccount();
  const reportId = 'self-heal-compaction-1';

  await resetRateForTest(account.tag + '-post-selfheal');
  const wordCount = SELF_HEAL_PASSAGE.split(/\s+/).filter(Boolean).length;
  const postReq = new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': account.tag + '-post-selfheal', cookie: `tp_session_v1=${account.cookie}` },
    body: JSON.stringify({
      deviceKey: account.deviceKey, id: reportId, submissionId: 'sub-' + reportId, title: 'Self-heal compaction fixture',
      createdAt: new Date().toISOString(), wordCount, archiveScore: 0, scoreBand: 'Low', aiScore: null, aiTone: null, room: 4,
      payload: {
        version: 11, id: reportId, submissionId: 'sub-' + reportId, title: 'Self-heal compaction fixture',
        author: '', assignment: '', created: new Date().toISOString(),
        score: 0, archiveScore: 0, wordCount, scoreBand: 'Low', matchedWordCount: 0, sources: [], repeats: [],
        text: SELF_HEAL_PASSAGE,
      },
    }),
  });
  const postRes = await reportsRoute.POST(postReq);
  assert.equal(postRes.status, 200, 'test setup sanity: the initial save must succeed');

  const rowBefore = await client.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, reportId] });
  const parsedBefore = JSON.parse(String(rowBefore.rows[0].payload_json));
  assert.ok(parsedBefore.unifiedSimilarity, 'test setup sanity: the first save must already have a real unifiedSimilarity');
  const generationBeforeStale = parsedBefore.unifiedSimilarityGeneration;

  // Bump the corpus generation (a real, independent promotion, exactly like
  // report-write-time-finalization.test.mjs's own "LEGACY ROOM BUG... a
  // later promotion bumped corpus_match_generation" precedent) so the
  // already-persisted result becomes STALE.
  await promoteDocumentIntoCorpus(
    'Geologists mapping an isolated basalt formation identified a mineral banding pattern inconsistent with the standard cooling-rate model typically used to date similar volcanic features in the region.',
  );

  // GET is a pure read now (customer historical-GET purity) — it does NOT
  // self-heal the now-stale row any more. The explicit recovery action
  // (the same write-time-finalization machinery POST /api/reports and an
  // admin/maintenance action would use) is what actually re-resolves and
  // re-persists it.
  const healed = await selfHealUnifiedSimilarity(client, { reportDeviceKey: account.deviceKey, reportId, accountId: account.userId });
  assert.equal(healed.attempted, true, 'the explicit recovery action must actually run for this test to be meaningful');

  await resetRateForTest(account.tag + '-get-selfheal');
  const getReq = new Request(`http://localhost/api/reports/${reportId}`, {
    headers: { 'x-forwarded-for': account.tag + '-get-selfheal', cookie: `tp_session_v1=${account.cookie}` },
  });
  const getRes = await reportIdRoute.GET(getReq, { params: Promise.resolve({ id: reportId }) });
  assert.equal(getRes.status, 200);
  const getBody = await getRes.json();
  const getUnified = getBody.payload.unifiedSimilarity;
  assert.ok(getUnified, 'GET must still return a real unifiedSimilarity after the explicit self-heal');
  assert.equal(getUnified.previousUploadPositionsEncoding, undefined, 'the customer-facing GET response must never expose the persistence-only marker, self-heal path included');
  assert.ok(Array.isArray(getUnified.previousUploadPositions), 'previousUploadPositions must be reconstructed as a real array');
  assert.deepEqual(getUnified.previousUploadPositions, getUnified.matchedPositions, 'this single-source fixture\'s previousUploadPositions must equal matchedPositions exactly, before and after self-heal');

  const rowAfter = await client.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, reportId] });
  const parsedAfter = JSON.parse(String(rowAfter.rows[0].payload_json));
  assert.notEqual(parsedAfter.unifiedSimilarityGeneration, generationBeforeStale, 'test setup sanity: the explicit self-heal above must have actually re-persisted a real result, not a no-op');
  assert.equal(getUnified.unifiedScore, parsedAfter.unifiedSimilarity.unifiedScore, 'GET reflects exactly what selfHealUnifiedSimilarity persisted, not a second independent computation of its own');

  // The actual requirement: persistRefreshedSimilarity's own write, inspected
  // directly from the raw persisted row -- proves the SAME shared encoder
  // used by the POST path is also applied on the self-heal write path.
  assert.ok(Array.isArray(parsedAfter.unifiedSimilarity?.matchedPositions) && parsedAfter.unifiedSimilarity.matchedPositions.length > 0);
  assert.equal(parsedAfter.unifiedSimilarity.previousUploadPositionsEncoding, PREVIOUS_UPLOAD_POSITIONS_ENCODING_MATCHED_POSITIONS, 'persistRefreshedSimilarity (the self-heal write path) must persist the compact marker when eligible, exactly like the POST write path');
  assert.equal('previousUploadPositions' in parsedAfter.unifiedSimilarity, false, 'persistRefreshedSimilarity must OMIT the now-redundant duplicate array when compacting');
});
