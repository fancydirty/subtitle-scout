#!/usr/bin/env bash
# 本地 Jellyfin 开发环境（OrbStack/Docker）。幂等：已存在则跳过。
# 首次运行后需在 http://localhost:8096 完成 Jellyfin 初始化向导并建媒体库。
set -euo pipefail
MEDIA=/tmp/scout-media
MOVIE_DIR="$MEDIA/movies/The Matrix (1999)"
MOVIE="$MOVIE_DIR/The.Matrix.1999.1080p.BluRay.x264.mkv"
if [ ! -f "$MOVIE" ]; then
  mkdir -p "$MOVIE_DIR"
  ffmpeg -y -f lavfi -i color=black:s=640x360:d=30 -f lavfi -i anullsrc \
    -c:v libx264 -t 30 -pix_fmt yuv420p -c:a aac -shortest "$MOVIE"
fi
if ! docker ps -a --format '{{.Names}}' | grep -q '^scout-jellyfin$'; then
  docker run -d --name scout-jellyfin -p 8096:8096 \
    -v /tmp/scout-jellyfin-config:/config \
    -v "$MEDIA":/media \
    ghcr.io/jellyfin/jellyfin:latest
else
  docker start scout-jellyfin >/dev/null
fi
echo "jellyfin: http://localhost:8096"
