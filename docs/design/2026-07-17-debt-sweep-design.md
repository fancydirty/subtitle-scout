# 债务清扫波 · Spec（2026-07-17）

出处：dashboard 战役与验收轮登记在案的零散债务，六件独立小刀，无相互依赖，可穿插执行
（K3 一单一件）。

## D1 receipts 截断改良

trace 痕迹 resultSummary 200 字符 cap 让 dispatch 回执大量 unparsed（真站 42/64）。修法：
reasoningAgent 的 summarizeForTrace 对 `dispatch_` 前缀工具的 result 放宽到 400 字符（回执
JSON 完整存活），其余工具维持 200（直播可读性）。passes 端点 receipts 解析命中率随之回升。

## D2 serveStatic 前缀穿越

`startsWith(normalize(distDir))` 可被兄弟目录（web/dist-old/x）穿越——战役前遗留（872dbab）。
修法：比较改 `resolved === distDir || resolved.startsWith(distDir + sep)`。测试：`../dist-evil`
与 `dist-old` 路径 404。

## D3 quota 呈报通道

provider 配额事件（emitQuotaNotice/emitQuotaExhausted，现只进日志）落 settings 表旁路键
`quota_state_<provider>`（JSON: {state, resetAt, at}）；workers 端点附 `providerQuota` 字段；
Workflow 页 Activity 顶部出现一行中性事实句（英文，如 `opensubtitles quota exhausted · resets in 3h`，
灰点不红块）。恢复=下次成功调用清键。

## D4 TmdbClient 代理/镜像配置口

env `TMDB_BASE_URL`（默认 api.themoviedb.org/3）+ `TMDB_PROXY_URL`（undici ProxyAgent，可选
依赖缺席时忽略并告警一行）。部署区 nonSecrets 展示两键。CN 直连超时的部署解药（老容器同病）。

## D5 settings 消费补齐（点亮最后两个装饰品 + 重启债）

- `scan_interval_ms`：daemon tick 间隔改惰性读 settings（每轮 tick 取值，同 roots 提供者化手法），
  env SCAN_INTERVAL_MS 降级为默认值来源。设置页注记改"已生效"。
- `trace_retention_days`：daemon 每日一次 `DELETE FROM runs WHERE finished_at < now-N天 AND
  trace_json IS NOT NULL` → 只清 trace_json 列（`UPDATE ... SET trace_json=NULL`），runs 账目
  行本身永久保留（痕迹是过程证据可修剪，账目不可）。注记改"已生效"。
- `target_languages`：resolve 提供者化（ingest/worker 派发时新鲜求值，同 roots 先例），
  设置页"需重启"注记退役。

## D6 富化重试候选谓词护栏

listSeriesNeedingEnrich 对"TMDB 真无 genres"的剧每轮空转击穿（V1 自审已记）。修法：
series 加列不划算——用 genres='[]'（空数组）与 NULL 区分"查过但没有"与"没查过"（enrich 拿到
空数组也落 '[]'），谓词只认 NULL。一行迁移不需要：applyEnrichment 现逻辑已 COALESCE，
只需 enrich 返回空数组时也写。

## 验收口径

各件独立：D1 真站 passes unparsed 显著下降；D2 测试锁死；D3 打满配额时 Workflow 可见事实句；
D4 test rig 配镜像后 TMDB 超时消失；D5 三注记全变"已生效"且行为可观察；D6 富化重试日志不再
每轮重复同一批剧。
