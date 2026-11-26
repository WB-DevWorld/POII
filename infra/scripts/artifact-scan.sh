#!/usr/bin/env bash
# Looks inside what CI builds and uploads, for BUILD-BASELINE.md section 8, criterion 10 ("no secrets or private
# evidence in the repository, images, logs or artifacts"). The repository itself is covered elsewhere: gitleaks
# over the history (ci.yml) and forbidden-material.sh over tracked file names.
#
#   artifact-scan.sh image <image-ref>   a local container image, e.g. poii-api:ci
#   artifact-scan.sh dir <path>          a directory about to be uploaded, e.g. apps/web/playwright-report
#
# image checks
#   names    every path in every layer of the image (base image included) against the patterns of
#            forbidden-material.sh: private evidence directories, .env files, dumps, archives.
#   runtime  things a runtime image must not carry: .git, the repository's fixtures/ (neither Dockerfile copies
#            them; if one ever does on purpose, drop that rule in the same change), tests with recorded provider
#            responses, scripts/agent-token.mjs.
#   content  gitleaks (directory mode, the repository's .gitleaks.toml) over /app in every layer, node_modules
#            included, and over the image configuration (environment, labels, build history).
# dir checks
#   names    the same patterns over the directory.
#   content  gitleaks over every file, into zip archives two levels deep (Playwright traces), and into zip
#            archives embedded in HTML as base64 (the Playwright report keeps its data that way in index.html;
#            reported as embedded/<file>.<n>.zip).
#
# How the image is read: `docker save`, every layer unpacked on its own. A file that a later layer deletes or
# replaces is therefore still seen, and reported with its layer.
#
# What this does not see:
#   - build stages. Only the layers of the final image are in it; what a build stage copied and left behind
#     stays in the builder cache and is never pushed.
#   - the content of the base image and of anything outside /app (names are checked there, content is not).
#     POII_SCAN_PATHS (space separated, default "app") changes which top-level directories are read.
#   - secrets that no gitleaks rule knows (a plain password, an owner token of this application), and content
#     that is compressed, encrypted or encoded other than as described above.
#   - a line marked gitleaks:allow, exactly as in the repository scan.
#   - application logs on a server. Nothing here reads those.
#
#   - a path that .gitleaks.toml allows from the repository root (^fixtures/): gitleaks sees the artifact's
#     paths below a directory of its own, so such an entry does not apply here. Its value patterns do.
#
# Output: one line per finding with the rule and the path, never the matched text. FAIL lines fail the scan.
# KNOWN lines are findings listed below with their reason: printed on every run, not a failure. Exit 0 when
# there is no FAIL line, 1 when there is one, 2 when the scan itself could not run.
#
# Needs bash, tar and docker. Nothing is unpacked on the machine that runs this: the artifact is piped into a
# container of the gitleaks image (the one ci.yml uses for the history scan) that has no network, the same
# script runs in there as `__inside`, and the container is removed on exit, with everything that was unpacked.
set -euo pipefail

# The image and version of the history scan in .github/workflows/ci.yml; artifact-scan.test.mjs holds them together.
GITLEAKS_IMAGE='ghcr.io/gitleaks/gitleaks:v8.30.1'

# The patterns of forbidden-material.sh, word for word; artifact-scan.test.mjs holds them together.
FORBIDDEN_NAMES='(^|/)(evidence|project_sources|private|generated)/|(^|/)\.env($|\.)|\.dump$|\.sql\.gz$|source.?pack|conversation.?archive|chatgpt.*export|claude.*export|\.zip$'
FORBIDDEN_NAMES_EXCEPT='(^|/)\.env\.example$'

# Names that match the patterns above and are not ours. Keep both lists short and each entry explained.
ALLOWED_IN_IMAGE=(
  # Alpine's empty directory for TLS private keys.
  '^etc/ssl/private/$'
  # "source.?pack" also reads "..._resource/package.json", a helper of @swc/helpers.
  '(^|/)node_modules/@swc/helpers/_/[a-z_]+_resource/package\.json$'
)
ALLOWED_IN_DIR=(
  # Playwright stores each trace as data/<sha1>.zip. Its content is still read (archive depth 2).
  '^data/[0-9a-f]{40}\.zip$'
)

