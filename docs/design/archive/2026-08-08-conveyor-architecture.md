# 传送带架构实现文档

**日期**: 2026-08-08
**状态**: 用户已确认架构方向，授权直接实施
**前置讨论**: 与用户多轮对齐，关键决策全部来自用户

---

## 0. 架构总览

```
扫描器（机械）→ work_files 表（文件级事实，按 dir_path 聚簇=未识别作品）
                      ↓
识别 agent（LLM）→ 确认作品根目录 = 哪部影视 → works 表 + 回填 work_files.work_id
                      ↓
            数据库 = 传送带
                      ↓
系统判定（机械）→ 查 TMDB origin_lang + 对照 ffprobe 内嵌轨 → 标记 sub_status
                      ↓
字幕 agent（LLM）→ 按作品一簇簇消费（一个 work 的全部 missing 文件）
                      ↓
翻译 agent（LLM）→ 兜底：找遍无果 → 外语音轨字幕 → AI 翻译
```

**核心原则**（全部来自用户决策）：

1. **机械层与 agent 层严格分工**：扫描/判定/调度是机械的；识别/找字幕/翻译是 agent 的
2. **两个 agent 零直接耦合**：数据库是它们之间唯一的媒介（传送带）
3. **识别 agent 不管集数**：它只确认"这个作品根目录 = 哪部影视"。集号是扫描器按约定解析的
4. **字幕 agent 按作品消费**：一个影视的所有缺字幕文件一簇处理，不管 1 集还是 1000 集
5. **没有 orchestrator agent**：调度是纯机械的（有未识别作品→派识别；有缺字幕→派字幕）
6. **不符合 Jellyfin 约定的目录静默跳过**：不进库、不报错、不展示。用户看不到"识别不出"的东西
7. **需不需要找字幕由系统判定**：身份确定后，查 TMDB origin_lang（国产跳过）+ 对照内嵌轨
   （内嵌中字跳过），不需要 agent 判断

---

## 1. 数据模型

### 1.1 works 表（作品，识别 agent 的产出）

