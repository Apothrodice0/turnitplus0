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
  const withNewlines = "Body text ends here. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This \n\nReferences\n\n[1] Author, A. Title of work. Journal, 2020.\n[2] Other, B. Second title. Conf, 2019.";
  const withoutNewlines = "Body text ends here. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This   References  [1] Author, A. Title of work. Journal, 2020. [2] Other, B. Second title. Conf, 2019.";

  const withNewlinesBody = stripReferenceSection(withNewlines);
  const withoutNewlinesBody = stripReferenceSection(withoutNewlines);

  assert.match(withNewlinesBody, /Body text ends here\./);
  assert.doesNotMatch(withNewlinesBody, /Author, A\./);
  assert.match(withoutNewlinesBody, /Body text ends here\./);
  assert.doesNotMatch(withoutNewlinesBody, /Author, A\./, "the exact regression: PDF-style space-joined text (no newlines) must still have its reference list detected");
});

test("author-year style reference lists (no numbered brackets) are also detected", () => {
  const text = "The study concludes here. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph adds unrelated\n\nReferences\n\nSmith, J., & Doe, A. (2020). A study of things. Journal of Studies, 12(3), 45-67.\nJohnson, K. (2019). Another study. Publisher House.\nLee, M. (2018). Third study. Conf. Proc., 100-110.";
  const body = stripReferenceSection(text);
  assert.equal(body.trim(), "The study concludes here. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph adds unrelated");
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
  const bibliography = "End of body. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph adds unrelated neutral \n\nBibliography\n\n[1] A. One. Title. 2021.\n[2] B. Two. Title. 2020.";
  const worksCited = "End of body. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph adds unrelated neutra\n\nWorks Cited\n\n[1] A. One. Title. 2021.\n[2] B. Two. Title. 2020.";
  assert.equal(stripReferenceSection(bibliography).trim(), "End of body. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph adds unrelated neutral");
  assert.equal(stripReferenceSection(worksCited).trim(), "End of body. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph adds unrelated neutra");
});

test("case-insensitive matching", () => {
  const text = "End of body. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph adds unrelated neu\n\nREFERENCES\n\n[1] A. One. Title. 2021.\n[2] B. Two. Title. 2020.";
  assert.equal(stripReferenceSection(text).trim(), "End of body. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph adds unrelated neu");
});

test("a document with no reference section at all is returned unchanged", () => {
  const text = "This is a short document with no bibliography or reference list of any kind, just plain body prose from start to finish.";
  assert.equal(findReferenceSectionStart(text), -1);
  assert.equal(stripReferenceSection(text), text);
});

test("the LAST qualifying heading wins when an earlier prose mention precedes the real section", () => {
  const text = "Our references to prior work are discussed throughout. We conclude here. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph add\n\nReferences\n\n[1] Real, C. Actual entry. 2022.\n[2] Second, D. Another entry. 2021.";
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
  const text = "This concludes the discussion. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph adds unrelated n\n\nREFERENCES\n\nA. Books\n\nSmith, J. General Studies, Example Press, City; 2014.\n\nB. Theses\n\nDoe, A. A Comparative Analysis, PhD Thesis, State University; 2023.";
  const body = stripReferenceSection(text);
  assert.equal(body.trim(), "This concludes the discussion. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph adds unrelated neutral body prose so the fixture models a realistically long document. This paragraph adds unrelated n");
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
  const text = "Ceci conclut la discussion du mémoire. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longueur plus réaliste. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longueur plus réaliste. Ce paragraphe ajoute un texte neutre et sans rapp\n\nRéférences\n\n[1] Dupont, J. Étude des phénomènes. Revue Française, 2020.\n[2] Martin, C. Deuxième étude. Éditions Example, 2019.";
  const body = stripReferenceSection(text);
  assert.equal(body.trim(), "Ceci conclut la discussion du mémoire. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longueur plus réaliste. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longueur plus réaliste. Ce paragraphe ajoute un texte neutre et sans rapp");
});

test("FRENCH: 'Bibliographie' heading is recognized", () => {
  const text = "Fin du corps du texte. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longueur plus réaliste. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longueur plus réaliste. Ce paragraphe ajoute un texte neutre et sans rapport afin que le documen\n\nBibliographie\n\n[1] Leclerc, A. Ouvrage complet. Presses Universitaires, 2018.\n[2] Bernard, P. Second ouvrage. Éditions XYZ, 2017.";
  const body = stripReferenceSection(text);
  assert.equal(body.trim(), "Fin du corps du texte. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longueur plus réaliste. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longueur plus réaliste. Ce paragraphe ajoute un texte neutre et sans rapport afin que le documen");
});

