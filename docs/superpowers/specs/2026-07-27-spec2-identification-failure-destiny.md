# Spec 2：识别失败的归宿（park 原因二分）

**日期**：2026-07-27
**状态**：待用户批准
**范围**：agent 识别失败时的分类、回写、与重试策略。不碰认领 UI（Spec 3）、不碰证据通道（Spec 4）。
**索引**：见 `docs/superpowers/specs/2026-07-27-INDEX.md`

## 1. 问题

Agent 识别不出一个文件时，现在会发生什么：

1. agent 在 finalize 里把该 target 报进 `no_safe_match`（附人话理由），`identity` 报 `outcome: 'unidentified'`。
2. **这个理由不会回写到 `parked_paths`。** park 原因仍是摄取时写的 `'awaiting-agent-identification'`。
3. 下一轮巡检，负缓存 `shouldRetryParkedPath` 按**时间**退避（1h→4h→24h）。窗口一到，该文件**重新入队、重新烧一轮 agent、必然又失败**。

第 3 步是真金白银的浪费。用户裁决的方向是"认不出的责任在用户侧，去改名"——但如果系统在用户改名之前一直反复重试，那这个责任转移就没有落地机制。

### 1.1 关键区分：两种失败在物理上不同

| | 证据不足 | 识别失败 |
|---|---|---|
| 例子 | `1.mp4` 在 `/movies/random/` 下，路径里无任何片名信息 | `招z魂z4` 已清洗出候选，但 TMDB 上查不到 / 没过 two-evidence bar |
| 证据集合 | **空**（或无信息量） | 非空 |
| 重跑会不同吗 | **不会**。证据没变，重跑必然同样结果 | **可能会**。TMDB 可能后来收录了、模型这轮恰好不行、网络抖动 |
| 解法 | 用户改名（唯一解） | 等待重试 / 也可能最终需要改名 |
| 正确策略 | 指纹未变则**永不重试** | 照常时间退避 |

现在这两者被压成同一个状态，于是要么都重试（浪费），要么都不重试（放弃可自愈的情况）。**二分是必要的。**

## 2. 设计

### 2.1 新增两个 park 原因

在 `parked_paths.park_reason` 上新增两个值（该列是自由文本 `TEXT NOT NULL`，无 CHECK 约束，**无需 schema 迁移**）：

- `insufficient-evidence` —— 证据集合为空或无信息量。**指纹未变则永不重试。**
- `identification-failed` —— 有证据但未通过 two-evidence bar。**照常时间退避重试。**

两者都是 eligible（会被 `buildUnidentifiedTargets` 取用）——区别只在负缓存的判定，不在是否上车。

### 2.2 谁来判？—— agent 判，不是机械层判

这是本 spec 最重要的设计决策，且**必须**如此：

- 机械层无法判断"证据是否足够"。`identifyFromPath` 的 `no-signal` park 只看有没有 year/season/episode 结构，判不出"这个目录名是不是个片名"。判断"`/movies/random/1.mp4` 的证据集合为空"需要理解语义。
- 更根本的：**spec 铁律是机械层零裁决权**。让机械层判"证据不足"就是给它发还裁决权。
- Agent 已经掌握全部证据，且已经在 finalize 里给出 `unidentified` + 理由。**它只需要多说一个字段：这是哪一种失败。**

因此：扩展 `identity` 判别联合的 `unidentified` 分支，增加一个分类字段。形如：

```
{ outcome: 'unidentified', reason: string, kind: 'insufficient-evidence' | 'identification-failed' }
```

字段名与枚举值由实施计划定稿。约束（必须遵守，来自六轮血案的教训）：

- **必须用 `coerce.ts` 的容错 helper**，不要新造更窄的门。真模型对枚举字段会发各种变体（大小写、下划线/连字符、省略键）。`identityTools.ts` 顶部的长注释记录了为什么——`z.number().int().nullable()` 那次让六轮评估全废。
- **缺席必须有安全默认**。模型没填 `kind` 时，默认取 `identification-failed`（照常重试）——宁可多花一轮，不可把一个可自愈的文件永久钉死。**默认值必须偏向"继续尝试"，不能偏向"永不重试"。**

### 2.3 回写：已有现成写口，不必新建

`LibraryRepo.updateParkReason(path, reason, now)` **已存在**（`libraryRepo.ts:891`，注释写明是"救援R1：改写停车理由"）。收割阶段拿到 agent 的分类后直接调用即可。

回写发生在**收割入账**阶段（`src/cli/unidentifiedFindSubtitle.ts` 的 ③ 步），与现有的"itemId 幻觉防线"同一层——只对本次 task 的目标路径回写，不接受 agent 报本批之外的路径。

### 2.4 负缓存：加一条指纹门

`shouldRetryParkedPath` 现在的逻辑（`libraryRepo.ts:870-882`）：

```
行不存在        → 重试
指纹变了        → 重试
next_retry_at 空 → 重试
否则            → now >= next_retry_at
```

新增一条，位置在"指纹变了 → 重试"**之后**（指纹变化优先级最高，改名必须立刻重走识别）：

```
park_reason == 'insufficient-evidence' 且指纹未变 → 不重试
```

