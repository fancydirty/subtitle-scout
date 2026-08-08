# 新架构规格补齐（对抗审计后）

**日期**: 2026-08-08
**前置**: `docs/design/2026-08-08-new-architecture-design.md`（被对抗审计找出 3 BLOCKER + 7 MAJOR）
**本文**: 针对审计结论逐条补齐规格，不推翻主设计

---

## 0. 审计结论速览

架构主脊正确（机械扫描 → DB 传送带 → 双 agent，纯机械调度）。3 个 BLOCKER + 7 个 MAJOR
全部是**规格缺口**而非架构错误。本文逐条补规格。

---

## B1. 静默跳过判据（与 agent 修正不冲突）

### 问题

"文件名无法解析出任何结构"不可操作——`parseFilename` 对任何文件名都至少产出一个 title
（哈希名 `ba75e9c2c1d8.mkv` → title="ba75e9c2c1d8"）。且 `[Erai-raws] Spy x Family Season 3 - 09`
实测**全 null**，正是设计 §3.4 说要交给 agent 修的形态——跳过判据若按"全 null"就会误杀。

### 规格

**不按"能否解析"跳过，按"文件是否真的像媒体"跳过**。可操作的判据（层层递进）：

```
1. 扩展名不在媒体白名单（mkv/mp4/avi/ts/m2ts/wmv/flv/webm）→ 跳过（非媒体）
2. 文件小于阈值（如 < 10MB，视频不可能这么小）→ 跳过（疑似垃圾/探针残留）
3. 文件在系统/隐藏目录（.subtitle-staging、.thumbnails、@eaDir 等）→ 跳过
4. 以上都不命中 → **入库**（不管 parseFilename 解析出什么）
```

**关键变化**：只要文件是媒体扩展名 + 大小正常 + 不在系统目录，就**入库**。
`parseFilename` 解析不出季集号不是跳过理由——那是"season/episode 为 NULL"，等 agent 处理。
真正的"静默跳过"只针对**非媒体**（扩展名不对/太小/系统目录），这些是确定性的垃圾，
agent 不该碰，用户也不该看到。

这样 B1 解决：跳过判据可操作（全是硬规则），且不与 §3.4 的 agent 修正冲突
（解析不出的进识别队列，agent 修）。

---

## B2. 失败退避与终态

### 问题

schema 无 attempt/next_retry 列，队列 SQL 无退避过滤 → 识别失败无限重试烧钱。
TMDB 404（作品真不存在）无终态。

### 规格

**files 表加三列**（§3.1 schema 补充）：

```sql
attempt INTEGER NOT NULL DEFAULT 0,      -- 识别尝试次数
next_retry_at INTEGER,                   -- 下次可重试时刻；NULL=立即
last_error TEXT,                         -- 最近失败原因（'tmdb-404' / 'timeout' / ...）
```

**双轨退避**（复用 jobsRepo 的既有思想，搬到 files 表）：

| 失败类型 | 判据 | 退避 | 终态 |
|---|---|---|---|
| TMDB 404 | `get_tmdb_details` 返回 null | **永久停**（`next_retry_at` 永为 NULL，但 `attempt` 记 1） | 终态：`last_error='tmdb-404'`，不再入队 |
| 瞬时错误 | timeout / 网络 / 5xx | 30s → 15min → 24h | 无终态，一直退避重试 |
| agent 拒识 | agent 明确报"无法识别" | 1h → 4h → 24h | 无终态，慢速重试 |

**队列 SQL 加过滤**：

```sql
-- 识别队列：只挑"该试的"（从没试过，或退避窗已过，且不是 404 终态）
SELECT DISTINCT dir FROM files
WHERE work_id IS NULL
  AND (next_retry_at IS NULL OR next_retry_at <= :now)
  AND (last_error IS NULL OR last_error != 'tmdb-404')
ORDER BY MIN(attempt), MIN(id)   -- 没试过的先，老的先
```

**404 终态的意义**：作品真的不在 TMDB（如 `惊蛰无声` 这种未收录片），
agent 确认后写 `last_error='tmdb-404'`，系统永不重试——不烧钱也不卡队列。

---

## B3. 分包算法（海贼王 1000 集）

### 问题

