/**
 * WEBSITE PROCESSING WORDING: extracted text goes to TurnitPlus's servers, and selected phrases and subscriber
 * analysis go further, so the site must not say documents stay in the browser or are never uploaded.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const FALSE_CLAIMS = [/never uploaded/i, /No cloud upload/i, /Reports stay on this device/i, /Keep documents local/i, /stays? in(side)? (your|this) browser/i, /(analyzed|processed) in(side)? your browser/i, /No document is uploaded/i];

test("no page repeats a claim that documents stay in the browser", async () => {
  for (const file of ["app/page.tsx", "components/reports/document-upload-panel.tsx"]) {
    const source = await readFile(file, "utf8");
    for (const claim of FALSE_CLAIMS) assert.ok(!claim.test(source), `${file}: ${claim}`);
  }
});

test("the privacy section names what is sent and where", async () => {
  const source = await readFile("app/page.tsx", "utf8");
  assert.match(source, /the extracted text is sent to TurnitPlus's servers/);
  assert.match(source, /private model service/);
  assert.match(source, /public scholarly search services and to English Wikipedia/);
});
