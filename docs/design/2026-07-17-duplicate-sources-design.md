# 重复源战役 · Spec（2026-07-17）

出处：登记册 §9 定稿段（2026-07-16 傍晚与用户讨论定稿：照抄 Jellyfin 版本分组的形、Sonarr 式绝不动文件、
奥本海默 4K/1080p 案例=已获字幕复制不重搜、用户关键洞察"传播=普通候选判断，全系统本无'轴已验证'"）。
真机现状：甄别页 110 条停车的大头是 duplicate-content（SPY×FAMILY/Nukitashi 多分辨率副本）。

## 目标

同一条目的多个视频文件（4K/1080p/不同压制）从"后来者停车"升级为一等公民：条目=文件集合，
覆盖=逐文件，字幕跨副本传播（复制优先，agent 兜底），甄别页 duplicate 箱清零。

## 1. schema v14：item_files 表

```sql
CREATE TABLE item_files (
  id INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL,          -- episodes.id / movies.id（该条目的主文件行）
  path TEXT NOT NULL UNIQUE,      -- 副本文件绝对路径
  added_at INTEGER NOT NULL
);
```
主文件仍在 episodes/movies.path（最早入库者，身份锚）；副本进 item_files。字幕账（subtitles）
加 `file_path TEXT`（NULL=挂主文件，兼容存量）——覆盖判定按"该条目每个文件各有着落"。

## 2. ingest 改造：副本不再停车

识别结果与既有条目同 (series,season,episode)/movie 身份但 path 不同 → 写 item_files（不再 park
duplicate-content）；存量 duplicate-content 停车行迁移：一次性 pass 重识别入 item_files 并退户口。
删文件时 item_files 行随 seenPaths 差异清理；主文件消失→最年长副本晋升主文件（path 顶替，
字幕行 file_path 归属不动）。

## 3. 覆盖语义逐文件

- `sub_status` 升维：条目级状态=聚合（全部文件 covered→covered；部分→新态 `partial`；主文件
  covered 副本缺→partial）。missingBySeason/活文档行携带 `filesMissing` 计数（机械事实）。
- 格阵 EpisodeCell：多文件条目显示分体态（格内小分割点，DESIGN.md 语义色沿用）；详情板列出
  每文件+各自字幕状态。

## 4. 传播=普通候选判断（用户洞察原文落实）

orchestrator 派 find_subtitle 时目标含 partial 条目；worker 的 search_source 结果集**前置注入
本地候选**：该条目已有字幕文件作为 `provider:'local'` 候选（零成本、指纹=其所属文件的 release
解析）。skill 教（主控亲笔）：本地候选与远端候选**同一套归属判断**——同源 release（同组名/同
分辨率族）→复制改名即装（install_subtitle 支持 local 源=文件复制）；异源→按目标文件 release
重新判断，"复制比没有强"仅在无更优候选时成立。无特殊"心虚状态"，与正常安装同一诚实度。

## 5. 甄别页

duplicate 组随迁移消失；组头说明文案退役。留位注释清理。

## 非目标

音频对轴验证（ffsubsync 式——另一物种，不排期）；转码/文件合并；跨条目去重。

## 验收口径

真机 SPY×FAMILY 4K+1080p：迁移后两文件同条目分体显示；已有字幕的条目触发传播后副本获得
复制字幕（同源）或 agent 判断记录（异源）；甄别页 duplicate 箱清零。

## 实现记录（2026-07-18 补记）

P1-P3b 已实现+提交（item_files 表、ingest 副本入册自愈迁移、itemFileCoverage 逐文件覆盖 DTO）。

P4 落地时发现"传播"天然是两个独立方向，agent 路径只够单向：
- **副本已有字幕 → 主文件缺口**（agent 兜底，已提交）：主文件缺字幕时被正常派发
  find_subtitle，search_source 前置注入副本现有字幕作 `provider:'local'` 候选，skill 教
  agent 用同一套归属判断处理（`agent/findSubtitleWorker.tools.ts` 的 `provider==='local'`
  分支 + `findSubtitleSkill.ts` 的"Local candidates"判断段）。
- **主文件已覆盖 → 副本缺字幕**（复制优先机械通道，已提交）：副本从不独立成为
  find_subtitle 的派活目标（没有独立 sub_status 列），agent 路径天然不可达。真机核查
  （SPY×FAMILY 多集：NanakoRaws 4K 已 covered，T3KASHi 1080p 停在 duplicate-content 停车
  场）证实这个方向才是验收口径原文点名的真机主导场景。改为纯机械通道：`v2/subtitlePropagation.ts`，
  副本入册瞬间（ingest.ts 的 addItemFile 两处分支）探测主副两个视频时长，够接近（±5s
  容差）直接复制改名装上；时长差得远或探测失败都不猜，原样留空——不新增判断，宁停不猜。

两条通道各管一个方向，互不依赖。至此"传播"双向都有落地路径。

**仍未做（P5，卡在生产部署）**：甄别页 duplicate 箱清零 + 真机 SPY×FAMILY 验收。生产
schema_version 仍是 7（P1-P4b 引入的 v16 迁移 + 新机械层从未部署过）——这批代码会在副本
入册瞬间自动往媒体目录写字幕文件，是一类新的自动化行为，主控选择不在深夜未经人过一眼的
情况下直接推生产。部署本身 + 部署后的真机验收是 P5 唯一剩下的动作，非代码问题。

