import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("signed-out visitors enter through the account screen", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /useState<View>\("account"\)/);
  assert.match(page, /if \(!account && requestedView !== "account" && requestedView !== "legal"\)/);
  assert.match(page, /if \(accountLoaded && !hasActiveAccount && nextView !== "account" && nextView !== "legal"\)/);
  assert.match(page, /Log in or create your account/);
  assert.match(page, /\{account && <>[\s\S]*?Dashboard[\s\S]*?My reports[\s\S]*?How it works/);
});
