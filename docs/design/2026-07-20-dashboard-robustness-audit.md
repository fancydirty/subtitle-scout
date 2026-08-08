# Dashboard 前端健壮性审计 · 报告与处置（2026-07-20）

只读审计代理扒了 dashboard 四页（Library/Workflow/Triage/Settings）+ shell + api 层 + SSE，聚焦用户最看重的**数据正确性**与**三态健壮性**。8 个确认 bug + 6 个测试缺口。本轮修了最高影响的 3 个（+ 2 个测试缺口随修补齐），其余按严重度与是否需产品拍板分档留办。

## ✅ 已修（commit c04d496，web 278 绿 tsc 净）

| # | 严重度 | bug | 修法 |
|---|---|---|---|
| 1 | **High** | SeriesPage `isNotFoundError` 只认合成串 `'→ 404'`，而真 404 后端 body 是 `{error:'not found'}` → client 返回 `'not found'`。友好"未找到"态是死代码，删过库后深链到已删剧会落进"错误+重试"死循环 | 认 `'not found'` 真信号（该端点 4xx 仅 bad id/not found，唯一对应）；测试从假 payload 改真 payload（原测试是 false positive，测试缺口 A） |
| 2 | Medium | Triage Restore（unexclude）无 try/catch → 失败静默、无 loading 可双提交（四页唯一无错误处理的 mutation） | ExcludedRow 自持 busy/error（行内报错+飞行中禁用），handleRestore 抛错传播（测试缺口 E 补齐） |
| 3 | Medium-high | SSE traceStream 无 `onerror`：致命关闭（server 重启 502/会话失效 401，readyState=CLOSED）浏览器不自动重连，而单例 es 常驻非 null → 直播永久卡死，同时"live"蓝点仍跳（假活） | 加 onerror：CLOSED 时 teardown + 3s 退避重连（重连 onopen 通知 reconnect 补拉 workers），CONNECTING 时不插手原生重连（测试缺口 B 补齐） |

## 🟡 待办·非产品判断（可后续 TDD 修，本轮因风险/收益未动）

- **#6（Low-med）轮询 hook 无中止守卫**：`useLibrary`/`useWorkflowPending`/`useWorkflowPasses`/`useWorkflowWorkers` 的 `load()` 无条件 setState，重叠请求可乱序（陈旧 last-writer）、卸载后 setState。修法=照一次性 hook（useSeries 等）的 AbortController + `if (!signal.aborted)` 既有范式，每发 load 存 ctrl、下一发/卸载时 abort。**LOW 且多为自收敛（同端点），承重代码，建议清醒时单独一 PR 做**（测试缺口 C：hooks 无测试文件，随修补）。
- **#7（Low）`claimedDirs` 集永不清**：认领某目录后该目录被 rescan 清掉、之后同目录落新文件，在常驻的 Triage tab 上会被误置灰（无 Claim 钮）。修法=每次 `triage.reload()` 用新 pending 集对账 claimedDirs（丢掉已不在 pending 的键）。低概率。
- **#8（Low）Rerun 成功不刷新 pending/workers**：`created/revived` 后靠 15s 轮询，刚点的 gap 行会滞留至多 15s。修法=非 coalesced/blocked 结局时 `reload()`。自愈。

## 🔴 待办·需你拍板（涉产品/展示判断，未擅动）

- **#4（Medium 数据正确性）海报覆盖徽章 + 筛选忽略 `partial`、排除 `embedded`**：
  - *partial-only 剧完全隐形*：只有 `partial`（副本时长不一致）问题的剧 `scope=0` → 无徽章、不匹配任何筛选，只在"all"下可见——一个可行动的问题被藏了。
  - *embedded-heavy 剧显示误导 `0/2`*：`embedded:10, missing:2` 的近满覆盖剧徽章显示 `0/2`（embedded 被排除出分子分母），像"什么都没做"。
  - **需你定**：partial 该进哪个筛选/给不给徽章？embedded 排除是否有意（若是，`0/2` 的呈现是否接受）？定了我就 TDD 改（`library/posterAngle.ts` + `filter.ts`）。
- **#5（Med-low）认领失败对话框死路**：ClaimDialog 提交失败后把表单换成只有 Close 的结果态，重试要关掉重开重搜重选。修法=独立 `error` 相位保留表单/给"重试"。属交互设计取舍，你要哪种我照做。

## 📝 by-design 小项（审计记录，暂不动）
DirBrowser "added" 成功提示可能因 `roots.reload()` 重算 startPath 而闪失；SummaryLine "Watching N gaps" 数的是 pending 条目非缺失集数；Topbar 新鲜度加载后不再回落 offline（一直老化的"scanned Xm ago"）；RunDetail `includeThrottled` 跨 run 切换未按 key 重置。均低影响，记录备查。

## 测试缺口总账
A（SeriesPage 404 假 payload）✅随 #1 修 · B（SSE 无失败/恢复测试）✅随 #3 修 · E（ExcludedBox Restore 失败）✅随 #2 修 · **C（api/hooks 无测试文件）**随 #6 · **D（posterAngle 无测试）**随 #4 · **F（ClaimDialog 失败可恢复）**随 #5。
