# HANDOFF：四战役进度同步（接手账号必读）

> **对接手的 fresh Claude**：你没有前面的对话上下文。先读本文档「Part 0 交接」把状态、铁律、卡点吃进去，再决定下一步动作。**关键：当前有一个明确需要用户拍板的断点（重复源 P5 生产部署），不要自主跨过。**

---

# Part 0 · 交接（接手前必读）

## 你是谁、在哪、干什么
- 项目 **subtitle-scout**，仓在 `/Users/dirtyfancy/projects/subtitle-scout`（**不是** `subtitle-plugin`——那是旧会话 CWD 的陈旧记忆目录名，别在里面干活；subtitle-scout 的活**别用 worktree 隔离**，用非隔离子代理走绝对路径）。
- 产品定位：**agent 驱动的 Bazarr 替代品**，自托管、TMDB 识别、LLM agent 找字幕。Jellyfin 已拆为纯刮削脚手架（去 Jellyfin 化战役已完成）。
- 用户是「哥们」，中文、非正式、气势足、爱喷愿景但一旦 overwhelmed 会焦虑——你的活是**攥住方向盘、把愿景一块块焊成真、别把整座山压回他肩上**。
- 用户在此前已授权：开发期 NAS 上的媒体数据可牺牲用于测试，**辐射范围仅限媒体目录**（不碰 docker 配置、scout DB 之外的数据、Jellyfin 数据、其他容器）。生产容器可切、媒体目录内可删可折腾。

## 当前战役总账（2026-07-18，HEAD=`e150b73`）

四战役立项顺序：**债务清扫波 → 救援官 → 重复源 → 鉴权**。

| 战役 | 状态 | 收官 commit | 说明 |
|---|---|---|---|
| 债务清扫波 | ✅ 收官 | `fad7f52` | 登记册 §九，六刀全落 |
| 救援官 R1-R6 | ✅ 收官 + 真站四口径全绿 | `0ae9b44` | 登记册 §十，生产已切 schema v7 |
| 重复源 P1-P4b | ✅ 代码完成 + 已提交，**待部署** | `e150b73` | 见下「P5 卡点」 |
| 重复源 P5 | ⛔ **卡在生产部署决策** | — | 需用户拍板，非代码问题 |
| 鉴权 A1-A4 | ⏳ 未开始 | — | 用户判断过"还早"，且排在 P5 之后 |

**测试基线**：root 92 文件 / **1536 绿**、tsc 干净、web 测试也绿。每个 Task 落地即验，非收官一次性补测。

## ⛔ P5 卡点（接手后第一件要明白的事）

**重复源 P1-P4b 代码全部完成并提交，但从未部署到生产。** 生产 schema_version 仍是 `7`（救援官版本），重复源引入的 v16 迁移 + 新机械层都没上过生产。

这批代码里 `v2/subtitlePropagation.ts`（P4b）会在**副本入册瞬间自动往媒体目录写字幕文件**——这是"新写权限的机械层第一次上生产"。前任主控的判断是这类行为值得用户过一眼再推，**没有在深夜自主部署**。这个判断是否仍然成立、何时部署，是**只有用户能拍板的决定**。

P5 剩下的动作（用户批准部署后）：
1. 部署这批代码到生产（rsync 全量 → `docker compose build && up -d`，schema 7→8 迁移）
2. 部署后跑一轮真机 ingest
3. 验证 SPY×FAMILY 分体显示 + 传播生效、甄别页 duplicate 箱清零
4. （可选清理）退役 `web/src/triage/PendingBox.tsx` 的 duplicates 桶死代码——该桶已是"空则自动隐藏"，真退役是清理死代码不是功能性变更

**真机现状（前任主控 SSH 查生产库所得，部署前基线）**：生产 `parked_paths` 表有 21 条 SPY×FAMILY `duplicate-content` 停车行（P2 迁移后会自动转为 item_files 副本）。SPY×FAMILY 多集是 NanakoRaws 4K（已 covered）+ T3KASHi 1080p（停 duplicate-content）——这正是 P4b"复制优先"机械通道要补的真机主导场景。

