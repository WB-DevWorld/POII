# Rollback and restore

Two separate procedures. Rolling back the application does not touch data; restoring the database replaces data. Never combine them without reading both.

## 1. Roll back the application (one step)

Use when a deployed digest misbehaves and the previous digest ran correctly.

1. Read the previous digest pair (API and web) from `infra/releases/` or the publish workflow summary of the earlier commit.
2. In Dokploy, set `API_IMAGE` and `WEB_IMAGE` of the affected environment to the previous digests and redeploy. The `migrate` service runs again and is a no-op for migrations already applied.
3. Check `GET /health/ready` reports the previous `version` (SHA) and `status: ready`.
4. Record the observation in `LIVE-ENVIRONMENT-FACTS.md` with the time and digests.

Expand/contract migrations (ADR-0003) mean the previous application runs against the newer schema. A contract migration is only shipped after the previous digest is no longer a rollback target.

## 2. Restore the database and storage

Use only for data loss or corruption, after the owner's explicit go-ahead in chat. Never cancel a running migration.

1. Stop the `api` and `web` services of the environment (Dokploy → service → stop). Leave `db` running.
2. Take a fresh dump of the current state before restoring, even if it is believed broken: `pg_dump -Fc` to the backup target under `pre-restore-<timestamp>`.
3. Restore the chosen backup: `pg_restore --clean --if-exists --no-owner` into the `poii` database, then restore the storage volume contents for the same point in time.
4. Run the migration service once so the schema matches the running digest.
5. Start `api` and `web`; check `/health/ready`; open a known source and record and verify the span resolves.
6. Record what was restored (backup id, time, digest) in `LIVE-ENVIRONMENT-FACTS.md`.

## 3. Restore drill (before production activation)

How backups are taken, what they contain and the local restore drill (`bash infra/scripts/restore-drill.sh`, also run in CI) are in [backup-and-restore-drill.md](backup-and-restore-drill.md). The local drill proves the format and the runner on the public fixtures; it does not replace this one.

Before production activation: restore the latest staging backup (the document named by `latest.json` at the staging target) into an empty, isolated environment (fresh database, migrations applied, `POST /v1/restore`), check the restored counts against the pointer's counts, then run the Playwright smoke and the context-pack export against it. Record pass/fail, measured time and the backup object key in `CURRENT-WORK.md`. The drill is a prerequisite for the owner's activation phrase.
