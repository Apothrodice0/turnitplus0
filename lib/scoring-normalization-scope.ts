import { AsyncLocalStorage } from "node:async_hooks";
import type { ScoringNormalizationVersion } from "./similarity-core";

/**
 * The scoring-normalization contract of the server computation in progress.
 *
 * lib/similarity-core.ts's normalize() — and therefore every matcher,
 * tokenizer and position mapper built on it — runs under the contract of the
 * enclosing runWithScoringNormalization call. That is what lets ONE matcher
 * implementation compute natively under either contract: a v1 report is
 * re-resolved under v1 and a v2 report under v2 by the very same code, with no
 * second implementation and no translation of one position space into the
 * other.
 *
 * SERVER ONLY. A browser (and its workers) never has a scope: it computes
 * under the ACTIVE_SCORING_NORMALIZATION_VERSION of the bundle it loaded, and
 * renders a saved report by passing that report's own contract explicitly
 * (tokenSpans(text, version), …). This module must never be imported from
 * client code — node:async_hooks does not exist there.
 *
 * Scopes are deliberately NARROW — one around each computation that produces
 * or reads a report's positions:
 *   - getOrComputeHistoricalMatchSnapshot / resolvePrimarySimilaritySummary
 *     (prior-submission, imported evidence, the unified union);
 *   - POST /api/reports' supplied-reference verification and interpretation;
 *   - POST /api/academic-evidence and POST /api/archive/match (the contract
 *     the request declared);
 *   - the deferred shadow evaluations / Selective Corpus finalizer.
 * Work that is not about one report's positions — corpus admission, identity
 * and family fingerprints, index builds — runs outside any scope, under the
 * build's active contract.
 *
 * The store is published on globalThis under a registered symbol, and
 * similarity-core reads it from there, so the two cannot be separated by a
 * bundler giving a route its own copy of either module.
 */
const SCORING_NORMALIZATION_SCOPE_KEY = Symbol.for("turnitplus.scoring-normalization-scope");

type ScopeHolder = { [SCORING_NORMALIZATION_SCOPE_KEY]?: AsyncLocalStorage<ScoringNormalizationVersion> };

const scope: AsyncLocalStorage<ScoringNormalizationVersion> =
  ((globalThis as ScopeHolder)[SCORING_NORMALIZATION_SCOPE_KEY] ??= new AsyncLocalStorage<ScoringNormalizationVersion>());

/**
 * Runs `fn` — and everything it awaits — with normalize() bound to `version`.
 * Nesting is allowed; the innermost scope wins. Returns whatever `fn` returns.
 */
export function runWithScoringNormalization<T>(version: ScoringNormalizationVersion, fn: () => T): T {
  return scope.run(version, fn);
}
