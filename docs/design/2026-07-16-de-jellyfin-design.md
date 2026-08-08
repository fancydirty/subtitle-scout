# 去 Jellyfin 化 · 设计（2026-07-16）

状态：brainstorming 完成，用户已批（2026-07-15 深夜）。两个产品叉已拍板：
①**硬切**，不做双模式，不迁移旧 DB——"一切开发期产生的数据都可以牺牲"，状态从磁盘重建
（真状态=盘上的字幕文件，DB 只是索引）；②**随战役带最小 park 救援**，且它是**刻意一次性
脚手架**——dashboard 在工作流收干净后要专门大讨论甚至重建（用户附加条款），救援不许僭越。

## 背景与终态

用户根本不用 Jellyfin 播放（2026-07-15 修正：当年只是想借它当刮削触发器才引入，纯脚手架）。
自研巡检（B）、自研识别（C）、旧管线退役（Wave 0-3）完成后，Jellyfin 只剩四件事：库摄取+id
空间、内嵌字幕轨探测、orchestrator 两条 jf.getItem 缝、realign 的三个调用。本战役全部拿回，
终态 **Jellyfin 从依赖、环境变量、部署栈中完全消失**，NAS 上可以少跑一个容器。产品坐实
"插在任何播放器旁的字幕/库大脑"。

## 七阶段

### P1 · ffprobe 内嵌字幕探针（唯一全新能力，独立先行）
- 新模块 `src/files/streamProbe.ts`：对视频文件跑 ffprobe（`-show_streams -select_streams s`
  JSON 输出），产出内嵌字幕轨的语言标签列表（BCP-47 归一，复用 langOf/tagsForLanguage 口径）。
- 二进制解析：`ffprobe-static` npm 依赖 + `FFPROBE_PATH` env 覆盖（容器/异构平台逃生舱）。
- 探测不可用（无二进制/文件损坏/超时）→ 优雅降级：该文件视为"无内嵌轨"，只认 sidecar
  （宁多查勿漏配的既有口径）；降级发生记一行日志。
- 替代对象：scanner rule 2 现在读 Jellyfin MediaStreams（daemon/triggers.ts
  usableChineseSubtitleStreams）。泛化机会：探针天然读出任意语言轨，rule 2 的"中文专属"
  限制可顺势按 targetLanguages 泛化（内嵌目标语言轨=覆盖），语义与 A 组一致。
- 性能：探测结果按 (path, mtime, size) 记忆化存库（摄取表带列），文件不变不重探。

### P2 · 自有 id 空间（schema v9，全新库）
- 主键改自有：series/movies = `tmdb:<id>`；episodes = `tmdb:<id>/s<N>e<M>`。
  **id 即身份**——一切"拿 id 换身份"的 jf.getItem 缝从根上消失。
- 新表 `parked_paths`（path PK, park_reason, first_seen, last_attempt）：未识别文件的
  正式户口，不再混进 episodes/movies；每轮巡检重试（既有语义）；供 P6 救援页读取。
- 新表 `identify_overrides`（path_prefix PK, tmdb_id, is_tv）：P6 认领写入，识别层消歧前查。
- 沿用列语义：provider_ids（imdb 等备用）、origin_lang（TMDB getOriginLanguage 直填）、
  poster_path（新列，TMDB 图片路径，P4 用）、sub_status 域不变（per-item，per-language
  留待多语言战役）。探针记忆化列（probe_mtime/probe_size/embedded_langs）挂 episodes/movies。
- **全新库 bootstrap**：openDb 按现有版本机制直接建 v9 终态 schema；不写 v8→v9 迁移
  （用户拍板牺牲开发期数据）。旧 scout.db 留在盘上不管（或改名 .bak，实现者判）。

### P3 · 自有摄取（架构简化的主菜）
- scanner 的 Jellyfin API 读取整体替换：`FS 走盘（selfScan 的 walker）→ recognize()
 （C 层，真站验证过）→ 覆盖探测（A3 sidecar + P1 探针）→ 直写 series/episodes/movies 行`。
- TMDB 直连补元数据：识别命中时顺手拉 origin_lang、季表（层内已有 client），海报 poster_path。
- **B2 双信号坍缩成单步**：检测即摄取。refresh-bridge、awaiting-set、knownPaths 快照、
  "Episode without SeriesId" 类半成品处理全部退役；selfScanTrigger 简化为
  "识别→写行→本轮有实际变化则触发一次 orchestrate"（同 identity 去重保留）。
