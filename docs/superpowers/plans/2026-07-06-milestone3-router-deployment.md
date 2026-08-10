# Milestone 3 Implementation Plan: 软路由真实部署

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 1 → sonnet 子代理；Task 2-5 → controller 持凭据实操（ssh `media-router-tunnel`）。

**Goal:** subtitle-scout + Jellyfin 以 Docker compose 跑在用户软路由上，挂 NAS 真实电影库，真实媒体验收通过。

**Architecture:** 路由上构建（Mac arm64 ≠ 路由 x86_64）；恒等路径映射（两容器同挂 `/media/movies`）+ `MEDIA_ROOTS=/media` 白名单；凭据全走部署目录 `.env`。

**Tech Stack:** node:22-slim、docker compose v2、rsync over ssh (CF Tunnel)。

**Spec:** `docs/superpowers/specs/2026-07-06-milestone3-router-deployment-design.md`

---

## File Structure

```
Dockerfile                 # 仓库根：node:22-slim + prod deps + tsx watch
.dockerignore
docker-compose.yml         # 仓库根：jellyfin + subtitle-scout 双服务模板
deploy/
├── deploy.sh              # Mac 侧：rsync → 路由构建 → up
└── router.env.example     # 路由 .env 模板（含 MEDIA_HOST_PATH）
package.json               # tsx 从 devDependencies 移到 dependencies
```

---

### Task 1（sonnet 子代理）: Dockerfile + compose + 部署脚本

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `deploy/deploy.sh`, `deploy/router.env.example`
- Modify: `package.json`（tsx 移入 dependencies）

- [ ] **Step 1: package.json 调整**

`tsx` 是运行时执行器（`CMD npx tsx ...`），必须在 `dependencies` 而非 `devDependencies`。
把 `"tsx": "^4.23.0"` 从 devDependencies 移到 dependencies（保持版本号），随后
`npm install` 刷新 lock，`npm run check && npm test` 确认 123 测试全绿。

- [ ] **Step 2: Dockerfile**

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production
CMD ["npx", "tsx", "src/cli/index.ts", "watch"]
```

`.dockerignore`：

```
node_modules
.git
.env
scratch
fixtures
docs
worker
scripts
output
*.log
```

- [ ] **Step 3: docker-compose.yml（仓库根，模板；路由 .env 提供变量）**

```yaml
services:
  jellyfin:
    image: ghcr.io/jellyfin/jellyfin:latest
    container_name: scout-jellyfin
    restart: unless-stopped
    ports:
      - "8096:8096"
    volumes:
      - ./jellyfin-config:/config
      - ${MEDIA_HOST_PATH}/Movies:/media/movies

  subtitle-scout:
    build: .
    container_name: subtitle-scout
    restart: unless-stopped
    depends_on:
      - jellyfin
    environment:
      JELLYFIN_URL: http://jellyfin:8096
      JELLYFIN_API_KEY: ${JELLYFIN_API_KEY}
      LLM_BASE_URL: ${LLM_BASE_URL}
      LLM_API_KEY: ${LLM_API_KEY}
      LLM_MODEL: ${LLM_MODEL}
      LLM_EXTRA_BODY: ${LLM_EXTRA_BODY:-}
      ASSRT_TOKEN: ${ASSRT_TOKEN}
      MEDIA_ROOTS: /media
      SUBTITLE_SCOUT_CACHE_DIR: /cache
      POLL_INTERVAL_SECONDS: ${POLL_INTERVAL_SECONDS:-15}
      TZ: Asia/Shanghai
    volumes:
      - ${MEDIA_HOST_PATH}/Movies:/media/movies
      - ./cache:/cache
```

- [ ] **Step 4: deploy/router.env.example**

```
# 路由部署目录 .env 模板。真实值不入 git。
MEDIA_HOST_PATH=/mnt/nvme0n1-4/nas_media
JELLYFIN_API_KEY=
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
LLM_EXTRA_BODY=
ASSRT_TOKEN=
POLL_INTERVAL_SECONDS=15
```

- [ ] **Step 5: deploy/deploy.sh（Mac 侧执行）**

```bash
#!/usr/bin/env bash
# 部署到软路由：rsync 构建上下文 → 路由上 compose build + up。
# 前置：ssh 别名 media-router-tunnel 可用；路由部署目录 .env 已就位。
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=media-router-tunnel:/mnt/nvme0n1-4/docker/subtitle-scout
rsync -az --delete \
  --include='src/***' --include='package.json' --include='package-lock.json' \
  --include='Dockerfile' --include='.dockerignore' --include='docker-compose.yml' \
  --exclude='*' \
  ./ "$DEST/"
