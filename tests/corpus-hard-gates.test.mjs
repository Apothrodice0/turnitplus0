import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCorpusHardGates, classifyLanguageForAdmission, DEFAULT_CORPUS_HARD_GATE_THRESHOLDS } from "../lib/corpus-hard-gates.ts";
import { detectDominantLanguage } from "../lib/similarity-core.ts";

const OK_FILE_VALIDATION = { ok: true, format: "txt" };
const OK_EXTRACTION = { ok: true, rawText: "irrelevant for these tests", extractorVersion: "test" };
const PER_USER_CONSENTED = { kind: "PER_USER_CONSENT", consented: true };
const PER_USER_NOT_CONSENTED = { kind: "PER_USER_CONSENT", consented: false };
const RESOLVED_PROVENANCE = {
  kind: "BULK_IMPORT_PROVENANCE",
  provenance: { sourceUrl: "https://example.test/a", acquisitionMethod: "BULK_IMPORT_DOWNLOAD", licenseOrPermission: "CC-BY-4.0", retentionBasis: "LICENSED_REUSE", retentionRightsResolved: true, notes: null },
};
const UNRESOLVED_PROVENANCE = {
  kind: "BULK_IMPORT_PROVENANCE",
  provenance: { sourceUrl: "https://example.test/b", acquisitionMethod: "BULK_IMPORT_DOWNLOAD", licenseOrPermission: null, retentionBasis: "UNRESOLVED", retentionRightsResolved: false, notes: "pending review" },
};

function baseInput(overrides = {}) {
  return {
    fileValidation: OK_FILE_VALIDATION,
    extraction: OK_EXTRACTION,
    wordCount: 3000,
    detectedLanguage: "English",
    languageConfidence: 1,
    consent: RESOLVED_PROVENANCE,
    ...overrides,
  };
}

test("2999 words fails the hard gate (WORD_COUNT_BELOW_MINIMUM)", () => {
  const result = evaluateCorpusHardGates(baseInput({ wordCount: 2999 }));
  assert.equal(result.passed, false);
  assert.ok(result.failureCodes.includes("WORD_COUNT_BELOW_MINIMUM"));
});

test("exactly 3000 words passes the word-count hard gate", () => {
  const result = evaluateCorpusHardGates(baseInput({ wordCount: 3000 }));
  assert.ok(!result.failureCodes.includes("WORD_COUNT_BELOW_MINIMUM"));
});

test("3001 words passes the word-count hard gate", () => {
  const result = evaluateCorpusHardGates(baseInput({ wordCount: 3001 }));
  assert.ok(!result.failureCodes.includes("WORD_COUNT_BELOW_MINIMUM"));
});

test("failed file validation short-circuits before word count / language are even evaluated", () => {
  const result = evaluateCorpusHardGates(baseInput({
    fileValidation: { ok: false, reasonCode: "UNSUPPORTED_FILE_FORMAT", detail: "x" },
    extraction: null,
    wordCount: 50, // would also fail the word-count gate, but should not be independently reported
  }));
  assert.equal(result.passed, false);
  assert.deepEqual(result.failureCodes, ["UNSUPPORTED_FILE_FORMAT"]);
});

test("failed extraction short-circuits before word count / language are evaluated", () => {
  const result = evaluateCorpusHardGates(baseInput({ extraction: { ok: false, reasonCode: "EXTRACTION_FAILED", detail: "x" } }));
  assert.equal(result.passed, false);
  assert.deepEqual(result.failureCodes, ["EXTRACTION_FAILED"]);
});

test("consent missing (per-user path) fails independently", () => {
  const result = evaluateCorpusHardGates(baseInput({ consent: PER_USER_NOT_CONSENTED }));
  assert.equal(result.passed, false);
  assert.ok(result.failureCodes.includes("CONSENT_MISSING"));
});

test("unresolved retention (bulk-import provenance path) fails independently", () => {
  const result = evaluateCorpusHardGates(baseInput({ consent: UNRESOLVED_PROVENANCE }));
  assert.equal(result.passed, false);
  assert.ok(result.failureCodes.includes("RETENTION_REQUIREMENT_UNMET"));
});

test("a fully valid candidate passes every hard gate", () => {
  const result = evaluateCorpusHardGates(baseInput());
  assert.equal(result.passed, true);
  assert.deepEqual(result.failureCodes, []);
});

// --- English-only (requirement 1) ---------------------------------------

