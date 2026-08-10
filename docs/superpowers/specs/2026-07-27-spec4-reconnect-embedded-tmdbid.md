# Spec 4：接回 `embeddedTmdbId` 证据通道

**日期**：2026-07-27
**状态**：待用户批准
**范围**：修复我在 agent-first 重构中引入的 spec 违背——`[tmdbid-N]` 路径标签这条最强证据被静默丢弃。
**索引**：见 `docs/superpowers/specs/2026-07-27-INDEX.md`

## 1. 这是我引入的缺陷，不是历史遗留

Agent-first 识别重构（2026-07-26/27，17 个任务）里，我把 ingest 的 FULL PATH 从 290 行砍到 37 行，只采集 raw 数据并 park。砍的时候把 `embeddedTmdbId` 一起丢了。

原 spec §1.2 明确要求 raw 数据里带这条：

> 改成给 raw 数据：文件路径 / 目录名（parent/grandparent）/ 资源名（文件名）/ 时长（probe duration）/ 结构提示（SxxEyy/第N集/绝对集号）/ **可能的 imdb hint（identify_overrides 里的）**

而我自己写的 `src/recognition/rawEvidence.ts` 头注释里，把它称为**最强证据**：

> `embeddedTmdbId` (the `[tmdbid-N]` tag — the canonical layout this project itself emits, see `buildTargetShowDir` in libraryRealign.ts) is the **STRONGEST hint available**, so it is carried here rather than dropped.

然后 `buildRawEvidence()` 这个函数**零生产调用者**（grep 确认：只有自己的定义）。写了、注释了它多重要、然后从未接上。

## 2. 这条通道承载什么

`embeddedTmdbId` 来自 `identifyFromPath.ts:40` 的 `TMDB_ID_PATTERN = /\[tmdbid-(\d+)\]/i`，两个来源：

1. **本项目自己产出的规范布局**。`buildTargetShowDir`（libraryRealign.ts）整理后的目录形如 `Show (Year) [tmdbid-N]/Season NN/`。也就是说：**本项目整理过的库，再次扫描时认不出自己写下的 id**。
2. **用户手写或外部工具（Sonarr/Radarr 生态）写下的标签**。这是一种完全合理的、甚至是**最精确的**"改名治本"方式——正好契合 Spec 3 的方向（我们要求用户改名，那就该支持最精确的那种改名）。

原 spec 提到的 `identify_overrides` 来源随 Spec 3 消失，但**路径标签这个来源与认领性质完全不同**：

