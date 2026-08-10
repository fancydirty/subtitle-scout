# 重复源战役 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。
> 执行器=K3（一单一任务+强制汇报收尾）；skill 改动（P4 的传播判断段）=主控亲笔。铁律与 trailer 同债务波计划头。spec=docs/design/2026-07-17-duplicate-sources-design.md（必读）。**排在救援官战役之后执行。**

**Goal:** 副本一等公民（item_files）+ 覆盖逐文件 + 字幕跨副本传播。

**现状坐标：** ingest duplicate-content park 点（src/v2/ingest.ts 识别撞身份分支）；subtitles 表（item_id/path/language/source）；missingBySeason/missingMovies；EpisodeCell/EpisodeDetail（web/src/library/）；search_source 结果集 store（agent/resultHandles.ts）；install_subtitle（findSubtitleWorker.tools.ts→files/subtitleWriter.ts）。

### P1: schema v15 + repo 面
Modify `src/v2/db.ts`+test（MIGRATIONS 追加：CREATE TABLE item_files 见 spec §1 + `ALTER TABLE subtitles ADD COLUMN file_path TEXT`；schema_version 断言顺延）；`src/v2/libraryRepo.ts`+test（addItemFile/listItemFiles(itemId)/removeItemFileByPath/promoteOldestReplica(itemId)——主文件消失时最年长副本 path 顶替 episodes/movies.path）。commit `feat(重复P1): v15 item_files+subtitles.file_path`。

### P2: ingest 副本入册 + 存量迁移
Modify `src/v2/ingest.ts`+test：识别撞身份→addItemFile（不再 park duplicate-content）；seenPaths 差异清理含 item_files；主文件消失→promoteOldestReplica。一次性迁移（pass 内自愈式）：现存 reason=duplicate-content 的 parked 行每轮取 10 条重识别→命中既有身份→入 item_files+退户口（同富化重试的自愈手法，无需独立迁移脚本）。测试：新副本入册/删主晋升/迁移退户口。commit `feat(重复P2): 副本入册+存量自愈迁移`。

### P3: 覆盖逐文件
Modify `src/v2/libraryRepo.ts`+test（条目覆盖聚合：全文件各有字幕（subtitles.file_path 维度）→covered；部分→partial；missingBySeason/missingMovies 行加 filesMissing）；`src/dashboard/apiV2.ts` 三层端点 onDisk 逐文件展开+coverage 带 file_path；`web/src/library/`（EpisodeCell 分体态小分割点+EpisodeDetail 每文件字幕状态清单）+测试。partial 语义色=既有黄 #e8a33d（有事实未完成，非失败）。commit `feat(重复P3): 覆盖逐文件+格阵分体态`。

### P4: 传播=普通候选判断（skill 段主控亲笔）
Modify `src/agent/resultHandles.ts`+test（search_source 结果集前置注入 local 候选：deps 加 localCandidates 供给——mapper 从该条目已有 subtitles 行构造 {provider:'local', path, releaseFingerprint=所属文件名解析}）；`src/v2/findSubtitleWorkerTask.ts`（partial 条目进任务目标，目标事实带 perFile 缺口清单+已有字幕清单）；`src/agent/findSubtitleWorker.tools.ts`（install_subtitle 支持 local 源=复制改名，走 subtitleWriter 同一落盘纪律）；findSubtitleSkill 传播判断段=**主控亲笔**（同源复制/异源重判/复制比没有强的兜底位阶）。测试：local 候选注入形状/复制安装端到端（mock 模型）。commit `feat(重复P4): 字幕跨副本传播`。

### P5: 甄别清理 + 收官
duplicate 组 UI 退役（组件+i18n 键+说明文案）；双侧全绿；真站：SPY×FAMILY 4K/1080p 验收 spec 口径三条；orchestrator B-matrix 回归（partial 派发不误触发 realign）；R2 对抗复审一轮+登记册落册。

## 自审
spec §1-§5 对应 P1-P5；file_path NULL=主文件兼容语义贯穿 P1/P3/P4；promoteOldestReplica 命名 P1/P2 一致；无 TBD。
