import assert from "node:assert/strict";
import test from "node:test";
import { composeCase } from "../tools/accuracy-benchmark-lib/compose.ts";

// REGRESSION (HAL/repository-banner fewSentences fixture defect, 2026-08-21):
// confirmed live on a real HAL-hosted paper (soc-openaire, DOI
// 10.1057/s41253-026-00314-w) that composeCase's "fewSentences" condition —
// which is supposed to probe whether a few genuinely copied sentences are
// still discoverable — instead grabbed 4 sentences of pure repository
// deposit banner (a duplicated deposit id/URL, an English then a French
// administrative paragraph, a license line), because it naively took the
// first N sentences of the raw, unsanitized sourceText, and this particular
// paper's own repository reprints its title in front matter before any real
// prose begins. Running the real production pipeline (extractCandidatePhrases
// + live OpenAIRE) against the resulting 114-word span found that NONE of
// the generated queries discovered the target, while the one genuinely
// distinctive word available in that span ("infoxicated") found it
// immediately on its own — proving the production discovery pipeline was
// not at fault; the test fixture itself was not a realistic stand-in for "a
// user copied a few real sentences." The fix (skipRepeatedFrontMatter,
// compose.ts) uses the paper's own already-known title (data every caller
// already has, not a new heuristic) to skip past any such repeated front
// matter before taking the first few sentences.

const BANNER_AND_REPEATED_TITLE =
  "RepoVault Id rv 55112 Submitted 3 Jan 2026 https://example-repo.test/rv-55112 " +
  "RepoVault is a multi domain open access repository for the deposit and dissemination of scholarly works. " +
  "The works may come from academic institutions in many countries. " +
  "Distributed under an Open Access Attribution License version four. " +
  "Coral Reef Bleaching Dynamics Under Fluctuating Thermal Stress Priya Okonkwo " +
  "To cite this version Priya Okonkwo Coral Reef Bleaching Dynamics Under Fluctuating Thermal Stress " +
  "Marine Ecology Review 2026. " +
  "Abstract This review synthesizes recent findings on coral bleaching thresholds. " +
  "Sustained thermal anomalies of even one degree above seasonal maxima triggered measurable bleaching across every studied reef system. " +
  "Recovery rates varied considerably depending on the frequency of prior bleaching events at each site. " +
  "Symbiont density loss preceded visible bleaching by several days in the majority of monitored colonies. " +
  "Researchers observed that reef sites with historically variable thermal exposure showed somewhat greater resilience overall.";

const PLAIN_DOCUMENT =
  "Coral Reef Bleaching Dynamics Under Fluctuating Thermal Stress. " +
  "Abstract This review synthesizes recent findings on coral bleaching thresholds. " +
  "Sustained thermal anomalies of even one degree above seasonal maxima triggered measurable bleaching across every studied reef system. " +
  "Recovery rates varied considerably depending on the frequency of prior bleaching events at each site. " +
  "Symbiont density loss preceded visible bleaching by several days in the majority of monitored colonies. " +
  "Researchers observed that reef sites with historically variable thermal exposure showed somewhat greater resilience overall.";

const TITLE = "Coral Reef Bleaching Dynamics Under Fluctuating Thermal Stress";

test("REGRESSION (repository-banner fewSentences fixture defect, 2026-08-21): with the source paper's title supplied, 'fewSentences' skips past repeated repository front matter and copies real content", () => {
  const composed = composeCase({
    sourceText: BANNER_AND_REPEATED_TITLE,
    domain: "Social Sciences",
    condition: "fewSentences",
    targetTotalWords: 1000,
    fillerSeed: 0,
    sourceTitle: TITLE,
  });
  const copiedSpan = composed.text
    .split(/\s+/)
    .slice(composed.trueCopiedWordStart, composed.trueCopiedWordEnd + 1)
    .join(" ");

  assert.ok(!/repovault/i.test(copiedSpan), `expected no repository-banner text in the copied span; got: "${copiedSpan}"`);
  assert.ok(!/distributed under/i.test(copiedSpan), `expected no license boilerplate in the copied span; got: "${copiedSpan}"`);
  assert.ok(/bleaching/i.test(copiedSpan), `expected the copied span to contain the paper's own real content; got: "${copiedSpan}"`);
});

test("REGRESSION: without a sourceTitle, 'fewSentences' behavior is completely unchanged (safe, additive-only default)", () => {
  const withTitle = composeCase({
    sourceText: BANNER_AND_REPEATED_TITLE,
    domain: "Social Sciences",
    condition: "fewSentences",
    targetTotalWords: 1000,
    fillerSeed: 0,
  });
  const withoutTitleParam = composeCase({
    sourceText: BANNER_AND_REPEATED_TITLE,
    domain: "Social Sciences",
    condition: "fewSentences",
    targetTotalWords: 1000,
    fillerSeed: 0,
    sourceTitle: undefined,
  });
  assert.equal(withTitle.text, withoutTitleParam.text);
  // Omitting the title entirely falls back to the original, unskipped
  // behavior — the copied span is whatever the first 4 raw sentences are,
  // banner or not (this is exactly the pre-fix behavior, preserved as the
  // default when no title is available to a caller).
  const copiedSpan = withTitle.text
    .split(/\s+/)
    .slice(withTitle.trueCopiedWordStart, withTitle.trueCopiedWordEnd + 1)
    .join(" ");
  assert.ok(/repovault/i.test(copiedSpan));
});

test("REGRESSION: a document with NO repeated front matter (a plain paper that opens directly with its own title once) is completely unaffected by supplying sourceTitle", () => {
  const withTitle = composeCase({
    sourceText: PLAIN_DOCUMENT,
    domain: "Social Sciences",
    condition: "fewSentences",
    targetTotalWords: 1000,
    fillerSeed: 0,
    sourceTitle: TITLE,
  });
  const withoutTitle = composeCase({
    sourceText: PLAIN_DOCUMENT,
    domain: "Social Sciences",
    condition: "fewSentences",
    targetTotalWords: 1000,
    fillerSeed: 0,
  });
  assert.equal(withTitle.text, withoutTitle.text, "a single, unrepeated title mention must never be skipped");
});

test("REGRESSION: every other copy condition ('exact', 'ten', 'twentyfive', 'fifty', 'original') is completely unaffected by sourceTitle", () => {
  for (const condition of ["exact", "ten", "twentyfive", "fifty", "original"]) {
    const withTitle = composeCase({
      sourceText: BANNER_AND_REPEATED_TITLE,
      domain: "Social Sciences",
      condition,
      targetTotalWords: 1000,
      fillerSeed: 0,
      sourceTitle: TITLE,
    });
    const withoutTitle = composeCase({
      sourceText: BANNER_AND_REPEATED_TITLE,
      domain: "Social Sciences",
      condition,
      targetTotalWords: 1000,
      fillerSeed: 0,
    });
    assert.deepEqual(withTitle, withoutTitle, `condition "${condition}" must be byte-for-byte unaffected by sourceTitle`);
  }
});
