#!/usr/bin/env bash

set -e
set -o pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

e2e_xdg=/tmp/pm2-captain-e2e-fake-xdg
e2e_config="$e2e_xdg/pm2-captain"
e2e_token=pm2-captain-e2e-token

rm -rf -- "$e2e_xdg"
mkdir -p "$e2e_config"
chmod 700 "$e2e_config"
printf '%s\n' "$e2e_token" > "$e2e_config/launch-token"
chmod 600 "$e2e_config/launch-token"

# Fake mode keeps its daemon list in memory and never looks for PM2, so the
# launch token is the only file it needs.
XDG_CONFIG_HOME="$e2e_xdg" exec node dist/backend/app.js --no-open --port 3215 --fake basic
