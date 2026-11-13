#!/usr/bin/env bash
# Measures how `npx` starts renor-engine with an isolated npm cache, so the update and offline cases are reproducible.
#
#   bash scripts/npx/measure-npx-update.sh            prints a table (needs the npm registry for the online rows)
#
# Rows: first run online; the cache entry downgraded by hand (spec ^OLD) then run online; and each of those with the
# registry unreachable (a dead local proxy, so nothing leaves the machine), with the plain command and with --prefer-offline.
# Nothing here touches your own npm cache or home folder.
set -u
OLD="${OLD:-1.4.7}"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
export HOME="$ROOT/home" npm_config_cache="$ROOT/cache" npm_config_update_notifier=false
mkdir -p "$HOME"
DEAD="http://127.0.0.1:9" # nothing listens on the discard port

run() { # label, extra env assignments..., then npx args
  local label="$1"; shift
  local start end out code
  start=$(date +%s.%N)
  out=$(env "$@" 2>&1 | tail -n 1); code=${PIPESTATUS[0]}
  end=$(date +%s.%N)
  printf '| %s | %.1fs | %s |\n' "$label" "$(echo "$end - $start" | bc -l)" "${out:0:80}"
}

echo "npm $(npm --version), node $(node --version)"
echo "| situation | time | last line of output |"
echo "|---|---|---|"
run "first run, online" npx -y renor-engine --version
run "current copy cached, registry unreachable" npm_config_registry="$DEAD" npx -y renor-engine --version
run "same, --prefer-offline" npm_config_registry="$DEAD" npx --prefer-offline -y renor-engine --version
# Downgrade: a fresh cache entry for the OLD spec, then start the unpinned command online.
run "old copy (renor-engine@$OLD) cached" npx -y "renor-engine@$OLD" --version
run "old copy cached, unpinned command, online" npx -y renor-engine --version
run "old copy cached, registry unreachable" npm_config_registry="$DEAD" npx -y "renor-engine@$OLD" --version
run "old copy cached, --prefer-offline, online" npx --prefer-offline -y renor-engine --version
