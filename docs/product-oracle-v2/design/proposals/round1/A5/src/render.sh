#!/bin/sh
# Build HTML from quillfield.json, then render the six PNGs.
set -e
cd "$(dirname "$0")/.."
node src/build.js "${1:-../../work/repo/docs/product-oracle-v2/design/proposals/quillfield.json}" .
LD_LIBRARY_PATH=/tmp/debs/root/usr/lib/x86_64-linux-gnu:/tmp/debs/root/lib/x86_64-linux-gnu FONTCONFIG_FILE=/tmp/debs/fonts.conf node src/render.js . .