"分包打包"被引用但从未规格化。1000 文件输入勉强装下、**输出必然截断/编造**
（384 编造事故的教训）。

### 规格

**分包规则**：

```
一个作品目录（work dir）下的文件按 60 个一包切分。
同一作品的身份确认**只做一次**（第一包），后续包复用（agent 不再 search_tmdb）。
```

**第一包**：agent 做完整识别（search_tmdb → get_tmdb_details → 双证据核验）→ 确认身份。
**后续包**：agent 拿到"这个目录已确认为 tmdb:<id>"的上下文，直接批量绑定季集号，
**不再搜索**。

**write_identified_media 的 files 数组上限 = 60**。海贼王 1000 集 = 17 包，
身份确认 1 次 + 16 次纯绑定，每次 60 行 JSON。

**为什么 60**：这是 2026-07-28 事故后定的实测安全值（`findSubtitleWorker.ts:426` stepCap 相关），
一个 agent 调用塞 60 个文件映射是安全的；1000 行 JSON 输出必炸（384 事故）。

**跨包状态传递**：`works` 表已有该作品的行（第一包写入）→ 后续包的 prompt 里带
"已确认身份"上下文 + 库中该作品的行 → agent 直接绑定。

---

## M1. 作品粒度 SQL（Season XX 子目录问题）

### 问题

`SELECT DISTINCT dir FROM files WHERE work_id IS NULL` 对 `TV/Constellation/Season 1/` 选出的是
**季目录**，不是作品根。三季剧 = 3 次识别调用，重复搜索。

### 规格

**复用 `workRootOf` 的思想**（设计 §8.1 说要删它——**不删，改造保留**）：

扫描器入库时**额外计算 `work_dir` 列**：

```sql
work_dir TEXT,   -- 作品根目录（从路径上爬，跳过分类桶/季目录，见 workRootOf 逻辑）
```

- `TV/Constellation/Season 1/E01.mkv` → work_dir = `TV/Constellation`
- `Movies/Pulp Fiction (1994)/movie.mkv` → work_dir = `Movies/Pulp Fiction (1994)`
- `Movies/loose.movie.mkv`（扁平）→ work_dir = `Movies`（该根下所有扁平文件同 work_dir）

**识别队列改为**：

```sql
SELECT DISTINCT work_dir FROM files WHERE work_id IS NULL AND ...
```

作品粒度正确：一部剧一个 work_dir，一次识别调用。

**workRootOf 的改造**：现有实现（`workUnit.ts:94-134`）已处理"跳过分类桶 + 季目录"，
保留其逻辑，从"返回路径"改为"入库时算好存 work_dir 列"。

---

## M2. media_type 来源

### 问题

模型里没有"库类型"。`media_roots.type` 是存储协议（'local'），不是内容类型。
`search_tmdb(query, media_type)` 需要类型，而 SPY x FAMILY 在 TMDB 同时有电影和剧。

### 规格

**给守备目录加 `content_type` 配置**（照 Jellyfin 的库定义）：

```sql
-- media_roots 表加列（或独立表）
content_type TEXT,   -- 'movies' / 'tv' / 'mixed'；NULL=未知
```

- 配置在 dashboard 的设置页（用户加守备目录时选类型）
- `movies` → work_dir 下的文件按电影识别（search_tmdb type=movie）
- `tv` → 按剧识别（type=tv）
- `mixed`（如 Anime 目录混合电影+剧）→ **让 agent 判断**：
  prompt 里给 `media_type: 'unknown'`，agent 根据文件结构（有没有季目录/多文件）自己定，
  search_tmdb 时先试一种类型，不行换另一种

**默认值**：新加守备目录时 content_type 默认 'mixed'（保守，agent 判断），
用户可在设置页改成明确的 movies/tv。

---

## M3. 115 测试目录可达性

### 问题

现有 `walkVideoFiles`（readdirSync/statSync）和 `probeEmbeddedSubtitles`（execFile ffprobe）
都是**本地路径**，无 URL/认证模式。115 以 OpenList WebDAV 暴露，现有代码不可扫。

### 规格

**用 rclone WebDAV FUSE 挂载**进 scout 容器：

1. 软路由装 rclone（或直接容器内跑 `rclone mount`）
2. 配置 remote：`openlist115`（type=webdav, url=http://192.168.100.1:5244/dav/115, 
   user=admin, pass=...）
