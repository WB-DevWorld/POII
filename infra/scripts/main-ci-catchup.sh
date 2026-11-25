#!/usr/bin/env bash
# Release path for a commit that reached main by auto-merge (.github/workflows/main-ci-catchup.yml).
#
# Routine pull requests are merged by GitHub auto-merge, which `classify` enables with the workflow token.
# GitHub starts no workflow for a push made with that token, so such a commit gets no CI by itself. And when
# a run that was started with the workflow token finishes, GitHub raises no `workflow_run` event either, so
# nothing follows a CI run started from here (observed on 2026-11-25 with #81, `d0edd19`). This script
# therefore walks the release path itself, one step after the other:
#
#   CI on main  ->  Publish immutable images  ->  Deploy staging  ->  Deploy production (started, not awaited)
#
# Each step starts only after the one before succeeded and while main still points at the same commit. A
# commit pushed by a person or an app starts CI by that push and is left alone. A commit whose CI was started
# here earlier and passed, but which has no published images, is picked up again at the publish step, so a
# later run (schedule, manual) repairs a chain that broke.
#
# It reads pull request and run metadata and starts workflows on main. It never runs code from a pull request.
#
# Environment:
#   GH_TOKEN             required by `gh`; the workflow token (actions: write, contents and pull-requests: read)
#   REPO                 required, owner/name
#   EVENT                required, the event that started the workflow (workflow_run, schedule, workflow_dispatch)
#   PR_NUMBER            optional; the pull request of the finished run, when the event names one
#   STAGING_ENABLED      optional; the repository variable POII_STAGING_ENABLED
#   PRODUCTION_ENABLED   optional; the repository variable POII_PRODUCTION_ENABLED
#   CATCHUP_NO_SLEEP     optional; `1` skips every wait (tests)
# Needs bash, GNU date and gh. Prints SHAs, run ids and states only.
set -euo pipefail

: "${REPO:?REPO is required}"
: "${EVENT:?EVENT is required}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
note() { echo "$1" | tee -a "$summary"; }
nap() { [ "${CATCHUP_NO_SLEEP:-}" = 1 ] || sleep "$1"; }
echo "## Main CI catch-up" >> "$summary"

if [ "$EVENT" = workflow_run ]; then
  # GitHub leaves the run's pull request list empty once the pull request is merged or closed, which an
  # auto-merge can be by the time this runs. Then only the head of main is looked at, below.
  if ! [[ "${PR_NUMBER:-}" =~ ^[0-9]+$ ]]; then
    note "The finished run names no pull request. Looking at the head of main only."
  else
    # Auto-merge lands seconds after the last required check. Wait for it, at most three minutes.
    state=waiting
    for _ in $(seq 1 12); do
      state="$(gh api "repos/$REPO/pulls/$PR_NUMBER" --jq '
        if .merged then (if .merged_by.login == "github-actions[bot]" then "auto-merged" else "merged-by-someone" end)
        elif .state != "open" then "closed"
        elif .auto_merge != null then "waiting"
        else "no-auto-merge" end')"
      [ "$state" = waiting ] || break
      nap 15
    done
    case "$state" in
      auto-merged) note "PR #$PR_NUMBER was merged by auto-merge." ;;
      merged-by-someone) note "PR #$PR_NUMBER was merged by a person or an app; that push starts CI itself."; exit 0 ;;
      waiting) note "PR #$PR_NUMBER has auto-merge on but has not merged yet. The scheduled run covers it."; exit 0 ;;
      *) note "PR #$PR_NUMBER is not auto-merging ($state). Nothing to do."; exit 0 ;;
    esac
  fi
fi

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Sets $sha and $committed (the head of main and its commit time).
read_head() {
  local line
  line="$(gh api "repos/$REPO/commits/main" --jq '[.sha, .commit.committer.date] | @tsv')"
  sha="${line%%$'\t'*}"
  committed="${line#*$'\t'}"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { note "Could not read the head of main."; exit 1; }
}

