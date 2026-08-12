import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("account information can be edited through the real account API", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /Edit information/);
  assert.match(page, /name="profileUsername"/);
  assert.match(page, /name="profileEmail"/);
  assert.match(page, /async function submitProfileEdit/);
  assert.match(page, /fetch\("\/api\/auth\/me", \{[\s\S]*?method: "PATCH"/);
  assert.match(page, /setAccount\(result\.user as LocalAccount\)/);
  assert.doesNotMatch(page, /sessionStorage\.setItem\("tp_active_account_v1"/);
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
