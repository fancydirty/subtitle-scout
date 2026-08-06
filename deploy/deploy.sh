#!/usr/bin/env bash
# Git-pull deploy for subtitle-scout on the soft router.
#
# Flow — mirrors the open-source user's `docker compose pull` upgrade path, so dev/test
# exercises the exact mechanism a real user would use:
#   1. push main  → GitHub Actions release.yml builds & pushes ghcr :latest
#   2. wait for that CI run (for THIS commit) to finish successfully
#   3. router: git fetch + reset --hard origin/main   (tracked files only)
#   4. router: docker compose pull + up -d            (adopt the new :latest image)
#   5. verify the running image's OCI revision label == the commit we pushed
#
# Router-owned .env and every untracked file under the deploy dir are preserved:
# reset --hard only rewrites TRACKED files, and we NEVER run `git clean`.
set -euo pipefail

cd "$(dirname "$0")/.."

SSH_HOST=${DEPLOY_SSH_HOST:-media-router-tunnel}   # at work / off-LAN: DEPLOY_SSH_HOST=media-router-wan
REMOTE_DIR=/mnt/nvme0n1-4/docker/subtitle-scout
BACKUP_ROOT=/mnt/nvme0n1-4/backup
BRANCH=${DEPLOY_BRANCH:-main}
REVISION=$(git rev-parse HEAD)
ATTEMPT=${DEPLOY_ATTEMPT:-$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short=12 HEAD)}
ATTEMPT_DIR="$REMOTE_DIR/.deploy/attempts/$ATTEMPT"
EVIDENCE_DIR="$BACKUP_ROOT/$ATTEMPT-deploy"
RUNNER="$ATTEMPT_DIR/rollout.sh"
LOG="$ATTEMPT_DIR/rollout.log"
DONE="$ATTEMPT_DIR/rollout.done"
POLL_TIMEOUT_SECONDS=${DEPLOY_TIMEOUT_SECONDS:-3600}
CI_TIMEOUT_SECONDS=${DEPLOY_CI_TIMEOUT_SECONDS:-2400}
SKIP_PUSH=${DEPLOY_SKIP_PUSH:-false}
SKIP_CI_WAIT=${DEPLOY_SKIP_CI_WAIT:-false}

# ---- 1. preflight + push ------------------------------------------------------
current_branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$current_branch" != "$BRANCH" ]]; then
  printf 'refusing to deploy: on branch %s, expected %s\n' "$current_branch" "$BRANCH" >&2
  exit 2
fi

if [[ "$SKIP_PUSH" != true ]]; then
  git push origin "$BRANCH"
fi

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# ---- 2. wait for release CI to build :latest FOR THIS COMMIT ------------------
# The router adopts ghcr :latest. If we pulled before CI rebuilt it, we'd get the
# PREVIOUS commit's image and the revision check in step 5 would (correctly) fail.
# So we block here until the push-triggered run for THIS sha completes.
if [[ "$SKIP_CI_WAIT" != true ]]; then
  printf 'waiting for release CI (%s) to publish :latest for %s ...\n' "$REPO" "${REVISION:0:12}"
  ci_deadline=$((SECONDS + CI_TIMEOUT_SECONDS))
  run_status=
  while (( SECONDS < ci_deadline )); do
    line=$(gh api -X GET "repos/$REPO/actions/workflows/release.yml/runs" \
      -f head_sha="$REVISION" -f event=push \
      --jq '.workflow_runs[0] // empty | "\(.id) \(.status) \(.conclusion // "")"' 2>/dev/null || true)
    read -r run_id run_status run_conclusion <<<"$line"
    if [[ "$run_status" == completed ]]; then
      if [[ "$run_conclusion" == success ]]; then
        printf 'release CI succeeded (run %s)\n' "$run_id"
        break
      fi
      printf 'release CI did not succeed: run %s conclusion=%s\n' "$run_id" "$run_conclusion" >&2
      exit 1
    fi
    sleep 15
  done
  if [[ "$run_status" != completed ]]; then
    printf 'timed out waiting for release CI on %s (%ss)\n' "${REVISION:0:12}" "$CI_TIMEOUT_SECONDS" >&2
    exit 124
  fi
