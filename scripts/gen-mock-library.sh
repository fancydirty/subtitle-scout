#!/usr/bin/env bash
# 生成 mock 媒体库：1 秒黑屏微型真视频（ffprobe 可探测，Jellyfin 正常刮削）。
# 用法: scripts/gen-mock-library.sh [outdir]   # 默认 fixtures/media
set -euo pipefail
OUT="${1:-fixtures/media}"

clip() {
  mkdir -p "$OUT/$(dirname "$1")"
  ffmpeg -f lavfi -i color=black:s=320x240:d=1 -c:v libx264 -pix_fmt yuv420p -y -loglevel error "$OUT/$1"
}
clip_with_chi() {  # 内嵌 chi 字幕轨 → 测"已带中字跳过"负路径
  mkdir -p "$OUT/$(dirname "$1")"
  local SRT; SRT=$(mktemp /tmp/mock-XXXXXX.srt)
  printf '1\n00:00:00,000 --> 00:00:01,000\n占位中文字幕\n' > "$SRT"
  ffmpeg -f lavfi -i color=black:s=320x240:d=1 -i "$SRT" \
    -map 0:v -map 1:s -c:v libx264 -pix_fmt yuv420p -c:s srt \
    -metadata:s:s:0 language=chi -y -loglevel error "$OUT/$1"
  rm -f "$SRT"
}

# —— 西剧（OpenSubtitles 主场；Peacemaker 是 ASSRT 已证零结果剧）——
for e in 1 2 3; do clip "TV/Peacemaker (2022)/Season 01/Peacemaker (2022) S01E0${e} 1080p.mkv"; done
for e in 1 2; do clip "TV/Young Sheldon (2017)/Season 01/Young Sheldon (2017) S01E0${e} 1080p.mkv"; done
# —— 华语路径（ASSRT 主场）——
for e in 1 2; do clip "TV/Love, Death & Robots (2019)/Season 03/Love, Death & Robots (2019) S03E0${e} 1080p.mkv"; done
# —— 负路径：自带内嵌中字，应判 embedded ——
clip_with_chi "Movies/The Wandering Earth (2019)/The Wandering Earth (2019) 1080p.mkv"
# —— 负路径：国产片（SKIP_CHINESE_ORIGIN）——
clip "Movies/Hero (2002)/Hero (2002) 1080p.mkv"

echo "mock library written to $OUT:"
find "$OUT" -name '*.mkv' | sort
