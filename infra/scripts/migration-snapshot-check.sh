#!/usr/bin/env bash
# Fails when `drizzle-kit generate` would write a migration for the committed schema: the TypeScript schema
# (apps/api/src/db/schema/) and the newest snapshot in apps/api/drizzle/meta/ must describe the same database.
# A hand-written migration without its snapshot, or a schema change without its migration, both end here.
# Needs Node and installed dependencies; no database (generate compares the schema with the snapshot only).
#
# The working tree is never touched: generate runs against a scratch copy of apps/api/drizzle, through a
# wrapper config that reuses apps/api/drizzle.config.ts and only replaces `out`. The scratch copy sits in
# apps/api/node_modules/.cache (git-ignored) because drizzle-kit 0.31 resolves `out` relative to the working
# directory and cannot take an absolute path. It is removed on exit.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root/apps/api"
mkdir -p node_modules/.cache
scratch=$(mktemp -d node_modules/.cache/poii-snapshot-check.XXXXXX)
trap 'rm -rf "$root/apps/api/$scratch"' EXIT

cp -R drizzle "$scratch/drizzle"
# Two levels below node_modules: ../../../ is apps/api.
cat > "$scratch/drizzle.config.cjs" <<'EOF'
const loaded = require('../../../drizzle.config.ts');
module.exports = { ...(loaded.default ?? loaded), out: process.env.POII_SNAPSHOT_CHECK_OUT };
EOF

listing() { (cd "$scratch/drizzle" && find . -type f | LC_ALL=C sort); }
before=$(listing)
status=0
POII_SNAPSHOT_CHECK_OUT="$scratch/drizzle" pnpm exec drizzle-kit generate --config "$scratch/drizzle.config.cjs" \
  </dev/null >"$scratch/generate.log" 2>&1 || status=$?
added=$(comm -13 <(printf '%s\n' "$before") <(listing))

if [ -n "$added" ]; then
  echo "drizzle-kit generate would write a migration: the schema and the newest snapshot differ."
  while IFS= read -r file; do
    case "$file" in
      *.sql)
        echo "Would generate apps/api/drizzle/${file#./}:"
        sed 's/^/    /' "$scratch/drizzle/$file"
        echo
        ;;
      *) echo "Would also write apps/api/drizzle/${file#./}" ;;
    esac
  done <<< "$added"
  echo "Fix: run 'pnpm --filter @poii/api migrate:generate' and commit the migration with its snapshot,"
  echo "or revert the schema change. A hand-written migration needs its meta/NNNN_snapshot.json too."
  exit 1
fi
# No new file is not enough: drizzle-kit also writes nothing (and exits 0) when a snapshot is malformed or two
# snapshots share a parent. Only its own "nothing to migrate" line, with an untouched journal, counts as a pass.
if [ "$status" -ne 0 ] || ! grep -q 'nothing to migrate' "$scratch/generate.log" \
  || ! cmp -s drizzle/meta/_journal.json "$scratch/drizzle/meta/_journal.json"; then
  echo "drizzle-kit generate did not report a clean no-op (exit $status). Its output:"
  sed 's/^/    /' "$scratch/generate.log"
  exit 1
fi
echo "Snapshots match the schema: drizzle-kit generate has nothing to migrate"
