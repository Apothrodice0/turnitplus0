import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The ONE fixed, server-only, build-time-materialized path for a hosted
 * imported-similarity-evidence package
 * (scripts/materialize-imported-similarity-evidence.mjs writes here;
 * ./config.ts's importedSimilarityEvidencePackagePath() falls back to
 * reading from here — see that file's own header comment for the exact
 * precedence order).
 *
 * Deliberately NOT under `public/` (never a static asset), never imported by
 * client code, and gitignored (`/.turnitplus/` in .gitignore) so a locally
 * materialized copy can never be accidentally staged.
 *
 * Resolved relative to THIS file's own location (not `process.cwd()`, which
 * can vary by invocation context) — the same repo-root convention this
 * codebase's own test fixtures already use (see
 * tests/helpers/large-report-retry-fixture.mjs's REPO_ROOT).
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const IMPORTED_SIMILARITY_EVIDENCE_MATERIALIZED_PACKAGE_RELATIVE_PATH =
  ".turnitplus/imported-similarity-evidence/package.json";

export const IMPORTED_SIMILARITY_EVIDENCE_MATERIALIZED_PACKAGE_PATH = resolve(
  REPO_ROOT,
  IMPORTED_SIMILARITY_EVIDENCE_MATERIALIZED_PACKAGE_RELATIVE_PATH,
);
