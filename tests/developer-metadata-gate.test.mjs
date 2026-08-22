import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Source-text wiring test, matching the convention used by
// tests/report-detail-route.test.mjs and tests/room-detail-route.test.mjs
// for the sibling Server Components that also can't be executed directly
// outside a real Next.js request scope (generateMetadata/the page body both
// call next/headers' cookies() via lib/developer-gate.ts's loadDeveloperGate).
//
// Production audit fix: every app/developer/* generateMetadata() used to
// return a page-identifying title unconditionally, with no admin check at
// all — even though the page body correctly notFound()s a non-admin. Next
// resolves <head> metadata independently of the body's notFound(), so a
// non-admin's browser tab still confirmed this route's existence via its
// title alone. Every generateMetadata() here must now gate on the exact
// same lib/developer-gate.ts loadDeveloperGate() the page body uses, and
// return {} (never the real title) when it resolves null.

const developerPages = [
  { file: "../app/developer/page.tsx", title: "Developer · TurnitPlus" },
  { file: "../app/developer/lookup/page.tsx", title: "Article lookup · Developer · TurnitPlus" },
  { file: "../app/developer/reports/[id]/page.tsx", title: "Report inspection · Developer · TurnitPlus" },
];

for (const { file, title } of developerPages) {
  test(`${file}: generateMetadata is gated behind loadDeveloperGate and never leaks its real title to a non-admin`, async () => {
    const source = await readFile(new URL(file, import.meta.url), "utf8");

    assert.match(source, /import \{ loadDeveloperGate \} from "@\/lib\/developer-gate";/);

    const metaMatch = source.match(/export async function generateMetadata\([\s\S]*?\n\}/);
    assert.ok(metaMatch, "generateMetadata must be found");
    const meta = metaMatch[0];

    assert.match(meta, /const admin = await loadDeveloperGate\(\);/, "generateMetadata must call the shared gate, not skip authorization entirely");
    assert.match(meta, /if \(!admin\) return \{\};/, "a non-admin must get an empty metadata object (falls back to the root layout's generic title), never the real one");

    // The real title must appear strictly AFTER the gate check, never
    // reachable before it.
    const gateIndex = meta.indexOf("if (!admin) return {};");
    const titleIndex = meta.indexOf(JSON.stringify(title).slice(1, -1));
    assert.ok(gateIndex > -1 && titleIndex > -1, "both the gate check and the real title must be present");
    assert.ok(gateIndex < titleIndex, "the gate check must come before the real title is ever returned");

    // The page body must use the exact same gate (not a separately
    // duplicated cookie/DB check that could drift out of sync with it).
    const bodyMatch = source.match(/export default async function \w+\([\s\S]*$/);
    assert.ok(bodyMatch, "the default export page component must be found");
    assert.match(bodyMatch[0], /const admin = await loadDeveloperGate\(\);/);
    assert.match(bodyMatch[0], /if \(!admin\) notFound\(\);/);
  });
}

test("lib/developer-gate.ts: the shared gate is cache()-wrapped (one DB lookup per request, not one per caller) and resolves null for no/invalid session", async () => {
  const source = await readFile(new URL("../lib/developer-gate.ts", import.meta.url), "utf8");
  assert.match(source, /import \{ cache \} from "react";/);
  assert.match(source, /export const loadDeveloperGate = cache\(async \(\): Promise<SessionUser \| null> => \{/);
  assert.match(source, /if \(!token\) return null;/);
  assert.match(source, /return await getAdminSessionUserByToken\(token, client\);/);
});
