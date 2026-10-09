#!/usr/bin/env bash
# Applies the migrations of the previous release (origin/main) to a fresh database,
# then applies this change's migrations on top. Proves the expand/contract path works.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
base_ref="${BASE_REF:-origin/main}"
if ! git rev-parse --verify --quiet "$base_ref" >/dev/null; then
  git fetch --no-tags --depth=1 origin main >/dev/null 2>&1 || true
fi
if ! git rev-parse --verify --quiet "$base_ref" >/dev/null; then
  echo "No previous release available at $base_ref; skipping upgrade check"
  exit 0
fi
if git diff --quiet "$base_ref" -- apps/api/drizzle; then
  echo "Migrations unchanged against $base_ref; the from-empty run already covers this change"
  exit 0
fi
upgrade_db="poii_upgrade_check"
admin_url="${DATABASE_URL%/*}/postgres"
psql_run() { docker run --rm --network host -e PGPASSWORD postgres:17 psql "$1" -v ON_ERROR_STOP=1 -c "$2" >/dev/null; }
export PGPASSWORD="$(printf '%s' "$DATABASE_URL" | sed -E 's#.*://[^:]+:([^@]+)@.*#\1#')"
psql_run "$admin_url" "DROP DATABASE IF EXISTS $upgrade_db"
psql_run "$admin_url" "CREATE DATABASE $upgrade_db"
upgrade_url="${DATABASE_URL%/*}/$upgrade_db"
tmp=$(mktemp -d)
git archive "$base_ref" apps/api/drizzle | tar -x -C "$tmp"
echo "Applying previous-release migrations from $base_ref"
POII_MIGRATIONS_DIR="$tmp/apps/api/drizzle" DATABASE_URL="$upgrade_url" pnpm --filter @poii/api migrate
echo "Applying this change's migrations on top"
DATABASE_URL="$upgrade_url" pnpm --filter @poii/api migrate
psql_run "$admin_url" "DROP DATABASE IF EXISTS $upgrade_db"
echo "Upgrade path from $base_ref verified"
