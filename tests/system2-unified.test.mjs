import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * PROVISIONAL unified similarity (owner decision 2026-10-29): final = max(System 1, conservative System 2), owner-only.
 * System 2 counts only when its estimate is usable; otherwise System 1 stands. Never a sum.
 */
const U = await import("../lib/system2-unified.ts");
const shown = (p, state = "CONSERVATIVE_WITHIN_RANGE") => ({ state, estimate_shown: true, conservative_estimate_percent: p, final_text: "x" });

test("max rule: System 2 raises the one percentage only when higher, and the difference is marked", () => {
  assert.deepEqual(U.unifySimilarity(3, shown(8)), { percent: 8, system1Percent: 3, system2Percent: 8, includesStatisticalEstimate: true });
  assert.deepEqual(U.unifySimilarity(12, shown(8)), { percent: 12, system1Percent: 12, system2Percent: 8, includesStatisticalEstimate: false });
  assert.deepEqual(U.unifySimilarity(8, shown(8)), { percent: 8, system1Percent: 8, system2Percent: 8, includesStatisticalEstimate: false }, "a tie is System 1's verified result");
  assert.equal(U.unifySimilarity(64, shown(20)).percent, 64, "a high verified result is never lowered");
  for (const [s1, s2] of [[0, 0], [0, 20], [5, 7], [19, 20], [20, 3], [100, 20]]) {
    const u = U.unifySimilarity(s1, shown(s2));
    assert.equal(u.percent, Math.max(s1, s2));
    if (s1 > 0 && s2 > 0) assert.notEqual(u.percent, s1 + s2, "never the sum");
  }
});

test("fallback: unsupported, unauthorized, failed or invalid System 2 output keeps System 1 unchanged", () => {
  const cases = [
    null, undefined,
    { state: "UNSUPPORTED_FILE_TYPE", estimate_shown: false, final_text: "not sent" },
    { state: "REFUSED_PDF", estimate_shown: false, final_text: "pdf" },
    { state: "UNAVAILABLE", estimate_shown: false, final_text: "service down" },
    { state: "NOT_ENGLISH", estimate_shown: false, final_text: "language", conservative_estimate_percent: 15 },
    shown(21), shown(-1), shown(7.5), { state: "X", estimate_shown: true, final_text: "x" },
    { state: "X", estimate_shown: "true", final_text: "x", conservative_estimate_percent: 9 },
  ];
  for (const c of cases) {
    const u = U.unifySimilarity(4, c);
    assert.deepEqual(u, { percent: 4, system1Percent: 4, system2Percent: null, includesStatisticalEstimate: false }, JSON.stringify(c));
  }
});

test("display text: System 1's <1% rule when System 1 stands; plain unified % when the estimate raised it", () => {
  assert.equal(U.unifiedPercentText(U.unifySimilarity(0, null), 12), "<1%");
  assert.equal(U.unifiedPercentText(U.unifySimilarity(0, shown(6)), 12), "6%");
  assert.equal(U.unifiedPercentText(U.unifySimilarity(9, shown(6)), 120), "9%");
  // owner decision 2026-10-30: one clean percentage, no extra label or note anywhere
  assert.equal("UNIFIED_ESTIMATE_NOTE" in U, false);
});

test("synthetic fixture: the accepted local-v2 expectation (length_301.docx = 8%) combines by the max rule", () => {
  // Owner parity fixture: local-s2-test/v2 returns a conservative 8% for length_301.docx (checked end to end by
  // tests/system2-research-parity.test.mjs against the real frozen model when the private paths are configured).
  const fixture = shown(8);
  assert.equal(U.unifySimilarity(0, fixture).percent, 8);
  assert.equal(U.unifySimilarity(5, fixture).percent, 8);
  assert.equal(U.unifySimilarity(23, fixture).percent, 23);
});

test("the unified helper is pure display logic: no network, storage or server configuration", async () => {
  const src = await readFile(new URL("../lib/system2-unified.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /fetch\(|localStorage|process\.env|import .*system2-research/);
  assert.match(src, /PROVISIONAL/);
});