test("FRENCH: compound heading 'Références bibliographiques' is detected", () => {
  const text = "Conclusion du document. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longueur plus réaliste. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longueur plus réaliste. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longueur plus réaliste. Ce paragraphe ajoute un te\n\nRéférences bibliographiques\n\n[1] Petit, R. Analyse comparative. Revue Scientifique, 2021.\n[2] Moreau, S. Étude complémentaire. Journal Universitaire, 2020.";
  const body = stripReferenceSection(text);
  assert.equal(body.trim(), "Conclusion du document. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longueur plus réaliste. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longueur plus réaliste. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longueur plus réaliste. Ce paragraphe ajoute un te");
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
  const text = "Conclusion du document. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longueur plus réa\n\nRéférences bibliographiques\n\n[1] Unique, X. Title.";
  const headingStart = text.indexOf("Références bibliographiques");

  assert.equal(findReferenceSectionStart(text), headingStart, "must resolve to the start of the full compound heading");

  const body = stripReferenceSection(text);
  assert.equal(body.trim(), "Conclusion du document. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longueur plus réa", "the body text before the heading must be retained");
  assert.doesNotMatch(body, /Références bibliographiques/, "the entire compound heading must be excluded");
  assert.doesNotMatch(body, /Unique, X\./, "the single bibliography entry must be excluded");
});

test("FRENCH: uppercase and mixed-case accented heading variants are recognized identically", () => {
  const upper = "Fin du texte. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longueur plus réaliste. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longu\n\nRÉFÉRENCES\n\n[1] Auteur, X. Titre. Revue, 2020.\n[2] Auteur, Y. Titre deux. Revue, 2019.";
  const mixedCase = "Fin du texte. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longueur plus réaliste. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longu\n\nRéférences\n\n[1] Auteur, X. Titre. Revue, 2020.\n[2] Auteur, Y. Titre deux. Revue, 2019.";
  assert.equal(stripReferenceSection(upper).trim(), "Fin du texte. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longueur plus réaliste. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longu");
  assert.equal(stripReferenceSection(mixedCase).trim(), "Fin du texte. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longueur plus réaliste. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longu");
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
  const text = "Introduction\n\nCette étude examine plusieurs phénomènes intéressants dans le domaine considéré.\n\nConclusion\n\nEn résumé, les résultats confirment notre hypothèse initiale. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longueur plus réaliste. Ce paragraphe ajoute un texte neutre et sans rapport afin que le document ait une longueur plus réaliste. Ce paragraphe ajoute un texte neutre et\n\nRéférences\n\n[1] Dupont, J. Étude des phénomènes. Revue Française, 2020.\n[2] Martin, C. Deuxième étude. Éditions Example, 2019.\n[3] Bernard, P. Troisième référence. Journal, 2018.";
  const body = stripReferenceSection(text);
  assert.match(body, /Cette étude examine/);
  assert.match(body, /En résumé, les résultats confirment/);
  assert.doesNotMatch(body, /Dupont, J\./);
  assert.doesNotMatch(body, /Martin, C\./);
});

// -- Arabic --

test("ARABIC: 'المراجع' heading with a numbered citation list is detected", () => {
  const text = "تنتهي هذه المناقشة هنا. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الف\n\nالمراجع\n\n[1] أحمد، محمد. دراسة الظواهر. مجلة العلوم، 2020.\n[2] علي، سارة. دراسة ثانية. دار النشر، 2019.";
  const body = stripReferenceSection(text);
  assert.equal(body.trim(), "تنتهي هذه المناقشة هنا. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الف");
});

test("ARABIC: 'قائمة المراجع' heading is recognized", () => {
  const text = "نهاية النص الأساسي. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا\n\nقائمة المراجع\n\n[1] حسن، علي. مرجع كامل. مطبعة الجامعة، 2018.\n[2] يوسف، ليلى. مرجع ثانٍ. دار النشر، 2017.";
  const body = stripReferenceSection(text);
  assert.equal(body.trim(), "نهاية النص الأساسي. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا");
});

