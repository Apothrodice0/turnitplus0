import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

/**
 * Phase B1 — the CONTAINMENT TRIPWIRE.
 *
 * `hypotheticalExcludedRepresentationIds` is the SHADOW-ONLY parameter that
 * removes a representation's matched words from the scored union. It must be
 * impossible for it to enter the authoritative similarity-scoring path. This
 * test proves, structurally, that the token appears in production source ONLY
 * in the two modules that legitimately implement the shadow counterfactual —
 * the engine parameter itself and the pure helper that drives it.
 *
 * B2 may later deliberately widen this allowlist to include the DEFERRED
 * shadow evaluator (the runAfterResponse telemetry writer) — but NEVER the
 * authoritative resolver (lib/report-primary-similarity.ts), the report
 * routes, the shared shadow scheduler, or any report persistence / payload
 * code. If B2 needs a new entry, it edits ALLOWED_FILES here with a comment
 * saying why, and the FORBIDDEN_FILES list below must never lose an entry.
 */

const TOKEN = "hypotheticalExcludedRepresentationIds";

// The ONLY production files permitted to name the token.
const ALLOWED_FILES = new Set([
  "lib/unified-similarity.ts", // defines the inert optional parameter
  "lib/corpus-duplicate-counterfactual.ts", // the pure shadow helper that passes it
]);

// Files that must NEVER contain it — the authoritative scoring path, the
// routes, the shared shadow scheduler, and report persistence / payload code.
const FORBIDDEN_FILES = [
  "lib/report-primary-similarity.ts",
  "app/api/reports/route.ts",
  "app/api/reports/[id]/route.ts",
  "lib/report-shadow-evaluations.ts",
  "lib/reports-repo.ts",
  "lib/report-types.ts",
  "app/reports/[id]/page.tsx",
  "app/reports/[id]/report-detail-shell.tsx",
  "lib/document-check-pipeline.ts",
  "lib/corpus-duplicate-suppression-policy.ts", // the policy is pure evidence only — it never touches the engine parameter
];

const repoRoot = path.resolve(".");
const SOURCE_ROOTS = ["lib", "app"];
const SOURCE_EXT = new Set([".ts", ".tsx"]);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (SOURCE_EXT.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

test("CONTAINMENT: the token appears in production source ONLY in the two allowlisted shadow modules", () => {
  const offenders = [];
  const seenAllowed = new Set();
  for (const root of SOURCE_ROOTS) {
    for (const file of walk(path.join(repoRoot, root))) {
      if (!fs.readFileSync(file, "utf8").includes(TOKEN)) continue;
      const rel = path.relative(repoRoot, file).split(path.sep).join("/");
      if (ALLOWED_FILES.has(rel)) seenAllowed.add(rel);
      else offenders.push(rel);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `${TOKEN} leaked into production source outside the shadow allowlist: ${offenders.join(", ")}`,
  );
  // Both allowlisted files must actually still use it — a stale allowlist is
  // its own kind of drift.
  assert.deepEqual([...seenAllowed].sort(), [...ALLOWED_FILES].sort());
});

test("CONTAINMENT: the token is absent from the authoritative resolver, the routes, the shadow scheduler, and report persistence/payload code", () => {
  const offenders = [];
  for (const rel of FORBIDDEN_FILES) {
    const full = path.join(repoRoot, rel);
    assert.ok(fs.existsSync(full), `expected ${rel} to exist — the forbidden-file list itself may be stale`);
    if (fs.readFileSync(full, "utf8").includes(TOKEN)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `${TOKEN} must never appear in these authoritative-path files: ${offenders.join(", ")}`,
  );
});

test("CONTAINMENT: resolvePrimarySimilaritySummary's own computeUnifiedSimilarity call site passes no hypothetical exclusion", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/report-primary-similarity.ts"), "utf8");
  // The authoritative call in resolvePrimarySimilaritySummary passes exactly
  // these keys — assert the surrounding block never mentions the shadow token.
  const callIndex = source.indexOf("compute({");
  assert.ok(callIndex > -1, "expected the authoritative compute({ ... }) call to still be present");
  const block = source.slice(callIndex, source.indexOf("});", callIndex) + 3);
  assert.doesNotMatch(block, /hypothetical/i, "the authoritative compute() call must pass nothing shadow-related");
  assert.match(block, /effectiveDeviceSelfRepresentationIds/, "sanity: this is the real authoritative call block");
});
