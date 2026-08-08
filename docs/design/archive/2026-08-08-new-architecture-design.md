# 新架构设计方案：机械扫描 → 识别 Agent → 传送带 → 字幕 Agent

**日期**: 2026-08-08
**状态**: 待对抗审计
**前置调研**: Jellyfin 真实刮削行为（从 scout-jellyfin 实库取证）、OpenList 115 挂载完成

---

## 0. 用户裁决记录（本设计的全部来源）

这一版架构是用户逐条裁决出来的，每一条都记录出处，实现时不许偏离：

| # | 裁决 | 原文/语境 |
|---|---|---|
| 1 | 机械扫描，不猜身份 | "首先就是机械扫描，就是jellyfin 网易爆米花这类到底是怎么扫出来的" |
| 2 | 按 Jellyfin 约定整理目录 | "那我们就按jellyfin 的来吧，先把目录整理干净，按jellyfin 的要求来" |
| 3 | 不符合约定的静默跳过 | "不让他们看到，他们只需要知道如果有什么影视没扫描到，那就是他们自己的问题" |
| 4 | 识别 agent 只做两件事 | "识别这个资源是什么影视，以及其中哪些需要找字幕" |
| 5 | 系统自动判"要不要找字幕" | "身份确定后系统能拿到 origin language + 内嵌轨，自动判定"（用户确认"没毛病，可以"） |
| 6 | 识别与字幕解耦，数据库为传送带 | "识别agent 只管它的工作，字幕agent 也只管接收工作，它们之间就是用数据库为媒介的一个传送带" |
| 7 | 字幕 agent 按作品一簇簇消费 | "字幕agent不是一集一集的找，而是一个影视一个影视的找……把这个影视的缺的字幕给补满" |
| 8 | 纯机械调度，无 orchestrator agent | "机械调度，这个调度员agent 是之前的agent 漂移产出的，我从没有同意过这个架构" |
| 9 | 表结构/具体逻辑由我把握 | "这些表结构，具体逻辑我其实不懂的"（用户授权技术实现） |
| 10 | 参考 Jellyfin 刮削，照猫画虎 + 测试 | "请你不要闭门造车，而是看看它的刮削逻辑，照猫画虎，并且测试" |
| 11 | 测试目录：115 网盘 Mediary Scout（只读） | "115 网盘中有一个叫Mediary Scout的目录，全都符合jellyfin的刮削要求，就拿它做测试目录" |

---

## 1. Jellyfin 刮削行为实测（从 scout-jellyfin 实库取证）

软路由上有 `scout-jellyfin` 容器，扫描的就是我们的 `nas_media`。查它的 `jellyfin.db` 的
`BaseItems` 表，得到真实刮削结果：

### 1.1 表现好的（标准布局）

| 目录形态 | 实测 | 结果 |
|---|---|---|
| `Movies/Pulp Fiction (1994)/Pulp.Fiction.1994...mkv` | 电影 | ✅ `TRON: Ares` (2025) 等全部正确 |
| `TV/Constellation/Constellation.S01E01...mkv` | S1E1-S1E7 | ✅ 全部正确 |
| `anime/Gachiakuta/[Erai-raws] Gachiakuta - 05...mkv` | S1E5 | ✅ 父目录唯一季 → 裸集号归 S1 |
| `anime/Gachiakuta/Gachiakuta.S01E19...mkv` | S1E19 | ✅ |

### 1.2 表现差的（fansub 命名 + 乱布局）

| 目录形态 | 实测 | 结果 |
|---|---|---|
| `SPY x FAMILY/[Moozzi2] Spy x Family S2 - 07...mkv` | **S1E10** | ❌ 实际 S2E7 |
| `SPY x FAMILY/[Erai-raws] Spy x Family Season 3 - 09...mkv` | **S1E9** | ❌ 实际 S3E9 |
| `SPY x FAMILY/SPY.x.FAMILY.S03E01...mkv` | S3E1 | ✅（标准命名仍对） |

### 1.3 结论

Jellyfin 的路径解析（`SxxEyy`/裸集号/目录名）在**标准命名 + 标准布局**下可靠；
在 **fansub 括号标签 + 文件与季目录同级** 时会**猜错季和集**。

这正是用户说"解决 Jellyfin 刮削识别错"的靶子：机械解析不可靠的形态，交给 agent。

---

## 2. 架构总览

