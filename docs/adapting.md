# 适配指南：为 Emby / 其他媒体服务器实现 PlayerServer

本文档面向两类读者：

1. **开发者**：想为 Emby 或其他媒体服务器贡献适配器
2. **使用 coding agent 的用户**：有自己的 Claude Code、Cursor 等工具，想让 agent 帮你写适配器

## 1. 架构一分钟

subtitle-scout 的核心管线（识别 → 搜索 → 排序 → 下载 → 写盘）完全不认识任何特定的媒体服务器。所有对媒体服务器的依赖都通过 **`PlayerServer`** 端口（定义在 `src/adapters/players/types.ts`）抽象出来了。

```
核心管线 ──→ PlayerServer 接口 ←── JellyfinClient 实现
                ↑
                └── 你的 EmbyClient / PlexClient 实现
```

这个端口有 **六个方法**。实现一个新的适配器 = 实现这六个方法，让它们返回符合约定形状的数据。

**重要**：daemon watch 模式实际只消费其中五个方法（`getSeasonEpisodes` 仅在整季升格的 CLI/管线路径使用），但适配器应实现全部六个方法以保证完整性。

---

## 2. 逐方法契约表

以下是六个方法的语义、消费者、触发时机与失败约定：

| 方法 | 语义 | 被谁消费 / 何时触发 | 失败约定 |
|------|------|---------------------|----------|
| **`getSessions()`** | 获取当前所有播放会话（含正在播放的条目） | daemon watcher 15秒轮询驱动"正在播放"触发节拍 | **抛错**（轮询失败会记日志并跳过本轮） |
| **`getRecentItems(limit: number)`** | 按 DateCreated 倒序返回最近入库的条目 | daemon arrivals 扫描（默认 300s 轮询）驱动新入库触发节拍 | **抛错**（arrivals 失败会记日志并跳过本轮） |
| **`getItem(itemId: string)`** | 获取单条目完整详情（必须包含 Path、ProviderIds、MediaStreams、OriginalTitle、Overview 等字段） | watcher 处理流程中拉取完整元数据，构建 MediaContext | **抛错**（获取失败会导致该条目进冷却） |
| **`refreshItem(itemId: string)`** | 让服务器重新扫描该条目（**重点：必须重扫外部字幕文件**） | 下载完字幕后调用，让服务器识别新写入的 sidecar 字幕文件 | **抛错**（refresh 失败会记日志但不影响台账） |
| **`getChineseTitle(item: MediaItem)`** | 用服务器的元数据源（如 TMDb zh-CN）查询中文译名 | 构建 MediaContext 时调用，辅助字幕搜索精度 | **静默降级返回 null**（失败/无 provider id/非 Movie\|Series 均返回 null，绝不阻塞主流程） |
| **`getSeasonEpisodes(item: MediaItem)`** | 枚举该剧该季全部集（SxxExx、路径、是否缺中字） | 整季打包下载路径（`run-item` / `watch` 内部触发），非 daemon 核心路径 | **静默降级返回 []**（无 SeriesId / 无季号 / 失败均返回 []） |

### 关键实测教训

#### `refreshItem` 必须强制重扫外部字幕

**Jellyfin 实测**（2026-07-06）：裸 `POST /Items/{id}/Refresh` 不会重新扫描外部字幕文件，必须加参数 `metadataRefreshMode=FullRefresh`：

```typescript
// jellyfin.ts 第 110-112 行
/** 必须 FullRefresh：裸 refresh 不重扫外部字幕文件（2026-07-06 实测） */
async refreshItem(itemId: string): Promise<void> {
  await this.call('POST', `/Items/${encodeURIComponent(itemId)}/Refresh?metadataRefreshMode=FullRefresh&replaceAllMetadata=false`)
}
```

**适配其他服务器时**：你必须找到等效的"重扫外挂字幕"API 参数或端点，并真机实测验证——下载字幕 → refresh → `getItem` 检查 MediaStreams 是否新增字幕流。如果默认 refresh 不生效，检查 API 文档中的 metadata refresh mode、rescan external files、library scan depth 等参数。

#### `getChineseTitle` / `getSeasonEpisodes` 静默降级

这两个方法是**锦上添花**，失败不应破坏主流程：

- **`getChineseTitle`**：Jellyfin 实现走 `POST /Items/RemoteSearch/Movie` 或 `Series` + `MetadataLanguage: zh-CN`。无 ProviderIds / API 不可达 / 非 Movie|Series 类型均返回 `null`（见 `jellyfin.ts` 第 121-148 行）。
- **`getSeasonEpisodes`**：无 SeriesId / 无季号 / API 失败均返回 `[]`（见 `jellyfin.ts` 第 150-179 行）。

返回服务器侧原始路径，调用方负责通过 `MEDIA_PATH_MAPPINGS` 映射为本地路径。

