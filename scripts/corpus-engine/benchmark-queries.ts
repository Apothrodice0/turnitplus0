import { tokensForScoringNormalization } from "../../lib/similarity-core";
import { CORPUS_NORMALIZATION_VERSION } from "../../lib/corpus-engine/versions";
import { docIdFromDecimal } from "../../lib/corpus-engine/ids";
import type { CorpusGenerationReader } from "../../lib/corpus-engine/reader";
import { openGeneration, readCatalog, writeCatalogJsonLines, type BenchmarkQuery, type CatalogEntry, type IntendedSource } from "./benchmark-common";
import { inventedWords, SYNTHETIC_LEGAL_BOILERPLATE, SYNTHETIC_NEAR_DUPLICATE_FAMILY, syntheticNearDuplicateBaseWords } from "./checkpoint-sources";
import { logLine, parseArguments, pick, prng, readJson, requireArgument, wordsOf, writeJson } from "./common";

/**
 * Builds the catalog of a generation and, from it, the benchmark submissions.
 *
 *   benchmark-queries.ts catalog --root R --generation G --out catalog.json
 *   benchmark-queries.ts build   --root R --generation G --catalog catalog.json --out queries.json
 *   benchmark-queries.ts build-100k --root R --generation G --catalog catalog.json --out queries.json --out-exhaustive-sample sample.json
 *
 * Every positive submission is assembled from passages read back OUT OF THE
 * GENERATION (the stored source text), so the source document ids it should
 * match are known by construction. The text between passages is original
 * filler generated here from sentence templates — ordinary academic phrasing
 * that shares common word sequences with real prose but was copied from
 * nowhere. Everything is seeded: the same generation gives the same queries.
 */

const SEED = 20261006;

// ── original filler: common-language prose that is not in any corpus ─────────
const EN = {
  openers: ["In this context,", "As a consequence,", "On the other hand,", "More generally,", "For this reason,", "At the same time,", "In practical terms,", "By contrast,", "Taken together,", "In most cases,", "From this perspective,", "As noted above,"],
  subjects: ["the proposed framework", "our preliminary analysis", "the second group of participants", "this line of reasoning", "the revised procedure", "a careful reading of the evidence", "the comparison between both samples", "the overall pattern of responses", "the working hypothesis", "each of the selected indicators", "the available documentation", "the committee's assessment"],
  verbs: ["suggests that", "does not imply that", "makes it clear that", "leaves open whether", "confirms that", "raises the question of whether", "helps explain why", "is consistent with the view that", "should not hide the fact that", "depends on whether"],
  clauses: ["the observed differences are larger than expected", "further work will be needed before any firm conclusion is drawn", "local conditions play a greater role than the model assumes", "the same approach could be applied to other settings", "the initial estimates were too optimistic", "practitioners rarely have the time to follow every step", "the benefits are unevenly distributed across the groups", "small changes in the starting assumptions alter the outcome", "the results remain stable when the sample is divided", "the measurement itself influences what is being measured", "several interpretations fit the same set of observations", "the costs appear earlier than the advantages"],
  tails: ["in the short term.", "under ordinary circumstances.", "for the purposes of this report.", "at least in the cases examined here.", "once the adjustment period is over.", "when compared with the previous year.", "as the following sections show.", "although exceptions are easy to find.", "which is hardly surprising.", "and this deserves closer attention."],
};
const FR = {
  openers: ["Dans ce contexte,", "Par conséquent,", "En revanche,", "De manière générale,", "Pour cette raison,", "Dans la pratique,", "À première vue,", "Autrement dit,", "Dans la plupart des cas,", "De ce point de vue,"],
  subjects: ["le dispositif proposé", "notre première analyse", "le second groupe de participants", "cette hypothèse de travail", "la procédure révisée", "la comparaison entre les deux échantillons", "l'ensemble des réponses recueillies", "chacun des indicateurs retenus", "la documentation disponible", "l'avis de la commission"],
  verbs: ["laisse penser que", "ne signifie pas que", "montre clairement que", "confirme que", "permet de comprendre pourquoi", "reste compatible avec l'idée que", "ne doit pas faire oublier que", "dépend de la question de savoir si"],
  clauses: ["les écarts observés sont plus importants que prévu", "des travaux complémentaires seront nécessaires avant toute conclusion", "les conditions locales jouent un rôle plus grand qu'on ne le suppose", "la même démarche pourrait être appliquée ailleurs", "les premières estimations étaient trop optimistes", "les bénéfices sont inégalement répartis entre les groupes", "de légères variations des hypothèses modifient le résultat", "les résultats restent stables lorsque l'échantillon est divisé", "plusieurs interprétations conviennent aux mêmes observations", "les coûts apparaissent avant les avantages"],
  tails: ["à court terme.", "dans des circonstances ordinaires.", "pour les besoins de ce rapport.", "du moins dans les cas étudiés ici.", "par rapport à l'année précédente.", "comme le montrent les sections suivantes.", "même si les exceptions ne manquent pas.", "ce qui n'a rien de surprenant."],
};
const AR = {
  openers: ["في هذا السياق،", "ونتيجة لذلك،", "ومن ناحية أخرى،", "وبصورة عامة،", "ولهذا السبب،", "ومن الناحية العملية،", "وبعبارة أخرى،", "وفي معظم الحالات،", "ومن هذا المنظور،", "وكما ذكرنا سابقا،"],
  subjects: ["الإطار المقترح", "تحليلنا الأولي", "المجموعة الثانية من المشاركين", "فرضية العمل هذه", "الإجراء المعدل", "المقارنة بين العينتين", "مجمل الإجابات التي جمعناها", "كل مؤشر من المؤشرات المختارة", "الوثائق المتوفرة لدينا", "تقييم اللجنة المكلفة"],
  verbs: ["يوحي بأن", "لا يعني أن", "يبين بوضوح أن", "يؤكد أن", "يساعد على تفسير سبب أن", "يبقى متوافقا مع الرأي القائل بأن", "لا ينبغي أن يحجب حقيقة أن", "يتوقف على معرفة ما إذا كانت"],
  clauses: ["الفروق الملحوظة أكبر مما كان متوقعا", "أعمالا إضافية ستكون ضرورية قبل استخلاص أي نتيجة", "الظروف المحلية تؤدي دورا أكبر مما يفترضه النموذج", "الطريقة نفسها يمكن تطبيقها في أماكن أخرى", "التقديرات الأولى كانت متفائلة أكثر من اللازم", "الفوائد موزعة بصورة غير متساوية بين المجموعات", "تغييرات طفيفة في الافتراضات تبدل النتيجة", "النتائج تبقى مستقرة عند تقسيم العينة", "تفسيرات عديدة تناسب الملاحظات ذاتها", "التكاليف تظهر قبل المزايا"],
  tails: ["على المدى القصير.", "في الظروف العادية.", "لأغراض هذا التقرير.", "على الأقل في الحالات المدروسة هنا.", "مقارنة بالسنة الماضية.", "كما توضح الأقسام التالية.", "وإن كانت الاستثناءات كثيرة.", "وهذا أمر غير مفاجئ."],
};

