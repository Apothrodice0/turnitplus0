import type { AcademicSearchProvider } from "../provider";
import type { AcademicSearchQuery, AcademicSearchResult } from "../types";

/**
 * The provider actually used to drive this Phase 1 POC (see final report).
 * A small, realistic, entirely fabricated academic-fixture corpus — no real
 * papers, no scraped data, no network access. Per STEP 5's own fallback
 * instruction ("If CORE cannot be used for the POC, create providers/mock.ts
 * and use realistic academic fixtures"): the sibling providers/core.ts is
 * implemented to the real CORE API v3 shape, but this environment has no
 * CORE_API_KEY and no way to verify a live call succeeds, so the mock
 * provider is what the demonstrated POC run and the deterministic test
 * suite actually exercise. Swapping providers/core.ts in instead requires
 * no change to any other file in this directory — see orchestrator.ts,
 * which only ever depends on the AcademicSearchProvider interface.
 */

export type MockAcademicFixture = {
  id: string;
  title: string;
  authors: string[];
  publication: string;
  year: number;
  doi: string | null;
  url: string;
  /** null models a metadata-only record — a provider that can locate a work but cannot supply full text (STEP 7's "unavailable full text" case). */
  fullText: string | null;
};

/** Ten fabricated works spanning several disciplines, so phrase-extractor output for a real, topically-mixed submission has a realistic chance of matching more than one. */
export const DEFAULT_MOCK_ACADEMIC_FIXTURES: MockAcademicFixture[] = [
  {
    id: "mock-001",
    title: "Bioluminescent Synchronization Patterns in Deep-Sea Plankton Colonies",
    authors: ["Ada Rivers", "Sam Cole"],
    publication: "Journal of Marine Bioluminescence",
    year: 2019,
    doi: "10.1234/mbio.2019.001",
    url: "https://example-journal.test/articles/mock-001",
    fullText:
      "Deep-sea plankton colonies exhibit synchronized bioluminescent flashing that propagates across a colony far faster than any individual organism's own reaction time would allow. Observations collected across multiple expeditions suggest the synchronization is mediated by a shared chemical trigger rather than by direct visual signaling between individuals, since flash propagation continued unchanged in turbidity conditions that would have obscured direct light-based cues. This finding challenges earlier models that treated bioluminescent synchronization as a purely optical phenomenon.",
  },
  {
    id: "mock-002",
    title: "Quantum Entanglement Approaches to Cryptographic Key Distribution",
    authors: ["Priya Natarajan"],
    publication: "International Review of Quantum Computing",
    year: 2021,
    doi: "10.5678/irqc.2021.014",
    url: "https://example-journal.test/articles/mock-002",
    fullText:
      "Quantum key distribution protocols exploit the no-cloning theorem to guarantee that any interception attempt introduces a detectable disturbance in the shared entangled state. This paper surveys entanglement-based distribution schemes proposed over the past decade and evaluates their resilience against increasingly sophisticated side-channel attacks that target implementation details rather than the underlying quantum-mechanical guarantees.",
  },
  {
    id: "mock-003",
    title: "Post-Colonial Narratives in Twentieth-Century Caribbean Literature",
    authors: ["Marisol Fontaine"],
    publication: "Journal of Comparative Literary Studies",
    year: 2017,
    doi: null,
    url: "https://example-repo.test/items/mock-003",
    fullText: null,
  },
  {
    id: "mock-004",
    title: "Machine Learning Approaches to Early Detection of Diabetic Retinopathy",
    authors: ["Chen Wei", "Fatima Al-Sayed", "Robert Klein"],
    publication: "Biomedical Informatics Quarterly",
    year: 2022,
    doi: "10.9012/biq.2022.077",
    url: "https://example-journal.test/articles/mock-004",
    fullText:
      "Convolutional networks trained on retinal fundus images can flag early-stage diabetic retinopathy before symptoms become clinically apparent to a human examiner. This study reports sensitivity and specificity across a demographically diverse validation cohort and discusses the calibration failures observed when the model is applied to imaging equipment not represented in the original training distribution.",
  },
  {
    id: "mock-005",
    title: "The Role of Mycorrhizal Networks in Forest Carbon Exchange",
    authors: ["Helena Brandt"],
    publication: "Ecosystems Research Letters",
    year: 2020,
    doi: "10.3456/erl.2020.033",
    url: "https://example-journal.test/articles/mock-005",
    fullText: null,
  },
  {
    id: "mock-006",
    title: "Attention Mechanisms and Long-Range Dependency Modeling in Sequence Transduction",
    authors: ["Elena Vasquez", "Tomas Herrera"],
    publication: "Proceedings of Computational Linguistics Review",
    year: 2018,
    doi: "10.7890/cclr.2018.045",
    url: "https://example-journal.test/articles/mock-006",
    fullText:
      "Recent advances in sequence transduction models have relied heavily on recurrent architectures, but a growing body of literature demonstrates that attention mechanisms alone can capture long-range dependencies more efficiently than recurrence or convolution. Self-attention layers compute a weighted representation of every token in the input sequence relative to every other token, allowing the network to model relationships regardless of their distance in the sequence. Empirical results across several translation benchmarks show that architectures relying solely on attention mechanisms achieve strong performance while requiring less training time than comparable recurrent models.",
  },
  {
    id: "mock-007",
    title: "Soil Microbiome Diversity Under Regenerative Grazing Regimes",
    authors: ["Oluwaseun Adeyemi"],
    publication: "Agricultural Ecology Review",
    year: 2023,
    doi: "10.2468/aer.2023.019",
    url: "https://example-journal.test/articles/mock-007",
    fullText:
      "Rotational grazing regimes designed to mimic historical grazing pressure produced measurably higher soil microbiome diversity than continuous grazing over a three-year comparison. The effect was strongest in the top ten centimeters of topsoil and diminished sharply below the root zone, suggesting the mechanism is driven primarily by root exudate variability rather than by manure deposition alone.",
  },
  {
    id: "mock-008",
    title: "Epistemic Injustice in Automated Decision-Making Systems",
    authors: ["Grace Okonkwo", "Daniel Petrov"],
    publication: "Journal of Technology and Society",
    year: 2022,
    doi: "10.1357/jts.2022.088",
    url: "https://example-journal.test/articles/mock-008",
    fullText:
      "Automated decision-making systems can produce a distinctive form of epistemic injustice when the individuals most affected by a decision are structurally excluded from contesting the reasoning behind it. This paper distinguishes testimonial injustice, in which an affected party's own account is discounted, from hermeneutical injustice, in which the affected party lacks the interpretive resources to even frame their objection.",
  },
  {
    id: "mock-009",
    title: "Thermal Tolerance Plasticity in Reef-Building Coral Larvae",
    authors: ["Isabela Marques"],
    publication: "Coral Reef Science",
    year: 2021,
    doi: "10.6543/crs.2021.052",
    url: "https://example-journal.test/articles/mock-009",
    fullText: null,
  },
  {
    id: "mock-010",
    title: "Monetary Policy Transmission Lags in Emerging Market Economies",
    authors: ["Luis Fernandez", "Wing-Yan Ho"],
    publication: "Journal of Development Economics Policy",
    year: 2020,
    doi: "10.7531/jdep.2020.061",
    url: "https://example-journal.test/articles/mock-010",
    fullText:
      "Emerging market central banks face materially longer monetary policy transmission lags than their developed-market counterparts, largely because a smaller share of household borrowing is indexed to the policy rate. This paper estimates transmission lags across fourteen emerging economies and finds that financial market depth, not central bank credibility, is the strongest predictor of transmission speed.",
  },
];

