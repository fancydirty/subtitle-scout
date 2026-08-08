# 新架构实现计划

**方案**: `docs/design/2026-08-08-new-architecture-design.md`
**规格补齐**: `docs/design/2026-08-08-new-architecture-spec-gap.md`
**状态**: 待执行

---

## 阶段划分

按依赖顺序分 5 步，每步 TDD + 完成后子代理对抗审计。

### 阶段 0：schema 迁移

**目标**：新表（files/works）与旧表（episodes/movies/subtitles）共存。

- 新建 `files` 表（含规格补齐的 attempt/next_retry_at/last_error/work_dir/parse_confidence 列）
- 新建 `works` 表
- `media_roots` 加 `content_type` 列（默认 'mixed'）
- 不动旧表（迁移嫁接在阶段 4）

**验收**：`tsc` 0 错；schema 版本链正常；旧数据完好。

### 阶段 1：机械扫描器

**目标**：遍历守备目录 → files 表（原始事实 + 结构解析 + confidence）。

- 复用 `walkVideoFiles`（遍历）+ `streamProbe`（ffprobe）
- 新写：路径结构解析（work_dir 推导 + season/episode 提取 + parse_confidence 判定）
- 跳过规则：非媒体（扩展名/大小/系统目录）
- 增量更新：指纹 mtime+size 跳过重探
- 复用三层防线（消失去抖、骤降哨兵）

**验收**：对 nas_media 和 115 测试目录（rclone 挂载后）扫描正确；
`parse_confidence` 与实测一致（Constellation→high、Moozzi2→low、Erai-raws→none）。

### 阶段 2：识别 Agent

**目标**：work_dir → TMDB 身份 + 批量绑定（60 一包，身份只确认一次）。

- 新写识别 agent（替代旧 orchestrator + unidentified 那套）：
  - 输入：一个 work_dir + 它的文件列表（含 confidence）
  - 工具：search_tmdb / get_tmdb_details / write_identified_media（批量，上限 60）
  - 输出：works 行 + files.work_id 批量更新 + 双轨退避 + 404 终态
- 分包：60 一包；身份确认后跨包复用（prompt 带"已确认"上下文）

**验收**：Mediary Scout 83 个作品全部识别、TMDB 核验通过、confidence 触发规则正确。

### 阶段 3：机械调度 + 自动判定

**目标**：纯 SQL 调度 + 需字幕判定。

- 识别队列：`SELECT DISTINCT work_dir FROM files WHERE work_id IS NULL AND (退避窗已过) AND (非404终态) ORDER BY MIN(attempt), MIN(id)`
- 字幕队列：`SELECT * FROM files WHERE needs_subtitle=1 GROUP BY work_id`
- 自动判定：origin_lang ∈ 目标语言 → 跳过；embedded_langs 含目标 → 跳过；sidecar 存在 → 跳过；否则 needs_subtitle=1
- 失败退避：瞬时 30s→15min→24h；404 终态；agent 拒识 1h→4h→24h

**验收**：调度正确性（无 orchestrator agent、无节流）；判定与实测一致。

### 阶段 4：字幕 Agent 接线 + 迁移

**目标**：字幕 agent 按作品一簇消费 + 旧数据嫁接。

- 字幕 agent：复用现有 findSubtitleWorker 的搜索→验证→装盘，改造输入为"一簇"（一个作品的全部缺字幕文件）
- 迁移：新表已从磁盘重建；旧表结论（covered/unavailable + provider_ref）嫁接到新表
- 旧表冻结

**验收**：字幕链路端到端（本地可写目录）；迁移后 52 条字幕来源追踪保留。

### 阶段 5：测试 + 清理

**目标**：115 只读测识别链路，本地可写测字幕链路；删旧死代码。

- 测试：Mediary Scout 83 作品识别全通；本地可写集字幕全通
- 清理：删 orchestrator agent / unidentified 那套 / workUnit 分组逻辑（workRootOf 保留改造）

---

## 自审记录

**自审 1：为什么要跟旧表共存而不是直接替换？**
字幕来源追踪（provider_ref）和穷尽结论（unavailable+recheck_after）无法从磁盘重建。
直接替换 = 丢数据。共存 + 嫁接最稳。

**自审 2：阶段 1 的 work_dir 推导复用 workRootOf 但改造成入库时算好。**
这是从"查询时推导"到"入库时物化"的变化——查询快，但要处理增量更新时 work_dir 变化
（用户把文件挪到别的目录）。用指纹变化检测：mtime/size 变了就重算 work_dir。

**自审 3：分包 60 一包会不会让"身份确认后跨包复用"的状态丢失？**
works 表是状态机（项目铁律）：第一包写入 works 行，后续包的 prompt 从库读。
不依赖内存状态，agent 死了重启也能续。

**自审 4：识别串行会不会太慢？**
83 个作品 × 每作品几秒 = 几分钟。可接受。识别之间无共享状态，串行最稳
（TMDB 配额敏感）。将来要并行再放开。

**自审 5：115 测试的 rclone 挂载需要软路由装 rclone。**
软路由是 OpenWrt，opkg 有 rclone 包。或者用容器跑 rclone（linuxserver/rclone 镜像）。
选容器方案——不污染宿主机，compose 里加一个 rclone 服务 + FUSE 挂载。
需要验证容器 FUSE 是否可用（`/dev/fuse` 是否透传）。

**自审 6：阶段 4 的字幕 agent"一簇"输入改造。**
现有 findSubtitleWorker 一次处理一个 task（含多个 target）。改造方向：
新调度器把"一个作品的全部 needs_subtitle 文件"组装成一个 task 喂给它。
这是最顺的——现有 worker 已经支持多 target 批量。

---

## 风险

| 风险 | 缓解 |
|---|---|
| rclone FUSE 在软路由不可用 | 自审 5 验证；不可用则改走 OpenList API（写专门的 WebDAV walker，较慢） |
| 新表与旧表并发写入冲突 | 阶段 0 起旧表只读（迁移前），新表独占写入 |
| 迁移嫁接出错丢字幕来源 | 迁移前全量备份；迁移后对比 provider_ref 数量 |
| 识别 agent 分包状态丢失 | 自审 3：works 表是状态机，不依赖内存 |

---

## 验收门（最终）

| 门 | 判据 |
|---|---|
| 类型 | 根 + web tsc 0 错 |
| 测试 | 全部新测试绿；旧测试按需删除/改造后绿 |
| Mediary Scout | 83 作品全部识别、TMDB 核验通过、needs_subtitle 判定正确 |
| 字幕链路 | 本地可写目录端到端：字幕落盘 + sub_status 更新 |
| 迁移 | 52 条字幕来源追踪保留 |
| 调度 | 无 orchestrator agent、无 UNIT_LIMIT/MAX_TARGETS 节流 |