| | 认领（Spec 3 删除） | `[tmdbid-N]` 路径标签（本 spec 接回） |
|---|---|---|
| 身份从哪来 | 用户在 UI 里凭空指定 | **路径里的客观文本**，与目录名/文件名同等地位的真实证据 |
| 覆盖范围 | 整个目录前缀，会吞掉未来扔进去的无关文件 | 只是这个路径自己的一段文本 |
| 是否绕过 two-evidence bar | 是（直接建行） | **否**——它只是 hint，agent 仍须 TMDB 核验 |
| 治本性 | 治标（只在本项目本库有效） | **治本**（Jellyfin/Emby/*arr 全生态通用） |

所以 Spec 3 废认领**不影响**本 spec：删的是"凭空指定"，接回的是"路径里的证据"。

## 3. 设计

### 3.1 它必须是 hint，不是判决

`rawEvidence.ts` 的注释已经把口径写对了，照此执行：

> It is still only a hint, not a verdict: the tag was written by a previous run or an external organizer and may be stale or wrong, so the agent must still confirm it resolves correctly on TMDB before relying on it.

标签可能**过期或错误**（上一轮识别错了写下的、外部工具写错的、用户手抄错的）。所以：

- agent 拿到它作为**首选查询起点**（省掉搜索步骤，直接 `get_tmdb_details`）
- **仍须走 two-evidence bar**：详情返回的名字要与目录/文件名证据吻合，结构（季表/年份/时长）也要吻合
- 核验失败 → 当作标签错误，**回退到正常识别流程**（清洗标题 → 搜索），不因为"路径里写了 id"就照抄

这一点在 skill 里必须讲明，否则模型会把标签当判决直接写库——那就等于把认领后门换个位置重开。

### 3.2 存储：parked_paths 加一列

摄取时把它落库，供 agent 识别时读取。与 `duration_sec`/`embedded_langs`（v25 加的两列）同一性质，走同样的裸 `ALTER TABLE ADD COLUMN` 增量迁移（`db.ts:345` 的 v25 迁移是现成范例，条件式补齐 + fresh install 走完整链）。

列名与迁移版本号由实施计划定稿。约束：

- `NULL` = 路径里没有标签（绝大多数情况），**不是**"未探测"。它是纯路径解析的产物，同步、零 I/O、必然有确定结果。
- 指纹语义：它随路径变化而变化，但**不参与 `(probe_mtime, probe_size)` 指纹**——路径改了就是新行（parked_paths 以 path 为主键），旧行随磁盘真相清理消失。无需特殊处理。

### 3.3 传递链

三个环节，每个都得接上（现在三个都断着）：

| 环节 | 现状 | 要做 |
|---|---|---|
| ingest 采集 | `identifyFromPath` 已算出 `embeddedTmdbId`，但 FULL PATH 丢弃它 | 落进 parked_paths 新列 |
| CLI 组装 targets | `buildUnidentifiedTargets`（`unidentifiedFindSubtitle.ts:38`）只取 season/episode 提示 | 读新列，填进 target fact |
| prompt 呈现 | `findSubtitleWorker.ts:208` 的 `targetsBlock` 不含此字段 | 作为 hint 呈现，措辞明示"可能过期/错误，仍须核验" |

**`FindSubtitleTargetFact` 需要加字段**（`findSubtitleWorker.schemas.ts`）。注意现有 `imdbId` 字段的先例：`unidentifiedFindSubtitle.ts:66` 恒填 `null` 并注明"无身份即无 imdb——禁止编造（search_source 工具只许用事实值）"。新字段同理：只在路径真有标签时非空。

### 3.4 `buildRawEvidence` 的去向

它是我写的死代码。两个选项：

- **接上它**：让 ingest 真正用这个函数组装证据，一处定义、一处消费。
- **删掉它**：ingest 直接写列，`RawFileEvidence` 这个中间类型不再需要。

我倾向**删掉**：ingest 现在只需要往 parked_paths 写几个标量列，中间再造一个结构体是多余的抽象；而"raw evidence 的契约"实际上已经由 `FindSubtitleTargetFact` + parked_paths 的列共同承担了。留着一个零调用者的类型和函数，下一个人还会以为它在用。

**但这是设计取舍，请用户裁决。** 如果保留，它必须真的成为唯一组装口（否则又是死代码）。

## 4. 不做什么（YAGNI）

- **不写 `[tmdbid-N]` 标签**（即不做整理/改名）。本 spec 只做读取。`libraryRealign` 的写侧是独立话题。
- **不支持其他 id 形态**（`[imdbid-tt...]`、`{tmdb-N}`、`[tvdbid-N]`）。只做本项目自己产出的那一种 + 已有正则覆盖的形态。有真实需求再加。
- **不让标签跳过 TMDB 核验**（见 §3.1）。省一次 `search_tmdb` 是收益，省 `get_tmdb_details` 是开后门。
- **不恢复 `identify_overrides` 作为 hint 来源**（原 spec §1.2 提到的那半）。该表随 Spec 3 消失，本 spec 只接路径标签这一个来源。

## 5. 验收标准

1. 路径含 `[tmdbid-1396]` 的文件，摄取后该值落进 parked_paths 新列。
2. `buildUnidentifiedTargets` 把它填进 target fact；prompt 里可见。
3. **标签正确时**：agent 直接 `get_tmdb_details` 核验通过 → 写库。（live eval 加 case）
4. **标签错误/过期时**：agent 核验失败 → **回退到正常识别流程并识别正确**，不照抄错标签。（live eval 加 case，这条是真正的红线）
5. 无标签的路径（绝大多数）：新列为 NULL，行为与今天完全一致（回归锁）。
6. `buildRawEvidence` 的去向按裁决执行：删掉则 grep 零残留；保留则成为唯一组装口且有调用者。
7. 全量测试仍全绿；迁移在真库验证。

## 6. 风险

| 风险 | 缓解 |
|---|---|
| **模型把标签当判决**，绕过 two-evidence bar 直接写库 —— 等于重开认领后门 | ①skill 明示"可能过期/错误"；②§5.4 的 live eval case 是硬门：故意给错标签，断言模型**不**照抄；③`write_identified_media` 已有 404 幻觉防线，但错标签指向的是**真实存在的错条目**，404 防线拦不住——只能靠 two-evidence bar，所以那条 eval case 不可省 |
| 本项目自己写的标签若曾写错，会形成"自我强化的错误"（错标签 → 再次识别时照抄 → 永久错） | 同上：核验不通过必须回退。这也是为什么标签不能免检 |
| 新列的迁移在真库上失败 | v25 的两列迁移是现成范例，同样的条件式 `ALTER`；真库已备份 |
| 与 Spec 3 的删表迁移冲突（同一次部署两个迁移） | 迁移链是顺序执行的（`db.ts:461` 的 `for` 循环 + 事务），互不干扰。但**实施顺序应先 Spec 4 加列、后 Spec 3 删表**，或反之皆可，只要各占一个版本号 |

## 7. 参考

- `src/recognition/rawEvidence.ts`（`buildRawEvidence` —— 零调用者的死代码，含"STRONGEST hint"注释）
- `src/recognition/identifyFromPath.ts:40`（`TMDB_ID_PATTERN`）、`:166`（Rule 1 短路逻辑）、`:280`（返回该字段）
- `src/v2/ingest.ts:596-640`（FULL PATH：`outcome` 里有 `embeddedTmdbId` 却未落库）
- `src/cli/unidentifiedFindSubtitle.ts:44-66`（targets 组装，`imdbId: null` 的先例）
- `src/agent/findSubtitleWorker.ts:208-226`（`targetsBlock` 呈现）
- `src/v2/db.ts:345`（v25 两列的增量迁移范例）
- 原 spec §1.2：`docs/design/2026-07-26-subtitle-agent-identity-spec.md`
