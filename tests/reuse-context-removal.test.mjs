import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OverviewReport } from "../components/report/similarity-report-papers.tsx";

/**
 * Structural regression guard for the REMOVED ordinary-user reuse-context
 * declaration / confirmation workflow (cancelled product direction, 2026-09).
 *
 * Ordinary users must never again be able to declare / confirm / reject /
 * revoke / withdraw a reuse relationship, or see "authorized reuse" /
 * SELF / same-owner reasoning. They receive only the normal machine-derived
 * similarity percentage.
 *
 * The historical migration drizzle/0022_reuse_context_declarations.sql and
 * its dormant table are DELIBERATELY retained (migration history is
 * immutable) — this file asserts they stay, so a future "cleanup" cannot
 * silently break the migration runner.
 */

const repo = path.resolve(".");

/** Every tracked-ish source file under the given roots. */
function sourceFiles(roots) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") continue;
        walk(full);
      } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  for (const root of roots) walk(path.join(repo, root));
  return out;
}

const RUNTIME_ROOTS = ["app", "components", "lib"];
const runtimeFiles = sourceFiles(RUNTIME_ROOTS);

// ---------------------------------------------------------------------------
// 1. no reuse-context route directory / component directory / lib modules
// ---------------------------------------------------------------------------

test("no app/api/reuse-context route directory remains", () => {
  assert.equal(fs.existsSync(path.join(repo, "app/api/reuse-context")), false);
});

test("no components/reuse-context directory remains", () => {
  assert.equal(fs.existsSync(path.join(repo, "components/reuse-context")), false);
});

test("every removed reuse-context / e8s lib module is gone", () => {
  for (const rel of [
    "lib/reuse-context-declarations.ts",
    "lib/reuse-context-report-binding.ts",
    "lib/reuse-context-types.ts",
    "lib/reuse-context-action-ref.ts",
    "lib/reuse-context-mutation-guard.ts",
    "lib/reuse-context-labels.ts",
    "lib/e8s-match-pair-resolution.ts",
    "lib/e8s-visibility.ts",
  ]) {
    assert.equal(fs.existsSync(path.join(repo, rel)), false, `${rel} must be deleted`);
  }
});

// ---------------------------------------------------------------------------
// 2. no runtime import of any reuse-context-* / e8s-visibility / e8s-match-pair
// ---------------------------------------------------------------------------

test("no runtime source imports a removed reuse-context / e8s module", () => {
  const importRe = /(?:import[\s\S]*?from\s*|require\(\s*)["'][^"']*(?:reuse-context|e8s-visibility|e8s-match-pair-resolution)[^"']*["']/;
  const offenders = runtimeFiles.filter((f) => importRe.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(offenders.map((f) => path.relative(repo, f)), []);
});

test("no runtime source references removed reuse-context symbols / the removed env var", () => {
  const forbidden = [
    "isE8sReuseContextAllowlisted",
    "E8S_REUSE_CONTEXT_ALLOWLIST",
    "buildReuseContextEnvelope",
    "resolveCallerOwnedReportBinding",
    "reuseContextSessionKey",
    "fetchReportReuseContext",
    "ReuseContextContainer",
    "ReuseContextEnvelope",
    "declareReuseContext",
  ];
  const offenders = [];
  for (const f of runtimeFiles) {
    const src = fs.readFileSync(f, "utf8");
    for (const token of forbidden) {
      if (src.includes(token)) offenders.push(`${path.relative(repo, f)} :: ${token}`);
    }
  }
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------------------
// 3. report GET envelope no longer carries reuseContext
// ---------------------------------------------------------------------------

test("GET /api/reports/[id] returns only { payload } — no reuseContext sibling", () => {
  const route = fs.readFileSync(path.join(repo, "app/api/reports/[id]/route.ts"), "utf8");
  assert.match(route, /JSON\.stringify\(\{\s*payload\s*\}\)/, "the 200 response must serialize exactly { payload }");
  assert.doesNotMatch(route, /reuseContext/i, "the report route must not mention reuseContext anywhere");
});

test("POST /api/reports has no reuse-context-specific payload scrub", () => {
  const route = fs.readFileSync(path.join(repo, "app/api/reports/route.ts"), "utf8");
  assert.doesNotMatch(route, /reuseContext/i);
});

// ---------------------------------------------------------------------------
// 4. ordinary report UI has no declaration / confirmation CTA
// ---------------------------------------------------------------------------

test("OverviewReport renders no reuse declaration / confirmation / authorized-reuse CTA", () => {
  const report = {
    version: 11,
    id: 1,
    submissionId: "sub-rc-removal",
    title: "fixture.pdf",
    author: "",
    assignment: "",
    created: new Date().toISOString(),
    score: 14,
    archiveScore: 14,
    scoreBand: "Low",
    wordCount: 100,
    text: "x ".repeat(100).trim(),
    sources: [],
    repeats: [],
    matchedWordCount: 14,
    archiveMatchedWordCount: 14,
    excludedDocuments: 0,
    highlights: [],
    unifiedSimilarity: {
      unifiedScorePercent: 14,
      uniqueMatchedWords: 14,
      wordCount: 100,
      archiveOnlyWords: 14,
      liveAcademicOnlyWords: 0,
      previousUploadOnlyWords: 0,
      overlapWords: 0,
      contributions: [],
    },
    historicalSubmissionMatch: {
      status: "MATCHED",
      matches: [
        {
          relationshipType: "PRIOR_SUBMISSION",
          matchedRepresentationId: "rep-x",
          matchType: "EXACT_CANONICAL_MATCH",
          containment: 1,
          matchedWordCount: 100,
          passageCount: 1,
          longestMatchWords: 100,
          passages: [],
          historicalSubmissionCount: 0,
        },
      ],
      computedAt: "t",
      matcherVersion: "t",
      fingerprintVersion: "t",
      canonicalizationVersion: "t",
    },
    viewerIsAdmin: false,
  };

  const html = renderToStaticMarkup(React.createElement(OverviewReport, { report, similarityStatus: "resolved" }));

  for (const phrase of [
    "Add context",
    "reuse context",
    "reuse-context",
    "authorized reuse",
    "Authorized reuse",
    "original submitter",
    "Confirm this",
    "same owner",
    "declare",
  ]) {
    assert.ok(!html.toLowerCase().includes(phrase.toLowerCase()), `ordinary report UI must not contain "${phrase}"`);
  }
});

// ---------------------------------------------------------------------------
// 5. dormant DB artifact is RETAINED (do not let a future cleanup drop it)
// ---------------------------------------------------------------------------

test("drizzle/0022 migration + dormant schema table are retained", () => {
  assert.ok(
    fs.existsSync(path.join(repo, "drizzle/0022_reuse_context_declarations.sql")),
    "historical migration 0022 must NOT be deleted (migration history is immutable)",
  );
  const schema = fs.readFileSync(path.join(repo, "db/schema.ts"), "utf8");
  assert.match(schema, /reuse_context_declarations/, "the dormant drizzle table definition must be retained");
  const runner = fs.readFileSync(path.join(repo, "lib/e8-tables-migration-runner.ts"), "utf8");
  assert.match(runner, /0022_reuse_context_declarations\.sql/, "the migration runner must still know migration 0022");
});
