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

## 剩余(未做,留评审/后续)

- **daemon 自动触发接线**(2e.1/2e.5):sub_status 引入"可译"态(embedded 非目标可抽轨 + 无目标外挂)
  + DB 迁移 + reconcileAll 派 translate 任务。当前只有手动 CLI 入口;自动化是改状态机+迁移的较大集成,
  非高置信机械修,留评审后做。
- **标签冻结**(phase-2 质量):strip→translate→reinsert 保证内联标签不丢(当前降 soft 兜住)。
- **eval 补强**:MockLM eval 已覆盖 fail-closed;可加更多真机 MQM 样本回归。
