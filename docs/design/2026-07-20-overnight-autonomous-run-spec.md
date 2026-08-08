# 整晚自主运行 · 设计规格(2026-07-20 夜)

用户 2026-07-20 23:00 就寝前口述:接下来是**整晚自主任务**,三大步**串行、一步一个脚印**(用户:串行几小时能收完,正因事多才要稳)。本文件是这一夜的作战规格;配套逐步计划见 `docs/superpowers/plans/2026-07-20-overnight-autonomous-run.md`。

## 目标 & 硬约束

- **三相串行**:① #12 recognizer 修 → ② E AI 翻译(原型先行→落项目)→ ③ 全项目审计。前一相收口提交后才进下一相。
- **省本账号配额**:重活全交 **opencode company 端点**子代理跑;主循环 Claude(本账号)只做**编排 + 判断 + 对抗式复核**,不亲自写大段实现。
- **不用项目 Workflow 工具**(用户铁律 [[feedback-subagents-over-workflow]]);opencode 子代理经 `Bash → opencode run` 直批。
- **可续跑**:每相 + 每关键节点提交 + 更新 roadmap/日志,中途 compact 也能按计划续。

## 编排模型

- **主循环 = 编排官 + 判官**:设计 prompt、派活、判质量、对抗式复核子代理产物、决定是否落地/提交。
- **opencode workers = 干活层**(company 端点,独立配额)。调用式:`opencode run --model <provider/model> "<prompt>"`(或 `--agent <persona>`)。
- **实测已验(2026-07-20 夜)**:company 端点通(opus-4-8 / kimi-k3 均正常翻译);deepseek-v4-flash 通(弱层);agency 人格在(sisyphus/hephaestus/oracle/**momus**/atlas…)。⚠️注:opencode 默认 persona 会自动调 `using-superpowers` skill(每次多一步开销,纯翻译子代理可接受;必要时用更瘦的调用)。

## 模型盘

| 角色 | 模型 | 用途 |
|---|---|---|
| 编排/判官 | 主循环(本账号) | 设计、判质量、复核、提交决策 |
| 强(轮廓/参照/实现) | `company/claude-opus-4-8` 主 + `company/gpt-5.6-sol` 交叉 | E 调出"好翻译"轮廓 + 参照译文;实现子代理 |
| 弱(回归引擎) | `deepseek/deepseek-v4-flash` | 制造 plausible-but-flawed 译文当回归语料(实测会把专名从"金洛克"漂成"金洛奇"——正是 E 术语表要抓的) |
| 审计人格 | opencode `momus`(批判)+ `oracle`(分析) | Phase 3 找问题 |
| 强开源备选 | `company/kimi-k3` | 用户明确 kimi-k3 是强模型、非弱队,备用/交叉 |

## Phase 1 — #12 recognizer 修(systematic-debugging + TDD)

**症状(D 大考实证)**:两类括号密集/非常规发布名再识别失败被 park:
`The Astronaut (2025) [2160p] [4K] [WEB] [5.1] [YTS.MX].mkv`(整片消失 movies 10→9)、
`[The-Nut] High School DxD Hero - 01..12.mkv`(DxD S4 整季 park;rescue-identify 重试未自愈=真解析缺陷非瞬时)。

**根因方向**(待 Phase 1 复现坐实):recognizer(`src/recognition/`:parseFilename 包 @ctrl/video-filename-parser → identifyFromPath → resolveToTmdb → recognize)对方括号组噪声(YTS.MX/[4K]/[The-Nut])提取标题时被污染,产出 TMDB 匹配不上的垃圾标题。DxD Hero 还叠加**发明组前缀 + 绝对集号**(Hero - 01)的动漫识别难点。

**做法**:
1. 复现:对这两个真文件名跑 recognize(),打印每层(parse→identify→resolve)的输入输出,定位在哪层污染/失配。
2. 修根因:在 parseFilename/identifyFromPath 层清理方括号组噪声,让真标题("The Astronaut"/"High School DxD Hero")被正确提取;DxD Hero 力争识别到 tmdb:45950 的 S4(或据实作独立条目),别 park。
3. TDD:两文件名 + 更多括号密集变体入回归夹具,红先验证。
4. 真机复核:清 parked / 重跑识别 → The Astronaut 回 movies、DxD Hero 建集 → 不再 park。
- **分工**:根因诊断 + 修法设计在主循环(识别是判断活);机械 TDD 实现交 opencode 强模型子代理(hephaestus/sisyphus),主循环复核。

**北极星**:park 是安全失败(宁不识别不认错);修的是"该识别的没识别出",绝不放宽成"瞎认"。