- 分类规则（原 classifyItemDetailed 的 rule 0-4）语义保持，数据源换自有：权威门 origin_lang
  来自 TMDB（已有缓存列）、中文启发式兜底照旧仅 zh、rule 2 换探针、rule 3 sidecar 不变。
- 删除随行：Jellyfin 播放会话轮询与播放优先级 boost（用户不用它播，语义已死）、
  v1 watcher.ts/queue.ts 遗骸、doctor 的 checkJellyfin。
- 删除/重扫语义：盘上文件消失→行退役（含 parked_paths）；字幕被删→sub_status 回 missing
  →orchestrator 正常派活（这是 P7 终极验收的机制基础）。

### P4 · 缝合切换
- `check_series_layout`：tmdbId 直接从自有 id/provider_ids 取，删 jf.getItem 解析。
- find-subtitle/realign 任务上下文构建（mediaContext/mapWorkerTaskToFindSubtitleTask）：
  全部字段改从自有库行+TMDB 取。
- dashboard：poster_tag → poster_path（TMDB image URL 前缀在前端拼或 API 拼，实现者判）；
  其余 apiV2 形状不变，web/ 改动仅海报 URL 来源。

### P5 · realign 去 JF（最谨慎块，主控逐 hunk 亲验）
- realign 对 Jellyfin 的调用走既有 port 抽象（RealignJellyfinPort 一族）：
  - getVirtualFolders（定位库）→ 读 MEDIA_ROOTS 配置映射；
  - refreshLibrary（重排后刷新）→ 踢自己的摄取 pass（P3 的 ingest 入口）；
  - 条目删除/getItem 类 → 自有库行操作。
- **只换 port 的实现与注入，restructuring/manifest/reveal/rollback 5 重安全层零触碰**；
  每个 diff hunk 由主控亲自复核并声明位置。
- realign 输出的 `[tmdbid-N]` 目录标签机制不变（识别层嵌 id 直通已消费它）。

### P6 · 最小 park 救援（一次性脚手架）
- dashboard 加：park 列表页（读 parked_paths：路径/原因/时间）+ 每行一个"贴 TMDB id 认领"
  输入框 → POST 写 identify_overrides → 下一轮巡检该路径识别命中。
- 不做：搜索、候选推荐、批量操作、样式打磨、astryx。UI 允许丑。
- 识别层：resolveToTmdb 消歧前先查 identify_overrides（前缀最长匹配）。

### P7 · 出口 + 真库终极闸门
- 代码出口：JELLYFIN_URL/JELLYFIN_API_KEY 退役（requireEnv 移除）、jellyfin.ts/types.ts
  的 PlayerServer 族按引用清算（若 realign port 仍要薄类型，收缩到最小）、README/
  .env.example/compose 文档更新。
- **真库闸门（用户明确授权，2026-07-15 深夜原话"生产库不测试那还算什么测试"）**：
  软路由真库（nas_media 全量）直接跑：①部署无 Jellyfin 栈→冷启动全库摄取（识别率/park
  清单取证）②**删光已装字幕→重扫→状态从磁盘重建→orchestrator 看见缺口→重新派活装回**
  （"状态=磁盘、DB=索引"的终极验收）③park 救援页认领一个真 park 走通。
  底线：媒体视频文件本身不删；软路由上非本项目容器不扰。OS 配额逼近上限置顶报告。
- 生产 compose 更新（去 scout-jellyfin 容器）写成步骤文档；实际切换用户醒来后自行执行或
  授权执行。

## 边界（YAGNI）
- 不做多语言 per-item×language 覆盖模型（schema 不为其重构，subtitles 表天然按语言存行已留缝）。
- 不做 TVDB/AniDB、不做模型辅助识别、不做 inotify、不做 astryx/dashboard 重建（下一战役）。
- 不做旧 DB 迁移。

## 测试策略
- 每阶段 TDD + gates（tsc/vitest）+ 逐 Task 提交；P1 探针用真样本文件（测试库有真 mkv）；
- P3 是行为等价重灾区：A 组门控（targetLanguages/originSkip/启发式）的既有测试全部要在
  新数据源下改造重锁；
- P7 真库闸门 = 战役验收，detached+监视器+取证，主控判 PASS。

## 自我审查
- 占位符：无 TBD。
- 一致性：P2 的 id 形状被 P3 写入、P4 消费、P5 port 实现引用，命名一致；P1 探针输出与
  A3 tagsForLanguage 语言口径一致；P6 覆盖表被识别层消费的时机（消歧前）唯一明确。
- 范围：单战役七阶段可逐段实现/回滚；P5 独立成块便于亲验。
