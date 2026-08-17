import {
  createAcademicSearchBudget,
  createInMemoryAcademicSearchCache,
  withRequestControl,
} from "./academic-search/cache";
import { DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, runAcademicSearch } from "./academic-search/orchestrator";
import type { AcademicSearchProvider } from "./academic-search/provider";
import { createEuropePmcAcademicSearchProvider } from "./academic-search/providers/europe-pmc";
import { createOpenAireAcademicSearchProvider } from "./academic-search/providers/openaire";
import type { AcademicSearchRunStats, AcademicSearchStatus, ExternalAcademicEvidence } from "./academic-search/types";

/**
 * Phase 3 bridge layer: the only module that knows about both "reports" and
 * "the academic-search subsystem" — same role lib/report-historical-match.ts
 * plays for the user-submission corpus, lib/e8s-report-integration.ts plays
 * for E8S reuse context. lib/academic-search/ itself stays completely
 * unaware of SimilarityReport/reports — this file is the only seam.
 *
 * Deliberately never touches score/archiveScore/aiScore/verifiedSimilarity/
 * historical-match state/E8S/E8P (this phase's own PRIMARY PRODUCT RULE) —
 * this file's only output is a plain ExternalAcademicEvidence[], already
 * exactly the shape lib/report-types.ts's externalAcademicEvidence field
 * expects, with no report-specific transformation applied to it at all.
 *
 * Never throws: runAcademicSearch() already guarantees this internally
 * (Phase 2's own STEP 8 requirement — a provider failure is recorded in
 * stats.providerErrors, never a rejected promise), so the try/catch here is
 * a second, outer safety net for anything unexpected around it (e.g. the
 * cache/budget construction itself), matching every other read-time
 * enrichment in this codebase (getOrComputeHistoricalMatchSnapshot,
 * getReuseContextEligibility) that treats "this optional signal failed to
 * compute" as a normal, non-fatal outcome, never a reason to fail the
 * report it's attached to.
 *
 * Module-level cache (mirrors lib/academic-search/'s own Phase 2 report on
 * why: a warm serverless instance reuses it across requests — identical
 * query text or the same DOI/PMCID looked up by two different submissions
 * within the same warm instance is served without a second network call.
 * Reset on cold start; see the Phase 2 report's own disclosed limitation on
 * this. A fresh AcademicSearchBudget is created per call so one slow/heavy
 * submission can never consume another's request allowance.
 */

const sharedCache = createInMemoryAcademicSearchCache();

/**
 * Phase 6.6 PART 1 fix: two independent budgets, not one shared
 * PER_REPORT_BUDGET — see lib/academic-search/cache.ts's own header
 * comment on withRequestControl's discoveryBudget/retrievalBudget split
 * for the root-cause explanation (discovery's query count scales with
 * submission length/topic count and could exhaust a shared pool before
 * retrieval ever got its turn, silently dropping candidates the search
 * stage had already found).
 *
 * DISCOVERY_BUDGET_LIMIT stays at the exact same 40 this file's own
 * PER_REPORT_BUDGET already used — not raised, since single-topic
 * submissions were already succeeding at this level (real measured
 * queryCount ~16-17 for a single topic x 2 providers ~= 32-34 search
 * calls, comfortably under 40); the fix is giving retrieval a separate
 * pool, not giving discovery a bigger one.
 *
 * RETRIEVAL_BUDGET_LIMIT is sized to retrieval's own real, bounded need:
 * DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG.maxCandidatesToRetrieve (5) candidates,
 * each trying at most its ~2 contributing providers' getText() (see
 * text-retriever.ts's retrieveCandidateText — it stops at the first
 * contributor that returns real text) before falling back to the
 * unbudgeted HTTP retriever — a theoretical worst case of 10 "text"
 * consumptions, so 15 leaves real margin without being unbounded.
 * getMetadata() is defined on the wrapped providers but not currently
 * called anywhere in the pipeline (see orchestrator.ts/text-retriever.ts)
 * — this budget covers it defensively in case a future stage starts
 * calling it, at negligible cost given the small limit.
 *
 * Total worst-case external requests per report: 40 + 15 = 55, up from
 * today's single 40-unit pool — a small, deliberately-sized increase
 * matched to retrieval's own measured need, not an across-the-board bump;
 * still a hard, bounded cap, nowhere near "uncontrolled."
 */
