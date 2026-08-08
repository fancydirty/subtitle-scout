# 死循环修复方案 v3（两轮对抗审计后）

**日期**: 2026-08-08
**前置**: v1 被推翻（3 BLOCKER）→ v2 纳入 → 复审再抓 2 BLOCKER，v3 全部纳入
**测试目录**: 115 Mediary Scout（用户指定，不再碰 nas_media）

---

## 0. 死循环根因（第一性原理）

**"找不到"没有退出机制。** 一个文件搜索无结果（no_safe_match），状态永远是
needs_subtitle=1、sub_status=null，字幕队列永远选中它，后面作品全被堵住。
（Peacemaker S01E08 实测：15 步 no_safe_match 多次，队列反复选中。）

业界统一解法（Bazarr search_frequency / Sonarr Missing 挂起）：
**找不到 → 标记状态 → 退出当前队列 → 按间隔重新轮询**。不是 worker 的错，
是调度器状态机缺"找不到→退避"这条边。

---

## 1. BLOCKER 修复

### B1. 字幕调度器补反编造门（防 2026-07-28 事故重演）

**问题**：新调度器无 trace 核账。步数烧尽的模型会凭空报 no_safe_match
（384 条编造事故），被标 6h unavailable = 假信号永久落库。

**修法**（复用旧管线 findSubtitleWorkerTask.ts:553-575 的做法）：

```
worker 跑完后，对 runKey `job-subtitle:<workId>` 做 traceBus.peek(512)
  （🔴 自审修正：worker 用 `makeRunTracer('job-' + task.jobId)` 写 trace，
  jobId=`subtitle:<workId>`（subtitleScheduler.ts:86），所以 trace 的 runKey 是
  `job-subtitle:<workId>`——peek 必须同 key，差 job- 前缀会 peek 到空。）：
  有 search_source 调用  → no_safe_match 可信 → unavailable + 6h
  零 search_source       → 编造 → 不标 unavailable，recheck_after=now+15min
                             + console.error 吼告警

  🔴 **B-1（复审定罪）：run 前必须先 `traceBus.snapshot(runKey)` 清缓冲。**
  traceBus 的 buf 是 push 追加不重置（traceBus.ts:55），新管线零 snapshot 调用——
  第二次跑同一 workId 时，缓冲里还留着第一次的 search_source 事件，
  peek 会误判"有证据"→ 编造被放行 → fake unavailable 永久落库
  （2026-07-28 事故形状）。旧管线每次收官都 snapshot（findSubtitleWorkerTask.ts:447），
  reconcileAll.ts:137-139 也有"snapshot 的清空副作用当目的"的先例。
  **修法：worker run 前 snapshot 一次（清陈旧），跑完再 peek（看本次）。**
```

### B2. identifyWorker 补超时 + identifyScheduler 补 catch-all 回写

**问题**：identifyWorker 无 AbortSignal（无超时），stepCap 抛错/死循环时
runIdentifyWorkDir 无 catch → 异常穿透 daemon → 零落库 → 每 30s 重选烧钱。

**修法**：
- identifyWorker 的 agent.generate 加 `abortSignal: AbortSignal.timeout(timeoutMs)`
  （timeoutMs 随 fileCount 伸缩：`min(5min + 2s*fileCount, 1h)`——🔴 M-3 复审：
  "识别通常更快"对大目录不成立，1000 文件的海贼王 30min 平值必超时，
  且"60 一包"只存在于旧字幕管线，识别是一个 work_dir 一个 session）
- identifyScheduler 的 runIdentifyWorkDir 包 try/catch：
  - 任何抛错 → `attempt+1, next_retry_at = now + retryDelayMs(attempt+1)`
    （复用已有 1h→4h→24h 阶梯）
  - stepCap 决议保留 100000（用户裁决"不设限"，但超时 + catch 是机械底线）

### B3. 字幕调度器 catch-all：非 TimeoutError 的抛错也回写

**问题**：方案 v1 只写"超时抛错 → 15min"。只读根 ENOENT、沙盒断言、LLM 5xx
这些非超时抛错不触发回写 → 文件保持 recheck_after=NULL → 每 30s 重选
（正是 Peacemaker 死循环原始形状）。

