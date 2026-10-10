#!/usr/bin/env bash
# Staging checks for the deploy workflow (docs/runbooks/staging-deploy.md).
#
#   staging-smoke.sh wait    poll the API's /health/ready until it reports the expected SHA (hard timeout)
#   staging-smoke.sh check   health live and ready, version, web root 200, unknown route 404, core-journey hook
#
# Environment:
#   POII_WEB_BASE_URL            required, e.g. https://poii-staging.example.org
#   POII_API_BASE_URL            optional; where /health/* of the API is routed (default: POII_WEB_BASE_URL,
#                                 which works when Dokploy routes the path /health on the web host to the api service)
#   POII_EXPECTED_SHA            required; the source SHA the deployment must report
#   POII_READY_TIMEOUT_SECONDS   optional, default 600 (wait only)
#   POII_READY_INTERVAL_SECONDS  optional, default 10 (wait only)
#   POII_STAGING_E2E_AUTH        optional; name of an approved staging sign-in method for the Playwright smoke.
#                                 None exists yet, so leave it unset and the smoke is skipped with a reason.
# Needs bash, curl and node (for JSON parsing). Prints status and version, never response bodies.
set -euo pipefail

mode="${1:-}"
web_base="${POII_WEB_BASE_URL:-}"
api_base="${POII_API_BASE_URL:-$web_base}"
expected="${POII_EXPECTED_SHA:-}"
web_base="${web_base%/}"
api_base="${api_base%/}"

die() { echo "::error::$*" >&2; exit 1; }
[ -n "$web_base" ] || die "POII_WEB_BASE_URL is required"
[ -n "$expected" ] || die "POII_EXPECTED_SHA is required"
command -v curl >/dev/null || die "curl is required"
command -v node >/dev/null || die "node is required for JSON parsing"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0

# fetch URL -> sets $code and writes the body to $work/body
fetch() {
  : > "$work/body"
  code="$(curl -sS -o "$work/body" -w '%{http_code}' --max-time 15 -H 'accept: application/json' "$1" 2>/dev/null)" || code="000"
}

# json_field NAME -> prints the top-level string field NAME of $work/body, empty if absent or not JSON
json_field() {
  node -e '
    let s = "";
    process.stdin.on("data", d => (s += d)).on("end", () => {
      try { const v = JSON.parse(s)[process.argv[1]]; process.stdout.write(typeof v === "string" ? v : ""); }
      catch { process.stdout.write(""); }
    });' "$1" < "$work/body"
}

pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; failures=$((failures + 1)); }

check_health() { # path wanted_status
  local path="$1" want="$2" status version
  fetch "$api_base$path"
  status="$(json_field status)"; version="$(json_field version)"
  if [ "$code" = 200 ] && [ "$status" = "$want" ] && [ "$version" = "$expected" ]; then
    pass "GET $path -> 200, status $status, version $version"
  else
    fail "GET $path -> HTTP $code, status '${status:-?}', version '${version:-?}' (want 200, '$want', '$expected')"
  fi
}

check_web() { # path wanted_code label
  fetch "$web_base$1"
  if [ "$code" = "$2" ]; then pass "GET $3 -> $code"; else fail "GET $3 -> HTTP $code (want $2)"; fi
}

run_core_journey_smoke() {
  if [ -z "${POII_STAGING_E2E_AUTH:-}" ]; then
    echo "SKIP  core-journey Playwright smoke: no authentication method is approved for staging yet."
    echo "      local-owner is loopback-only unless POII_ALLOW_LOCAL_OWNER_REMOTE is set deliberately,"
    echo "      and local sign-in is still being built (#14). Set POII_STAGING_E2E_AUTH once one is approved."
    return 0
  fi
  # Hook: the Playwright config (apps/web/playwright.config.ts) starts local servers and cannot target staging yet.
  # When a staging sign-in method is approved, add a staging project there and call it from here.
  fail "core-journey smoke requested with POII_STAGING_E2E_AUTH='$POII_STAGING_E2E_AUTH', but no staging runner is implemented yet"
}

case "$mode" in
  wait)
    timeout="${POII_READY_TIMEOUT_SECONDS:-600}"
    interval="${POII_READY_INTERVAL_SECONDS:-10}"
    deadline=$(( $(date +%s) + timeout ))
    echo "Waiting up to ${timeout}s for $api_base/health/ready to report $expected"
    last=""
    while :; do
      fetch "$api_base/health/ready"
      status="$(json_field status)"; version="$(json_field version)"
      now="HTTP $code, status '${status:-?}', version '${version:-?}'"
      [ "$now" = "$last" ] || { echo "$(date -u +%H:%M:%SZ)  $now"; last="$now"; }
      if [ "$code" = 200 ] && [ "$status" = ready ] && [ "$version" = "$expected" ]; then
        echo "Ready: the API reports $version"
        [ -z "${GITHUB_OUTPUT:-}" ] || echo "observed_ready_version=$version" >> "$GITHUB_OUTPUT"
        exit 0
      fi
      if [ "$(date +%s)" -ge "$deadline" ]; then
        die "Timed out after ${timeout}s: /health/ready never reported $expected (last: $now)"
      fi
      sleep "$interval"
    done
    ;;
  check)
    echo "Staging smoke against web $web_base, API health $api_base, expecting $expected"
    check_health /health/live ok
    check_health /health/ready ready
    check_web / 200 "web root"
    check_web "/poii-smoke-unknown-route-$(date +%s)" 404 "unknown route"
    run_core_journey_smoke
    if [ "$failures" -gt 0 ]; then die "$failures staging smoke check(s) failed"; fi
    echo "All staging smoke checks passed"
    ;;
  *)
    die "usage: staging-smoke.sh wait|check"
    ;;
esac
