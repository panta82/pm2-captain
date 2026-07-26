#!/usr/bin/env bash

set -e
set -o pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

e2e_home=/tmp/pm2-captain-e2e
e2e_token=pm2-captain-e2e-token

mkdir -p "$e2e_home"
chmod 700 "$e2e_home"
printf '%s\n' "$e2e_token" > "$e2e_home/pm2-captain-token"
chmod 600 "$e2e_home/pm2-captain-token"

PM2_HOME="$e2e_home" ./node_modules/.bin/pm2 delete all >/dev/null 2>&1 || true
PM2_HOME="$e2e_home" ./node_modules/.bin/pm2 flush >/dev/null 2>&1 || true
PM2_CAPTAIN_E2E_ENV=visible PM2_HOME="$e2e_home" ./node_modules/.bin/pm2 start test/fixtures/process.cjs \
  --name captain-fixture >/dev/null

cleanup() {
  PM2_HOME="$e2e_home" ./node_modules/.bin/pm2 kill >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

node dist/backend/app.js --no-open --port 3214 --pm2-home "$e2e_home"
