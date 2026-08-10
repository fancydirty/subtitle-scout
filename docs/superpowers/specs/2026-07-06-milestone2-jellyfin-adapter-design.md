# Milestone 2 Design: Jellyfin Adapter + Sidecar 常驻模式

Status: approved by user on 2026-07-06
Scope: 从"手写 MediaContext 的 CLI"进化为"盯着 Jellyfin 自动干活的常驻 sidecar"。
M1 核心流水线（identify → cache → search → rank → gate → download → write → journal）零改动复用。

## 目标体验

用户在 Jellyfin 点开一部没有中文字幕的外语片；几十秒后暂停再看字幕菜单，
"中文（简体）"已经在那了。全程无人工介入，决策证据在 journal 里。

## 真实部署拓扑（2026-07-06 实地侦察）

```
NAS (Synology DS218+, 192.168.100.241)
  仅存储：/volume1/share/Movies（227GB 真实电影库，规范 release 命名）
  内存过弱，不跑任何服务。SMB share //192.168.100.241/share。

软路由 (iStoreOS, Docker)
  已有健康的 CIFS rw 挂载 //192.168.100.241/share → /mnt/nvme0n1-4/nas_media
  ├─ Jellyfin 容器（本里程碑部署）  -v <挂载>/Movies:/media/movies
  └─ subtitle-scout 容器            同一宿主路径挂到同一容器路径

字幕写入链路：subtitle-scout → CIFS → NAS（share 权限 777，实测 admin 可写）
```

两容器共享同一容器内路径 → 标准部署下 `MEDIA_PATH_MAPPINGS` 可省略（恒等映射）。

实地发现的产品论据（写进 README 素材库）：
- `Pulp Fiction (1994)`：83GB UHD REMUX、规范命名、无中文字幕 → 验收对象。
- `TRON - Ares (2025)`：目录里有中文 .ass，但按另一个 release 命名且不符合 Jellyfin
  外挂命名规则，Jellyfin 无法关联——"人肉找字幕"失败的活标本。

## 触发方式：轮询 /Sessions（已比较三案）

- **A. 轮询 Sessions API（选定）**：每 `POLL_INTERVAL_SECONDS`（默认 15）GET
  `/Sessions?api_key=...`，遍历 NowPlayingItem。任何 Jellyfin 版本可用、零插件、零配置。
- B. Webhook 插件：要求用户进 Jellyfin 装插件配 URL，违背三凭证哲学。v2 候选。
- C. WebSocket：文档薄、断线重连复杂度不值。

## 触发条件（全部满足才入队）

1. NowPlayingItem.Type 为 Movie 或 Episode；
2. 无中文字幕流：MediaStreams 中不存在 `Type=Subtitle` 且语言为 chi/zho/chs/cht/
   zh-*（含外挂与内嵌文本型；PGS 图形字幕按配置 `TREAT_PGS_AS_MISSING`，默认 true 视为缺失）；
3. 负缓存未命中（复用 M1 DecisionCache）；
4. 该 itemId 不在处理中（进程内 in-flight Set 去重）；
5. 同一 itemId 冷却期内不重复处理（`ITEM_COOLDOWN_MINUTES` 默认 30，防止失败后
   同一次播放反复触发烧配额）。

## 新增组件

```
src/adapters/players/jellyfin.ts   # JellyfinClient（fixture 可测）
src/core/mediaContext.ts           # Jellyfin item → MediaContext 映射 + 路径映射
src/daemon/watcher.ts              # 常驻轮询循环 + 触发条件 + 生命周期
src/cli/index.ts                   # 子命令化：run（M1 原样）/ watch / run-item
```

### JellyfinClient

- `getSessions()`：GET /Sessions，返回含 NowPlayingItem 的会话；
- `getItem(itemId)`：GET /Users/{userId}/Items/{itemId} 或 /Items?ids=（取
  ProviderIds、ProductionYear、Path、MediaStreams、Type、SeriesName/Season/Episode）；
  实现时以录制的真实响应为准选择端点；
- `refreshItem(itemId)`：POST /Items/{itemId}/Refresh；
- `verifyChineseSubtitle(itemId)`：重新 getItem，检查 MediaStreams 出现中文外挂字幕流；
- 认证：`X-Emby-Token` header；错误处理与审计模式沿用 AssrtClient（onApiCall 回调）。

### MediaContext 构造（src/core/mediaContext.ts）

