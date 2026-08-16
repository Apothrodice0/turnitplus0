/**
 * Phase 2 STEP 6/7 real-world benchmark — NOT wired into any build or
 * production route, NOT committed as part of this phase's deliverable code
 * (see the phase's own final report for why it exists as a standalone,
 * uncommitted diagnostic tool rather than a permanent tools/ script).
 *
 * Runs runAcademicSearch() against the real OpenAIRE + Europe PMC providers
 * for a set of real, verifiable test cases (title/DOI known in advance,
 * verbatim abstract text captured live from each provider during this
 * phase — see the header comment on each BENCHMARK_CASES entry). Reports
 * discovery success (was the true source found at all, and within top-5 /
 * top-10) separately from matching success (did the local comparator
 * confirm textual correspondence against retrieved full text) per STEP 7.
 *
 * Run: node --import tsx tools/academic-search-live-benchmark.ts
 */

import {
  createAcademicSearchBudget,
  createInMemoryAcademicSearchCache,
  withRequestControl,
} from "../lib/academic-search/cache";
import { DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, runAcademicSearch } from "../lib/academic-search/orchestrator";
import { createEuropePmcAcademicSearchProvider } from "../lib/academic-search/providers/europe-pmc";
import { createOpenAireAcademicSearchProvider } from "../lib/academic-search/providers/openaire";
import type { AcademicSearchCandidate, AcademicSearchRunResult, ExternalAcademicEvidence } from "../lib/academic-search/types";

type BenchmarkCase = {
  label: string;
  discipline: string;
  groundTruthDoi: string | null;
  groundTruthTitle: string;
  submissionText: string;
  variant: "verbatim" | "paraphrased";
};