# Sets $ci_count and, for the newest CI run of $sha on main, $ci_event, $ci_actor, $ci_status, $ci_conclusion.
# A failed or odd answer stops the job: it must never be read as "no run", which would start CI needlessly.
read_ci() {
  local line
  line="$(gh api -X GET "repos/$REPO/actions/workflows/ci.yml/runs" -f branch=main -f head_sha="$sha" -f per_page=1 --jq '
    [.total_count, (.workflow_runs[0].event // "-"), (.workflow_runs[0].triggering_actor.login // "-"),
     (.workflow_runs[0].status // "-"), (.workflow_runs[0].conclusion // "-")] | @tsv')"
  IFS=$'\t' read -r ci_count ci_event ci_actor ci_status ci_conclusion <<<"$line"
  [[ "${ci_count:-}" =~ ^[0-9]+$ ]] || { note "Could not count the CI runs of \`$sha\`."; exit 1; }
}

still_head() { [ "$(gh api "repos/$REPO/commits/main" --jq .sha)" = "$sha" ]; }

# wait_for_run FILE LABEL MINUTES SINCE: waits for the run of FILE that was started by dispatch on main for
# $sha at or after SINCE. Returns 0 only when that run succeeded.
wait_for_run() {
  local file="$1" label="$2" minutes="$3" since="$4" id="" line status="" conclusion=""
  for _ in $(seq 1 18); do
    id="$(gh api -X GET "repos/$REPO/actions/workflows/$file/runs" -f branch=main -f head_sha="$sha" \
      -f event=workflow_dispatch -f created=">=$since" -f per_page=1 --jq '.workflow_runs[0].id // empty')"
    [ -n "$id" ] && break
    nap 10
  done
  [[ "$id" =~ ^[0-9]+$ ]] || { note "$label: the started run for \`$sha\` did not appear within three minutes (main may have moved on). The chain stops here."; return 1; }
  for _ in $(seq 1 $(( minutes * 3 ))); do
    line="$(gh api "repos/$REPO/actions/runs/$id" --jq '[.status, (.conclusion // "none")] | @tsv')"
    status="${line%%$'\t'*}"
    conclusion="${line#*$'\t'}"
    [ "$status" = completed ] && break
    nap 20
  done
  if [ "$status" != completed ]; then note "$label run [$id](https://github.com/$REPO/actions/runs/$id) did not finish within $minutes minutes. The chain stops here."; return 1; fi
  if [ "$conclusion" != success ]; then note "$label run [$id](https://github.com/$REPO/actions/runs/$id) ended as \`$conclusion\`. The chain stops here."; return 1; fi
  note "$label run [$id](https://github.com/$REPO/actions/runs/$id) succeeded."
}

read_head
read_ci
start_at=none
if [ "$ci_count" -eq 0 ]; then
  # A push by a person starts CI within seconds; do not race it.
  age=$(( $(date +%s) - $(date -d "$committed" +%s) ))
  if [ "$age" -lt 60 ]; then
    nap $(( 60 - age ))
    read_ci
  fi
  if [ "$ci_count" -eq 0 ]; then start_at=ci; fi
fi
if [ "$start_at" = none ]; then
  if [ "$ci_event" != workflow_dispatch ] || [ "$ci_actor" != "github-actions[bot]" ]; then
    note "main \`$sha\` already has a CI run. Nothing to do."
    exit 0
  fi
  # The newest CI run of this commit was started with the workflow token: by an earlier run of this script.
  if [ "$ci_status" != completed ]; then
    note "main \`$sha\`: the CI run started by an earlier catch-up is still running. Nothing to do now."
    exit 0
  fi
  if [ "$ci_conclusion" != success ]; then
    note "main \`$sha\`: the CI run started by an earlier catch-up ended as \`$ci_conclusion\`. Nothing is published."
    exit 0
  fi
  released="$(gh api -X GET "repos/$REPO/actions/artifacts" -f name="poii-release-$sha" -f per_page=100 \
    --jq '[.artifacts[] | select(.expired | not)] | length')"
  [[ "$released" =~ ^[0-9]+$ ]] || { note "Could not look for the published release of \`$sha\`."; exit 1; }
  if [ "$released" -gt 0 ]; then
    note "main \`$sha\` already has CI and published images. Nothing to do."
    exit 0
  fi
  note "main \`$sha\` has a passed CI run that was started with the workflow token, and no published images. Continuing at the publish step."
  start_at=publish
fi

if [ "$start_at" = ci ]; then
  since="$(now)"
  gh workflow run ci.yml --repo "$REPO" --ref main
  note "main \`$sha\` had no CI run (merged with the workflow token). Started CI on main."
  wait_for_run ci.yml "CI" 30 "$since" || exit 1
fi

if ! still_head; then note "main has moved on from \`$sha\`. The newer commit takes over; nothing more is started for this one."; exit 0; fi
since="$(now)"
gh workflow run publish.yml --repo "$REPO" --ref main
note "Started the image publish for \`$sha\`."
wait_for_run publish.yml "Publish immutable images" 30 "$since" || exit 1

if [ "${STAGING_ENABLED:-}" != true ]; then note "Staging deploys are switched off. The chain ends here."; exit 0; fi
if ! still_head; then note "main has moved on from \`$sha\`. The newer commit takes over; nothing is deployed for this one."; exit 0; fi
since="$(now)"
gh workflow run deploy-staging.yml --repo "$REPO" --ref main -f source_sha="$sha"
note "Started the staging deploy of \`$sha\`."
wait_for_run deploy-staging.yml "Deploy staging" 45 "$since" || exit 1

if [ "${PRODUCTION_ENABLED:-}" != true ]; then note "Production deploys are switched off. The chain ends here."; exit 0; fi
gh workflow run deploy-production.yml --repo "$REPO" --ref main -f source_sha="$sha"
note "Started Deploy production for \`$sha\`. It decides the promotion class itself and is not waited for."