## 先读这些（按序）
1. **记忆索引** `~/.claude/projects/-Users-dirtyfancy-projects-subtitle-scout/memory/MEMORY.md`——本账号记忆库（注意目录是 `-subtitle-scout` 不是 `-subtitle-plugin`）。核心记忆：
   - `glue-layer-campaign-progress.md`（战役进度断点，最权威的"现在到哪了"）
   - `subagent-executor-kimi-k3.md`（执行器令：实现子代理走 opencode company/kimi-k3）
   - `autonomous-overnight-mandate.md`（无人值守授权——但注意此令的边界：不为无需拍板的事叫醒用户，也不为需要拍板的事自主跨过）
   - `project-handoff-continuation.md`（2026-07-15 接手背景 + 旧记忆库指针）
2. **旧记忆库** `~/.claude/projects/-Users-dirtyfancy-projects-subtitle-plugin/memory/MEMORY.md`（更早的铁律、产品愿景、事故反省）。
3. **设计文档**（按需）：
   - 重复源 spec：`docs/design/2026-07-17-duplicate-sources-design.md`（**已补 2026-07-18 实现记录段**，讲清 P4/P4b 为何拆成两条通道）
   - 救援官 spec + 收官：`docs/design/2026-07-17-rescue-officer-design.md`、登记册 `docs/design/2026-07-16-old-world-lineage-registry.md` §十
   - 鉴权 spec：`docs/design/2026-07-17-auth-design.md`（未开始）
4. 本文 Part 1（重复源 P1-P4b 实现细节，验尸/接续时按图索骥）。

## Git 状态（交接时刻）
- 分支 `main`，HEAD `e150b73`。全部已提交，树干净（仅 `.claude/` `.omo/` 未跟踪，**不入 commit**）。
- `git log --oneline` 看 `feat(重复P*)` / `feat(救援R*)` / `docs(...)` 系列即战役脉络。

## 真站/软路由访问
- 在家：`ssh media-router`（直连 LAN，root）。在公司：`ssh media-router-tunnel`（cloudflared）。**直连不通=用户在公司，切 tunnel**。家网/隧道会抖 → 长作业一律 detached + 重试轮询。
- 部署目录 `/mnt/nvme0n1-4/docker/subtitle-scout/`，DB `/mnt/nvme0n1-4/docker/subtitle-scout/cache/scout.db`，媒体 `/media`（容器内挂载）。
- 部署流程（救援官真站用过）：rsync 全量代码到部署目录 → `docker compose build && up -d` → 看 schema 迁移日志。
- 容器名 `subtitle-scout`。别扰其他容器（jellyfin 等）。

## 铁律（违反 = 掉价）
- **实现子代理走 opencode `company/kimi-k3`**（省 Claude 配额），主控逐 diff 亲核 + 打回修复轮纪律不变。任务书自带全部上下文（K3 无跨调用记忆）。若 K3 质量不济如实向用户汇报并建议回退。详见记忆 `subagent-executor-kimi-k3.md`。
- **`src/agent/skills/` 只有人 + 主控 Claude 改，跑活的 agent/K3 无权改任何 skill**。
- **`src/v2/realignExecutor.ts` 是圣文件，禁触**（唯一例外：单字段类型加字段，先例见救援 R5e）。
- **绝不用 Workflow 工具**（用户不要它在其端冒 session）——直批 Agent 子代理或 opencode K3。
- **别停摆**：能自己做的净赚小事直接做；但**真需要用户拍板的叉子才叫他**——P5 部署就是这种叉子。
- **commit trailer**：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- **`.claude/` `.omo/` 不入 commit**。

## 方法论血泪教训（写进方法论，后续战役生效）
1. 迁移类改动务必自己写"真造旧库塞数据再升级"安全性测试（两次立功，救援 R5a/重复 P1）。
2. SQLite CHECK 约束不能 ALTER，值域扩展要走 12 步建新表重建。
3. 第三方设计系统（astryx）`defineTheme` 的 `TokenName` 是封闭枚举，需新语义色用 `color-mix` 混现有 token，不能凭空注册。
4. `rule 4b` 类"识别后分类"逻辑只对 `recognize()` 成功的文件生效，测试要用真实可识别剧名。
5. **spec 验收口径原文要逐字核对真机数据再宣称完成**——重复源 P4 若不查生产库就收尾，会漏掉验收口径原文点名的主导场景（差点把"能跑但不是验收要的那个方向"当作收官）。
6. **新写权限机械层第一次上生产**值得用户过一眼再推（P4b 教训：部署前对抗性复核发现 copyFile 会覆盖用户手放 sidecar 的数据损失隐患，已修 `e150b73`）。