// Every abstract below was fetched live from the real OpenAIRE Graph API v3 or Europe PMC
// REST API during this phase (see tools/*, not committed, used to gather these) — genuine
// text from genuine, currently-indexed open-access records, not fabricated fixtures.
const BENCHMARK_CASES: BenchmarkCase[] = [
  {
    label: "pain-estimation-thermal-rgb",
    discipline: "biomedical (Europe PMC)",
    groundTruthDoi: "10.1371/journal.pdig.0001424",
    groundTruthTitle: "Cross-spectral fusion of thermal and RGB imaging for objective pain estimation",
    variant: "verbatim",
    submissionText:
      "Pain assessment remains challenging for patients unable to verbally communicate, including neonates, cognitively impaired individuals, sedated patients, and those who suppress expressions due to cultural norms or stoicism. We demonstrate that integrating thermal imaging with RGB facial expression analysis provides more accurate and robust pain intensity estimation than either modality alone. Our dual-camera system records synchronized thermal and RGB video, processed through a cross-spectral attention fusion (CSAF) model with a temporal transformer for continuous 0-10 scale pain prediction. In a controlled laboratory pain induction study, 50 healthy adults underwent Cold Pressor Test and pressure algometry protocols; our system achieves a mean absolute error of 0.79, representing a 33.1% improvement over RGB-only. In a real-world clinical postoperative monitoring study, 30 surgical patients recovering from abdominal surgery were monitored; our system achieves a mean absolute error of 1.08, representing a 28.5% improvement over RGB-only. Thermal responses precede visible expressions by 1.2 seconds, enabling earlier detection.",
  },
  {
    label: "pain-estimation-thermal-rgb-paraphrased",
    discipline: "biomedical (Europe PMC) — paraphrase stress test",
    groundTruthDoi: "10.1371/journal.pdig.0001424",
    groundTruthTitle: "Cross-spectral fusion of thermal and RGB imaging for objective pain estimation",
    variant: "paraphrased",
    submissionText:
      "Assessing pain continues to be difficult in patients who cannot communicate verbally, such as newborns, those with cognitive impairments, sedated individuals, and people who mask their expressions because of stoicism or cultural norms. Our own review builds on prior work showing that combining thermal imaging with RGB-based facial analysis yields more robust and accurate pain-level estimates than using either signal by itself. A two-camera setup captures synchronized thermal and RGB footage, which a cross-spectral attention fusion model paired with a temporal transformer then processes to continuously predict pain on a 0-10 scale. Across a lab-based pain-induction trial with 50 healthy adults, the described approach substantially outperformed an RGB-only baseline, and similar gains were reported in a clinical postoperative monitoring study of 30 abdominal-surgery patients. Notably, thermal signals were reported to appear noticeably earlier than visible facial expressions, which could allow earlier detection of pain onset.",
  },
  {
    label: "crispr-md-simulation",
    discipline: "biomedical (Europe PMC)",
    groundTruthDoi: "10.1021/acsomega.2c05583",
    groundTruthTitle: "Insights into the Mechanism of CRISPR/Cas9-Based Genome Editing from Molecular Dynamics Simulations",
    variant: "verbatim",
    submissionText:
      "The CRISPR/Cas9 system is a popular genome-editing tool with immense therapeutic potential. It is a simple two-component system (Cas9 protein and RNA) that recognizes the DNA sequence on the basis of RNA:DNA complementarity, and the Cas9 protein catalyzes the double-stranded break in the DNA. In the past decade, near-atomic resolution structures at various stages of the CRISPR/Cas9 DNA editing pathway have been reported along with numerous experimental and computational studies. Despite such advancements, the application of CRISPR/Cas9 in therapeutics is still limited, primarily due to off-target effects. Molecular Dynamics (MD) simulations have been an excellent complement to the experimental studies for investigating the mechanism of CRISPR/Cas9 editing in terms of structure, thermodynamics, and kinetics. MD-based studies have uncovered several important molecular aspects of Cas9, such as nucleotide binding, catalytic mechanism, and off-target effects.",
  },
  {
    label: "crispr-md-simulation-paraphrased",
    discipline: "biomedical (Europe PMC) — paraphrase stress test",
    groundTruthDoi: "10.1021/acsomega.2c05583",
    groundTruthTitle: "Insights into the Mechanism of CRISPR/Cas9-Based Genome Editing from Molecular Dynamics Simulations",
    variant: "paraphrased",
    submissionText:
      "CRISPR/Cas9 has become one of the most widely used genome-editing technologies because of its considerable therapeutic promise. The system relies on just two components, a Cas9 protein and a guide RNA, which together locate a target DNA sequence through RNA:DNA base pairing before Cas9 introduces a double-stranded cut. Over the last ten years, researchers have solved near-atomic-resolution structures capturing multiple stages of the Cas9 editing pathway, complementing a large body of experimental and computational work. Even so, off-target cutting remains a major obstacle limiting how far CRISPR/Cas9 can be pushed into real therapeutic use. Molecular dynamics simulations have proven to be a valuable companion to wet-lab experiments for probing the structural, thermodynamic, and kinetic details of how Cas9 actually edits DNA, revealing mechanistic insights into nucleotide binding, catalysis, and the origins of off-target activity.",
  },
  {
    label: "diabetic-retinopathy-radiomics",
    discipline: "biomedical (Europe PMC)",
    groundTruthDoi: "10.1167/tvst.15.5.27",
    groundTruthTitle: "Radiomics-Based Fundus Photography Analysis in Diabetic Retinopathy",
    variant: "verbatim",
    submissionText:
      "The purpose of this study was to apply radiomics feature extraction from fundus photographs to automatically identify biomarkers that distinguish different stages of diabetic retinopathy. A total of 52 radiomic features were extracted from fundus photographs representing different DR stages: diabetes without DR, mild non-proliferative DR, moderate NPDR, severe NPDR, and proliferative DR. When comparing eyes without DR to all NPDR eyes, significant differences were detected in first-order statistics, gray-level co-occurrence matrix features, Gabor texture features, and Law's texture energy features. Several features demonstrated a linear trend with increasing DR severity, whereas proliferative DR showed a distinct pattern. Radiomic features from fundus photographs may help in distinguishing eyes without DR from NPDR, demonstrating strong potential for automated DR classification and screening applications.",
  },
  {
    label: "soil-microbiome-grazing-nitrogen",
    discipline: "biomedical/agricultural (Europe PMC)",
    groundTruthDoi: "10.1016/j.isci.2026.116009",
    groundTruthTitle: "Different grazing intensities affect soil nitrogen cycling by altering microbial nitrogen metabolism in alpine wetlands",
    variant: "verbatim",
    submissionText:
      "Grazing significantly affects soil nitrogen cycling in eastern Qinghai-Tibet Plateau alpine wetlands. Grazing did not alter soil microbial alpha-diversity, but shifted community composition via metagenomic analysis. Moderate and heavy grazing reduced soil total and active nitrogen contents by 53.8%-92.0% versus light grazing, significantly decreased abundances of nitrification genes (amoA and hao) and ammonium assimilation gene (glnA), while increased dissimilatory nitrite reduction to ammonium gene (nirB) by 142.1%. A nitrification bottleneck from impaired nitrification drove active nitrogen decline, and structural equation modeling identified nitrogen cycle gene abundance as the key driver.",
  },
  {
    label: "coral-selective-breeding-heat",
    discipline: "biomedical/marine biology (Europe PMC)",
    groundTruthDoi: "10.1098/rspb.2025.1817",
    groundTruthTitle: "Selective breeding enhances coral heat tolerance even over small spatial scales",
    variant: "verbatim",
    submissionText:
      "Coral reefs globally are experiencing escalating mass bleaching and mortality. We established heat tolerance baselines and selective breeding efforts for two widespread reef-building Acropora species within the Ningaloo World Heritage Area. Fitness responses were measured in control and heat stress temperatures, including survival, tissue necrosis, bleaching and photosynthesis. Larvae with one parent from the warmer population exhibited over 2.2-fold higher survival under heat stress, while those with both parents from the warmer population survived 1.6-fold better. These findings are the first to demonstrate that selective breeding can provide heat tolerance enhancement for corals in the Indian Ocean and will be critical to preparing for future marine heatwaves.",
  },
  {
    label: "gut-microbiome-protein-diet",
    discipline: "biomedical (Europe PMC)",
    groundTruthDoi: "10.1038/s41598-026-46663-y",
    groundTruthTitle: "Impact of dietary protein quantity on the non-dysbiotic human microbiome",
    variant: "verbatim",
    submissionText:
      "The gut microbiome plays an essential role in human health, and alterations in its composition have been associated with a range of gastrointestinal and metabolic disorders. Diet is one of the most important modifiable factors influencing the gut microbiome, with dietary protein known to affect microbial composition and metabolic activity. This controlled crossover feeding study examined whether diets providing 10% versus 25% of total energy intake from protein alter stool microbiome profiles in healthy adults. Ten participants completed a controlled crossover feeding trial. Stool microbiome composition varied more by individual than by diet. No significant changes in dysbiosis scores, microbiome diversity, or short chain fatty acid concentrations were observed.",
  },
  {
    label: "transformer-attention-is-all-you-need",
    discipline: "computer science (OpenAIRE)",
    groundTruthDoi: "10.65215/r5bs2d54",
    groundTruthTitle: "Attention Is All You Need",
    variant: "verbatim",
    submissionText:
      "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks in an encoder-decoder configuration. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely. Experiments on two machine translation tasks show these models to be superior in quality while being more parallelizable and requiring significantly less time to train. Our model achieves 28.4 BLEU on the WMT 2014 English-to-German translation task, improving over the existing best results, including ensembles by over 2 BLEU. We show that the Transformer generalizes well to other tasks by applying it successfully to English constituency parsing both with large and limited training data.",
  },
  {
    label: "quantum-key-distribution-entanglement-swapping",
    discipline: "physics (OpenAIRE)",
    groundTruthDoi: "10.48550/arxiv.quant-ph/0009025",
    groundTruthTitle: "Multiparty key distribution and secret sharing based on entanglement swapping",
    variant: "verbatim",
    submissionText:
      "A general proof of the security against eavesdropping of a previously introduced protocol for two-party quantum key distribution based on entanglement swapping is provided. In addition, the protocol is extended to permit multiparty quantum key distribution and secret sharing of classical information.",
  },
  {
    label: "mycorrhizal-kinship-carbon-phosphorus",
    discipline: "plant biology (OpenAIRE)",
    groundTruthDoi: "10.3390/plants15050703",
    groundTruthTitle: "Kinship Modulates Carbon Allocation and Phosphorus Acquisition in Chinese Fir",
    variant: "verbatim",
    submissionText:
      "Phosphorus deficiency in forest soils is a key constraint on the sustainable management and productivity of Chinese fir plantations. This study investigated how phosphorus limitation alters the reciprocal exchange of photosynthetic carbon and mineral phosphorus between Chinese fir and arbuscular mycorrhizal fungi when the focal plant grows adjacent to neighbors with different degrees of relatedness. Neighbor phosphorus limitation significantly increased AMF colonization in roots and whole-plant phosphorus concentration of the focal Chinese fir. These patterns indicate that neighbor relatedness may modulate carbon allocation and phosphorus acquisition within the mycorrhizal network, providing new insights into how mycorrhizal networks may facilitate plant adaptation to nutrient limitation.",
  },
  {
    label: "monetary-policy-transmission-inflation-targeting",
    discipline: "economics (OpenAIRE)",
    groundTruthDoi: null,
    groundTruthTitle: "EFFECTIVENESS OF MONETARY TRANSMISSION AND THE IMPACT OF INFLATION TARGETING STRATEGY",
    variant: "verbatim",
    submissionText:
      "The objective of this paper is to investigate the impact of inflation targeting strategy on monetary policy transmission mechanism by estimating the impact of deposit rate on consumption to GDP ratio in emerging market economies. The study considers sixteen years of annual data from 2001 to 2016 comprising of thirty-six emerging market economies including inflation targeting countries and non-inflation targeting countries. This study implies Generalized Method of Moments for empirical investigation. The study found a significant impact of inflation targeting on monetary policy transmission mechanism.",
  },
  {
    label: "postcolonial-italian-literature-transnational",
    discipline: "humanities (OpenAIRE)",
    groundTruthDoi: "10.1093/oxfordhb/9780197613955.013.9",
    groundTruthTitle: "Beyond the National Paradigm",
    variant: "verbatim",
    submissionText:
      "This chapter discusses the impact of a combined transnational and translational methodology on definitions of Italian literature and on the critical reading practices that inform the approach to literary texts. It calls into question assumptions of geographic, cultural, or linguistic homogeneity and their historical role in defining an Italian literary canon as well as ideas of Italianness, arguing instead in favor of a more fluid and inclusive notion of Italian literature. Using examples that range from colonial and postcolonial to diasporic and translingual writing, the article aims to illustrate the porous nature of the production, circulation, and reception of literary works.",
  },
  {
    label: "epistemic-injustice-government-systems",
    discipline: "philosophy/tech ethics (OpenAIRE)",
    groundTruthDoi: "10.1007/978-3-031-70274-7_26",
    groundTruthTitle: "Epistemic Injustice and Government Information Systems",
    variant: "verbatim",
    submissionText:
      "Cases of bias and unfair decisions in automated decision-making are heavily discussed. When unfair decisions can be attributed to a difference in the knowledge of groups of subjects, we can speak of epistemic injustice. In this paper, we analyse the various types of epistemic injustice: testimonial, hermeneutical, distributional, and content-focused epistemic injustice, and show how they can be conceptualised. We apply the notion of epistemic injustice to analyse what went wrong in two automated decision making scandals: Toeslagenaffaire in the Netherlands, and RoboDebt in Australia.",
  },
];

