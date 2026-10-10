#!/usr/bin/env bash
# Local restore drill (#16, docs/runbooks/backup-and-restore-drill.md). Needs TEST_DATABASE_URL (a role that may
# create databases), Node and installed dependencies. Steps:
#   1. fresh database poii_drill_<random>_src, migrated; API started on a random port
#   2. the three public fixtures loaded through that API with a small decision history (confirm, reject, supersede)
#   3. a backup taken with the backup runner (backup-cli) into a temporary local directory
#   4. another empty database poii_drill_<random>_dst, migrated; a second API started on a random port
#   5. the document named by latest.json POSTed to /v1/restore; counts checked against the manifest (and counted
#      again in the database); a known record resolves to its exact span; /health/ready reports ready
#   6. both databases dropped, elapsed time printed. Any mismatch exits non-zero.
set -euo pipefail

: "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required (a PostgreSQL role allowed to create databases)}"
# Milliseconds since the epoch: bash 5's EPOCHREALTIME when present (decimal point or comma), else Node.
now_ms() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    local t=${EPOCHREALTIME/[.,]/}
    echo $(( 10#$t / 1000 ))
  else
    node -e 'process.stdout.write(String(Date.now()))'
  fi
}
started_ms=$(now_ms)
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
api_dir="$root/apps/api"
work=$(mktemp -d "${TMPDIR:-/tmp}/poii-drill.XXXXXX")
suffix=$(node -e "process.stdout.write(require('node:crypto').randomBytes(5).toString('hex'))")
src_db="poii_drill_${suffix}_src"
dst_db="poii_drill_${suffix}_dst"
pids=()

step() { printf '[drill %6ss] %s\n' "$(( ($(now_ms) - started_ms) / 1000 ))" "$*"; }
tool() { (cd "$api_dir" && node --import tsx src/ops/drill.ts "$@"); }

cleanup() {
  local status=$?
  set +e
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; done
  if [ "$status" -ne 0 ]; then
    for log in "$work"/api-*.log; do
      [ -f "$log" ] && { echo "--- last lines of $(basename "$log")"; tail -n 30 "$log"; }
    done
  fi
  if ! tool drop-db "$src_db" "$dst_db"; then
    echo "ERROR: could not drop $src_db / $dst_db; drop them by hand"
    [ "$status" -eq 0 ] && status=1
  fi
  rm -rf "$work"
  local elapsed_ms=$(( $(now_ms) - started_ms ))
  if [ "$status" -eq 0 ]; then
    echo "RESTORE DRILL PASSED in $((elapsed_ms / 1000)).$(printf '%03d' $((elapsed_ms % 1000))) s"
  else
    echo "RESTORE DRILL FAILED (exit $status) after $((elapsed_ms / 1000)).$(printf '%03d' $((elapsed_ms % 1000))) s"
  fi
  exit "$status"
}
trap cleanup EXIT

migrate() { (cd "$api_dir" && DATABASE_URL="$1" node --import tsx src/migrate.ts); }

# start_api <name> <database url> <port> <storage dir>
start_api() {
  mkdir -p "$4"
  (
    cd "$api_dir"
    export DATABASE_URL="$2" PORT="$3" POII_STORAGE_LOCAL_DIR="$4" GIT_SHA="drill" POII_AI_ENABLED="false" \
      POII_IDENTITY_ADAPTER="local-owner" WEB_BASE_URL="http://localhost:3000"
    exec node --import tsx src/main.ts
  ) >"$work/api-$1.log" 2>&1 &
  pids+=("$!")
  tool wait-ready "http://127.0.0.1:$3" 90
}

step "creating $src_db"
src_url=$(tool create-db "$src_db")
migrate "$src_url" >/dev/null
src_port=$(tool free-port)
start_api src "$src_url" "$src_port" "$work/storage-src"
step "source API ready on port $src_port; loading fixtures"
tool seed "http://127.0.0.1:$src_port" "$root/fixtures" "$work/state.json"

step "taking a backup with the backup runner"
(
  cd "$api_dir"
  DATABASE_URL="$src_url" POII_STORAGE_LOCAL_DIR="$work/storage-src" POII_BACKUP_TARGET=local \
    POII_BACKUP_LOCAL_DIR="$work/backups" POII_BACKUP_KEEP=30 WEB_BASE_URL="http://localhost:3000" \
    node --import tsx src/backup-cli.ts
) >"$work/backup.log"
grep -q '"status":"succeeded"' "$work/backup.log" || { cat "$work/backup.log"; exit 1; }
step "backup written: $(ls "$work/backups" | tr '\n' ' ')"

step "creating $dst_db (empty) and starting a second API"
dst_url=$(tool create-db "$dst_db")
migrate "$dst_url" >/dev/null
dst_port=$(tool free-port)
start_api dst "$dst_url" "$dst_port" "$work/storage-dst"
step "restoring into the empty install on port $dst_port and verifying"
tool verify "http://127.0.0.1:$dst_port" "$work/backups" "$work/state.json" "$dst_url"