fi

# ---- 3. ship the router-side rollout runner ----------------------------------
# Preconditions on the router: it's a git repo (prior `git init` + remote set),
# has a router-owned .env, and docker-compose.yml is tracked in the repo.
ssh "$SSH_HOST" "set -eu; test -f '$REMOTE_DIR/.env'; test -d '$REMOTE_DIR/.git'; mkdir -p '$ATTEMPT_DIR'"

ssh "$SSH_HOST" "cat > '$RUNNER'" <<'REMOTE_RUNNER'
#!/bin/sh
set -eu
umask 077

remote_dir=$1
attempt=$2
evidence_dir=$3
revision=$4
branch=$5
attempt_dir="$remote_dir/.deploy/attempts/$attempt"
done_file="$attempt_dir/rollout.done"
lock_dir="$remote_dir/.deploy/rollout.lock"
lock_acquired=false

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
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

# --- evidence: compose + git state BEFORE we touch anything ---
sha256sum docker-compose.yml > "$evidence_dir/compose-before.sha256"
git rev-parse HEAD > "$evidence_dir/git-before.txt" 2>/dev/null || printf 'none\n' > "$evidence_dir/git-before.txt"

# --- rollback: tag the currently-running image so we can pin back to it ---
previous_image=$(docker inspect -f '{{.Image}}' subtitle-scout 2>/dev/null || true)
rollback_tag="subtitle-scout-rollback:$(date +%Y%m%d-%H%M%S)"
if [ -n "$previous_image" ]; then
  docker image tag "$previous_image" "$rollback_tag"
  printf '%s %s\n' "$rollback_tag" "$previous_image" > "$evidence_dir/rollback-image.txt"
else
  printf 'none\n' > "$evidence_dir/rollback-image.txt"
fi
# --- adopt the pushed commit: fetch + reset TRACKED files only ---
# reset --hard rewrites only tracked files (docker-compose.yml et al). It never
# deletes untracked files, so the router-owned .env, backups, .deploy/, companion
# session dirs and scratch scripts are all preserved. We deliberately DO NOT run
# `git clean` — untracked files on the router are the router's property.
git fetch --prune origin "$branch"
git reset --hard "origin/$branch"
git rev-parse HEAD > "$evidence_dir/git-after.txt"

# --- adopt the new image: pull ghcr :latest, recreate the container ---
docker compose pull subtitle-scout || exit $?
docker compose up -d subtitle-scout || exit $?

# --- verify the running image was built from the commit we pushed ---
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

# ---- 4. launch the runner detached + poll the done-file ----------------------
# nohup + done-file so a dropped tunnel (cloudflared / dropbear) can't orphan the
# rollout: the router keeps running it; we just re-poll the sentinel on reconnect.
ssh "$SSH_HOST" "set -eu; rm -f '$LOG' '$DONE'; chmod 700 '$RUNNER'; nohup sh '$RUNNER' '$REMOTE_DIR' '$ATTEMPT' '$EVIDENCE_DIR' '$REVISION' '$BRANCH' > '$LOG' 2>&1 </dev/null &"

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

# ---- 5. independent final verification (belt-and-suspenders) ------------------
ssh "$SSH_HOST" "test \"\$(docker image inspect \"\$(docker inspect -f '{{.Image}}' subtitle-scout)\" -f '{{index .Config.Labels \"org.opencontainers.image.revision\"}}')\" = '$REVISION'"
ssh "$SSH_HOST" "cd '$REMOTE_DIR' && docker compose ps subtitle-scout"
printf 'revision=%s\nevidence=%s\nrollback=' "$REVISION" "$EVIDENCE_DIR"
ssh "$SSH_HOST" "cut -d' ' -f1 '$EVIDENCE_DIR/rollback-image.txt'"
