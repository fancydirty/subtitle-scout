# Milestone 4 Design: 触发经济学（收编 / 预热队列 / 重试策略）

Status: approved by user on 2026-07-06
Scope: 五件套——本地字幕收编、新进资源预热队列、国产内容过滤、已有字幕跳过缓存、
失败重试策略。全部是流水线"入口侧"的触发与经济性改进，M1-M3 核心流水线不动。

## 动因（用户三个关切 + 两个补充洞察）

1. 已有字幕时绝不浪费 agent（现状已保证零 LLM/ASSRT，本里程碑消除残余的重复 getItem）；
2. 用户手里已有的字幕（命名错配的孤儿文件）应被收编复用而非重新下载；
3. 播放触发之外应有"新进资源预热"，让用户按播放时字幕已就位；
4. 剧集更新也是新进（Jellyfin 每集独立 item 有 DateCreated，水位线天然覆盖）；
5. 首搜失败的处置要匹配"字幕迟到而非没有"的现实。

## ① 本地字幕收编（adoptLocal）

流水线 `cacheLookup` 未命中后、`planSearch` 前插入：

```
scanOrphans（纯代码）→ judgeOrphan（第四判断点，LLM）→ gate 校验 → 复制收编 → adopted_local
                └─无孤儿/判否/gate 拒 → 原 ASSRT 流程
```

- `src/files/orphanScanner.ts`：扫视频同目录 `.ass/.srt/.ssa`，排除已符合
  `<videoBase>.<lang>.<ext>` 约定命名者；每候选返回文件名 + 解码后内容头部样本
  （~500 字符，供 agent 看语言与片名线索）；样本解码复用 chardet/iconv。
- `src/agent/judgeOrphan.ts`：输入 identity + 视频文件名 + 孤儿清单（名字+样本），
  输出 `{adopt: boolean, file?: string, language?: 'zh-Hans'|'zh-Hant', confidence, reasons[]}`。
- gate（纯代码）：file ∈ 扫描集合；language 存在；confidence ≥ auto_download_min_confidence。
  任一不过 → 放弃收编走 ASSRT（绝不误收，宁下载勿错编）。
- 执行：读原件字节 → `writeSubtitle`（复用编码归一化与不覆盖保护）→ **原件不动（复制）**。
- 新 decision：`adopted_local`（FinalDecisionSchema 扩枚举），exit 0；journal 记录收编来源文件。
- 配置：`ADOPT_LOCAL_SUBTITLES`（默认 true）。

## ② 新进资源预热队列（prefetch queue）

- 发现：每 `ARRIVALS_POLL_MINUTES`（默认 15）查
  `/Items?recursive=true&includeItemTypes=Movie,Episode&sortBy=DateCreated&sortOrder=Descending&limit=50&fields=...`，
  与持久化水位线（最新已见 DateCreated）比对，新 item 过触发条件后入队。
- 队列：`<cacheRoot>/queue.json` 持久化（重启不丢）；条目
  `{itemId, name, addedAt, attempts, nextRetryAt, state: 'pending'|'dormant'}`。
- 消费：每 `PREFETCH_INTERVAL_MINUTES`（默认 10）消费 1 条 pending 且到期的；
  **播放触发优先**：watcher 有在途播放任务时本轮消费让路；消费复用 watcher 的
  maybeProcess 全套防线（冷却/去重/根白名单/预检）。
- 触发条件与播放侧完全共用（缺中字、可触发类型、非国产）。

## ③ 国产内容过滤

- `src/daemon/triggers.ts` 增 `isChineseOrigin(item)`：ProductionLocations 与
  {China, Hong Kong, Taiwan, 中国大陆/香港/台湾 等常见表述} 相交 → 跳过；
  **元数据缺失时放行**（宁多查勿漏配）。
- 配置：`SKIP_CHINESE_ORIGIN`（默认 true）。播放触发与队列共用。
- 注：此条为最初 product-shape 既定条件，M2 实现时遗漏，本里程碑补齐。

## ④ 已有字幕跳过缓存

- watcher 对判定"不缺字幕/不可触发/国产"的 item 记入短 TTL 跳过缓存
  （进程内 Map，`SKIP_CACHE_MINUTES` 默认 5），期内同 item 不再 getItem。
- 消除"播放中已有字幕的片每 15 秒一次 getItem"的残余开销；TTL 短保证
  字幕状态变化 5 分钟内仍能被感知。

## ⑤ 失败重试策略（双轨）

- **队列来源失败**（no_safe_match/ask_user）：衰减重试 1d → 2d → 4d → 8d
  （`attempts`/`nextRetryAt` 记于队列），4 次后 `state: dormant`，不再自动重试。
  依据：新片字幕通常在发布后数天至两周内出现。
- **播放来源失败**：不定时重试；负缓存 TTL 由 7 天降至 **24 小时**
  （cache.ts 的 NEGATIVE_TTL_DAYS → 1）；
- **休眠激活**：dormant 的 item 被真实播放时无条件重新激活完整搜索一次
  （播放意图是最强信号）——实现：播放路径查队列，dormant 命中则绕过负缓存
  强制执行，并重置该条目为 pending/attempts=0。
- 衰减重试成功/收编成功/下载成功 → 从队列移除。

## 行为总表

| 场景 | 行为 |
|---|---|
| 新片/新集入库 | 15 分钟内入队，10 分钟节奏慢消费，播放让路 |
| 目录里有孤儿中文字幕 | 收编（复制+规范命名+转码），零下载零配额 |
| 首搜没字幕 | 1/2/4/8 天衰减重试 → 休眠 |
| 休眠片被播放 | 无条件重激活搜一次 |
| 播放时没找到 | 24h 负缓存后可再试 |
| 国产片 | 不触发（可配） |
| 已有字幕的片在播 | 5 分钟跳过缓存，零重复查询 |

## 测试

- 单测：orphanScanner（含约定命名排除、编码样本）、judgeOrphan gate、isChineseOrigin、
  跳过缓存 TTL、队列水位线/衰减/休眠/激活状态机（全 fake 时钟或注入 now）；
- OrbStack 场景：a) 塞孤儿中文字幕 → 播放 → adopted_local 且 ASSRT 零调用；
  b) 新增假电影 → 水位线入队 → 慢消费预热；c) 强制 no_safe_match → 验证 nextRetryAt；
- 路由生产复验：部署后观察真实新进（如有）与收编行为。

## 不做什么

- 不做全库回填扫描（存量老片依然只靠播放兜底）；
- 不做 ask_user 的用户通知通道（已记为独立候选课题）；
- 不做队列的多实例并发安全（单 sidecar 假设）。

## 架构决策：暂不引入 SQLite（2026-07-06，与用户共同确认）

现状全部持久化均为"按 key 点查单条"（决策缓存/响应缓存/档案/队列），单进程单写者，
队列几百条量级——JSON 文件是正确工具，SQLite 是过度设计。

**翻转条件**（满足即重新评估）：做 ask_user 通知/交互通道或任何 UI 时，出现跨实体
多条件查询（待确认列表、下载历史、休眠清单）。届时用 Node 22+ 内置 `node:sqlite`
（零原生依赖，镜像不胖），一次性迁移各文件缓存。
