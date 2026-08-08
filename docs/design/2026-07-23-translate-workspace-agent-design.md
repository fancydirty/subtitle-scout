# Translate Workspace Agent · Design Spec

日期: 2026-07-23  
状态: **approved for implementation**（用户确认方案 1 + spec 全图 C + 实现从 P1 切片）  
前置: `docs/design/2026-07-20-ai-translation-design.md`、F1/F2 设计、翻译加固战役  
取代关系: **不删除**现有 `translateItem`/`translatePipeline`；本设计将生产主路径升级为 agent 工作台，旧管道可降为内部 helper 或退役候选。

---

## 1. 目标与北极星

### 1.1 目标

把 AI 翻译从「确定性批灌 LLM（整段源字幕进上下文）」升级为 **文档工作台上的 `translateWorker` agent**：

1. 先 **正确选源**（源语言→中文单跳）  
2. 再 **攒上下文**（TMDB + 同剧已有目标语字幕 + 权威 wiki/fetch）  
3. 再 **冻结术语表文档**  
4. 再 **按表逐句写入** bilingual 工作表  
5. **fail-closed** 质量闸通过后，确定性 merge 装盘  

Agent 像坐在工作台前的人：眼前是清洗过的源文文档、术语表文档、双语表；**不是**把整集 SRT 塞进聊天上下文。

### 1.2 北极星（不变）

| 规则 | 说明 |
|---|---|
| 错译不如留缺口 | 闸不过 → 不装；诚实 held / no-source |
| 源语言→中文单跳 | 永不 JP→EN→CN 中继 |
| 时轴/样式不进模型 | canonical 保留；agent 只见净文本；merge 回装 |
| 磁盘是记忆 | 长状态只在 staging 文件；上下文窗口 = 工作集 + tool I/O |

### 1.3 明确不做（本战役）

- Brave Search / 通用网页搜索 SaaS（要 API key、增用户负担；测试亦故意绑手脚）  
- CometKiwi 等需托管权重的 QE  
- 硬字幕 OCR  
- **并行**多 agent 拆句翻译（打碎滚动记忆；原 E 设计已否）  
- 降术语闸阈值以迁就弱模型  

### 1.4 实现切片（spec 全图，plan 分期）

| Phase | 交付 | 可独立验收 |
|---|---|---|
| **P1** | staging 工作台 + 选源单跳 + clean view + glossary 文档 + bilingual 表 + 确定性 merge + 结构/术语闸；上下文 = TMDB + 同剧目标语字幕 | CLI/`translate-item` 或单任务 runner 端到端 |
| **P2** | wiki/权威 fetch 工具 + critic 工作流写入 `critic.*` + reflect-refine 失败行 | 权威上下文 enrichment 可测 |
| **P3** | daemon 派活接 agent、`ai_translate_enabled` 双门、staging 清理策略、runs/llm 观测对齐 | 生产可关可开 |

**纪律:** 每期对照本 spec 勾选；禁止「只做 P1 就当战役结束」而丢掉全图字段/工具位。

---

## 2. 背景与问题

### 2.1 现状

| 层 | 状态 |
|---|---|
| 设计 E | 编排式 translateWorker agent + 工具集 |
| 实现 | `translateItem` → `translatePipeline`：固定批译，MockLM 单测 |
| 选源 | 有 eng soft 轨则优先英轨；日漫易误走英→中 |
| 上下文 | `gatherContext` 可接同剧中字，但非 agent 决策；易被绕过 |
| 主覆盖 | find-subtitle 已很强；AI 几乎未贡献装盘 |

### 2.2 失败模式（已观测）

- 整段/大批进 prompt → 术语漂移、漏译、弱模型 held  
- 不知作品上下文 → 音译垃圾（如「莫里希托」）  
- 日漫有 CR English → 英译路径违反单跳铁律  
- MockLM 过闸 ≠ 产品语义正确  

### 2.3 业界对齐（调研摘要）