---

## 3. 数据形状

### MediaItem 与 PlaybackSession

`src/adapters/players/types.ts` 第 5-6 行定义：

```typescript
export type MediaItem = JellyfinItem
export type PlaybackSession = JellyfinSession
```

当前线格式与 **Jellyfin API 同形**（Emby 天然兼容；其他服务器的适配器负责映射成此形状）。

### 字段分两层：schema 必填 vs 业务关键

**第一层：schema 必填（zod 校验硬性要求，缺了直接校验失败抛错）**

以 `jellyfin.ts` 第 17-34、37-43 行的 zod schema 为准，真正 required 的只有：

- **MediaItem (JellyfinItem)**: `Id`, `Name`, `Type`（"Movie" / "Episode" / "Series"）
- **PlaybackSession (JellyfinSession)**: `Id`

其余字段全部是 `.nullish()`——缺失或为 null 都能通过校验。

**第二层：业务关键（zod 不强制，但缺了对应功能会退化）**

| 字段 | 缺失后果 |
|------|----------|
| `Path` | 无法定位媒体目录，字幕无法写盘（该条目直接跳过） |
| `MediaStreams` | 无法判断是否缺中字（触发判定失效） |
| `ProviderIds`（如 `{ Tmdb: "937941", Imdb: "tt0133093" }`） | `getChineseTitle` 直接返回 null，中文译名查询退化 |
| `SeriesId` + `ParentIndexNumber` + `IndexNumber`（剧集） | `getSeasonEpisodes` 返回 []，剧集识别/季包路径退化 |
| `DateCreated` | arrivals 扫描无法判断新入库（watermark 比对失效） |
| `OriginalTitle`, `ProductionYear`, `Overview`, `SeriesName` | 搜索与识别精度下降 |
| `PlayState.IsPaused`（Session） | 无法过滤暂停中的会话 |
| `NowPlayingItem`（Session） | 该会话无法触发处理（视为空闲） |

**适配建议**：schema 必填是底线，业务关键字段能映射的尽量全部映射——每缺一个就少一块功能。

### Zod 校验与 passthrough

Jellyfin 适配器使用 **passthrough schema**（见 `jellyfin.ts` 第 14、34、42 行的 `.passthrough()`）：

```typescript
export const JellyfinItemSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  Type: z.string(),
  // ... 其余字段全部 .nullish() ...
}).passthrough()  // ← 允许未定义的额外字段通过
```

**含义**：你的适配器返回的对象可以包含**多余字段**（不会报错）；只有三个硬必填字段（MediaItem 的 Id/Name/Type，Session 的 Id）缺失或类型错误才会导致 zod 校验失败并抛出异常，其余字段缺失表现为对应功能退化（见上表）。

### Emby 特别提示

Emby 与 Jellyfin API **同源**，主要差异：

- 认证头同为 **`X-Emby-Token`**（见 `jellyfin.ts` 第 79 行）
- 大部分端点路径相同（`/Sessions`, `/Items`, `/Items/{id}/Refresh` 等）
- 字段形状高度相似（Id、Name、Type、Path、MediaStreams、ProviderIds 等）

**推荐策略**：直接复制 `jellyfin.ts` → 改类名为 `EmbyClient` → 真机测试 → 按实际差异微调（可能需调整 refresh 参数、RemoteSearch 端点等）。

---

## 4. 给你的 coding agent 的提示词

如果你不想手写代码，把下面这段**整段粘贴**给你的 Claude Code、Cursor 或其他 coding agent：

````markdown
# 任务：为 [你的服务器名称] 实现 PlayerServer 适配器

我需要为 subtitle-scout 项目适配 [Emby / Plex / 其他媒体服务器]。

## 目标

在 `src/adapters/players/` 目录下创建新文件（如 `emby.ts`），实现 `PlayerServer` 接口的全部六个方法。

## 契约文件

- **接口定义**: `src/adapters/players/types.ts`（PlayerServer 接口 + MediaItem / PlaybackSession 类型别名）
- **参考实现**: `src/adapters/players/jellyfin.ts`（Jellyfin 实现，认证头、字段映射、zod 校验、ITEM_FIELDS、FullRefresh 实测注释等全在这里）
- **消费者**: `src/daemon/watcher.ts`（WatcherDeps 展示了 daemon 如何调用这些方法）

## 六个方法的契约

1. **`getSessions(): Promise<PlaybackSession[]>`**  
   返回当前所有播放会话（含 NowPlayingItem）。失败**抛错**。

2. **`getRecentItems(limit: number): Promise<MediaItem[]>`**  
   按 DateCreated 倒序返回最近入库的条目（Movie / Episode）。失败**抛错**。

