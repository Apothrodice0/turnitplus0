import { createClient } from "@libsql/client";
import { loadEnvFile, hostnameLabel } from "./apply-e8-tables-migration";

/**
 * Phase E8I: read-only production audit that (re-)derives the exact rows a
 * targeted cleanup would delete. This file issues SELECT statements only —
 * it has no INSERT/UPDATE/DELETE anywhere and never calls client.batch. It
 * reuses loadEnvFile/hostnameLabel from tools/apply-e8-tables-migration.ts
 * (same credential-handling discipline: only a hostname label is ever
 * logged, never the URL or token).
 *
 * Usage: node --import tsx tools/e8i-cleanup-plan.ts
 *
 * Method (matches the E8H audit's own stated criteria):
 *   1. Group document_identities by (account_id, canonical_sha256) via their
 *      corpus_submission_references -> corpus_document_representations join.
 *   2. A group with exactly 2 members, created_at deltas of 0-2 seconds,
 *      same account, same content, and exactly one matching saved_reports
 *      row is a legacy pre-E8F DUPLICATE_SAVE_ARTIFACT (app/page.tsx used to
 *      save the same report twice: immediately, then again after Wikipedia
 *      enrichment — see app/api/reports/route.ts's own Phase E8F comment).
 *   3. Any other multi-member group (larger delta, multiple saved_reports
 *      rows) is a legitimate repeat submission and must NOT be touched.
 *   4. For each confirmed artifact cluster, the deletion target is only the
 *      younger identity + its own corpus_submission_references row. The
 *      representation, the older identity, and saved_reports are untouched.
 */