## Phase 2 — E AI 翻译(原型先行 → 质量闸 → 落项目)

E 设计规格已定档 `docs/design/2026-07-20-ai-translation-design.md`(术语表先行 + 分批带滚动记忆 + fail-closed 闸;v1 靠同剧既有中字 + TMDB)。本相**执行用户钦定的方法论**:*先用强模型调出轮廓,再用弱模型测错误回归,再打磨,质量过得去才安置进项目 agent*。

**⚠️ 用户松绑(2026-07-20)**:E 要的是 **feature 本身**,不必拿 The Rig 当例子——随便找带内嵌/外挂英文轨的媒体验证即可,不是真为某剧的中字。

### 2a 原型语料
从 NAS 媒体抽 1-2 份**真英文字幕**(内嵌 eng 轨 `ffmpeg -map 0:s:N` 抽出,或现成英文外挂)当原型输入——要有真专名/世界观术语/角色名/敬称这些硬骨头。落本地 scratch。

### 2b 强模型调轮廓("好"长什么样)
opencode 强模型(opus/gpt-5.6)按 E 设计的 pipeline 译原型语料:术语表先行(EN→ZH 专名记录)→ 场景分批带滚动记忆 → CJK 约束(≤~16 全角/行 ~9CPS)。产出**参照级高质译文 + 术语表**。主循环判质量、锚定"好"的标准。

### 2c 弱模型测回归(制造失败模式)
deepseek-v4-flash 当翻译引擎 → 产出 plausible-but-flawed(专名漂移/CPS 超标/幻觉/术语破)→ 攒**回归语料**:已知坏译,质量闸**必须**抓住。证 fail-closed 闸(结构确定性 + 术语符合性 + LLM-judge + 回译抽查)拦得下。

### 2d 打磨
迭代 pipeline + 闸,直到:①强模型译文连贯、全局一致(专名跨场景稳定)、过闸;②弱模型垃圾被闸拦下,失败时**留英文 + 标记**(绝不静默装错译)。

### 2e 落项目(**质量闸门控**)
**质量达标 → 才**把验证过的 pipeline 落进项目 `translateWorker`(照 E 设计:extract_embedded_sub / read_series_existing_subs / get_tmdb_context / translate_batch+glossary / critic-verify;新 sub_status "可译"触发;fail-closed 闸)+ 测试,TDD 测试绿。
**质量不达标 → 不落**,写阻塞点报告 + 回归语料留下一程。
- **分工**:实现交 opencode 强模型子代理,主循环复核每块;圣文件(realign 5 重安全层等)不碰。

**质量闸标准(落地门槛)**:①强模型译原型语料=连贯 + 全局一致(术语表锁专名跨场景稳)+ CJK 约束达标 + 通顺;②fail-closed 闸=正确放行好译、拦住弱模型注入的错(专名漂移/幻觉/结构破),失败留英文+标记;③结构不变量=行数/时轴/样式标签逐字节保。

## Phase 3 — 全项目审计(agency 人格)

**范围**:整个 subtitle-scout 仓再审一遍(用户:三大坨解决完后,从 agency agents 起 code-review 等人格再审,看能否发现并修问题)。

**做法**:
1. opencode 人格(**momus** 批判 + **oracle** 分析,必要时加 explore 摸盘)分维度审代码(正确性/安全/简化/测试覆盖)。
2. 主循环**对抗式复核**每条发现(是不是真问题?可复现?)——不轻信子代理。
3. **高置信 + 改后全套测试仍绿 → 当晚自动修 + 提交**;其余 → 出报告留早上你逐个定夺。
4. **兜底铁律**:任何自动修必须保持 1747+ 全套测试绿;任何修破测试 → 回退 + 改报告,绝不带病提交。

## 跨相纪律 & 风险

- 每相收口提交、更新 roadmap;留运行日志(compact 可续)。
- **E 落项目风险**(大功能自主实现)→ 质量闸门控兜底(不达标不落)。
- **审计自动修风险** → 测试绿 + 高置信双门控,破测即回退。
- opencode 子代理可靠性 → 已验;每调带 timeout,主循环验产物。
- 主循环上下文将随夜推进增长 → 本 spec + 计划即 runbook,compact 后按计划续。

## 范围外(YAGNI)

- E 的 wiki/web 搜索源、CometKiwi 等 QE 模型、并行子代理翻译——留 phase-2(见 E 设计规格)。
- 产品 4 小决策(partial/里番adult/embedded/subhd防灰)——非本夜三相,收尾有余力再随手做。
