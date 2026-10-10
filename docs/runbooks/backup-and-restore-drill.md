# Backup and restore drill

How POII is backed up, how to run a backup by hand or on a schedule, and how to prove a backup restores. Issue #16. Restoring for real after data loss is `rollback-and-restore.md` §2 and needs the owner's go-ahead in chat.

## 1. What a backup is

A backup is one `poii.backup` version 1 JSON document (ADR-0008), the same document `POST /v1/backup` returns. It holds the complete workspace with identical ids: actors, sources, every revision with its **original bytes** (base64, read from the storage port), tombstones, records, versions, evidence, approvals, audit events and export-run metadata. Restoring it into an empty install reproduces the workspace, including history and approvals (BUILD-BASELINE.md §8, item 2).

Only this document is backed up. That is deliberate: it is restorable through the API's own validation into any install running the same or a later schema, and it carries the originals, so the storage volume does not need a separate copy.

Not in the document, by design: the backup run history (`ops_backup_run`), idempotency keys, the migration ledger (the schema comes from the migrations of the image), and generated context-pack files in storage (regenerate them; their metadata is in the export runs).

Optional belt-and-braces, not enabled: a nightly `pg_dump -Fc` of the `poii` database to the same target. It restores faster for very large installs and keeps tables the document leaves out, but it is tied to the schema version and does not hold the original bytes (those live in the storage volume). The owner can ask for it later; it would be a second scheduled command, not a replacement.

Each backup run produces, at the target:

- `poii-backup-<workspaceId>-<time>.json`: the document. `<time>` is the ISO 8601 UTC start time with `:` and `.` replaced by `-` (valid on every filesystem; sorts by time), e.g. `poii-backup-0199…-2026-10-10T03-15-00-123Z.json`.
- `latest.json`: a pointer (`format: "poii.backup-pointer"`) naming the newest document with its byte length, SHA-256 and row counts. The counts are the manifest a restore is checked against.

Each run also writes one row to `ops_backup_run` (start, finish, target, object key, byte length, SHA-256, status `running`/`succeeded`/`failed`, error), records a `workspace.backup` audit event (`via: backup-cli`) and an `export_run` whose manifest names the target and object key. `GET /health/version` shows the last run as `backup: { lastRunAt, lastTarget, lastStatus }`. Readiness never depends on it.

## 2. Configuration

| Variable | Meaning |
| --- | --- |
| `POII_BACKUP_TARGET` | `local` (default) or `s3`. |
| `POII_BACKUP_LOCAL_DIR` | Directory for `local`. Required when the target is `local`. |
| `POII_BACKUP_KEEP` | How many documents to keep (default 30, at least 1). |
| `POII_BACKUP_S3_ENDPOINT` | S3-compatible endpoint URL, e.g. `https://<region>.<provider>`. Path-style addressing: `<endpoint>/<bucket>/<key>`. |
| `POII_BACKUP_S3_BUCKET` | Bucket name. |
| `POII_BACKUP_S3_ACCESS_KEY`, `POII_BACKUP_S3_SECRET_KEY` | Credentials. Secrets: Dokploy environment only, never in the repository. |
| `POII_BACKUP_S3_REGION` | Signing region (default `us-east-1`; many S3-compatible services accept any value, some need theirs). |
| `POII_BACKUP_S3_PREFIX` | Key prefix inside the bucket (default `poii/`), so a shared bucket stays tidy. Retention only ever deletes `poii-backup-*.json` objects directly under this prefix. |

The runner also reads what the API reads: `DATABASE_URL` and `POII_STORAGE_LOCAL_DIR` (the originals). S3 requests are signed with AWS Signature Version 4 using `node:crypto` and `fetch`; there is no SDK. The runner needs outbound HTTPS to the endpoint.

## 3. Run a backup locally

With PostgreSQL running and `.env` loaded (see `.env.example`):

```bash
set -a; . ./.env; set +a
pnpm --filter @poii/api backup:run
```

It prints one JSON line per step (`backup.started`, `backup.written` with size, SHA-256 and counts, `backup.pruned` if retention deleted anything, `backup.finished`) and exits 1 if anything failed. With the `.env.example` defaults the files land in `apps/api/artifacts/backups/` (gitignored).

