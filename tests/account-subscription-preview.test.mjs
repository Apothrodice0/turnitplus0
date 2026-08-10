import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("account information can be edited for the active browser session", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /Edit information/);
  assert.match(page, /name="profileUsername"/);
  assert.match(page, /name="profileEmail"/);
  assert.match(page, /function submitProfileEdit/);
  assert.match(page, /sessionStorage\.setItem\("tp_active_account_v1", JSON\.stringify\(nextAccount\)\)/);
  assert.match(page, /Save changes/);
});

test("the unlimited plan is an honest non-payment preview", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /TurnitPlus Unlimited/);
  assert.match(page, /Unlimited similarity checks/);
  assert.match(page, /Unlimited AI writing reports/);
  assert.match(page, /<strong>\$20<\/strong><span>\/ month<\/span>/);
  assert.match(page, /COMING SOON/);
  assert.match(page, /Plan preview only · no payment will be collected\./);
  assert.match(page, /No payment was taken\./);
});
