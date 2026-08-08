# 整晚自主运行 · 终报(2026-07-20 夜 → 21 凌晨)

> 用户就寝前布置的三大相**串行**自主任务。spec `2026-07-20-overnight-autonomous-run-spec.md`,
> plan `docs/superpowers/plans/2026-07-20-overnight-autonomous-run.md`,流水日志 `2026-07-20-overnight-run-log.md`。
> 分工:主循环编排+判官,重活交 opencode company 端点省本账号配额;不用 Workflow;高置信才自动改且测试须绿。

## TL;DR

| 相 | 结果 | 提交 |
|---|---|---|
| **Phase 1 · #12 recognizer** | 调查证伪 D#2 假说——**非 bug,两处皆北极星正确安全 park**;留"票数 tiebreak"设计建议待拍板 | `519bd72` |
| **Phase 2 · E AI 翻译** | 原型方法论**验证达标**(强调轮廓→弱测回归→质量闸,fail-closed 成立);质量闸模块落地;**worker 全量留晨间共执行** | `0da3845` `d57705b` |
| **Phase 3 · 全项目审计** | flake 修 + **新代码质量闸补 2 处 fail-closed 洞**;fetchLib 独立复核干净;persona 路径损坏(inline 绕开) | `a0e45c7` `1dd662c` |

全程全套测试绿(1747→**1758**)、tsc 净、零回退、零夜间生产部署(守省配额)。

## Phase 1 — #12 recognizer 括号密集片名 park(systematic-debugging)

**证伪 D 报告"解析回归"假说**(同 #1 更正):
- **The Astronaut**:解析层完全正确;park 因 TMDB 有**两条精确同 title+year 记录**(1086260 真片/404票
  vs 1435035 空壳/0票)不可约歧义 → `ambiguous` 正确 park。
- **DxD Hero**:解析失败,但"修好"会撞多季红线(`search(tv,"High School DxD Hero")` 得单一 hit=主系列
  45950,折算绝对1→S1E1 装 S4 文件)→ 保持 park 才对。
- 两者 rescue-eligible,系统既定出路(救援 worker + 人工认领)完好。**无代码修复。**
- 报告 `2026-07-20-recognizer-park-investigation.md`。**留一条设计建议**:精确同 title+year 时的票数
  tiebreak(能救 The Astronaut,但改动"不做 popularity 排序"的北极星,需你拍板)。

## Phase 2 — E AI 翻译(原型先行 → 质量闸 → 落项目)

**原型验证达标(2a–2d,2d.3 GO)**:The Rig S2E01 内嵌英文轨前 200 cue——
- 强模型(opus)术语表先行+分批带记忆 → 参照译文术语 100% 符合、通顺、结构完整 → **PASS**。
- 弱模型(deepseek-v4-flash)裸译 → Pictor→"皮克特"专名漂移 → **69.8% FAIL**(回归语料)。
- 质量闸干净判别(fail-closed 成立)。

**已落项目**:`src/translate/qualityGate.ts` 质量闸确定性层(结构/术语符合/CJK,9→11 单测绿,commit
`0da3845`,后经审计加固 `1dd662c`)。

**translateWorker 全量(~2k 行 agent+DB迁移+编排+eval)留晨间共执行**——大功能非高置信机械修、夜跑
生产烧本账号配额,守两铁律。完整落项目计划:`2026-07-21-e-prototype-validation-and-port-plan.md`。

## Phase 3 — 全项目审计

- **自动修 2 组真问题(高置信+测试绿)**:①streamProbe 真二进制 smoke 并发 flaky→显式30s超时
  (`a0e45c7`)②质量闸两处 fail-closed 假放行(聚合稀释 #1 + 非ASCII专名 #3)→ per-term 硬闸 + unicode
  边界(`1dd662c`)。
- **独立复核干净**:fetchLib(#11 interleave/dedup)、recognition(#12 已深挖)。
- **基建教训**:opencode `--agent` 人格路径损坏(Read schema 错+幻觉路径),`--model` 无人格正常;
  可靠解法=待审内容 inline 进 prompt。
- 报告 `2026-07-21-project-audit-report.md`(含低优发现 #2/#4/#6 + gate 设计张力,留晨间定夺)。

## 晨间待办(留用户)

1. **E translateWorker 全量落项目**(计划已备,与我共执行;真机 e2e 用 The Rig S2E1 有人看着跑)。
2. **recognizer 票数 tiebreak** 设计决策(救 The Astronaut 类不可约歧义 vs 守 park 北极星)。
3. **质量闸设计微调**(严格 per-occurrence vs 聚合阈值;低优 #2/#4/#6),随 2e 落地时结合 LLM-judge 调。
4. **recognition/resolveToTmdb 审计 6 条(全部对抗式复核后 → 报告,零自动改**——都环绕 park 北极星的设计
   权衡,非高置信机械修)。最值得看:**#3 丢年重搜只在零 hit 触发,漏"非空但全错年"档**(发布年≠首播年→
   真片取不到→该识别却 park),改进候选=park 前先丢年重搜(retry-before-park)。详见审计报告。

## 未越的红线

- 不夜间自动部署/自动跑生产(新 LLM worker 无人值守写文件+烧配额)。
- 不用 Workflow 工具(直批 opencode 子代理)。
- 不擅动北极星/安全哲学(票数 tiebreak、gate 严格化都留用户拍板,只报告不擅改)。
- 圣文件(realign 5 重安全层)未碰。
