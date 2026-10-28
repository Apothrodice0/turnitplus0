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

// Owner decision 2026-10-24 (manual account activation): the "TurnitPlus Unlimited — $20/month, coming soon" preview
// is obsolete and replaced by a plain manual activation / renewal message — no price, no payment, no contact details.
test("the account page explains manual activation and renewal, with no price or payment", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(page, /TurnitPlus Unlimited/);
  assert.doesNotMatch(page, /\$\d/);
  assert.doesNotMatch(page, /Notify me at launch/);
  assert.doesNotMatch(page, /COMING SOON/);
  assert.match(page, /Activate or renew your plan/);
  assert.match(page, /TurnitPlus plans are activated manually by the TurnitPlus team\./);
  assert.match(page, /There is no online payment on this site\./);
  assert.doesNotMatch(page, /mailto:|tel:|wa\.me|whatsapp\.com|facebook\.com/i, "no invented contact details");
});
