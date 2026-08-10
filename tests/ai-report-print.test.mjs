import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("AI report download renders a static copy of the complete preview", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(page, /<AiReport report=\{currentReport\} printMode \/>/);
  assert.match(page, /animated=\{!printMode\}/);
  assert.doesNotMatch(page, /className="print-report-bundle" aria-hidden="true"/);
  assert.match(css, /\.print-report-bundle \.ai-report-print/);
  assert.match(css, /\.print-report-bundle \.report-paper \{[\s\S]*?overflow: visible;/);
  assert.match(css, /\.print-report-bundle \.ai-passage-list article,[\s\S]*?break-inside: avoid;/);
});
