#!/bin/sh
# build.sh — the phone's app: the window of src/ui as it is, plus remote.js loaded before any other
# script (it routes /api through the relay, sealed end to end). Published at app.atril.synsema.io, an
# origin of its own: the keys a phone keeps there are not shared with any other page.
#   src/app/build.sh [out]      (default: out/app)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-"$here/../../out/app"}
rm -rf "$out"
mkdir -p "$out"
cp -R "$here/../ui/." "$out/"
cp "$here/remote.js" "$out/remote.js"
# remote.js goes right before the first script of the page
awk 'BEGIN { done = 0 } /<script src=/ && !done { print "<script src=\"remote.js\"></script>"; done = 1 } { print }' \
    "$here/../ui/index.html" > "$out/index.html"
grep -q '<script src="remote.js"></script>' "$out/index.html" || { echo "build.sh: no <script> in index.html" >&2; exit 1; }
echo "app.atril.synsema.io" > "$out/CNAME"
touch "$out/.nojekyll"
echo "app: $out"
