# 剧集详情页重设计 · 设计文档（2026-07-20，roadmap item B）

## 目标

把"小家子气、空白多、没用足 TMDB"的剧集详情页，重做成**元数据丰盛但克制**的媒体库详情页：
1. 展现**剧集简介**（TMDB series overview）——现状完全没有。
2. **点某一集 → 就地展开那一集的简介**（TMDB episode overview）——用户最重点的诉求。
3. 顶部**渐变压暗的背景大图 hero**（氛围感）+ **逐集 16:9 剧照缩略图**（用户选定的最丰盛档）。
4. 保留并复用现有覆盖态语义（5px 语义点、三层格阵事实源、含 A 修的内嵌区分）。

调研支撑：Overseerr/Jellyseerr（季手风琴+文字在左逐集行+渐变 hero）、Plex（Modern Layout 背景图优先）、
Jellyfin（逐集 list+剧照+状态指示）、Trakt（**反面教材**：停靠右侧的弹出面板逼仄难读）。

## 已锁定的设计决策（brainstorming 定盘，用户 2026-07-20 拍板）

- **方向**：季手风琴 + 文字在左的逐集行；点一集**行内展开**该集简介。**彻底移除现有右侧滑入面板
  `EpisodeDetail`**（=Trakt 反模式）。行内展开一石二鸟：既除反模式，又天然实现"点某集看那集简介"。
- **剧照缩略图**：**开**（逐集 16:9 still）。
- **背景 hero**：**带**（渐变压暗背景大图）。
- **超长季密度自适应**（主控技术判断，非用户逐条拍）：行式为默认；**单季集数超阈值（EPISODE_ROW_CAP=30）
  的季回落到紧凑点阵格**（复用现有 `EpisodeCell`），点格时在格阵下方就地展开该集简介。里番/长番
  200+ 集不会堆成 200 条带剧照的巨行。
- **缓存回填**（主控技术判断）：加列后现有 `tmdb_seasons`/`series` 行的新字段为 NULL；迁移时**把
  `tmdb_seasons.fetched_at` 清零强制下轮重富化**，series 层靠既有富化重试（genres 回填那条 pass）
  连带补 overview/backdrop——不干等 7 天 TTL。

## 呈现层设计（web/src/library）

单一事实源仍是 `buildGridCells`（canonical ∪ onDisk 按集号并集）。本次把 canonical 侧携带的字段从
仅 `title` 扩到 `title/overview/airDate/stillPath`，逐集行/格阵/展开面板共用。

### 组件拆分（新 + 改 + 删）

| 组件 | 动作 | 职责 |
|---|---|---|
| `SeriesHero.tsx` | 新 | 背景大图（backdrop）+ 180° 渐变压暗 scrim + 标题/年代/网络/剧集简介叠加其上；无 backdrop 时降级为纯排印头部（大字标题+留白，不放空图占位） |
| `FactsRail.tsx` | 新 | mono 技术读数行/栏：覆盖 N/M、目标语言、来源（外挂/内嵌）。把机械数据视觉隔离，正文保持比例 |
| `SeasonAccordion.tsx` | 新 | 每季一个可折叠 disclosure；季头卷起汇总（`第 N 季 · Asylum · 13 集 · 3 集缺字幕` + 细覆盖条）；展开渲染 body |
| `EpisodeRow.tsx` | 新 | 文字在左：语义点 + `E0N`(mono) + 标题 + 内嵌 tag + 剧照(右, 112×63) + air_date(mono)；点击行内展开该集简介（height 过渡）。同一时刻至多一行展开 |
| `EpisodeCell.tsx` | 留 | 超长季密度回落用的紧凑点阵格（现状实现，不动其视觉） |
| `SeasonGridBody.tsx` | 新 | 超长季 body：`EpisodeCell` 格阵 + 点格在格阵下方展开该集简介板 |
| `EpisodeDetail.tsx` | **删** | 右侧滑入面板整体移除（含 `.library-detail-panel` 相关 CSS、SeriesPage 的 selection 右板分支） |
| `SeriesPage.tsx` | 改 | 编排：Hero + FactsRail + 每季 SeasonAccordion（body 按集数选 EpisodeRow 列表 or SeasonGridBody） |
| `episodeState.ts` | 改 | `GridCell` 扩 canonical 字段；`buildGridCells` 透传 overview/airDate/stillPath |
| `text.ts` | 复用 | 覆盖句（含 A 修的内嵌 clause）→ 季头汇总 |

