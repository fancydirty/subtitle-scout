# E AI 翻译 · 原型验证结果 + 2e 落项目计划(2026-07-20 夜→21 凌晨)

> 整晚自主运行 Phase 2 产物。方法论按用户钦定:**先用强模型调出轮廓 → 再用弱模型测错误回归 →
> 打磨质量闸 → 质量过关才落项目**。本文档记录①原型验证(已完成,质量达标)②质量闸已落地的部分
> ③translateWorker 完整落项目计划(留晨间与用户共执行——见文末"为何不夜间自动落全量")。

## 一、原型验证(2a–2d)——✅ 质量达标(2d.3 GO)

**语料(2a)**:The Rig S2E01 内嵌英文 soft 轨(ffmpeg `-map 0:2` 抽出,ass→srt)前 200 cue,术语
丰富(角色 Rose/Coake、公司 Pictor、世界观 the Ancestor/the organism/the rings、地质 seismic/fault line)。

**强模型调轮廓(2b,company/claude-opus-4-8)**:按 E pipeline——术语表先行 + 场景分批带滚动记忆 +
CJK 约束 + 冻结时轴/标签。产出:
- 术语表 48 条(专名 canonical zh:皮克托/始祖体/有机体/阻断剂/环层/北海…),讲究且全局一致。
- 参照译文 200 cue:通顺、跨场景术语锁死、SDH 译出、`<i>`+时轴逐字节保、CJK 自然断行。
- 主循环判质量:**PASS**(连贯 + 全局一致 + 结构完整 + 通顺)。

**弱模型测回归(2c,deepseek-v4-flash,裸单批无术语表)**:如预期 plausible-but-flawed。**实证专名
漂移**:Pictor→"皮克特"(权威"皮克托")、Research and Expansion→"研究与扩展部"(权威"研究与开发部")
——"金洛克↔金洛奇"同类漂移。这是回归语料:质量闸**必须**抓住的已知坏译。

**质量闸(2d)**——`evaluateTranslationGate`(已落地,见下)对两译文判决:

| 译文 | 结构违规 | 术语符合率 | 判词 |
|---|---|---|---|
| 强 ref | 0 | **100% (96/96)** | ✅ **PASS** |
| 弱 weak | tag×1 | **69.8% (67/96)** | ❌ **FAIL** |

**结论(2d.3):方法论成立,fail-closed 确定性层单独即足以放行好译、拦下坏译。质量达标 → 授权落项目。**

## 二、已落地(本夜提交)

- **`src/translate/qualityGate.ts` + 测试**(commit `0da3845`):fail-closed 确定性闸三层(结构确定性 /
  术语符合性 / CJK 约束)。纯函数、零 LLM、可脱机单测(9 单测绿),真数据验证与原型一致。
  worker 可直接消费:`evaluateTranslationGate(source, candidate, glossary, opts) → GateResult`。

## 三、translateWorker 落项目计划(2e,**留晨间共执行**)

照 E 设计规格 `docs/design/2026-07-20-ai-translation-design.md` §架构。分工:实现交 opencode 强模型
子代理,主循环复核每块;圣文件(realign 5 重安全层)不碰;DB 迁移照 v7 配方。每步 TDD、测试须绿、独立提交。

### 2e.1 触发探测 + DB 迁移
- `embedded_langs` 含非目标可抽轨 + 无目标外挂 →"可译候选"(区别 `embedded`=已覆盖)。
- schema 迁移:sub_status 引入"可译"态(`src/v2/db.ts` 迁移 + `src/v2/libraryRepo.ts` 查询)。
- TDD:红先验证探测判定 → 实现 → 全绿。

### 2e.2 抽取 util `src/files/extractEmbeddedSub.ts`
- ffmpeg `-map 0:s:N`(复用 streamProbe 找轨号),冻结时轴+样式,出源 .srt。
- 单测:ffmpeg map 参数构造 + 轨选择(mock execFile,照 streamProbe.test.ts fakeExecFile 手法)。

### 2e.3 上下文攒取工具(可并行)
- `read_series_existing_subs`(同剧其他集既有中字→播种术语表;库内直读零网络)。
- `get_tmdb_context`(剧/逐集简介+cast,复用 B 的 TMDB 管线)。

### 2e.4 场景分批 + translateWorker agent(`src/agent/translateWorker.{ts,tools,schemas}.ts`)
- 场景分批切分(纯函数:>2s 间隔或场景切→新批;单测)。
- agent 循环(照 findSubtitleWorker.ts 模子):术语表先行 → 串行分批带滚动记忆 → grounded 精修 →
  **critic 角色(LLM-judge MQM 分型 + 回译抽查)= 闸的第 3/4 层** → 过 `evaluateTranslationGate` 硬闸
  才落。按剧持久化术语表(E02+ 继承 E01)。
- **eval**(照 `findSubtitleWorker.eval.test.ts` MockLM 手法):断言术语一致/结构完整/**fail-closed(坏译被拦、留英文+标记)**。

### 2e.5 编排接线 + 落盘
- `src/v2/reconcileAll.ts` 派 translate 任务;`src/cli/index.ts` watch 注入 worker。
- 落外挂中文 .srt(时轴对齐)→ 转 covered(来源=ai-translated);失败→不装、留原态+诚实标记。

### 2e.6 真机端到端(**晨间有人看着跑**)
- The Rig S2E1/E6(内嵌英文轨 + 同剧 S2E2-5 既有中字当上下文)→ 出中文外挂 → 人工抽验 + 确认 fail-closed。

## 四、为何不夜间自动落全量 + 部署生产

1. **体量**:worker+tools+schemas+task+eval ≈ 2000 行新 agent + DB 迁移 + 编排接线,是大功能,该经用户
   过目而非无人值守堆进仓(用户铁律"高置信才自动改"——大功能集成非高置信机械修)。
2. **省本账号配额**(用户最在意):translateWorker 走项目 `llm.ts` makeModel。夜间在真媒体上自动跑
   会大量 LLM 调用 + 写字幕文件,无人值守烧配额——违"省配额"。
3. **结论**:原型研究(不确定的部分)已验证达标;工程落项目按计划留晨间共执行,基础件(质量闸)已先落。
