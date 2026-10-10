# Rollback and restore

Two separate procedures. Rolling back the application does not touch data; restoring the database replaces data. Never combine them without reading both.

## 1. Roll back the application (one step)

Use when a deployed digest misbehaves and the previous digest ran correctly.

1. Read the previous digest pair (API and web) from `infra/releases/` or the publish workflow summary of the earlier commit.
2. In Dokploy, set `API_IMAGE` and `WEB_IMAGE` of the affected environment to the previous digests and redeploy. The `migrate` service runs again and is a no-op for migrations already applied.
3. Check `GET /health/ready` reports the previous `version` (SHA) and `status: ready`.
4. Record the observation in `LIVE-ENVIRONMENT-FACTS.md` with the time and digests.

Expand/contract migrations (ADR-0003) mean the previous application runs against the newer schema. A contract migration is only shipped after the previous digest is no longer a rollback target.

## 2. Restore the workspace from a backup

Use only for data loss or corruption, after the owner's explicit go-ahead in chat. Never cancel a running migration. This is the procedure the restore drill proves (`backup-and-restore-drill.md` §6): a `poii.backup` document restored through the API into an empty database. The document carries the original bytes, so the storage volume needs no separate restore.

1. Pause the Dokploy backup schedule of the environment, so no run backs up the broken or empty state and retention never prunes good backups during the window.
2. Stop `web` (Dokploy → service → stop). If the database is still readable, keep a copy of the current state first, inside the running `api` container: `POII_BACKUP_TARGET=local POII_BACKUP_LOCAL_DIR=/data/storage/pre-restore-<UTC timestamp> node dist/backup-cli.js` (this writes to the storage volume, not to the backup target, so `latest.json` there is untouched).
3. Choose the backup: by default the object named by `latest.json` at the backup target (an older `poii-backup-*.json` if the newest already holds the damage). Download it and check its SHA-256 against the pointer's `sha256` (`sha256sum`), and note the pointer's `counts`. For an older document, take its counts from the `backup.written` line of that run's log or count its arrays.
4. Stop `api`. Empty the database, leaving `db` running: `docker exec -i <db container> psql -U poii -d poii -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'`. Move the storage volume's contents aside (do not delete them until the restore is verified).
5. Run the `migrate` service once (Dokploy redeploy runs it before `api`), so the schema matches the running digest.
6. Start `api` only. Check `GET /health/ready` answers `ready`.
7. Copy the document into the `api` container (`docker cp`) and post it from there:
   `node -e "const f=require('fs').readFileSync(process.argv[1],'utf8');fetch('http://127.0.0.1:3001/v1/restore',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backup:JSON.parse(f)})}).then(async r=>console.log(r.status,await r.text()))" /tmp/<object key>`
   Expect `200` with `restored` counts equal to the pointer's `counts` and `workspaceId` equal to the pointer's `workspaceId`. Any difference: stop and tell the owner.
8. Check `GET /health/ready` again and `GET /health/version` (`migrations.applied` equals `migrations.latest`). Open a known source and record and verify the span resolves. Then start `web` and resume the backup schedule; run it once by hand and check `backup.lastStatus` is `succeeded`.
9. Record what was restored (object key, its SHA-256, counts, time, digest) in `LIVE-ENVIRONMENT-FACTS.md`. Delete the moved-aside storage contents and the pre-restore copy only after the owner agrees.

Limit: `/v1/restore` accepts up to 100 MB of JSON (see the drill runbook). Optional extra, not enabled: if the owner later adds a nightly `pg_dump -Fc`, a dump of the same night can be restored with `pg_restore --clean --if-exists --no-owner` into the `poii` database plus the storage volume of the same point in time instead of steps 4 to 7; the document path above stays the primary one.

## 3. Restore drill (before production activation)

How backups are taken, what they contain and the local restore drill (`bash infra/scripts/restore-drill.sh`; proposed for CI, step in the PR description) are in [backup-and-restore-drill.md](backup-and-restore-drill.md). The local drill proves the format and the runner on the public fixtures; it does not replace this one.

Before production activation: restore the latest staging backup (the document named by `latest.json` at the staging target) into an empty, isolated environment (fresh database, migrations applied, `POST /v1/restore`), check the restored counts against the pointer's counts, then run the Playwright smoke and the context-pack export against it. Record pass/fail, measured time and the backup object key in `CURRENT-WORK.md`. The drill is a prerequisite for the owner's activation phrase.
