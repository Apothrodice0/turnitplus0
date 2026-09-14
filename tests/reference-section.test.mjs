import assert from "node:assert/strict";
import test from "node:test";
import { findReferenceSectionStart, stripReferenceSection } from "../lib/reference-section.ts";

/**
 * "Investigate two real detection issues" ISSUE 1 — direct unit coverage
 * for the shared reference-section detector, isolated from the real PDF/
 * DOCX fixtures (tests/pdf-docx-extraction-parity.test.mjs covers those
 * end to end). See this module's own header comment for the full
 * root-cause account.
 */

test("FORMAT-AGNOSTIC: a numbered reference list is detected whether or not the heading has surrounding newlines", () => {
  const withNewlines = "Body text ends here.\n\nReferences\n\n[1] Author, A. Title of work. Journal, 2020.\n[2] Other, B. Second title. Conf, 2019.";
  const withoutNewlines = "Body text ends here.  References  [1] Author, A. Title of work. Journal, 2020. [2] Other, B. Second title. Conf, 2019.";

  const withNewlinesBody = stripReferenceSection(withNewlines);
  const withoutNewlinesBody = stripReferenceSection(withoutNewlines);

  assert.match(withNewlinesBody, /Body text ends here\./);
  assert.doesNotMatch(withNewlinesBody, /Author, A\./);
  assert.match(withoutNewlinesBody, /Body text ends here\./);
  assert.doesNotMatch(withoutNewlinesBody, /Author, A\./, "the exact regression: PDF-style space-joined text (no newlines) must still have its reference list detected");
});

test("author-year style reference lists (no numbered brackets) are also detected", () => {
  const text = "The study concludes here.\n\nReferences\n\nSmith, J., & Doe, A. (2020). A study of things. Journal of Studies, 12(3), 45-67.\nJohnson, K. (2019). Another study. Publisher House.\nLee, M. (2018). Third study. Conf. Proc., 100-110.";
  const body = stripReferenceSection(text);
  assert.equal(body.trim(), "The study concludes here.");
});

test("FALSE POSITIVE GUARD: ordinary prose mentioning \"references\" without an actual list is never stripped", () => {
  const text = "This section references several prior studies in the field. As the references above indicate, the topic has been well studied, and many references converge on similar conclusions.";
  assert.equal(findReferenceSectionStart(text), -1);
  assert.equal(stripReferenceSection(text), text);
});

test("FALSE POSITIVE GUARD: a single bracketed in-text citation is not mistaken for a reference list opening", () => {
  const text = "Recent work [13] has shown that this approach generalizes well across a variety of unrelated downstream tasks discussed at length in the following sections of this paper.";
  assert.equal(findReferenceSectionStart(text), -1, "one isolated citation with ordinary prose after it must not be treated as the start of a reference list");
});

test("BIBLIOGRAPHY and WORKS CITED headings are recognized identically to REFERENCES", () => {
  const bibliography = "End of body.\n\nBibliography\n\n[1] A. One. Title. 2021.\n[2] B. Two. Title. 2020.";
  const worksCited = "End of body.\n\nWorks Cited\n\n[1] A. One. Title. 2021.\n[2] B. Two. Title. 2020.";
  assert.equal(stripReferenceSection(bibliography).trim(), "End of body.");
  assert.equal(stripReferenceSection(worksCited).trim(), "End of body.");
});

test("case-insensitive matching", () => {
  const text = "End of body.\n\nREFERENCES\n\n[1] A. One. Title. 2021.\n[2] B. Two. Title. 2020.";
  assert.equal(stripReferenceSection(text).trim(), "End of body.");
});

test("a document with no reference section at all is returned unchanged", () => {
  const text = "This is a short document with no bibliography or reference list of any kind, just plain body prose from start to finish.";
  assert.equal(findReferenceSectionStart(text), -1);
  assert.equal(stripReferenceSection(text), text);
});

test("the LAST qualifying heading wins when an earlier prose mention precedes the real section", () => {
  const text = "Our references to prior work are discussed throughout. We conclude here.\n\nReferences\n\n[1] Real, C. Actual entry. 2022.\n[2] Second, D. Another entry. 2021.";
  const body = stripReferenceSection(text);
  assert.match(body, /Our references to prior work are discussed throughout/, "the early incidental mention of \"references\" must survive as body text");
  assert.match(body, /We conclude here\./);
  assert.doesNotMatch(body, /Real, C\./);
});