- **SWE-agent ACI / OpenHands:** 状态在盘，LLM 只看 tool 观察窗  
- **DelTA (ICLR 2025):** 外部专名记录 + 滚动双语摘要 + 按句更新  
- **CAT (memoQ/Trados):** bilingual grid + termbase；人不重提示整文档  
- **字幕实践:** 时间码永不进模型，译后 merge  

本设计 = 上述模式在 subtitle-scout 内的具体化，并复用 `findSubtitleWorker` 的 skill/tool 骨架。

---

## 3. 架构总览

```
daemon / CLI
    │
    ▼
runTranslateWorkerTask  (claim job)
    │
    ▼
makeTranslateWorker(deps)  ≈ findSubtitleWorker 形状
    │  allocate staging under stagingRoot
    │  tools + translate skill (read_doc progressive disclosure)
    ▼
Agent loop (serial)
    │  ① resolve_source (origin-lang single-hop)
    │  ② materialize canonical + agent_view (strip TS/styles)
    │  ③ gather_context → write context snippets into staging docs
    │  ④ freeze_glossary → glossary/terms.json
    │  ⑤ translate loop: get_window + glossary → update_row*
    │  ⑥ critic (P2+): write critic checklist / row flags
    │  ⑦ merge_to_sidecar (non-LLM) + quality gates
    ▼
install / held / no-source  → runs + job complete*
```

**原则:** Agent **从不**直接「生成整份 SRT 字符串当最终产物」。最终 sidecar 只来自 **merge(canonical shells, bilingual.tgt)**。

---

## 4. Staging 工作台（每任务独立，方案 A）

### 4.1 根路径

与 find-subtitle 一致：挂在配置媒体根级，便于 gc：

```
{stagingRoot}/.subtitle-translate/{jobId}/
```

- `stagingRoot` = 任务所属 media root 的配置根（同 H4：非收窄季目录）  
- job 成功且已装盘 → cleanup（可配置保留失败 job 的 staging 供审计）  
- 进程崩溃 → 既有 orphan GC 扩展扫描 `.subtitle-translate/`（P3）

### 4.2 目录契约

```
{jobId}/
  meta.json                 # itemId, videoPath, originLang, sourceRef, phase, timestamps
  canonical/
    source.srt              # 或 .ass 抽出后的 srt；不可变
    source.meta.json        # track index / provider ref / durationSec
  agent_view/
    source_clean.jsonl      # 一行一 cue: {id, text, scene?}  无 timing/样式
  context/
    tmdb.md                 # 剧/集简介 + cast（工具写入）
    series_subs.md          # 同剧已有目标语字幕摘录（可空）
    wiki.md                 # P2：权威 wiki 摘录（可空）
  glossary/
    terms.json              # [{src, zh, note?}] 冻结后默认只加不改
    FROZEN                  # 空文件或 flag：冻结后 update 需显式 unfreeze（人/工具）
  work/
    bilingual.jsonl         # {id, src, tgt, status, notes?}
    summary.md              # 滚动双语摘要（DelTA-lite）
    critic.md               # P2：MQM 清单与结论
  out/
    target.srt              # merge 产物；过闸后才 install
```

### 4.3 agent_view 清洗规则

从 canonical 解析 cue 后：

- **保留:** 稳定 `id`（与 canonical 下标/序号对齐）、纯文本 span、可选 scene 切分标签  
- **剥离出模型视野:** 时间轴、ASS override `{\...}`、纯样式 font 标签（或降为纯文本）  
- **canonical 永不被 agent 改写**

### 4.4 bilingual 表语义

| status | 含义 |
|---|---|
| `pending` | 未译 |
| `draft` | 已写入 tgt，未过行级检查 |
| `ok` | 行级通过 |
| `needs_review` | critic/术语问题 |
| `failed` | 放弃该行（可留 src 或空 tgt；整档策略见闸） |

`src` 列在 materialize 后 **不可变**；agent 只写 `tgt` / `status` / `notes`。

---

## 5. 选源策略（硬规则，非模型自由裁量）