function fillerWords(language: "en" | "fr" | "ar", random: () => number, count: number): string[] {
  const bank = language === "fr" ? FR : language === "ar" ? AR : EN;
  const words: string[] = [];
  while (words.length < count) {
    words.push(...wordsOf(`${pick(bank.openers, random)} ${pick(bank.subjects, random)} ${pick(bank.verbs, random)} ${pick(bank.clauses, random)} ${pick(bank.tails, random)}`));
  }
  return words.slice(0, count);
}

const normalizedLength = (text: string) => tokensForScoringNormalization(text, CORPUS_NORMALIZATION_VERSION).length;

type Passage = { docId: string; words: string[]; edit: IntendedSource["edit"] };

class QueryBuilder {
  private readonly parts: string[] = [];
  readonly intended: IntendedSource[] = [];

  constructor(private readonly language: "en" | "fr" | "ar", private readonly random: () => number) {}

  filler(count: number, language: "en" | "fr" | "ar" = this.language) {
    if (count > 0) this.parts.push(...fillerWords(language, this.random, count));
    return this;
  }

  raw(words: string[]) {
    this.parts.push(...words);
    return this;
  }

  passage(passage: Passage) {
    this.intended.push({
      docId: passage.docId,
      words: passage.words.length,
      normalizedWords: normalizedLength(passage.words.join(" ")),
      edit: passage.edit,
      submissionWordStart: this.parts.length,
    });
    this.parts.push(...passage.words);
    return this;
  }

  text() {
    return this.parts.join(" ");
  }
}

async function buildCatalog(reader: CorpusGenerationReader): Promise<CatalogEntry[]> {
  const catalog: CatalogEntry[] = [];
  for (const slot of reader.slots) {
    if (!slot.reader) throw new Error(`segment ${slot.segmentId} is unavailable; the catalog must cover the whole generation`);
    const addenda = new Map<string, number>();
    for (const other of reader.slots) {
      if (other.partition !== slot.partition || !other.reader) continue;
      for (const addendum of await other.reader.readAliasAddenda()) addenda.set(addendum.docId, (addenda.get(addendum.docId) ?? 0) + 1);
    }
    for (let ordinal = 0; ordinal < slot.reader.documentCount; ordinal += 1) {
      const { metadata } = await slot.reader.readMetadata(ordinal);
      const record = metadata as { docId: string; canonicalSource: Record<string, unknown>; aliases: unknown[]; syntheticLoadOnly: boolean };
      const source = record.canonicalSource;
      catalog.push({
        docId: record.docId,
        tokenCount: slot.reader.tokenCounts[ordinal],
        fingerprintCount: slot.reader.fingerprintCounts[ordinal],
        language: (source.language as string | null) ?? null,
        sourceType: String(source.sourceType),
        provider: String(source.provider),
        dataset: String(source.dataset),
        externalId: String(source.externalId),
        title: (source.title as string | null) ?? null,
        syntheticLoadOnly: record.syntheticLoadOnly,
        aliasCount: record.aliases.length + (addenda.get(record.docId) ?? 0),
        partition: slot.partition,
        segmentId: slot.segmentId,
      });
    }
  }
  return catalog.sort((left, right) => (docIdFromDecimal(left.docId) < docIdFromDecimal(right.docId) ? -1 : 1));
}