```
                    ┌─────────────────────────────────────────────┐
                    │             守备目录（可多个）                 │
                    │   /hostroot/.../Movies  /TV  /anime  /115... │
                    └──────────────────────┬──────────────────────┘
                                           │ ① 机械扫描（Jellyfin 约定）
                                           ▼
                    ┌─────────────────────────────────────────────┐
                    │             files 表（事实表）                │
                    │  path / dir / filename / size / mtime /      │
                    │  duration / embedded_langs / audio_langs     │
                    │  season / episode（按约定解析，可空）         │
                    │  work_id（NULL=未识别）                      │
                    └──────────────────────┬──────────────────────┘
                                           │ ② 机械调度（纯 SQL）
                                           ▼
                    ┌─────────────────────────────────────────────┐
                    │     未识别作品列表 → 识别 agent（LLM）         │
                    │  一个作品目录 = 一次调用                      │
                    │  产出：work_id（TMDB 身份）                  │
                    └──────────────────────┬──────────────────────┘
                                           │ ③ 写回 files.work_id
                                           ▼
                    ┌─────────────────────────────────────────────┐
                    │  系统自动判定（机械，无 LLM）                 │
                    │  origin_lang（TMDB）→ 国产片？跳过             │
                    │  embedded_langs（ffprobe）→ 已有内嵌中字？跳过  │
                    │  其余 → needs_subtitle = true                │
                    └──────────────────────┬──────────────────────┘
                                           │ ④ 机械调度（纯 SQL）
                                           ▼
                    ┌─────────────────────────────────────────────┐
                    │  needs_subtitle 文件清单 → 字幕 agent（LLM）   │
                    │  一个作品 = 一簇消费                          │
                    │  产出：字幕落盘 + 状态更新                    │
                    └─────────────────────────────────────────────┘
```

**关键性质**：
- 四个环节之间**零直接耦合**，全部通过数据库（files 表 + 状态列）传递
- 调度是纯机械的：`SELECT ... WHERE work_id IS NULL` → 派识别；
  `SELECT ... WHERE needs_subtitle = true` → 派字幕
- 没有 orchestrator agent，没有 UNIT_LIMIT/MAX_TARGETS 这类节流
- 识别 agent 一次处理一个作品目录（一簇），字幕 agent 一次处理一个作品的所有缺字幕文件

---

## 3. 数据模型

### 3.1 files 表（核心事实表）

机械扫描的产出，每行一个媒体文件。**零身份判断**，只落原始事实 + 按约定解析的结构。

```sql
CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,          -- 绝对路径
  dir TEXT NOT NULL,                  -- 所在目录
  filename TEXT NOT NULL,             -- 文件名
  size INTEGER NOT NULL,              -- 字节
  mtime INTEGER NOT NULL,             -- 毫秒
  duration_sec INTEGER,               -- ffprobe 探测，可空（探测失败）
  embedded_langs TEXT,                -- JSON 数组，ffprobe 内嵌字幕轨语言
  audio_langs TEXT,                   -- JSON 数组，ffprobe 音轨语言
  -- 以下按 Jellyfin 约定解析，可空（解析不出/不符合约定）
  season INTEGER,                     -- 季号（目录 Season XX / 文件名 SxxEyy）
  episode INTEGER,                    -- 集号
  work_id TEXT,                       -- NULL=未识别；'tmdb:<id>'=已识别
  needs_subtitle INTEGER,             -- NULL=未判定；0=不需要；1=需要
  sub_status TEXT,                    -- NULL=未处理；'missing'/'covered'/'embedded'/'unavailable'
  updated_at INTEGER NOT NULL
);
```

### 3.2 works 表（作品表，识别 agent 产出）

