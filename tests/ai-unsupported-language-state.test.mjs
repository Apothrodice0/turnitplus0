import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import {
  AI_UNAVAILABLE_REASON_REPORT_SIZE,
  AI_UNAVAILABLE_REASON_UNSUPPORTED_LANGUAGE,
  aiUnavailableRoomNote,
  isAiRetryOffered,
  languageUnsupportedAiAnalysis,
  withLanguageUnavailableAi,
} from "../lib/ai-unavailable-state.ts";
import { aiSignalDisplay } from "../lib/report-types.ts";
import { resolveAiDisplayState } from "../lib/ai-display-state.ts";
import { findRoomOccupant } from "../lib/reports-repo.ts";

// The AI detector (an English-trained classifier with an English human-reference calibration) declines any other language
// as "unsupported". That outcome must read as "not available for <language>", never as "not enough text", never as a
// percentage, and never offer a Retry that can only decline again. Synthetic fixtures only.

const unsupported = (extra) => ({ status: "unsupported", score: null, model: "m", engine: null, threshold: 0.5, eligibleWordCount: 0, analyzedWordCount: 0, passages: [], ...extra });
const reportWith = (aiAnalysis) => ({ aiAnalysis });

test("languageUnsupportedAiAnalysis: explicit reason, legacy language field, and the English/short and non-unsupported controls", () => {
  assert.equal(languageUnsupportedAiAnalysis(unsupported({ unsupportedReason: "UNSUPPORTED_LANGUAGE", detectedLanguage: "Arabic" })), "Arabic");
  assert.equal(languageUnsupportedAiAnalysis(unsupported({ detectedLanguage: "Arabic" })), "Arabic", "results saved before unsupportedReason existed");
  assert.equal(languageUnsupportedAiAnalysis(unsupported({ unsupportedReason: "INSUFFICIENT_TEXT", detectedLanguage: "English" })), null);
  assert.equal(languageUnsupportedAiAnalysis(unsupported({ detectedLanguage: "English" })), null, "a legacy short English result stays 'not enough text'");
  assert.equal(languageUnsupportedAiAnalysis(unsupported({})), null, "no language recorded: never guessed");
  assert.equal(languageUnsupportedAiAnalysis({ status: "complete", detectedLanguage: "Arabic" }), null);
  assert.equal(languageUnsupportedAiAnalysis({ status: "error", detectedLanguage: "Arabic" }), null);
});

test("display: Arabic reads 'Not available for Arabic' with no number; other languages generic; short English unchanged", () => {
  const ar = aiSignalDisplay(reportWith(unsupported({ unsupportedReason: "UNSUPPORTED_LANGUAGE", detectedLanguage: "Arabic" })));
  assert.equal(ar.value, null);
  assert.equal(ar.label, "Not available for Arabic");
  assert.equal(ar.range, "No AI result");
  assert.match(ar.detail, /validated for English only/);
  assert.doesNotMatch(ar.detail, /\d+\s*%|Fewer than 300/);
  const fr = aiSignalDisplay(reportWith(unsupported({ unsupportedReason: "UNSUPPORTED_LANGUAGE", detectedLanguage: "French" })));
  assert.equal(fr.label, "Not available for this language");
  assert.equal(fr.value, null);
  const en = aiSignalDisplay(reportWith(unsupported({ unsupportedReason: "INSUFFICIENT_TEXT", detectedLanguage: "English" })));
  assert.equal(en.label, "Not enough text");
  assert.match(en.detail, /Fewer than 300 eligible English words/);
  // the resolver itself is unchanged: an unsupported result is not_eligible with no score, whatever the persisted columns say
  assert.deepEqual(resolveAiDisplayState({ aiStatus: "failed", aiScore: null, aiTone: "unavailable", aiAnalysis: unsupported({ detectedLanguage: "Arabic" }) }), { state: "not_eligible", score: null, tone: "unavailable" });
});