async function buildQueries(reader: CorpusGenerationReader, catalog: CatalogEntry[]): Promise<BenchmarkQuery[]> {
  const random = prng(SEED);
  const used = new Set<string>();
  const real = (language: string) => catalog.filter((entry) => !entry.syntheticLoadOnly && entry.language === language);

  /** A not-yet-used real document of `language` whose length is in [minimum, maximum] tokens. */
  const choose = (language: string, minimum: number, maximum: number, filter: (entry: CatalogEntry) => boolean = () => true): CatalogEntry => {
    const pool = real(language).filter((entry) => entry.tokenCount >= minimum && entry.tokenCount <= maximum && !used.has(entry.docId) && filter(entry));
    if (pool.length === 0) throw new Error(`no unused ${language} document with ${minimum}-${maximum} tokens`);
    const chosen = pick(pool, random);
    used.add(chosen.docId);
    return chosen;
  };
  const textOf = async (entry: CatalogEntry): Promise<string> => {
    const fetched = await reader.fetchText(docIdFromDecimal(entry.docId));
    if (fetched.state !== "OK") throw new Error(`cannot read source text of ${entry.docId}: ${fetched.state}`);
    return fetched.text;
  };
  /** `count` consecutive words from the first 60% of a source (clear of any trailing reference list). */
  const passageFrom = async (entry: CatalogEntry, count: number, edit: IntendedSource["edit"] = "verbatim"): Promise<Passage> => {
    const words = wordsOf(await textOf(entry));
    const latestStart = Math.max(0, Math.floor(words.length * 0.6) - count);
    const start = Math.floor(random() * (latestStart + 1));
    const slice = words.slice(start, start + count);
    if (slice.length < count) throw new Error(`source ${entry.docId} is too short for a ${count}-word passage`);
    if (edit !== "verbatim") {
      const step = edit === "every-40th-word-replaced" ? 40 : 12;
      const replacements = inventedWords(Math.floor(random() * 1e9), Math.ceil(count / step) + 1);
      for (let index = step - 1, used = 0; index < slice.length; index += step, used += 1) slice[index] = replacements[used];
    }
    return { docId: entry.docId, words: slice, edit };
  };

  const queries: BenchmarkQuery[] = [];
  const add = (query: Omit<BenchmarkQuery, "intendedSources" | "text"> & { builder: QueryBuilder }) => {
    const { builder, ...rest } = query;
    queries.push({ ...rest, intendedSources: builder.intended, text: builder.text() });
  };
  const sizeFor = (words: number) => words * 2 + 400;

  // 1. exact source matches: the whole stored text of a document
  for (const [label, minimum, maximum] of [["small", 300, 500], ["medium", 1500, 2500], ["large", 6000, 9000]] as const) {
    const entry = choose("en", minimum, maximum);
    const words = wordsOf(await textOf(entry));
    const builder = new QueryBuilder("en", random).passage({ docId: entry.docId, words, edit: "verbatim" });
    add({ id: `exact-en-${label}`, category: "exact-document", language: "en", description: `the entire stored text of one ${label} English document (${entry.tokenCount} tokens)`, expectation: "positive", builder });
  }

  // 2. near-exact copied passages: one word in forty replaced
  for (const index of [1, 2]) {
    const entry = choose("en", sizeFor(600), 20000);
    const builder = new QueryBuilder("en", random).filler(300).passage(await passageFrom(entry, 600, "every-40th-word-replaced")).filler(300);
    add({ id: `near-exact-en-${index}`, category: "near-exact-passage", language: "en", description: "600 words from one source with every 40th word replaced, inside 600 words of original text", expectation: "positive", builder });
  }

  // 3. a heavily edited passage: one word in twelve replaced — below what the verifier admits
  {
    const entry = choose("en", sizeFor(600), 20000);
    const builder = new QueryBuilder("en", random).filler(300).passage(await passageFrom(entry, 600, "every-12th-word-replaced")).filler(300);
    add({ id: "heavy-edit-en", category: "heavily-edited-passage", language: "en", description: "600 words from one source with every 12th word replaced (no 25-word run survives)", expectation: "below-verifier-threshold", builder });
  }

  // 4. short excerpts of decreasing length, to find the smallest recoverable passage
  for (const length of [120, 80, 60, 40, 30, 25, 20, 15]) {
    const entry = choose("en", sizeFor(length), 20000);
    const builder = new QueryBuilder("en", random).filler(400).passage(await passageFrom(entry, length)).filler(400);
    add({ id: `excerpt-en-${String(length).padStart(3, "0")}`, category: "short-excerpt", language: "en", description: `${length} verbatim words from one source inside 800 words of original text`, expectation: length >= 70 ? "positive" : "below-verifier-threshold", builder });
  }

  // 5. mixed-source submissions
  for (const [index, lengths] of [[1, [300, 300, 300]], [2, [300, 300, 300]], [3, [150, 200, 250, 300, 400]], [4, [150, 200, 250, 300, 400]]] as const) {
    const builder = new QueryBuilder("en", random).filler(120);
    for (const length of lengths) builder.passage(await passageFrom(choose("en", sizeFor(length), 20000), length)).filler(120);
    add({ id: `mixed-en-${index}`, category: "mixed-source", language: "en", description: `${lengths.length} sources contributing ${lengths.join("/")} words, separated by original text`, expectation: "positive", builder });
  }

  // 6. one submission with many small contributing sources
  for (const [index, count, length, gap] of [[1, 25, 80, 60], [2, 40, 70, 40]] as const) {
    const builder = new QueryBuilder("en", random).filler(gap);
    for (let source = 0; source < count; source += 1) builder.passage(await passageFrom(choose("en", sizeFor(length), 20000), length)).filler(gap);
    add({ id: `many-small-en-${index}`, category: "many-small-sources", language: "en", description: `${count} different sources contributing ${length} words each, ${gap} original words between them`, expectation: "positive", builder });
  }

  // 7. one dominant source plus several small ones
  for (const index of [1, 2]) {
    const dominant = choose("en", 6500, 30000);
    const builder = new QueryBuilder("en", random).filler(80).passage(await passageFrom(dominant, 3000)).filler(80);
    for (let source = 0; source < 6; source += 1) builder.passage(await passageFrom(choose("en", sizeFor(80), 20000), 80)).filler(80);
    add({ id: `dominant-plus-small-en-${index}`, category: "dominant-plus-small", language: "en", description: "3,000 words from one source, then six other sources contributing 80 words each", expectation: "positive", builder });
  }

  // 8. a long submission
  {
    const builder = new QueryBuilder("en", random).filler(700);
    for (let source = 0; source < 10; source += 1) builder.passage(await passageFrom(choose("en", sizeFor(500), 20000), 500)).filler(700);
    add({ id: "long-en", category: "long-submission", language: "en", description: "a 12,700-word submission with ten sources contributing 500 words each", expectation: "positive", builder });
  }

  // 9. common-language negatives: original prose only
  for (const length of [500, 1500, 4000]) {
    add({ id: `negative-en-${length}`, category: "common-language-negative", language: "en", description: `${length} words of original common-language prose; nothing copied`, expectation: "negative", builder: new QueryBuilder("en", random).filler(length) });
  }

  // 10. legal boilerplate (the block shared by the whole synthetic family)
  add({ id: "boilerplate-only", category: "legal-boilerplate", language: "en", description: "the shared legal boilerplate block inside 600 words of original text; no source-specific text", expectation: "negative", builder: new QueryBuilder("en", random).filler(300).raw(wordsOf(SYNTHETIC_LEGAL_BOILERPLATE)).filler(300) });
  {
    const family = catalog.filter((entry) => entry.syntheticLoadOnly && entry.sourceType === "synthetic-load-only");
    const entry = pick(family, random);
    const words = wordsOf(await textOf(entry));
    const blockAt = words.indexOf("This");
    const start = blockAt > 400 ? 60 : blockAt + wordsOf(SYNTHETIC_LEGAL_BOILERPLATE).length + 40;
    const builder = new QueryBuilder("en", random).filler(200).raw(wordsOf(SYNTHETIC_LEGAL_BOILERPLATE)).filler(60)
      .passage({ docId: entry.docId, words: words.slice(start, start + 250), edit: "verbatim" }).filler(200);
    add({ id: "boilerplate-plus-specific", category: "legal-boilerplate", language: "en", description: "the shared boilerplate block plus 250 source-specific words of ONE member of the synthetic family", expectation: "positive", builder });
  }

  // 11. a document that also has an exact-duplicate alias from another provider
  if (!real("en").some((candidate) => candidate.aliasCount > 0 && candidate.tokenCount >= sizeFor(500) && candidate.tokenCount <= 20000)) {
    logLine("no English document with an alias in this generation; the duplicate-alias query is skipped");
  } else {
    const entry = choose("en", sizeFor(500), 20000, (candidate) => candidate.aliasCount > 0);
    const builder = new QueryBuilder("en", random).filler(200).passage(await passageFrom(entry, 500)).filler(200);
    add({ id: "duplicate-alias-en", category: "duplicate-alias", language: "en", description: "500 words from a document supplied by two providers (one logical document, one alias)", expectation: "positive", builder });
  }

  // 11b. a long passage that a whole family of near-duplicate documents shares, followed by small real sources.
  //      Every family member matches the long passage strongly, so a whole-document ranking fills its budget
  //      with them; the small sources only survive if retrieval looks at each region of the submission.
  {
    const familySize = catalog.filter((entry) => entry.sourceType === SYNTHETIC_NEAR_DUPLICATE_FAMILY.sourceType).length;
    if (familySize < 60) logLine(`near-duplicate family has ${familySize} members in this generation; the crowding queries are skipped`);
    else {
      const base = syntheticNearDuplicateBaseWords();
      for (const [index, shared, small] of [[1, 1500, 6], [2, 2500, 12]] as const) {
        const builder = new QueryBuilder("en", random).filler(80).raw(base.slice(100, 100 + shared)).filler(80);
        for (let source = 0; source < small; source += 1) builder.passage(await passageFrom(choose("en", sizeFor(80), 20000), 80)).filler(80);
        add({ id: `crowded-en-${index}`, category: "crowded-by-near-duplicates", language: "en", description: `${shared} words shared by all ${familySize} members of a synthetic near-duplicate family, then ${small} real sources contributing 80 words each`, expectation: "positive", builder });
      }
    }
  }

  // 12. French and Arabic, where the generation holds them
  for (const language of ["fr", "ar"] as const) {
    if (real(language).length < 10) {
      logLine(`no ${language} material in this generation; ${language} queries skipped`);
      continue;
    }
    {
      const entry = choose(language, 1500, 6000);
      const builder = new QueryBuilder(language, random).passage({ docId: entry.docId, words: wordsOf(await textOf(entry)), edit: "verbatim" });
      add({ id: `exact-${language}`, category: "exact-document", language, description: `the entire stored text of one ${language} document (${entry.tokenCount} tokens)`, expectation: "positive", builder });
    }
    {
      const builder = new QueryBuilder(language, random).filler(120);
      for (let source = 0; source < 3; source += 1) builder.passage(await passageFrom(choose(language, sizeFor(250), 40000), 250)).filler(120);
      add({ id: `mixed-${language}`, category: "mixed-source", language, description: `three ${language} sources contributing 250 words each, separated by original ${language} text`, expectation: "positive", builder });
    }
    for (const length of [80, 40]) {
      const builder = new QueryBuilder(language, random).filler(300).passage(await passageFrom(choose(language, sizeFor(length), 40000), length)).filler(300);
      add({ id: `excerpt-${language}-${String(length).padStart(3, "0")}`, category: "short-excerpt", language, description: `${length} verbatim ${language} words inside 600 words of original ${language} text`, expectation: length >= 70 ? "positive" : "below-verifier-threshold", builder });
    }
    add({ id: `negative-${language}`, category: "common-language-negative", language, description: `800 words of original common-language ${language} prose; nothing copied`, expectation: "negative", builder: new QueryBuilder(language, random).filler(800) });
  }
  if (real("fr").length >= 10 && real("ar").length >= 10) {
    const builder = new QueryBuilder("en", random).filler(150)
      .passage(await passageFrom(choose("en", sizeFor(200), 20000), 200)).filler(150)
      .passage(await passageFrom(choose("fr", sizeFor(200), 40000), 200)).filler(150, "fr")
      .passage(await passageFrom(choose("ar", sizeFor(200), 40000), 200)).filler(150, "ar");
    add({ id: "multilingual-mix", category: "multilingual-mix", language: "mixed", description: "one English, one French and one Arabic source contributing 200 words each in one submission", expectation: "positive", builder });
  }
  return queries;
}

