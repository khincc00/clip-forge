#!/usr/bin/env bash
# Stages the web app into desktop/app so electron-builder can package it.
set -euo pipefail
cd "$(dirname "$0")"
(cd .. && npm install && npm run build)
rm -rf app/server app/dist
cp -R ../server app/server
cp -R ../dist app/dist
echo '{ "type": "module" }' > app/server/package.json
mkdir -p resources
if [ ! -x resources/yt-dlp ]; then
  curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos -o resources/yt-dlp
  chmod +x resources/yt-dlp
fi