test("empty input never throws", () => {
  assert.equal(findReferenceSectionStart(""), -1);
  assert.equal(stripReferenceSection(""), "");
});

// --- "Investigate two production issues" ISSUE 2 ---

test("LETTERED CATEGORIES: a reference list grouped by type (\"A. Books\", \"B. Theses\", ...) with semicolon-delimited years is detected", () => {
  // Modeled on a real production case (categorized bibliography, non-
  // parenthetical "Author, Title, Publisher; Year." citation style) that
  // slipped past both the numbered-marker and the parenthetical-year
  // checks — see looksLikeReferenceListStart's own comment.
  const text = "This concludes the discussion.\n\nREFERENCES\n\nA. Books\n\nSmith, J. General Studies, Example Press, City; 2014.\n\nB. Theses\n\nDoe, A. A Comparative Analysis, PhD Thesis, State University; 2023.";
  const body = stripReferenceSection(text);
  assert.equal(body.trim(), "This concludes the discussion.");
});

test("LETTERED CATEGORIES: a lowercase letter or a longer word is NOT mistaken for a category marker", () => {
  const text = "This concludes the discussion.\n\nReferences\n\na lowercase word is not a real list marker at all, just prose continuing normally.";
  assert.equal(findReferenceSectionStart(text), -1);
});

test("DELIMITED YEAR: an ordinary in-prose year mention (not tightly delimited on both sides) does NOT trigger the weaker signal alone", () => {
  const text = "This concludes the discussion.\n\nReferences\n\nSome prose here mentions the year 2014 in passing and again references 2020 without ever forming a real citation list at all.";
  assert.equal(findReferenceSectionStart(text), -1);
});

// --- MULTILINGUAL HEADING SUPPORT (Unicode-safe boundaries) ---
//
// lib/reference-section.ts's HEADING_PATTERN switched from \b(...)\b to a
// \p{L}/\p{N}-based negative-lookbehind/lookahead boundary — \b is defined
// purely in terms of \w ([A-Za-z0-9_]), which excludes both Arabic letters
// and accented Latin letters (é, à, ç, ...) even under /u. All tests below
// exercise ONLY the heading-detection change: the existing corroboration
// function (looksLikeReferenceListStart) is completely untouched, so every
// "recognized" case here still requires the exact same numbered/lettered-
// marker or year-cluster evidence English already requires — nothing about
// what counts as "looks like a real reference list" changed.

// -- French --

test("FRENCH: 'Références' heading with a numbered citation list is detected", () => {
  const text = "Ceci conclut la discussion du mémoire.\n\nRéférences\n\n[1] Dupont, J. Étude des phénomènes. Revue Française, 2020.\n[2] Martin, C. Deuxième étude. Éditions Example, 2019.";
  const body = stripReferenceSection(text);
  assert.equal(body.trim(), "Ceci conclut la discussion du mémoire.");
});

test("FRENCH: 'Bibliographie' heading is recognized", () => {
  const text = "Fin du corps du texte.\n\nBibliographie\n\n[1] Leclerc, A. Ouvrage complet. Presses Universitaires, 2018.\n[2] Bernard, P. Second ouvrage. Éditions XYZ, 2017.";
  const body = stripReferenceSection(text);
  assert.equal(body.trim(), "Fin du corps du texte.");
});

test("FRENCH: compound heading 'Références bibliographiques' is detected", () => {
  const text = "Conclusion du document.\n\nRéférences bibliographiques\n\n[1] Petit, R. Analyse comparative. Revue Scientifique, 2021.\n[2] Moreau, S. Étude complémentaire. Journal Universitaire, 2020.";
  const body = stripReferenceSection(text);
  assert.equal(body.trim(), "Conclusion du document.");
});

