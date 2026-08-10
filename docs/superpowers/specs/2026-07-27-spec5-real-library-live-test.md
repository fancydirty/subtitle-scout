# Spec 5：A 线 —— 真库 live test（集成验证）

**日期**：2026-07-27
**状态**：待用户批准
**范围**：在真实软路由环境上验证 agent-first 识别管线端到端可用。**这是集成验证，不是识别能力测试**（后者是 Spec 6）。
**索引**：见 `docs/superpowers/specs/2026-07-27-INDEX.md`

## 1. 目的与定位（先把它和 Spec 6 分清）

用户要"是骡子是马拉出来溜溜"。但**真库测不出识别能力**，原因：真库是规范命名的（`American Horror Story`、`Invasion (2021)`、`Constellation`），agent 一眼就过。删字幕重跑会得到一个漂亮的全绿，而**关于 vague 命名的最小必要条件一无所知**。

所以两件事分开：

| | Spec 5（A 线） | Spec 6（B 线） |
|---|---|---|
| 测什么 | **管线**能不能跑通 | **识别能力**的边界在哪 |
| 环境 | 真软路由、真挂载、真 TMDB、真库 | eve 实验台、构造数据 |
| 变量 | 全真实（CIFS 抖动、云盘延迟、迁移、并发） | 严格控制（逐维度削减证据） |
| 失败意味着 | 有 bug 要修 | 找到了能力分界线（是产出，不是失败） |

真库要验的是这些**只有真实环境才暴露**的东西：schema 16→25 迁移、CIFS 抖动、云盘 12s 探针、1185 文件的扫描耗时、parked→识别→写库→找字幕的完整链路、orchestrator 的派发逻辑。

## 2. 前置依赖

| 依赖 | 来自 | 是否阻塞 |
|---|---|---|
| 最新代码部署到软路由 | 本 spec | — |
| schema 16→25 迁移 | 自动（`openDb` 迁移链） | 阻塞：必须先备份 |
| 云盘挂载 + compose 卷 | **Spec 1** | 阻塞云盘部分；NAS 部分不阻塞 |
| park 原因二分 | Spec 2 | **不阻塞**。没有它也能跑，只是认不出的文件会反复重试 |
| 认领点 UI | Spec 3 | 不阻塞 |
| `[tmdbid-N]` 通道 | Spec 4 | 不阻塞（真库现有 0 个带标签的目录，实测确认） |

**所以 A 线可以在 Spec 1 之后立即开跑，不必等 2/3/4。** 但若 Spec 2 未完成，跑全量时要预期"认不出的文件反复烧 token"。

## 3. 环境实况（已实测）

| 项 | 值 |
|---|---|
| 宿主 | iStoreOS/OpenWrt 24.10.4，kernel 6.6.110，busybox（无 `apk`/`timeout`） |
| 库位置 | `/mnt/nvme0n1-4/docker/subtitle-scout/cache/scout.db` |
| 当前 schema | **16**（代码为 25，待迁移） |
| 当前库行 | series 28 / episodes 442 / movies 9 / parked 1 / subtitles 272 / tmdb_seasons 925 / identify_overrides 4 |
| 已备份 | `cache/backups/scout.db.pre-agent-first-20260727-205530` |
| NAS 挂载 | CIFS `//192.168.100.241/share` → `/mnt/nvme0n1-4/nas_media`，探针 1.09s |
| NAS 内容 | TV 27 目录 / Movies 10 / anime 4，共 **1185 视频**，**1893 外挂字幕** |
| 云盘测试数据 | `/mnt/aliyun-ftp/subtitle-scout-test`：Anime/Movie/TV，**27 视频**，27 字幕（**26 个在 `.archive/` 内**，正常位置仅 1 个） |
| 云盘探针 | 12-16s/文件（见 Spec 1） |
| 模型 | `LLM_MODEL=mimo-v2.5`（弱模型，用户钦定） |
| compose | **软路由持有，`deploy.sh` 明确保护不覆盖**（`--filter='protect /docker-compose.yml'`） |

云盘测试数据正是我 eval 案例的真实原型：`莉可丽丝 蓝光原盘REMUX`、`H）后丨室（2026）`、`招z魂z4 (2025)`、`招魂 4K原盘REMUX...-V2`、`铁拳教育 (2026)`。

## 4. 分阶段执行

### 4.1 阶段一：最小闭环（用户已批准范围）

- **范围**：NAS `anime` 4 目录（46 视频）+ 云盘测试目录（27 视频）= **73 视频**
- **删字幕**：NAS anime 25 个 + 云盘正常位置 1 个。**`.archive/` 内 26 个保留**（用户裁决：留作对照——可比对 agent 选的字幕与历史归档是否同一份）
- **清库行**：只清这 73 个路径对应的行。`TV`/`Movies` 的 28 剧 9 影**不动**
- **覆盖**：CIFS + 云盘两种挂载；全部 5 个真实污染命名
- **预期耗时**：探针 46×1.09s + 27×~13s（并发后更短）；识别按目录批量，约 10-20 轮 agent

### 4.2 阶段二：全量（用户说"我要休息时再跟你说"）

- **范围**：全部 1185 视频 + 1893 字幕
- **时机**：用户明示休息时启动，烧一晚，次日验收
- **必须先完成阶段一并修完暴露的 bug**——不要把已知 bug 带进通宵跑
- **强烈建议先完成 Spec 2**：否则认不出的文件会整夜反复重试烧 token
- 预期：token 消耗大（用户已明示不担心：mimo-v2.5 便宜且是会员额度）