### 视觉语汇（Astryx，不新起配色）

- 背景 hero scrim：`linear-gradient(180deg, rgba(11,12,15,.35) 0%, #0b0c0f 82%)`，图只在顶部存活，
  标题/简介坐在实底上（暗色下文字对比的最可靠做法）。
- **单 accent 铁律**：整屏至多一处 lime `#a3e635`——给**当前展开行的左边框**。语义点用既有调色板
  （covered/embedded 绿 `#28bf5c`、missing 灰空心 `#6b7280`、throttled 灰、error 红），**不占 accent**。
- mono（Geist Mono）只给技术读数：集号、air_date、语言码、覆盖计数。正文/简介绝不 mono。
- 发丝线 `rgba(255,255,255,.07)` 分隔；无 drop-shadow。

### 交互

- 点季头 → 展开/折叠该季（懒渲染 body）。
- 点逐集行 → 就地展开该集简介（height 过渡）；再点或点他行 → 收起（同一时刻至多一行开）。
- 超长季：点格 → 格阵下方展开该集简介板（同一事实，换布局）。
- 键盘：行/季头可聚焦、Enter/Space 触发；移除原 esc-关闭面板（无面板了）。

## 数据模型变更（src/v2/db.ts 迁移）

新增一条 migration（版本以 `MIGRATIONS` 数组末尾顺延，v16+；纯 `ALTER TABLE ADD COLUMN`，不触发建新表）：

```sql
ALTER TABLE series ADD COLUMN overview TEXT;         -- TMDB 剧集简介；NULL=未富化/无
ALTER TABLE series ADD COLUMN backdrop_path TEXT;    -- TMDB 背景图路径；web 端自拼 CDN 前缀
ALTER TABLE tmdb_seasons ADD COLUMN overview TEXT;   -- 逐集简介；NULL=未富化/该集无
ALTER TABLE tmdb_seasons ADD COLUMN air_date TEXT;   -- 逐集首播日 'YYYY-MM-DD'；NULL=无
ALTER TABLE tmdb_seasons ADD COLUMN still_path TEXT; -- 逐集剧照路径；NULL=无
UPDATE tmdb_seasons SET fetched_at = 0;              -- 强制下轮重富化回填新列（不干等 TTL）
```

`series` 层无强制回填 SQL——存量剧的 overview/backdrop 靠既有富化重试 pass（genres 回填那条）
连带补齐，NULL 期间前端诚实降级（见下）。

## TMDB adapter 扩展（src/adapters/providers/tmdb.ts）

- `TmdbDetails` 增 `backdropPath: string \| null`；`getDetails` 从 `/tv/{id}` 的 `backdrop_path` 提取
  （overview 已提取，无需改）。空串/缺失/非字符串 → null（同既有字段口径）。
- `getSeasonEpisodes` 返回形状从 `{episode, title}` 扩到 `{episode, title, overview, airDate, stillPath}`：
  - `overview` ← `e.overview`（空串→null）
  - `airDate` ← `e.air_date`（空串→null）
  - `stillPath` ← `e.still_path`（空串→null）
  失败/降级语义完全不变（null=真无数据含 404，抛 `TmdbRequestFailedError`=瞬时可重试）。

## 富化与持久化

