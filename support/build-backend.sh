#!/usr/bin/env bash

set -e
set -o pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

mapfile -t backend_sources < <(
  rg --files src/backend src/shared -g '*.ts' -g '!*.spec.ts' -g '!*.d.ts'
)

./node_modules/.bin/esbuild \
  "${backend_sources[@]}" \
  --outdir=dist \
  --outbase=src \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --packages=external \
  --sourcemap