test("ARABIC: compound heading 'المصادر والمراجع' is detected", () => {
  const text = "خاتمة الدراسة. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل ال\n\nالمصادر والمراجع\n\n[1] كريم، سامي. تحليل مقارن. مجلة علمية، 2021.\n[2] سعيد، منى. دراسة تكميلية. مجلة جامعية، 2020.";
  const body = stripReferenceSection(text);
  assert.equal(body.trim(), "خاتمة الدراسة. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل ال");
});

test("ARABIC: a heading followed by a colon before the reference list is still recognized", () => {
  // The colon sits between the heading and the list, so the STRONG
  // immediate-marker check does not fire (looksLikeReferenceListStart's
  // trimStart() does not strip a colon) — this exercises the existing
  // weaker fallback signal (>=2 years plus a parenthetical year), which is
  // unaffected by a leading colon since it scans the whole lookahead
  // window rather than anchoring to its start. No corroboration logic was
  // changed to make this pass.
  const text = "خاتمة النص. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفق\n\nالمراجع:\n\n(2020) أحمد، محمد. دراسة الظواهر. مجلة العلوم.\n(2019) علي، سارة. دراسة ثانية. دار النشر.";
  const body = stripReferenceSection(text);
  assert.equal(body.trim(), "خاتمة النص. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفق");
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
  const text = "المقدمة\n\nتتناول هذه الدراسة عدة ظواهر مثيرة للاهتمام في هذا المجال.\n\nالخاتمة\n\nباختصار، تؤكد النتائج فرضيتنا الأولية. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا محايدا غير ذي صلة لجعل المستند أكثر واقعية وطولا. تضيف هذه الفقرة نصا \n\nالمراجع\n\n[1] أحمد، محمد. دراسة الظواهر. مجلة العلوم، 2020.\n[2] علي، سارة. دراسة ثانية. دار النشر، 2019.\n[3] حسن، كريم. مرجع ثالث. مجلة أخرى، 2018.";
  const body = stripReferenceSection(text);
  assert.match(body, /تتناول هذه الدراسة/);
  assert.match(body, /باختصار، تؤكد النتائج/);
  assert.doesNotMatch(body, /أحمد، محمد/);
  assert.doesNotMatch(body, /علي، سارة/);
});

// --- TERMINAL-FRACTION GUARD (Strategy A, threshold = 0.50, character-offset fraction) ---
//
// findReferenceSectionStart now requires candidate.start / text.length >= 0.50
// before a candidate heading is even corroborated (see lib/reference-section.ts's
// TERMINAL_FRACTION_THRESHOLD). Audited against a real 273-page book where an
// incidental heading occurrence at 22.4% discarded 77.6% of substantive
// content, versus every confirmed genuine terminal case sitting at 55%+.
//
// The fixtures below place a candidate at an EXACTLY computed character
// offset (not approximated) so the 0.50 boundary itself can be tested
// precisely: candidateStart = prefixLength + 2 by construction (prefix,
// then "\n\n", then the heading), so solving prefixLength for a target
// fraction is exact integer arithmetic, not trial and error.

function fixtureWithPrefixLength(suffix, prefixLength) {
  const prefix = "x".repeat(Math.max(0, prefixLength));
  const text = `${prefix}\n\n${suffix}`;
  const candidateStart = prefixLength + 2;
  return { text, candidateStart, fraction: candidateStart / text.length };
}

function fixtureAtFraction(suffix, targetFraction) {
  const k = suffix.length;
  const x = Math.round((targetFraction * k) / (1 - targetFraction));
  return fixtureWithPrefixLength(suffix, Math.max(0, x - 2));
}

test("TERMINAL-FRACTION GUARD: a qualifying candidate clearly before the 50% mark (~20%, mirroring the audited Fuller failure position of 22.4%) is rejected outright", () => {
  const suffix = "References\n\n[1] Entry one. 2020.\n[2] Entry two. 2019.";
  const { text, fraction } = fixtureAtFraction(suffix, 0.2);
  assert.ok(fraction < 0.3, `test setup check: fraction ${fraction} should be well under 0.5`);
  assert.equal(findReferenceSectionStart(text), -1);
});

test("TERMINAL-FRACTION GUARD: candidate immediately below the 0.50 threshold is rejected", () => {
  const suffix = "References\n\n[1] Entry one. 2020.\n[2] Entry two. 2019.";
  const k = suffix.length;
  const { text, fraction } = fixtureWithPrefixLength(suffix, k - 3);
  assert.ok(fraction < 0.5, `test setup check: fraction ${fraction} must be < 0.5`);
  assert.equal(findReferenceSectionStart(text), -1);
});

