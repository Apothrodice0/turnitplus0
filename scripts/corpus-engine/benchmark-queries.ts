import { tokensForScoringNormalization } from "../../lib/similarity-core";
import { CORPUS_NORMALIZATION_VERSION } from "../../lib/corpus-engine/versions";
import { docIdFromDecimal } from "../../lib/corpus-engine/ids";
import type { CorpusGenerationReader } from "../../lib/corpus-engine/reader";
import { openGeneration, type BenchmarkQuery, type CatalogEntry, type IntendedSource } from "./benchmark-common";
import { inventedWords, SYNTHETIC_LEGAL_BOILERPLATE, SYNTHETIC_NEAR_DUPLICATE_FAMILY, syntheticNearDuplicateBaseWords } from "./checkpoint-sources";
import { logLine, parseArguments, pick, prng, readJson, requireArgument, wordsOf, writeJson } from "./common";

/**
 * Builds the catalog of a generation and, from it, the benchmark submissions.
 *
 *   benchmark-queries.ts catalog --root R --generation G --out catalog.json
 *   benchmark-queries.ts build   --root R --generation G --catalog catalog.json --out queries.json
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

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArguments(rest);
  const { store, reader } = await openGeneration(requireArgument(args, "root"), requireArgument(args, "generation"));
  try {
    if (command === "catalog") {
      const catalog = await buildCatalog(reader);
      writeJson(requireArgument(args, "out"), { identity: reader.identity(), documentCount: catalog.length, catalog });
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
    } else throw new Error(`unknown command ${JSON.stringify(command)}; expected catalog | build`);
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
