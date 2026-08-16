import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("product branding presents AI detection and scoped archive overlap clearly", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  // The AI report paper (and its "ENGLISH AI WRITING ANALYSIS"/"AI writing
  // score" copy) moved to components/report/ai-report.tsx when saved reports
  // became a routable page — see app/reports/[id].
  const aiReport = await readFile(new URL("../components/report/ai-report.tsx", import.meta.url), "utf8");

  assert.match(page, /AI & similarity detection/);
  assert.match(page, /Check AI writing and similarity/);
  // Phase 7 PRIORITY 2: this paragraph was updated to also describe live
  // academic sources (lib/academic-search/'s OpenAIRE + Europe PMC) rather
  // than implying the archive is the only thing checked, without removing
  // the archive-overlap disclosure itself.
  assert.match(page, /TurnitPlus checks AI-writing signals and measures similarity against its indexed archive/);
  assert.match(aiReport, /ENGLISH AI WRITING ANALYSIS/);
  assert.match(aiReport, /AI writing score/);
  assert.doesNotMatch(page, /EXPERIMENTAL ENGLISH AI WRITING SIGNAL/);
  assert.doesNotMatch(page, /screening estimate, not proof of authorship/);
  assert.match(layout, /TurnitPlus - AI & Similarity Detection/);
  assert.doesNotMatch(page, /the best AI|best plagiarism|guaranteed detection/i);
});

test("privacy and retention rules match the browser-local product", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /Privacy & retention/);
  assert.match(page, /up to 20 selected phrases may be sent to the English Wikipedia search service/);
  assert.match(page, /IndexedDB on this device/);
  assert.match(page, /A salted, irreversible hash is stored; the password itself is never stored or logged/);
  assert.match(page, /Clear history/);
  assert.match(page, /The interface displays up to 50 recent reports/);
  assert.match(page, /Documents checked in the browser are not added to a TurnitPlus training database/);
});

test("privacy copy discloses remote report storage and the device-key soft-scoping mechanism", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /Report identification \(no account required\)/);
  assert.match(page, /is not a username or password and is not authentication/);
  assert.match(page, /it behaves like an unlisted link/);
  assert.match(page, /saved both on this device \(IndexedDB\) and to TurnitPlus's database/);
  assert.match(page, /Clear history removes both copies/);
  assert.match(page, /Use Clear history to remove saved reports from both this browser and TurnitPlus's database/);
});

test("privacy copy accurately describes real account authentication (Phase 2A)", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /Your password itself is never stored — only a one-way cryptographic hash used to verify future sign-ins/);
  assert.match(page, /Signing in issues a session, held in a browser cookie/);
  assert.match(page, /TurnitPlus's account database/);
  assert.match(page, /When you sign out, or automatically after 30 days/);
  assert.doesNotMatch(page, /The current account experience is device-local/);
  assert.doesNotMatch(page, /Password values are not stored by TurnitPlus/);
});

test("terms cover responsible use and the subscription preview", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /Terms of use/);
  assert.match(page, /Automated results should not be the sole basis for academic discipline/);
  assert.match(page, /The displayed \$20 monthly Unlimited plan is a coming-soon preview/);
  assert.match(page, /no guarantee is made that every source, AI-written passage or similarity will be detected/);
  assert.match(page, /A dedicated privacy contact and legal operator details will be published before public commercial billing begins/);
});