/**
 * The 100k known-source set: about forty submissions whose sources are known
 * by construction, drawn from every provider of the 100k generation
 * (Wikipedia en/fr/ar, PMC, Federal Register, and the 10k material), plus the
 * ids of the small sample that is also verified against EVERY document.
 *
 * Two categories exist only because the 100k corpus is real enough to have
 * them: an article held in two independent editions (the 2023 Wikipedia dump
 * and the older Selective copy — a natural near-duplicate pair), and Federal
 * Register notices whose title recurs many times (a natural family of
 * documents sharing most of their wording).
 */
const SEED_100K = 20261106;
const EXHAUSTIVE_SAMPLE_100K = [
  "exact-en-small", "passage-fr-500", "passage-ar-500", "passage-fedreg-600", "mosaic-en-25x80", "dominant-pmc-plus-small",
  "long-en-12k", "neardup-wiki-1", "recurring-fedreg-1", "negative-en-1500", "multilingual-mix",
];

async function buildQueries100k(reader: CorpusGenerationReader, catalog: CatalogEntry[]): Promise<BenchmarkQuery[]> {
  const random = prng(SEED_100K);
  const used = new Set<string>();
  const real = catalog.filter((entry) => !entry.syntheticLoadOnly);
  const pools = {
    enWiki: real.filter((entry) => entry.provider === "wikimedia" && entry.dataset.endsWith(".en")),
    fr: real.filter((entry) => entry.language === "fr"),
    ar: real.filter((entry) => entry.language === "ar"),
    pmc: real.filter((entry) => entry.provider === "nih-nlm-pmc"),
    fedreg: real.filter((entry) => entry.provider === "us-gpo-govinfo"),
    selective: real.filter((entry) => entry.dataset === "selective-corpus-clean-v4"),
  };
  for (const [name, pool] of Object.entries(pools)) if (pool.length < 100) throw new Error(`the generation holds only ${pool.length} ${name} documents; this query set needs the 100k corpus`);
  const anyEnglish = [...pools.enWiki, ...pools.pmc, ...pools.fedreg, ...pools.selective];

  const choose = (pool: CatalogEntry[], minimum: number, maximum: number, filter: (entry: CatalogEntry) => boolean = () => true): CatalogEntry => {
    const eligible = pool.filter((entry) => entry.tokenCount >= minimum && entry.tokenCount <= maximum && !used.has(entry.docId) && filter(entry));
    if (eligible.length === 0) throw new Error(`no unused document with ${minimum}-${maximum} tokens in the requested pool`);
    const chosen = pick(eligible, random);
    used.add(chosen.docId);
    return chosen;
  };
  const textOf = async (entry: CatalogEntry): Promise<string> => {
    const fetched = await reader.fetchText(docIdFromDecimal(entry.docId));
    if (fetched.state !== "OK") throw new Error(`cannot read source text of ${entry.docId}: ${fetched.state}`);
    return fetched.text;
  };
  const passageFrom = async (entry: CatalogEntry, count: number, edit: IntendedSource["edit"] = "verbatim"): Promise<Passage> => {
    const words = wordsOf(await textOf(entry));
    const latestStart = Math.max(0, Math.floor(words.length * 0.6) - count);
    const start = Math.floor(random() * (latestStart + 1));
    const slice = words.slice(start, start + count);
    if (slice.length < count) throw new Error(`source ${entry.docId} is too short for a ${count}-word passage`);
    if (edit !== "verbatim") {
      const replacements = inventedWords(Math.floor(random() * 1e9), Math.ceil(count / 40) + 1);
      for (let index = 39, replaced = 0; index < slice.length; index += 40, replaced += 1) slice[index] = replacements[replaced];
    }
    return { docId: entry.docId, words: slice, edit };
  };
  const queries: BenchmarkQuery[] = [];
  const add = (query: Omit<BenchmarkQuery, "intendedSources" | "text"> & { builder: QueryBuilder }) => {
    const { builder, ...rest } = query;
    queries.push({ ...rest, intendedSources: builder.intended, text: builder.text() });
  };
  const sizeFor = (words: number) => words * 2 + 400;
  type Language = "en" | "fr" | "ar";

  // 1. whole documents
  for (const [id, pool, language, minimum, maximum] of [
    ["exact-en-small", pools.enWiki, "en", 300, 600], ["exact-en-large", pools.enWiki, "en", 6000, 9000], ["exact-fr", pools.fr, "fr", 1500, 4000],
    ["exact-ar", pools.ar, "ar", 1500, 4000], ["exact-pmc", pools.pmc, "en", 3000, 6000], ["exact-fedreg", pools.fedreg, "en", 800, 2000],
  ] as Array<[string, CatalogEntry[], Language, number, number]>) {
    const entry = choose(pool, minimum, maximum);
    const builder = new QueryBuilder(language, random).passage({ docId: entry.docId, words: wordsOf(await textOf(entry)), edit: "verbatim" });
    add({ id, category: "exact-document", language, description: `the entire stored text of one ${entry.provider}/${entry.dataset} document (${entry.tokenCount} tokens)`, expectation: "positive", builder });
  }

  // 2. one copied passage inside original text, verbatim and lightly edited
  for (const [id, pool, language, length, edit] of [
    ["passage-en-600", pools.enWiki, "en", 600, "verbatim"], ["passage-fr-500", pools.fr, "fr", 500, "verbatim"], ["passage-ar-500", pools.ar, "ar", 500, "verbatim"],
    ["passage-pmc-600", pools.pmc, "en", 600, "verbatim"], ["passage-fedreg-600", pools.fedreg, "en", 600, "verbatim"],
    ["near-exact-en", pools.enWiki, "en", 600, "every-40th-word-replaced"], ["near-exact-fr", pools.fr, "fr", 600, "every-40th-word-replaced"], ["near-exact-pmc", pools.pmc, "en", 600, "every-40th-word-replaced"],
  ] as Array<[string, CatalogEntry[], Language, number, IntendedSource["edit"]]>) {
    const builder = new QueryBuilder(language, random).filler(300).passage(await passageFrom(choose(pool, sizeFor(length), 40000), length, edit)).filler(300);
    add({ id, category: "near-exact-passage", language, description: `${length} words from one source (${edit}) inside 600 words of original text`, expectation: "positive", builder });
  }

  // 3. short excerpts
  for (const [id, pool, language, length] of [
    ["excerpt-en-120", pools.enWiki, "en", 120], ["excerpt-en-080", pools.enWiki, "en", 80], ["excerpt-fr-080", pools.fr, "fr", 80],
    ["excerpt-ar-080", pools.ar, "ar", 80], ["excerpt-pmc-100", pools.pmc, "en", 100], ["excerpt-fedreg-100", pools.fedreg, "en", 100],
  ] as Array<[string, CatalogEntry[], Language, number]>) {
    const builder = new QueryBuilder(language, random).filler(400).passage(await passageFrom(choose(pool, sizeFor(length), 40000), length)).filler(400);
    add({ id, category: "short-excerpt", language, description: `${length} verbatim words from one source inside 800 words of original text`, expectation: "positive", builder });
  }

  // 4. mosaics: many sources contributing a little each
  for (const [id, pool, language, count, length, gap] of [
    ["mosaic-en-25x80", anyEnglish, "en", 25, 80, 60], ["mosaic-en-40x70", anyEnglish, "en", 40, 70, 40], ["mosaic-fr-12x120", pools.fr, "fr", 12, 120, 60],
    ["mosaic-ar-12x120", pools.ar, "ar", 12, 120, 60], ["mosaic-pmc-15x100", pools.pmc, "en", 15, 100, 60], ["mosaic-fedreg-20x90", pools.fedreg, "en", 20, 90, 50],
  ] as Array<[string, CatalogEntry[], Language, number, number, number]>) {
    const builder = new QueryBuilder(language, random).filler(gap);
    for (let source = 0; source < count; source += 1) builder.passage(await passageFrom(choose(pool, sizeFor(length), 40000), length)).filler(gap);
    add({ id, category: "many-small-sources", language, description: `${count} different sources contributing ${length} words each, ${gap} original words between them`, expectation: "positive", builder });
  }

  // 5. one dominant source plus small ones
  for (const [id, dominantPool, smallPool] of [["dominant-pmc-plus-small", pools.pmc, pools.enWiki], ["dominant-fedreg-plus-small", pools.fedreg, pools.fedreg]] as Array<[string, CatalogEntry[], CatalogEntry[]]>) {
    const builder = new QueryBuilder("en", random).filler(80).passage(await passageFrom(choose(dominantPool, 6500, 60000), 3000)).filler(80);
    for (let source = 0; source < 6; source += 1) builder.passage(await passageFrom(choose(smallPool, sizeFor(80), 40000), 80)).filler(80);
    add({ id, category: "dominant-plus-small", language: "en", description: "3,000 words from one source, then six other sources contributing 80 words each", expectation: "positive", builder });
  }

  // 6. long submissions
  {
    const builder = new QueryBuilder("en", random).filler(700);
    for (let source = 0; source < 10; source += 1) builder.passage(await passageFrom(choose(anyEnglish, sizeFor(500), 40000), 500)).filler(700);
    add({ id: "long-en-12k", category: "long-submission", language: "en", description: "a 12,700-word submission with ten sources from four providers contributing 500 words each", expectation: "positive", builder });
  }
  {
    const builder = new QueryBuilder("fr", random).filler(500);
    for (let source = 0; source < 8; source += 1) builder.passage(await passageFrom(choose(pools.fr, sizeFor(400), 40000), 400)).filler(500);
    add({ id: "long-fr-7k", category: "long-submission", language: "fr", description: "a 7,700-word French submission with eight sources contributing 400 words each", expectation: "positive", builder });
  }

  // 7. natural near-duplicates: an article the corpus holds in two independent editions
  {
    const selectiveTitles = new Set(pools.selective.filter((entry) => entry.title && entry.tokenCount >= 1500).map((entry) => entry.title as string));
    const twins = pools.enWiki.filter((entry) => entry.title && entry.tokenCount >= 1500 && entry.tokenCount <= 40000 && selectiveTitles.has(entry.title));
    logLine(`${twins.length} English Wikipedia articles are also held as an older Selective edition`);
    for (const index of [1, 2]) {
      const entry = choose(twins, 1500, 40000);
      const builder = new QueryBuilder("en", random).filler(250).passage(await passageFrom(entry, 500)).filler(250);
      add({ id: `neardup-wiki-${index}`, category: "natural-near-duplicate", language: "en", description: `500 words from the 2023 edition of "${entry.title}", which the corpus also holds as an older edition from another dataset`, expectation: "positive", builder });
    }
  }

  // 8. recurring public notices: a Federal Register title that many documents share
  {
    const byTitle = new Map<string, CatalogEntry[]>();
    for (const entry of pools.fedreg) if (entry.title) byTitle.set(entry.title, [...(byTitle.get(entry.title) ?? []), entry]);
    const recurring = [...byTitle.values()].filter((group) => group.length >= 12).sort((left, right) => right.length - left.length || ((left[0].title as string) < (right[0].title as string) ? -1 : 1));
    logLine(`${recurring.length} Federal Register titles recur in at least 12 documents (largest: ${recurring[0]?.length ?? 0} x ${JSON.stringify(recurring[0]?.[0].title ?? null)})`);
    for (const index of [1, 2]) {
      const group = recurring[Math.floor(random() * Math.min(recurring.length, 30))];
      const entry = choose(group, 500, 40000);
      const builder = new QueryBuilder("en", random).filler(250).passage(await passageFrom(entry, 250)).filler(250);
      add({ id: `recurring-fedreg-${index}`, category: "recurring-public-notice", language: "en", description: `250 words from one of ${group.length} Federal Register documents titled "${entry.title}"`, expectation: "positive", builder });
    }
  }

  // 9. common language only
  for (const [id, language, length] of [["negative-en-1500", "en", 1500], ["negative-en-4000", "en", 4000], ["negative-fr-800", "fr", 800], ["negative-ar-800", "ar", 800]] as Array<[string, Language, number]>) {
    add({ id, category: "common-language-negative", language, description: `${length} words of original common-language prose; nothing copied`, expectation: "negative", builder: new QueryBuilder(language, random).filler(length) });
  }

  // 10. the labelled synthetic stress fixtures the 10k checkpoint used, now inside the 100k corpus
  {
    const family = catalog.filter((entry) => entry.syntheticLoadOnly && entry.sourceType === "synthetic-load-only");
    const entry = pick(family, random);
    const words = wordsOf(await textOf(entry));
    const blockAt = words.indexOf("This");
    const start = blockAt > 400 ? 60 : blockAt + wordsOf(SYNTHETIC_LEGAL_BOILERPLATE).length + 40;
    const builder = new QueryBuilder("en", random).filler(200).raw(wordsOf(SYNTHETIC_LEGAL_BOILERPLATE)).filler(60)
      .passage({ docId: entry.docId, words: words.slice(start, start + 250), edit: "verbatim" }).filler(200);
    add({ id: "boilerplate-plus-specific", category: "legal-boilerplate", language: "en", description: "the synthetic shared boilerplate block plus 250 source-specific words of one member of the synthetic family", expectation: "positive", builder });
  }
  {
    const familySize = catalog.filter((entry) => entry.sourceType === SYNTHETIC_NEAR_DUPLICATE_FAMILY.sourceType).length;
    const builder = new QueryBuilder("en", random).filler(80).raw(syntheticNearDuplicateBaseWords().slice(100, 1600)).filler(80);
    for (let source = 0; source < 6; source += 1) builder.passage(await passageFrom(choose(anyEnglish, sizeFor(80), 40000), 80)).filler(80);
    add({ id: "crowded-en", category: "crowded-by-near-duplicates", language: "en", description: `1,500 words shared by all ${familySize} members of the synthetic near-duplicate family, then six real sources contributing 80 words each`, expectation: "positive", builder });
  }
  {
    const entry = choose(pools.selective, sizeFor(500), 20000, (candidate) => candidate.aliasCount > 0);
    const builder = new QueryBuilder("en", random).filler(200).passage(await passageFrom(entry, 500)).filler(200);
    add({ id: "duplicate-alias-en", category: "duplicate-alias", language: "en", description: "500 words from a document supplied by two providers (one logical document, one alias)", expectation: "positive", builder });
  }

  // 11. three languages in one submission
  {
    const builder = new QueryBuilder("en", random).filler(150)
      .passage(await passageFrom(choose(pools.pmc, sizeFor(200), 40000), 200)).filler(150)
      .passage(await passageFrom(choose(pools.fr, sizeFor(200), 40000), 200)).filler(150, "fr")
      .passage(await passageFrom(choose(pools.ar, sizeFor(200), 40000), 200)).filler(150, "ar");
    add({ id: "multilingual-mix", category: "multilingual-mix", language: "mixed", description: "one English (PMC), one French and one Arabic source contributing 200 words each in one submission", expectation: "positive", builder });
  }
  return queries;
}

