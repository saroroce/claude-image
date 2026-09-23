#!/usr/bin/env bash
set -euo pipefail

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
SRC="$(cd "$(dirname "$0")" && pwd)"
OUT="$SRC/.."
ONLY=("$@")

want() {
  [ ${#ONLY[@]} -eq 0 ] && return 0
  for n in "${ONLY[@]}"; do [ "$n" = "$1" ] && return 0; done
  return 1
}

shot() {
  local name="$1" width="$2" height="$3" format="$4"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --window-size="${width},${height}" --virtual-time-budget=4000 \
    --screenshot="$OUT/$name.png" "file://$SRC/$name.html" >/dev/null 2>&1
  if [ "$format" = "jpg" ]; then
    sips -s format jpeg -s formatOptions 88 "$OUT/$name.png" --out "$OUT/$name.jpg" >/dev/null
    rm "$OUT/$name.png"
    echo "rendered $name.jpg"
  else
    echo "rendered $name.png"
  fi
}

want hero && shot hero 1600 800 jpg
want session && shot session 1500 1530 jpg
want scroll && shot scroll 1600 690 jpg
want cost-guard && shot cost-guard 1500 860 png
want setup && shot setup 1500 800 png
want tiers && shot tiers 1600 745 png
