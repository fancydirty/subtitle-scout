# Spec 3：废掉认领入口，保留认领点 + 改名指引

**日期**：2026-07-27
**状态**：待用户批准
**范围**：删除凭空指定身份的通道；把认领点改造成"缺什么证据 + 该改成什么名"的指引面板。
**索引**：见 `docs/superpowers/specs/2026-07-27-INDEX.md`

## 1. 用户裁决（原话要点）

> 所谓的认领，我觉得不能变成用户能给比如根本没有意义的 `1.mp4` 这种配个进击的巨人的认领……你比起在这认领不如你给文件名或者文件所在的目录改名……我们不接受在项目内瞎搞了，用户不满意就自己去改文件名，不能把这个事交给我们这个项目，毕竟治标不治本。

补充裁决：

> 废掉认领入口，不代表废掉认领点，还是能有个地方让用户看到有哪些资源是因为实在识别不出来是什么玩意而放那的，只要用户乖乖去改了名，下次巡检这些待认领的资源就会消失。

> 置信度这个元素，如果传递给用户，势必造成他们的心智负担……他们要的是确定性的结果……对就对，认不出就认不出，并且认不出的责任，在用户侧。

## 2. 为什么废掉入口是对的（代码层面的硬证据）

不只是"治标不治本"这个直觉，代码里有更硬的理由：

**`identify_overrides` 的覆盖单位是目录前缀，不是那个文件。** `triageOps.ts:41`：

```
lib.addOverride(dirname(path), tmdbId, isTv, Date.now(), season ?? null)
```

用户给 `1.mp4` 配一个身份，写下的是**整个父目录**的认领（`findOverride` 做最长前缀匹配，`libraryRepo.ts:1096`）。那个目录里以后扔进去的任何文件——别的剧、电影、真正的家庭录像——**全部被这条认领吞掉**。用户以为在标注一个文件，实际在给一片路径空间焊死一个身份。

此外：认领是**绕过 two-evidence bar 的后门**。整个项目的核心不变量是"没有两条独立证据不许认领身份"。给用户开一个不需要证据的入口，是在自己的核心不变量上开洞。

而改名是真解：改完之后**所有**下游都受益（本项目的 agent 识别、Jellyfin/Emby 刮削、以后任何工具）；认领只在这个项目的这个库里有效。

## 3. 要删什么 / 要留什么

### 3.1 删除（凭空指定身份的通道）

| 对象 | 位置 | 说明 |
|---|---|---|
| `claimParked` | `src/v2/triageOps.ts:27` | 写 `identify_overrides` 的唯一人工入口 |
| `unclaim` / `removeOverride` | `triageOps.ts` / `libraryRepo.ts:1122` | 认领的撤销口，随认领一起消失 |
| `findOverride` | `libraryRepo.ts:1096` | 消歧前查 |
| `addOverride` | `libraryRepo.ts:1076` | 写入 |
| `recognize()` 的 override 分支 | `src/recognition/index.ts:47-71` | 把认领当权威身份的那段 |
| `identify_overrides` 表 | `db.ts:118` | 整张表 |
| `buildClaimedOverrides` + `TriageDTO.claimed` | `apiV2.ts:1239` / `:1224` | API 层的 claimed 半边 |
| 前端认领 UI（tmdbId 输入框） | `web/src/` | 待实施时定位 |

**真库现存 4 条认领**。删表意味着丢弃它们；它们已建出来的库行不受影响（行 id 编码 tmdbId，与认领表解耦）。

**注意 `recognize()` 的签名会变**：override 分支删掉后，`opts.findOverride` 参数消失。该函数的 `tmdb` 参数**早已是纯遗留**（注释自陈 "retained only for transitional call-site compatibility — recognize no longer searches TMDB and never touches it"），本 spec 顺手把它一并清掉——它是上一轮重构留下的死参数。

### 3.1.1 顺带消灭一笔历史债务："空名 ? 卡"

