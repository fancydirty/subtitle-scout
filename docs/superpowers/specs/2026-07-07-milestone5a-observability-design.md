# Milestone 5a Design: 可观测性（台账 / 日志落盘 / report）

Status: approved by user on 2026-07-07
Scope: 四件套——运行台账 ledger、daemon 日志落盘轮转、`report` 子命令、运维卫生
（docker 日志上限 + journal 保留策略）。核心流水线零改动，只加观测点。

## 动因

用户核心诉求：重点不是今晚找到字幕，是**持续成功且可追溯**——明早一条命令知道昨晚
发生了什么；出问题五分钟内定位根因。实证痛点：部署重建容器导致当晚早期 docker logs
灭失（2026-07-06 实际发生）；journal 完整但无聚合时间线。

## ① 运行台账 ledger（核心件）

- 文件：`<cacheRoot>/ledger.jsonl`，追加式一行一 JSON 事件，崩溃安全（append + fsync 不必，
  行级完整性足够；损坏行读取时跳过）。
- 事件类型与字段：
  - `run`：`{ts, type:'run', itemId, name, source:'playback'|'queue'|'cli', decision,
    confidence?, subtitlePath?, journalPath, llmProfile:{mode,quirkId?}, durationMs,
    llmCalls, assrtCalls, error?}`；
  - `queue`：`{ts, type:'queue', event:'enqueued'|'decayed'|'dormant'|'activated'|'removed',
    itemId, name, attempts?, nextRetryAt?}`。
- 写入点：watcher 的 runJob 完成处（含失败）与 PrefetchQueue 各变迁方法（通过注入的
  onEvent 回调，queue 模块不直接依赖 ledger——保持可测）。CLI run/run-item 也记
  （source:'cli'）。
- 模块：`src/core/ledger.ts`——`Ledger.append(event)`、`Ledger.read(sinceMs): Event[]`
  （逐行 parse，坏行跳过计数）。zod schema 定义事件（LedgerEventSchema）。

## ② daemon 日志落盘

- watcher/CLI 的 log 函数升级：stdout 照旧 + 追加写 `<cacheRoot>/logs/watch-YYYY-MM-DD.log`
  （本地时区日期），按天新文件；每次写入时惰性清理 30 天前的旧文件。
- 模块：`src/core/fileLogger.ts`——`makeFileLogger(dir, retainDays, now?)` 返回
  `(msg: string) => void`；注入时钟可测。

## ③ `subtitle-scout report` 子命令

- `report [--since 24h|7d|<ISO>]`（默认 24h）：读 ledger，输出人类可读摘要：
  - 运行统计：按 decision 分组计数（download/adopted_local/no_safe_match/ask_user/
    already_exists/error），按 source 分组；
  - 失败明细：每条 no_safe_match/ask_user/error 一行（名字、来源、原因摘要、journal 路径）；
  - 队列动态：入队/衰减/休眠/激活计数与当前 queue.json 概况（pending/dormant 数）；
  - 资源消耗：ASSRT 调用总数、LLM 调用总数、profile 模式分布；
  - 坏行计数（ledger 自身健康）。
- exit 0；空台账输出"无记录"。--since 解析：`(\d+)(h|d)` 或 ISO 日期。

## ④ 运维卫生

- docker-compose.yml 两服务加：
  `logging: {driver: json-file, options: {max-size: "10m", max-file: "3"}}`；
- journal 保留：daemon 每日首个 tick 惰性清理 `<cacheRoot>/journals/` 中 90 天前的目录
  （`JOURNAL_RETAIN_DAYS` 可配）；ledger 永久保留；
- 新环境变量：`JOURNAL_RETAIN_DAYS=90`、`LOG_RETAIN_DAYS=30`。

## 诚实边界

`download` 成功 ≠ 字幕内容正确；正确性无自动 ground truth。本里程碑交付"每个决策
可追溯可复盘"。准确率反馈闭环（用户标记 → 影响打分）与 ask_user 通知通道同属 M6，
届时触发 SQLite 重评估条件。

## 测试

- 单测：Ledger append/read/坏行跳过；fileLogger 按天分文件与保留清理（注入时钟）；
  report 的 since 解析与摘要聚合（喂手造 ledger 行，断言输出关键行）；journal 清理；
- 集成：watcher 注入 fake ledger 断言 run/queue 事件写入点；
- 真实：OrbStack 跑一轮后 `report --since 1h` 输出正确摘要；部署软路由后次日人工 report。

## 不做什么

- 不做 HTML/Web 面板（CLI 摘要够用；UI 属 M6）；
- 不做 metrics 导出（Prometheus 等）；
- 不做 SQLite（翻转条件未触发，见 M4 spec 决策）。

## 终审遗留（fast-follow 候选）

- ledger.jsonl 无保留策略（append-only 永久增长；当前量级一年数 MB 可接受）。
  未来触发条件：report 变慢或文件 >50MB 时做按月轮转归档。
- --since 裸日期按 UTC 解释（已文档化）；如需本地时区语义待用户反馈。
