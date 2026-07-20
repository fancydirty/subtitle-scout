# 整晚自主运行 · 运行日志(2026-07-20 夜)

> 心跳与续跑读本文件定位相位。plan:`docs/superpowers/plans/2026-07-20-overnight-autonomous-run.md`。

## 当前相位

**Phase 3 — 全项目审计(agency 人格,高置信自动修)**

- 状态:进行中 · 3.1 分维度派 opencode 人格审
- 心跳:job 607c49d0(每 15 分钟)。

### Phase 2 收口 ✅(E 原型验证达标 + 质量闸落地;worker 留晨间共执行)
- 2a–2d 全部完成,**2d.3 质量门 = GO**(强译 PASS 100%术语 / 弱译 FAIL 69.8% 被拦 = fail-closed 成立)。
- 已落项目:`src/translate/qualityGate.ts`(commit `0da3845`,9 单测绿,真数据验证)。
- 完整记录 + 2e worker 落项目计划:`docs/design/2026-07-21-e-prototype-validation-and-port-plan.md`。
- **worker 全量(~2k行 agent+DB迁移+编排)留晨间共执行**:大功能非高置信机械修、夜跑生产烧配额——守"高置信才自动改"+"省配额"两铁律。task #10 保持 in_progress(部分完成)。

### Phase 2 历史流水
- 2a✅ The Rig S2E01 内嵌英文轨→前200 cue 切片。2b✅ 强模型术语表48条+参照译文(bg bodps3tay)。
- 2c✅ 弱模型回归语料(bg bbzx1f2s2,Pictor→皮克特漂移)。2d✅ 闸干净判别(srtGate 原型→项目模块)。
- 语料:The Rig S2E01 内嵌英文轨抽出→前200 cue 切片 `scratch/e-proto/source-rig200.eng.srt`(术语丰富:Rose/钻井平台/seismic)。
- 2b/2c 并行(独立)。闸建好后:读两译文→闸放行强译、拦弱译→2d.3 质量门决策。
- **2b 术语表已落地且质量极高**(48 条:罗斯/科克/皮克托/始祖体/有机体/阻断剂/环层/北海…),强模型确产出 E 需要的术语锚。
- **早现缺陷**:弱模型写 199 cue(非200)——结构漂移,正是闸该抓的。
- 闸原型脚本:`scratch/e-proto/srtGate.mts`(结构+术语符合+CJK 三确定性层;LLM-judge/回译待加)。
- 等待中:ref-rig200.zh.srt(强译)落地 → 跑闸(ref 应 PASS、weak 应 FAIL)。后台任务完工发通知,心跳 15 分兜底。
- 心跳:job 607c49d0(每 15 分钟)。

### Phase 1 收口 ✅(#12,非 bug,已证伪 D#2 假说)
- 结论:两处 park 皆北极星正确安全失败,非解析回归。**无代码修复**。
- 产物:`docs/design/2026-07-20-recognizer-park-investigation.md`(调查报告);更正 D 报告 #2 + roadmap;留"票数 tiebreak"设计建议待用户拍板。
- 提交:见下方 git 记录。task #12 → completed。

## 进度流水

- [已复现] Phase 1 Step 1.1/1.2 — **D 报告假说被证伪(systematic-debugging)**:
  - **The Astronaut**:解析层完全正确(title="The Astronaut" year=2025 isTv=false)。park 原因是 `ambiguous`——真实 TMDB `search(movie,"The Astronaut",2025)` 返回**两条相同记录**(id=1086260 与 id=1435035,标题/original/年份全同)→ pickUniqueHit 年份+clean-title 都不收窄 → 正确 park。**不是解析 bug,是 TMDB 重复条目的不可约歧义,park 是北极星正确行为。**
  - **DxD Hero**:lib 对 `[The-Nut]` 前缀完全解析失败(整名含 .mkv 当 title)→ park no-signal。但改进解析会撞多季红线(Hero=S4,绝对1 vs 季内1 歧义),**保持 park 正确**。
  - 结论方向:#12 大概率是"正确的安全 park"非可修 bug;取证坐实中(Astronaut 两记录元数据 + ambiguous/no-signal 是否可人工认领)。
