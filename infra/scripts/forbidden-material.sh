#!/usr/bin/env bash
# Fails when tracked files look like private evidence, environment files or dumps.
set -euo pipefail
forbidden=$(git ls-files | grep -Ei '(^|/)(evidence|project_sources|private|generated)/|(^|/)\.env($|\.)|\.dump$|\.sql\.gz$|source.?pack|conversation.?archive|chatgpt.*export|claude.*export|\.zip$' | grep -Ev '(^|/)\.env\.example$' || true)
if [ -n "$forbidden" ]; then
  echo 'Forbidden private material, dump or environment file is tracked:'
  echo "$forbidden"
  exit 1
fi
echo 'No forbidden material tracked'