`ingest.ts:775` 记录了一条债务：override 命中时 `recognize()` 的 claim-gated 分支**恒返回 `title: ''`**（认领只给 tmdbId，给不出剧名），于是库里留下"空名 ? 卡"，需要一条"富化重试"机制（`listSeriesNeedingEnrich` + `applyEnrichment`，每轮 cap 10）去事后补标题。

**认领通道删掉后，这个债务的根源随之消失**——agent 的 `write_identified_media` 从来都带着 TMDB 核验过的 title 建行，不会写空名。

但**本 spec 不删那条富化重试机制**：它还在治另一个正交的缺口（旧库存量剧从未拉过 `genres`，schema v13 新列，NULL=尚未富化）。删掉会伤到存量数据的修复。只在文档上记明：它的"空名"那一半适用面已经归零，未来若确认存量空名已清完，可以再收窄。

### 3.2 保留（不是认领，是"放回识别队列"）

`unexclude`（`triageOps.ts:52`）**必须保留**。它与认领性质完全不同：

| | 认领（删） | unexclude（留） |
|---|---|---|
| 用户提供什么 | 一个库里没有的身份（无证据） | 一个"你判错了，重新识别"的信号 |
| 之后谁裁决身份 | 无人，直接写库 | **agent 重新识别**，照走 two-evidence bar |
| 治本方案 | 改文件名 | 无——机械排除规则本身是启发式，必然误伤 |

`excluded-extra` / `duplicate-content` 是机械层**唯一还保留裁决权**的角落（用路径含 `sample`/`extras` 之类的启发式规则），必然有误伤，所以需要人类逃生阀。这符合用户的原则，不是后门。

### 3.3 认领点本身：保留并改造

认领点 = `parked_paths` 表本身，**它已经存在，无需新建任何东西**。已有：`path`、`park_reason`、`first_seen`、`last_attempt`、`duration_sec`、`embedded_langs`。API 层 `buildParked`（`apiV2.ts:498`）已在读它。

用户设想的"agent 留下资源位置与元数据"——**数据库入队时本来就记了**，agent 不需要额外留标记。用户自己也推翻了这个想法，方向正确。

用户担心的"用户不能删除认领点里的资源，不然下次跑工作流又识别到"——**本来就删不掉，而且不该给删除按钮**：`parked_paths` 的行由巡检的磁盘真相唯一决定（文件还在就重新 park，`ingest.ts:761`）。给用户一个删除按钮等于让他手动维护一个自愈的表，删了下轮还会回来，纯粹制造困惑。

## 4. 改造后的认领点 UI

### 4.1 核心原则：责任转移必须伴随可执行指引

用户说"认不出的责任在用户侧"——我同意，但**前提是先告诉他该做什么**。只显示"认不出"就是甩锅。所以每一条待认领资源必须展示：

1. **它是什么文件**（path，以及可读的目录/文件名拆分）
2. **为什么认不出**（park 原因二分，来自 Spec 2：证据不足 / 识别失败）
3. **缺什么证据**（`/movies/random/1.mp4` → "文件名和它所在目录都不包含任何片名信息"）
4. **该改成什么**（可复制的建议名，如 `片名 (年份)/片名.年份.mkv`）
5. **已知的客观元数据**（时长、内嵌字幕语言）——这些是事实，帮用户自己认出这是什么

### 4.2 两种 park 原因的展示差异

| park 原因（Spec 2） | 展示口径 | 用户该做什么 |
|---|---|---|
| `insufficient-evidence` | "路径里没有任何可识别的片名信息" | **改名**（唯一解）。明示：不改名的话重新触发不会有任何效果 |
| `identification-failed` | "已尝试识别但未能确认身份"（附 agent 的人话理由） | 可等自动重试；若反复失败，改名或检查 TMDB 是否收录 |
| `excluded-extra` | "被判为花絮/样片" | 若判错，点 unexclude 放回识别队列 |
| `duplicate-content` | "与已入库文件重复" | 无需动作 |

### 4.3 无置信度