3. 挂载到宿主机某目录（如 `/mnt/nvme0n1-4/115-test/`），再 bind 进 scout 容器
   （compose 加 volume）
4. scout 容器里它就是本地路径 → 现有 walker/probe 全可用

**为什么 FUSE 而非直接 WebDAV walker**：ffprobe 需要本地路径（要 seek、要读容器头）。
rclone FUSE 把 WebDAV 变成本地文件系统，ffprobe 不用改。

**权限**：115 测试目录**只读挂载**（rclone 配置 `read_only = true`）——
符合用户"只读测试"的裁决。测试只验证扫描+识别+判定，不验证字幕写入（M4 见下）。

---

## M4. 只读测试目录 + 字幕链路测试缺口

### 问题

115 只读 → 字幕写必失败。测试计划只测扫描+识别+判定，字幕链路无测试。

### 规格

**测试分两层**：

**层 1（115 只读）**：验证扫描 + 识别 + 需字幕判定。
- 83 个作品全部识别、TMDB 身份核验通过、needs_subtitle 判定正确
- 字幕 agent **不派发**（或派发了但预期失败）——115 是只读的，写不进去是预期行为
- 验收判据：识别链路全通，`needs_subtitle=1` 行正确产生

**层 2（本地可写目录）**：验证字幕链路。
- 在 nas_media 或临时目录里建一个小的可写测试集（如 3-5 部作品的副本）
- 完整跑：扫描 → 识别 → 判定 → 字幕 agent → 落盘 → sub_status 更新
- 验收判据：字幕真的写进磁盘 + 库状态正确

**115 在生产守备目录里的定位**：**不加入**生产守备目录（裁决 #11 说它是测试目录）。
生产只扫 nas_media。115 测试时临时加根，测完移除。

---

## M5. "机械解析错/缺时 agent 补"的触发条件

### 问题

agent 怎么知道"解析错了"而不是"没解析"？两者输入形状相同。
且 `S2 - 07` 实测 `absoluteEpisode=7`（季丢失）——files 表没有 absoluteEpisode 列，
会存成什么？

### 规格

**给 files 表加 `parse_confidence` 列**，把机械解析的可信度显式化：

```sql
parse_confidence TEXT,   -- 'high' / 'low' / 'none'
```

判定规则（扫描器落库时算）：

| parseFilename 结果 | confidence | 说明 |
|---|---|---|
| season + episode 都有（标准 SxxEyy） | high | 可信 |
| 只有 absoluteEpisode（如 `S2 - 07` → abs=7） | low | 季号可能丢（`S2` 被吞进 title） |
| 全 null（如 `Season 3 - 09`） | none | 完全没解析出 |
| 哈希名（title 无字母空间分隔等） | none | 疑似垃圾 |

🔴 **实测核验补充（2026-08-08 亲测）**：`Pulp.Fiction.1994...mkv`（合法电影）与
`ba75e9c2c1d8.mkv`（哈希垃圾）都判为 `none`。这不是设计错误——`confidence` 只表示
**季集号解析的可信度**，电影本来就没有季集号（season/episode 恒为 NULL）。
区分电影 vs 垃圾靠 `media_type`（M2 的 content_type 配置）：
- `media_type='movie'` + `confidence='none'` → 正常（电影没有季集号）
- `media_type='tv'` + `confidence='none'` → agent 必须从文件名+目录推断季集号
- agent 的 prompt 里必须同时给 `media_type` 与 `confidence`，否则无法区分

**agent 的触发规则**（写入 prompt）：
- `high` → 沿用机械值，agent 只需核验
- `low` → **agent 必须重推季集号**（abs 推导不可信，季可能丢了）
- `none` + `media_type='tv'` → agent 从文件名+目录结构推断季集号，推断不出就报"无法识别"
- `none` + `media_type='movie'` → 正常（电影），agent 只需核验身份

这样"错/缺"被显式编码成 confidence，agent 有明确触发条件。

**absoluteEpisode 处理**：扫描器把 abs 推导**不直接存 season/episode**（因为季可能错），
而是存 `parse_confidence='low'` + 结构提示里带 abs 值（供 agent 参考）。season/episode
列为 NULL，等 agent 定。

