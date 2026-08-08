# daemonV2 巡检化方案 v2（对抗审计后）

**日期**: 2026-08-08
**触发**: 用户裁决——字幕/识别 agent 的工作台语义是"有活就一直跑，跑完歇，明天再巡检"
（对齐 Jellyfin 的库扫描频率），**不是 30s tick 轮询**（那是旧架构 orchestrator 的残留思维）。

---

## 0. 审计修正记录

**B-1（致命）**：judge 阶段（需字幕判定）**不在 daemon 里跑**——judgeSubtitle 只有手工 CLI
（judgeCommand.ts）引用，daemonV2/dispatcher 从不调用。识别绑定后 needs_subtitle 恒 NULL，
字幕队列 `WHERE needs_subtitle=1` 恒空 → 阶段 3 永远不可达。
**修法**：巡检加显式 judge 阶段（扫描→识别→judge→字幕），judge 依赖 work_id 所以
排识别之后、字幕之前。

**M-1**：retry_later=1h 在日巡检模型下是死语义（1h 后 daemon 在睡）→ **合并进明天**（24h）。

**M-2**：识别 1h/4h 阶梯 + while-drain = 同轮二次尝试 → 退避统一 24h，与 step 1 同批落地。

**M-3**：lastInspectAt 不持久化 → 存 meta 表（last_inspect_at），重启读它判 24h（旧 daemon
有 last_ingest_at 先例）。

**M-5**：只读根过滤（writableRoots）在 while 循环中必须保留（115 只读跳过字幕）。

---

## 0. 用户裁决记录

| # | 裁决 | 原文 |
|---|---|---|
| 1 | 没有 30s 轮询 | "每三十秒啥意思？工作台上有待消费的资源就应该一直跑下去" |
| 2 | 每天巡检一次 | "识别当然也是一天巡检一次，跟jellyfin 的逻辑一样" |
| 3 | 上下游流水线 | "字幕agent 的巡检建立在识别agent 基础上……每天的巡检先跑识别工作流，再跑字幕工作流" |
| 4 | 找不到的字幕明天再试 | "找不到的就标记找不到然后继续下一个……下次巡检也就是明天再重试" |
| 5 | 巡检间隔用后者 | "当前就后者"（距上次满 24h 就再跑） |

---

## 1. 正确模型

```
每天一次巡检（距上次满 24h）：
  阶段 1：机械扫描守备目录 → files 表（新文件入库，指纹跳过）
  阶段 2：识别工作流（上游）
    → 识别工作台 = 未识别的作品（work_id IS NULL 且 next_retry_at 已过）
    → 有活就一直跑（逐个作品），识别不出的标 next_retry_at=明天
    → 跑空才进入阶段 3
  阶段 2.5：judge（🔴 B-1 补齐——识别绑定后判 needs_subtitle）
    → 对已识别但未判定的文件跑 judgeSubtitle（国产/内嵌/sidecar 跳过）
  阶段 3：字幕工作流（下游）
    → 字幕工作台 = 已识别作品里缺字幕的（needs_subtitle=1 且 recheck_after 已过）
    → 有活就一直跑（逐个作品），找不到的标 recheck_after=明天
    → 跑空才结束
  阶段 4：停，歇着，等明天
```

**关键**：
- 没有 tick、没有 30s、没有"看一眼有没有活"
- 工作台有活就跑到空，没活就停
- 识别跑完才跑字幕（上下游串行）
- 找不到/识别不出的都标记"明天再试"，不插队

---

## 2. daemonV2 重写

```ts
class ScoutDaemonV2 {
  async run(signal) {
    while (!signal.aborted) {
      // 距上次巡检满 24h？→ 跑一轮巡检
      if (Date.now() - lastInspectAt >= INSPECT_INTERVAL_MS) {
        await this.runInspection()   // 扫描 → 识别 → 字幕，一条龙跑完
        lastInspectAt = Date.now()
      }
      // 没到 24h → 歇着（sleep 长间隔，如 5min 检查一次是否到点）
      await sleep(5 * 60 * 1000, signal)
    }
  }

  async runInspection() {
    // 阶段 1：扫描
    await scanOnce()
    // 阶段 2：识别工作流（有活跑到空）
    while (identifyQueue.length > 0) {
      await runIdentifyWorkDir(...)
    }
    // 阶段 3：字幕工作流（有活跑到空）
    while (subtitleQueue.length > 0) {
      await runSubtitleWorkDir(...)
    }
  }
}
```

**"歇着"用 5min 检查**：不是轮询工作台，是轮询"到没到 24h"——两者本质不同。工作台是事件驱动（有活就跑），24h 是时间闸（到点才跑）。

---

## 3. 退避语义对齐"明天"

| 情况 | 标记 | recheck |
|---|---|---|
| 识别不出（agent 拒识/超时） | next_retry_at | **明天**（24h，对齐巡检） |
| 字幕找不到（no_safe_match） | sub_status=unavailable, recheck_after | **明天**（24h） |
| 瞬时故障（真 retry_later） | recheck_after | **明天**（M-1：1h 在日巡检下是死语义，合并进明天） |
| 超时 | recheck_after | **明天**（同 M-1） |

**统一：全部"明天"**。不再有 15min/6h/1h 短退避——那些是旧 30s tick 思维的残留，
与"每天巡检一次"的模型矛盾。

---

## 4. skill 措辞修正（限流 ≠ 找不到）

`findSubtitleSkill.ts` 明确：
- retry_later 只用于**真瞬时故障**（provider errored / download timed out）
- **限流（429）→ 等一下再搜，不是 retry_later**——等完继续，搜完确实没有 = no_safe_match

当前 Peacemaker S01E08 报了 retry_later 是误判（它真找不到，该 no_safe_match）。
skill 要教：限流等待是常态，搜不到才是 no_safe_match。

---

## 5. 巡检间隔常量

```ts
INSPECT_INTERVAL_MS = 24 * 60 * 60 * 1000  // 24h
```

---

## 6. TDD 实现计划

### 步 1：daemonV2 巡检化（与步 2 同批，M-2 防中间态）
- 去掉 tick 循环 → runInspection（扫描→识别→judge→字幕 while 跑空）
- "歇着"改 sleep(5min) 检查 24h（或 sleep 到 24h 到点）
- lastInspectAt 持久化到 meta（last_inspect_at），重启读它判 24h（M-3）
- 保留 writableRoots 只读门（M-5）
- 测试：识别队列有活 → 一直跑到空；字幕在识别+judge 后才跑；跑空后停

### 步 2：退避语义改"明天"（与步 1 同批）
- identifyScheduler：retryDelayMs → 24h（识别不出）
- subtitleScheduler：no_safe_match → recheck_after=24h；retry_later/超时 → 24h
- 测试：找不到 → recheck 24h；瞬时 → 24h

### 步 3：skill 限流措辞
- findSubtitleSkill.ts：明确限流等待 vs no_safe_match

### 步 4：端到端验证
- 115 只读：识别跑通、字幕工作台跳过（只读）
- 死循环验证：找不到的标 24h，一轮跑完不停

---

## 7. 验收

| 门 | 判据 |
|---|---|
| tsc | 0 错 |
| 测试 | 全部绿，7 红基线不变 |
| 巡检语义 | 识别跑完才字幕；工作台有活跑到空 |
| 退避语义 | 找不到=24h，瞬时=1h |
| 115 | 识别全通，字幕只读跳过 |
