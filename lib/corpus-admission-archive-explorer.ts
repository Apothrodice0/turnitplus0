import type { Client } from "@libsql/client";
import {
  CORPUS_ACTIVATION_DELAY_DAYS,
  parseSqliteUtc,
  resolveAdminEligibilityPredicates,
  sqliteUtcTimestamp,
  type AdminEligibilityPredicates,
} from "./user-submission-corpus";
import { getCorpusAdmissionStatusCounts } from "./corpus-admission-admin-repo";
import { isCorpusPromotionEnabled } from "./corpus-admission-promotion";
import { isCorpusSourceMatchingEnabled } from "./corpus-source-matching-flag";
import { isArchiveServerSideEnabled } from "./archive-server-flag";
import { ARCHIVE_COMPACT_FINGERPRINT_VERSION } from "./archive-fingerprint";

/**
 * Read-only data layer for the admin Archive / Corpus Explorer
 * (app/admin/archive/page.tsx, app/api/admin/archive/*). Like
 * lib/corpus-admission-admin-repo.ts it performs NO authorization of its
 * own — every caller MUST be gated by loadAdminGate() / getAdminSessionUser()
 * first. Named into the corpus-admission-* namespace deliberately (it reads
 * corpus_admission_* tables), so tests/corpus-admission-privacy.test.mjs
 * treats it as a reviewed admin-dashboard door rather than letting it sit
 * outside that guard.
 *
 * SOURCE CLASSES — a partition of what the hosted runtime can match against,
 * plus the admission intake that feeds it:
 *   reference_archive   — archive_document_representations (the hosted
 *                         built-in reference archive). Eligibility: the exact
 *                         ARCHIVE-mode predicate. No maturity window.
 *   admitted_submission — corpus_admission_decisions (every evaluated upload,
 *                         ACCEPT/REVIEW/REJECT). An ACCEPT is stored; it is
 *                         match-eligible only once promoted ('indexed') AND
 *                         the exact MATCHING-mode predicate holds for its
 *                         representation.
 *   legacy_submission   — a non-archive corpus_document_representations row
 *                         no admission promotion created (pre-admission-gate
 *                         direct indexing). Eligibility: MATCHING predicate.
 * The authoritative local 769-source library is NOT visible to this runtime
 * and is never reported here.
 *
 * "Active" is never re-derived: every eligibility bit comes from
 * resolveAdminEligibilityPredicates (lib/user-submission-corpus.ts), i.e.
 * the matchers' own admissionEligibilitySql fragments.
 *
 * PRIVACY: nothing here selects source_ref, account/device/report ids,
 * emails, retained text, or canonical_text. Submissions are labelled with a
 * privacy-safe name ("Private submission · <id prefix>"); only reference
 * archive titles (public archive metadata) are shown verbatim.
 *
 * COST: every query is bounded — pages are LIMITed (MAX_PAGE_SIZE), feeds are
 * LIMITed, the growth series is ≤ 30 day buckets. The shared `sources` CTE
 * reads no text column; the one large-row read is first_seen_at /
 * word_count on non-archive representations and on the ≤ MAX_PAGE_SIZE rows
 * of a page.
 */

export const ARCHIVE_EXPLORER_MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 25;
const MAX_QUERY_LENGTH = 200;
const ACTIVITY_LIMIT = 14;
const GROWTH_WINDOW_DAYS = 30;
/** "Added / rejected in 7 days" reporting window (UTC calendar days, incl. today) — a reporting window, unrelated to CORPUS_ACTIVATION_DELAY_DAYS. */
const RECENT_WINDOW_DAYS = 7;
const MS_PER_DAY = 86_400_000;
const FINGERPRINT_PREFIX_LENGTH = 12;

export const ARCHIVE_EXPLORER_SOURCE_CLASSES = ["reference_archive", "admitted_submission", "legacy_submission"] as const;
export type ArchiveExplorerSourceClass = (typeof ARCHIVE_EXPLORER_SOURCE_CLASSES)[number];

/**
 * active   — match-eligible now (the class's own exact predicate).
 * maturing — stored, inside the CORPUS_ACTIVATION_DELAY_DAYS window.
 * stored   — accepted and mature, but not match-eligible (not indexed yet).
 * removed  — accepted, then deactivated by an admin (revoked fingerprint).
 * review / rejected / duplicate — evaluated, never stored.
 */
export const ARCHIVE_EXPLORER_STATES = ["active", "maturing", "stored", "removed", "review", "rejected", "duplicate"] as const;
export type ArchiveExplorerState = (typeof ARCHIVE_EXPLORER_STATES)[number];

const STORED_ADMISSION_STATES: ReadonlySet<ArchiveExplorerState> = new Set(["active", "maturing", "stored", "removed"]);

export type ArchiveExplorerSort = "newest" | "oldest";

export type ArchiveExplorerListRow = {
  /** "archive:<archive_article_id>" | "admission:<decision_id>" | "legacy:<representation_id>" */
  sourceId: string;
  sourceClass: ArchiveExplorerSourceClass;
  displayName: string;
  state: ArchiveExplorerState;
  matchEligible: boolean;
  wordCount: number | null;
  /** ISO — archive row creation, decision time, or representation first_seen_at. */
  addedAt: string;
  /** ISO — T0 + CORPUS_ACTIVATION_DELAY_DAYS. null when no maturity window applies (reference archive, non-accepted decisions). */
  maturesAt: string | null;
  provenance: string;
  decision: "ACCEPT" | "REVIEW" | "REJECT" | null;
  promotionStatus: string | null;
};

export type ArchiveExplorerListParams = {
  q?: string;
  sourceClass?: ArchiveExplorerSourceClass;
  state?: ArchiveExplorerState;
  sort?: ArchiveExplorerSort;
  page?: number;
  pageSize?: number;
};

export type ArchiveExplorerFacets = {
  bySourceClass: Record<ArchiveExplorerSourceClass, number>;
  byState: Record<ArchiveExplorerState, number>;
};

export type ArchiveExplorerListResult = {
  rows: ArchiveExplorerListRow[];
  page: number;
  pageSize: number;
  totalCount: number;
  /** Counts under the search term only (class/state filters not applied) — drives the filter chips. */
  facets: ArchiveExplorerFacets;
};

// ---------------------------------------------------------------------------
// Shared CTE
// ---------------------------------------------------------------------------