实现为 **确定性工具/前置步骤**（可被 skill 叙述，但代码强制）：

```
function resolveTranslateSource(item):
  origin = series/movies.origin_lang  # lower
  if origin in {ja, jpn}:
    try embedded non-image ja/jpn text track → extract
    else try fetchSourceSub(languages=[ja])  # jimaku 优先（已有 ja 排序）
    else → no-source
    # 禁止：仅因存在 eng soft 轨而英译
  if origin in {en, eng} or origin empty-with-en-embedded:  # 见下
    try embedded non-image non-zh text track (prefer eng)
    else try fetchSourceSub(languages=[en])
    else → no-source
  else if origin in SUPPORTED_SOURCE_LANGS:
    same pattern for that lang
  else:
    → no-source  # 不中继
```

**日漫铁律:** `origin_lang=ja` 时，**即使**存在 `CR_English` 内嵌轨，也 **不得**选 eng 作为翻译源。

**时长:** 外源候选继续走已有 duration accept 谓词；探针 null → fail-closed。

**sourceRef:** 写入 `meta.json` 与 runs（`jimaku:…` / `embedded:s:N` / `opensubtitles:…`）。

---

## 6. 上下文源

| 源 | 阶段 | 强制？ | 说明 |
|---|---|---|---|
| TMDB 剧/集简介 + cast | P1 | 有 key 则调；失败记空 | 结构骨架，**不**当角色中文名权威 |
| 同剧已有目标语字幕 | P1 | 有则用，无不强求 | **最高性价比术语种子**；库内 sidecar/embedded 摘录写入 `context/series_subs.md` |
| 权威 wiki / MediaWiki 类 fetch | P2 | 可空 | 无 API key 负担的只读 fetch；**禁止 Brave** |
| 通用 web / Brave | — | **永不接线** | 文档与 skill 明示；测试环境故意无 search 工具 |

Skill 文案须写明：测试/生产均无通用搜索；上下文不足时术语表缩小、翻译更保守，**不得臆造专名**。

---

## 7. Agent 工具面

### 7.1 骨架

- 复用 `makeReasoningAgent` + `systemPromptSkillIndex` + `read_doc`  
- 新 skill: `translate-workspace`（`src/agent/skills/translateSkill.ts`）  
- 新 worker: `src/agent/translateWorker.ts` + `translateWorker.tools.ts` + schemas  
- 任务类型: 既有 `payload.taskType='translate'`；runner 从 `runItem(translateItem)` **改为** `runTranslateAgent(task)`（P3 接线；P1 可 CLI 直调）

### 7.2 工具列表（全图；P1 必须实现 ★）