3. **`getItem(itemId: string): Promise<MediaItem>`**  
   获取单条目完整详情，必须包含字段：`Id`, `Name`, `Type`, `Path`, `MediaStreams`, `ProviderIds`, `OriginalTitle`, `ProductionLocations`, `Overview`, `SeriesId`（剧集）, `ParentIndexNumber`, `IndexNumber`。  
   相当于 Jellyfin 的 `/Items?ids={id}&fields=Path,ProviderIds,MediaStreams,OriginalTitle,ProductionLocations,Overview,SeriesId`。失败**抛错**。

4. **`refreshItem(itemId: string): Promise<void>`**  
   **关键实测坑**：必须让服务器**重扫外部字幕文件**。Jellyfin 裸 refresh 不生效，必须 `metadataRefreshMode=FullRefresh`（见 `jellyfin.ts` 第 110-112 行注释）。  
   你必须找到你的服务器的等效参数/端点并**真机实测验证**（下载字幕 → refresh → getItem 检查 MediaStreams 新增字幕流）。失败**抛错**。

5. **`getChineseTitle(item: MediaItem): Promise<string | null>`**  
   用服务器的元数据源（如 TMDb zh-CN RemoteSearch）查询中文译名。无 ProviderIds / 失败 / 非 Movie|Series → 静默返回 **`null`**，绝不抛错（见 `jellyfin.ts` 第 121-148 行）。

6. **`getSeasonEpisodes(item: MediaItem): Promise<SeasonEpisode[]>`**  
   枚举该剧该季全集（含 SxxExx、路径、是否缺中字）。无 SeriesId / 无季号 / 失败 → 静默返回 **`[]`**（见 `jellyfin.ts` 第 150-179 行）。  
   返回服务器侧原始路径（调用方负责 MEDIA_PATH_MAPPINGS 映射）。

## 数据形状约定

- **MediaItem**: 必须符合 `JellyfinItemSchema`（见 `jellyfin.ts` 第 17-34 行）。zod `.passthrough()` 允许多余字段；硬必填只有 `Id`/`Name`/`Type`（Session 只有 `Id`），其余字段是 `.nullish()`——但 `Path`/`MediaStreams`/`ProviderIds`/`SeriesId`/`ParentIndexNumber`/`IndexNumber`/`DateCreated` 等业务关键字段能映射的尽量映射，缺一个退化一块功能。
- **PlaybackSession**: 符合 `JellyfinSessionSchema`（见 `jellyfin.ts` 第 37-43 行）。
- **认证头**（如果是 Emby）: `X-Emby-Token`（见 `jellyfin.ts` 第 79 行）。

## 测试要求

参考 `src/adapters/players/jellyfin.test.ts` 的风格：

1. **录制真实响应**：在 `fixtures/[你的服务器名]/` 目录下录制 JSON fixtures（sessions、items、refresh 后等）。
2. **mock fetch**：测试不依赖真实服务器，用 fixtures 驱动。
3. **覆盖边界**：空结果、HTTP 错误、schema 校验、认证头是否正确发送。

运行 `npm run check` 和 `npm run test` 确保全绿。

## 完成判据

1. **类型检查通过**: `npm run check` 无错误
2. **测试全绿**: `npm run test` 全部通过
3. **真机验证**（可选但强烈推荐）:
   - 配置你的服务器 URL / API Key 到 `.env`
   - 运行 `npm run cli -- doctor` 检查连接
   - 运行 `npm run cli -- run-item --item-id <真实条目ID>` 单发验证（检查 refresh 是否真的让字幕可见）

## 关键提醒

- **不许凭空写字段名**：所有字段名/端点路径必须与你的服务器 API 文档一致，先查文档再写代码。
- **FullRefresh 等效物必须实测**：refresh 是最容易踩坑的地方，下载字幕后如果 MediaStreams 没新增字幕流 = refresh 参数不对。
- **静默降级不抛错**：getChineseTitle / getSeasonEpisodes 失败返回 null / [] 即可，不要 throw。
- **认证头名称**：Jellyfin/Emby 是 `X-Emby-Token`，Plex 是 `X-Plex-Token`，你的服务器是什么？先查再写。

完成后提交 PR，记得在 README 中更新支持的服务器列表。
````

---

## 附录：相关文件路径速查

- **接口定义**: `src/adapters/players/types.ts`
- **Jellyfin 参考实现**: `src/adapters/players/jellyfin.ts`
- **Jellyfin 测试**: `src/adapters/players/jellyfin.test.ts`
- **Jellyfin fixtures**: `fixtures/jellyfin/sessions-playing.json`, `items-detail.json`, `item-after-refresh.json` 等
- **Watcher 消费者**: `src/daemon/watcher.ts`（WatcherDeps 接口）
- **核心类型**: `src/core/episode.ts`（SeasonEpisode）, `src/core/schemas.ts`（MediaContext）

祝适配顺利！有问题欢迎提 issue 或 discussion。
