#!/bin/sh
# Renders the listing images (icon.png, cover.png) from the SVGs in this folder with a headless
# Chrome or Chromium. Usage: sh images/render.sh [icon] [cover]. CHROME overrides the browser.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
chrome=${CHROME:-}
if [ -z "$chrome" ]; then
  for candidate in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" chromium chromium-browser google-chrome; do
    if command -v "$candidate" >/dev/null 2>&1 || [ -x "$candidate" ]; then chrome=$candidate; break; fi
  done
fi
[ -n "$chrome" ] || { echo "render.sh: no Chrome or Chromium found; set CHROME" >&2; exit 1; }

render() {
  name=$1 width=$2 height=$3
  page=$(mktemp -d)/page.html
  {
    printf '<!doctype html><meta charset="utf-8"><style>'
    for weight in 600 700; do
      printf "@font-face{font-family:'Barlow Condensed';font-weight:%s;src:url('file://%s/fonts/barlow-condensed-%s.woff2') format('woff2')}" "$weight" "$here" "$weight"
    done
    printf 'html,body{margin:0}svg{display:block;width:%spx;height:%spx}</style>' "$width" "$height"
    cat "$here/$name.svg"
  } >"$page"
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --virtual-time-budget=2000 --window-size="$width,$height" \
    --screenshot="$here/$name.png" "file://$page" >/dev/null 2>&1
  echo "rendered $name.png"
}

[ $# -gt 0 ] || set -- icon cover
for job in "$@"; do
  case $job in
    icon) render icon 512 512 ;;
    cover) render cover 1600 1000 ;;
    *) echo "render.sh: unknown image $job" >&2; exit 64 ;;
  esac
done