- `tmdbCatalog.ts` `refreshSeriesCatalog`：把 `getSeasonEpisodes` 的新字段一并写进 `tmdb_seasons`
  INSERT；`canonicalEpisodes` 读出 `overview/air_date/still_path`。gain-path 降级不变（拿全所有季完整
  数据才在单事务 DELETE+INSERT，绝不半新半旧）。
- `libraryRepo.ts` `upsertSeries`：`SeriesUpsertParams` 增 `overview?`/`backdropPath?`；INSERT 列表 +
  ON CONFLICT 用既有 `COALESCE(excluded.x, x)` 语义（新值非 NULL 才覆盖，抖动失败不清空既有）。
- ingest 富化调用点（现供 `posterPath` 的同一处，getDetails 结果落 series 行）：把 `overview` +
  `backdropPath` 一并传入 upsertSeries。getDetails 已返回 overview，backdropPath 本次新增。

## DTO 变更（web/src/api/types.ts ↔ src/dashboard/apiV2.ts 保持一致）

```ts
interface LibrarySeriesSummaryDTO {   // 增：
  overview: string | null
  backdropPath: string | null
}
interface LibraryCanonicalEpisodeDTO {  // 增：
  overview: string | null
  airDate: string | null
  stillPath: string | null
}
```

`apiV2.ts` 的 series-detail builder：series overview/backdrop 取自 series 行；canonical 逐集三字段取自
`canonicalEpisodes` 读出结果。

## 图片 URL（web/src/api/client.ts）

现有 `TMDB_IMAGE_BASE='https://image.tmdb.org/t/p/w400'` + `posterUrl()`。新增两个尺寸各一函数：
- `backdropUrl(path)` → `.../t/p/w1280{path}`（hero 背景）
- `stillUrl(path)` → `.../t/p/w300{path}`（逐集剧照缩略图）
入参 null → 返回 null（组件据此不渲染 `<img>`，走降级）。

## NULL / 诚实降级（北极星：silent 装错比留缺口更糟）

- series overview 为 null → 不渲染简介段（不留空框、不编造）。
- backdrop 为 null → hero 降级为纯排印头部（大字标题 + 留白），不放灰色空图占位。
- 逐集 overview 为 null → 展开区显示"暂无本集简介（TMDB 未提供）"，不空白、不糊。
- still 为 null → 该行不显剧照（保持文字行），不放碎图。
- canonical 未缓存（`isCanonicalPending`）→ 沿用现状"应有集目录尚未缓存"提示。

## 测试策略

- **adapter**（tmdb.test.ts）：getDetails 提 backdropPath；getSeasonEpisodes 提 overview/airDate/stillPath
  （含空串→null、缺字段→null）。
- **catalog**（tmdbCatalog.test.ts）：refresh 把新字段写库；canonicalEpisodes 读回；gain-path 降级不半新半旧。
- **repo**（libraryRepo.test.ts）：upsertSeries 写/COALESCE overview/backdrop，NULL 不清空既有。
- **DTO/apiV2**：series-detail 出参带新字段（有值/NULL 两路）。
- **episodeState.test.ts**：GridCell 透传 canonical 三字段。
- **前端组件**（新测试）：Hero 有/无 backdrop 两态；SeasonAccordion 季头汇总 + 展开折叠；EpisodeRow 点击
  行内展开该集简介、同一时刻至多一行开、still 有/无；超长季回落 SeasonGridBody；**回归：右侧 EpisodeDetail
  面板已移除**（旧面板相关断言删/改）。
- 迁移：v16 加列不炸存量库；fetched_at 清零后下轮 refresh 回填。

## 范围外（YAGNI）

- 演员表/评分/预告片/外部链接——本轮不做（媒体中心堆料的开始，克制）。
- 电影详情页——本轮只做剧集（movie 详情后续单开）。
- 逐集 runtime 展示——数据可得但详情页不放（信息噪音）。
- 剧照懒加载/虚拟滚动优化——超长季已用格阵回落规避，暂不需要。