const DISCOVERY_BUDGET_LIMIT = 40;
const RETRIEVAL_BUDGET_LIMIT = 15;
const PROVIDER_TIMEOUT_MS = 9_000;
const PROVIDER_MAX_RESULTS_PER_QUERY = 5;

export type AcademicEvidenceResult = {
  evidence: ExternalAcademicEvidence[];
  stats: AcademicSearchRunStats | null;
  /**
   * "start the two fixes now" TASK 2: mirrors runAcademicSearch's own
   * status exactly on success. FAILED here covers both that function's own
   * FAILED outcome (a total provider outage it still completed measuring)
   * and this function's own outer catch (something broke before a status
   * could even be computed, e.g. budget/cache construction) — a caller only
   * needs one signal to know "do not treat this as a confirmed zero-match
   * result."
   */
  status: AcademicSearchStatus;
};

function buildProviders() {
  const discoveryBudget = createAcademicSearchBudget(DISCOVERY_BUDGET_LIMIT);
  const retrievalBudget = createAcademicSearchBudget(RETRIEVAL_BUDGET_LIMIT);
  return [
    withRequestControl(
      createOpenAireAcademicSearchProvider({ maxResultsPerRequest: PROVIDER_MAX_RESULTS_PER_QUERY, timeoutMs: PROVIDER_TIMEOUT_MS }),
      { cache: sharedCache, discoveryBudget, retrievalBudget },
    ),
    withRequestControl(
      createEuropePmcAcademicSearchProvider({ maxResultsPerRequest: PROVIDER_MAX_RESULTS_PER_QUERY, timeoutMs: PROVIDER_TIMEOUT_MS }),
      { cache: sharedCache, discoveryBudget, retrievalBudget },
    ),
  ];
}

/**
 * Runs the full academic-search pipeline (phrase extraction -> search ->
 * dedup -> rank -> retrieve -> compare) against one submission's raw text
 * and returns the evidence ready to attach to SimilarityReport.
 * externalAcademicEvidence — already deduplicated by
 * lib/academic-search/deduplicator.ts's existing DOI-first, then-canonical-
 * URL, then-provider-id identity logic (this phase's STEP 7 requirement),
 * since that is runAcademicSearch's own Stage 4 for every candidate
 * regardless of which of OpenAIRE/Europe PMC (or both) produced it.
 *
 * Bounded by the existing, unmodified defaults from Phase 2
 * (DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG: 5-20 queries, top 5 candidates ever
 * text-retrieved) — this phase's own STEP 4 explicitly says not to exceed
 * the existing bounded query/candidate limits, so nothing here loosens them.
 *
 * `providersOverride` exists solely for tests (STEP 9's "provider failure"
 * / "both providers fail" scenarios) to exercise this function's own
 * try/catch and runAcademicSearch's independent non-throwing guarantee
 * without a real network call — production code never passes it, so
 * buildProviders()'s real OpenAIRE/Europe PMC construction is exactly what
 * every real call still goes through.
 */
export async function getExternalAcademicEvidence(
  rawText: string,
  providersOverride?: AcademicSearchProvider[],
): Promise<AcademicEvidenceResult> {
  try {
    const providers = providersOverride ?? buildProviders();
    const result = await runAcademicSearch(rawText, providers, DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG);
    return { evidence: result.evidence, stats: result.stats, status: result.status };
  } catch (error) {
    // Never logs rawText itself (this codebase's own existing discipline —
    // see e.g. lib/user-submission-corpus.ts's identical rule) — only the
    // error message, which describes the failure, not the document.
    console.error("getExternalAcademicEvidence failed (non-fatal):", error instanceof Error ? error.message : String(error));
    return { evidence: [], stats: null, status: "FAILED" };
  }
}