语义是**可自愈的终局**：与 `excluded-extra`/`duplicate-content` 那类机械终局裁决同构，但更强——它明确指向一个用户可执行的动作（改名），且改名即自动解除（改名 → 路径变 → 新路径无 parked 行 → `行不存在 → 重试`）。

**注意 `duration_sec`/`embedded_langs` 不参与指纹**。指纹是 `(probe_mtime, probe_size)`。改名不改 mtime/size——但**改名会改 path，而 parked_paths 以 path 为主键**，所以旧行随磁盘真相清理消失（`ingest.ts:761`），新路径是全新行。这条链已验证可行，无需新代码。

### 2.5 用户改名后的自愈链（已全部存在，零新代码）

| 步骤 | 机制 | 位置 |
|---|---|---|
| 用户改名 | — | 用户侧 |
| 旧路径的 parked 行消失 | 每轮巡检：本轮未见 + 磁盘复核确认 gone → `clearParkedPath` | `ingest.ts:761-765` |
| 新路径重走识别 | 新路径无 parked 行 → `shouldRetryParkedPath` 返回 true | `libraryRepo.ts:878` |
| 用户没改名就手动触发 | 指纹未变 + `insufficient-evidence` → 不入队，零消耗 | **本 spec 新增** |

用户裁决里担心的"未改名重复触发浪费"，正是最后一行解决的。

## 3. 边界：不许扩大 `insufficient-evidence` 的适用面

这个状态的代价是**永不自动重试**，所以判定必须严格。以下情况**不是** `insufficient-evidence`：

- TMDB 查不到条目（可能后来收录）→ `identification-failed`
- 模型这轮没查出来但证据其实存在 → `identification-failed`
- 网络/TMDB 抖动 → `identification-failed`（甚至该进 `retry_later`）
- 某一集集号越界（身份其实认出来了）→ 这根本不是识别失败，身份照常落库，该 target 单独 `no_safe_match`

只有一种情况算：**路径（目录名 + 文件名）里客观上不存在任何可用于识别的信息**。skill 里需要把这条判据讲清楚，且**必须给出反例**（上面四条）——否则模型会把"我没查到"当成"证据不足"，把可自愈的文件永久钉死。

这是本 spec 最大的风险点，见 §6。

## 4. 不做什么（YAGNI）

- **不引入置信度分数**。北极星不变：决策 + 人话理由，无分数。二分是"哪种失败"，不是"多有信心"。
- **不做第三个中间态**。两类已覆盖决策需求（重试 / 等改名）。
- **不在本 spec 做 UI**。认领点展示与改名指引是 Spec 3。
- **不改 `no_safe_match` 桶的语义**。识别失败的 target 照旧进那个桶；本 spec 只加"park 原因回写"这条正交的事。

## 5. 验收标准

1. Agent 判 `insufficient-evidence` 的路径，**指纹未变时再次巡检/手动触发不入队**（用测试断言 `shouldRetryParkedPath` 返回 false）。
2. Agent 判 `identification-failed` 的路径，**照常按时间退避重试**。
3. 模型**省略分类字段**时，落到 `identification-failed`（安全默认），不是永不重试。
4. 模型发**各种变体编码**（大小写、下划线/连字符）时 schema 收得下——比照 `identityTools.test.ts` 那组"六种发法"回归锁的做法，为新枚举也建一组。
5. 改名自愈链端到端：造一个 `insufficient-evidence` 行 → 改名 → 巡检 → 旧行消失、新路径入队。
6. 回写只作用于本批目标：agent 报一个本 task 之外的路径 → 拒绝并告警，不回写。
7. 全量测试仍全绿。

## 6. 风险

| 风险 | 缓解 |
|---|---|
| **模型滥用 `insufficient-evidence`**，把"我没查到"当"证据不足"，可自愈文件被永久钉死 | ①skill 明确给出四条反例（§3）；②安全默认偏向重试；③**live eval 必须专门测这个分类的准确率**——构造"证据充足但故意难查"的 case，断言模型**不**判 insufficient；④用户侧有逃生阀：认领点会显示这些文件（Spec 3），用户看到误判可以改名或触发重扫 |
| 二分判据讲不清 → 模型随机二选一 | 判据必须是**客观的**（"路径里有没有可识别信息"），不是主观的（"我有多确定"）。若 eval 显示分类准确率低，**回退方案是全部按 `identification-failed` 处理**（退回今天的行为，只是浪费，不会钉死文件） |
| `insufficient-evidence` 的文件永远堆在认领点，用户忽视 | Spec 3 的 UI 责任：必须显示"缺什么证据 + 建议改成什么名"，把用户推向可执行动作 |
| 指纹门写错导致**所有** park 路径都不重试 | 指纹变化优先级最高的顺序必须有测试锁；且新条件只在 `park_reason` 精确等于该值时生效 |

## 7. 参考

- `src/v2/libraryRepo.ts:870`（`shouldRetryParkedPath`）、`:891`（`updateParkReason`，现成写口）
- `src/agent/findSubtitleWorker.schemas.ts:141`（`identity` 判别联合，待扩展 `unidentified` 分支）
- `src/agent/identityTools.ts:11-23`（六轮血案的根因记录——新枚举必须复用 `coerce.ts`）
- `src/v2/ingest.ts:761`（磁盘真相清理 parked 行，改名自愈的关键一环）
- `src/cli/unidentifiedFindSubtitle.ts`（收割入账，回写发生地）