type BoundSql = { sql: string; args: (string | number | null)[] };

/**
 * The single `sources` CTE every list/summary query selects from. Column
 * order and `?` order are fixed; args are returned alongside.
 *
 * Aliases: the MATCHING/ARCHIVE fragments are written over `r`; the
 * admission-backing maturity fragment over `d`. Each fragment's own inner
 * subqueries (p, ar, d, sr, adr, ...) shadow the outer aliases only inside
 * those subqueries.
 */
function sourcesCte(predicates: AdminEligibilityPredicates): BoundSql {
  const { matching, archive, admissionBackingMaturity } = predicates;
  const sql = `
    WITH archive_rows AS (
      SELECT
        adr.archive_article_id, adr.representation_id, adr.title, adr.corpus_version, adr.created_at,
        CASE WHEN EXISTS (
          SELECT 1 FROM corpus_document_representations r WHERE r.id = adr.representation_id AND ${archive.sql}
        ) THEN 1 ELSE 0 END AS match_eligible,
        (SELECT r2.canonical_sha256 FROM corpus_document_representations r2 WHERE r2.id = adr.representation_id) AS canonical_sha256
      FROM archive_document_representations adr
    ),
    admission_rows AS (
      SELECT
        d.id, d.created_at, d.decision, d.family_relation, d.extracted_word_count, d.policy_version, d.canonical_sha256,
        ar.revoked_at, p.status AS promotion_status, p.representation_id,
        CASE WHEN ${admissionBackingMaturity.sql} THEN 1 ELSE 0 END AS own_mature,
        CASE WHEN p.status = 'indexed' AND EXISTS (
          SELECT 1 FROM corpus_document_representations r WHERE r.id = p.representation_id AND ${matching.sql}
        ) THEN 1 ELSE 0 END AS match_eligible
      FROM corpus_admission_decisions d
      LEFT JOIN corpus_admission_accepted_representations ar ON ar.decision_id = d.id
      LEFT JOIN corpus_admission_promotions p ON p.decision_id = d.id
    ),
    legacy_rows AS (
      SELECT
        r.id, r.canonical_sha256, r.first_seen_at,
        CASE WHEN ${matching.sql} THEN 1 ELSE 0 END AS match_eligible
      FROM corpus_document_representations r
      WHERE NOT ${archive.sql}
        AND NOT EXISTS (
          SELECT 1 FROM corpus_admission_promotions pn
          WHERE pn.representation_id = r.id AND pn.link_type = 'NEW_CONTENT_REPRESENTATION'
        )
    ),
    sources AS (
      SELECT
        'reference_archive' AS source_class, 'archive:' || archive_article_id AS source_id, archive_article_id AS native_id,
        representation_id, title, created_at AS added_at, NULL AS maturity_t0, match_eligible,
        CASE WHEN match_eligible = 1 THEN 'active' ELSE 'stored' END AS state,
        NULL AS word_count, corpus_version AS version_label, NULL AS decision, NULL AS promotion_status, canonical_sha256
      FROM archive_rows
      UNION ALL
      SELECT
        'admitted_submission', 'admission:' || id, id,
        representation_id, NULL, created_at, CASE WHEN decision = 'ACCEPT' THEN created_at END, match_eligible,
        CASE
          WHEN decision = 'REVIEW' THEN 'review'
          WHEN decision = 'REJECT' AND family_relation IN ('EXACT_DUPLICATE', 'EDITED_VERSION') THEN 'duplicate'
          WHEN decision = 'REJECT' THEN 'rejected'
          WHEN revoked_at IS NOT NULL THEN 'removed'
          WHEN own_mature = 0 THEN 'maturing'
          WHEN match_eligible = 1 THEN 'active'
          ELSE 'stored'
        END,
        extracted_word_count, policy_version, decision, promotion_status, canonical_sha256
      FROM admission_rows
      UNION ALL
      SELECT
        'legacy_submission', 'legacy:' || id, id,
        id, NULL, first_seen_at, first_seen_at, match_eligible,
        CASE WHEN match_eligible = 1 THEN 'active' ELSE 'maturing' END,
        NULL, NULL, NULL, NULL, canonical_sha256
      FROM legacy_rows
    )
  `;
  // `?` order = textual order: archive_rows (ARCHIVE — no binds), then
  // admission_rows (backing maturity, then MATCHING), then legacy_rows
  // (MATCHING in the SELECT list, then ARCHIVE — no binds — in WHERE).
  const args = [...archive.args, ...admissionBackingMaturity.args, ...matching.args, ...matching.args, ...archive.args];
  return { sql, args };
}

// ---------------------------------------------------------------------------
// Presentation helpers (pure)
// ---------------------------------------------------------------------------

/** SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) or ISO -> ISO string. */
function toIso(value: string): string {
  return parseSqliteUtc(value).toISOString();
}

function maturesAtIso(t0: string | null): string | null {
  if (!t0) return null;
  return new Date(parseSqliteUtc(t0).getTime() + CORPUS_ACTIVATION_DELAY_DAYS * MS_PER_DAY).toISOString();
}

/** Last 8 alphanumerics — the random tail of a UUID, so ids sharing a prefix still read apart. */
function shortId(id: string): string {
  return id.replace(/[^0-9a-z]/gi, "").slice(-8).toLowerCase();
}

/** Privacy-safe display name. Only reference-archive titles (public archive metadata) are shown verbatim. */
export function archiveExplorerDisplayName(sourceClass: ArchiveExplorerSourceClass, nativeId: string, title: string | null): string {
  if (sourceClass === "reference_archive") return title && title.trim() ? title : `Reference source · ${nativeId}`;
  if (sourceClass === "admitted_submission") return `Private submission · ${shortId(nativeId)}`;
  return `Legacy submission · ${shortId(nativeId)}`;
}

function provenanceFor(sourceClass: ArchiveExplorerSourceClass, versionLabel: string | null): string {
  if (sourceClass === "reference_archive") return versionLabel ? `Reference archive · ${versionLabel}` : "Reference archive";
  if (sourceClass === "admitted_submission") return versionLabel ? `Account upload · ${versionLabel}` : "Account upload";
  return "Direct submission index (pre-admission gate)";
}

function fingerprintPrefix(sha: string | null): string | null {
  return sha ? sha.slice(0, FINGERPRINT_PREFIX_LENGTH) : null;
}