```sql
CREATE TABLE works (
  id TEXT PRIMARY KEY,                -- 'tmdb:<id>'
  title TEXT NOT NULL,                -- TMDB 主标题
  original_title TEXT,                -- 原名
  year INTEGER,                       -- 首映年
  media_type TEXT NOT NULL,           -- 'tv' / 'movie'
  origin_lang TEXT,                   -- TMDB origin language（判定国产片用）
  overview TEXT,                      -- 简介
  poster_path TEXT,
  chinese_titles TEXT,                -- JSON 数组，中文译名变体
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### 3.3 为什么不需要"目录表"

目录树隐含在 `files.dir` + `files.path` 里，SQL 的 `GROUP BY dir` 可重建任意层级视图。
不单独建目录表——目录不是实体，是文件的组织方式（用户裁决 #9 授权我定，此为其一）。

### 3.4 集号怎么来（用户裁决记录）

用户明确："识别agent 要做的不仅是识别，还有分包，打包……它确定这一千集都是有的，那就直接映射"。

结合 Jellyfin 约定：**扫描器按约定解析出 season/episode（可空），识别 agent 确认或修正**。
"不接受机械解码"指的是**不让机械解析决定作品身份**——季集号在 Jellyfin 约定下由扫描器提取，
识别 agent 看到的是"这个作品目录 + 它的文件列表（含结构提示）"，它确认身份后，
系统按约定展开映射。fansub 命名（`S2 - 07` 那种）解析不出或解析错的文件，
season/episode 为 NULL，由识别 agent 在确认身份时**逐文件给出正确的季集号**（批量工具，见 §5）。

---

## 4. 机械扫描器

### 4.1 行为（照 Jellyfin）

1. 遍历守备目录（递归，按扩展名过滤媒体文件：mkv/mp4/avi/ts/m2ts/wmv/flv/webm）
2. 对每个文件 ffprobe 探测（duration、embedded_langs、audio_langs）——**可并发、可跳过**
   （指纹 mtime+size 未变则不重探）
3. 按 Jellyfin 约定解析路径结构：
   - `Movies/名字 (年份)/xxx.mkv` → work 候选 + 电影
   - `TV/名字/Season XX/SxxEyy.mkv` → 季集号
   - `TV/名字/SxxEyy.mkv`（文件在剧根目录）→ 季集号（无 Season 目录）
   - 解析不出的 → season/episode 置 NULL，仍入库
4. **静默跳过**不符合约定的：
   - 无媒体文件的目录（纯空目录/纯字幕目录）
   - 文件名无法解析出任何结构的（如纯哈希名）
   - 这些**不产生任何提示**，用户看不到（裁决 #3）

### 4.2 增量更新（照 Jellyfin）

- 指纹（mtime+size）未变的文件跳过 ffprobe
- 新文件 → 插入（work_id=NULL，等识别）
- 消失的文件 → 去抖后删除（复用现有三层防线）
- 指纹变化 → 重探，season/episode 重新解析

### 4.3 与现有代码的关系

现有 `walkVideoFiles`（selfScan.ts）已做遍历；`streamProbe.ts` 已做探测；
`identifyFromPath.ts` 的**季集号解析部分**（`parseFilename`/`detectSeasonFolder`）可复用——
但身份判断（`resolveToTmdb` 那类）**彻底移除**，识别只产 season/episode 结构提示。

---

## 5. 识别 Agent

### 5.1 输入（一次一个作品目录）

```
作品目录: /hostroot/.../TV/SPY x FAMILY/
类型:     tv（按守备目录类型或目录结构推断）
文件数:   12
文件列表:
  - filename: SPY.x.FAMILY.S03E01...mkv    season: 3   episode: 1   duration: 1440s
  - filename: [Moozzi2] Spy x Family S2 - 07...mkv    season: NULL  episode: NULL  ← 机械解析不出
  - ...
```

### 5.2 工具

- `search_tmdb(query, media_type)` — 搜候选
- `get_tmdb_details(tmdb_id)` — 核验（双证据：名字 + 季数/年份/时长）
- `write_identified_media({ tmdb_id, files: [...] })` — **批量绑定**（一次调用的输出，非逐文件）

`write_identified_media` 的 `files` 数组：
- 每个文件：`{ filename, season?, episode? }`
- season/episode 可空——**沿用机械解析值**，agent 只在机械解析**错/缺**时补
  （如 `S2 - 07` 那个文件，agent 看到它，结合季表判断它是 S2E7，填上）
- 这个工具是"分包打包"：agent 确认作品身份 + 确认/修正每个文件的季集映射，一次写入

### 5.3 输出

- `works` 表插入一行（TMDB 身份）
- `files.work_id` 批量更新为 `tmdb:<id>`
- `files.season/episode` 按 agent 确认/修正后的值更新

### 5.4 识别完自动判定"需不需要字幕"（机械，无 LLM）

```
对每个 work_id 刚确认的文件：
  origin_lang = works.origin_lang（TMDB）
  if origin_lang ∈ 目标语言（如 zh）→ needs_subtitle=0（国产片，裁决 #5）
  elif embedded_langs 含目标语言 → needs_subtitle=0（已有内嵌中字）
  elif 磁盘已有同名 sidecar 中文字幕 → needs_subtitle=0（已有外挂）
  else → needs_subtitle=1