test("TERMINAL-FRACTION GUARD: candidate exactly at the 0.50 threshold is accepted (inclusive boundary: candidateStart / text.length >= 0.50)", () => {
  const suffix = "References\n\n[1] Entry one. 2020.\n[2] Entry two. 2019.";
  const k = suffix.length;
  const { text, fraction, candidateStart } = fixtureWithPrefixLength(suffix, k - 2);
  assert.equal(fraction, 0.5, `test setup check: fraction must be exactly 0.5, got ${fraction}`);
  assert.equal(findReferenceSectionStart(text), candidateStart);
});

test("TERMINAL-FRACTION GUARD: candidate immediately above the 0.50 threshold is accepted", () => {
  const suffix = "References\n\n[1] Entry one. 2020.\n[2] Entry two. 2019.";
  const k = suffix.length;
  const { text, fraction, candidateStart } = fixtureWithPrefixLength(suffix, k - 1);
  assert.ok(fraction > 0.5, `test setup check: fraction ${fraction} must be > 0.5`);
  assert.equal(findReferenceSectionStart(text), candidateStart);
});

test("TERMINAL-FRACTION GUARD: a genuine terminal reference section well after the 50% mark (~90%, mirroring the audited Sandel case) is still correctly stripped", () => {
  const suffix = "References\n\n[1] Real, C. Actual entry. 2022.\n[2] Second, D. Another entry. 2021.";
  const { text, fraction, candidateStart } = fixtureAtFraction(suffix, 0.9);
  assert.ok(fraction > 0.85, `test setup check: fraction ${fraction} should be well within the terminal region`);
  assert.equal(findReferenceSectionStart(text), candidateStart);
  assert.doesNotMatch(stripReferenceSection(text), /Real, C\./);
});

test("TERMINAL-FRACTION GUARD: the existing STRONG numbered-marker signal still fires normally once the candidate is inside the terminal window", () => {
  const suffix = "Bibliography\n\n[1] Author, A. Title. 2023.\n[2] Author, B. Title two. 2022.";
  const { text, fraction, candidateStart } = fixtureAtFraction(suffix, 0.65);
  assert.ok(fraction >= 0.5, `test setup check: fraction ${fraction} must be inside the terminal window`);
  assert.equal(findReferenceSectionStart(text), candidateStart);
});

test("TERMINAL-FRACTION GUARD: the existing WEAK year-cluster signal still fires normally once the candidate is inside the terminal window", () => {
  const suffix = "References\n\nSmith, J. (2020). A study. Journal, 12, 45-67.\nDoe, A. (2019). Another study. Publisher House.";
  const { text, fraction, candidateStart } = fixtureAtFraction(suffix, 0.65);
  assert.ok(fraction >= 0.5, `test setup check: fraction ${fraction} must be inside the terminal window`);
  assert.equal(findReferenceSectionStart(text), candidateStart);
});

test("TERMINAL-FRACTION GUARD: a heading at the very start of the document (fraction 0) is rejected regardless of otherwise-qualifying content", () => {
  const text = "References\n\n[1] Entry. 2020.\n[2] Entry two. 2019.";
  assert.equal(findReferenceSectionStart(text), -1);
});

test("TERMINAL-FRACTION GUARD: FULLER-SHAPE regression — an early incidental heading occurrence with adjacent footnote years no longer discards the rest of the document", () => {
  // Mirrors the audited Fuller failure mechanism exactly: an incidental
  // prose use of "references" immediately followed by two footnotes that
  // each carry a parenthetical year — enough to satisfy the existing WEAK
  // corroboration signal — sitting early in a long document, with
  // substantial further substantive content afterward and no other
  // candidate anywhere (this codebase's HEADING_TERMS does not recognize
  // "Notes", exactly as audited).
  const earlyFalseCandidate =
    "Relevant references will be found in my article in 71 Harvard Law Review 650 (1958). " +
    "Graham v. Goodcell, 282 U.S. 409, 429 (1930).";
  const laterSubstantiveContent = "Further chapters of substantive analysis continue here. ".repeat(200);
  const text = `Chapter one begins here. ${earlyFalseCandidate} ${laterSubstantiveContent}`;

  const candidateOffset = text.indexOf("references");
  assert.ok(candidateOffset / text.length < 0.5, "test setup check: the false candidate must sit before the 50% mark");

  assert.equal(findReferenceSectionStart(text), -1, "no genuine terminal heading exists, so the whole document must be retained, not truncated at the early incidental mention");
  assert.equal(stripReferenceSection(text), text);
});

