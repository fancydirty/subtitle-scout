#!/usr/bin/env bash
# Deploy an exact source whitelist while leaving the router-owned compose and .env untouched.
set -euo pipefail

cd "$(dirname "$0")/.."

SSH_HOST=${DEPLOY_SSH_HOST:-media-router-tunnel}
REMOTE_DIR=/mnt/nvme0n1-4/docker/subtitle-scout
BACKUP_ROOT=/mnt/nvme0n1-4/backup
REVISION=$(git rev-parse HEAD)
ATTEMPT=${DEPLOY_ATTEMPT:-$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short=12 HEAD)}
META_DIR="$REMOTE_DIR/.deploy"
STAGE_DIR="$META_DIR/stage-$ATTEMPT"
ATTEMPT_DIR="$META_DIR/attempts/$ATTEMPT"
EVIDENCE_DIR="$BACKUP_ROOT/$ATTEMPT-deploy"
RUNNER="$ATTEMPT_DIR/rollout.sh"
LOG="$ATTEMPT_DIR/rollout.log"
DONE="$ATTEMPT_DIR/rollout.done"
POLL_TIMEOUT_SECONDS=${DEPLOY_TIMEOUT_SECONDS:-7200}
SOURCE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/subtitle-scout-deploy.XXXXXX")

cleanup_local() {
  rm -rf "$SOURCE_DIR"
}
trap cleanup_local EXIT
git archive HEAD | tar -x -C "$SOURCE_DIR"

ssh "$SSH_HOST" "set -eu; test -f '$REMOTE_DIR/.env'; test -f '$REMOTE_DIR/docker-compose.yml'; rm -rf '$STAGE_DIR'; mkdir -p '$STAGE_DIR' '$ATTEMPT_DIR'"

rsync -az --delete \
  --include='src/***' \
  --include='package.json' --include='package-lock.json' \
  --include='tsconfig.json' --include='tsconfig.build.json' \
  --include='Dockerfile' --include='.dockerignore' \
  --include='web/' --include='web/src/***' \
  --include='web/package.json' --include='web/package-lock.json' \
  --include='web/index.html' --include='web/vite.config.ts' --include='web/tsconfig.json' \
  --exclude='*' \
  "$SOURCE_DIR/" "$SSH_HOST:$STAGE_DIR/"

ssh "$SSH_HOST" "cat > '$RUNNER'" <<'REMOTE_RUNNER'
#!/bin/sh
set -eu
umask 077

remote_dir=$1
stage_dir=$2
attempt=$3
evidence_dir=$4
revision=$5
attempt_dir="$remote_dir/.deploy/attempts/$attempt"
done_file="$attempt_dir/rollout.done"
lock_dir="$remote_dir/.deploy/rollout.lock"
lock_acquired=false

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  rm -rf "$stage_dir"
  if [ "$lock_acquired" = true ]; then
    rmdir "$lock_dir" 2>/dev/null || true
  fi
  printf '%s\n' "$status" > "$done_file.tmp"
  mv "$done_file.tmp" "$done_file"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if ! mkdir "$lock_dir"; then
  printf 'deployment lock is already held: %s\n' "$lock_dir"
  exit 75
fi
lock_acquired=true

mkdir -p "$evidence_dir"
chmod 700 "$evidence_dir"
cd "$remote_dir"
sha256sum docker-compose.yml > "$evidence_dir/compose-before.sha256"

(cd "$stage_dir" && find . -type f -exec sha256sum '{}' ';' | LC_ALL=C sort) > "$evidence_dir/source-manifest.sha256"
tar -czf "$evidence_dir/source.tar.gz" -C "$stage_dir" .

previous_image=$(docker inspect -f '{{.Image}}' subtitle-scout 2>/dev/null || true)
rollback_tag="subtitle-scout-rollback:$(date +%Y%m%d-%H%M%S)"
if [ -n "$previous_image" ]; then
  docker image tag "$previous_image" "$rollback_tag"
  printf '%s %s\n' "$rollback_tag" "$previous_image" > "$evidence_dir/rollback-image.txt"
else
  printf 'none\n' > "$evidence_dir/rollback-image.txt"
fi

rsync -a --delete \
  --filter='protect /.env' \
  --filter='protect /docker-compose.yml' \
  --include='src/***' \
  --include='package.json' --include='package-lock.json' \
  --include='tsconfig.json' --include='tsconfig.build.json' \
  --include='Dockerfile' --include='.dockerignore' \
  --include='web/' --include='web/src/***' \
  --include='web/package.json' --include='web/package-lock.json' \
  --include='web/index.html' --include='web/vite.config.ts' --include='web/tsconfig.json' \
  --exclude='*' \
  "$stage_dir/" "$remote_dir/"

docker compose build --build-arg IMAGE_REVISION="$revision" subtitle-scout && \
  docker compose up -d subtitle-scout

current_image=$(docker inspect -f '{{.Image}}' subtitle-scout)
actual_revision=$(docker image inspect "$current_image" -f '{{index .Config.Labels "org.opencontainers.image.revision"}}')
if [ "$actual_revision" != "$revision" ]; then
  printf 'revision mismatch: expected %s, got %s\n' "$revision" "$actual_revision"
  exit 1
fi

{
  printf 'image_id=%s\n' "$current_image"
  printf 'revision=%s\n' "$actual_revision"
  printf 'repo_digests='
  docker image inspect "$current_image" -f '{{join .RepoDigests ","}}'
} > "$evidence_dir/current-image.txt"
sha256sum docker-compose.yml > "$evidence_dir/compose-after.sha256"
docker compose ps subtitle-scout
REMOTE_RUNNER

ssh "$SSH_HOST" "set -eu; rm -f '$LOG' '$DONE'; chmod 700 '$RUNNER'; nohup sh '$RUNNER' '$REMOTE_DIR' '$STAGE_DIR' '$ATTEMPT' '$EVIDENCE_DIR' '$REVISION' > '$LOG' 2>&1 </dev/null &"

deadline=$((SECONDS + POLL_TIMEOUT_SECONDS))
status=
while (( SECONDS < deadline )); do
  if status=$(ssh -o ConnectTimeout=10 "$SSH_HOST" "test -f '$DONE' && cat '$DONE'" 2>/dev/null); then
    break
  fi
  sleep 5
done

if [[ -z "$status" ]]; then
  printf 'deployment timed out; inspect %s:%s\n' "$SSH_HOST" "$LOG" >&2
  exit 124
fi

ssh "$SSH_HOST" "set -eu; mkdir -p '$EVIDENCE_DIR'; chmod 700 '$EVIDENCE_DIR'; cp '$LOG' '$EVIDENCE_DIR/rollout.log'; cp '$DONE' '$EVIDENCE_DIR/rollout.done'"

if [[ "$status" != 0 ]]; then
  printf 'deployment failed with status %s; inspect %s:%s\n' "$status" "$SSH_HOST" "$LOG" >&2
  exit "$status"
fi

ssh "$SSH_HOST" "test \"\$(docker image inspect \"\$(docker inspect -f '{{.Image}}' subtitle-scout)\" -f '{{index .Config.Labels \"org.opencontainers.image.revision\"}}')\" = '$REVISION'"
ssh "$SSH_HOST" "cd '$REMOTE_DIR' && docker compose ps subtitle-scout"
printf 'revision=%s\nevidence=%s\nrollback=' "$REVISION" "$EVIDENCE_DIR"
ssh "$SSH_HOST" "cut -d' ' -f1 '$EVIDENCE_DIR/rollback-image.txt'"
