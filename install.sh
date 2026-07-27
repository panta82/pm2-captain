#!/usr/bin/env bash

set -e
set -o pipefail

app_name=pm2-captain
auth_mode=proxy
captain_version=1
install_dir=
port=3212
should_accept_defaults=false
should_force=false

usage() {
  cat <<'EOF'
Install PM2 Captain as a pinned local dependency and generate its PM2 config.

Usage:
  install.sh [options]

Options:
  --dir <path>              Installation directory
  --name <name>             PM2 application name (default: pm2-captain)
  --port <number>           Captain HTTP port (default: 3212)
  --auth <proxy|captain>    Authentication owner (default: proxy)
  --yes                     Accept defaults without prompting
  --force                   Replace generated files in an existing installation
  -h, --help                Show this help
EOF
}

while (($#)); do
  case "$1" in
    --dir)
      install_dir="${2:-}"
      shift 2
      ;;
    --name)
      app_name="${2:-}"
      shift 2
      ;;
    --port)
      port="${2:-}"
      shift 2
      ;;
    --auth)
      auth_mode="${2:-}"
      shift 2
      ;;
    --yes)
      should_accept_defaults=true
      shift
      ;;
    --force)
      should_force=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

for command in node npm pm2; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "PM2 Captain setup requires '$command' on PATH." >&2
    exit 1
  fi
done

node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
if ((node_major < 22)); then
  echo "PM2 Captain requires Node.js 22 or newer; found $(node --version)." >&2
  exit 1
fi

if [[ -z "$install_dir" ]]; then
  if ((EUID == 0)); then
    install_dir=/opt/pm2-captain
  else
    install_dir="${HOME:?HOME is required}/opt/pm2-captain"
  fi
fi

if [[ "$should_accept_defaults" == false ]]; then
  if [[ ! -r /dev/tty ]]; then
    echo "Interactive setup requires a terminal. Pass --yes or provide explicit options." >&2
    exit 1
  fi
  exec 3</dev/tty

  read -r -u 3 -p "Installation directory [$install_dir]: " answer
  install_dir="${answer:-$install_dir}"
  read -r -u 3 -p "PM2 application name [$app_name]: " answer
  app_name="${answer:-$app_name}"
  read -r -u 3 -p "HTTP port [$port]: " answer
  port="${answer:-$port}"
  read -r -u 3 -p "Authentication owner, proxy or captain [$auth_mode]: " answer
  auth_mode="${answer:-$auth_mode}"
fi

case "$install_dir" in
  "~")
    install_dir="${HOME:?HOME is required}"
    ;;
  "~/"*)
    install_dir="${HOME:?HOME is required}/${install_dir#~/}"
    ;;
esac

if [[ ! "$app_name" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "PM2 application name may contain only letters, numbers, dots, underscores, and hyphens." >&2
  exit 2
fi
if [[ ! "$port" =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); then
  echo "Port must be an integer between 1 and 65535." >&2
  exit 2
fi
if [[ "$auth_mode" != proxy && "$auth_mode" != captain ]]; then
  echo "Authentication owner must be 'proxy' or 'captain'." >&2
  exit 2
fi
mkdir -p "$install_dir"
install_dir="$(cd "$install_dir" && pwd -P)"

if [[ "$should_force" == false ]] &&
  [[ -e "$install_dir/package.json" || -e "$install_dir/ecosystem.config.cjs" ]]; then
  echo "An installation already exists at $install_dir. Use --force to replace its generated files." >&2
  exit 1
fi

cat >"$install_dir/package.json" <<'EOF'
{
  "name": "pm2-captain-service",
  "private": true
}
EOF

(
  cd "$install_dir"
  npm install --save-exact "pm2-captain@$captain_version"
)

installed_version="$(
  cd "$install_dir"
  node -p "require('pm2-captain/package.json').version"
)"

no_auth_argument=
if [[ "$auth_mode" == proxy ]]; then
  no_auth_argument=", '--no-auth'"
fi

cat >"$install_dir/ecosystem.config.cjs" <<EOF
module.exports = {
  apps: [
    {
      name: '$app_name',
      cwd: __dirname,
      script: require.resolve('pm2-captain'),
      args: ['--no-open', '--port', '$port'$no_auth_argument],
      autorestart: true,
      stop_exit_codes: [78],
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
EOF

quoted_install_dir="$(printf '%q' "$install_dir")"

cat <<EOF

PM2 Captain $installed_version is installed in:

  $install_dir

Review the generated configuration:

  $install_dir/ecosystem.config.cjs

Then start and persist it:

  cd $quoted_install_dir
  pm2 start ecosystem.config.cjs --only $app_name
  pm2 save

Captain will listen on http://127.0.0.1:$port.
EOF

if [[ "$auth_mode" == proxy ]]; then
  cat <<'EOF'
Authentication is delegated to your reverse proxy. Protect it before exposing
the service.
EOF
else
  cat <<'EOF'
Captain launch-token authentication remains enabled.
EOF
fi

cat <<EOF

Upgrades are explicit. To install the latest compatible v1 release later:

  cd $quoted_install_dir
  npm install --save-exact pm2-captain@1
  pm2 restart $app_name
  pm2 save
EOF