// --- CITATION-POINTER REJECTION (reference-strip-pointer-rule-audit 20260919T182220Z) ---
//
// findReferenceSectionStart now rejects a candidate — after the existing 50%
// terminal-fraction guard and before the existing 700-char corroboration —
// when its immediate (<=30 char, trimStart()-ed) lookahead matches one of
// three closed, evidence-backed pointer phrases: /^see\b/i, /^of\s+the\b/i,
// /^will\s+be\s+found\b/i. These fix two confirmed real false positives
// (Lipset, one Archive769 document) while preserving all 411 known genuine
// reference-section strips from the audit. Case 1 of the audit's own test
// plan ("Fuller-shaped false case remains rejected") is already covered,
// unmodified, by the existing "FULLER-SHAPE regression" test directly above
// — the 50% guard rejects that candidate before the new gate is ever
// reached, so no new assertion is needed for it.

test("CITATION-POINTER: Fuller-shaped 'will be found' phrase moved PAST the 50% mark is rejected by the new gate (case 2 of the audit's test plan — not covered by the existing pre-50%-guard Fuller test)", () => {
  const suffix =
    "References will be found in my article in 71 Harvard Law Review 650 (1958). " +
    "Graham v. Goodcell, 282 U.S. 409, 429 (1930).";
  const { text, fraction } = fixtureAtFraction(suffix, 0.6);
  assert.ok(fraction > 0.5, `test setup check: fraction ${fraction} must be past the terminal guard`);
  assert.equal(findReferenceSectionStart(text), -1, "the 'will be found' pointer phrase must reject this candidate even past 50% (without the new gate, this exact shape passes the existing weak corroboration signal via its two parenthetical years)");
  assert.equal(stripReferenceSection(text), text);
});

test("CITATION-POINTER: Lipset-shaped 'references see ...' past 50% is rejected", () => {
  const suffix =
    "References see S. M. Author and R. Coauthor, Some Title (City: Publisher, 1959). " +
    "See also T. Other (Elsewhere, 1962), pp. 14, 111. 32 Next Footnote reference continues here " +
    "discussing further work by Third, A. (1965) and Fourth, B. et al. (1970).";
  const { text, fraction } = fixtureAtFraction(suffix, 0.6);
  assert.ok(fraction > 0.5, `test setup check: fraction ${fraction} must be past 50%`);
  assert.equal(findReferenceSectionStart(text), -1, "the 'see' pointer phrase must reject this candidate (without the new gate, this shape passes the existing weak corroboration signal via 4 years + 'et al.'/'pp.')");
});

test("CITATION-POINTER: Archive-shaped 'references of the ...' past 50% is rejected", () => {
  const suffix =
    "References of the Example Peace Conference, the some-principle, UN Resolutions 1397, 338, 242, " +
    "discussed further in relation to events from 1991 and 1993 regarding regional diplomacy et al. (1995).";
  const { text, fraction } = fixtureAtFraction(suffix, 0.6);
  assert.ok(fraction > 0.5, `test setup check: fraction ${fraction} must be past 50%`);
  assert.equal(findReferenceSectionStart(text), -1, "the 'of the' pointer phrase must reject this candidate (without the new gate, this shape passes the existing weak corroboration signal via 3 years + 'et al.')");
});

test("CITATION-POINTER: leading whitespace (newlines and extra spaces) between the heading and the pointer phrase is trimmed before matching", () => {
  const suffix =
    "References\n\n   see S. M. Author and R. Coauthor, Some Title (City: Publisher, 1959). " +
    "See also T. Other (Elsewhere, 1962), discussing further work by Third, A. (1965) et al. (1970).";
  const { text, fraction } = fixtureAtFraction(suffix, 0.6);
  assert.ok(fraction > 0.5, `test setup check: fraction ${fraction} must be past 50%`);
  assert.equal(findReferenceSectionStart(text), -1, "leading whitespace/newlines before the pointer phrase must not prevent rejection");
});