From a built image or `dist`: `node dist/backup-cli.js` in `apps/api` (the container's working directory).

## 4. Run it from Dokploy (scheduled)

The command runs inside the running `api` container, so it uses that container's environment and its storage volume.

1. The `api` service needs the `POII_BACKUP_*` variables in its environment (Compose passes them through; see the change requested in the #16 PR) and, for `s3`, outbound network access to the endpoint.
2. Dokploy → the POII Compose service of the environment → **Schedules** → add:
   - Service: `api`
   - Schedule (cron, UTC): `15 3 * * *` (daily at 03:15)
   - Shell: `sh`
   - Command: `node dist/backup-cli.js`
3. In the environment's variables set `POII_BACKUP_TARGET=s3`, the four `POII_BACKUP_S3_*` values from owner-setup.md §6, and optionally `POII_BACKUP_S3_REGION`, `POII_BACKUP_S3_PREFIX`, `POII_BACKUP_KEEP`. Redeploy so the container sees them.
4. Run the schedule once by hand ("Run now"), then check `GET /health/version`: `backup.lastStatus` is `succeeded` and `backup.lastTarget` is `s3`. Record the observation in `LIVE-ENVIRONMENT-FACTS.md`.

A `local` target inside the container only protects against application mistakes, not against losing the host; use `s3` for staging and production.

Watching it: alert when `backup.lastStatus` is `failed` or `backup.lastRunAt` is older than 26 hours. The schedule's own log in Dokploy shows the JSON lines.

## 5. Retention

After a successful upload and pointer update the runner lists the target, sorts the `poii-backup-*.json` documents by the time in their names and deletes all but the newest `POII_BACKUP_KEEP`. `latest.json` and any other object are never touched. If pruning fails the backup still counts: the run is `succeeded` with the pruning error recorded, and the command exits 1 so the schedule shows it. Bucket-side lifecycle rules or object lock, if the provider offers them, are a sensible extra guard against a compromised key deleting backups; that is the owner's call.

## 6. The restore drill

```bash
set -a; . ./.env; set +a          # needs TEST_DATABASE_URL: a role allowed to create databases
bash infra/scripts/restore-drill.sh
```

What it does, start to finish, on fresh databases it creates and drops itself (`poii_drill_<random>_src` and `_dst`):

1. Creates and migrates the source database and starts the API from source on a random port.
2. Loads the three public fixtures through the API, with a small history: two assistant statements (one confirmed, one rejected), a decision that is superseded by a confirmed successor, a requirement, an observation and a price decision.
3. Takes a backup with the backup runner into a temporary local directory.
4. Creates and migrates a second, empty database and starts a second API on another random port.
5. Posts the document named by `latest.json` to `/v1/restore` and checks: the document's size and SHA-256 match the pointer; the restore response's counts equal the pointer's counts; the same counts again straight from the restored database; the known successor decision resolves to its exact span (text and excerpt hash); it keeps its approval and antecedent; it is current and its predecessor is not; `/health/ready` answers `ready`.
6. Stops both APIs, drops both databases, prints `RESTORE DRILL PASSED in <seconds> s`.

**Passing means** a backup taken by the same runner the schedule uses restores into an empty install with every row, the original bytes, history and approvals intact, and the restored install serves the journey. Any mismatch prints the failed check and exits non-zero; the API logs are printed on failure.

Measured on 2026-10-10 on a developer machine (Windows, PostgreSQL 17 in Docker): 18.2 s end to end. CI runs the same script after the tests.

This proves the format and the runner locally. It does not prove the staging backup target, the Dokploy schedule or a restore of a real staging backup: that is the pre-activation drill in `rollback-and-restore.md` §3.

Known limit: `/v1/restore` accepts a JSON body of up to 100 MB. Original bytes are inlined as base64 (about 4/3 of their size), so a workspace whose document approaches that needs a raised limit or a streamed restore before it can be restored through HTTP. The runner's log shows the document size on every run.

## 7. What still needs the owner

- The backup target credentials as Dokploy environment variables (owner-setup.md §6). Nothing has been sent to a real bucket yet; the S3 client is proven only against AWS's published signing examples and a local fake (mocked).
- Creating the Dokploy schedule (§4) once staging exists, and the first observed run recorded in `LIVE-ENVIRONMENT-FACTS.md`.
- The pre-activation drill against a real staging backup (`rollback-and-restore.md` §3).
- Whether to add the optional `pg_dump` step (§1).
