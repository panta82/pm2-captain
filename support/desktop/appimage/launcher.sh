#!/bin/sh
# PM2 Captain's AppImage launcher, installed in place of the Electron binary,
# which becomes pm2-captain-desktop.bin. It keeps Chromium's sandbox wherever it
# can work, and otherwise starts without it, as most Electron AppImages do.
#
# electron-builder's AppRun adds --no-sandbox when its own probe
# (`unshare -Ur true`) fails. This launcher decides again with the probe that
# matches what Chromium's sandbox needs, so a sandbox that works is not turned
# off, and one that cannot work does not stop the app from starting.
set -u

here=$(dirname "$(readlink -f "$0")")
binary="$here/pm2-captain-desktop.bin"

for argument do
  shift
  if [ "$argument" = --no-sandbox ]; then
    continue
  fi
  set -- "$@" "$argument"
done

# Chromium's namespace sandbox maps the user and creates a network namespace.
# An AppImage cannot carry the setuid helper, so this is the only sandbox it has.
if ! unshare --user --map-root-user --net true >/dev/null 2>&1; then
  printf '%s\n' "PM2 Captain: starting without the Chromium sandbox, because this system does not allow the AppImage to use user namespaces. The DEB or RPM package, or the AppArmor profile in the desktop guide, keeps the sandbox." >&2
  set -- --no-sandbox "$@"
fi

exec "$binary" "$@"