function emptyFacets(): ArchiveExplorerFacets {
  return {
    bySourceClass: Object.fromEntries(ARCHIVE_EXPLORER_SOURCE_CLASSES.map((c) => [c, 0])) as Record<ArchiveExplorerSourceClass, number>,
    byState: Object.fromEntries(ARCHIVE_EXPLORER_STATES.map((s) => [s, 0])) as Record<ArchiveExplorerState, number>,
  };
}

export function isArchiveExplorerSourceClass(value: unknown): value is ArchiveExplorerSourceClass {
  return typeof value === "string" && (ARCHIVE_EXPLORER_SOURCE_CLASSES as readonly string[]).includes(value);
}

export function isArchiveExplorerState(value: unknown): value is ArchiveExplorerState {
  return typeof value === "string" && (ARCHIVE_EXPLORER_STATES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

type RawSourceRow = {
  source_class: ArchiveExplorerSourceClass;
  source_id: string;
  native_id: string;
  representation_id: string | null;
  title: string | null;
  added_at: string;
  maturity_t0: string | null;
  match_eligible: number | bigint;
  state: ArchiveExplorerState;
  word_count: number | bigint | null;
  version_label: string | null;
  decision: string | null;
  promotion_status: string | null;
};

/**
 * Search matches a reference title (case-insensitive), a source id, or — for
 * a hex term of 6+ characters — a fingerprint prefix. instr(), never LIKE, so
 * `%`/`_` in the term are literal. Never matches source_ref (account/device/
 * report ids).
 */
function searchCondition(q: string | undefined): BoundSql {
  const term = (q ?? "").trim().slice(0, MAX_QUERY_LENGTH);
  if (!term) return { sql: "", args: [] };
  if (/^[0-9a-f]{6,64}$/i.test(term)) {
    return {
      sql: "(instr(lower(COALESCE(title, '')), lower(?)) > 0 OR instr(source_id, ?) > 0 OR instr(COALESCE(canonical_sha256, ''), lower(?)) = 1)",
      args: [term, term, term],
    };
  }
  return { sql: "(instr(lower(COALESCE(title, '')), lower(?)) > 0 OR instr(source_id, ?) > 0)", args: [term, term] };
}

export async function listArchiveExplorerSources(
  client: Client,
  params: ArchiveExplorerListParams,
  options: { asOf?: Date } = {},
): Promise<ArchiveExplorerListResult> {
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const pageSize = Math.min(ARCHIVE_EXPLORER_MAX_PAGE_SIZE, Math.max(1, Math.floor(params.pageSize ?? DEFAULT_PAGE_SIZE)));
  const offset = (page - 1) * pageSize;
  const predicates = await resolveAdminEligibilityPredicates(client, options.asOf ?? new Date());
  const cte = sourcesCte(predicates);
  const search = searchCondition(params.q);

  const facetResult = await client.execute({
    sql: `${cte.sql} SELECT source_class, state, COUNT(*) AS n FROM sources ${search.sql ? `WHERE ${search.sql}` : ""} GROUP BY source_class, state`,
    args: [...cte.args, ...search.args],
  });
  const facets = emptyFacets();
  let totalCount = 0;
  for (const row of facetResult.rows as unknown as { source_class: ArchiveExplorerSourceClass; state: ArchiveExplorerState; n: number | bigint }[]) {
    const n = Number(row.n);
    facets.bySourceClass[row.source_class] += n;
    facets.byState[row.state] += n;
    if ((!params.sourceClass || params.sourceClass === row.source_class) && (!params.state || params.state === row.state)) totalCount += n;
  }

  const conditions: string[] = [];
  const conditionArgs: (string | number | null)[] = [];
  if (search.sql) {
    conditions.push(search.sql);
    conditionArgs.push(...search.args);
  }
  if (params.sourceClass) {
    conditions.push("source_class = ?");
    conditionArgs.push(params.sourceClass);
  }
  if (params.state) {
    conditions.push("state = ?");
    conditionArgs.push(params.state);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const direction = params.sort === "oldest" ? "ASC" : "DESC";
  const pageResult = await client.execute({
    sql: `${cte.sql}
      SELECT source_class, source_id, native_id, representation_id, title, added_at, maturity_t0, match_eligible, state,
             word_count, version_label, decision, promotion_status
      FROM sources ${where}
      ORDER BY added_at ${direction}, source_id ASC
      LIMIT ? OFFSET ?`,
    args: [...cte.args, ...conditionArgs, pageSize, offset],
  });
  const rawRows = pageResult.rows as unknown as RawSourceRow[];

  // Word counts for archive/legacy rows live on the representation, after
  // its canonical_text column — fetched for this page's rows only.
  const representationIds = rawRows
    .filter((row) => row.source_class !== "admitted_submission" && row.representation_id)
    .map((row) => row.representation_id as string);
  const wordCountById = await loadRepresentationWordCounts(client, representationIds);

  const rows = rawRows.map((row): ArchiveExplorerListRow => {
    const wordCount = row.source_class === "admitted_submission"
      ? (row.word_count === null ? null : Number(row.word_count))
      : (row.representation_id ? wordCountById.get(row.representation_id) ?? null : null);
    return {
      sourceId: row.source_id,
      sourceClass: row.source_class,
      displayName: archiveExplorerDisplayName(row.source_class, row.native_id, row.title),
      state: row.state,
      matchEligible: Number(row.match_eligible) === 1,
      wordCount,
      addedAt: toIso(row.added_at),
      maturesAt: maturesAtIso(row.maturity_t0),
      provenance: provenanceFor(row.source_class, row.version_label),
      decision: row.decision as ArchiveExplorerListRow["decision"],
      promotionStatus: row.promotion_status,
    };
  });

  return { rows, page, pageSize, totalCount, facets };
}

async function loadRepresentationWordCounts(client: Client, representationIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (representationIds.length === 0) return map;
  const unique = [...new Set(representationIds)].slice(0, ARCHIVE_EXPLORER_MAX_PAGE_SIZE);
  const result = await client.execute({
    sql: `SELECT id, word_count FROM corpus_document_representations WHERE id IN (${unique.map(() => "?").join(",")})`,
    args: unique,
  });
  for (const row of result.rows as unknown as { id: string; word_count: number | bigint }[]) map.set(row.id, Number(row.word_count));
  return map;
}

// ---------------------------------------------------------------------------
// Summary: metrics, lifecycle, growth, activity
// ---------------------------------------------------------------------------

export type ArchiveExplorerGrowthDay = {
  /** 'YYYY-MM-DD' (UTC) */
  day: string;
  accepted: number;
  duplicate: number;
  rejected: number;
  review: number;
  referenceAdded: number;
  legacyAdded: number;
};

export type ArchiveExplorerActivityKind = "admitted" | "duplicate" | "rejected" | "review" | "matured" | "indexed" | "removed" | "reference_added" | "legacy_added";

export type ArchiveExplorerActivityEvent = {
  kind: ArchiveExplorerActivityKind;
  /** ISO */
  at: string;
  /** Opens the detail panel; null for grouped (bulk) events. */
  sourceId: string | null;
  label: string;
  /** Grouped events (reference / legacy additions) — how many sources on that day. */
  count: number | null;
};

export type ArchiveExplorerSummary = {
  generatedAt: string;
  maturityWindowDays: number;
  maturityCutoff: string;
  flags: { promotionEnabled: boolean; sourceMatchingEnabled: boolean; archiveServerSideEnabled: boolean };
  /** Distinct match-eligible sources right now (representation level). */
  activeMatchingSources: { total: number; referenceArchive: number; priorSubmissions: number };
  referenceArchive: {
    total: number;
    active: number;
    corpusVersions: { version: string; count: number }[];
    activeFingerprintVersion: string;
    fingerprintedUnderActiveVersion: number;
  };
  /** Admission records (decision level). storedTotal = active + maturing + awaitingIndex. */
  admissions: {
    storedTotal: number;
    active: number;
    maturing: number;
    awaitingIndex: number;
    removed: number;
    review: number;
    rejected: number;
    duplicate: number;
    evaluated: number;
    pendingEvaluation: number;
    failedEvaluation: number;
    /** lib/corpus-admission-admin-repo.ts's own activeRepresentations — the existing /admin/corpus "Total corpus representations" figure. */
    existingDashboardActiveRepresentations: number;
  };
  legacy: { total: number; active: number; maturing: number };
  added: { today: number; last7Days: number; last30Days: number };
  rejectedOrDuplicate: { total: number; last7Days: number };
  growth: ArchiveExplorerGrowthDay[];
  activity: ArchiveExplorerActivityEvent[];
};

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

type SourceBuckets = {
  count: (sourceClass: ArchiveExplorerSourceClass, state: ArchiveExplorerState) => number;
  classTotal: (sourceClass: ArchiveExplorerSourceClass) => number;
  added: { today: number; last7Days: number; last30Days: number };
  rejectedOrDuplicateLast7Days: number;
  growth: ArchiveExplorerGrowthDay[];
};

/**
 * One pass over the shared `sources` CTE: all-time totals per (class,
 * state), plus per-day buckets for the last GROWTH_WINDOW_DAYS UTC days.
 * The SINGLE derivation behind every state / added / rejected figure — used
 * by both getArchiveExplorerSummary (/admin/archive) and
 * getArchiveExplorerCardMetrics (the /admin launcher card).
 */
async function loadSourceBuckets(client: Client, predicates: AdminEligibilityPredicates, asOf: Date): Promise<SourceBuckets> {
  const cte = sourcesCte(predicates);
  const todayStart = new Date(`${utcDay(asOf)}T00:00:00.000Z`);
  const windowStart = new Date(todayStart.getTime() - (GROWTH_WINDOW_DAYS - 1) * MS_PER_DAY);
  const result = await client.execute({
    sql: `${cte.sql}
      SELECT CASE WHEN added_at >= ? THEN substr(added_at, 1, 10) ELSE NULL END AS day, source_class, state, COUNT(*) AS n
      FROM sources GROUP BY 1, 2, 3`,
    args: [...cte.args, sqliteUtcTimestamp(windowStart)],
  });

  const todayKey = utcDay(asOf);
  const recentWindowKey = utcDay(new Date(todayStart.getTime() - (RECENT_WINDOW_DAYS - 1) * MS_PER_DAY));
  const totals = new Map<string, number>();
  const growthByDay = new Map<string, ArchiveExplorerGrowthDay>();
  for (let i = 0; i < GROWTH_WINDOW_DAYS; i += 1) {
    const day = utcDay(new Date(windowStart.getTime() + i * MS_PER_DAY));
    growthByDay.set(day, { day, accepted: 0, duplicate: 0, rejected: 0, review: 0, referenceAdded: 0, legacyAdded: 0 });
  }
  const added = { today: 0, last7Days: 0, last30Days: 0 };
  let rejectedOrDuplicateLast7Days = 0;

  for (const row of result.rows as unknown as { day: string | null; source_class: ArchiveExplorerSourceClass; state: ArchiveExplorerState; n: number | bigint }[]) {
    const n = Number(row.n);
    const key = `${row.source_class}:${row.state}`;
    totals.set(key, (totals.get(key) ?? 0) + n);
    if (row.day === null) continue;
    const isAddedSource = row.source_class !== "admitted_submission" || STORED_ADMISSION_STATES.has(row.state);
    if (isAddedSource) {
      added.last30Days += n;
      if (row.day >= recentWindowKey) added.last7Days += n;
      if (row.day === todayKey) added.today += n;
    } else if ((row.state === "duplicate" || row.state === "rejected") && row.day >= recentWindowKey) {
      rejectedOrDuplicateLast7Days += n;
    }
    const bucket = growthByDay.get(row.day);
    if (!bucket) continue;
    if (row.source_class === "reference_archive") bucket.referenceAdded += n;
    else if (row.source_class === "legacy_submission") bucket.legacyAdded += n;
    else if (STORED_ADMISSION_STATES.has(row.state)) bucket.accepted += n;
    else if (row.state === "duplicate") bucket.duplicate += n;
    else if (row.state === "rejected") bucket.rejected += n;
    else if (row.state === "review") bucket.review += n;
  }

  const count = (sourceClass: ArchiveExplorerSourceClass, state: ArchiveExplorerState) => totals.get(`${sourceClass}:${state}`) ?? 0;
  const classTotal = (sourceClass: ArchiveExplorerSourceClass) => ARCHIVE_EXPLORER_STATES.reduce((sum, state) => sum + count(sourceClass, state), 0);
  return { count, classTotal, added, rejectedOrDuplicateLast7Days, growth: [...growthByDay.values()] };
}

/** Distinct non-archive representations the exact MATCHING predicate admits right now. */
async function countMatchEligiblePriorSubmissions(client: Client, predicates: AdminEligibilityPredicates): Promise<number> {
  const result = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM corpus_document_representations r WHERE NOT ${predicates.archive.sql} AND ${predicates.matching.sql}`,
    args: [...predicates.archive.args, ...predicates.matching.args],
  });
  return Number((result.rows[0] as unknown as { n: number | bigint }).n);
}

function deriveActiveMatchingSources(buckets: SourceBuckets, priorSubmissions: number): ArchiveExplorerSummary["activeMatchingSources"] {
  const referenceArchive = buckets.count("reference_archive", "active");
  return { total: referenceArchive + priorSubmissions, referenceArchive, priorSubmissions };
}

export type ArchiveExplorerCardMetrics = {
  /** Same value as ArchiveExplorerSummary.activeMatchingSources.total. */
  active: number;
  /** Same value as ArchiveExplorerSummary.added.last7Days. */
  addedLast7Days: number;
  /** Same value as ArchiveExplorerSummary.admissions.maturing. */
  maturing: number;
  /** Same value as ArchiveExplorerSummary.rejectedOrDuplicate.last7Days. */
  rejectedOrDuplicateLast7Days: number;
};

/**
 * The four live figures on the /admin launcher's Archive card — a
 * summary-only subset of getArchiveExplorerSummary built from the SAME
 * helpers (loadSourceBuckets, countMatchEligiblePriorSubmissions,
 * deriveActiveMatchingSources), without the activity feed, growth series,
 * fingerprint coverage or status counts the full page needs. Read-only;
 * same "no authorization of its own" contract as the rest of this module.
 */
export async function getArchiveExplorerCardMetrics(client: Client, options: { asOf?: Date } = {}): Promise<ArchiveExplorerCardMetrics> {
  const asOf = options.asOf ?? new Date();
  const predicates = await resolveAdminEligibilityPredicates(client, asOf);
  const [buckets, priorSubmissions] = await Promise.all([
    loadSourceBuckets(client, predicates, asOf),
    countMatchEligiblePriorSubmissions(client, predicates),
  ]);
  return {
    active: deriveActiveMatchingSources(buckets, priorSubmissions).total,
    addedLast7Days: buckets.added.last7Days,
    maturing: buckets.count("admitted_submission", "maturing"),
    rejectedOrDuplicateLast7Days: buckets.rejectedOrDuplicateLast7Days,
  };
}

export async function getArchiveExplorerSummary(client: Client, options: { asOf?: Date } = {}): Promise<ArchiveExplorerSummary> {
  const asOf = options.asOf ?? new Date();
  const predicates = await resolveAdminEligibilityPredicates(client, asOf);

  const [buckets, priorSubmissions, archiveCoverageResult, statusCounts, activity] = await Promise.all([
    loadSourceBuckets(client, predicates, asOf),
    countMatchEligiblePriorSubmissions(client, predicates),
    client.execute({
      sql: `SELECT adr.corpus_version AS version, COUNT(*) AS n,
              SUM(CASE WHEN EXISTS (
                SELECT 1 FROM archive_document_fingerprints f
                WHERE f.representation_id = adr.representation_id AND f.fingerprint_version = ?
              ) THEN 1 ELSE 0 END) AS fingerprinted
            FROM archive_document_representations adr GROUP BY adr.corpus_version ORDER BY adr.corpus_version`,
      args: [ARCHIVE_COMPACT_FINGERPRINT_VERSION],
    }),
    getCorpusAdmissionStatusCounts(client),
    loadActivity(client, predicates, asOf),
  ]);

  const { count, classTotal } = buckets;
  const activeMatchingSources = deriveActiveMatchingSources(buckets, priorSubmissions);
  const archiveVersions = (archiveCoverageResult.rows as unknown as { version: string; n: number | bigint; fingerprinted: number | bigint | null }[]).map((row) => ({
    version: row.version,
    count: Number(row.n),
    fingerprinted: Number(row.fingerprinted ?? 0),
  }));

  const admissions = {
    active: count("admitted_submission", "active"),
    maturing: count("admitted_submission", "maturing"),
    awaitingIndex: count("admitted_submission", "stored"),
    removed: count("admitted_submission", "removed"),
    review: count("admitted_submission", "review"),
    rejected: count("admitted_submission", "rejected"),
    duplicate: count("admitted_submission", "duplicate"),
  };

  return {
    generatedAt: asOf.toISOString(),
    maturityWindowDays: CORPUS_ACTIVATION_DELAY_DAYS,
    maturityCutoff: toIso(predicates.maturityCutoff),
    flags: {
      promotionEnabled: isCorpusPromotionEnabled(),
      sourceMatchingEnabled: isCorpusSourceMatchingEnabled(),
      archiveServerSideEnabled: isArchiveServerSideEnabled(),
    },
    activeMatchingSources,
    referenceArchive: {
      total: classTotal("reference_archive"),
      active: activeMatchingSources.referenceArchive,
      corpusVersions: archiveVersions.map(({ version, count: n }) => ({ version, count: n })),
      activeFingerprintVersion: ARCHIVE_COMPACT_FINGERPRINT_VERSION,
      fingerprintedUnderActiveVersion: archiveVersions.reduce((sum, v) => sum + v.fingerprinted, 0),
    },
    admissions: {
      storedTotal: admissions.active + admissions.maturing + admissions.awaitingIndex,
      ...admissions,
      evaluated: classTotal("admitted_submission"),
      pendingEvaluation: statusCounts.pending,
      failedEvaluation: statusCounts.failed,
      existingDashboardActiveRepresentations: statusCounts.activeRepresentations,
    },
    legacy: {
      total: classTotal("legacy_submission"),
      active: count("legacy_submission", "active"),
      maturing: count("legacy_submission", "maturing"),
    },
    added: buckets.added,
    rejectedOrDuplicate: { total: admissions.rejected + admissions.duplicate, last7Days: buckets.rejectedOrDuplicateLast7Days },
    growth: buckets.growth,
    activity,
  };
}

/**
 * Recent corpus activity, derived ONLY from existing timestamps — no event
 * log. Each source is LIMITed, then merged and cut to ACTIVITY_LIMIT.
 * "matured" is derived (decision T0 + CORPUS_ACTIVATION_DELAY_DAYS, for an
 * ACCEPT whose window has elapsed) — it states that the window elapsed; the
 * separate "indexed" event is what match eligibility additionally needs.
 */
async function loadActivity(client: Client, predicates: AdminEligibilityPredicates, asOf: Date): Promise<ArchiveExplorerActivityEvent[]> {
  const nowSql = sqliteUtcTimestamp(asOf);
  const [decisions, matured, indexed, removed, referenceAdds, legacyAdds] = await Promise.all([
    client.execute({
      sql: `SELECT id, created_at AS at, decision, family_relation FROM corpus_admission_decisions
            WHERE created_at <= ? ORDER BY created_at DESC, id LIMIT ?`,
      args: [nowSql, ACTIVITY_LIMIT],
    }),
    client.execute({
      sql: `SELECT d.id, d.created_at AS t0 FROM corpus_admission_decisions d
            JOIN corpus_admission_accepted_representations ar ON ar.decision_id = d.id
            WHERE d.decision = 'ACCEPT' AND d.created_at <= ? ORDER BY d.created_at DESC, d.id LIMIT ?`,
      args: [predicates.maturityCutoff, ACTIVITY_LIMIT],
    }),
    client.execute({
      sql: `SELECT decision_id AS id, updated_at AS at FROM corpus_admission_promotions
            WHERE status = 'indexed' AND updated_at <= ? ORDER BY updated_at DESC, decision_id LIMIT ?`,
      args: [nowSql, ACTIVITY_LIMIT],
    }),
    client.execute({
      sql: `SELECT decision_id AS id, revoked_at AS at FROM corpus_admission_accepted_representations
            WHERE revoked_at IS NOT NULL AND revoked_at <= ? ORDER BY revoked_at DESC, decision_id LIMIT ?`,
      args: [nowSql, ACTIVITY_LIMIT],
    }),
    client.execute({
      sql: `SELECT corpus_version AS version, substr(created_at, 1, 10) AS day, MAX(created_at) AS at, COUNT(*) AS n
            FROM archive_document_representations WHERE created_at <= ?
            GROUP BY corpus_version, day ORDER BY at DESC LIMIT ?`,
      args: [nowSql, ACTIVITY_LIMIT],
    }),
    client.execute({
      sql: `SELECT substr(r.first_seen_at, 1, 10) AS day, MAX(r.first_seen_at) AS at, COUNT(*) AS n
            FROM corpus_document_representations r
            WHERE r.first_seen_at <= ? AND NOT ${predicates.archive.sql}
              AND NOT EXISTS (
                SELECT 1 FROM corpus_admission_promotions pn
                WHERE pn.representation_id = r.id AND pn.link_type = 'NEW_CONTENT_REPRESENTATION'
              )
            GROUP BY day ORDER BY at DESC LIMIT ?`,
      args: [nowSql, ...predicates.archive.args, ACTIVITY_LIMIT],
    }),
  ]);

  const events: ArchiveExplorerActivityEvent[] = [];
  for (const row of decisions.rows as unknown as { id: string; at: string; decision: string; family_relation: string | null }[]) {
    const kind: ArchiveExplorerActivityKind = row.decision === "ACCEPT"
      ? "admitted"
      : row.decision === "REVIEW"
        ? "review"
        : row.family_relation === "EXACT_DUPLICATE" || row.family_relation === "EDITED_VERSION" ? "duplicate" : "rejected";
    events.push({ kind, at: toIso(row.at), sourceId: `admission:${row.id}`, label: archiveExplorerDisplayName("admitted_submission", row.id, null), count: null });
  }
  for (const row of matured.rows as unknown as { id: string; t0: string }[]) {
    events.push({ kind: "matured", at: maturesAtIso(row.t0) as string, sourceId: `admission:${row.id}`, label: archiveExplorerDisplayName("admitted_submission", row.id, null), count: null });
  }
  for (const row of indexed.rows as unknown as { id: string; at: string }[]) {
    events.push({ kind: "indexed", at: toIso(row.at), sourceId: `admission:${row.id}`, label: archiveExplorerDisplayName("admitted_submission", row.id, null), count: null });
  }
  for (const row of removed.rows as unknown as { id: string; at: string }[]) {
    events.push({ kind: "removed", at: toIso(row.at), sourceId: `admission:${row.id}`, label: archiveExplorerDisplayName("admitted_submission", row.id, null), count: null });
  }
  for (const row of referenceAdds.rows as unknown as { version: string; at: string; n: number | bigint }[]) {
    events.push({ kind: "reference_added", at: toIso(row.at), sourceId: null, label: `Reference archive · ${row.version}`, count: Number(row.n) });
  }
  for (const row of legacyAdds.rows as unknown as { at: string; n: number | bigint }[]) {
    events.push({ kind: "legacy_added", at: toIso(row.at), sourceId: null, label: "Legacy submission index", count: Number(row.n) });
  }
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return events.slice(0, ACTIVITY_LIMIT);
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

type DetailCommon = {
  sourceId: string;
  sourceClass: ArchiveExplorerSourceClass;
  displayName: string;
  state: ArchiveExplorerState;
  matchEligible: boolean;
  /** Which matcher predicate `matchEligible` came from. */
  eligibilityMode: "ARCHIVE" | "MATCHING";
  wordCount: number | null;
  language: string | null;
  addedAt: string;
  maturityWindowDays: number;
  /** ISO — the single instant eligibility and maturity were evaluated at. */
  evaluatedAt: string;
  /** null = no maturity window applies to this source. */
  maturesAt: string | null;
  mature: boolean | null;
  provenance: string;
  /** First FINGERPRINT_PREFIX_LENGTH hex chars of the canonical SHA-256 — never the text. */
  fingerprintPrefix: string | null;
};

export type ArchiveExplorerDetail =
  | (DetailCommon & {
      sourceClass: "reference_archive";
      archiveArticleId: string;
      sourceType: string;
      corpusVersion: string;
      seedFingerprintVersion: string;
      archiveOrder: number | null;
      activeFingerprintVersion: string;
      fingerprintsUnderActiveVersion: number;
    })
  | (DetailCommon & {
      sourceClass: "admitted_submission";
      decisionId: string;
      decision: "ACCEPT" | "REVIEW" | "REJECT";
      policyVersion: string;
      reasonCodes: string[];
      hardGatePassed: boolean;
      hardGateFailureCodes: string[];
      detectedFormat: string | null;
      languageConfidence: number | null;
      qualityScore: number | null;
      corpusValueScore: number | null;
      familyRelation: string | null;
      familyContainment: number | null;
      storedFingerprint: "active" | "removed" | null;
      removedAt: string | null;
      hasRetainedText: boolean;
      maturityExemptionApplies: boolean;
      promotionStatus: string | null;
      promotionAttemptCount: number | null;
      promotionLinkType: string | null;
      indexedAt: string | null;
    })
  | (DetailCommon & {
      sourceClass: "legacy_submission";
      representationId: string;
      submissionReferenceCount: number;
      indexedAdmissionBackings: number;
      canonicalizationVersion: string;
      extractorVersion: string | null;
    });

function safeJsonStringArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Splits "archive:<id>" / "admission:<id>" / "legacy:<id>". null for anything else. */
export function parseArchiveExplorerSourceId(sourceId: string): { sourceClass: ArchiveExplorerSourceClass; nativeId: string } | null {
  const match = /^(archive|admission|legacy):(.+)$/.exec(sourceId);
  if (!match || match[2].length > 200) return null;
  const sourceClass: ArchiveExplorerSourceClass = match[1] === "archive" ? "reference_archive" : match[1] === "admission" ? "admitted_submission" : "legacy_submission";
  return { sourceClass, nativeId: match[2] };
}

export async function getArchiveExplorerSourceDetail(client: Client, sourceId: string, options: { asOf?: Date } = {}): Promise<ArchiveExplorerDetail | null> {
  const parsed = parseArchiveExplorerSourceId(sourceId);
  if (!parsed) return null;
  const asOf = options.asOf ?? new Date();
  const predicates = await resolveAdminEligibilityPredicates(client, asOf);
  if (parsed.sourceClass === "reference_archive") return loadArchiveDetail(client, predicates, parsed.nativeId, asOf);
  if (parsed.sourceClass === "admitted_submission") return loadAdmissionDetail(client, predicates, parsed.nativeId, asOf);
  return loadLegacyDetail(client, predicates, parsed.nativeId, asOf);
}

async function loadArchiveDetail(client: Client, predicates: AdminEligibilityPredicates, articleId: string, asOf: Date): Promise<ArchiveExplorerDetail | null> {
  const result = await client.execute({
    sql: `SELECT adr.archive_article_id, adr.representation_id, adr.title, adr.source_type, adr.corpus_version,
                 adr.fingerprint_version, adr.archive_order, adr.created_at,
                 r.canonical_sha256, r.word_count, r.language,
                 CASE WHEN ${predicates.archive.sql} THEN 1 ELSE 0 END AS match_eligible,
                 (SELECT COUNT(*) FROM archive_document_fingerprints f
                  WHERE f.representation_id = r.id AND f.fingerprint_version = ?) AS active_fingerprints
          FROM archive_document_representations adr
          JOIN corpus_document_representations r ON r.id = adr.representation_id
          WHERE adr.archive_article_id = ?`,
    args: [...predicates.archive.args, ARCHIVE_COMPACT_FINGERPRINT_VERSION, articleId],
  });
  const row = result.rows[0] as unknown as {
    archive_article_id: string; title: string; source_type: string; corpus_version: string; fingerprint_version: string;
    archive_order: number | bigint | null; created_at: string; canonical_sha256: string; word_count: number | bigint;
    language: string | null; match_eligible: number | bigint; active_fingerprints: number | bigint;
  } | undefined;
  if (!row) return null;
  const matchEligible = Number(row.match_eligible) === 1;
  return {
    sourceId: `archive:${row.archive_article_id}`,
    sourceClass: "reference_archive",
    displayName: archiveExplorerDisplayName("reference_archive", row.archive_article_id, row.title),
    state: matchEligible ? "active" : "stored",
    matchEligible,
    eligibilityMode: "ARCHIVE",
    wordCount: Number(row.word_count),
    language: row.language,
    addedAt: toIso(row.created_at),
    maturityWindowDays: CORPUS_ACTIVATION_DELAY_DAYS,
    evaluatedAt: asOf.toISOString(),
    maturesAt: null,
    mature: null,
    provenance: provenanceFor("reference_archive", row.corpus_version),
    fingerprintPrefix: fingerprintPrefix(row.canonical_sha256),
    archiveArticleId: row.archive_article_id,
    sourceType: row.source_type,
    corpusVersion: row.corpus_version,
    seedFingerprintVersion: row.fingerprint_version,
    archiveOrder: row.archive_order === null ? null : Number(row.archive_order),
    activeFingerprintVersion: ARCHIVE_COMPACT_FINGERPRINT_VERSION,
    fingerprintsUnderActiveVersion: Number(row.active_fingerprints),
  };
}

async function loadAdmissionDetail(client: Client, predicates: AdminEligibilityPredicates, decisionId: string, asOf: Date): Promise<ArchiveExplorerDetail | null> {
  const result = await client.execute({
    sql: `SELECT d.id, d.decision, d.policy_version, d.reason_codes, d.hard_gate_passed, d.hard_gate_failure_codes,
                 d.detected_format, d.extracted_word_count, d.detected_language, d.language_confidence, d.canonical_sha256,
                 d.quality_score, d.corpus_value_score, d.family_relation, d.family_containment, d.created_at,
                 ar.id AS accepted_representation_id, ar.revoked_at,
                 EXISTS (SELECT 1 FROM corpus_admission_content_store cs WHERE cs.decision_id = d.id) AS has_retained_text,
                 p.status AS promotion_status, p.attempt_count AS promotion_attempt_count, p.link_type AS promotion_link_type,
                 p.updated_at AS promotion_updated_at,
                 CASE WHEN ${predicates.admissionBackingMaturity.sql} THEN 1 ELSE 0 END AS own_mature,
                 CASE WHEN p.status = 'indexed' AND EXISTS (
                   SELECT 1 FROM corpus_document_representations r WHERE r.id = p.representation_id AND ${predicates.matching.sql}
                 ) THEN 1 ELSE 0 END AS match_eligible
          FROM corpus_admission_decisions d
          LEFT JOIN corpus_admission_accepted_representations ar ON ar.decision_id = d.id
          LEFT JOIN corpus_admission_promotions p ON p.decision_id = d.id
          WHERE d.id = ?`,
    args: [...predicates.admissionBackingMaturity.args, ...predicates.matching.args, decisionId],
  });
  const row = result.rows[0] as unknown as {
    id: string; decision: "ACCEPT" | "REVIEW" | "REJECT"; policy_version: string; reason_codes: string | null;
    hard_gate_passed: number | bigint; hard_gate_failure_codes: string | null; detected_format: string | null;
    extracted_word_count: number | bigint | null; detected_language: string | null; language_confidence: number | null;
    canonical_sha256: string | null; quality_score: number | null; corpus_value_score: number | null;
    family_relation: string | null; family_containment: number | null; created_at: string;
    accepted_representation_id: string | null; revoked_at: string | null; has_retained_text: number | bigint;
    promotion_status: string | null; promotion_attempt_count: number | bigint | null; promotion_link_type: string | null;
    promotion_updated_at: string | null; own_mature: number | bigint; match_eligible: number | bigint;
  } | undefined;
  if (!row) return null;

  const matchEligible = Number(row.match_eligible) === 1;
  const ownMature = Number(row.own_mature) === 1;
  const accepted = row.decision === "ACCEPT";
  const isDuplicate = row.family_relation === "EXACT_DUPLICATE" || row.family_relation === "EDITED_VERSION";
  // Same precedence as the `sources` CTE's admission CASE.
  const state: ArchiveExplorerState = row.decision === "REVIEW"
    ? "review"
    : row.decision === "REJECT"
      ? (isDuplicate ? "duplicate" : "rejected")
      : row.revoked_at !== null
        ? "removed"
        : !ownMature ? "maturing" : matchEligible ? "active" : "stored";
  const ageMature = row.created_at <= predicates.maturityCutoff;

  return {
    sourceId: `admission:${row.id}`,
    sourceClass: "admitted_submission",
    displayName: archiveExplorerDisplayName("admitted_submission", row.id, null),
    state,
    matchEligible,
    eligibilityMode: "MATCHING",
    wordCount: row.extracted_word_count === null ? null : Number(row.extracted_word_count),
    language: row.detected_language,
    addedAt: toIso(row.created_at),
    maturityWindowDays: CORPUS_ACTIVATION_DELAY_DAYS,
    evaluatedAt: asOf.toISOString(),
    maturesAt: accepted ? maturesAtIso(row.created_at) : null,
    mature: accepted ? ownMature : null,
    provenance: provenanceFor("admitted_submission", row.policy_version),
    fingerprintPrefix: fingerprintPrefix(row.canonical_sha256),
    decisionId: row.id,
    decision: row.decision,
    policyVersion: row.policy_version,
    reasonCodes: safeJsonStringArray(row.reason_codes),
    hardGatePassed: Number(row.hard_gate_passed) === 1,
    hardGateFailureCodes: safeJsonStringArray(row.hard_gate_failure_codes),
    detectedFormat: row.detected_format,
    languageConfidence: row.language_confidence,
    qualityScore: row.quality_score,
    corpusValueScore: row.corpus_value_score,
    familyRelation: row.family_relation,
    familyContainment: row.family_containment,
    storedFingerprint: row.accepted_representation_id === null ? null : row.revoked_at === null ? "active" : "removed",
    removedAt: row.revoked_at === null ? null : toIso(row.revoked_at),
    hasRetainedText: Number(row.has_retained_text) === 1,
    maturityExemptionApplies: accepted && ownMature && !ageMature,
    promotionStatus: row.promotion_status,
    promotionAttemptCount: row.promotion_attempt_count === null ? null : Number(row.promotion_attempt_count),
    promotionLinkType: row.promotion_link_type,
    indexedAt: row.promotion_status === "indexed" && row.promotion_updated_at ? toIso(row.promotion_updated_at) : null,
  };
}

async function loadLegacyDetail(client: Client, predicates: AdminEligibilityPredicates, representationId: string, asOf: Date): Promise<ArchiveExplorerDetail | null> {
  const result = await client.execute({
    sql: `SELECT r.id, r.canonical_sha256, r.word_count, r.language, r.canonicalization_version, r.extractor_version, r.first_seen_at,
                 (SELECT COUNT(*) FROM corpus_submission_references sr WHERE sr.representation_id = r.id) AS submission_reference_count,
                 (SELECT COUNT(*) FROM corpus_admission_promotions pi WHERE pi.representation_id = r.id AND pi.status = 'indexed') AS indexed_admission_backings,
                 CASE WHEN ${predicates.matching.sql} THEN 1 ELSE 0 END AS match_eligible
          FROM corpus_document_representations r
          WHERE r.id = ?
            AND NOT ${predicates.archive.sql}
            AND NOT EXISTS (
              SELECT 1 FROM corpus_admission_promotions pn
              WHERE pn.representation_id = r.id AND pn.link_type = 'NEW_CONTENT_REPRESENTATION'
            )`,
    args: [...predicates.matching.args, representationId, ...predicates.archive.args],
  });
  const row = result.rows[0] as unknown as {
    id: string; canonical_sha256: string; word_count: number | bigint; language: string | null;
    canonicalization_version: string; extractor_version: string | null; first_seen_at: string;
    submission_reference_count: number | bigint; indexed_admission_backings: number | bigint; match_eligible: number | bigint;
  } | undefined;
  if (!row) return null;
  const matchEligible = Number(row.match_eligible) === 1;
  const maturesAt = maturesAtIso(row.first_seen_at);
  return {
    sourceId: `legacy:${row.id}`,
    sourceClass: "legacy_submission",
    displayName: archiveExplorerDisplayName("legacy_submission", row.id, null),
    state: matchEligible ? "active" : "maturing",
    matchEligible,
    eligibilityMode: "MATCHING",
    wordCount: Number(row.word_count),
    language: row.language,
    addedAt: toIso(row.first_seen_at),
    maturityWindowDays: CORPUS_ACTIVATION_DELAY_DAYS,
    evaluatedAt: asOf.toISOString(),
    maturesAt,
    mature: maturesAt !== null && maturesAt <= asOf.toISOString() ? true : matchEligible,
    provenance: provenanceFor("legacy_submission", null),
    fingerprintPrefix: fingerprintPrefix(row.canonical_sha256),
    representationId: row.id,
    submissionReferenceCount: Number(row.submission_reference_count),
    indexedAdmissionBackings: Number(row.indexed_admission_backings),
    canonicalizationVersion: row.canonicalization_version,
    extractorVersion: row.extractor_version,
  };
}
