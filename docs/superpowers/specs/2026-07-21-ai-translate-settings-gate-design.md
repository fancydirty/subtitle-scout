# 设计:AI 翻译设置页开关 + 两个健壮性修复

日期:2026-07-21 · 状态:用户授权(除推公开仓外全自主)

## 1. 背景与目标

**用户核心判断**:有了 AI 翻译后理论上"没有拿不到的字幕",但翻译 token 消耗随无字幕媒体数量增长,
会极度消耗用户配额。因此 AI 翻译必须是**默认关、用户显式开**的行为级开关(放设置页),而不是
"配了 TRANSLATE_* 就自动跑"。指数退避/停牌仍是常规路径,翻译只作兜底且受开关约束。

三个任务:
1. **AI 翻译开关**:settings 新增 `ai_translate_enabled`(true/false,默认关),设置页行为区加 Switch;
   daemon 派活需 `TRANSLATE_*` 三件套 **且** 开关=true;手动 CLI 不受开关限制(用户显式动作)。
2. **CLI 写盘后挂起修复**:`translate-item` 完成后主动退出(进程不被 fetch keep-alive 挂住)。
3. **ja 源优先级**:languages 含 `ja` 时,jimaku 候选排在 OS 之前(避免 OS 日字抢跑导致 critic held)。

## 2. 现状与约束

### 开关
- 行为级 settings 白名单五键(target_languages/hardsub_mode/exclude_extras/trace_retention_days/scan_interval_ms),
  读写经 `SETTINGS_KEYS` + `SETTINGS_VALUE_SCHEMAS`(zod) + `updateSettings`,前端 BehaviorSection 单键 PUT。
- daemon 注入:`dispatchTranslate: tryAutoTranslateCfg() ? () => dispatchTranslateTasks(db, jobs, now) : undefined`。
- 手动 CLI:`cmdTranslateItem` 独立走 `translateLlmCfg()`,与 daemon 分离。
- **门控语义**:开关管的是"系统会不会在没有用户当场指令时烧配额"(daemon 自动)。用户手动跑
  `translate-item` 是显式授权,不该被 dashboard 开关挡住(与手动 run-item 不受负缓存天然节流同理)。

### 挂起
- The Astronaut 生产实测:sidecar 已写,`translate-item` 进程不退(单线程 S,stdout pipe)。
- 已知:fetch/undici 默认 keep-alive;`cmdTranslateItem` 依赖 `process.exit()` 在函数末尾,但
  Node 事件循环有活 handle 时 exit 前的 await/句柄延迟进程收尾(常见 undici 场景)。
- 最小修复:`cmdTranslateItem` 在打印结果后显式 `process.exit(code)`(已有),并确保不等待无用
  异步句柄;给 fetch 路径一个可关闭点成本太高——**接受 exit 强制收尾**是正确取舍。

### ja 优先级
- `runSearch` 对多 provider 结果用 `interleaveByProvider` round-robin,按 adapters 入列顺序
  (assrt→opensubtitles→zimuku→subhd→jimaku)。ja 搜索时 OS 也收 ja,可能在前几位塞日字。
- F2 实测:OS 日字曾触发 critic held(漏译),jimaku 日字 installed——jimaku 质量更稳。
- 修法:languages 含 ja 时把 jimaku 的结果数组排到最前再 interleave(或排序 enabled adapters)。
  最小:在 `runSearch` 完成后,若 `args.languages` 含 ja,把 `provider==='jimaku'` 的候选移到头部。

## 3. 方案(推荐 A,均最小侵入)

### 3.1 ai_translate_enabled

- `SETTINGS_KEYS += 'ai_translate_enabled'`;schema `z.enum(['true','false'])`。
- `buildSettings`/`SettingsDTO`/前端 `SettingsKey`/`BehaviorSection` 加 Switch 行(注记:默认关;
  开后 daemon 会在候选出现时自动翻译并烧 TRANSLATE_* 配额;仍需部署层三件套)。
- daemon 门:`tryAutoTranslateCfg() && settingsRepo.get('ai_translate_enabled')==='true'` 才接
  dispatchTranslate;worker claim 端**保持** tryAutoTranslateCfg 检查(开关只管派活,存量行若被
  claim 仍按 env 判,避免开关抖动把在途任务变错误)。
- 手动 CLI 不读开关。
- 生产当前 TRANSLATE_* 已配但开关未设 → 自动翻译**关闭**(符合"默认不开"),手动可用。

### 3.2 CLI 挂起

- `cmdTranslateItem`:收尾统一走 `finally { db?.close() }`,并在**打印结果后立即**
  `process.exit(code)`(不再依赖 return 后自然退出)。不引入 dispatcher 关闭(侵入大)。
- 若未来仍挂:daemon 路径不 exit(daemon 常驻),只 CLI 强制;daemon 的 keep-alive 由进程常驻
  复用,是正常行为。

### 3.3 ja 优先

- `fetchLib.runSearch` 在 dedup 后:若 languages 含 ja(`ja|jpn|jp-` 前缀),将 jimaku 候选
  stable-partition 到前。不影响 en/zh 路径。
- 理由:jimaku 是日字专门源、真机质量更好;机械重排不做"哪个源更对"的语义判断(北极星#2)。

## 4. 错误处理

- 开关非法值:zod 400,不入库。
- 开关未设:daemon 不派活(默认关),手动可跑。
- runSearch 全 provider 失败仍抛(既有纪律不变)。

## 5. 测试(TDD)

- apiV2:白名单含新键;true/false 可写;坏值 400;buildSettings 未设=null。
- BehaviorSection:渲染新 Switch;PUT ai_translate_enabled。
- cli/index 门控:开关 false/未设 → dispatchTranslate undefined;true → 接线(注 cli 测试面
  若无,改在可注入点或走 translateWorkerTask 层单测)。
- fetchLib:ja languages 下 jimaku 排前;en 不变。
- 全量 ≥ 基线 + tsc;web 测试跑通。

## 6. 非目标

- 推公开仓
- 改手动 CLI 受开关限制(明确不受)
- 票据 tiebreak、critic reflect-refine、标签冻结
- TRANSLATE_* 自动写部署层(仍用户/部署层职责)

## 7. 风险

| 风险 | 缓解 |
|---|---|
| daemon 存量 translate 行 | worker 端仍 env 门,开关只断派活 |
| 用户忘开导致"怎么不自动翻" | 设置页注记写清默认关+需三件套 |
| ja 重排误伤 | 仅 ja 路径,加回归测试 |
