#!/usr/bin/env bash

set -e
set -o pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

e2e_home=/tmp/pm2-captain-e2e
e2e_xdg=/tmp/pm2-captain-e2e-xdg
e2e_config="$e2e_xdg/pm2-captain"
e2e_token=pm2-captain-e2e-token

mkdir -p "$e2e_home"
chmod 700 "$e2e_home"
rm -rf -- "$e2e_xdg"
mkdir -p "$e2e_config"
chmod 700 "$e2e_config"
printf '%s\n' "$e2e_token" > "$e2e_config/launch-token"
# An existing daemon list, even an empty one, stops Captain from detecting the
# developer's own PM2 daemons. --pm2-home below adds the fixture daemon.
printf '{"version":1,"daemons":[]}\n' > "$e2e_config/daemons.json"
chmod 600 "$e2e_config/launch-token" "$e2e_config/daemons.json"

PM2_HOME="$e2e_home" ./node_modules/.bin/pm2 delete all >/dev/null 2>&1 || true
PM2_HOME="$e2e_home" ./node_modules/.bin/pm2 flush >/dev/null 2>&1 || true
PM2_CAPTAIN_E2E_ENV=visible PM2_HOME="$e2e_home" ./node_modules/.bin/pm2 start tests/fixtures/process.cjs \
  --name captain-fixture >/dev/null

cleanup() {
  PM2_HOME="$e2e_home" ./node_modules/.bin/pm2 kill >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

XDG_CONFIG_HOME="$e2e_xdg" PM2_CAPTAIN_E2E_ENV=captain node dist/backend/app.js \
  --no-open --port 3214 --pm2-home "$e2e_home"
