#!/usr/bin/env bash
# 生成乱排布 mock 媒体库：验收间谍过家家绝对编号平铺场景 + 4 种对照形态。
# 用法: scripts/gen-messy-library.sh [outdir]   # 默认 fixtures/media-messy
set -euo pipefail
command -v ffmpeg >/dev/null || { echo "ffmpeg not found — brew install ffmpeg / apt-get install ffmpeg" >&2; exit 1; }
OUT="${1:-fixtures/media-messy}"

clip() {
  mkdir -p "$OUT/$(dirname "$1")"
  ffmpeg -f lavfi -i color=black:s=320x240:d=1 -c:v libx264 -pix_fmt yuv420p -y -loglevel error "$OUT/$1"
}

# —— 形态 1：绝对编号平铺（验收主场景）——
# 间谍过家家(2022)：TMDB 真实季表 S1=25 集/S2=12 集/S3=3 集，共 40 集；这里全部塞进单个
# "Season 01" 目录、文件名用裸 E{abs} 记法，模拟被 Jellyfin 误刮成 S1E1..S1E40 的乱库。
for i in $(seq 1 40); do
  clip "TV/Spy x Family (2022)/Season 01/Spy x Family (2022) E${i}.mkv"
done

# —— 形态 2：错位（正确集数，但按特别篇偏移一位）——
# 用同一部剧，但文件按 SxxEyy 记法给出、集号整体错位 1（模拟特别篇混入导致的季内错位）；
# 这批文件已含 SxxEyy，parseAbsoluteEpisodeNumber 会判 null（不当绝对编号平铺处理，
# 交给"正常库"逻辑走——错位问题不在本次 realign 的范围内，YAGNI，仅用作对照不应误伤）。
for i in $(seq 1 25); do
  clip "TV/Offset Show (2021)/Season 01/Offset Show (2021) S01E$(printf '%02d' $((i + 1))).mkv"
done

# —— 形态 3：合集文件（E01-02 合并成一个文件）——
# E01-02 合集文件本身解不出单一集号（隔离区）；配够单集文件（E03..E11）让可解析覆盖率
# ≥80%（libraryRealign.ts 的 MIN_PARSEABLE_COVERAGE 闸门），这样这批 fixture 若被直接喂给
# buildRealignPlan 也会得到真实、有意义的结果（合集文件隔离，其余 9 集正常整理），
# 而不是被覆盖率闸门整剧拒绝——与 libraryRealign.messyMatrix.test.ts 的验收断言口径一致。
clip "TV/Combined Show (2020)/Season 01/Combined Show (2020) E01-02.mkv"
for i in $(seq 3 11); do
  clip "TV/Combined Show (2020)/Season 01/Combined Show (2020) E${i}.mkv"
done

# —— 形态 4：特别篇混入（S0 文件与正片同目录）——
clip "TV/Specials Mixed Show (2019)/Season 01/Specials Mixed Show (2019) S01E01.mkv"
clip "TV/Specials Mixed Show (2019)/Season 01/Specials Mixed Show (2019) S00E01.mkv" # 特别篇，应被隔离

# —— 形态 5：正常库（控制组，绝不应触发诊断/整理）——
for i in 1 2 3; do
  clip "TV/Normal Show (2018)/Season 01/Normal Show (2018) S01E0${i}.mkv"
done

echo "messy mock library written to $OUT:"
find "$OUT" -name '*.mkv' | sort
