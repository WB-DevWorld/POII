#!/usr/bin/env bash
# Staging checks for the deploy workflow (docs/runbooks/staging-deploy.md).
#
#   staging-smoke.sh wait    poll the API's /health/ready until it reports the expected SHA (hard timeout)
#   staging-smoke.sh check   health live and ready, version, web root, unknown route, no HTTP/3 offer,
#                             core-journey hook
#                             Web root: 200, or a redirect to this host's /signin whose page answers 200.
#                             Unknown route: 404, or a redirect to this host's /signin. An instance that
#                             requires sign-in redirects every signed-out request there, so it reveals
#                             no route.
#                             No HTTP/3 offer: no Alt-Svc response header that names h3. Dokploy's Traefik
#                             offers HTTP/3 by default; on staging that stalled signed-in browser sessions
#                             (LIVE-ENVIRONMENT-FACTS.md, 2026-11-25).
#
# Environment:
#   POII_WEB_BASE_URL            required, e.g. https://poii-staging.example.org
#   POII_API_BASE_URL            optional; where /health/* of the API is routed (default: POII_WEB_BASE_URL,
#                                 which works when Dokploy routes the path /health on the web host to the api service)
#   POII_EXPECTED_SHA            required; the source SHA the deployment must report
#   POII_READY_TIMEOUT_SECONDS   optional, default 600 (wait only)
#   POII_READY_INTERVAL_SECONDS  optional, default 10 (wait only)
#   POII_ALLOW_HTTP3             optional; `true` skips the HTTP/3 check, for a host where HTTP/3 is proven to work
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

# fetch URL -> sets $code and $redirect (absolute target of a redirect, else empty) and writes the body
# to $work/body and the response headers to $work/headers. Redirects are reported, never followed.
fetch() {
  local out
  : > "$work/body"
  : > "$work/headers"
  out="$(curl -sS -o "$work/body" -D "$work/headers" -w '%{http_code} %{redirect_url}' --max-time 15 -H 'accept: application/json' "$1" 2>/dev/null)" || out="000 "
  code="${out%% *}"
  redirect="${out#* }"
}

# True when the last fetch was a redirect to the sign-in page of the web host itself.
redirected_to_signin() {
  case "$code" in 302|303|307|308) ;; *) return 1 ;; esac
  [ "$redirect" = "$web_base/signin" ] || [[ "$redirect" == "$web_base/signin?"* ]]
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

check_web_root() {
  fetch "$web_base/"
  if [ "$code" = 200 ]; then pass "GET web root -> 200"; return; fi
  if redirected_to_signin; then
    local first="$code"
    fetch "$web_base/signin"
    if [ "$code" = 200 ]; then pass "GET web root -> $first to /signin, sign-in page -> 200"
    else fail "GET web root -> $first to /signin, but the sign-in page -> HTTP $code (want 200)"; fi
    return
  fi
  fail "GET web root -> HTTP $code (want 200, or a redirect to /signin on this host)"
}

check_unknown_route() {
  fetch "$web_base/poii-smoke-unknown-route-$(date +%s)"
  if [ "$code" = 404 ]; then pass "GET unknown route -> 404"
  elif redirected_to_signin; then pass "GET unknown route -> $code to /signin (sign-in is required before any route answers)"
  else fail "GET unknown route -> HTTP $code (want 404, or a redirect to /signin on this host)"; fi
}

# The web host must not offer HTTP/3. An Alt-Svc header naming h3 moves browsers to UDP 443 for up to the
# header's max-age; where that path does not work, pages stall for a minute at a time while every check
# over TCP stays green.
check_no_http3() {
  if [ "${POII_ALLOW_HTTP3:-}" = true ]; then
    echo "SKIP  HTTP/3 offer: not checked, POII_ALLOW_HTTP3 is true"
    return 0
  fi
  fetch "$web_base/"
  if [ "$code" = 000 ]; then fail "HTTP/3 offer: the web root did not answer, so its headers could not be read"; return; fi
  if grep -i '^alt-svc:' "$work/headers" | grep -qi 'h3'; then
    fail "the web host offers HTTP/3 (Alt-Svc names h3). Switch it off in Traefik (docs/runbooks/staging-deploy.md, HTTP/3 off in Traefik), or set POII_ALLOW_HTTP3=true once HTTP/3 is proven to work"
  else
    pass "no HTTP/3 offer (no Alt-Svc header naming h3)"
  fi
}

run_core_journey_smoke() {
  if [ -z "${POII_STAGING_E2E_AUTH:-}" ]; then
    echo "SKIP  core-journey Playwright smoke: no authentication method is approved for staging yet."
    echo "      Staging requires sign-in, and no credential for an automated browser is approved."
    echo "      Set POII_STAGING_E2E_AUTH once one is approved."
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
    check_web_root
    check_unknown_route
    check_no_http3
    run_core_journey_smoke
    if [ "$failures" -gt 0 ]; then die "$failures staging smoke check(s) failed"; fi
    echo "All staging smoke checks passed"
    ;;
  *)
    die "usage: staging-smoke.sh wait|check"
    ;;
esac