# Content findings that are known and do not fail the scan. Rule and path pattern, separated by a space. Each
# one is printed as KNOWN on every run, so it stays in view; an entry covers that rule in the whole file.
KNOWN_IN_IMAGE=(
  # Next.js writes three keys into its build output on every build: the preview (draft mode) id with its
  # signing and encryption key, and the key that encrypts what server actions close over. They are generated
  # per build and are in every web image. Whoever can pull the image can read them; whether that matters is
  # a decision about who may pull the image and what the server actions close over, not about this scan.
  'generic-api-key ^app/apps/web/\.next/(prerender-manifest\.json|server/preview-props\.json)$'
  'generic-api-key ^app/apps/web/\.next/server/server-reference-manifest\.json$'
)
KNOWN_IN_DIR=(
  # The trace viewer that Playwright copies into a report with traces bundles xterm.js, whose minified code
  # reads like a key assignment to the generic rule ("...KeyMap=..."). Checked against Playwright 1.64.1.
  'generic-api-key ^trace/assets/xtermModule-[A-Za-z0-9_-]+\.js$'
)

# Rule and pattern, separated by a space. Checked on paths outside node_modules, except .git, which is checked everywhere.
NOT_FOR_RUNTIME=(
  'git-directory (^|/)\.git(/|$)'
  'repository-fixtures ^[^/]+/fixtures(/|$)'
  'recorded-provider-response (^|/)test/recorded/.'
  'agent-token-script (^|/)agent-token\.mjs$'
)

fail() { echo "artifact-scan: $*" >&2; exit 2; }
usage() { echo 'usage: artifact-scan.sh image <image-ref> | dir <path>' >&2; exit 2; }
join_alternatives() { local IFS='|'; echo "$*"; }

# ---------------------------------------------------------------------------------------------------------
# Inside the scanner container. The artifact arrives as a tar stream on standard input.
# ---------------------------------------------------------------------------------------------------------
work=/work
known=()
record() { printf 'FAIL  %-28s %s\n' "$1" "$2" >> "$work/findings.txt"; }
# A content finding: $1 rule, $2 path, $3 line, $4 text appended to the path
record_secret() {
  local entry
  for entry in "${known[@]}"; do
    if [ "$1" = "${entry%% *}" ] && echo "$2" | grep -Eq -- "${entry#* }"; then
      printf 'KNOWN %-28s %s\n' "secret:$1" "$2:$3$4" >> "$work/known.txt"
      return 0
    fi
  done
  record "secret:$1" "$2:$3$4"
}

# $1 a file with one path per line, $2 a regular expression of allowed names, $3 text appended to each path
check_forbidden_names() {
  { grep -Ei -- "$FORBIDDEN_NAMES" "$1" || true; } | { grep -Ev -- "$FORBIDDEN_NAMES_EXCEPT" || true; } |
    { grep -Ev -- "$2" || true; } | while IFS= read -r path; do record 'forbidden-name' "$path$3"; done
}