test("Retry: never offered for a language decline; still offered for an ordinary failure; room note names the reason", () => {
  assert.equal(isAiRetryOffered({ aiUnavailableReason: AI_UNAVAILABLE_REASON_UNSUPPORTED_LANGUAGE }), false);
  assert.equal(isAiRetryOffered({ aiUnavailableReason: AI_UNAVAILABLE_REASON_REPORT_SIZE }), false);
  assert.equal(isAiRetryOffered({}), true);
  assert.match(aiUnavailableRoomNote({ aiUnavailableReason: AI_UNAVAILABLE_REASON_UNSUPPORTED_LANGUAGE }), /validated for English only/);
  assert.doesNotMatch(aiUnavailableRoomNote({ aiUnavailableReason: AI_UNAVAILABLE_REASON_REPORT_SIZE }), /English only/);
  const failed = { id: "1", aiStatus: "failed", aiScore: null, aiTone: "unavailable" };
  assert.equal(withLanguageUnavailableAi(failed, unsupported({ unsupportedReason: "UNSUPPORTED_LANGUAGE", detectedLanguage: "Arabic" })).aiUnavailableReason, AI_UNAVAILABLE_REASON_UNSUPPORTED_LANGUAGE);
  assert.equal(withLanguageUnavailableAi(failed, unsupported({ unsupportedReason: "INSUFFICIENT_TEXT", detectedLanguage: "English" })).aiUnavailableReason, undefined);
  assert.equal(withLanguageUnavailableAi(failed, { status: "error", error: "worker crashed" }).aiUnavailableReason, undefined, "a genuine failure keeps its Retry");
  assert.equal(withLanguageUnavailableAi({ ...failed, aiStatus: "ready" }, unsupported({ detectedLanguage: "Arabic" })).aiUnavailableReason, undefined);
});

// ---------- server room summary: the reason is DERIVED from the stored analysis (read-only), never a stored marker ----------
const dbFile = path.join(path.resolve("."), "test_ai_unsupported_language_state.db");
for (const s of ["", "-wal", "-shm"]) if (fs.existsSync(dbFile + s)) fs.unlinkSync(dbFile + s);
const client = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(client, path.join(path.resolve("."), "drizzle"));
test.after(() => { client.close(); for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbFile + s); } catch { /* ignore */ } } });

async function seedRoom(userId, room, aiAnalysis) {
  await client.execute({ sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)", args: [userId, `${userId}@example.test`, userId, "x"] });
  const id = `${room}${Date.now()}`;
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_score, ai_tone, payload_json, user_id, room_number, ai_status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id, `dk-${userId}`, `sub-${id}`, "t", new Date().toISOString(), 4000, 3, "low", null, "unavailable", JSON.stringify({ aiAnalysis }), userId, room, "failed"],
  });
}

test("room summary: an Arabic decline is non-retryable; a short English decline and a genuine failure stay retryable", async () => {
  await seedRoom("u-ar", 1, unsupported({ unsupportedReason: "UNSUPPORTED_LANGUAGE", detectedLanguage: "Arabic" }));
  await seedRoom("u-ar-legacy", 1, unsupported({ detectedLanguage: "Arabic" }));
  await seedRoom("u-en", 1, unsupported({ unsupportedReason: "INSUFFICIENT_TEXT", detectedLanguage: "English" }));
  await seedRoom("u-err", 1, { status: "error", score: null, model: "m", engine: null, threshold: 0.5, eligibleWordCount: 0, analyzedWordCount: 0, passages: [], error: "worker crashed" });
  const ar = await findRoomOccupant(client, "u-ar", 1), legacy = await findRoomOccupant(client, "u-ar-legacy", 1);
  const en = await findRoomOccupant(client, "u-en", 1), err = await findRoomOccupant(client, "u-err", 1);
  assert.equal(ar.status, "failed");
  assert.equal(ar.report.aiUnavailableReason, AI_UNAVAILABLE_REASON_UNSUPPORTED_LANGUAGE);
  assert.equal(ar.report.aiScore, null, "never a fabricated percentage");
  assert.equal(legacy.report.aiUnavailableReason, AI_UNAVAILABLE_REASON_UNSUPPORTED_LANGUAGE);
  assert.equal(isAiRetryOffered(ar.report), false);
  assert.equal(en.report.aiUnavailableReason, undefined);
  assert.equal(err.report.aiUnavailableReason, undefined);
  assert.equal(isAiRetryOffered(err.report), true);
});
