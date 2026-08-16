# Backup drill — destructive restore proof (LF-018)

`scripts/backup-drill.sh` proves the backup/restore path against a REAL,
throwaway PostgreSQL — never touching dev or production stacks. Full
round trip:

1. Disposable `postgres:16-alpine` on a random host port.
2. Repo migrations applied (`packages/db` migrator).
3. Sentinel rows inserted (timestamped words — provably *this* run's data).
4. `lfctl backup create` — `pg_dump -Fc` + SHA-256 sidecar.
5. **`DROP SCHEMA public CASCADE` + `DROP SCHEMA drizzle CASCADE`** —
   simulated catastrophic loss.
6. `lfctl backup restore` (refuses non-empty targets, so a successful
   restore proves the data was really gone).
7. Sentinel + row-count verification; non-zero exit on any mismatch.

The pg tools run inside the PostgreSQL container via
`LFCTL_PG_CONTAINER=<container>` — the same operator mode documented for
hosts without a local postgres client install.

## Verified run (2026-08-16, Windows/Git Bash host)

```
== 1/7 Disposable PostgreSQL (random host port) ==
container: lf-backup-drill-1899  host port: 63058
== 2/7 Apply repo migrations ==
[db:migrate] migrations applied
== 3/7 Insert sentinel data ==
cards before destroy: 3 (expect 3 sentinels + any seeded)
== 4/7 Backup (pg_dump -Fc + SHA-256 via lfctl) ==
{ "file": "…\\lobbyforge-2026-08-16T17-28-43-630Z.dump",
  "sha256": "628c45a565325450cd36bc1db60a2ef84792742158a38b552778d299866102b8",
  "sizeBytes": 98469 }
== 5/7 DESTROY the schema (simulated catastrophic loss) ==
user tables after destroy: 0 (expect 0)
== 6/7 Restore from backup ==
{ "ok": true, "message": "Database restored successfully." }
== 7/7 Verify restored data ==
cards after restore: 3 (before: 3)
sentinel rows restored: 3 (expect 3)
PASS: backup → destroy → restore → verify round-tripped 3 cards incl. 3 sentinels.
```

## Bugs the drill itself caught (and fixed)

- `lfctl backup restore`'s empty-check only counted the `public` schema —
  a populated `drizzle` (migrations ledger) schema slipped through and
  collided mid-restore. Now counts every non-system schema.
- Container-mode dumps were captured as UTF-8 strings, silently
  corrupting the binary `-Fc` TOC (`encoding: 'buffer'` now).

## Operator quick reference

```bash
# Run the drill (needs Docker only)
bash scripts/backup-drill.sh

# Backup a live stack (pg tools inside the stack's postgres container)
LFCTL_PG_CONTAINER=lobbyforge-postgres node scripts/lfctl.mjs \
  backup create --out backups --database-url "$DATABASE_URL" --json

# Restore (target must be EMPTY — lfctl refuses otherwise)
LFCTL_PG_CONTAINER=lobbyforge-postgres node scripts/lfctl.mjs \
  backup restore --file backups/<dump> --to "$DATABASE_URL" --json
```