/**
 * The 1M launch-scale known-source set: new submissions drawn from the whole 1M generation (every provider and
 * language, larger mosaics and a ~20k-word submission, natural families that only a large corpus has), plus every
 * 100k known-source submission that does not depend on a synthetic fixture, reused verbatim — the 1M root holds
 * the same real documents, and a document id is derived from its normalized content, so their known sources are
 * the same ids. Sources already used by a reused submission are not drawn again.
 */
const SEED_1M = 20261107;
const EXHAUSTIVE_SAMPLE_1M = ["passage-pmc-1m", "mosaic-mixed-1m-40x80", "recurring-fedreg-1m-1", "multilingual-mix-1m"];
const SYNTHETIC_FIXTURE_QUERIES_100K = ["boilerplate-plus-specific", "crowded-en"];

async function buildQueries1m(reader: CorpusGenerationReader, catalog: CatalogEntry[], reused: BenchmarkQuery[]): Promise<BenchmarkQuery[]> {
  const random = prng(SEED_1M);
  const used = new Set<string>(reused.flatMap((query) => query.intendedSources.map((source) => source.docId)));
  const real = catalog.filter((entry) => !entry.syntheticLoadOnly);
  const pools = {
    enWiki: real.filter((entry) => entry.provider === "wikimedia" && entry.dataset.endsWith(".en")),
    fr: real.filter((entry) => entry.language === "fr"),
    ar: real.filter((entry) => entry.language === "ar"),
    pmc: real.filter((entry) => entry.provider === "nih-nlm-pmc"),
    fedreg: real.filter((entry) => entry.provider === "us-gpo-govinfo"),
    selective: real.filter((entry) => entry.dataset === "selective-corpus-clean-v4"),
  };
  for (const [name, pool] of Object.entries(pools)) if (pool.length < 1000) throw new Error(`the generation holds only ${pool.length} ${name} documents; this query set needs the 1M corpus`);
  const anyEnglish = [...pools.enWiki, ...pools.pmc, ...pools.fedreg, ...pools.selective];

  const choose = (pool: CatalogEntry[], minimum: number, maximum: number, filter: (entry: CatalogEntry) => boolean = () => true): CatalogEntry => {
    const eligible = pool.filter((entry) => entry.tokenCount >= minimum && entry.tokenCount <= maximum && !used.has(entry.docId) && filter(entry));
    if (eligible.length === 0) throw new Error(`no unused document with ${minimum}-${maximum} tokens in the requested pool`);
    const chosen = pick(eligible, random);
    used.add(chosen.docId);
    return chosen;
  };
  const textOf = async (entry: CatalogEntry): Promise<string> => {
    const fetched = await reader.fetchText(docIdFromDecimal(entry.docId));
    if (fetched.state !== "OK") throw new Error(`cannot read source text of ${entry.docId}: ${fetched.state}`);
    return fetched.text;
  };
  const passageFrom = async (entry: CatalogEntry, count: number, edit: IntendedSource["edit"] = "verbatim"): Promise<Passage> => {
    const words = wordsOf(await textOf(entry));
    const latestStart = Math.max(0, Math.floor(words.length * 0.6) - count);
    const start = Math.floor(random() * (latestStart + 1));
    const slice = words.slice(start, start + count);
    if (slice.length < count) throw new Error(`source ${entry.docId} is too short for a ${count}-word passage`);
    if (edit !== "verbatim") {
      const replacements = inventedWords(Math.floor(random() * 1e9), Math.ceil(count / 40) + 1);
      for (let index = 39, replaced = 0; index < slice.length; index += 40, replaced += 1) slice[index] = replacements[replaced];
    }
    return { docId: entry.docId, words: slice, edit };
  };
  const queries: BenchmarkQuery[] = [];
  const add = (query: Omit<BenchmarkQuery, "intendedSources" | "text"> & { builder: QueryBuilder }) => {
    const { builder, ...rest } = query;
    queries.push({ ...rest, intendedSources: builder.intended, text: builder.text() });
  };
  const sizeFor = (words: number) => words * 2 + 400;
  type Language = "en" | "fr" | "ar";

  // 1. whole documents
  for (const [id, pool, language, minimum, maximum] of [
    ["exact-en-1m", pools.enWiki, "en", 1500, 4000], ["exact-pmc-long-1m", pools.pmc, "en", 8000, 15000], ["exact-fedreg-1m", pools.fedreg, "en", 3000, 8000],
    ["exact-fr-1m", pools.fr, "fr", 800, 2500], ["exact-ar-1m", pools.ar, "ar", 800, 2500],
  ] as Array<[string, CatalogEntry[], Language, number, number]>) {
    const entry = choose(pool, minimum, maximum);
    const builder = new QueryBuilder(language, random).passage({ docId: entry.docId, words: wordsOf(await textOf(entry)), edit: "verbatim" });
    add({ id, category: "exact-document", language, description: `the entire stored text of one ${entry.provider}/${entry.dataset} document (${entry.tokenCount} tokens)`, expectation: "positive", builder });
  }

  // 2. one copied passage inside original text, verbatim and lightly edited
  for (const [id, pool, language, length, edit] of [
    ["passage-en-1m", pools.enWiki, "en", 600, "verbatim"], ["passage-fr-1m", pools.fr, "fr", 500, "verbatim"], ["passage-ar-1m", pools.ar, "ar", 500, "verbatim"],
    ["passage-pmc-1m", pools.pmc, "en", 600, "verbatim"], ["passage-fedreg-1m", pools.fedreg, "en", 600, "verbatim"],
    ["near-exact-ar-1m", pools.ar, "ar", 600, "every-40th-word-replaced"], ["near-exact-fedreg-1m", pools.fedreg, "en", 600, "every-40th-word-replaced"],
  ] as Array<[string, CatalogEntry[], Language, number, IntendedSource["edit"]]>) {
    const builder = new QueryBuilder(language, random).filler(300).passage(await passageFrom(choose(pool, sizeFor(length), 40000), length, edit)).filler(300);
    add({ id, category: "near-exact-passage", language, description: `${length} words from one source (${edit}) inside 600 words of original text`, expectation: "positive", builder });
  }

  // 3. short excerpts
  for (const [id, pool, language] of [
    ["excerpt-en-1m-080", pools.enWiki, "en"], ["excerpt-fr-1m-080", pools.fr, "fr"], ["excerpt-ar-1m-080", pools.ar, "ar"],
    ["excerpt-pmc-1m-080", pools.pmc, "en"], ["excerpt-fedreg-1m-080", pools.fedreg, "en"],
  ] as Array<[string, CatalogEntry[], Language]>) {
    const builder = new QueryBuilder(language, random).filler(400).passage(await passageFrom(choose(pool, sizeFor(80), 40000), 80)).filler(400);
    add({ id, category: "short-excerpt", language, description: "80 verbatim words from one source inside 800 words of original text", expectation: "positive", builder });
  }

  // 4. mosaics, up to 60 sources in one submission
  for (const [id, pool, language, count, length, gap] of [
    ["mosaic-mixed-1m-40x80", anyEnglish, "en", 40, 80, 40], ["mosaic-mixed-1m-60x75", anyEnglish, "en", 60, 75, 40], ["mosaic-fr-1m-20x100", pools.fr, "fr", 20, 100, 50],
    ["mosaic-ar-1m-20x100", pools.ar, "ar", 20, 100, 50], ["mosaic-pmc-1m-25x90", pools.pmc, "en", 25, 90, 50], ["mosaic-fedreg-1m-30x80", pools.fedreg, "en", 30, 80, 50],
  ] as Array<[string, CatalogEntry[], Language, number, number, number]>) {
    const builder = new QueryBuilder(language, random).filler(gap);
    for (let source = 0; source < count; source += 1) builder.passage(await passageFrom(choose(pool, sizeFor(length), 40000), length)).filler(gap);
    add({ id, category: "many-small-sources", language, description: `${count} different sources contributing ${length} words each, ${gap} original words between them`, expectation: "positive", builder });
  }

  // 5. one dominant source plus small ones
  for (const [id, language, dominantPool, dominantWords, smallPool] of [
    ["dominant-en-1m-plus-small", "en", pools.enWiki, 3000, pools.pmc], ["dominant-fr-1m-plus-small", "fr", pools.fr, 2500, pools.fr], ["dominant-ar-1m-plus-small", "ar", pools.ar, 2500, pools.ar],
  ] as Array<[string, Language, CatalogEntry[], number, CatalogEntry[]]>) {
    const builder = new QueryBuilder(language, random).filler(80).passage(await passageFrom(choose(dominantPool, Math.ceil(dominantWords / 0.6) + 200, 80000), dominantWords)).filler(80);
    for (let source = 0; source < 6; source += 1) builder.passage(await passageFrom(choose(smallPool, sizeFor(80), 40000), 80)).filler(80);
    add({ id, category: "dominant-plus-small", language, description: `${dominantWords} words from one source, then six other sources contributing 80 words each`, expectation: "positive", builder });
  }

  // 6. long submissions
  {
    const builder = new QueryBuilder("en", random).filler(700);
    for (let source = 0; source < 16; source += 1) builder.passage(await passageFrom(choose(anyEnglish, sizeFor(500), 40000), 500)).filler(700);
    add({ id: "long-mixed-1m-20k", category: "long-submission", language: "en", description: "a ~19,900-word submission with sixteen English sources from four providers contributing 500 words each", expectation: "positive", builder });
  }
  {
    const builder = new QueryBuilder("ar", random).filler(500);
    for (let source = 0; source < 8; source += 1) builder.passage(await passageFrom(choose(pools.ar, sizeFor(400), 40000), 400)).filler(500);
    add({ id: "long-ar-1m-8k", category: "long-submission", language: "ar", description: "a ~7,700-word Arabic submission with eight sources contributing 400 words each", expectation: "positive", builder });
  }

  // 7. natural families: recurring public notices, a second edition, a natural exact duplicate
  {
    const byTitle = new Map<string, CatalogEntry[]>();
    for (const entry of pools.fedreg) if (entry.title) byTitle.set(entry.title, [...(byTitle.get(entry.title) ?? []), entry]);
    // titles recurring in >= 12 documents, of which >= 3 are long enough for a 250-word passage
    const recurring = [...byTitle.values()].filter((group) => group.length >= 12 && group.filter((entry) => entry.tokenCount >= 500 && entry.tokenCount <= 40000).length >= 3).sort((left, right) => right.length - left.length || ((left[0].title as string) < (right[0].title as string) ? -1 : 1));
    logLine(`${recurring.length} Federal Register titles recur in at least 12 documents (largest: ${recurring[0]?.length ?? 0} x ${JSON.stringify(recurring[0]?.[0].title ?? null)})`);
    for (const index of [1, 2, 3]) {
      const group = recurring[Math.floor(random() * Math.min(recurring.length, 30))];
      const entry = choose(group, 500, 40000);
      const builder = new QueryBuilder("en", random).filler(250).passage(await passageFrom(entry, 250)).filler(250);
      add({ id: `recurring-fedreg-1m-${index}`, category: "recurring-public-notice", language: "en", description: `250 words from one of ${group.length} Federal Register documents titled "${entry.title}"`, expectation: "positive", builder });
    }
  }
  {
    const selectiveTitles = new Set(pools.selective.filter((entry) => entry.title && entry.tokenCount >= 1500).map((entry) => entry.title as string));
    const twins = pools.enWiki.filter((entry) => entry.title && entry.tokenCount >= 1500 && entry.tokenCount <= 40000 && selectiveTitles.has(entry.title));
    logLine(`${twins.length} English Wikipedia articles are also held as an older Selective edition`);
    const entry = choose(twins, 1500, 40000);
    const builder = new QueryBuilder("en", random).filler(250).passage(await passageFrom(entry, 500)).filler(250);
    add({ id: "neardup-wiki-1m", category: "natural-near-duplicate", language: "en", description: `500 words from the 2023 edition of "${entry.title}", which the corpus also holds as an older edition from another dataset`, expectation: "positive", builder });
  }
  {
    const entry = choose(pools.pmc, sizeFor(500), 40000, (candidate) => candidate.aliasCount > 0);
    const builder = new QueryBuilder("en", random).filler(200).passage(await passageFrom(entry, 500)).filler(200);
    add({ id: "duplicate-alias-pmc-1m", category: "duplicate-alias", language: "en", description: `500 words from a PMC article the corpus received ${entry.aliasCount + 1} times with identical normalized text (one document, ${entry.aliasCount} alias)`, expectation: "positive", builder });
  }

  // 8. common language only
  for (const [id, language, length] of [["negative-en-1m-2500", "en", 2500], ["negative-fr-1m-1200", "fr", 1200], ["negative-ar-1m-1200", "ar", 1200]] as Array<[string, Language, number]>) {
    add({ id, category: "common-language-negative", language, description: `${length} words of original common-language prose; nothing copied`, expectation: "negative", builder: new QueryBuilder(language, random).filler(length) });
  }

  // 9. three languages and two English providers in one submission
  {
    const builder = new QueryBuilder("en", random).filler(150)
      .passage(await passageFrom(choose(pools.pmc, sizeFor(200), 40000), 200)).filler(150)
      .passage(await passageFrom(choose(pools.fedreg, sizeFor(200), 40000), 200)).filler(150)
      .passage(await passageFrom(choose(pools.fr, sizeFor(200), 40000), 200)).filler(150, "fr")
      .passage(await passageFrom(choose(pools.ar, sizeFor(200), 40000), 200)).filler(150, "ar");
    add({ id: "multilingual-mix-1m", category: "multilingual-mix", language: "mixed", description: "PMC, Federal Register, French and Arabic sources contributing 200 words each in one submission", expectation: "positive", builder });
  }

  // 10. the reused 100k submissions, text unchanged. A known source absent from this generation (excluded from
  //     the launch corpus, e.g. revoked for unrecorded rights) is no longer expected: it is moved to
  //     `excludedIntendedSources`, and its passage becomes text the corpus does not hold.
  const present = new Set(catalog.map((entry) => entry.docId));
  for (const query of reused) {
    const missing = query.intendedSources.filter((source) => !present.has(source.docId));
    if (missing.length === 0) {
      queries.push(query);
      continue;
    }
    logLine(`reused submission ${query.id}: ${missing.length} known source(s) not in this generation; no longer expected`);
    queries.push({ ...query, intendedSources: query.intendedSources.filter((source) => present.has(source.docId)), excludedIntendedSources: missing });
  }
  return queries;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArguments(rest);
  const { store, reader } = await openGeneration(requireArgument(args, "root"), requireArgument(args, "generation"));
  try {
    if (command === "catalog") {
      const catalog = await buildCatalog(reader);
      const out = requireArgument(args, "out");
      if (out.endsWith(".jsonl")) {
        await writeCatalogJsonLines(out, catalog);
        writeJson(`${out}.identity.json`, { identity: reader.identity(), documentCount: catalog.length });
      } else writeJson(out, { identity: reader.identity(), documentCount: catalog.length, catalog });
      const by = (key: (entry: CatalogEntry) => string) => {
        const counts: Record<string, number> = {};
        for (const entry of catalog) counts[key(entry)] = (counts[key(entry)] ?? 0) + 1;
        return counts;
      };
      logLine(`catalog: ${catalog.length} documents — language ${JSON.stringify(by((entry) => `${entry.syntheticLoadOnly ? "synthetic" : "real"}:${entry.language ?? "null"}`))}`);
      logLine(`source types ${JSON.stringify(by((entry) => entry.sourceType))}; documents with aliases ${catalog.filter((entry) => entry.aliasCount > 0).length}`);
    } else if (command === "build") {
      const { catalog } = readJson<{ catalog: CatalogEntry[] }>(requireArgument(args, "catalog"));
      const queries = await buildQueries(reader, catalog);
      writeJson(requireArgument(args, "out"), { identity: reader.identity(), seed: SEED, queries });
      for (const query of queries) {
        logLine(`${query.id.padEnd(28)} ${query.expectation.padEnd(26)} ${String(wordsOf(query.text).length).padStart(6)} words, ${query.intendedSources.length} intended source(s)`);
      }
      logLine(`${queries.length} queries; ${queries.filter((query) => query.expectation === "positive").length} positive, ${queries.filter((query) => query.expectation === "negative").length} negative, ${queries.filter((query) => query.expectation === "below-verifier-threshold").length} below the verifier threshold`);
    } else if (command === "build-100k") {
      const { catalog } = readJson<{ catalog: CatalogEntry[] }>(requireArgument(args, "catalog"));
      const queries = await buildQueries100k(reader, catalog);
      writeJson(requireArgument(args, "out"), { identity: reader.identity(), seed: SEED_100K, queries });
      const sample = queries.filter((query) => EXHAUSTIVE_SAMPLE_100K.includes(query.id));
      if (sample.length !== EXHAUSTIVE_SAMPLE_100K.length) throw new Error("the exhaustive sample names a query that was not built");
      writeJson(requireArgument(args, "out-exhaustive-sample"), { identity: reader.identity(), seed: SEED_100K, queries: sample });
      for (const query of queries) {
        logLine(`${query.id.padEnd(28)} ${query.expectation.padEnd(10)} ${String(wordsOf(query.text).length).padStart(6)} words, ${String(query.intendedSources.length).padStart(2)} intended source(s)${EXHAUSTIVE_SAMPLE_100K.includes(query.id) ? "  [exhaustive sample]" : ""}`);
      }
      logLine(`${queries.length} queries; ${sample.length} in the full-corpus exhaustive sample`);
    } else if (command === "build-1m") {
      const catalog = await readCatalog(requireArgument(args, "catalog"));
      const reused = readJson<{ queries: BenchmarkQuery[] }>(requireArgument(args, "reuse-100k")).queries.filter((query) => !SYNTHETIC_FIXTURE_QUERIES_100K.includes(query.id));
      const queries = await buildQueries1m(reader, catalog, reused);
      writeJson(requireArgument(args, "out"), { identity: reader.identity(), seed: SEED_1M, reusedFrom100k: reused.map((query) => query.id), queries });
      const sample = queries.filter((query) => EXHAUSTIVE_SAMPLE_1M.includes(query.id));
      if (sample.length !== EXHAUSTIVE_SAMPLE_1M.length) throw new Error("the exhaustive sample names a query that was not built");
      writeJson(requireArgument(args, "out-exhaustive-sample"), { identity: reader.identity(), seed: SEED_1M, queries: sample });
      for (const query of queries) {
        logLine(`${query.id.padEnd(28)} ${query.expectation.padEnd(10)} ${String(wordsOf(query.text).length).padStart(6)} words, ${String(query.intendedSources.length).padStart(2)} intended source(s)${EXHAUSTIVE_SAMPLE_1M.includes(query.id) ? "  [exhaustive sample]" : ""}`);
      }
      logLine(`${queries.length} queries (${reused.length} reused from 100k); ${sample.length} in the full-corpus exhaustive sample`);
    } else throw new Error(`unknown command ${JSON.stringify(command)}; expected catalog | build | build-100k | build-1m`);
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
