# Milestone 3 Design: 软路由真实部署

Status: approved by user on 2026-07-06（含全权委托：部署与验收测试由 agent 代执行）
Scope: subtitle-scout Docker 化并部署到用户 iStoreOS 软路由，与新部署的 Jellyfin
共同挂载 NAS 真实电影库，完成真实媒体验收。零代码改动预期（若真实环境逼出 bug 则按惯例修）。

## 目标环境（2026-07-06 实地侦察）

- 软路由：iStoreOS，x86_64，8GB RAM（可用 ~2.8GB），Compose v2.39.1，ghcr.io 可达；
- 媒体：NAS (Synology 192.168.100.241) CIFS share 已挂载于软路由
  `/mnt/nvme0n1-4/nas_media`（rw，实测健康）；电影库 `<挂载>/Movies`（227GB）；
- 部署惯例：`/mnt/nvme0n1-4/docker/<project>/` 每项目一目录，`restart: unless-stopped`；
- 开发机 Mac 为 arm64，与路由异构 → 在路由上构建镜像（rsync 源码 + compose build）；
- 前辈项目 `ai-subtitle-downloader`（Python/xvfb/浏览器抓取路线）证明痛点长期存在；
  其 compose 内明文 secrets 已提醒用户自行处理，不在本里程碑范围。

## 部署布局

```
/mnt/nvme0n1-4/docker/subtitle-scout/
├── docker-compose.yml
├── .env                  # 全部凭据（gitignored 模式；绝不写进 compose）
├── src/                  # rsync 自开发机（含 package.json 等构建上下文）
└── cache/                # SUBTITLE_SCOUT_CACHE_DIR 挂载点（journal/档案/缓存持久化）
```

## 服务

### jellyfin（新部署）

- 镜像 `ghcr.io/jellyfin/jellyfin:latest`；
- `/config` → `./jellyfin-config`（nvme），`/media/movies` → `<CIFS挂载>/Movies`；
- 端口 8096（部署前实测确认空闲）；局域网访问，不做 Caddy/域名暴露；
- 初始化沿用 M2 的 Startup API 自动化（管理员、建库、API key）。

### subtitle-scout

- Dockerfile：`node:22-slim`，`npm ci --omit=dev` + tsx 运行 `src/cli/index.ts watch`；
- `/media/movies` 与 jellyfin 同源同路径（恒等映射，`MEDIA_PATH_MAPPINGS` 省略）；
- `MEDIA_ROOTS=/media` 收紧写入白名单；
- `JELLYFIN_URL=http://jellyfin:8096`（compose 网络内服务名）；
- LLM 凭据沿用 MiMo SGP（或 DeepSeek v4，探针自适应，无需关心）；
- `restart: unless-stopped`；日志走 docker logs。

## 验收剧本（agent 代执行）

1. 部署后 Jellyfin 完成 Movies 库扫描（227GB 元数据）；
2. 通过 Sessions API 模拟客户端播放 **Pulp Fiction (1994)**（83GB UHD REMUX，无中文字幕）；
3. 观察 subtitle-scout 日志：触发 → 流水线 → 下载 → 落盘 NAS（经 CIFS）→ FullRefresh →
   verify 字幕流可见；
4. 确认 NAS 上 `Pulp Fiction (1994)/` 目录出现 `*.zh-Hans.*` 且 Jellyfin 流列表可见；
5. 彩蛋验收：**TRON - Ares (2025)**——目录内既有错配命名的中文 .ass（Jellyfin 不识别），
   看 scout 是否正确判定"缺字幕"并补一个规范命名的；
6. journal 审计完整归档于 cache/journals；
7. 用户后续人工复验：真实客户端播放看字幕（非阻塞项）。

## 边界（YAGNI）

- 不动路由上任何现有容器/服务；
- 不做公共镜像发布（开源发布是另一个里程碑）；
- 不做 Caddy/外网暴露/HTTPS；
- 不做 Jellyfin 硬件转码调优；
- 代码零改动预期；真实环境逼出的 bug 按 TDD 惯例修并带回归测试。

## 回滚

`docker compose down` + 删除项目目录即完全清除；不触碰 NAS 媒体文件
（除新增字幕文件，可手动删除）；Jellyfin config 独立目录，删除无残留。

## 验收结果（2026-07-06，agent 代执行）

- 部署：双容器 up，镜像于路由构建；Jellyfin 建库扫描 10 部电影，元数据在线匹配成功。
- Pulp Fiction（83GB UHD REMUX，仅内嵌 PGS 图形中字）：判缺 → 流水线 → 字幕经 CIFS
  写入 NAS（298,969 字节 .zh-Hans.ass）→ FullRefresh → Jellyfin 流列表可见。69 秒。
- The Astronaut（2025）：暴露 ASSRT 零结果时 `subs:{}` 怪癖（已修 + fixture + 回归测试，
  f3d8af8），修复重部署后自动重试，模型以低置信 `ask_user` 保守拒绝——正确。
- TRON: Ares：内嵌 40 条文本字幕轨含 2 条 zho → 正确判"不缺"静默跳过；目录中错配
  命名的外挂 .ass 与判定无关（Jellyfin 本就不识别它）。
- 模拟播放注意：无进度心跳的 Sessions/Playing 会话会被 Jellyfin 快速清理，
  测试时需周期 POST Sessions/Playing/Progress。
- 非阻塞跟进：用户真实客户端播放复验。
