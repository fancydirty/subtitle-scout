# 全项目审计报告(2026-07-21 凌晨,整晚自主运行 Phase 3)

> 方法:主循环编排 + **对抗式复核每条**(不信子代理一面之词,读真代码坐实)。高置信 + 改后全套
> 测试仍绿 → 当晚自动修 + 提交;其余 → 本报告留晨间定夺。铁律:任何修破测试即回退,绝不带病提交。

## 审计基建的教训(先记)

**opencode `--agent` 人格路径在本机损坏**:momus/oracle 人格的 Read 工具 schema 不匹配
(报 `SchemaError missing key filePath`)+ 幻觉 Windows 临时路径(`C:\Users\...`),卡在重试循环
产不出 findings;find-2 更直接"momus not found"回退默认 persona。**但 `--model company/claude-opus-4-8`
(无 --agent)工作正常**。**可靠解法:把待审文件内容 inline 进 prompt,绕开损坏的 Read 工具**——本报告
的有效发现都来自这条路径。教训:审计子代理别依赖 opencode 的 --agent 人格 + 自主文件读取,直接喂内容。

## 已自动修复(高置信 + 全套测试绿)

### ✅ F1 — streamProbe 真二进制 smoke 并发 flaky(commit `a0e45c7`)
- 现象:`probeEmbeddedSubtitles — real binary smoke` 单跑绿(20/20),全量套件偶挂。
- 对抗式复核根因:该用例真起 ffprobe 探 1080p fixture,无 per-test 超时吃 vitest 默认 5s;内部
  `probeEmbeddedSubtitles` catch 一切错误返回 null(断言恒不因返回值失败)→ 唯一失败模式 = 测试级
  超时。全量并行 CPU 争用下真 ffprobe 超 5s(单跑仅 ~150ms)。
- 修:显式 30s 测试超时(内部 ffprobe 超时是 15s,给足余量)。全量 1756→1758 绿。

### ✅ F2 — 质量闸两处 fail-closed 假放行(commit `1dd662c`)
审计对刚写的 `src/translate/qualityGate.ts`(独立第二双眼)揪出:
- **#1 术语符合率聚合稀释(HIGH)**:`conformance=hits/checks` 池化所有(术语,cue)对,高频正确
  术语会稀释稀有关键专名的系统性漂移——如 Pictor→"皮克特" 7/7 却因其他术语正确使聚合>85% 蒙混
  过关,正是北极星"错译比留缺口更糟"要拦的。**且偏离 E 设计"每专名不符→该行自动失败"的严格意图。**
  - 修:补 per-term 硬闸——任一专名出现≥2次却从未正确落地(termHits===0)= 系统性漂移,不管聚合
    一律硬拦。阈值≥2:单次未落地可能是合法代词替换/省略(留聚合率兜),≥2 全漏则是真漂移。
- **#3 `\b` 边界对非 ASCII 专名失效(MED)**:`\bCafé\b`/`O'Brien`/`Zoë` 的 ASCII 词边界失效 →
  该术语永不匹配源 → 永不校验 → 静默假放行。改 unicode-aware lookaround 边界。
- +2 TDD 测;真数据不变(强译 PASS 100%/弱译 FAIL);全量 1758 绿。

## 独立复核·未见问题(不制造 nitpick)

- **`src/cli/fetchLib.ts`**(#11 interleaveByProvider/dedup/fail-soft):逻辑正确。dedup 用
  `candidateKey=${provider}:${providerId}`(含 provider,已核实)→ 注释"cross-provider keys never
  collide"成立,无跨源误丢。fail-soft(部分 provider 挂仍返回活着的)+ fail-fast(全挂/零配置抛错
  不写负缓存)两分支正确。
