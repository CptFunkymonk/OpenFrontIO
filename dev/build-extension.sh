#!/usr/bin/env bash
# Copies the Overlord userscript into the unpacked Chrome extension so it can be
# loaded at document_start (a Tampermonkey-equivalent for local dev/testing).
#
# Usage:
#   dev/build-extension.sh
#   google-chrome --load-extension="$PWD/dev/overlord-extension" http://localhost:9000/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cp "$ROOT/tampermonkey-overlord-bot.js" "$ROOT/dev/overlord-extension/overlord.js"
echo "Copied userscript -> dev/overlord-extension/overlord.js"
echo "Load it with:"
echo "  google-chrome --load-extension=\"$ROOT/dev/overlord-extension\" http://localhost:9000/"