**修法**：runSubtitleWorkDir 包 try/catch，判别 `err.name === 'TimeoutError'`
（AbortSignal.timeout 抛 DOMException，见 adapters/download/direct.ts:43 先例）：

```
catch (e) {
  const isTimeout = e?.name === 'TimeoutError'
  for (const f of item.files) {
    db.prepare('UPDATE files SET recheck_after = ?, last_error = ? WHERE path = ?')
      .run(now + (isTimeout ? 15min : 30min), isTimeout ? 'timeout' : String(e).slice(0,100), f.path)
  }
  // 抛回给 dispatcher 但不让它崩 tick（daemon 已 log）
  // 🔴 M-2（复审）：错误轨同样走 attempt 阶梯（15min→1h→4h→24h），
  // 不能恒 30min——永性错误（沙盒断言/TMDB 持续 5xx）的文件每 30min 烧一轮整簇 LLM，
  // 是 M1 定罪"恒 15min 烧 19h"的同一病换剂量。
}
```

---

## 2. 核心修复（v1 保留）

### 2.1 files 表加 recheck_after（schema v31）

```sql
recheck_after INTEGER  -- NULL=可立即处理；时间戳=此时间后才能重新入字幕队列
```

与识别轨的 next_retry_at 分列，不混淆（识别只挑 work_id IS NULL，字幕只挑
needs_subtitle=1——两队列天然不相交，审计 n1 确认）。

### B-2（复审定罪）：无结局文件必须回写

三桶（installed/no_safe_match/retry_later）不保证覆盖全部 targets
（FindSubtitleBatchReportSchema 各桶独立 tolerantArray，无覆盖率校验，schemas.ts:151-158）。
itemId 可 null（job 34 实测，schemas.ts:139-144 显式容忍）→ null-itemId 的判无条目无法归因。

**修法**：收官时对 item.files 中**未被任何桶覆盖**的文件统一写
`recheck_after=now+15min + last_error='no-outcome'`——残留子集不能永远 needs=1。

### 2.2 字幕调度器回写状态（按文件粒度）

```
installed     → sub_status='covered', needs_subtitle=0
no_safe_match → 反编造门通过 → sub_status='unavailable', recheck_after=now+6h
                 反编造门拒绝 → recheck_after=now+15min（不标 unavailable）
retry_later   → recheck_after=now+15min
超时           → recheck_after=now+15min
其它抛错       → recheck_after=now+30min + last_error
```

**retry_later/超时轨用退避阶梯**（审计 M1：恒 15min 会让永不 finalize 的模型
每天烧 19 小时 LLM）。files 表已有 attempt 列，字幕轨复用：

```
attempt 0 → 15min；1 → 1h；2 → 4h；≥3 → 24h（封顶）
```

### 2.3 字幕队列 SQL 消费 recheck_after

```sql
WHERE f.needs_subtitle = 1 AND (f.recheck_after IS NULL OR f.recheck_after <= :now)
ORDER BY w.id, f.season, f.episode
```

### 2.4 移除步数上限（遵守用户裁决）

identifyWorker / findSubtitleWorker 的 `stepCap ?? N` → 100000。
反编造门（B1）+ 超时（B2）+ catch-all（B3）是防线，stepCap 不再是防线。

---

## 3. 115 测试目录切换（用户指定）

**审计 M2 指出 v1 方案方向错了**：说"把 media_roots 改成 115"是反向的——
115 是测试专用，生产 roots 应该是用户的真实库。正确做法：

```
测试环境（本机/软路由验证）：
  media_roots = 115 的 Movies/TV/Anime（只读）
  🔴 只读根必须显式关字幕派发——否则每 tick 字幕队列选中 115 的簇
     → staging 沙盒 ENOENT → 死循环
  dispatcher 加 roots 的 writable 检测：只读根跳过字幕派发（识别照常）

生产环境（用户真实库）：
  media_roots = 用户的真实目录（可写）
  daemonV2 正常跑字幕
```

