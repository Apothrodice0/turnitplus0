# Production Migration Runbook — Corpus Admission Release (0029-0036)

Scope: applying migrations `0029` through `0036` to the production Turso
database via `lib/e8-tables-migration-runner.ts` / `tools/apply-e8-tables-migration.ts`.
Nothing here applies to any other migration set or tool.

## 1. Backup / export

No automated backup exists in this repo — take one manually before anything else:

```
turso db show <db-name>                              # confirm you have the right database
turso db dump <db-name> > backup-YYYYMMDD-HHMM.sql    # or the Turso dashboard's export
```

Store the dump outside this repo — never commit it, it may contain real user
data. Confirm it's non-empty / a plausible size before proceeding.

## 2. Verify current state (read-only, no `--execute`)

```
node --import tsx tools/apply-e8-tables-migration.ts --env=production
```

Dry-run is the default — this touches nothing. It reports:

- `refused` if the database isn't at the expected pre-0012 baseline, if any
  target file's content doesn't match its pinned SHA256, or if any file
  contains a destructive statement outside the one 0032 exception.
- Per-file `already-applied` / `would-apply` status — confirm this shows
  0012-0028 already-applied and 0029-0036 would-apply before continuing. If
  it shows anything else, stop and investigate before touching production.

## 3. Ordered migration

Order is fixed by `TARGET_MIGRATIONS`, not chosen at invocation time:
0029 → 0030 → 0031 → 0032 → 0033 → 0034 → 0035 → 0036.

```
node --import tsx tools/apply-e8-tables-migration.ts --env=production --execute --confirm=APPLY-TO-PRODUCTION
```

- Each file applies inside its own transaction (`client.migrate()`) — a
  single file can never partially apply.
- There is no cross-file transaction — files before a failure stay committed.
- 0032 contains one reviewed `DROP INDEX`, immediately replaced by an
  equivalent partial index in the same transaction/file — the one and only
  statement this release's hardening pass allowlisted. Any other destructive
  statement, anywhere in the set, still gets refused outright.

## 4. Failure stop conditions

| Condition | Result | Action |
|---|---|---|
| `environmentLabel` mismatch | refused, `ENVIRONMENT_LABEL_MISMATCH` | nothing touched — fix the invocation |
| pre-0012 legacy tables missing | refused, `MISSING_LEGACY_TABLE` | this isn't the expected database — stop |
| a file's content doesn't match its pinned SHA256 | refused, `HASH_MISMATCH` | do not proceed until the file/pin is reconciled and re-reviewed |
| destructive statement outside the one 0032 exception | refused, `DESTRUCTIVE_STATEMENT_DETECTED` | do not override — this is a hard stop by design |
| a migration's tables/columns exist in a mixed state | failed, "partially applied" | manual inspection required — never rerun blindly |
| a migration's SQL genuinely errors | failed, names the exact file + what already succeeded | see §5 |

Any `failed` result: **stop**. Inspect the reported `failedMigration` and
`error`, and the actual database state, before deciding whether to retry or
restore from the §1 backup.

## 5. Roll-forward recovery

No down-migrations exist for 0029-0036 — every migration in this set is
additive (new tables, new nullable/defaulted columns, or 0032's safe index
swap). Recovery is roll-forward, not rollback:

- Re-running the exact command from §3 against the **same** database is safe
  and idempotent. Already-applied migrations are detected by table/column
  existence and skipped; only genuinely pending ones apply.
- This holds regardless of why the run stopped — a real SQL error, a network
  drop, a killed process between files. The runner does not distinguish
  those from "some migrations already succeeded" and does not need to.
- The one state this runner cannot recover from automatically is a migration
  reported as "partially applied" (some but not all of its own tables/columns
  exist). This can't happen through the runner itself — each file is one
  transaction — but could result from manual intervention outside it. That
  requires manual inspection and correction before any rerun, never a blind
  retry.
- If inspection concludes the database is in an unrecoverable or unexpected
  state, restore from the §1 backup and re-run from a clean 0028 baseline.

## 6. Post-migration

- Re-run the §2 dry-run once more — every migration should now report
  `already-applied`.
- Deploy the corresponding code release only after this confirms success.
  Deploying code before migrations land degrades the already-live
  historicalSubmissionMatch feature to `UNAVAILABLE` on every report view
  (see this release's own deployment checklist).
- Keep `CORPUS_ADMISSION_ENABLED` / `CORPUS_PROMOTION_ENABLED` /
  `CORPUS_SOURCE_MATCHING_ENABLED` unset until migrations are confirmed
  applied and the code deploy is verified healthy — flip them on one at a
  time, separately, afterward.
