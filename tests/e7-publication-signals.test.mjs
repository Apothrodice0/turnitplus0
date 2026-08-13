import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { extractPublicationSignals } from "../lib/e7-publication-signals.ts";

const repoRoot = path.resolve(".");

test("lib/e7-publication-signals.ts performs no I/O — pure text analysis only", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/e7-publication-signals.ts"), "utf8");
  const imports = source.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join("\n");
  assert.doesNotMatch(imports, /node:fs|node:http|@libsql\/client/, "signal extraction must stay a pure function over already-loaded text");
});

test("extracts a labelled ISSN and classifies STRONG", () => {
  const text = "SY Journal of Sport Science Technology ISSN: 1112-4032 Some article body follows here.";
  const result = extractPublicationSignals(text);
  assert.deepEqual(result.issns, ["1112-4032"]);
  assert.equal(result.strength, "STRONG");
});

test("extracts a DOI and classifies STRONG", () => {
  const text = "This article is available at https://doi.org/10.1234/example.2024.001 for reference.";
  const result = extractPublicationSignals(text);
  assert.deepEqual(result.dois, ["10.1234/example.2024.001"]);
  assert.equal(result.strength, "STRONG");
});

test("bare ISSN-shaped digits without a label are WEAK, not STRONG", () => {
  const text = "A reference list entry mentions 1112-4032 without the word ISSN nearby, plus no journal name.";
  const result = extractPublicationSignals(text);
  assert.deepEqual(result.issns, []);
  assert.deepEqual(result.bareIssnShapedHits, ["1112-4032"]);
  assert.equal(result.strength, "WEAK");
});

test("a journal-name-shaped masthead phrase alone is WEAK", () => {
  const text = "Published in the International Journal of Banking Studies, this paper explores customer satisfaction.";
  const result = extractPublicationSignals(text);
  assert.ok(result.journalNameHints.length > 0, `expected a journal name hint, got: ${JSON.stringify(result.journalNameHints)}`);
  assert.equal(result.strength, "WEAK");
});

test("plain thesis-style text with none of these markers is NONE", () => {
  const text = "Arbitration in Algerian Labor Law under the Labor Disputes Act No. 23-08. Dr. Ali Latrech. Workers and employers in public and private sectors experience times when their labor relations break down.";
  const result = extractPublicationSignals(text);
  assert.deepEqual(result.issns, []);
  assert.deepEqual(result.dois, []);
  assert.equal(result.asjpMentioned, false);
  assert.equal(result.strength, "NONE");
});

test("detects an explicit ASJP/CERIST mention", () => {
  const text = "This journal is hosted on the ASJP platform at asjp.cerist.dz for open access.";
  const result = extractPublicationSignals(text);
  assert.equal(result.asjpMentioned, true);
});

test("hints are bounded in length and count — never returns large excerpts of the source text", () => {
  const longJournalName = "The " + "Extremely ".repeat(20) + "Long Journal of Something Very Verbose";
  const text = `Text before. ${longJournalName} Text after.`;
  const result = extractPublicationSignals(text);
  for (const hint of result.journalNameHints) assert.ok(hint.length <= 71, `hint too long: ${hint.length} chars`);
  assert.ok(result.issns.length <= 5 && result.dois.length <= 5 && result.journalNameHints.length <= 5, "all hint arrays must be bounded");
});

test("real sample: a known archive document with an embedded ISSN correctly extracts it (synthetic reproduction of the real front-matter shape, not real archive content)", () => {
  const text = "A Comparative Study of Some Physical Attributes of Football Players by Salaheddine Abdelaziz Sy Journal snot SY Journal of Sport Science Technolo; Va J) ISSN: 1112-4032 Powe ode A Comparative Study of Certain Physical Attributes";
  const result = extractPublicationSignals(text);
  assert.ok(result.issns.includes("1112-4032"));
  assert.equal(result.strength, "STRONG");
});
