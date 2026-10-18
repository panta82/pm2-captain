#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_IMAGE="$PROJECT_ROOT/src/frontend/public/pm2-captain-logo.png"
OUTPUT_DIRECTORY="$PROJECT_ROOT/src/frontend/public"
DESKTOP_ICON_DIRECTORY="$PROJECT_ROOT/support/desktop/resources/icons"

if ! command -v magick >/dev/null 2>&1; then
  echo "ImageMagick 7 or newer is required to generate icons." >&2
  exit 1
fi

magick "$SOURCE_IMAGE" -resize 16x16 "$OUTPUT_DIRECTORY/favicon-16x16.png"
magick "$SOURCE_IMAGE" -resize 32x32 "$OUTPUT_DIRECTORY/favicon-32x32.png"
magick "$SOURCE_IMAGE" -resize 180x180 "$OUTPUT_DIRECTORY/apple-touch-icon.png"
magick "$SOURCE_IMAGE" -resize 192x192 "$OUTPUT_DIRECTORY/android-chrome-192x192.png"
magick "$SOURCE_IMAGE" -resize 512x512 "$OUTPUT_DIRECTORY/android-chrome-512x512.png"
magick "$SOURCE_IMAGE" \
  -define icon:auto-resize=48,32,16 \
  "$OUTPUT_DIRECTORY/favicon.ico"

mkdir -p "$DESKTOP_ICON_DIRECTORY"
for size in 16 24 32 48 64 96 128 256 512; do
  magick "$SOURCE_IMAGE" -resize "${size}x${size}" "$DESKTOP_ICON_DIRECTORY/${size}x${size}.png"
done

echo "Generated favicon and application icons from pm2-captain-logo.png."
