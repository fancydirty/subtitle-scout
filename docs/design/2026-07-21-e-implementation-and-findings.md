# E AI 翻译 · 实现与测试发现(2026-07-21)

> 取代 `2026-07-21-e-prototype-validation-and-port-plan.md` 里"worker 留晨间"的计划——已当场建成。
> 用户晨起纠正"早停":红线拦"上生产跑",不拦"建功能测绿";建 worker(TDD+MockLM,零真实 LLM
> /零配额)本就该做。本文件记录已建成的实现 + 严格真机测试逼出的 3 个改计划(验证用户"测试才是重点")。

## 架构:确定性编排 + 可注入 LM/critic(非自由 tool-calling agent)

刻意不做成自由 agent——自由 agent 的非确定性与 fail-closed 北极星相冲、难脱机测。核心是**确定性
管道 + 依赖注入**,MockLM 即可全量 eval,真机只需验模型产出质量。模块(`src/translate/` + `src/files/`):

| 模块 | 职责 | 测试 |
|---|---|---|
| `files/extractEmbeddedSub.ts` | ffmpeg `-map 0:s:N -f srt` 抽内嵌轨→SRT | 5 |
| `translate/qualityGate.ts` | fail-closed 确定性闸(结构/术语符合/CJK)+ parse/serialize SRT | 13 |
| `translate/sceneBatcher.ts` | 场景分批(间隔+上限,带滚动记忆前提) | 6 |
| `translate/translatePipeline.ts` | 核心编排:术语表先行→分批带滚动记忆→闸→critic→installed/held | 14 |
| `translate/translateLm.ts` | 真 LM(ai SDK generateText+容错解析,模型只回译文我重建结构) | 9 |
| `translate/translateCritic.ts` | LLM-judge 语义层(强模型判官) | 6 |
| `translate/translateItem.ts` | 单条端到端(探轨→选源→抽→译→写 sidecar) | 10 |
| `cli/translateItemCommand.ts` | CLI `subtitle-scout translate-item <path>` | — |

**fail-closed 结构保真核心**:模型永不返回时轴/序号;reconstructBatch 用原 batch 的 index/timing
重建 cue、只填译文,模型漏译的 cue 保留原英文——时轴/序号从构造上不可能漂。

## 真机测试逼出的 3 个改计划(用户方法论:强模型测效果→弱模型验回归,测试出改动)

同 The Rig S2E01 前 60 cue,真模型跑:

| 模型 | verdict | 术语 | 质量 |
|---|---|---|---|
| **mimo-v2.5**(生产 `LLM_MODEL`,弱) | held(丢标签 5/60) | 100% | 生硬:"打孔在地球上" |
| **company/claude-opus-4-8**(强) | **installed** | **100%** | 自然:"我们不断在地球上打洞";通顺地道术语稳 CJK 断行漂亮 SDH 译出 |

1. **E 必须用强模型** → `TRANSLATE_BASE_URL/API_KEY/MODEL` 独立可配(设了走这套,否则回退 `LLM_*`)。
   mimo 留 captcha。生产建议 E 指向强模型端点(如 company opus)。
2. **强弱模型都偶尔在译文里丢内联 `<i>` 标签**(opus 2/60、mimo 5/60)→ 样式标签检查从 hard 降 **soft**。
   斜体/粗体是装饰,丢了既非错译也非缺口,按北极星不该 fail-close 整档。硬闸只留 corruption 类
   (条数/时轴逐字节/术语符合+系统性漂移)。**标签冻结(strip→translate→reinsert 保证不丢)留 phase-2。**
3. **确定性闸判不了通顺度/语义准**(mimo 的"打孔在地球上"过了确定性闸)→ 加 **LLM-judge critic 层**:
   强模型判官逐条审英中对照,抓 mistranslation/awkward/omission/term,major→held。critic 抛错/输出坏
   → 优雅降级(确定性闸已过则装),不因判官抽风阻塞。默认开(`TRANSLATE_CRITIC=off` 关)。

**完整管道验收**(opus LM + opus critic,60 cue):installed / 术语 100% / critic.ok=true / 0 问题 →
产出 The Rig S2E01 真中文字幕。critic 不误伤好译文。

## 配置(E 生产用)

