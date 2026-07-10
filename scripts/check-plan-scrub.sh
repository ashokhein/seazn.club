#!/usr/bin/env bash
# v3/03 §6 regression gate: the retired plan tier must never reappear in UI
# copy. The word (capitalised, standalone) is forbidden in component/app
# source; the lowercase `business` DB plan-key literal in lib/server code is
# deliberately out of scope.
set -euo pipefail

cd "$(dirname "$0")/.."

matches=$(grep -rn --include='*.ts' --include='*.tsx' -w 'Business' \
  apps/web/src/components apps/web/src/app || true)

if [[ -n "$matches" ]]; then
  echo "Plan-scrub gate failed — 'Business' found in UI source (v3/03 §6):"
  echo "$matches"
  exit 1
fi
echo "plan-scrub gate ok"