function normalizeDoiForCompare(doi: string | null): string | null {
  if (!doi) return null;
  return doi.trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
}

function normalizeTitleForCompare(title: string | null): string {
  return (title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function matchesGroundTruth(candidate: AcademicSearchCandidate | ExternalAcademicEvidence, testCase: BenchmarkCase): boolean {
  const candidateDoi = normalizeDoiForCompare(candidate.doi);
  const groundTruthDoi = normalizeDoiForCompare(testCase.groundTruthDoi);
  if (candidateDoi && groundTruthDoi && candidateDoi === groundTruthDoi) return true;

  const candidateTitle = normalizeTitleForCompare(candidate.title);
  const groundTruthTitle = normalizeTitleForCompare(testCase.groundTruthTitle);
  if (!candidateTitle || !groundTruthTitle) return false;
  return candidateTitle.includes(groundTruthTitle) || groundTruthTitle.includes(candidateTitle);
}

type CaseResult = {
  label: string;
  discipline: string;
  variant: string;
  queryCount: number;
  searchLatencyMs: number;
  candidateCountBeforeDedup: number;
  candidateCountAfterDedup: number;
  candidatesTextRetrieved: number;
  textRetrievalLatencyMs: number;
  totalLatencyMs: number;
  providerErrors: number;
  discoveryRank: number | null; // 1-indexed rank of the ground-truth candidate, or null if not found in the ranked candidate list at all
  discoveredInTop5: boolean;
  discoveredInTop10: boolean;
  matchingSuccess: boolean;
  matchedSimilarity: number | null;
  matchedPassageCount: number;
  falsePositives: Array<{ title: string | null; doi: string | null; similarity: number; strongMatch: boolean }>;
};

async function runCase(testCase: BenchmarkCase, cache: ReturnType<typeof createInMemoryAcademicSearchCache>): Promise<{ result: CaseResult; raw: AcademicSearchRunResult }> {
  const budget = createAcademicSearchBudget(60);
  const providers = [
    withRequestControl(createOpenAireAcademicSearchProvider({ maxResultsPerRequest: 5, timeoutMs: 12_000 }), { cache, budget }),
    withRequestControl(createEuropePmcAcademicSearchProvider({ maxResultsPerRequest: 5, timeoutMs: 12_000 }), { cache, budget }),
  ];

  const config = { ...DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, maxCandidatesToRetrieve: 10 };
  const raw = await runAcademicSearch(testCase.submissionText, providers, config);

  const rankIndex = raw.candidates.findIndex((c) => matchesGroundTruth(c, testCase));
  const discoveryRank = rankIndex === -1 ? null : rankIndex + 1;

  const matchedEvidence = raw.evidence.find((e) => matchesGroundTruth(e, testCase));
  const falsePositives = raw.evidence
    .filter((e) => !matchesGroundTruth(e, testCase))
    .map((e) => ({ title: e.title, doi: e.doi, similarity: e.similarity, strongMatch: e.similarity >= 40 }));

  const result: CaseResult = {
    label: testCase.label,
    discipline: testCase.discipline,
    variant: testCase.variant,
    queryCount: raw.stats.queryCount,
    searchLatencyMs: raw.stats.searchLatencyMs,
    candidateCountBeforeDedup: raw.stats.candidateCountBeforeDedup,
    candidateCountAfterDedup: raw.stats.candidateCountAfterDedup,
    candidatesTextRetrieved: raw.stats.candidatesTextRetrieved,
    textRetrievalLatencyMs: raw.stats.textRetrievalLatencyMs,
    totalLatencyMs: raw.stats.totalLatencyMs,
    providerErrors: raw.stats.providerErrors.length,
    discoveryRank,
    discoveredInTop5: discoveryRank !== null && discoveryRank <= 5,
    discoveredInTop10: discoveryRank !== null && discoveryRank <= 10,
    matchingSuccess: Boolean(matchedEvidence),
    matchedSimilarity: matchedEvidence?.similarity ?? null,
    matchedPassageCount: matchedEvidence?.matchedPassages.length ?? 0,
    falsePositives,
  };

  return { result, raw };
}

async function main() {
  const sharedCache = createInMemoryAcademicSearchCache();
  const results: CaseResult[] = [];
  const rawResults: Record<string, AcademicSearchRunResult> = {};

  console.log(`Running ${BENCHMARK_CASES.length} live benchmark cases against real OpenAIRE + Europe PMC APIs...\n`);

  for (const testCase of BENCHMARK_CASES) {
    const start = Date.now();
    const { result, raw } = await runCase(testCase, sharedCache);
    rawResults[testCase.label] = raw;
    results.push(result);
    console.log(
      `[${(Date.now() - start).toString().padStart(6)}ms] ${testCase.label.padEnd(45)} `
      + `rank=${result.discoveryRank ?? "—"} top5=${result.discoveredInTop5} top10=${result.discoveredInTop10} `
      + `matched=${result.matchingSuccess} sim=${result.matchedSimilarity ?? "—"} fp=${result.falsePositives.length} errs=${result.providerErrors}`,
    );
  }

  // --- Cache-reuse demonstration: rerun the first case's queries through the SAME cache ---
  console.log("\n--- Cache reuse demonstration (re-running case #1 through the same warm cache) ---");
  const rerunStart = Date.now();
  const { result: rerunResult } = await runCase(BENCHMARK_CASES[0], sharedCache);
  const rerunLatency = Date.now() - rerunStart;
  console.log(`First run search latency:  ${results[0].searchLatencyMs} ms`);
  console.log(`Warm rerun search latency: ${rerunResult.searchLatencyMs} ms`);
  console.log(`Warm rerun total latency:  ${rerunLatency} ms`);
  console.log(`Cache stats after full benchmark + rerun:`, sharedCache.stats);

  // --- Aggregate ---
  const total = results.length;
  const top5 = results.filter((r) => r.discoveredInTop5).length;
  const top10 = results.filter((r) => r.discoveredInTop10).length;
  const notFound = results.filter((r) => r.discoveryRank === null).length;
  const matched = results.filter((r) => r.matchingSuccess).length;
  const totalFalsePositives = results.reduce((sum, r) => sum + r.falsePositives.length, 0);
  const strongFalsePositives = results.flatMap((r) => r.falsePositives).filter((fp) => fp.strongMatch);
  const totalQueries = results.reduce((sum, r) => sum + r.queryCount, 0);
  const totalTextRetrieved = results.reduce((sum, r) => sum + r.candidatesTextRetrieved, 0);
  const totalProviderErrors = results.reduce((sum, r) => sum + r.providerErrors, 0);
  const avgTotalLatency = results.reduce((sum, r) => sum + r.totalLatencyMs, 0) / total;
  const avgSearchLatency = results.reduce((sum, r) => sum + r.searchLatencyMs, 0) / total;

  console.log("\n=== AGGREGATE RESULTS ===");
  console.log(`Cases run:                 ${total}`);
  console.log(`Discovery top-5 rate:      ${top5}/${total} (${((top5 / total) * 100).toFixed(1)}%)`);
  console.log(`Discovery top-10 rate:     ${top10}/${total} (${((top10 / total) * 100).toFixed(1)}%)`);
  console.log(`Not discovered at all:     ${notFound}/${total}`);
  console.log(`Matching success rate:     ${matched}/${total} (${((matched / total) * 100).toFixed(1)}%)`);
  console.log(`Total evidence entries that were false positives: ${totalFalsePositives} (strong/similarity>=40: ${strongFalsePositives.length})`);
  console.log(`Total queries issued (all cases): ${totalQueries}`);
  console.log(`Total text retrievals attempted:  ${totalTextRetrieved}`);
  console.log(`Total provider errors:            ${totalProviderErrors}`);
  console.log(`Avg total latency per case:  ${avgTotalLatency.toFixed(0)} ms`);
  console.log(`Avg search latency per case: ${avgSearchLatency.toFixed(0)} ms`);
  console.log(`Cache stats:`, sharedCache.stats);

  console.log("\n=== PER-CASE DETAIL (JSON) ===");
  console.log(JSON.stringify(results, null, 2));

  console.log("\n=== FALSE POSITIVE DETAIL ===");
  for (const r of results) {
    if (r.falsePositives.length === 0) continue;
    console.log(`${r.label}:`, r.falsePositives);
  }
}

main().catch((error) => {
  console.error("BENCHMARK FAILED:", error);
  process.exitCode = 1;
});
