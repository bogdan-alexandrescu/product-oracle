#!/bin/sh
# Build HTML from the data file, then render PNGs.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
node "$HERE/build.js" "${1:-docs/product-oracle-v2/design/proposals/quillfield.json}"
FONTCONFIG_FILE=${FONTCONFIG_FILE:-/tmp/fonts.conf} LD_LIBRARY_PATH=/tmp/sysroot/usr/lib/x86_64-linux-gnu:/tmp/sysroot/lib/x86_64-linux-gnu NODE_PATH=/tmp/pw/node_modules node "$HERE/render.js"
