/**
 * What the site tells a paying customer must match what the product does. Each statement here was false at some point
 * while the product moved from a free browser tool to manually activated subscriptions.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the legal pages do not describe the old free product", async () => {
  const page = await read("app/page.tsx");
  assert.doesNotMatch(page, /Paid subscriptions, server accounts and email verification are not active/);
  assert.doesNotMatch(page, /independent university project/);
  assert.doesNotMatch(page, /self-service account deletion is not yet available/);
  assert.doesNotMatch(page, /does not require creating an account/);
  assert.doesNotMatch(page, /linked to this browser's random identifier, not your identity/);
  assert.doesNotMatch(page, /stays available on this device/);
});

test("retention says what happens when a subscription ends", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /When a subscription expires, its reports, and the records made for those reports, are deleted from TurnitPlus's database/);
  assert.match(page, /Text already accepted into TurnitPlus's comparison collection is kept separately/);
  assert.match(page, /A suspended subscription's reports are kept, but cannot be opened until it is restored/);
  assert.match(page, /Reports are deleted when a subscription expires, so keep copies/);
});

test("the comparison collection is disclosed, including that deletion does not remove accepted text", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /may be added to TurnitPlus's comparison collection/);
  assert.match(page, /after 7 days it can be matched against other customers' documents/);
  assert.match(page, /does not remove text already accepted into the collection/);
});

test("the site no longer says every result is direct evidence: estimates and predictions are named as such", async () => {
  const page = await read("app/page.tsx");
  assert.doesNotMatch(page, /reports only the text it can show you direct evidence for/);
  assert.doesNotMatch(page, /is not an estimate of any other provider/);
  assert.match(page, /a statistical estimate of likely similarity, which has no passages behind it/);
  assert.match(page, /Passages with a dashed underline are model predictions, not verified matches/);
});

test("a customer told to contact TurnitPlus can see how, and no address is written into this public repository", async () => {
  const contact = await read("lib/contact.ts");
  assert.match(contact, /process\.env\.NEXT_PUBLIC_TURNITPLUS_CONTACT_EMAIL/);
  for (const file of ["components/reports/subscription-required-state.tsx", "components/reports/document-upload-panel.tsx", "app/page.tsx"]) {
    assert.match(await read(file), /<ContactLink \/>/, file);
  }
  assert.doesNotMatch(await read("components/reports/contact-link.tsx"), /@[a-z0-9-]+\.[a-z]{2,}/i);
});
