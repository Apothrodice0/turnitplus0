import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { aiLanguageRoute } from "../lib/ai-core.ts";
import { detectLanguage, arabicScriptWindowCount, EMBEDDED_PASSAGE_MAX_WINDOWS } from "../lib/similarity-core.ts";
import { AI_UNAVAILABLE_REASON_UNSUPPORTED_LANGUAGE, languageUnsupportedAiAnalysis, withLanguageUnavailableAi } from "../lib/ai-unavailable-state.ts";
import { aiSignalDisplay } from "../lib/report-types.ts";

// The English-only AI detector may give a whole-document score only to text that is English as scored. Synthetic fixtures.
const EN_SENTENCES = [
  "The study examines how public institutions adapt their administrative procedures when digital services are introduced across the region.",
  "Data were collected from interviews with officials and from records that describe the changes made during the reform period.",
  "The results show that training and clear responsibilities were more important than the technology itself for the success of the project.",
  "These findings suggest that future reforms should consider the capacity of staff before they introduce new systems in local offices.",
  "However, the analysis also reveals that citizens valued faster responses more than the variety of services that were offered online.",
];
const AR_SENTENCES = [
  "تتناول هذه الدراسة كيفية تكيف المؤسسات العمومية مع الإجراءات الإدارية عند إدخال الخدمات الرقمية في مختلف الولايات.",
  "وقد جمعت البيانات من مقابلات مع المسؤولين ومن السجلات التي تصف التغييرات التي أجريت خلال فترة الإصلاح الإداري.",
  "وتبين النتائج أن التكوين وتحديد المسؤوليات كانا أهم من التكنولوجيا نفسها في نجاح المشروع على المستوى المحلي.",
  "وتشير هذه النتائج إلى ضرورة مراعاة قدرات الموظفين قبل إدخال أنظمة جديدة في المكاتب المحلية والبلديات.",
];
const words = (sentences, n) => { const out = []; for (let i = 0; out.length < n; i++) out.push(...sentences[i % sentences.length].split(" ")); return out.slice(0, n).join(" "); };
const english = words(EN_SENTENCES, 1500);

test("routing: English, English + one Arabic abstract, English mixed with an Arabic body, Arabic, French", () => {
  assert.equal(aiLanguageRoute(english, detectLanguage(english)), "ENGLISH");
  const withAbstract = `${words(AR_SENTENCES, 180)}\n\n${english}`;
  assert.equal(detectLanguage(withAbstract), "English");
  assert.ok(arabicScriptWindowCount(withAbstract) <= EMBEDDED_PASSAGE_MAX_WINDOWS);
  assert.equal(aiLanguageRoute(withAbstract, detectLanguage(withAbstract)), "ENGLISH", "a translated abstract stays scored, as before");
  const bilingual = `${english}\n\n${words(AR_SENTENCES, 700)}`;
  assert.equal(detectLanguage(bilingual), "English", "the existing dominant-language rule still calls it English");
  assert.ok(arabicScriptWindowCount(bilingual) > EMBEDDED_PASSAGE_MAX_WINDOWS);
  assert.equal(aiLanguageRoute(bilingual, detectLanguage(bilingual)), "MIXED_LANGUAGE", "never a whole-document English score over an Arabic body");
  const arabic = words(AR_SENTENCES, 1200);
  assert.equal(aiLanguageRoute(arabic, detectLanguage(arabic)), "UNSUPPORTED_LANGUAGE");
  assert.equal(aiLanguageRoute(english, "French"), "UNSUPPORTED_LANGUAGE");
});

test("routing: a document English only because of its reference list is judged on the text the detector scores", () => {
  const references = Array.from({ length: 120 }, (_, i) => `${i + 1}. Smith, J. and Brown, A. (2019). The role of public administration in the digital transition of local services. Journal of Public Policy, ${i}(2), 45-67.`).join("\n");
  const doc = `${words(AR_SENTENCES, 900)}\n\n${words(EN_SENTENCES, 250)}\n\nReferences\n${references}`;
  if (detectLanguage(doc) === "English") assert.equal(aiLanguageRoute(doc, "English"), "MIXED_LANGUAGE");
  else assert.equal(aiLanguageRoute(doc, detectLanguage(doc)), "UNSUPPORTED_LANGUAGE");
});

test("display: mixed languages are inconclusive with no score and no Retry; English scores are labelled experimental", () => {
  const mixed = { status: "unsupported", unsupportedReason: "MIXED_LANGUAGE", detectedLanguage: "English", score: null, model: "m", engine: null, threshold: 0.5, eligibleWordCount: 1500, analyzedWordCount: 0, passages: [] };
  assert.equal(languageUnsupportedAiAnalysis(mixed), "Mixed");
  const shown = aiSignalDisplay({ aiAnalysis: mixed });
  assert.equal(shown.value, null);
  assert.equal(shown.label, "Inconclusive: mixed languages");
  assert.match(shown.detail, /cannot give a truthful whole-document result/);
  assert.doesNotMatch(shown.detail, /validated|\d+\s*(%|\/100)/i);
  assert.equal(withLanguageUnavailableAi({ aiStatus: "failed" }, mixed).aiUnavailableReason, AI_UNAVAILABLE_REASON_UNSUPPORTED_LANGUAGE, "re-running cannot change it: no Retry");
  const complete = aiSignalDisplay({ aiAnalysis: { status: "complete", scoringVersion: 0, score: null, model: "m", engine: null, threshold: 0.5, eligibleWordCount: 500, analyzedWordCount: 500, passages: [] } }, { aiStatus: "ready", aiScore: 35, aiTone: null });
  assert.equal(complete.value, 35);
  assert.match(complete.detail, /^Experimental\./);
  assert.match(complete.detail, /not calibrated probabilities of AI authorship/);
  assert.match(complete.detail, /not the percentage of the text written by AI/);
  assert.doesNotMatch(complete.detail + complete.range, /validated|%/i);
});

test("labels: the PDF, room tile and history row mark the AI score as experimental", async () => {
  const pdf = await readFile(new URL("../components/report/ai-report.tsx", import.meta.url), "utf8");
  assert.match(pdf, /EXPERIMENTAL ENGLISH AI WRITING ANALYSIS/);
  for (const f of ["../app/reports/rooms/[room]/room-page-shell.tsx", "../components/reports/report-history-row.tsx"]) {
    assert.match(await readFile(new URL(f, import.meta.url), "utf8"), /AI indicators"\} · experimental`/);
  }
});
