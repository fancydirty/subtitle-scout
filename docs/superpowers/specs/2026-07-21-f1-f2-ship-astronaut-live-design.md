# 战役设计:F1+F2 收口上线 + The Astronaut 长片 live test

日期:2026-07-21 · 状态:**用户授权自主推进**(除推公开 GitHub 外:commit/部署/烧配额均可)

## 1. 目标

把本会话已验收的 **F1(源语言外挂 en 腿)+ F2(jimaku ja 源)** 收口进 git 并部署生产;
用被 park 的长片 **The Astronaut (2025)** 做 agent 翻译压力 live test;
建立会话内「心跳」节奏(不依赖外部 cron 工具)。

成功标准:
1. 本地 diff commit 到 main(不 push origin/public)
2. 生产镜像含 F1+F2;服务器 `.env` 配 `TRANSLATE_*` + `JIMAKU_API_KEY`
3. The Astronaut 从 `parked_paths(ambiguous)` → 入库 movies → `translate-item` 跑通
4. 产出中文字幕:gate pass 或诚实 held(fail-closed);人肉抽验通顺/术语/结构
5. 测试基线 ≥1873 绿 + tsc 净

## 2. 背景与约束

### 已建成(本会话,未 commit)
- F1 加固:batchRetries 默认 2;TRANSLATE_TIMEOUT_MS 默认 300s
- F2:JimakuClient + adapter + PROVIDERS + SUPPORTED_SOURCE_LANGS={en,ja}
- prompt 源语言参数化;jimakuQueryVariants(长全称回退)
- 本地 F2 E2E:Frieren S01E01 → jimaku:729 → installed 术语 100%
- 本地 F1 E2E:fetch OS 通;全量译后术语闸 held(正确 fail-closed)

### The Astronaut 现状(生产真机)
- 路径:`/media/movies/The Astronaut (2025)/The Astronaut (2025) [2160p] [4K] [WEB] [5.1] [YTS.MX].mkv`(~4.3GB)
- `parked_paths.park_reason=ambiguous`(TMDB 双记录 1086260 真片 vs 1435035 空壳)
- 内嵌轨:PGS eng SDH(图) + **subrip 文本轨**(无 language tag,hearing_impaired=1)→ **走 E 内嵌腿**,不依赖 F1 fetch
- 片长 ~90min → 长批串行,考验超时/重试/术语一致性/critic
- 解 park:**写 `identify_overrides`**(path_prefix → tmdb:1086260,is_tv=0),触发 ingest——**不**改 pickUniqueHit 票数 tiebreak(仍留评审)

### 授权边界(用户 2026-07-21 明确)
| 动作 | 是否可自主 |
|---|---|
| commit 本地 main | ✅ |
| 部署 media-router | ✅ |
| 烧 company/TRANSLATE 配额 live test | ✅ |
| 服务器写 TRANSLATE_*/JIMAKU_* | ✅ |
| **push 公开 GitHub** | ❌ 必须当次获准 |

### 心跳(opencode 官方能力核查)
- 官方 CLI/docs:**无**会话级 15min timer/heartbeat 原语
- 有:`opencode run --continue/-c`、`session list`、experimental `BACKGROUND_SUBAGENTS`、`doom_loop` 权限键
- **本战役心跳协议**(会话内,不引外部 cron):
  1. 长任务一律 `nohup` + `/tmp/<job>-done` + log
  2. 主控短轮询(不挂 10min 死 shell);间隔 2–5min 查 done/进程/log 尾
  3. 关键节点写 `docs/design/2026-07-21-campaign-run-log.md` 一行状态
  4. 若会话中断:用户/新会话读 run-log + handoff 续

## 3. 架构与步骤(方案 A — 推荐)

```
[本地] commit F1+F2
   ↓ rsync 白名单
[生产] docker build+up (media-router 直连)
   ↓ 写 .env TRANSLATE_* + JIMAKU_API_KEY + 重启
[生产] identify_overrides 认领 Astronaut → ingest
   ↓
[生产] translate-item <Astronaut mkv>  (E 内嵌 subrip → 管道)
   ↓
人肉抽验 + run-log 收口
```

### 为何不先改票数 tiebreak
- 调查已定:ambiguous park 是北极星正确行为;救援路径=override
- 战役目标是**翻译 live test**,不是 recognizer 设计变更
- override 一条即可解锁 Astronaut,零北极星风险

### 部署 env(生产)
从本机 `.env` 同步(不进 git):
- `TRANSLATE_BASE_URL` / `TRANSLATE_API_KEY` / `TRANSLATE_MODEL=claude-opus-4-8`
- `JIMAKU_API_KEY`
- 已有 OS/ASSRT/TMDB 等保持
- **不**开会误烧的弱路径;daemon 自动 translate 在 TRANSLATE_* 齐后会醒——接受(用户授权)

### 可选加固(同批若有余力,TDD)
- ja 搜索时 jimaku 排序优先于 OS(减少 OS 日字抢跑)
- 非阻塞;Astronaut 是 en 内嵌腿,不依赖此项

## 4. 错误处理

- 部署 build 超时:nohup + done 标记(busybox 用 /proc)
- translate held:记录 gate/critic 原因,不降闸阈值;若超时类→确认 300s/retry 已在镜像
- override 后仍无 movies 行:查 ingest 日志/负缓存
- 配额耗尽:停自动 daemon 任务,记 run-log,不静默回退 mimo

## 5. 测试

- commit 前:`npx vitest run` ≥1873 + `npm run check`
- 生产:Astronaut translate-item 退出码 + sidecar 存在性 + 抽 10+ cue 对照
- 不把 live 结果当单测夹具(过大/配额)

## 6. 非目标

- push origin/GitHub
- pickUniqueHit 票数 tiebreak
- critic reflect-refine / 标签冻结
- 公开 README 宣传页

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 90min 片翻译 1h+ 占会话 | nohup+done;run-log 可跨会话 |
| 术语闸对长片 held | 接受 fail-closed;记录发现 |
| 生产自动 translate 醒后烧配额 | 用户已授权;可用 TRANSLATE_CRITIC 等保持 |
| company 端点慢 | 已 300s timeout + retry |