check_not_for_runtime() {
  local entry rule pattern
  for entry in "${NOT_FOR_RUNTIME[@]}"; do
    rule=${entry%% *}
    pattern=${entry#* }
    if [ "$rule" = 'git-directory' ]; then cat "$1"; else { grep -Ev '(^|/)node_modules/' "$1" || true; }; fi |
      { grep -E -- "$pattern" || true; } | while IFS= read -r path; do record "not-for-runtime:$rule" "$path$2"; done
  done
}

# gitleaks over $work/scan. Paths and rule names go to the findings; the matched text is never written anywhere.
check_content() {
  local status=0
  printf '%s' '{{range .}}{{.RuleID}}{{"\t"}}{{.File}}{{"\t"}}{{.StartLine}}{{"\n"}}{{end}}' > "$work/report.tmpl"
  (cd "$work/scan" && gitleaks dir . --no-banner --redact --max-archive-depth 2 --exit-code 3 --log-level error \
    --report-format template --report-template "$work/report.tmpl" --report-path "$work/report.txt") > "$work/gitleaks.log" 2>&1 || status=$?
  if [ "$status" -ne 0 ] && [ "$status" -ne 3 ]; then
    cat "$work/gitleaks.log" >&2
    fail "gitleaks stopped with status $status"
  fi
  [ -s "$work/report.txt" ] || return 0
  # layer-07/app/x -> app/x (layer 7); files/x -> x
  while IFS=$'\t' read -r rule file line; do
    file=${file#./}
    case "$file" in
      layer-*) layer=${file%%/*}; layer=$((10#${layer#layer-})); record_secret "$rule" "${file#*/}" "$line" " (layer $layer)" ;;
      files/*) record_secret "$rule" "${file#files/}" "$line" '' ;;
      *) record_secret "$rule" "$file" "$line" '' ;;
    esac
  done < "$work/report.txt"
}

finish() {
  local count
  sort -u "$work/known.txt" -o "$work/known.txt"
  sort -u "$work/findings.txt" -o "$work/findings.txt"
  cat "$work/known.txt"
  count=$(wc -l < "$work/findings.txt")
  if [ "$count" -gt 0 ]; then
    sed -n '1,200p' "$work/findings.txt"
    [ "$count" -le 200 ] || echo "... and more: $count lines in all, the first 200 are shown"
    echo "artifact-scan $1: $count finding(s). $2"
    exit 1
  fi
  count=$(wc -l < "$work/known.txt")
  if [ "$count" -gt 0 ]; then
    echo "artifact-scan $1: nothing found beyond the $count known line(s) above. $2"
  else
    echo "artifact-scan $1: nothing found. $2"
  fi
}

inside_image() {
  local scan_paths=${POII_SCAN_PATHS:-app} allowed manifest layers total n=0 read_layers=0 names layer config path_pattern
  allowed=$(join_alternatives "${ALLOWED_IN_IMAGE[@]}")
  known=("${KNOWN_IN_IMAGE[@]}")
  path_pattern="^($(join_alternatives $scan_paths))(/|\$)"
  tar -xf - -C "$work/in" || fail 'could not unpack the docker save archive'
  manifest="$work/in/manifest.json"
  [ -f "$manifest" ] || fail 'no manifest.json: not a docker save archive'
  layers=$(grep -o '"Layers":\[[^]]*\]' "$manifest" | grep -o '"[^",]*"' | tr -d '"' | grep -v '^Layers$' | awk '!seen[$0]++')
  [ -n "$layers" ] || fail 'manifest.json names no layers'
  total=$(echo "$layers" | wc -l)
  for layer in $layers; do
    n=$((n + 1))
    names="$work/names-$n.txt"
    # busybox tar reads plain and gzip layers alike
    tar -tf "$work/in/$layer" > "$names" 2>/dev/null || fail "could not list layer $n of $total"
    sed -i 's|^\./||' "$names"
    cat "$names" >> "$work/names.txt"
    check_forbidden_names "$names" "$allowed" " (layer $n)"
    check_not_for_runtime "$names" " (layer $n)"
    if grep -Eq -- "$path_pattern" "$names"; then
      mkdir -p "$work/scan/$(printf 'layer-%02d' "$n")"
      # A member that is not in this layer makes tar complain; the listing above already told us what is there.
      for member in $scan_paths; do
        if grep -Eq -- "^($member)(/|\$)" "$names"; then
          tar -xf "$work/in/$layer" -C "$work/scan/$(printf 'layer-%02d' "$n")" "$member" 2>> "$work/tar.log" || fail "could not unpack /$member of layer $n"
        fi
      done
      read_layers=$((read_layers + 1))
    fi
  done
  [ "$read_layers" -gt 0 ] || fail "no layer holds /${scan_paths// / or /}: nothing of the application would be read (POII_SCAN_PATHS)"
  for config in $(grep -o '"Config":"[^"]*"' "$manifest" | cut -d'"' -f4); do
    cp "$work/in/$config" "$work/scan/image-config.json"
  done
  check_content
  finish "image $2" "$(wc -l < "$work/names.txt") paths in $total layers checked by name; gitleaks read /${scan_paths// / and /} in $read_layers layer(s) and the image configuration."
}

inside_dir() {
  local allowed file rel count n embedded=0
  allowed=$(join_alternatives "${ALLOWED_IN_DIR[@]}")
  known=("${KNOWN_IN_DIR[@]}")
  mkdir -p "$work/scan/files"
  tar -xf - -C "$work/scan/files" || fail 'could not unpack the directory'
  (cd "$work/scan/files" && find . -mindepth 1 | sed 's|^\./||') > "$work/names.txt"
  check_forbidden_names "$work/names.txt" "$allowed" ''
  # A zip that an HTML file carries as base64 is written out so that gitleaks reads what is in it, and taken
  # out of the copy of the HTML file: megabytes of base64 on one line are noise to every rule.
  while IFS= read -r -d '' file; do
    rel=${file#"$work/scan/files/"}
    count=$({ grep -o 'data:application/zip;base64,[A-Za-z0-9+/=]*' "$file" || true; } | wc -l)
    [ "$count" -gt 0 ] || continue
    mkdir -p "$(dirname "$work/scan/embedded/$rel")"
    for n in $(seq 1 "$count"); do
      grep -o 'data:application/zip;base64,[A-Za-z0-9+/=]*' "$file" | sed -n "${n}p" | sed 's/^[^,]*,//' | base64 -d > "$work/scan/embedded/$rel.$n.zip" 2>/dev/null ||
        fail "could not decode zip $n embedded in $rel"
      unzip -tq "$work/scan/embedded/$rel.$n.zip" > /dev/null 2>&1 || fail "zip $n embedded in $rel is not readable"
      embedded=$((embedded + 1))
    done
    sed -i 's|data:application/zip;base64,[A-Za-z0-9+/=]*|data:application/zip;base64,|g' "$file"
  done < <(find "$work/scan/files" -type f \( -name '*.html' -o -name '*.htm' \) -print0)
  check_content
  finish "dir $2" "$(wc -l < "$work/names.txt") paths checked by name; gitleaks read every file, zip archives and $embedded zip(s) embedded in HTML."
}

if [ "${1:-}" = '__inside' ]; then
  mkdir -p "$work/in" "$work/scan"
  : > "$work/findings.txt"
  : > "$work/known.txt"
  : > "$work/names.txt"
  case "${2:-}" in
    image) inside_image "$2" "${3:-}" ;;
    dir) inside_dir "$2" "${3:-}" ;;
    *) usage ;;
  esac
  exit 0
fi

# ---------------------------------------------------------------------------------------------------------
# On the machine that has the artifact.
# ---------------------------------------------------------------------------------------------------------
mode=${1:-}
target=${2:-}
case "$mode" in image | dir) ;; *) usage ;; esac
[ -n "$target" ] || usage
[ "$mode" != 'dir' ] || [ -d "$target" ] || fail "not a directory: $target"
command -v docker > /dev/null || fail 'docker is required (gitleaks runs as a container)'

# Git Bash on Windows would rewrite /artifact-scan.sh and <container>:/ into Windows paths.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
self=$(basename "${BASH_SOURCE[0]}")
config=${POII_GITLEAKS_CONFIG:-$here/../../.gitleaks.toml}
[ -f "$config" ] || fail "gitleaks configuration not found: $config"
[ "$mode" != 'image' ] || docker image inspect "$target" > /dev/null 2>&1 || fail "no local image $target"

scanner=''
cleanup() { [ -z "$scanner" ] || docker rm -f "$scanner" > /dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT TERM

# gitleaks takes its configuration from this variable, so no path of this machine is mounted into the container.
GITLEAKS_CONFIG_TOML=$(cat "$config")
export GITLEAKS_CONFIG_TOML
scanner=$(docker create -i --network none -e GITLEAKS_CONFIG_TOML -e POII_SCAN_PATHS --entrypoint bash \
  "$GITLEAKS_IMAGE" "/$self" __inside "$mode" "$target") || fail "could not create the scanner container from $GITLEAKS_IMAGE"
tar -c -C "$here" "$self" | docker cp - "$scanner:/" > /dev/null || fail 'could not copy this script into the scanner container'
if [ "$mode" = 'image' ]; then
  docker save "$target" | docker start -a -i "$scanner"
else
  tar -c -C "$target" . | docker start -a -i "$scanner"
fi