---

# Part 1 · 重复源 P1-P4b 实现细节（验尸/接续用）

spec：`docs/design/2026-07-17-duplicate-sources-design.md`（含 2026-07-18 补记的实现记录段）。

**核心架构决定**：`partial` 是逐文件覆盖的**派生聚合态**，不是持久化的 sub_status 值——避免又一次 CHECK 约束 12 步重建。覆盖按"该条目每个文件各有着落"判定。

## P1 — schema v16（`5a75c70`，主控亲手）
- `item_files` 表（`id / item_id / path UNIQUE / added_at`）：副本文件一等公民。主文件仍在 `episodes.path`/`movies.path`（最早入库者=身份锚）。
- `subtitles` 加 `file_path TEXT` 列（NULL=挂主文件，兼容存量；非 NULL=挂具体副本）。
- `libraryRepo` 四方法：`addItemFile` / `listItemFiles` / `removeItemFileByPath` / `promoteOldestReplica`。
- schema_version 现 `8`（v14 extras_exemptions + v15 hardsub CHECK 重建是救援官的，v16 是重复源的）。

## P2 — ingest 副本入册 + 存量自愈（`b9ae30d`，主控亲手）
- ingest 的"撞既有身份但 path 不同"分支：不再 park `duplicate-content`，改 `addItemFile` + `clearParkedPath`（自愈存量 duplicate-content 停车行）。
- 主文件消失 → `promoteOldestReplica`（最年长副本顶替 path，字幕行 file_path 归属不动）。
- 磁盘真相移除循环：item_files 清理先于 promote-aware 的 episode/movie 移除。

## P3a/P3b — 逐文件覆盖（`e2f877e` + `b844f56` + `7b571f0`）
- `libraryRepo.itemFileCoverage(itemId)`：返回 `[{path, isMain, covered}]`，主文件看 sub_status，副本看 subtitles.file_path 是否有对应行。
- CoverageDTO 派生 + 格阵分体态（多文件条目格内小分割点）+ 详情逐文件清单。
- `7b571f0` 是主控补漏：K3 验收时漏跑 `server.test.ts` 的 `series.coverage` toEqual 涟漪（K3 反复出现的"涟漪扫描不全"模式）。

## P4 — 跨副本传播·agent 兜底方向（`c82b303`，主控亲手）
**方向：副本已有字幕 → 主文件缺口。** 主文件缺字幕时被正常派发 find_subtitle，search_source 前置注入副本现有字幕作 `provider:'local'` 候选。

- `src/core/schemas.ts`：`PROVIDERS` 加 `'local'`（第四个"provider"，**不是真实网络适配器**，adapters 里永远没有名叫 local 的 FetchAdapter）。
- `src/v2/findSubtitleWorkerTask.ts`：`buildLocalCandidates(lib, itemIds)`——对每个 partial 条目（多文件 + 有覆盖有缺口），把已覆盖文件的现有字幕转成 `provider:'local'` 候选，`providerId=encodeURIComponent(sub.path)`。
- `src/agent/resultHandles.ts`：`search_source` execute 前置注入 `localCandidates`（零成本、不经过 adapters 扇出、与查询词无关）。
- `src/agent/findSubtitleWorker.tools.ts`：`download_candidate` 的 `provider==='local'` 分支——解码 providerId 还原路径，`isUnderRoots` 复核 `mediaRoot`，`readFile` 直接读盘，走同一套 `writeSubtitle`/`inspectSubtitle` 落盘（绕开 runResolve/downloadDirect 网络路径）。`DownloadCandidateDeps` 加 `mediaRoot?`。
- `src/agent/findSubtitleWorker.ts`：`makeSearchSourceTool` 传 `localCandidates`、`makeDownloadCandidateTool` 传 `mediaRoot`。
- `src/agent/skills/findSubtitleSkill.ts`：补"Local candidates"判断段（**主控亲笔**）——本地候选与远端候选**同一套归属判断**，不是"因为是自己的"走捷径，也不是额外猜忌；同源 release 可信复制，异源仍按结构信号重新判断。

