import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("AI report download renders a static copy of the complete preview", async () => {
  const shell = await readFile(new URL("../app/reports/[id]/report-detail-shell.tsx", import.meta.url), "utf8");
  const aiReport = await readFile(new URL("../components/report/ai-report.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  // The print copy renders the SAME already-resolved AI signal as the
  // on-screen copy (signal={aiSignal}) — see lib/ai-display-state.ts — so
  // the downloadable report can never show a different AI headline from the
  // page it was generated from.
  assert.match(shell, /<AiReport report=\{report\} signal=\{aiSignal\} printMode \/>/);
  assert.match(shell, /<AiReport report=\{report\} signal=\{aiSignal\} \/>/);
  assert.match(aiReport, /animated=\{!printMode\}/);
  assert.doesNotMatch(shell, /className="print-report-bundle" aria-hidden="true"/);
  assert.match(css, /\.print-report-bundle \.ai-report-print/);
  assert.match(css, /\.print-report-bundle \.report-paper \{[\s\S]*?overflow: visible;/);
  assert.match(css, /\.print-report-bundle \.ai-passage-list article,[\s\S]*?break-inside: avoid;/);
});