test("CITATION-POINTER: case-insensitive matching across all three pointer forms", () => {
  const pointerCases = [
    "SEE Author, A. Title (Place, 1988). Discussion continues et al. (1992) and 1995.",
    "Of The Committee, the report notes years 1991 and 1993 discussed further et al. (1995).",
    "WILL BE FOUND in the appendix, discussed further in years 1991 and 1993 et al. (1995).",
  ];
  const headingCases = ["REFERENCES", "References", "references"];
  for (const heading of headingCases) {
    for (const pointer of pointerCases) {
      const suffix = `${heading} ${pointer}`;
      const { text, fraction } = fixtureAtFraction(suffix, 0.6);
      assert.ok(fraction > 0.5, `test setup check: fraction ${fraction} must be past 50%`);
      assert.equal(findReferenceSectionStart(text), -1, `expected rejection for heading "${heading}" + pointer "${pointer.slice(0, 15)}..."`);
    }
  }
});

test("GENUINE PRESERVED: 'References list:' remains accepted (not in the closed pointer set)", () => {
  const suffix =
    "References list: Smith, J. (2020). A study of things. Journal of Studies, 12(3), 45-67.\n" +
    "Doe, A. (2019). Another study. Publisher House.";
  const { text, fraction, candidateStart } = fixtureAtFraction(suffix, 0.6);
  assert.ok(fraction > 0.5, `test setup check: fraction ${fraction} must be past 50%`);
  assert.equal(findReferenceSectionStart(text), candidateStart, "'list:' does not match any of the three closed pointer forms, so this genuine case must remain accepted");
});

test("GENUINE PRESERVED: 'Bibliography list:' remains accepted", () => {
  const suffix =
    "Bibliography list: Smith, J. (2020). A study of things. Journal of Studies, 12(3), 45-67.\n" +
    "Doe, A. (2019). Another study. Publisher House.";
  const { text, fraction, candidateStart } = fixtureAtFraction(suffix, 0.6);
  assert.ok(fraction > 0.5, `test setup check: fraction ${fraction} must be past 50%`);
  assert.equal(findReferenceSectionStart(text), candidateStart);
});

test("GENUINE PRESERVED: 'References used in the research:' remains accepted", () => {
  const suffix =
    "References used in the research: Smith, J. (2020). A study of things. Journal of Studies, 12(3), 45-67.\n" +
    "Doe, A. (2019). Another study. Publisher House.";
  const { text, fraction, candidateStart } = fixtureAtFraction(suffix, 0.6);
  assert.ok(fraction > 0.5, `test setup check: fraction ${fraction} must be past 50%`);
  assert.equal(findReferenceSectionStart(text), candidateStart);
});

test("GENUINE PRESERVED: 'References and Referrals' (no colon at all) remains accepted", () => {
  const suffix =
    "References and Referrals\nAuthor, A., Coauthor, B. (2020). Title one. Journal, 1, 1-10.\n" +
    "Author, C. (2019). Title two. Publisher.";
  const { text, fraction, candidateStart } = fixtureAtFraction(suffix, 0.6);
  assert.ok(fraction > 0.5, `test setup check: fraction ${fraction} must be past 50%`);
  assert.equal(findReferenceSectionStart(text), candidateStart);
});

test("NEAR-MISS PRESERVED: 'References of Modern Criticism' is NOT rejected merely because it starts with 'of' — only the 'of the' bigram is in the closed set", () => {
  const suffix = "References of Modern Criticism\n\n[1] Author, A. Title. Journal, 2020.\n[2] Author, B. Title two. Journal, 2019.";
  const { text, fraction, candidateStart } = fixtureAtFraction(suffix, 0.6);
  assert.ok(fraction > 0.5, `test setup check: fraction ${fraction} must be past 50%`);
  assert.equal(findReferenceSectionStart(text), candidateStart, "'of Modern' is not the 'of the' bigram, so this genuine heading must remain eligible");
  assert.doesNotMatch(stripReferenceSection(text), /Author, A\. Title/);
});