async function main() {
  const repoRoot = process.cwd();
  const url = loadEnvFile(repoRoot, ".env.production.local", "PROD_TURSO_DATABASE_URL");
  const authToken = loadEnvFile(repoRoot, ".env.production.local", "PROD_TURSO_TOKEN");
  console.log(`target hostname label: ${hostnameLabel(url)} (not the full URL, never the token)`);
  console.log("mode: READ-ONLY AUDIT (this file contains no INSERT/UPDATE/DELETE statements)\n");

  const client = createClient({ url, authToken });
  try {
    const counts = await Promise.all([
      client.execute("SELECT COUNT(*) AS n FROM corpus_document_representations"),
      client.execute("SELECT COUNT(*) AS n FROM corpus_submission_references"),
      client.execute("SELECT COUNT(*) AS n FROM document_identities"),
      client.execute("SELECT COUNT(DISTINCT account_id) AS n FROM document_identities WHERE account_id IS NOT NULL"),
    ]);
    console.log("=== Current production corpus counts ===");
    console.log(`corpus_document_representations: ${counts[0].rows[0].n}`);
    console.log(`corpus_submission_references:     ${counts[1].rows[0].n}`);
    console.log(`document_identities:              ${counts[2].rows[0].n}`);
    console.log(`distinct accounts w/ identities:  ${counts[3].rows[0].n}`);
    console.log("");

    // One row per submission event that has been indexed into the corpus,
    // joined out to its owning account/title/timestamps.
    const rows = await client.execute(`
      SELECT
        di.id AS identity_id,
        di.account_id AS account_id,
        u.email AS account_email,
        di.title AS title,
        di.created_at AS identity_created_at,
        di.canonical_sha256 AS canonical_sha256,
        sr.id AS submission_reference_id,
        sr.representation_id AS representation_id,
        sr.link_type AS link_type
      FROM document_identities di
      JOIN corpus_submission_references sr ON sr.document_identity_id = di.id
      LEFT JOIN users u ON u.id = di.account_id
      ORDER BY di.account_id, di.canonical_sha256, di.created_at ASC
    `);

    type Row = {
      identity_id: string;
      account_id: string | null;
      account_email: string | null;
      title: string | null;
      identity_created_at: string;
      canonical_sha256: string;
      submission_reference_id: number;
      representation_id: string;
      link_type: string;
    };
    const allRows = rows.rows as unknown as Row[];

    // Group by (account_id, canonical_sha256)
    const groups = new Map<string, Row[]>();
    for (const row of allRows) {
      if (!row.account_id) continue; // anonymous rows are never indexed (see indexDocumentSubmissionIntoCorpus) — defensive only
      const key = `${row.account_id}::${row.canonical_sha256}`;
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }

    const multiGroups = [...groups.values()].filter((g) => g.length > 1);
    console.log(`=== Clusters with >1 document_identities for the same (account, content) ===`);
    console.log(`Found ${multiGroups.length} cluster(s)\n`);

    let clusterIndex = 0;
    const deletionPlan: Array<{
      cluster: number;
      title: string | null;
      accountEmail: string | null;
      accountId: string;
      representationId: string;
      keepIdentityId: string;
      keepCreatedAt: string;
      deleteIdentityId: string;
      deleteCreatedAt: string;
      deleteSubmissionReferenceId: number;
      deltaSeconds: number;
      resolvedSavedReportsRow: { id: string; saved_at: string; updated_at: string; word_count: number } | null;
      otherSavedReportsRowsForThisTitle: Array<{ id: string; saved_at: string; updated_at: string; word_count: number }>;
      deleteIdentityShingleCount: number;
      deleteIdentityFamilyMembership: unknown;
      deleteIdentityProvenanceRefs: number;
      otherRowsReferencingDeleteTargetAsMatch: unknown;
      affectedReportDeviceKey: string | null;
      affectedReportCurrentSnapshot: unknown;
    }> = [];

    for (const group of multiGroups) {
      clusterIndex += 1;
      const first = group[0];
      console.log(`--- Cluster ${clusterIndex}: "${first.title}" (account ${first.account_email ?? "?"} / ${first.account_id}) ---`);
      console.log(`  representation_id: ${group[0].representation_id}`);
      console.log(`  ${group.length} identities sharing this (account, canonical_sha256):`);
      for (const row of group) {
        console.log(`    identity_id=${row.identity_id} created_at=${row.identity_created_at} submission_reference_id=${row.submission_reference_id} link_type=${row.link_type}`);
      }

      if (group.length === 2) {
        const [older, younger] = group; // already ordered ASC by created_at
        const deltaSeconds = (Date.parse(younger.identity_created_at + "Z") - Date.parse(older.identity_created_at + "Z")) / 1000;
        console.log(`  time delta: ${deltaSeconds}s`);

        // All saved_reports rows for this account+title — an account can
        // legitimately have several across separate genuine uploads of a
        // same-named file, so this alone does not decide anything.
        const savedReportsResult = await client.execute({
          sql: `SELECT id, saved_at, updated_at, word_count FROM saved_reports WHERE user_id = ? AND title = ? ORDER BY saved_at ASC`,
          args: [first.account_id, first.title],
        });
        const savedReportsRows = savedReportsResult.rows as unknown as Array<{ id: string; saved_at: string; updated_at: string; word_count: number }>;
        console.log(`  saved_reports rows for this account+title (all history): ${savedReportsRows.length}`);
        for (const sr of savedReportsRows) {
          console.log(`    saved_reports.id=${sr.id} saved_at=${sr.saved_at} updated_at=${sr.updated_at} word_count=${sr.word_count}`);
        }

        // The actual question (per the E8H audit's own criterion): does EACH
        // identity's created_at resolve to the SAME single saved_reports row
        // when matched by nearest timestamp? Pre-E8F, one saved_reports row
        // (one device_key+id, upserted twice: initial save, then again after
        // Wikipedia enrichment) spawned two identity-capture runs. A genuine
        // second upload is a different (device_key,id) -> a different
        // saved_reports row, and the two identities would each resolve to
        // their own distinct row instead.
        const nearestFor = (identityCreatedAt: string) => {
          let best: { id: string; saved_at: string; updated_at: string; word_count: number } | null = null;
          let bestDist = Infinity;
          for (const sr of savedReportsRows) {
            const dist = Math.abs(Date.parse(identityCreatedAt + "Z") - Date.parse(sr.updated_at + "Z"));
            if (dist < bestDist) {
              bestDist = dist;
              best = sr;
            }
          }
          return { row: best, distMs: bestDist };
        };
        const olderNearest = nearestFor(older.identity_created_at);
        const youngerNearest = nearestFor(younger.identity_created_at);
        console.log(`  older identity's nearest saved_reports row: id=${olderNearest.row?.id} (${olderNearest.distMs}ms away)`);
        console.log(`  younger identity's nearest saved_reports row: id=${youngerNearest.row?.id} (${youngerNearest.distMs}ms away)`);
        const sameSavedReportsRow = olderNearest.row && youngerNearest.row && olderNearest.row.id === youngerNearest.row.id;
        console.log(`  both identities resolve to the same saved_reports row: ${sameSavedReportsRow ? "YES" : "NO"}`);

        // Cascade-impact checks for the younger identity only (the proposed
        // deletion target) — informational, nothing is written.
        const shingleCountResult = await client.execute({
          sql: `SELECT COUNT(*) AS n FROM document_identity_shingles WHERE document_identity_id = ?`,
          args: [younger.identity_id],
        });
        const familyResult = await client.execute({
          sql: `SELECT family_id, match_type FROM document_family_members WHERE document_identity_id = ?`,
          args: [younger.identity_id],
        });
        const provenanceResult = await client.execute({
          sql: `SELECT COUNT(*) AS n FROM provenance_sources WHERE document_identity_id = ?`,
          args: [younger.identity_id],
        });
        // Any OTHER identity's family-membership row that points at the
        // deletion target via matched_against_identity_id would have that
        // one column SET NULL by the FK (not deleted) — informational only.
        const referencedAsMatchTargetResult = await client.execute({
          sql: `SELECT id, document_identity_id FROM document_family_members WHERE matched_against_identity_id = ?`,
          args: [younger.identity_id],
        });
        // The saved_reports row's own device_key (needed to look up its
        // report_historical_match_snapshots row, keyed by device_key+id, not
        // by title) plus that snapshot's current cached status.
        let deviceKeyRow: { device_key: string } | undefined;
        let snapshotRow: { status: string; computed_at: string } | undefined;
        if (olderNearest.row) {
          const dk = await client.execute({
            sql: `SELECT device_key FROM saved_reports WHERE id = ?`,
            args: [olderNearest.row.id],
          });
          deviceKeyRow = dk.rows[0] as unknown as { device_key: string } | undefined;
          if (deviceKeyRow) {
            const snap = await client.execute({
              sql: `SELECT status, computed_at FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?`,
              args: [deviceKeyRow.device_key, olderNearest.row.id],
            });
            snapshotRow = snap.rows[0] as unknown as { status: string; computed_at: string } | undefined;
          }
        }
        console.log(`  other rows pointing at the deletion target via matched_against_identity_id: ${referencedAsMatchTargetResult.rows.length}`);
        console.log(`  affected report's device_key: ${deviceKeyRow?.device_key ?? "(not found)"}`);
        console.log(`  affected report's current cached historical-match snapshot: ${snapshotRow ? `${snapshotRow.status} (computed_at=${snapshotRow.computed_at})` : "(none cached yet)"}`);

        const isArtifact = deltaSeconds >= 0 && deltaSeconds <= 2 && Boolean(sameSavedReportsRow) && Math.max(olderNearest.distMs, youngerNearest.distMs) <= 2000;
        console.log(`  classification: ${isArtifact ? "DUPLICATE_SAVE_ARTIFACT (candidate for deletion)" : "LEGITIMATE REPEAT SUBMISSION (do not touch)"}`);
        console.log("");

        if (isArtifact) {
          deletionPlan.push({
            cluster: clusterIndex,
            title: first.title,
            accountEmail: first.account_email,
            accountId: first.account_id!,
            representationId: first.representation_id,
            keepIdentityId: older.identity_id,
            keepCreatedAt: older.identity_created_at,
            deleteIdentityId: younger.identity_id,
            deleteCreatedAt: younger.identity_created_at,
            deleteSubmissionReferenceId: younger.submission_reference_id,
            deltaSeconds,
            resolvedSavedReportsRow: olderNearest.row,
            otherSavedReportsRowsForThisTitle: savedReportsRows.filter((r) => r.id !== olderNearest.row?.id),
            deleteIdentityShingleCount: Number(shingleCountResult.rows[0].n),
            deleteIdentityFamilyMembership: familyResult.rows[0] ?? null,
            deleteIdentityProvenanceRefs: Number(provenanceResult.rows[0].n),
            otherRowsReferencingDeleteTargetAsMatch: referencedAsMatchTargetResult.rows,
            affectedReportDeviceKey: deviceKeyRow?.device_key ?? null,
            affectedReportCurrentSnapshot: snapshotRow ?? null,
          });
        }
      } else {
        console.log(`  classification: NEEDS MANUAL REVIEW (${group.length} members, not the expected 2) — excluded from plan\n`);
      }
    }

    console.log("\n=== READ-ONLY DELETION PLAN (nothing has been deleted) ===");
    console.log(`${deletionPlan.length} cluster(s) proposed for cleanup:\n`);
    for (const item of deletionPlan) {
      console.log(JSON.stringify(item, null, 2));
    }
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error("e8i-cleanup-plan failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