test("FRENCH: compound heading 'Références bibliographiques' is detected via the STRONG immediate-marker signal ALONE, independent of the weak year/citation fallback", () => {
  // Deliberately isolates the STRONG immediate-numbered-marker corroboration
  // path from looksLikeReferenceListStart: exactly ONE entry, no repeated
  // years (the weak fallback requires >=2), no citation vocabulary, no
  // parenthetical/delimited year. If HEADING_TERMS ever regresses to listing
  // "références" ahead of "références\s+bibliographiques" again, JS
  // alternation's first-match-wins semantics make the compound heading match
  // only as "Références" - the STRONG check would then see "bibliographiques"
  // immediately after the match (not "[1]") and fail to fire, and this
  // single-entry fixture has no other signal to fall back on, so this test
  // would fail.
  const text = "Conclusion du document.\n\nRéférences bibliographiques\n\n[1] Unique, X. Title.";
  const headingStart = text.indexOf("Références bibliographiques");

  assert.equal(findReferenceSectionStart(text), headingStart, "must resolve to the start of the full compound heading");

  const body = stripReferenceSection(text);
  assert.equal(body.trim(), "Conclusion du document.", "the body text before the heading must be retained");
  assert.doesNotMatch(body, /Références bibliographiques/, "the entire compound heading must be excluded");
  assert.doesNotMatch(body, /Unique, X\./, "the single bibliography entry must be excluded");
});

test("FRENCH: uppercase and mixed-case accented heading variants are recognized identically", () => {
  const upper = "Fin du texte.\n\nRÉFÉRENCES\n\n[1] Auteur, X. Titre. Revue, 2020.\n[2] Auteur, Y. Titre deux. Revue, 2019.";
  const mixedCase = "Fin du texte.\n\nRéférences\n\n[1] Auteur, X. Titre. Revue, 2020.\n[2] Auteur, Y. Titre deux. Revue, 2019.";
  assert.equal(stripReferenceSection(upper).trim(), "Fin du texte.");
  assert.equal(stripReferenceSection(mixedCase).trim(), "Fin du texte.");
});

test("FALSE POSITIVE GUARD (FRENCH): 'références'/'bibliographie' in ordinary prose without a real list is never stripped", () => {
  const text = "Cette section présente des références à plusieurs études antérieures. Comme le montrent les références ci-dessus, une bibliographie exhaustive serait trop longue, et de nombreuses références convergent vers des conclusions similaires.";
  assert.equal(findReferenceSectionStart(text), -1);
  assert.equal(stripReferenceSection(text), text);
});

test("EMBEDDED WORD GUARD (FRENCH): 'références' inside a larger word like 'préférences' is not matched as a heading candidate", () => {
  // \b(références)\b would behave unpredictably here — "é" is itself
  // "non-word" under \w's ASCII-only definition, so a naive \b-based
  // pattern has spurious word-boundary transitions around every accented
  // letter in an ordinary French word. The \p{L}-based check correctly
  // sees "p" (immediately before the embedded "références") as a letter
  // and rejects the match.
  const text = "Cette section décrit les préférences des utilisateurs interrogés lors de l'étude et se termine ici sans aucune autre mention du terme cible dans ce texte.";
  assert.equal(findReferenceSectionStart(text), -1);
});

test("FRENCH: a full French-style manuscript retains its body and excludes only the bibliography, per the existing policy", () => {
  const text = "Introduction\n\nCette étude examine plusieurs phénomènes intéressants dans le domaine considéré.\n\nConclusion\n\nEn résumé, les résultats confirment notre hypothèse initiale.\n\nRéférences\n\n[1] Dupont, J. Étude des phénomènes. Revue Française, 2020.\n[2] Martin, C. Deuxième étude. Éditions Example, 2019.\n[3] Bernard, P. Troisième référence. Journal, 2018.";
  const body = stripReferenceSection(text);
  assert.match(body, /Cette étude examine/);
  assert.match(body, /En résumé, les résultats confirment/);
  assert.doesNotMatch(body, /Dupont, J\./);
  assert.doesNotMatch(body, /Martin, C\./);
});

// -- Arabic --

test("ARABIC: 'المراجع' heading with a numbered citation list is detected", () => {
  const text = "تنتهي هذه المناقشة هنا.\n\nالمراجع\n\n[1] أحمد، محمد. دراسة الظواهر. مجلة العلوم، 2020.\n[2] علي، سارة. دراسة ثانية. دار النشر، 2019.";
  const body = stripReferenceSection(text);
  assert.equal(body.trim(), "تنتهي هذه المناقشة هنا.");
});