test("GENUINE PRESERVED: standalone/running-header 'Bibliography' heading is unaffected by the pointer gate, with and without surrounding newlines (format-agnostic, per the module's own existing convention)", () => {
  const withNewlines = fixtureAtFraction(
    "Bibliography\n\n[1] Retz, Cardinal de. Memoires. Paris: Gallimard, 1717.\n[2] Other, A. Second Work. City: Publisher, 1716.",
    0.6,
  );
  const withoutNewlines = fixtureAtFraction(
    "Bibliography  [1] Retz, Cardinal de. Memoires. Paris: Gallimard, 1717. [2] Other, A. Second Work. City: Publisher, 1716.",
    0.6,
  );
  assert.ok(withNewlines.fraction > 0.5 && withoutNewlines.fraction > 0.5, "test setup check: both fixtures must be past 50%");
  assert.equal(findReferenceSectionStart(withNewlines.text), withNewlines.candidateStart);
  assert.equal(findReferenceSectionStart(withoutNewlines.text), withoutNewlines.candidateStart);
});

test("LANGUAGE SCOPE (FRENCH): 'voir' (French for 'see') immediately after a French heading is NOT rejected — the pointer gate is English-lexeme-only by construction", () => {
  const suffix =
    "Références voir texte suivant pour plus de détails.\n\n" +
    "[1] Un ouvrage. Presses, 2020.\n[2] Deuxième ouvrage, Presses, 2019.";
  const { text, fraction, candidateStart } = fixtureAtFraction(suffix, 0.6);
  assert.ok(fraction > 0.5, `test setup check: fraction ${fraction} must be past 50%`);
  assert.equal(findReferenceSectionStart(text), candidateStart, "French 'voir' cannot match any of the three English-only pointer regexes");
});

test("LANGUAGE SCOPE (ARABIC): 'انظر' (Arabic for 'see') immediately after an Arabic heading is NOT rejected — disjoint script, cannot match any Latin-script pointer pattern", () => {
  const suffix =
    "المراجع انظر النص التالي لمزيد من التفاصيل.\n\n" +
    "(2020) مؤلف، أ. عنوان العمل. مجلة العلوم.\n(2019) مؤلف، ب. عنوان آخر. دار النشر.";
  const { text, fraction, candidateStart } = fixtureAtFraction(suffix, 0.6);
  assert.ok(fraction > 0.5, `test setup check: fraction ${fraction} must be past 50%`);
  assert.equal(findReferenceSectionStart(text), candidateStart);
});

test("BOUNDARY ORDERING: a pointer-shaped candidate immediately BELOW the 0.50 threshold is rejected by the pre-existing 50% guard alone, never reaching the new pointer gate", () => {
  const suffix = "References of the Committee, the report continues with years 1991 and 1993 discussed further et al. (1995).";
  const k = suffix.length;
  const { text, fraction } = fixtureWithPrefixLength(suffix, k - 3);
  assert.ok(fraction < 0.5, `test setup check: fraction ${fraction} must be < 0.5`);
  assert.equal(findReferenceSectionStart(text), -1);
});

test("BOUNDARY ORDERING: a pointer-shaped candidate exactly AT the 0.50 threshold reaches the new gate and is rejected (contrast with the pre-existing genuine-candidate boundary test, which ACCEPTS at exactly 0.50)", () => {
  const suffix = "References of the Committee, the report continues with years 1991 and 1993 discussed further et al. (1995).";
  const k = suffix.length;
  const { text, fraction } = fixtureWithPrefixLength(suffix, k - 2);
  assert.equal(fraction, 0.5, `test setup check: fraction must be exactly 0.5, got ${fraction}`);
  assert.equal(findReferenceSectionStart(text), -1, "at exactly 0.5 the candidate now reaches the pointer gate (guard is inclusive) and is rejected by 'of the'");
});

test("BOUNDARY ORDERING: a pointer-shaped candidate immediately ABOVE the 0.50 threshold reaches the new gate and is rejected", () => {
  const suffix = "References of the Committee, the report continues with years 1991 and 1993 discussed further et al. (1995).";
  const k = suffix.length;
  const { text, fraction } = fixtureWithPrefixLength(suffix, k - 1);
  assert.ok(fraction > 0.5, `test setup check: fraction ${fraction} must be > 0.5`);
  assert.equal(findReferenceSectionStart(text), -1);
});

test("CITATION-POINTER: empty/no-candidate input remains safe and unaffected by the new pointer gate", () => {
  assert.equal(findReferenceSectionStart(""), -1);
  assert.equal(stripReferenceSection(""), "");
  const noHeading = "This is a short document with no bibliography or reference list of any kind, just plain body prose from start to finish.";
  assert.equal(findReferenceSectionStart(noHeading), -1);
});
