import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("AI passage cards keep signal metadata separate from passage text", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(css, /\.ai-passage-list \{[\s\S]*?gap: 20px;/);
  assert.match(css, /\.ai-passage-list article \{[\s\S]*?grid-template-columns: 96px minmax\(0, 1fr\);/);
  assert.match(css, /\.ai-passage-list article > div small \{[\s\S]*?white-space: normal;/);
  assert.match(css, /\.ai-passage-list article > p \{[\s\S]*?padding: 19px 21px;[\s\S]*?line-height: 1\.8;/);
});
