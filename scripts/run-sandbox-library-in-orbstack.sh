#!/usr/bin/env bash
# Live fake-library run inside OrbStack/Docker: real TMDB + LLM + subtitle providers,
# 0-byte videos. Not part of npm test.
# Overlay /app/node_modules so Linux native addons never write into the Darwin tree.
#
# Usage: scripts/run-sandbox-library-in-orbstack.sh [zh-viewer|en-viewer|all] [--ids a,b]
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p sandbox-scratch
PROFILE="${1:-all}"
shift || true
docker run --rm \
  --env-file .env \
  -v "$PWD":/app -w /app \
  -v /app/node_modules \
  -v "$PWD/sandbox-scratch":/tmp/sandbox-scratch \
  -e TMPDIR=/tmp/sandbox-scratch \
  -e SUBTITLE_SCOUT_CACHE_DIR=/tmp/sandbox-scratch/cache \
  node:22-slim \
  sh -lc 'apt-get update -qq && apt-get install -y -qq python3 make g++ ffmpeg ca-certificates >/dev/null && npm ci && npx tsx src/cli/index.ts sandbox-library --profile "$0" --root /tmp/sandbox-scratch/lib --cache-dir /tmp/sandbox-scratch/cache "$@"' \
  "$PROFILE" "$@"
