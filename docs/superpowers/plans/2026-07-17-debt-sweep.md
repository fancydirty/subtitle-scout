# 债务清扫波 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。
> 执行器=K3（`opencode run -m company/kimi-k3 "<任务书>"`，Bash 后台，任务书自带全部上下文——K3 无跨调用记忆且有输出长度天花板：**一单一件，任务书要求"必须以汇报格式收尾+commit"**，主控每单验尸+鲜验+可能续作派单）。铁律：不碰 src/agent/skills/；`.claude/`/`.omo/` 不入 commit；trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

**Goal:** spec=docs/design/2026-07-17-debt-sweep-design.md 六件独立小刀。

**顺序无依赖，逐件：**

### T1: D1 receipts 截断改良
Modify `src/agent/reasoningAgent.ts`+test。summarizeForTrace 加第三参或按 tool 名分档：onStepEnd 派发处对 `call.toolName.startsWith('dispatch_')` 的 resultSummary 用 cap 400，其余 200。测试：dispatch 工具 300 字符结果不截断、普通工具 300 字符截到 200。commit `fix(债务D1): dispatch 回执痕迹 cap 放宽 400——unparsed 治理`。

### T2: D2 serveStatic 前缀穿越
Modify `src/dashboard/server.ts`+test。serveStatic 内比较改 `resolved === base || resolved.startsWith(base + sep)`（`node:path` 的 sep）。测试：`/x/../dist-evil/a.js` 与同前缀兄弟目录 `distDir + '-old'` 下文件均 404，正常资源 200。commit `fix(债务D2): serveStatic 同前缀兄弟目录穿越封堵`。

### T3: D3 quota 呈报通道
Modify `src/cli/index.ts`（emitProviderEvent 处捕 quota 事件写 settings 旁路键）、`src/dashboard/apiV2.ts`+test（workers 端点附 providerQuota——读 `quota_state_%` 键 JSON parse）、`src/cli/buildAdapters.ts`（成功 resolve 清键——看 emitQuotaNotice/emitQuotaExhausted 调用点决定清键位置，实施者先读 src/cli/fetchLib.ts 事件类型）、`web/src/workflow/`（Activity 顶部事实句行：灰点+`{provider} quota exhausted · resets {相对}`，i18n 不涉及——Workflow 英文区）+web 测试。commit `feat(债务D3): provider 配额事实呈报——settings 旁路键 + workers 端点 + Activity 事实句`。

### T4: D4 TMDB 代理/镜像配置口
Modify `src/adapters/providers/tmdb.ts`+test（TmdbClientOpts 加 baseUrl（默认现值）；proxy：构造时 `TMDB_PROXY_URL` 有值则动态 import('undici').ProxyAgent 挂 dispatcher，import 失败告警一行继续直连）、`src/cli/index.ts` assemble 处透传两 env、`src/dashboard/apiV2.ts` DEPLOY_NONSECRET_KEYS 补两键。测试：baseUrl 注入后请求 URL 前缀断言；proxy env 缺席零行为变化。commit `feat(债务D4): TMDB_BASE_URL/TMDB_PROXY_URL 配置口——CN 直连超时解药`。

### T5: D5 settings 消费补齐
Modify `src/v2/daemon.ts`+test（tick 间隔惰性读：DaemonDeps 加 `scanIntervalMs: () => number`，cmdWatch 传 `() => Number(settingsRepo.get('scan_interval_ms')) || envDefault`；trace 修剪：daemon 每日 job `UPDATE runs SET trace_json=NULL WHERE finished_at < ? AND trace_json IS NOT NULL`，N=trace_retention_days settings||30）、`src/cli/targetLanguages.ts` 消费点提供者化（ingest deps targetLanguages 改 `() => string[]`、worker 派发时新鲜求值——沿 G4 roots 同款手法，改动面：ingest.ts/cli/index.ts/findSubtitleWorkerTask spread 处）、`web/src/settings/BehaviorSection.tsx` 三条注记文案改"已生效"（en/zh）。commit `feat(债务D5): scan_interval/trace_retention/target_languages 真消费——设置页零装饰品`。

### T6: D6 富化重试谓词护栏
Modify `src/v2/ingest.ts`+test、`src/v2/libraryRepo.ts`。enrich 返回 genres 空数组时也落 `'[]'`（现在 null 才不写——查 applyEnrichment/upsertSeries 两路，确保 `[]` 能落库）；listSeriesNeedingEnrich 谓词不变（只认 NULL）。测试：TMDB 回空 genres 的剧富化一次后不再出现在候选清单。commit `fix(债务D6): 空 genres 落 '[]'——富化重试不再空转击穿`。

### 收官
双侧全绿 → 重部署测试台 → 六件验收口径逐条过 → 登记册补一行。

## 自审
spec D1-D6 全覆盖；类型链：scanIntervalMs 提供者签名 T5 内自洽；无 TBD。契约级粒度=房风（主控亲核兜质量）。
