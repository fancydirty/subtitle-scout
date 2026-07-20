# 整晚自主运行 · 运行日志(2026-07-20 夜)

> 心跳与续跑读本文件定位相位。plan:`docs/superpowers/plans/2026-07-20-overnight-autonomous-run.md`。

## 当前相位

**Phase 2 — E AI 翻译(原型先行→质量闸→落项目)**

- 状态:进行中 · Step 2a 原型语料(从 NAS 抽真英文字幕)
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