export type MockAcademicSearchProviderConfig = {
  id?: string;
  fixtures?: MockAcademicFixture[];
  maxResultsPerQuery?: number;
  /** Optional artificial delay per search() call, useful for exercising/measuring the orchestrator's latency stats deterministically in tests. */
  simulatedLatencyMs?: number;
};

const STOP_SHORT_WORDS = new Set(["the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "with", "is", "are", "this", "that"]);

function searchableTokens(fixture: MockAcademicFixture): string[] {
  const text = [fixture.title, fixture.authors.join(" "), fixture.publication, fixture.fullText ?? ""].join(" ");
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function queryTokens(queryText: string): string[] {
  return (queryText.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= 3 && !STOP_SHORT_WORDS.has(word));
}

function relevanceScore(fixture: MockAcademicFixture, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const haystack = new Set(searchableTokens(fixture));
  const matched = tokens.filter((token) => haystack.has(token)).length;
  return matched / tokens.length;
}

/** Builds a deterministic, in-memory, no-network AcademicSearchProvider over a fabricated fixture corpus. */
export function createMockAcademicSearchProvider(config: MockAcademicSearchProviderConfig = {}): AcademicSearchProvider {
  const id = config.id ?? "mock";
  const fixtures = config.fixtures ?? DEFAULT_MOCK_ACADEMIC_FIXTURES;
  const maxResultsPerQuery = config.maxResultsPerQuery ?? 5;
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));

  function toResult(fixture: MockAcademicFixture, queryText: string, relevance: number): AcademicSearchResult {
    return {
      providerId: id,
      externalId: fixture.id,
      title: fixture.title,
      authors: fixture.authors,
      publication: fixture.publication,
      year: fixture.year,
      doi: fixture.doi,
      url: fixture.url,
      textAvailable: fixture.fullText !== null,
      abstract: null,
      querySignalUsed: queryText,
      providerRelevance: relevance,
    };
  }

  return {
    id,

    async search(query: AcademicSearchQuery): Promise<AcademicSearchResult[]> {
      if (config.simulatedLatencyMs) await new Promise((resolve) => setTimeout(resolve, config.simulatedLatencyMs));

      const tokens = queryTokens(query.queryText);
      const scored = fixtures
        .map((fixture) => ({ fixture, score: relevanceScore(fixture, tokens) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);

      const maxScore = scored.length > 0 ? scored[0].score : 0;
      return scored
        .slice(0, maxResultsPerQuery)
        .map((entry) => toResult(entry.fixture, query.queryText, maxScore > 0 ? entry.score / maxScore : 0));
    },

    async getMetadata(externalId: string): Promise<Partial<AcademicSearchResult> | null> {
      const fixture = byId.get(externalId);
      if (!fixture) return null;
      return toResult(fixture, "", 1);
    },

    async getText(externalId: string): Promise<string | null> {
      return byId.get(externalId)?.fullText ?? null;
    },
  };
}
