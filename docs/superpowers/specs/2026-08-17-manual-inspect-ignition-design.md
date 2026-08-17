# Spec：手动点火巡检

日期：2026-08-17 ｜ 状态：用户已批准 §1 行为与 §2 文案 ｜ 上游：活动页《黑暗智宅》挂在排队里，看不到下次巡检，也无法立刻开跑

## 1. 问题

字幕工作台只在 **24 小时一轮**的完整巡检里跑。活动页状态条只写「上次自动检查开始于…」，没有下次。设置里的 `scan_interval_ms`（占位 15 分钟）**没有接到** `INSPECT_INTERVAL_MS`。`POST /api/v2/library/scan` 只跑机械扫盘（`scanOnce`），不跑识别/字幕。

《黑暗智宅》在活动页排队，是 `retry_later` 写了 `files.recheck_after`。界面用 `includeBackoff: true` 能看见它；daemon 取件默认滤掉未到期行（防付费 LLM 热循环）。所以即使用户等到下一轮自然巡检，没到点也不会搜。

用户要两件事：看得见下次自动检查；一键立刻开跑，且**这一轮**连退避中的字幕一起搜。

## 2. 范围

**In**

- 活动页状态条：空闲时显示下次自动检查相对时间 +「现在跑」。
- `POST /api/v2/library/inspect`：置位并叫醒主循环，绕过 24h 闸和巡检失败短退避，跑完整 `runInspection`。
- 仅这一轮：字幕 `listSubtitleQueue(..., { includeBackoff: true })`；翻译 `listNewTranslateCandidates(..., { includeBackoff: true })`。
- `GET /api/v2/health` 增加 `nextInspectAt`。
- 进行中禁用按钮；已在跑再点 409；daemon 未就绪 503。

**Out**

- 单部「跑这部」。
- 改 `scan_interval_ms` 接线或日巡检周期。键继续可写，本轮不消费。
- 把 `/library/scan` 升级成完整巡检。加根防抖仍只扫盘。
- 识别台跳过 `next_retry_at`。
- 自然巡检（24h 闸那一轮）改成 `includeBackoff: true`。那会把 C26 热循环放回来。
- 改 `lastInspectAt` 从开始时刻改成完成时刻（既有债务，本轮不修）。
- 删除或重写「等待重试」卡片文案（点火之后 SSE 会自己把卡片变成在跑）。

## 3. 行为

### 3.1 倒计时

`nextInspectAt`：

- `lastInspectAt == null` → `nextInspectAt = null`（冷启动）。
- 否则 `nextInspectAt = lastInspectAt + INSPECT_INTERVAL_MS`（与 daemon 日闸同一常量，后端算，前端不手抄第三份 24h）。

状态条空闲（`inspectFreshness.phase === 'idle'`）：说「下次自动检查约 X 后」，X 来自 `max(0, nextInspectAt - now)`。若 `nextInspectAt <= now` 但仍是 idle（维护拍尚未转到闸门）：说「下次自动检查即将开始」，仍给「现在跑」。

`never` / `stale` / `running` 的既有四态句子保留。`idle` 不再渲染「上次自动检查开始于」。`stale` 仍带「…前」间隔（那是死亡信号，不是倒计时）。

### 3.2 点火

`ScoutDaemonV2.requestInspect()`：

- 若本进程正在 `runInspection` → 返回 `'already_running'`，不置第二轮旗。
- 否则置 `inspectRequested`、`wakeIdle()`，返回 `'queued'`。连点只置同一旗。
- 取件时清 `inspectRequested`，并清 `scanRequested`（完整巡检阶段 1 已含 `scanOnce`，不必再扫一遍）。
- 取件后：若 `workPermitted`，跑 `runInspection`（**不**看 `now - lastInspectAt >= everyMs`，也**不**看 `inspectRetryAfter`）。若不许干活，丢掉旗、不跑（按钮本就不出现）。
- 本轮设一次性 `skipBackoffThisInspect`：阶段 3 字幕快照与阶段 4 翻译取件带 `includeBackoff: true`。`finally` 清掉。识别队列不改。
- 成功仍 `writeLastInspectAt(本轮开始时刻)`，倒计时从这次点火重新算 24h。失败走既有短退避，不推进日闸。用户可在短退避期间再点——手动路径继续绕过 `inspectRetryAfter`。

`inspectOnce`（沙盒 CLI）不走这面旗，默认仍尊重退避。

### 3.3 HTTP

`POST /api/v2/library/inspect`，鉴权与 `/library/scan` 相同。

| 条件 | 状态 | 体 |
| --- | --- | --- |
| 未接线 / holder 空 / 回调 `not_ready` | 503 | `{ error: 'inspect trigger not configured (watch daemon not running)' }` 或 ready 窗口那句 |
| `already_running` | 409 | `{ error: 'already running' }` |
| `queued` | 200 | `{ ok: true }` |
| 非 POST | 405 | 与 scan 同形 |
| 无凭据 | 401 | 统一前置门 |

`DashboardOpts.requestInspect?: () => 'queued' | 'already_running' | 'not_ready'`。cmdWatch 用与 `requestScan` 同一个 `daemonHolder`；daemon 未构造完 → `not_ready`。

不复用 `/library/scan`。

### 3.4 UI

活动页状态条，许可为 `permitted` 时出现按钮「现在跑」（`data-testid="wb-inspect-now"`）。`engine-off` / `setup-incomplete` 那两行已在，按钮不出现。

`running`：按钮 `disabled`。点下去 200：立刻 `disabled`，等 health/SSE 切到「正在自动检查」。不另造「已排队」态。

409：状态条下沿 `role="alert"`「已经在检查了」。503 / 网络：同一位置「现在没法跑」。不弹窗。

文案不出现巡检 / daemon / backoff / inspect。中英：

| key | zh | en |
| --- | --- | --- |
| `wb_inspect_next` | 下次自动检查 | Next automatic check |
| `wb_inspect_soon` | 即将开始 | due soon |
| `wb_inspect_run` | 现在跑 | Run now |
| `wb_inspect_already` | 已经在检查了 | A check is already running |
| `wb_inspect_run_failed` | 现在没法跑 | Can't start a check right now |

相对时间「约 18 小时后」与现有 `relAgoLabel` 同粒度（秒/分/时/天），方向改为「后」；英文沿用 `18h` 这种短单位，前缀用 `wb_inspect_next`。

## 4. 测试

- health：有 `last_inspect_at` 时 `nextInspectAt` 为其值 + `INSPECT_INTERVAL_MS`；冷启动两者皆 null；键名单含 `nextInspectAt`。
- daemon：闸关死时 `requestInspect` 仍跑完整巡检；退避中的字幕本轮被 worker 拉到；随后一轮自然巡检仍滤退避；进行中再 `requestInspect` → `already_running`；叫醒 idle（拍长、断言在拍内开始）。
- HTTP：200/409/503/405/401，对拍 scan 那组。
- 活动页：idle 出现下次文案 + 按钮；running 按钮禁用；engine-off 无按钮；点下去打 `POST /api/v2/library/inspect`。

## 5. 明确不做的谎言

不要把「现在跑」画成只跑排队里那几部。它开的是完整巡检（扫盘 + 识别 + 字幕 + 翻译推进一个）。黑暗智宅能被带走，是因为本轮字幕快照含退避行，不是因为有单部 API。