ssh media-router-tunnel 'cd /mnt/nvme0n1-4/docker/subtitle-scout && test -f .env || { echo "missing .env — copy deploy/router.env.example and fill it"; exit 1; }'
ssh media-router-tunnel 'cd /mnt/nvme0n1-4/docker/subtitle-scout && docker compose build subtitle-scout && docker compose up -d'
ssh media-router-tunnel 'cd /mnt/nvme0n1-4/docker/subtitle-scout && docker compose ps'
```

`chmod +x deploy/deploy.sh`。

- [ ] **Step 6: 本地验证 + 提交**

`npm run check && npm test`（123 绿）；本地 `docker build -t scout-test . && docker run --rm scout-test npx tsx src/cli/index.ts 2>&1; true` 应打印 usage（缺 env 也行，证明镜像自洽——注意本地是 arm64 构建，仅验证 Dockerfile 正确性）。若本地 Docker 拉 node:22-slim 失败（docker.io 网络问题），跳过本地构建、在报告注明（路由上会真实构建）。

```bash
git add Dockerfile .dockerignore docker-compose.yml deploy/ package.json package-lock.json
git commit -m "feat: dockerfile, compose and router deploy script"
```

---

### Task 2（Controller）: 路由部署

- [ ] 确认 8096 空闲：`ssh media-router-tunnel 'netstat -tlnp 2>/dev/null | grep 8096 || echo free'`
- [ ] 建部署目录 + 写 `.env`（从本地 .env 取 LLM/ASSRT 值 + MEDIA_HOST_PATH；凭据不经过子代理）
- [ ] `./deploy/deploy.sh` → 镜像构建成功、双容器 up
- [ ] `docker logs subtitle-scout` 应显示 "missing required env var: JELLYFIN_API_KEY" 之外的正常等待（首次无 key 时预期报错退出 → 待 Task 3 注入 key 后重启）

### Task 3（Controller）: Jellyfin 初始化

- [ ] Startup API 完成向导（沿用 M2 脚本模式：Configuration/User/Complete）
- [ ] 建 Movies 库指向 `/media/movies`，触发扫描，轮询等待 227GB 元数据完成（Items 数 > 0 且稳定）
- [ ] 生成 API key → 写入路由 `.env` → `docker compose up -d subtitle-scout` 重启注入
- [ ] `docker logs subtitle-scout` 显示 "watching http://jellyfin:8096"

### Task 4（Controller）: 真实媒体验收

- [ ] 找到 Pulp Fiction 的 itemId；确认其 MediaStreams 无中文字幕
- [ ] Sessions API 模拟播放（AuthenticateByName + /Sessions/Playing）
- [ ] 跟踪 `docker logs -f subtitle-scout`：processing → download → subtitle visible
- [ ] 确认 NAS 上 `Pulp Fiction (1994)/` 出现 `*.zh-Hans.*`（经 CIFS 写入成功）且 Jellyfin 流列表含中文外挂
- [ ] 彩蛋：对 TRON - Ares 重复（其错配 .ass 不被 Jellyfin 识别 → 应判"缺字幕"并补规范命名的）
- [ ] journal 检查：`cache/journals/` 完整审计；探针档案确认 LLM mode
- [ ] 负面探针：再次模拟播放同一部 → 冷却/已有字幕跳过，日志安静

### Task 5（Controller）: 文档 + 收尾

- [ ] README 增"部署到自己的服务器"节（compose 模板 + deploy.sh 用法 + 路由实测记录）
- [ ] spec 补验收结果；用户人工复验（真实客户端播放）列为非阻塞跟进项
- [ ] 轻量终审（本里程碑代码面小：Dockerfile/compose/脚本 diff 由 controller 直接审）→ 合并 main

---

## Self-Review 结果（已执行）

- **Spec 覆盖**：镜像构建于路由(T1 deploy.sh/T2)、部署布局(T1/T2)、Jellyfin 新部署+初始化(T1 compose/T3)、恒等映射+MEDIA_ROOTS(T1 compose)、验收剧本全部七项(T4)、回滚(compose down，spec 已述)、边界（不动现有容器——compose 独立项目目录；不暴露外网——仅 8096 端口映射局域网）。
- **占位符扫描**：无。
- **一致性**：容器内路径 `/media/movies` 与 `MEDIA_ROOTS=/media` 一致；`SUBTITLE_SCOUT_CACHE_DIR=/cache` 与 volume `./cache:/cache` 一致；tsx 移依赖与 Dockerfile `--omit=dev` 一致。
