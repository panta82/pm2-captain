#!/bin/sh
# Prints an AppArmor profile that lets one PM2 Captain AppImage, at the given
# absolute path, use the user namespaces its sandbox needs. Processes it
# starts, including Electron, inherit the profile (see apparmor.d(5): unconfined
# and default_allow tasks use a pix exec transition). Install it with:
#
#   sh apparmor-profile.sh "$HOME/Applications/PM2-Captain-x86_64.AppImage" \
#     | sudo tee /etc/apparmor.d/pm2-captain-desktop-appimage
#   sudo apparmor_parser -r /etc/apparmor.d/pm2-captain-desktop-appimage
#
# Moving or renaming the AppImage needs a new profile. Updates keep the path.
set -eu

path=${1:-}
case "$path" in
  /*) ;;
  *)
    echo "Usage: $0 /absolute/path/to/PM2-Captain-x86_64.AppImage" >&2
    exit 2
    ;;
esac
# The path is written into the profile; keep it to characters that need no quoting rules.
if printf '%s' "$path" | grep -q '[^A-Za-z0-9._/+-]'; then
  echo "Move the AppImage to a path of letters, digits and . _ - + / only." >&2
  exit 2
fi
if [ ! -f "$path" ]; then
  echo "$path is not a file." >&2
  exit 2
fi

cat <<PROFILE
abi <abi/4.0>,
include <tunables/global>

profile pm2-captain-desktop-appimage $path flags=(default_allow) {
  userns,

  include if exists <local/pm2-captain-desktop-appimage>
}
PROFILE