```

---

## 6. 字幕 Agent

### 6.1 输入（一次一个作品，一簇）

```
作品: SPY x FAMILY (tmdb:120089)
需字幕的文件:
  - S3E1  /hostroot/.../SPY.x.FAMILY.S03E01...mkv
  - S2E7  /hostroot/.../[Moozzi2] Spy x Family S2 - 07...mkv
  - ...
字幕写到: 各文件同目录（系统指定，agent 不需要想）
```

### 6.2 职责（系统 harness 它）

- 搜字幕源（ASSRT/OpenSubtitles/subhd/...）
- 下载候选 → 沙盒体检 → 验证集号对得上 → 装盘
- 不负责：目录结构、身份、字幕放哪（系统指定）、集号判断（识别 agent 已备好）

### 6.3 输出

- 字幕文件落盘（视频同目录）
- `files.sub_status` 更新（covered/unavailable）

---

## 7. 机械调度器

**纯 SQL + 定时 tick**，无 LLM：

```
每个 tick（如 30s）：
  ① 识别队列：SELECT DISTINCT dir FROM files WHERE work_id IS NULL
               → 派识别 agent（一次一个 dir，串行）
  ② 字幕队列：SELECT * FROM files WHERE needs_subtitle=1
               → 按 work_id 分组，一簇一次（串行或小并发）
```

- 无 UNIT_LIMIT、无 MAX_TARGETS——有多少未识别的就识别多少，直到清空
- 无 24h 心跳——只要还有 work_id IS NULL 的行就继续派
- 失败退避：识别失败的目录记 attempt，下次重试（沿用退避阶梯思想，但不节流队列）

---

## 8. 与现有代码的迁移

### 8.1 删除（architectural 死代码）

- `orchestratorAgent.ts` / `orchestratorSkill.ts` — orchestrator agent（用户从未同意）
- `findSubtitleWorkerTask.ts` 的 mapper 里的 workUnit 分组逻辑（改由扫描器分层）
- `unidentifiedFindSubtitle.ts` 的 buildUnidentifiedTargets 那一套
- `workUnit.ts` 的 groupIntoWorkUnits / workRootOf（被新模型取代）
- `ingest.ts` 的身份相关逻辑

### 8.2 保留复用

- `walkVideoFiles`（遍历）
- `streamProbe`（ffprobe）
- `parseFilename` / `detectSeasonFolder`（季集号结构解析）
- `findSubtitleWorker` / 字幕工具（搜索→验证→装盘）
- 三层防线（消失去抖、骤降哨兵）
- `bumpParkedRetry` 的思想（识别失败的退避）

### 8.3 前端

用户裁决：**后端修好跑通后前端全删重做**。本设计只动后端。

---

## 9. 测试计划

### 9.1 单元测试

- 扫描器：目录遍历、扩展名过滤、Jellyfin 约定解析（含 fansub 失败形态）、增量更新
- 机械调度：识别队列 SQL、字幕队列 SQL、失败退避
- 自动判定：origin_lang / embedded_langs / sidecar 三种跳过逻辑

### 9.2 集成测试（真实数据）

- **115 网盘 Mediary Scout 目录（只读）**：
  - Movies/ 36 部电影、TV/ 31 部剧、Anime/ 16 部动画，全部符合 Jellyfin 约定
  - 验证：扫描器能扫出全部；识别 agent 能全部识别（TMDB 核验）；需字幕判定正确
- **nas_media 现有目录**：
  - 验证不符合约定的（如 SPY x FAMILY 乱布局）被静默跳过
  - 验证符合约定的（Constellation 等）正常入库

---

## 10. 验收

| 门 | 判据 |
|---|---|
| 类型 | 根 tsc 0 错 |
| 后端测试 | 全绿（删掉旧测试后重写） |
| 构建 | 通过 |
| Mediary Scout 测试 | 83 个作品全部识别、TMDB 身份全部核验通过、需字幕判定正确 |
| nas_media 测试 | 符合约定的入库、不符合的静默跳过 |
| 调度 | 无 orchestrator agent；识别/字幕队列纯机械驱动 |
