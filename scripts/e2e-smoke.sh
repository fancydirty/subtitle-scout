#!/usr/bin/env bash
# 手动端到端冒烟：真调 LLM + ASSRT + 真下载。消耗 ASSRT 配额，不进 CI。
# 前置：.env 已配好 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL/ASSRT_TOKEN
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=$(mktemp -d)
echo "output dir: $OUT"
# 用独立缓存目录，保证真实走 API 而不是吃旧缓存
SUBTITLE_SCOUT_CACHE_DIR=$(mktemp -d) npx tsx src/cli/index.ts run \
  --context fixtures/contexts/matrix.json --out "$OUT"
echo "--- decision.json ---"
python3 -m json.tool "$OUT/decision.json" | head -40
echo "--- files ---"
ls -la "$OUT"
file "$OUT"/*.ass "$OUT"/*.srt 2>/dev/null || true
