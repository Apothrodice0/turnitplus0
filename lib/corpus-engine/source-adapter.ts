import { createReadStream, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { nodeBytes, type Bytes } from "./bytes";

/**
 * Corpus Engine v1 — the source adapter contract.
 *
 * An adapter is the ONLY thing that knows where content came from. Everything
 * downstream (normalization, deduplication, fingerprinting, packing, indexing)
 * sees a SourceDocument and nothing else, so a bulk dataset, a repository API,
 * a legal corpus, an institutional feed, a public archive and a filesystem
 * fixture are indistinguishable to the indexer.
 *
 * NEVER FABRICATE: a field the source does not supply is null. The builder
 * stores null as null; it does not derive a title from a file name or a year
 * from a retrieval date.
 */

export type SourceRights = {
  /** e.g. "CC BY-SA 4.0". */
  license: string | null;
  licenseUrl: string | null;
  /** What the corpus is permitted to do with the text, as stated by the supplier. */
  usage: string | null;
  attribution: string | null;
};

export type SourceProvenance = {
  /** How the content was obtained, e.g. "en.wikipedia.org:action=query&export". */
  acquisitionSource: string | null;
  /** ISO-8601 instant the supplier says the content was retrieved. */
  retrievedAt: string | null;
  /** The supplier's own version of the content (revision id, snapshot date, ...). */
  sourceVersion: string | null;
  notes: string | null;
};

export type SourceDocument = {
  /** Who supplied it, e.g. "wikimedia". */
  provider: string;
  /** Which of the provider's collections, e.g. "selective-corpus-clean-v4". */
  dataset: string;
  datasetVersion: string | null;
  /** The provider's own identifier; unique within (provider, dataset). */
  externalId: string;
  canonicalUrl: string | null;
  title: string | null;
  authors: string[] | null;
  /** ISO date or year string as supplied; never inferred. */
  publishedDate: string | null;
  /** e.g. "encyclopedia-article", "public-report", "synthetic-load-only". */
  sourceType: string;
  language: string | null;
  rights: SourceRights;
  provenance: SourceProvenance;
  /** Version of whatever turned the provider's bytes into `text`. */
  extractionVersion: string;
  /** Exactly the bytes the provider supplied (hashed as the raw-content hash). */
  rawContent: Bytes;
  /** The extracted text handed to normalization. */
  text: string;
  /** True for generated load-only material. Carried into provenance and reported separately. */
  syntheticLoadOnly: boolean;
};

export interface SourceAdapter {
  /** Stable identifier recorded in the build ledger. */
  readonly adapterId: string;
  /**
   * Every document once, in a DETERMINISTIC order that does not depend on
   * filesystem iteration order. (The index bytes do not depend on this order
   * at all; a stable order just makes a resumed build skip a clean prefix.)
   */
  documents(): AsyncIterable<SourceDocument>;
}

/** (provider, dataset, externalId) — a source's identity across builds. */
export function sourceKeyOf(document: Pick<SourceDocument, "provider" | "dataset" | "externalId">): string {
  for (const part of [document.provider, document.dataset, document.externalId]) {
    if (typeof part !== "string" || part.length === 0 || /[\u0000-\u001f]/.test(part)) {
      throw new Error(`source identity parts must be non-empty strings without control characters: ${JSON.stringify(part)}`);
    }
  }
  return `${document.provider}\u001f${document.dataset}\u001f${document.externalId}`;
}

const TEXT_EXTRACTION_VERSION = "utf8-text-file-v1";

function decodeTextFile(bytes: Bytes): string {
  const text = bytes.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function* readJsonLines(file: string): AsyncGenerator<Record<string, unknown>> {
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    yield JSON.parse(line) as Record<string, unknown>;
  }
}

/**
 * The deterministic local fixture adapter.
 *
 * Reads a JSON-lines manifest in which each row is a SourceDocument without
 * its content, plus `textPath` (relative to the manifest) naming a UTF-8 text
 * file. Rows are emitted sorted by externalId, so the order never depends on
 * how the manifest or the directory happened to be written.
 */
export class LocalFixtureSourceAdapter implements SourceAdapter {
  readonly adapterId: string;

  constructor(private readonly manifestPath: string, adapterId?: string) {
    this.adapterId = adapterId ?? `local-fixture:${path.basename(manifestPath)}`;
  }

  async *documents(): AsyncGenerator<SourceDocument> {
    const rows: Record<string, unknown>[] = [];
    for await (const row of readJsonLines(this.manifestPath)) rows.push(row);
    rows.sort((left, right) => (String(left.externalId) < String(right.externalId) ? -1 : String(left.externalId) > String(right.externalId) ? 1 : 0));
    const directory = path.dirname(this.manifestPath);
    for (const row of rows) {
      const rawContent = nodeBytes(readFileSync(path.join(directory, String(row.textPath))));
      const rights = (row.rights ?? {}) as Record<string, unknown>;
      const provenance = (row.provenance ?? {}) as Record<string, unknown>;
      yield {
        provider: String(row.provider),
        dataset: String(row.dataset),
        datasetVersion: stringOrNull(row.datasetVersion),
        externalId: String(row.externalId),
        canonicalUrl: stringOrNull(row.canonicalUrl),
        title: stringOrNull(row.title),
        authors: Array.isArray(row.authors) && row.authors.length > 0 ? row.authors.map(String) : null,
        publishedDate: stringOrNull(row.publishedDate),
        sourceType: String(row.sourceType ?? "unspecified"),
        language: stringOrNull(row.language),
        rights: {
          license: stringOrNull(rights.license),
          licenseUrl: stringOrNull(rights.licenseUrl),
          usage: stringOrNull(rights.usage),
          attribution: stringOrNull(rights.attribution),
        },
        provenance: {
          acquisitionSource: stringOrNull(provenance.acquisitionSource),
          retrievedAt: stringOrNull(provenance.retrievedAt),
          sourceVersion: stringOrNull(provenance.sourceVersion),
          notes: stringOrNull(provenance.notes),
        },
        extractionVersion: stringOrNull(row.extractionVersion) ?? TEXT_EXTRACTION_VERSION,
        rawContent,
        text: decodeTextFile(rawContent),
        syntheticLoadOnly: row.syntheticLoadOnly === true,
      };
    }
  }
}

const SELECTIVE_BULK_SOURCE_TYPES: Record<string, string> = {
  A_wikipedia: "encyclopedia-article",
  B_public_reports: "public-report",
  F_foundational: "foundational-reference",
};

/**
 * Minimal adapter over the EXISTING Selective Corpus bulk source staging
 * (`bulk-source-manifest.jsonl` + `raw/<docId>.txt`). Read-only: it opens the
 * manifest and the text files and writes nothing there. Field mapping only —
 * every value is the manifest's own; the manifest has no author or
 * publication-date column, so those stay null.
 */
export class SelectiveBulkManifestSourceAdapter implements SourceAdapter {
  readonly adapterId = "selective-bulk-manifest";

  constructor(
    private readonly sourceDirectory: string,
    /** `from`/`to` select a slice [from, to) of the manifest in docId order (for incremental builds). */
    private readonly options: { dataset: string; from?: number; to?: number } = { dataset: "selective-corpus-bulk" },
  ) {}

  async *documents(): AsyncGenerator<SourceDocument> {
    const rows: Record<string, unknown>[] = [];
    for await (const row of readJsonLines(path.join(this.sourceDirectory, "bulk-source-manifest.jsonl"))) {
      if (row.status === "OK") rows.push(row);
    }
    rows.sort((left, right) => (String(left.docId) < String(right.docId) ? -1 : String(left.docId) > String(right.docId) ? 1 : 0));
    const selected = rows.slice(this.options.from ?? 0, this.options.to ?? rows.length);
    for (const row of selected) {
      const rawContent = nodeBytes(readFileSync(path.join(this.sourceDirectory, "raw", `${String(row.docId)}.txt`)));
      const family = String(row.family ?? "");
      const license = stringOrNull(row.license);
      const acquisitionSource = stringOrNull(row.acquisitionSource);
      yield {
        provider: acquisitionSource?.split(":")[0] ?? "unknown-provider",
        dataset: this.options.dataset,
        datasetVersion: stringOrNull(row.corpusVersion),
        externalId: String(row.docId),
        canonicalUrl: stringOrNull(row.url),
        title: stringOrNull(row.title),
        authors: null,
        publishedDate: null,
        sourceType: SELECTIVE_BULK_SOURCE_TYPES[family] ?? (family || "unspecified"),
        language: stringOrNull(row.language),
        rights: { license, licenseUrl: null, usage: null, attribution: null },
        provenance: {
          acquisitionSource,
          retrievedAt: stringOrNull(row.retrievedAt),
          sourceVersion: stringOrNull(row.revid) ? `revid:${String(row.revid)}` : stringOrNull(row.sourceVersionDate),
          notes: [
            `family=${family}`,
            stringOrNull(row.subtype) ? `subtype=${String(row.subtype)}` : null,
            stringOrNull(row.canonicalId) ? `canonicalId=${String(row.canonicalId)}` : null,
            stringOrNull(row.sourceVersionDate) ? `sourceVersionDate=${String(row.sourceVersionDate)}` : null,
          ].filter(Boolean).join("; "),
        },
        extractionVersion: "selective-corpus-clean-v4-text",
        rawContent,
        text: decodeTextFile(rawContent),
        syntheticLoadOnly: false,
      };
    }
  }
}

/**
 * Text extractors a bundle row may name. Each turns the provider's own bytes
 * (kept verbatim as the raw content) into the text handed to normalization,
 * and is versioned by its name: changing what one does needs a new name.
 */
export const BUNDLE_EXTRACTORS: Record<string, (raw: string) => string | null> = {
  /** The provider supplied plain text; it is used as is. */
  "utf8-text-v1": (raw) => raw,
  /**
   * PMC Article Datasets `.txt`: a JOURNAL INFORMATION block and an ARTICLE
   * INFORMATION block, each under a rule line, then a third rule line, then
   * the article. The text is everything after that third rule. (The third
   * rule is usually wrapped in U+009F control characters; they are allowed
   * around a rule, and nothing else is dropped.)
   */
  "pmc-oa-txt-body-v1": (raw) => {
    const rule = /^[ \t\u0080-\u009f]*={10,}[ \t\u0080-\u009f]*\r?$/gm;
    let match: RegExpExecArray | null = null;
    for (let seen = 0; seen < 3; seen += 1) {
      match = rule.exec(raw);
      if (!match) return null;
    }
    return raw.slice((match as RegExpExecArray).index + (match as RegExpExecArray)[0].length).replace(/^\s+/, "");
  },
  /**
   * One Federal Register document element (RULE, PRORULE, NOTICE, PRESDOCU) of
   * a govinfo bulk-data issue file: block elements end a line, every other tag
   * is dropped, and the five XML entities plus numeric references are decoded.
   */
  "govinfo-fr-xml-text-v1": (raw) => raw
    .replace(/<\/(?:P|HD|FP|SUBJECT|AGENCY|SUBAGY|DEPDOC|CFR|RIN|FRDOC|BILCOD|ROW|TTITLE|TDESC|GPOTABLE|EXTRACT|LI|NAME|TITLE|DATE|SIG|FTNT|AMDPAR|SECTNO|STARS|PRTPAGE|AUTH)>/g, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_all, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim(),
};

/**
 * The bulk adapter: one JSON-lines file in which each row is a whole
 * SourceDocument — its metadata, `raw` (exactly what the provider supplied,
 * as a string) and `extraction` (which BUNDLE_EXTRACTORS entry turns `raw`
 * into text). The file is streamed, so a provider of any size costs one
 * document of memory, and there is no file per document.
 *
 * Order is the file's: whoever stages a bundle writes it sorted by
 * externalId. The adapter checks that as it reads and refuses a bundle that
 * is not strictly ascending, which also refuses a repeated externalId.
 */
export class JsonLinesBundleSourceAdapter implements SourceAdapter {
  readonly adapterId: string;

  constructor(private readonly bundlePath: string, adapterId?: string) {
    this.adapterId = adapterId ?? `jsonl-bundle:${path.basename(bundlePath)}`;
  }

  async *documents(): AsyncGenerator<SourceDocument> {
    let previous: string | null = null;
    for await (const row of readJsonLines(this.bundlePath)) {
      const externalId = String(row.externalId);
      if (previous !== null && !(previous < externalId)) {
        throw new Error(`bundle ${this.bundlePath} is not strictly ascending by externalId at ${JSON.stringify(externalId)}`);
      }
      previous = externalId;
      const extraction = String(row.extraction);
      const extractor = BUNDLE_EXTRACTORS[extraction];
      if (!extractor) throw new Error(`bundle ${this.bundlePath} names an unknown extraction ${JSON.stringify(extraction)}`);
      if (typeof row.raw !== "string") throw new Error(`bundle ${this.bundlePath} row ${JSON.stringify(externalId)} has no raw content`);
      const text = extractor(row.raw);
      if (text === null) throw new Error(`bundle ${this.bundlePath} row ${JSON.stringify(externalId)} could not be extracted by ${extraction}`);
      const rights = (row.rights ?? {}) as Record<string, unknown>;
      const provenance = (row.provenance ?? {}) as Record<string, unknown>;
      yield {
        provider: String(row.provider),
        dataset: String(row.dataset),
        datasetVersion: stringOrNull(row.datasetVersion),
        externalId,
        canonicalUrl: stringOrNull(row.canonicalUrl),
        title: stringOrNull(row.title),
        authors: Array.isArray(row.authors) && row.authors.length > 0 ? row.authors.map(String) : null,
        publishedDate: stringOrNull(row.publishedDate),
        sourceType: String(row.sourceType ?? "unspecified"),
        language: stringOrNull(row.language),
        rights: {
          license: stringOrNull(rights.license),
          licenseUrl: stringOrNull(rights.licenseUrl),
          usage: stringOrNull(rights.usage),
          attribution: stringOrNull(rights.attribution),
        },
        provenance: {
          acquisitionSource: stringOrNull(provenance.acquisitionSource),
          retrievedAt: stringOrNull(provenance.retrievedAt),
          sourceVersion: stringOrNull(provenance.sourceVersion),
          notes: stringOrNull(provenance.notes),
        },
        extractionVersion: extraction,
        rawContent: Buffer.from(row.raw, "utf8"),
        text,
        syntheticLoadOnly: false,
      };
    }
  }
}

/** Wraps in-memory documents (tests, generated load-only material). Order is the array's. */
export class InMemorySourceAdapter implements SourceAdapter {
  constructor(readonly adapterId: string, private readonly items: readonly SourceDocument[]) {}

  async *documents(): AsyncGenerator<SourceDocument> {
    for (const item of this.items) yield item;
  }
}

/** A SourceDocument from plain text, every unspecified field null. */
export function sourceDocumentFromText(
  fields: Partial<SourceDocument> & Pick<SourceDocument, "provider" | "dataset" | "externalId" | "text">,
): SourceDocument {
  return {
    datasetVersion: null,
    canonicalUrl: null,
    title: null,
    authors: null,
    publishedDate: null,
    sourceType: "unspecified",
    language: null,
    rights: { license: null, licenseUrl: null, usage: null, attribution: null },
    provenance: { acquisitionSource: null, retrievedAt: null, sourceVersion: null, notes: null },
    extractionVersion: TEXT_EXTRACTION_VERSION,
    rawContent: Buffer.from(fields.text, "utf8"),
    syntheticLoadOnly: false,
    ...fields,
  };
}
