#!/usr/bin/env bash
# Run the live matrix inside an OrbStack/Docker container: clean filesystem + reproducible node,
# repo + fixtures mounted read-write, .env for the LLM key. Replay mode needs ONLY LLM network.
#
# Usage: scripts/run-live-matrix-in-orbstack.sh --type anime --form only-pack
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p matrix-scratch
docker run --rm \
  --env-file .env \
  -v "$PWD":/app -w /app \
  -v "$PWD/matrix-scratch":/tmp/matrix-scratch \
  -e TMPDIR=/tmp/matrix-scratch \
  node:22-slim \
  sh -lc 'npx --yes tsx scripts/run-live-matrix.ts "$@"' _ "$@"