按用户裁决：不显示任何百分比/分数/"可能性"。二元结论 + 人话理由 + 可执行动作。理由不只是心智负担——**置信度无法校准**：我们没有 ground truth 验证"八成"真是八成，报出去的数字是编的。

### 4.4 "重新触发"按钮的诚实语义

用户设想"用户改好名后点重新触发"。实现上：

- 该按钮触发的是**重扫**，不是"强制重识别这个路径"。
- 如果用户**没有**改名，`insufficient-evidence` + 指纹未变 → 不入队、零消耗（Spec 2 §2.4）。**UI 必须诚实说明这一点**，否则用户点了没反应会以为是 bug。
- 如果用户改了名 → 旧路径行消失、新路径入队（Spec 2 §2.5 的自愈链）。

## 5. 不做什么（YAGNI）

- **不做自动改名**。项目替用户改名 = 项目又一次替用户做身份决策，绕回同一个洞。且改名涉及原子性/跨设备/CJK 大小写等一堆坑（`docs/design/2026-07-12-library-realign-design.md` 有记录）。
- **不做"建议名"的一键应用**。同上。只给可复制的文本。
- **不保留任何形式的 tmdbId 输入**。包括"高级模式"。留了就等于没废。
- **不给 agent 写 `identify_overrides` 的权限**（spec §205 曾设计的 `source='agent'` 逃生阀）。agent 现在直接 `write_identified_media` 建行，不需要这张表。

## 6. 验收标准

1. `identify_overrides` 表与全部读写口（`addOverride`/`findOverride`/`removeOverride`/`claimParked`/`unclaim`）在代码里**零残留**（grep 断言）。
2. `recognize()` 不再接受 `findOverride`，且遗留的 `tmdb` 参数一并清除；签名简化后所有调用点更新。
3. `unexclude` 仍工作，且有测试覆盖。
4. `GET /api/v2/triage` 不再返回 `claimed` 半边；`pending` 半边扩展出 §4.1 的五类信息。
5. 前端无任何 tmdbId 输入控件。
6. 认领点每条资源都能展示：park 原因（人话）、缺什么证据、建议改成什么名、已知元数据。
7. 未改名点"重新触发" → 不产生入队；UI 如实告知。
8. 改名后下一轮巡检 → 该条从认领点消失（端到端测试）。
9. 全量测试仍全绿；schema 迁移（删表）在真库上验证过。

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 删表是不可逆的破坏性迁移 | 真库已备份（`scout.db.pre-agent-first-20260727-205530`）；迁移前再备份一次。现存 4 条认领的**内容先导出记录在案**，万一用户想恢复某条可手工改名达到同等效果 |
| 用户失去"我知道这是什么但系统认不出"的表达途径 | 这正是裁决的意图——那个途径的正确形式是改名。但**必须**保证 §4.1 的指引质量，否则用户会卡住 |
| `insufficient-evidence` 误判（Spec 2 §6）导致用户被要求改一个其实没问题的名字 | 认领点展示 agent 的人话理由，用户能看出误判；且改名总是有效的兜底 |
| 建议名生成得不好（比如对剧集给了电影格式） | 建议名基于已知客观事实（有无 season/episode 结构提示、时长）生成；无法确定时给出**两种**格式模板让用户选，不假装知道 |

## 8. 参考

- `src/v2/triageOps.ts`（`claimParked` 删 / `unexclude` 留）
- `src/v2/libraryRepo.ts:1058-1125`（override 表的全部读写口）
- `src/recognition/index.ts:42-75`（`recognize()` 的 override 分支 + 遗留 `tmdb` 参数）
- `src/dashboard/apiV2.ts:488-506`（`ParkedItemDTO` / `buildParked`）、`:1237-1254`（`buildClaimedOverrides` / `buildTriage`）
- `src/v2/db.ts:118`（`identify_overrides` 表定义）、`:325`（v24 的 `source` 列迁移）
- 依赖 Spec 2：park 原因二分是本 spec 的 UI 展示基础