## 5. 触发方式

链路已接通（实测确认）：

```
orchestrator agent 的 dispatch_unidentified_identification 工具
  → jobs 表写一行 { taskType: 'find_subtitle', scope: 'unidentified' }
  → daemon 的 handleWorkerTask 认领
  → makeUnidentifiedFindSubtitleWorker + runUnidentifiedFindSubtitleWorkerTask
  → parked_paths → raw evidence targets → agent 识别 → write_identified_media → 找字幕
```

（`orchestratorAgent.tools.ts:328`、`cli/index.ts:415-440`）

所以 A 线不需要新的入口代码，走正常的巡检 + orchestrator 派发即可。

## 6. 观测与判据

### 6.1 必须采集的证据

- 每轮 run 的 trace（`runs` 表 + traceBus）
- 识别结论：tmdbId / season / episode / 两条证据文本
- `write_identified_media` 调用记录（是否真写库）
- 库行落地情况（series/episodes/movies 行 + own-id 形状）
- parked_paths 残留（谁没被识别、park 原因）
- 字幕安装结果（installed / no_safe_match / retry_later 三桶）
- 耗时分解：扫描 / 探针 / 识别 / 找字幕
- 异常日志：CIFS errno、TMDB 失败、模型 schema 拒绝

### 6.2 验收标准

**管线正确性（硬门）**

1. schema 16→25 迁移成功，无外键违例，`meta.schema_version = 25`
2. 73 个视频全部被扫到并 park（`parked_paths` 有 73 行，raw 数据齐全）
3. 云盘文件的 `duration_sec` **非空且正确**（莉可丽丝应 ~1442s）——这条验证"云盘等同物理 NAS"的地基
4. agent 识别的 tmdbId **全部正确**（人工核对 5 个污染命名 + anime 4 部）
5. `write_identified_media` 建出的行 own-id 形状正确（`tmdb:N` / `tmdb:N/sNeM`）
6. 识别成功的路径**退出 parked_paths**
7. 无幽灵行（无 404 id 建出的行）、无重复行
8. **身份错了一个都不接受**——识别错比认不出严重得多

**鲁棒性**

9. 单文件探针失败不拖垮整轮
10. CIFS 抖动/云盘超时不导致库行被误退役（三层防线生效）
11. 一轮 run 内某个 target 失败不影响其他 target

**不作为失败的情况**（诚实记录，不算 bug）

- 找不到字幕（`no_safe_match`）——识别对了就算成功，找字幕是另一件事
- `.archive/` 里的历史字幕与 agent 选的不是同一份——不同选择不等于错

## 7. 不做什么（YAGNI）

- **不在 A 线测识别能力边界**。规范命名的真库测不出这个，硬测会得到假的信心。→ Spec 6
- **不给云盘写字幕**。云盘挂载是 `:ro`（Spec 1 §3.2）。写入语义未验证，另立 spec
- **不动 `TV`/`Movies`** 直到阶段二
- **不删 `.archive/`**（用户裁决：留作对照）
- **不为 A 线写自动化断言套件**。这是一次性的人工验收活动，证据靠 trace + 库查询。自动化的那部分是 Spec 6

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 迁移 16→25 失败或产生外键违例 | 迁移前 FK 体检已内建（`db.ts:440`，失败则整体回滚且不落版本号）；已备份；**先在备份副本上试跑一次迁移** |
| 清库行时误删 `TV`/`Movies` 的数据 | 删除按路径前缀精确限定；**执行前先 SELECT 出待删清单人工过目**，再 DELETE |
| 云盘 OpenList 停机 → 目录变空 → 误判文件消失退役库行 | 三层防线（errno 区分/消失去抖/骤降哨兵）应生效，但**需专门造一次 OpenList 停机验证**（Spec 1 §6 也记了这条） |
| 全量夜跑中途崩溃，次日无从判断进度 | 每轮 run 落 `runs` 表；trace 持久化；崩溃后能从库状态推断进度。**夜跑前确认日志轮转配置**（compose 已设 max-size 10m / max-file 3，全量跑可能冲掉早期日志——需临时放大或另存） |
| 识别错误被漏过（比全绿更危险） | 5 个污染命名 + anime 全部**人工逐个核对** TMDB id，不依赖 agent 自述 |
| 阶段二烧一整夜但白烧（比如某个系统性 bug） | 阶段一必须先跑通并修完 bug；夜跑前做一次 10 分钟冒烟 |

## 9. 参考

- `src/agent/orchestratorAgent.tools.ts:297-330`（`dispatch_unidentified_identification`）
- `src/cli/index.ts:415-440`（daemon 的 unidentified 分支接线）
- `src/cli/unidentifiedFindSubtitle.ts`（targets 组装 + 收割入账 + itemId 幻觉防线）
- `src/v2/db.ts:440-480`（迁移前 FK 体检 + 事务迁移）
- `src/v2/ingest.ts:700-765`（磁盘真相移除的三层防线）
- `deploy/deploy.sh`（compose 保护规则 —— 云盘卷改动不能走它）
- 依赖 Spec 1（云盘挂载）；建议但不强制依赖 Spec 2（避免夜跑空转）