| 工具 | Phase | 行为 |
|---|---|---|
| `read_doc` | ★ | skill 全文 |
| `read_workspace_doc` | ★ | 读 staging 内文档（path 白名单 + offset/limit） |
| `write_workspace_doc` | ★ | 写/覆写 **小文档**（context/*, summary.md）；禁止写 canonical |
| `resolve_source` | ★ | 执行 §5；写 canonical + meta.sourceRef；失败 → 可 finalize no-source |
| `materialize_agent_view` | ★ | canonical → source_clean.jsonl + 初始化 bilingual pending 行 |
| `fetch_tmdb_context` | ★ | 写 `context/tmdb.md` |
| `fetch_series_target_subs` | ★ | 写 `context/series_subs.md`（可空） |
| `freeze_glossary` | ★ | 写 `glossary/terms.json` + FROZEN；输入来自模型产出的结构化 terms |
| `lookup_glossary` | ★ | 查询术语 |
| `list_rows` / `get_row` / `update_row` | ★ | bilingual 表；`update_row` 仅允许 tgt/status/notes |
| `get_window` | ★ | 取 id 窗口 ±N 行净文本 + 当前 summary 片段（观察结果进 tool result，不常驻 system） |
| `update_summary` | ★ | 追加/改写 `work/summary.md` |
| `run_structural_gate` | ★ | 非 LLM：行数对齐、术语符合率、空 tgt 等 → 写结果 |
| `merge_to_srt` | ★ | 非 LLM：shell + tgt → `out/target.srt` |
| `install_sidecar` | ★ | 过闸后原子安装；防覆盖源视频（既有加固） |
| `fetch_wiki_context` | P2 | 权威 wiki → `context/wiki.md` |
| `run_critic` | P2 | LLM-judge；写 `critic.md` + 行 flags |
| `finalize` | ★ | 结构化报告：installed / held / no-source / … + sourceRef + 路径 |

**禁止的工具:** `web_search`、Brave、任意「把整份 clean 源一次性塞进 generateText 当唯一 prompt」的捷径 API（内部实现若对 **单窗** 调用 LM，必须经 `get_window` 限制行数）。

### 7.3 翻译时 LM 的合法输入

单次 batch 调用最多包含：

- 当前 window 的 clean 行（有上限，如 10–40）  
- 冻结 glossary 全文或命中子集  
- `summary.md` 截断  
- 可选：series_subs / tmdb 的短摘录（已在文档，tool 可读后放入 **本步** 观察）

**禁止**把 `source_clean.jsonl` 全文件读入单次 completion。

---

## 8. Skill 行为纲要（translate-workspace）

Progressive disclosure：system 仅 name+description；`read_doc` 后全文包含：

1. 你是翻译作业员，工作台在 staging；先 `resolve_source` 再看文  
2. 日漫必须日源；无日源 → finalize no-source，禁止英中继  
3. 读 tmdb + series_subs（有则用）；无通用搜索  
4. 通读方式：分页 `read_workspace_doc` / `get_window`，写 glossary，**freeze**  
5. 按 scene/窗口译，每窗后 `update_row` + `update_summary`  
6. 专名必须遵守 terms.json  
7. 完成后 `run_structural_gate` → `merge_to_srt` → `install_sidecar` 或 held  
8. 绝不手写最终 SRT 时轴  

（完整英文/中文 playbook 在实现 P1 的 skill 文件中落盘，并由 skill 单测钉锚点。）

---

## 9. 质量闸与装盘

### 9.1 确定性闸（P1，非 LLM）

- bilingual 行数 = agent_view 行数  
- 每个 ok/draft 行：tgt 非空（策略：允许少数 failed 行则整档 held——**默认整档 fail-closed**：任一 forced-ok 策略外的空 tgt → held）  
- 术语符合率 ≥ 现网阈值（85%，不降）  
- merge 后 cue 数/ timing 与 canonical 一致（字节级 timing）  
- 视频时长闸：沿用 max cue end / duration ∈ [0.85, 1.15]；探针失败 fail-closed  

### 9.2 Critic（P2）

- 独立模型配置可沿用 `TRANSLATE_CRITIC*`  
- 只读 window + glossary；结果进 `critic.md` 与 row status  
- critic 抛错 → 降级策略与现网一致（可配置：P1 无 critic 则仅确定性闸）

### 9.3 装盘

- 仅 `out/target.srt`（或约定格式）经 `install_sidecar`  
- 语言标记 zh-Hans（或配置目标语）  
- installed → completeDone + requestIngest  
- held / no-source / extract-failed → 既有 job 语义 + runs 记账（含 llm_calls）

---

## 10. 与现有代码的关系

| 模块 | 命运 |
|---|---|
| `translatePipeline` / `translateLm` | P1 可被 **window 级** `translate_batch` helper 复用；禁止作为「整集一次」入口 |
| `translateItem` | CLI 兼容层：改为调 agent runner，或保留 `--legacy` 至 P3 后删除 |
| `qualityGate` | 继续服务术语/结构闸 |
| `fetchSourceSub` + jimaku | `resolve_source` 内部调用 |
| `translateWorkerTask` | P3：`runItem` 换 agent；候选列表可收紧（ja 必须有日源路径才派） |
| `ai_translate_enabled` + TRANSLATE_* | 双门不变 |
| find-subtitle | 不改；翻译仍是 unavailable 之后的最后手段 |

---

## 11. 测试策略

### 11.1 单元 / 契约（P1）

- staging 目录契约与 path 沙盒（不能读出 job 目录）  
- agent_view 剥离 timing/override  
- `update_row` 不能改 src  
- resolve_source：ja+eng 内嵌 → 仍选 ja 或 no-source，**绝不** eng  
- merge：timing 与 canonical 一致  
- 术语闸：漂移 → held  

### 11.2 Agent 级（非 MockLM 冒充质量）

- **Tool-loop 测试:** 注入 scripted tool 策略或可录制 LM，断言 **工具调用顺序与工作台文件形状**（先 resolve_source、有 freeze_glossary、有 update_row、无整文件灌译）  
- **子代理/真模型验收（战役验收）:** 用 opencode 子代理 + 真模型，工作台只给 clean 源 + TMDB +（可选）同剧中字；**不提供 Brave**；对照「魔女与使魔」等已有中字专名，禁止纯音译交差  
- **禁止**用「MockLM 忠译 40 行 → installed」作为产品质量签字  

### 11.3 回归样本

| 样本 | 期望 |
|---|---|
| Witch Watch（ja，有 eng 内嵌，有 OS 中字兄弟集） | 源=日或 no-source；若译，术语锚同剧中字/日源，非英音译 |
| Peacemaker（en，PGS only） | F1 英源或 no-source |
| Adam E06（ja，无源） | no-source |
| Overflow 错时长外源 | 候选拒绝 / no-source，零 LLM 或极少 |

---

## 12. 观测与配置

- runs: `translate:*` + `sourceRef` + `llm_calls`（尝试边界）  
- staging 保留策略: 失败默认保留 N 天（P3）  
- env: 既有 TRANSLATE_*；可选 `TRANSLATE_STAGING_RETAIN_FAILED=1`  
- 无新 Brave/SearXNG 依赖  

---

## 13. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Agent 步数爆炸 | step cap + skill 强制窗口化；P1 先单集 |
| 模型绕过工具手写 SRT | finalize 只认 merge 产物；无 out/target 不装 |
| ja 无 jimaku | 诚实 no-source；不英中继 |
| 与 find 竞态抢装 | 既有：翻译候选 unavailable；装盘前再读 sidecar |
| 磁盘泄漏 | GC `.subtitle-translate`；对齐 stagingSandbox |

---

## 14. 成功标准

**P1 done 当且仅当：**

1. 存在 `makeTranslateWorker` + skill + staging 契约测试绿  
2. ja+eng 内嵌用例：**不**选择 eng 为源  
3. 工作台文件在成功路径上齐全（canonical、clean、glossary、bilingual、out）  
4. 装盘路径仅 merge 产物；fail-closed 单测在  
5. 文档：本 spec + plan 勾选 P1  

**战役 done 当且仅当：** P1–P3 按本 spec 勾完，且至少一条真机/子代理验收证明「工作台 + 单跳 + 术语文档」路径，而非批灌 prompt。

---

## 15. 决策记录（brainstorming）

| 决策 | 选择 |
|---|---|
| 架构 | Disk Workspace Agent（方案 1） |
| Staging | 每任务独立目录（A） |
| 选源 | origin-lang 单跳（A） |
| 上下文 | TMDB + 同剧目标语字幕 + wiki(P2)；禁 Brave |
| Spec vs 实现 | Spec=全图 C；实现从 P1(A 闭环)起 |
| 旧 pipeline | 可复用为 window helper，不作主入口 |

---

## 16. 参考

- `docs/design/2026-07-20-ai-translation-design.md`  
- `docs/design/2026-07-21-f1-source-lang-fetch-translate-design.md`  
- `docs/design/2026-07-21-f2-jimaku-ja-source-design.md`  
- DelTA: https://arxiv.org/abs/2410.08143  
- SWE-agent ACI: https://arxiv.org/pdf/2405.15793  
- Andrew Ng translation-agent: https://github.com/andrewyng/translation-agent  
