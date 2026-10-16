#!/usr/bin/env bash

set -e
set -o pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

package_test_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$package_test_dir"
}
trap cleanup EXIT

npm_config_cache="$package_test_dir/npm-cache" \
  npm pack --pack-destination "$package_test_dir" > "$package_test_dir/pack.log"

package_path="$(find "$package_test_dir" -maxdepth 1 -type f -name '*.tgz' -print -quit)"
if [[ -z "$package_path" ]]; then
  echo "npm pack did not produce a tarball." >&2
  exit 1
fi

tar -tzf "$package_path" > "$package_test_dir/files.txt"
for required in package/install.sh package/dist/backend/app.js package/dist/frontend/index.html package/README.md package/LICENSE; do
  grep -Fx "$required" "$package_test_dir/files.txt" >/dev/null || {
    echo "The package is missing $required." >&2
    exit 1
  }
done
# Desktop sources, staging, installers and development files stay out.
if grep -E '^package/(src|tests|build|support|scratch|dist/desktop)/|^package/electron-builder\.yml$' "$package_test_dir/files.txt"; then
  echo "The package contains files that belong to development or the desktop app." >&2
  exit 1
fi

npm_config_cache="$package_test_dir/npm-cache" \
  npm install --ignore-scripts --no-audit --no-fund --prefix "$package_test_dir/install" "$package_path"

installed="$package_test_dir/install/node_modules"
# npm users never get Electron or the desktop updater.
for desktop_only in electron electron-updater electron-builder; do
  if [[ -e "$installed/$desktop_only" ]]; then
    echo "Installing the package pulled in $desktop_only." >&2
    exit 1
  fi
done
if grep -rlE "require\(\"electron(-updater)?\"\)" "$installed/pm2-captain/dist" >/dev/null; then
  echo "The npm runtime requires Electron." >&2
  exit 1
fi

"$installed/.bin/pm2-captain" --help >/dev/null
node support/test-package-smoke.mjs "$installed/.bin/pm2-captain" "$package_test_dir"

echo "Packed artifact installed and executable smoke test passed."
