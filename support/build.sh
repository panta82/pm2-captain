#!/usr/bin/env bash

set -e
set -o pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
rm -rf dist
mkdir -p dist/frontend dist/backend

npm run build:frontend &
frontend_pid=$!
npm run build:backend &
backend_pid=$!

wait "$frontend_pid"
wait "$backend_pid"

chmod +x dist/backend/app.js