Jellyfin item → M1 的 MediaContextSchema：
- title=Name，original_title=OriginalTitle，year=ProductionYear，
  provider_ids=ProviderIds（键小写化），type 由 Type 映射（Movie→movie，Episode→episode），
  season/episode=ParentIndexNumber/IndexNumber，runtime_minutes=RunTimeTicks/600_000_000；
- path/filename：item.Path 经 `MEDIA_PATH_MAPPINGS` 映射（`jellyfin前缀=本地前缀`，
  逗号分隔多对；未配置则恒等）；
- existing_subtitles：MediaStreams 中 Type=Subtitle 的流（language/format/source）；
- trigger='playback_start'。

### Watcher（src/daemon/watcher.ts）

```
每 tick：
  sessions = jellyfin.getSessions()
  对每个 NowPlayingItem：
    过触发条件 → 否则跳过
    item = jellyfin.getItem(id)
    ctx = buildMediaContext(item, mappings)
    outDir = dirname(ctx.media.path)          # 字幕写到视频同目录！
    result = runPipeline(deps, ctx, outDir)    # M1 流水线原样
    result=download → jellyfin.refreshItem → 轮询 verifyChineseSubtitle（最多 6 次×10s）
    journal 归档到 <cacheRoot>/journals/<itemId>-<ts>/（outDir 的 decision.json 移入，
    避免污染媒体目录——decision.json 不该躺在电影文件夹里）
```

注意：M1 runPipeline 把 journal 写进 outDir；daemon 模式下 outDir 是媒体目录。
处理：runPipeline 增加可选参数 `journalDir`（默认=outDir，保持 M1 CLI 行为不变），
daemon 传独立目录。这是 M1 核心唯一的改动，向后兼容。

### CLI 子命令化

- `subtitle-scout run --context x.json --out dir`：M1 原样；
- `subtitle-scout run-item --item-id <id>`：单发处理一个 Jellyfin item（调试/手动触发）；
- `subtitle-scout watch`：常驻 daemon。SIGINT/SIGTERM 优雅退出（等在途任务完成）。

新环境变量：`JELLYFIN_URL`、`JELLYFIN_API_KEY`、`MEDIA_PATH_MAPPINGS`（可选）、
`POLL_INTERVAL_SECONDS`（默认 15）、`ITEM_COOLDOWN_MINUTES`（默认 30）、
`TREAT_PGS_AS_MISSING`（默认 true）。

## 验证策略：两阶段

### 阶段 A：本地 OrbStack（本里程碑主体）

1. OrbStack 起官方 jellyfin/jellyfin 容器，挂 fixture 媒体目录；
2. fixture 媒体：ffmpeg 生成的极小视频（黑屏+静音几秒），按真实规范命名
   （如 `The.Matrix.1999.1080p.BluRay.x264.mkv`），必要时配 NFO 提供 provider ids；
3. 录制真实 Jellyfin API 响应（sessions/item/refresh 前后）→ fixtures/jellyfin/，
   单测全部离线跑；
4. 端到端：真播放（web 客户端）→ watcher 触发 → 真 ASSRT + 真 LLM → 字幕落盘
   同目录 → refresh → verifyChineseSubtitle 通过；
5. 客户端播放中能否立刻看到新字幕：实测记录行为（不承诺），写进 journal/文档。

### 阶段 B：软路由真实部署（阶段 A 完成后执行，视情况可切为 Milestone 2.5）

compose 部署 Jellyfin + subtitle-scout 于软路由，挂 CIFS 的 Movies 子目录；
用户真实点播 Pulp Fiction 验收。NAS 凭据等 secrets 走 .env（不入 git）。

## 不做什么（YAGNI）

- 不做全库扫描/后台预热；
- 不做 Webhook 插件与 WebSocket；
- 不做播放中强推字幕到客户端（记录 refresh 后各客户端实际行为即可）；
- 不做模糊缓存复用（judgeCacheReuse 继续推迟）；
- 不做多 Jellyfin 实例;
- Emby/Plex adapter 不在本里程碑（接口形状已为其留位）。

## 测试

- 单测：mediaContext 映射（含路径映射、季集、PGS 判定）、触发条件纯函数、
  JellyfinClient 用录制 fixture、watcher 用注入 fake client/pipeline 测 tick 逻辑
  （触发/去重/冷却/优雅退出）；
- 集成：阶段 A 的真实端到端（手动，不进 CI）；
- 全程 M1/M1.5 的 79 个测试保持全绿。