**P4 诚实标注的 scope 限制**：只做"副本已有字幕→主文件缺口"这一可达方向（main 是唯一会被 gap 查询选中派活的目标）。反方向（main 已覆盖、副本缺字幕）当时标为"超出本单范围"——**这个标注后来被真机核查推翻，催生了 P4b**。

## P4b — 跨副本传播·"复制优先"机械通道反方向（`23257ee` + `e150b73`，主控亲手，未经 K3）
**方向：主文件已覆盖 → 副本缺字幕。** 真机核查（SSH 查生产库）发现这才是验收口径原文点名的主导场景（SPY×FAMILY 多集：NanakoRaws 4K covered + T3KASHi 1080p 停 duplicate-content）。**副本从不独立成为 find_subtitle target**（没有独立 sub_status 列），agent 路径天然不可达 → 必须走机械通道。

- `src/v2/subtitlePropagation.ts`（新文件）：`propagateSubtitleToReplica(deps, itemId, mainPath, replicaPath, now)`。副本入册瞬间调用，探测主副两个视频时长（复用 `files/streamProbe.ts` 的 `probeDurationSec`，±5s 容差），够接近就直接 `copyFile` 改名装到副本身边；时长差得远或探测失败都**不猜**，原样留空（宁停不猜，不新增派活机制）。
- `src/v2/libraryRepo.ts`：`addReplicaSubtitle`（写口，`file_path` 恒指向副本自己的 path，`ON CONFLICT(item_id, path) DO NOTHING`）。
- `src/v2/ingest.ts`：两个 `addItemFile` 分支（TV + movie）后接 `propagateSubtitleToReplica`，best-effort（失败只 log 不抛）。`IngestDeps` 加 `probeDuration`。
- `src/cli/index.ts`：`buildIngestPass` 接线 `probeDuration: probeDurationSec`。
- **`e150b73` 数据损失防线**：copyFile 前加 `existsSync(destPath)` 检查——副本旁用户手放的 sidecar 不在 DB 里（副本走 addItemFile 分支不做 sidecar 探测），前置 DB 检查看不到它，没这层磁盘检查 copyFile 会覆盖掉用户那份（真实数据损失）。已存在则跳过不覆盖、不登记（宁停不猜，不猜那份磁盘文件的语言/归属）。

**幂等**：副本已有任何字幕行就短路跳过，ingest 每轮重新命中同一分支也不会重复探测/复制。

## P4 / P4b 双向关系
两条通道各管一个方向，互不依赖，谁先补齐都行：
- P4（agent 兜底）：主缺 → 抄副本（agent 用同一套归属判断）
- P4b（机械复制优先）：副本缺 → 抄主文件（时长够接近直接复制）

---

# Part 2 · 下一步行动建议

1. **等用户回来定 P5 部署**。这是唯一卡点。用户回来后明确问："重复源 P1-P4b 部署到生产，现在推还是等？"——不要自主推。
2. 用户批准后：按"部署流程"rsync+build+up，看 schema 7→8 迁移日志（应为纯 additive：CREATE TABLE item_files + ALTER TABLE subtitles ADD COLUMN file_path + CREATE INDEX，无 12 步重建，低风险），跑一轮真机 ingest，验证 SPY×FAMILY。
3. P5 验收通过后开鉴权 A1-A4（spec `docs/design/2026-07-17-auth-design.md`）。鉴权此前被判断"还早"（公开仓发布前才需要），重新评估时机也可问用户。
4. **不要在用户没明确同意时**：自主部署 P5、自主开鉴权、自主改 skill 文本清那条已知小债（救援官 Astronaut 案例 finalize-reason 退化，非正确性问题，留 skill 润色项）。

## 已知小债（非正确性，不影响收官）
- 救援官 R6 真站验收发现：Astronaut 案例 agent 中间 `keep_parked` 工具调用写了丰富理由，但最终 `finalize` 报告对同一目录的 reason 退化成机械层"ambiguous"三字。skill 只教"repeating the decisions you recorded"没强制逐字复制。功能安全性未受影响（无误认领、无死循环），留 skill 未来润色项。

---

*本文档由前任主控 Claude（Fable 5）于 2026-07-18 撰写，HEAD `e150b73`。若你接手后发现状态与本文档不符，以 `git log` + 记忆 `glue-layer-campaign-progress.md` 为准并更新本文档。*