**实现**：dispatcher 检查每个 root 的写权限（试写临时文件），不可写的 root
只在识别队列使用，不进字幕队列。这是"挂载能力画像"的既有概念
（core/mountCapabilities.ts，doctor 用它检测可写性）。

**验证流程**：
1. 115 只读：扫描 + 识别 + 判定（刮削验证）
2. 115 只读：字幕队列应被跳过（不 ENOENT、不死循环）
3. 可写临时目录（/tmp/test-media 之类）：字幕装盘端到端验证一次
4. 生产：daemonV2 配真实 roots，正常跑

---

## 4. 审计 MAJOR 的处理

| # | 问题 | 处理 |
|---|---|---|
| M2 | 115 只读与字幕派发矛盾 | §3 解决（writable 检测） |
| M3 | 超时整簇丢失部分装机成果 | 记为已知限制（v2 不拆簇——一簇一 session 是用户裁决，部分成果在 recheck 时重试）。至少记 runs/日志 |
| M4 | covered 是终态，删字幕不重查 | 记为已知限制（当前不重查，将来可加"磁盘 sidecar 消失 → 翻回 missing"的扫描时重判，同旧管线 libraryRepo.ts:658-660 的翻篇语义） |
| M1 | 退避阶梯 | §2.2 用 attempt 阶梯（15min→1h→4h→24h） |
| M5 | 识别轨失败无回写 | B2 解决（catch-all + 阶梯） |
| n3 | covered 误挂（前缀碰撞） | 🔴 复审修正：itemId **可 null**（job 34），不能只按 itemId 匹配。装机判定改为：**优先 itemId 精确匹配，null 时回退 installedPath 前缀法**（subtitleScheduler.ts:141 现码） |

---

## 5. TDD 实现计划

### 步 1：schema v31（recheck_after 列）
- db.ts 追加迁移 + db.test 更新

### 步 2：字幕调度器回写 + 反编造门 + catch-all
- subtitleScheduler.ts：
  - runSubtitleWorkDir 包 try/catch（TimeoutError 判别）
  - 回写状态（covered/unavailable/recheck_after）
  - traceBus.peek 核账（反编造门）
  - 装机判定改 itemId 精确匹配
- 测试：installed→covered / no_safe_match+有搜索证据→unavailable+6h /
  no_safe_match+零搜索→15min / retry_later→15min / 超时→15min /
  非超时抛错→30min / covered 不重选 / unavailable 不重选

### 步 3：字幕队列 SQL 消费 recheck_after
- subtitleScheduler.listSubtitleQueue 加过滤
- 测试：recheck_after 在未来→不入选；已过→入选

### 步 4：步数上限移除 + identifyWorker 超时 + identifyScheduler catch-all
- identifyWorker：stepCap→100000，agent.generate 加 timeoutMs
- findSubtitleWorker：stepCap→100000
- identifyScheduler：runIdentifyWorkDir 包 try/catch（attempt 阶梯）
- 测试：识别抛错→next_retry_at 推进

### 步 5：115 只读切换 + writable 检测
- dispatcher 加 root writable 检测（试写临时文件）
- 只读根跳过字幕派发，识别照常
- 测试：只读根→字幕队列跳过 / 可写根→正常

### 步 5b：dispatcher 每 tick 轮转（M-4）
- 识别和字幕每 tick 各派一项改为**轮转**（奇偶 tick 交替），避免识别长跑阻塞字幕
- 测试：识别忙时字幕仍能派发（不饿死）

### 步 6：端到端验证
- 115 只读：扫描+识别+判定（刮削全通）
- 可写临时目录：字幕装盘一次
- 死循环验证：no_safe_match 文件退出队列 6h，不反复选中

---

## 6. 验收

| 门 | 判据 |
|---|---|
| tsc | 0 错 |
| 测试 | 全部新测试绿，既有 7 红基线不变 |
| 115 刮削 | 83 作品全识别、判定正确 |
| 死循环 | no_safe_match 文件 6h 内不重选，队列推进到其它作品 |
| 字幕装盘 | 可写目录端到端装盘成功 |
| 步数 | identify/subtitle 无 stepCap 上限（100000） |
