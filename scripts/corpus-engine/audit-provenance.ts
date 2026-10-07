import type { CorpusDocumentMetadata } from "../../lib/corpus-engine/builder";
import { openGeneration } from "./benchmark-common";
import { logLine, parseArguments, requireArgument, writeJson } from "./common";

/**
 * Rights and provenance audit of a whole generation, from the metadata every
 * document stores (its canonical source and every alias).
 *
 *   audit-provenance.ts --root R --generation G --out audit.json
 *
 * For every source record it checks that the fields a launch corpus must keep
 * are present: provider, provider source id, canonical URL, retrieval time,
 * source version, licence and licence basis, raw content hash, document type,
 * and (reported separately, because some providers carry none) language. It
 * also counts documents and sources by provider / dataset / language / type /
 * licence, and real vs synthetic. Nothing is written to the corpus.
 */

type SourceRecord = {
  provider?: string;
  dataset?: string;
  datasetVersion?: string | null;
  externalId?: string;
  canonicalUrl?: string | null;
  sourceType?: string;
  language?: string | null;
  rights?: { license?: string | null; licenseUrl?: string | null; usage?: string | null; attribution?: string | null };
  provenance?: { acquisitionSource?: string | null; retrievedAt?: string | null; sourceVersion?: string | null };
  rawContentSha256?: string;
  syntheticLoadOnly?: boolean;
};

const REQUIRED: Array<[string, (source: SourceRecord) => boolean]> = [
  ["provider", (source) => Boolean(source.provider)],
  ["providerSourceId", (source) => Boolean(source.externalId)],
  ["canonicalUrl", (source) => Boolean(source.canonicalUrl)],
  ["acquisitionSource", (source) => Boolean(source.provenance?.acquisitionSource)],
  ["retrievedAt", (source) => Boolean(source.provenance?.retrievedAt)],
  ["sourceVersion", (source) => Boolean(source.provenance?.sourceVersion)],
  ["license", (source) => Boolean(source.rights?.license)],
  ["licenseBasis", (source) => Boolean(source.rights?.usage) && Boolean(source.rights?.attribution)],
  ["rawContentSha256", (source) => /^[0-9a-f]{64}$/.test(source.rawContentSha256 ?? "")],
  ["documentType", (source) => Boolean(source.sourceType)],
];

function bump(counts: Record<string, number>, key: string, by = 1) {
  counts[key] = (counts[key] ?? 0) + by;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const { store, reader } = await openGeneration(requireArgument(args, "root"), requireArgument(args, "generation"));
  const documents = { total: 0, real: 0, synthetic: 0, byProvider: {}, byDataset: {}, byLanguage: {}, bySourceType: {}, byLicense: {} } as {
    total: number; real: number; synthetic: number;
    byProvider: Record<string, number>; byDataset: Record<string, number>; byLanguage: Record<string, number>; bySourceType: Record<string, number>; byLicense: Record<string, number>;
  };
  const sources = { total: 0, canonical: 0, aliases: 0, aliasesByProvider: {} as Record<string, number>, missing: {} as Record<string, Record<string, number>>, missingLanguageByProvider: {} as Record<string, number> };
  const examples: Record<string, string> = {};
  const tokensByProvider: Record<string, number> = {};
  try {
    for (const slot of reader.slots) {
      if (!slot.reader) throw new Error(`segment ${slot.segmentId} is unavailable; the audit must cover the whole generation`);
      const addenda = new Map<string, SourceRecord[]>();
      for (const other of reader.slots) {
        if (other.partition !== slot.partition || !other.reader) continue;
        for (const addendum of await other.reader.readAliasAddenda()) addenda.set(addendum.docId, [...(addenda.get(addendum.docId) ?? []), addendum.alias as SourceRecord]);
      }
      for (let ordinal = 0; ordinal < slot.reader.documentCount; ordinal += 1) {
        const metadata = (await slot.reader.readMetadata(ordinal)).metadata as CorpusDocumentMetadata;
        const canonical = metadata.canonicalSource as SourceRecord;
        const aliases = [...(metadata.aliases as SourceRecord[]), ...(addenda.get(metadata.docId) ?? [])];
        documents.total += 1;
        if (metadata.syntheticLoadOnly) documents.synthetic += 1;
        else documents.real += 1;
        bump(documents.byProvider, String(canonical.provider));
        bump(documents.byDataset, String(canonical.dataset));
        bump(documents.byLanguage, String(canonical.language ?? "null"));
        bump(documents.bySourceType, String(canonical.sourceType));
        bump(documents.byLicense, String(canonical.rights?.license ?? "null"));
        bump(tokensByProvider, String(canonical.provider), metadata.tokenCount);
        for (const [index, source] of [canonical, ...aliases].entries()) {
          sources.total += 1;
          if (index === 0) sources.canonical += 1;
          else {
            sources.aliases += 1;
            bump(sources.aliasesByProvider, `${String(source.provider)}${source.syntheticLoadOnly ? " (synthetic)" : ""}`);
          }
          const provider = String(source.provider);
          for (const [field, ok] of REQUIRED) {
            if (ok(source)) continue;
            sources.missing[field] = sources.missing[field] ?? {};
            bump(sources.missing[field], provider);
            examples[`${field}:${provider}`] = examples[`${field}:${provider}`] ?? `${metadata.docId} ${String(source.dataset)}/${String(source.externalId)}`;
          }
          if (!source.language) bump(sources.missingLanguageByProvider, provider);
        }
      }
      logLine(`partition ${slot.partition} segment ${slot.segmentId}: ${documents.total} documents audited so far`);
    }
    const complete = Object.keys(sources.missing).length === 0;
    writeJson(requireArgument(args, "out"), { identity: reader.identity(), documents, tokensByProvider, sources, complete, examples });
    logLine(`${documents.total} documents (${documents.real} real, ${documents.synthetic} synthetic), ${sources.total} source records (${sources.aliases} aliases); required provenance ${complete ? "COMPLETE" : `INCOMPLETE: ${JSON.stringify(sources.missing)}`}`);
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