- `TRANSLATE_MODEL` / `TRANSLATE_BASE_URL` / `TRANSLATE_API_KEY`:E 翻译模型(设强模型;缺省回退 `LLM_*`)。
- `TRANSLATE_CRITIC`:`off` 关 critic(默认开)。`TRANSLATE_CRITIC_MODEL`:单独指定判官模型。
- CLI:`subtitle-scout translate-item "<videoPath>"` → 过闸+critic 才写 `<base>.zh-Hans.srt`(held 不写)。

## 深度质量复核发现(2026-07-21 下午,对生产字幕的批判性评估)

对已写进库的 The Rig S2E01 全 941-cue 字幕做批判性评估(不只 gate pass/fail):

**质量结论:高。** ①**术语跨 941 cue 完全一致**(Pictor→皮克托 17× 零漂移、Rose→罗斯 25×、Ancestor→始祖 11×、
Coake→科克 29×、Fulmer→富尔默 13×,每专名仅一种译法——glossary-first 守住长片最难的一致性关)②结构完美
(0 时轴/序号漂移)③通顺地道、SDH 全译、CJK 近乎完美(941 中仅 1 长行 2 超速,标签丢 16=soft)。

**但 critic 复审(生产跑时关的)逼出 critic 层自身的真缺陷 → 新改计划:**
对 cue 441-500 补跑 opus critic:6 条(5 minor 风格 + 1 **major**)。对抗式复核那条 major(cue 450
"Aye, me and Danny Glover" 译"我和丹尼·格洛弗一样"):**判官过判了**——"老"的语境已由相邻 cue 449
("Getting a bit old for going up the stairs?"→"爬楼梯有点吃不消了?")承载,450 直译忠实,判官要求补"老了"
是可选本地化非错译。**判官把忠实译文误判成 major mistranslation。**

- **缺陷1:critic 过判**(严重度校准太激进,混淆"真错译"与"可更本地化")。
- **缺陷2:"任一 major→held 整档"太刚**——一条(还是误判的)major 会让整部术语一致、通顺的 941-cue 字幕
  全作废、零安装。**灾难性 false-hold。** 故生产跑关 critic 反而对;但 **critic 默认 on 是潜在隐患**。
- **修法①(已做,commit f9ecc81)**:收紧 critic prompt 严重度定义——major 仅限"改变原意/丢关键信息/看不懂"
  的真硬伤,忠实但可更地道→minor,结合相邻上下文判断,宁漏报不过判。**empirically 验证**:同一 cue 441-500
  从 6 条(含1误判 major)→ ok=true 仅 1 minor,false-major 消失。**这也大幅降了缺陷2危险**——判官现在只在
  真硬伤才 major,"任一major→held"就成正确 fail-closed(不再灾难性 false-hold 好字幕),故 critic 默认 on 现可接受。
- **修法②(留评审)**:把"整档 hold"换成 **E 设计步⑥ reflect-refine 逐句精修**(只重译 critic 标 major 的那句,
  而非弃整档)——更优架构,但改 pipeline 编排,留用户评审再动。

## 剩余(未做,留评审/后续)

- **~~daemon 自动触发接线~~ ✅ 已做+验证(2026-07-21,commit 1a3b299)**:daemon 每 tick 机械派
  translate worker_task(候选=unavailable+内嵌非中文轨);**双重 env 门控**(只认显式 TRANSLATE_* 三件套,
  不全则功能休眠零成本/任务拒跑,绝不回退 mimo 烧配额,同 SUBHD_ENABLED 模式);**无 DB 迁移**(复用
  unavailable/embedded_langs 现成列),不碰圣文件。**真数据验证**:生产库 5 条 unavailable+embedded →
  正确筛出唯一候选 tmdb:112581/s2e6(The Rig S2E06),排除已覆盖的 S2E01;翻译过的 S2E01 已被 ingest
  记成 covered(端到端通)。10 单测 + daemon 钩子 3 测。**上线只需服务器配 TRANSLATE_* + 重部署(留用户开关)。**
- **critic 缺陷2 reflect-refine(留评审)**:把"任一 major→held 整档"换成逐句精修——改 pipeline 编排的
  架构级改动;缺陷1(过判)校准修好后已不紧急,留评审再动。
- **标签冻结**(phase-2 质量):strip→translate→reinsert 保证内联标签不丢(当前降 soft 兜住)。
- **eval 补强**:MockLM eval 已覆盖 fail-closed;可加更多真机 MQM 样本回归。
