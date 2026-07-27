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

tar -tzf "$package_path" | grep -Fx 'package/install.sh' >/dev/null

npm_config_cache="$package_test_dir/npm-cache" \
  npm install --ignore-scripts --no-audit --no-fund --prefix "$package_test_dir/install" "$package_path"

"$package_test_dir/install/node_modules/.bin/pm2-captain" --help >/dev/null

echo "Packed artifact installed and executable smoke test passed."