```sql
CREATE TABLE works (
  id TEXT PRIMARY KEY,                        -- tmdb:37854
  kind TEXT NOT NULL CHECK(kind IN ('tv','movie')),
  title TEXT NOT NULL,
  chinese_title TEXT,
  year INTEGER,
  dir_path TEXT NOT NULL UNIQUE,              -- 作品根目录（扫描器解析，识别 agent 绑定的锚点）
  origin_lang TEXT,                           -- TMDB origin language（系统判定的输入）
  needs_subtitle INTEGER NOT NULL DEFAULT 1,  -- 系统判定结果：0=无需找（国产/内嵌中字），1=需要
  poster_path TEXT,
  overview TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### 1.2 work_files 表（媒体文件，扫描器的产出，端点=文件）

```sql
CREATE TABLE work_files (
  id INTEGER PRIMARY KEY,
  work_id TEXT REFERENCES works(id),          -- 从所属作品根继承；NULL=未识别作品根的文件
  path TEXT NOT NULL UNIQUE,                  -- 媒体文件绝对路径
  filename TEXT NOT NULL,
  dir_path TEXT NOT NULL,                     -- 所属作品根目录（= works.dir_path 的候选）
  season INTEGER,                             -- 扫描器按约定解析（电影 NULL）
  episode INTEGER,                            -- 扫描器按约定解析（电影 NULL）
  duration_sec INTEGER,                       -- ffprobe
  embedded_langs TEXT,                        -- ffprobe JSON 数组
  audio_langs TEXT,                           -- ffprobe JSON 数组
  sub_status TEXT NOT NULL DEFAULT 'missing',
    -- missing/covered/embedded/unavailable/ignored
    -- covered=外挂中字已就位; embedded=内嵌中字(系统判定); unavailable=搜索穷尽(带复查);
    -- ignored=国产等策略跳过(系统判定)
  status_reason TEXT,
  probe_mtime INTEGER, probe_size INTEGER,    -- 指纹（增量更新跳过探测用）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_work_files_work ON work_files(work_id);
CREATE INDEX idx_work_files_dir ON work_files(dir_path);
```

### 1.3 队列（传送带的两端，都是 SELECT，不是独立表）

```
识别队列: SELECT DISTINCT dir_path FROM work_files WHERE work_id IS NULL
          （一个 dir_path = 一个待识别作品）

字幕队列: SELECT work_id FROM work_files WHERE sub_status='missing' GROUP BY work_id
          （一个 work_id = 一簇，字幕 agent 一次消费一个）
```

---

## 2. 扫描器（机械）

按 Jellyfin 约定遍历守备目录，产出 work_files。

### 2.1 目录约定

```
Movies/<Movie Name (Year)>/任何层级的媒体文件   → 电影
TV/<Show Name>/<Season NN>/SxxEyy.ext         → 剧集
TV/<Show Name>/<Season NN>/任意命名.ext       → 剧集（文件名解析不出集号 → 该文件静默跳过）
```

- 守备目录（media root）的直接子目录 = 作品根（dir_path）
- `Movies/` 根下：直接子目录是作品根，文件放作品根内
- `TV/` 根下：直接子目录是作品根，作品根下 `Season NN` 目录是季，季目录内是集文件
- 作品根名即"作品名候选"（识别 agent 的输入）

### 2.2 解析规则

| 元素 | 来源 | 规则 |
|---|---|---|
| dir_path | 作品根目录 | media root 的直接子目录 |
| season | 季目录名 | `Season NN` / `Sxx` / `第N季` / `Specials`(→0) |
| episode | 文件名 | `SxxEyy` / `Eyy` / 裸集号（解析不出 → 该文件静默跳过） |
| duration_sec | ffprobe | 复用 streamProbe |
| embedded_langs | ffprobe | 复用 streamProbe |
| audio_langs | ffprobe | 复用 streamProbe |

### 2.3 不符合约定的处理

**静默跳过**：不写库、不报错、不展示。用户不知道有东西被跳过。

### 2.4 增量更新（Jellyfin 方式）

- 定时全量遍历 + `probe_mtime`/`probe_size` 指纹跳过未变化文件
- 新文件 → 插入 work_files（若 dir_path 已绑定作品 → 继承 work_id；否则 NULL）
- 消失文件 → 去抖后删除行（复用 ingest 既有三层防线）
- 变化文件 → 重探 + 重判定

---

## 3. 识别 agent（LLM）

### 3.1 工作台

识别队列（`work_files WHERE work_id IS NULL` 按 dir_path 分组）。机械调度一次派一个 dir_path。

### 3.2 任务输入（一个作品根）

```
作品根目录: /hostroot/.../TV/Spy x Family/
作品名候选: Spy x Family
类型:       tv（按所在守备目录推断）
文件数:     12
文件列表:
  Season 01/S01E01.mkv   时长 1440s   内嵌轨 ["jpn","eng"]
  Season 01/S01E02.mkv   时长 1440s   内嵌轨 ["jpn","eng"]
  ...
```

### 3.3 agent 做的事（一件事）

```
看作品名候选 "Spy x Family"
→ search_tmdb("Spy x Family", tv)
→ get_tmdb_details(tmdb:120089)
→ 双证据核验（名字匹配 + 季数/年份/时长吻合）
→ bind_work(dir_path, tmdbId, kind, ...)   ← 一次工具调用
```

**不碰集号、不枚举文件、不判断字幕需求。**

### 3.4 bind_work 工具

```
bind_work({
  dirPath: "/hostroot/.../TV/Spy x Family/",
  tmdbId: "120089",
  kind: "tv",
  title: "SPY x FAMILY",
  evidence: "名字匹配 + TMDB 季数 3 与磁盘季数 3 吻合"
})
```

执行：
1. 事务内创建 works 行（查 TMDB 富化：origin_lang/poster/overview/年份）
2. 回填 work_files.work_id WHERE dir_path = ?
3. 同一事务内按 §4 规则判定并标记 sub_status

### 3.5 无法识别的处理

- 搜索无果 / 证据不足 → **静默跳过**（不写 works，文件保持 work_id NULL）
- 同一 dir_path 不重复派发（记录 last_attempt，退避后重试；或永久放弃后不再派）
- 用户永远看不到"识别不出"的列表

---

## 4. 系统判定（机械，bind_work 事务内）

身份确定后：

```
① origin_lang 是中文（zh/zh-CN/zh-TW）→ 国产 → 全部文件 sub_status='ignored'，works.needs_subtitle=0
② 文件 embedded_langs 含中文 → sub_status='embedded'（内嵌中字，无需处理）
③ 其余 → sub_status='missing'（进入字幕队列）
```

判定输入全是机械事实（TMDB origin_lang + ffprobe embedded_langs），无 agent 参与。

---

## 5. 字幕 agent（LLM）

### 5.1 任务输入（一簇 = 一个 work 的全部 missing 文件）

```
作品: SPY x FAMILY (tmdb:120089)
目标语言: zh
需要字幕的文件:
  Season 01/S01E01.mkv   S1E1   时长 1440s
  Season 01/S01E02.mkv   S1E2   时长 1440s
  Season 02/S02E01.mkv   S2E1   时长 1440s
  ...
字幕写到: 各文件同目录
```

### 5.2 agent 做的事

搜索 → 下载候选 → 沙盒验证（集号/时长/简繁/编码）→ 装盘 → 更新 sub_status='covered'

**不看目录树、不判身份、不猜集号（扫描器已解析）、不需要知道字幕写哪（系统 harness）**

### 5.3 复用

现有 findSubtitleWorker 的搜索/下载/验证/装盘链路与 provider 适配器全部复用。
变化的是任务单位（按作品一簇，而非按季/按批）与数据来源（work_files 而非 episodes）。

---

## 6. 机械调度（daemon tick，无 LLM）

```
每 tick（15s）：
  ① 识别队列非空 且 无识别任务在跑 → 派一个 dir_path 的识别任务
  ② 字幕队列非空 且 无字幕任务在跑 → 派一个 work 的字幕任务
  ③ 翻译队列（unavailable 且可译）非空 → 派翻译任务（兜底）
```

并发槽各 1（识别/字幕/翻译互不阻塞——识别跑着字幕也能跑）。

**无 orchestrator agent，无 24h 心跳问题**——只要有队列非空就派活。

---

## 7. 翻译兜底

复用现有 translate 链路。字幕 agent 搜索穷尽标记 `unavailable` 后，
系统把"有非中语音轨/字幕可作源"的文件进入翻译队列，翻译 agent 逐集或逐作品翻译落盘。

---

## 8. 与现有代码的关系

| 现有组件 | 处置 |
|---|---|
| `walkVideoFiles`（selfScan.ts） | 改造：Jellyfin 约定解析 |
| `streamProbe.ts`（ffprobe） | **完全复用** |
| provider 适配器（assrt/os/subhd/tmdb） | **完全复用** |
| `findSubtitleWorker` 搜索/验证/装盘链路 | 复用核心，任务单位改为按作品 |
| `translate` 链路 | **完全复用** |
| orchestrator agent | **退役删除**（用户从未同意该架构） |
| `parked_paths` / unidentified 管线 | **退役删除** |
| realign / rescue / triage | **退役删除**（用户已确认） |
| `series`/`episodes`/`movies` 表 | 替换为 works/work_files |
| ingest.ts 识别相关 | 替换为 Jellyfin 约定扫描器 |

---

## 9. 实施阶段

| 阶段 | 内容 | 依赖 |
|---|---|---|
| 1 | 数据模型（works/work_files 建表）+ 扫描器改造（Jellyfin 约定） | — |
| 2 | 识别 agent（工作台 + bind_work） | 1 |
| 3 | 系统判定（sub_status 规则，bind_work 事务内） | 1 |
| 4 | 机械调度（替代 orchestrator） | 1,2,3 |
| 5 | 字幕 agent 按作品消费 | 1,3 |
| 6 | 翻译兜底接线 | 5 |
| 7 | 全量验收 + 部署 + live test | 全部 |

每阶段 TDD + 子代理实现 + 对抗审计。后端全绿后用户才重做前端（已确认）。

---

## 10. 验收判据

- 识别 agent 绑定一个作品根 = 一次工具调用，与文件数无关
- 海贼王 1000 集 = works 1 行 + work_files 1000 行，识别任务 1 个
- 字幕 agent 一簇消费 = 一个 work 的全部 missing 文件一次任务
- 机械调度下队列非空即派活，无 24h 心跳等待
- 不符合约定的目录静默跳过，无任何展示
- 国产片/内嵌中字自动标记 ignored/embedded，不进字幕队列