---

## M6. 迁移方案

### 问题

生产库现状：series=4、episodes=101、movies=2、subtitles=52、parked=389。
设计 §8 只列代码删除，没提旧表去留。

### 规格

**旧表保留不删，新表并行**。理由：

- `subtitles.provider_ref`（来源证据）无法从磁盘重建
- `sub_status='unavailable'`（搜索穷尽结论 + recheck_after）无法重建
- 重建 = 把 52 条字幕的来源追踪和已穷尽的搜索结论抹掉

**迁移步骤**：

1. 新 schema 建新表（files/works/...），与旧表（episodes/movies/subtitles）**共存**
2. 扫描器跑一轮，files 表从磁盘重建（纯机械，不依赖旧数据）
3. 识别 agent 跑一轮，works 表填充
4. 判定跑一轮，needs_subtitle 填充
5. **旧表数据迁移到新表**：
   - 已 covered 的字幕：从旧 subtitles 表读 provider_ref，映射到新文件行的 sub_status='covered'
   - 已 unavailable 的：映射 sub_status='unavailable' + recheck_after
   - 未识别的 parked：映射到 files（work_id=NULL，等识别）
6. 迁移完成后旧表冻结（不再写入），前端切到新表
7. 确认稳定后旧表 DROP（或保留一个版本）

**关键**：迁移不是重建，是"新表从磁盘重建 + 旧表结论嫁接到新表"。字幕来源追踪和
穷尽结论都不丢。

---

## M7. nas_media 测试预期修正

### 问题

设计 §9.2 说"验证 SPY x FAMILY 乱布局被静默跳过"——但 §1 取证显示它是**混合态**：
S03E01 刮削正确、S2-07 进 agent、Season 3-09 全 null。测试预期写反了。

### 规格

**nas_media 测试预期改为**（与 §1 取证一致）：

```
SPY x FAMILY：
  - SPY.x.FAMILY.S03E01...  → 入库，parse_confidence=high，agent 沿用
  - [Moozzi2] Spy x Family S2 - 07...  → 入库，confidence=low，agent 重推季集号
  - [Erai-raws] Spy x Family Season 3 - 09...  → 入库，confidence=none，agent 推断
  - （整目录不是一个状态，是三个文件三种状态）
```

**静默跳过只对非媒体**（扩展名不对/太小/系统目录）——不是对"解析不出"。

---

## 补充规格

### MINOR-1：队列选择策略

```sql
ORDER BY MIN(attempt), MIN(id)   -- 没试过的先，老的先（公平，不饿死小目录）
```

### MINOR-2：并发

**识别串行**（一次一个 work_dir）——TMDB 配额敏感，且识别之间无共享状态，串行最稳。
**字幕按作品串行**（一次一个作品的一簇）——字幕源配额（ASSRT 5/min）敏感，串行最稳。
识别与字幕**可并行**（一个识别一个字幕同时跑，不同资源池）。

### MINOR-3：write_identified_media 原子性

```
同一事务内：
  INSERT OR REPLACE works（身份）
  UPDATE files SET work_id, season, episode, parse_confidence='confirmed', 
        attempt=0, next_retry_at=NULL, last_error=NULL WHERE path IN (...)
```

部分识别（dir 里 8 个已识别 + 4 个新增）：agent 对 8 个调 write，4 个留 NULL 等下一轮。
工具入参是**文件名数组**（不是整目录），agent 自己挑哪些文件已确认。

---

## 审计后设计变更清单

| 变更 | 文件/模块 |
|---|---|
| files 表加 attempt / next_retry_at / last_error / work_dir / parse_confidence 列 | schema |
| media_roots 加 content_type 列 + dashboard 配置 | schema + 设置页 |
| 跳过判据改为"非媒体才跳"（扩展名/大小/系统目录） | 扫描器 |
| 双轨退避 + 404 终态 | 调度器 |
| 分包：60 一包，身份只确认一次，后续包复用 | 识别 agent 工具 |
| workRootOf 保留改造 → work_dir 列 | 扫描器 |
| 迁移：新表并行，旧表结论嫁接，稳定后冻结 | 迁移脚本 |
| 测试分层：115 只读测识别链路，本地可写测字幕链路 | 测试计划 |