test("ARABIC: 'قائمة المراجع' heading is recognized", () => {
  const text = "نهاية النص الأساسي.\n\nقائمة المراجع\n\n[1] حسن، علي. مرجع كامل. مطبعة الجامعة، 2018.\n[2] يوسف، ليلى. مرجع ثانٍ. دار النشر، 2017.";
  const body = stripReferenceSection(text);
  assert.equal(body.trim(), "نهاية النص الأساسي.");
});

test("ARABIC: compound heading 'المصادر والمراجع' is detected", () => {
  const text = "خاتمة الدراسة.\n\nالمصادر والمراجع\n\n[1] كريم، سامي. تحليل مقارن. مجلة علمية، 2021.\n[2] سعيد، منى. دراسة تكميلية. مجلة جامعية، 2020.";
  const body = stripReferenceSection(text);
  assert.equal(body.trim(), "خاتمة الدراسة.");
});

test("ARABIC: a heading followed by a colon before the reference list is still recognized", () => {
  // The colon sits between the heading and the list, so the STRONG
  // immediate-marker check does not fire (looksLikeReferenceListStart's
  // trimStart() does not strip a colon) — this exercises the existing
  // weaker fallback signal (>=2 years plus a parenthetical year), which is
  // unaffected by a leading colon since it scans the whole lookahead
  // window rather than anchoring to its start. No corroboration logic was
  // changed to make this pass.
  const text = "خاتمة النص.\n\nالمراجع:\n\n(2020) أحمد، محمد. دراسة الظواهر. مجلة العلوم.\n(2019) علي، سارة. دراسة ثانية. دار النشر.";
  const body = stripReferenceSection(text);
  assert.equal(body.trim(), "خاتمة النص.");
});

test("FALSE POSITIVE GUARD (ARABIC): 'المراجع' in ordinary prose without a real list is never stripped", () => {
  const text = "يناقش هذا القسم المراجع السابقة المتعلقة بهذا الموضوع. وكما تشير المراجع أعلاه فإن هذا الموضوع قد درس جيدا، وتتفق معظم المراجع على استنتاجات مماثلة في نهاية المطاف.";
  assert.equal(findReferenceSectionStart(text), -1);
  assert.equal(stripReferenceSection(text), text);
});

test("EMBEDDED WORD GUARD (ARABIC): 'المراجع' inside a larger word like 'المراجعون' is not matched as a heading candidate", () => {
  // \bالمراجع\b never matches at all in real usage — neither an Arabic
  // letter nor a space is ever \w, so \b has no \w/non-\w transition to
  // fire on here. The \p{L}-based check instead directly inspects the
  // character after the candidate match ("و" in "المراجعون") and correctly
  // rejects it as a letter, not a boundary.
  const text = "قام المراجعون بفحص هذا العمل بعناية قبل نشره في المجلة، وينتهي هذا القسم هنا دون أي إشارة أخرى إلى المصطلح المستهدف في هذا النص.";
  assert.equal(findReferenceSectionStart(text), -1);
});

test("ARABIC: a full Arabic-style manuscript retains its body and excludes only the bibliography, per the existing policy", () => {
  const text = "المقدمة\n\nتتناول هذه الدراسة عدة ظواهر مثيرة للاهتمام في هذا المجال.\n\nالخاتمة\n\nباختصار، تؤكد النتائج فرضيتنا الأولية.\n\nالمراجع\n\n[1] أحمد، محمد. دراسة الظواهر. مجلة العلوم، 2020.\n[2] علي، سارة. دراسة ثانية. دار النشر، 2019.\n[3] حسن، كريم. مرجع ثالث. مجلة أخرى، 2018.";
  const body = stripReferenceSection(text);
  assert.match(body, /تتناول هذه الدراسة/);
  assert.match(body, /باختصار، تؤكد النتائج/);
  assert.doesNotMatch(body, /أحمد، محمد/);
  assert.doesNotMatch(body, /علي، سارة/);
});