test("classifyLanguageForAdmission: confident English", () => {
  assert.equal(classifyLanguageForAdmission("English", 0.9), "CONFIDENT_ENGLISH");
});

test("classifyLanguageForAdmission: confident non-English (Arabic, French)", () => {
  assert.equal(classifyLanguageForAdmission("Arabic", 0.9), "CONFIDENT_NON_ENGLISH");
  assert.equal(classifyLanguageForAdmission("French", 0.9), "CONFIDENT_NON_ENGLISH");
});

test("classifyLanguageForAdmission: Mixed always resolves UNCERTAIN regardless of confidence value passed in", () => {
  assert.equal(classifyLanguageForAdmission("Mixed", 0.5), "UNCERTAIN");
  // Under the windowed dominant-language detector, a genuinely decisive
  // Mixed-script case (Arabic+Latin both clearing the script-ratio bar) can
  // legitimately carry a HIGH confidence/share value — unlike the old
  // detector, whose Mixed result was always exactly 0.5. Mixed must resolve
  // UNCERTAIN by explicit construction in classifyLanguageForAdmission, not
  // merely because Mixed happened to always produce a low number.
  assert.equal(classifyLanguageForAdmission("Mixed", 0.95), "UNCERTAIN");
});

test("classifyLanguageForAdmission: low-confidence English is UNCERTAIN, not CONFIDENT_ENGLISH", () => {
  assert.equal(classifyLanguageForAdmission("English", 0.1), "UNCERTAIN");
});

test("confident non-English fails the hard gate with NOT_ENGLISH", () => {
  const result = evaluateCorpusHardGates(baseInput({ detectedLanguage: "Arabic", languageConfidence: 0.9 }));
  assert.equal(result.passed, false);
  assert.ok(result.failureCodes.includes("NOT_ENGLISH"));
  assert.equal(result.languageClass, "CONFIDENT_NON_ENGLISH");
});

test("uncertain language does NOT fail the hard gate (it is a policy-level REVIEW cap, not a hard rejection) — the gate still passes", () => {
  const result = evaluateCorpusHardGates(baseInput({ detectedLanguage: "Mixed", languageConfidence: 0.5 }));
  assert.equal(result.passed, true);
  assert.ok(!result.failureCodes.includes("NOT_ENGLISH"));
  assert.equal(result.languageClass, "UNCERTAIN");
});

test("confident English never fails the language gate, for any word-count/consent-passing candidate", () => {
  const result = evaluateCorpusHardGates(baseInput({ detectedLanguage: "English", languageConfidence: 0.95 }));
  assert.equal(result.languageClass, "CONFIDENT_ENGLISH");
  assert.ok(!result.failureCodes.includes("NOT_ENGLISH"));
});

test("bug reproduction end-to-end: an English body with a short Spanish abstract, run through the real detector, clears the hard gate as CONFIDENT_ENGLISH", () => {
  function repeatWords(bank, count) {
    const out = [];
    for (let i = 0; i < count; i += 1) out.push(bank[i % bank.length]);
    return out.join(" ");
  }
  const ENGLISH_WORDS = ["the", "study", "examined", "population", "sample", "and", "results", "were", "compared", "with", "previous", "findings", "in", "this", "research", "which", "was", "conducted"];
  const SPANISH_WORDS = ["el", "estudio", "examina", "la", "filantropia", "y", "riqueza", "en", "las", "empresas", "con", "una", "metodologia", "para", "estos", "resultados", "que", "es"];
  const text = `${repeatWords(SPANISH_WORDS, 60)} ${repeatWords(ENGLISH_WORDS, 3000)}`;

  const { language, confidence } = detectDominantLanguage(text);
  const result = evaluateCorpusHardGates(baseInput({ wordCount: 3000, detectedLanguage: language, languageConfidence: confidence }));

  assert.equal(language, "English");
  assert.equal(result.languageClass, "CONFIDENT_ENGLISH");
  assert.equal(result.passed, true);
  assert.ok(!result.failureCodes.includes("NOT_ENGLISH"));
});

test("documents the language gate's current default threshold as ENGINEERING_DEFAULT, not a calibrated cutoff", () => {
  assert.equal(DEFAULT_CORPUS_HARD_GATE_THRESHOLDS.languageConfidenceFloor.status, "ENGINEERING_DEFAULT");
  assert.equal(DEFAULT_CORPUS_HARD_GATE_THRESHOLDS.minimumWords.status, "ENGINEERING_DEFAULT");
});
