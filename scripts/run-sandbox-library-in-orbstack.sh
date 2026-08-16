#!/usr/bin/env bash
# Live fake-library run inside OrbStack/Docker: real TMDB + LLM + subtitle providers,
# 0-byte videos. Not part of npm test.
#
# Usage: scripts/run-sandbox-library-in-orbstack.sh [zh-viewer|en-viewer|all]
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p sandbox-scratch
PROFILE="${1:-all}"
docker run --rm \
  --env-file .env \
  -v "$PWD":/app -w /app \
  -v "$PWD/sandbox-scratch":/tmp/sandbox-scratch \
  -e TMPDIR=/tmp/sandbox-scratch \
  -e SUBTITLE_SCOUT_CACHE_DIR=/tmp/sandbox-scratch/cache \
  node:22-slim \
  sh -lc 'apt-get update -qq && apt-get install -y -qq python3 make g++ ffmpeg ca-certificates >/dev/null && npm rebuild better-sqlite3 && npx tsx src/cli/index.ts sandbox-library --profile "$0" --root /tmp/sandbox-scratch/lib --cache-dir /tmp/sandbox-scratch/cache' \
  "$PROFILE"