- **`src/recognition/*`**(#12 深挖):park-on-uncertainty 北极星工作正常,两处 D#2 park 皆正确安全
  失败(非回归),见 `2026-07-20-recognizer-park-investigation.md`。

## 记录待晨间定夺(未自动改)

### 质量闸低优发现(gate 设计微调,非机械修)
- **#2(LOW)**:一个 cue 内专名多次出现,`.includes(t.zh)` 只要有一次正确就算整 cue hit——cue 内
  重复漂移不可见。实际极少(名字很少一 cue 内出现多次),留 phase-2。
- **#4(LOW)**:时轴逐字节比较 `!==`,但 durationSec 容忍 `,`↔`.` 毫秒分隔——若某译文规范化了分隔符
  会假拦。实际:worker 冻结时轴出 LLM 视野,分隔符不会变,几乎不触发。可选:比较前归一化分隔符。
- **#6(LOW)**:FULLWIDTH 正则漏 CJK Ext B(U+20000+ 增补平面),罕见汉字宽度算 0.5——只影响 CPS/行长
  soft 告警,不改判词。可选:补增补平面区间。
- **设计张力(留用户拍板)**:术语层"严格 per-occurrence 硬拦(设计原意)vs 聚合阈值(原型 85%)"
  的取舍——严格会误拦合法的代词替换/省略(false-fail),聚合会稀释稀有漂移(false-pass,已用
  per-term 系统性漂移硬闸缓解)。当前是折中。2e 落 translateWorker 时可结合 LLM-judge 层再调。

### recognition/resolveToTmdb 审计(6 条,对抗式复核后**全部 → 报告,零自动改**)

opencode 纯强模型 inline 审计 `resolveToTmdb.ts`,读了模块+tmdb 类型+测试。6 条发现都是**真代码观察**,
但对抗式复核后我判定**没有一条是高置信机械修**——它们全环绕 park-on-uncertainty 北极星精心设计的核心
匹配裁决,任一改动非"增假拦(该识别却 park)"即"增误认(采错 tmdbId 永久污染库)",是用户该权衡的
安全取舍,不该夜间擅改。逐条复核:

- **#1 [HIGH→PLAUSIBLE] 规则(b) L68-70 只按 year 收窄、零 title 校验**:year 唯一命中即采纳,不复核该 hit
  title 是否沾边。真 gap,但触发需 TMDB 模糊搜索返回"切边但非标题匹配"且恰好年份唯一(TMDB 搜索较精确,
  低概率)。**修法(给规则b加 title 复核)会破 Invasion 2021 类合法案例(年收窄到多条、clean-title 裁决)**
  → 非安全自动修。
- **#2 [HIGH→PLAUSIBLE] 规则(a) L66 单 hit 无条件采纳,被"丢年重搜"L114-116 放大**:年搜0→丢年重搜返回
  单条模糊 hit→无条件采纳。是 spec 明定行为(注释 L109-113)。审计质疑"TMDB 返回恰一条 ≠ 标题精确唯一"
  (搜索模糊)——真观察。但**修法(给规则a加 clean-title 复核)会破 Tron Ares→TRON: Ares 单 hit 合法采纳**
  → 非安全自动修。
- **#3 [MED→CONFIRMED gap,最实质] 重搜条件 L114 `hits.length===0` 漏"非空但全错年"档**:丢年重搜只在
  带年搜索返回**空**时触发;但发布年≠首播年(TV 常见)会让错年服务端过滤召回一批切边同年 hit(非空)→
  重搜永不触发→真片取不到→该识别却 park 或误采错年变体。**真 gap 且触发现实**。改进候选:**park 前先做
  一次丢年重搜**(retry-before-park)。但仍是改核心逻辑、影响 recognize-vs-park 的设计决策 → 留用户拍板,
  非夜改。
- **#4 [MED→PLAUSIBLE] cleanTitle L47-48 剥离全部分隔符**:`9-1-1`→`911`、`Spy×Family`→`spyfamily`,靠分隔符
  区分的不同作品撞形。是抗标点漂移的**刻意设计**(TRON: Ares vs Tron Ares);碰撞低概率(需真片缺席+无关同形
  唯一命中)。→ 记录的设计权衡。
- **#5 [MED→PLAUSIBLE] 规则(c) L74-75 对 title|originalTitle OR 匹配**:可经"另一作品的原名"跨字段唯一命中。
  是让 CJK 查询命中本地化标题的**刻意设计**;需恰一条命中(两条则 park)。→ 记录的设计权衡。
- **#6 [LOW] 单 hit title='' 被采纳 L66/L125**:TMDB 畸形行→`Recognized.title=''`,下游丢标题信号(tmdbId 未必
  错,属带瑕入库非误认)。可选防御:adopted.title 空时回退 identity.title。低优。

**复核纪律**:没盲信子代理——逐条对代码注释的设计意图 + 北极星 + 修法风险核验,#1/#2/#4/#5 是 spec 明定的
设计权衡(改则破合法案例)、#3 是真 gap 但改动是设计决策、#6 轻微。**全部留报告,守"高置信才自动改 + 不擅动
安全哲学"两铁律。** 最值得晨间看的是 **#3(retry-before-park 覆盖改进)**,与 #12 的 park-vs-adopt 安全主题同源。

## 结论

审计覆盖:E 新代码(gate,揪 2 真洞已修)+ 热点(fetchLib 干净)+ 测试基建(flake 已修)+ recognition
(#12 已深挖)。**修了 2 组真问题(1 flake + 2 gate fail-closed 洞),全程全套测试绿、零回退。** 项目
在 D 从零大考 + #11/#12 后已相当成熟,本轮审计的最大价值是给**当夜新写的安全关键代码(质量闸)**补上
了两处 fail-closed 洞——独立审计新代码的典型收益。
