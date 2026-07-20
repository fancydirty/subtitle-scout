# AI 字幕翻译 · 设计文档（2026-07-20,roadmap item E）

## 目标 & 北极星

给 subtitle-scout 加"AI 翻译"能力:当一个视频**内嵌了非目标语言的 soft 外挂轨**(如 The Rig 的内嵌英文
soft sub,可抽取、非硬字幕)、且**无目标语(中文)外挂字幕**时,抽取该轨 → 用 agent **带全局上下文、
全局一致地**译成中文 → 落外挂中文字幕。

**北极星(用户钦定):错译比留缺口更糟。质量闸 fail-closed,最坏允许结局="这行留英文 + 标记",
绝不静默装错译。**

调研支撑(2026 SOTA):DelTA(ICLR 2025,专名记录+四层记忆)、Andrew Ng translation-agent(reflect-refine)、
llm-subtrans(场景分批 UX)、CometKiwi/回译(质量估计)。核心结论:**术语表先行 + 分批带记忆 + fail-closed
结构/语义闸**,不是整集一次过、不是裸逐行。

## 核心设计决策(brainstorming 定盘,用户 2026-07-20 拍板)

- **逐行翻译=灾难;整集一次过=陷阱**(每句阅读速度约束/长上下文迷失中段/一次坏响应毁整档无恢复粒度)。
  → **术语表(专名记录)先冻结,再按场景分批(10-40 行,2 秒间隔切场)串行翻译,每批带滚动记忆。**
- **架构=编排式单 agent,翻译串行,不并行子代理翻译**。理由:并行会打碎"滚动记忆(本批带上批摘要+尾行)"
  这条一致性支柱。术语表可共享不怕并行,但滚动上下文一拆就废。**上下文攒取阶段可并行**(TMDB/旧字幕独立 fetch)。
  QA 用**独立 critic 角色**。
- **上下文源(v1)=同剧既有中字 + TMDB**;**不接 SearXNG / 搜索 SaaS / Jina**(用户拍板)。wiki(MediaWiki
  API 直搜直取,返回结构化干净内容故无需 Jina 提取层)+ 通用 web 搜索留 **phase-2**。
  - **同剧既有中字是最高性价比上下文**(最便宜、最高精度、零搜索):S01E01 已有好中字(**无论是不是 AI 译的**)
    → 挖它给 S01E02 播种术语表。subtitle-scout 本身就产这些字幕,天生有此源。The Rig 实证有(仅 S2E1/E6 缺,
    其余集有中字)。
  - TMDB 给结构(剧情/演员**英文名**),**但 TMDB 不译角色中文名**——是背景骨架不是术语表。
- **质量闸(v1)**=结构确定性检查(行数一致/时轴逐字节不动/索引时间戳保留/样式标签完整)+ **术语表符合性**
  (每个专名匹配其记录,否则该行自动失败)+ LLM-as-judge(MQM 错误分型)+ **回译抽查**(对高风险/低置信行,
  抓 QE 漏掉的幻觉/漏译)。**CometKiwi 等 QE 模型留 phase-2**(要托管开源权重模型,v1 先靠确定性+LLM-judge+回译)。

## 架构

新增 `translateWorker`(agent,照 `src/agent/findSubtitleWorker.ts` 模子)+ 抽取 util + 上下文攒取工具。
现有 `ai` SDK tool 框架、`llm.ts` makeModel、按剧持久化(可复用 tmdb_seasons/新表)一并复用。

### 流水线(编排式单 agent 驱动)

```
① 探测   embedded_langs(streamProbe 已有)含非目标 soft 轨(eng)且无目标外挂 → 可译候选
② 抽取   ffmpeg -map 0:s:N 拉出该轨 → 源文本 .srt/.ass（ffmpeg 已在镜像;冻结时轴+样式标签出 LLM 视野）
③ 攒上下文(可并行)  同剧既有中字(播种术语表)+ TMDB 剧/逐集简介+cast → [phase-2: wiki/web]
④ 冻结术语表  agent 通读整集+上下文 → EN→ZH 专名记录(角色名/地名/世界观术语/敬称/口头禅),去重取
              canonical,**按剧持久化**(E02+ 继承 E01 的决定)
⑤ 串行分批翻译  场景分批;每批 prompt 带:钉死术语表 + 滚动双语摘要 + 前几行 + CJK 约束(≤~16 全角/行,
              ~9 CPS);每批后更新摘要 + 追加新见专名
⑥ grounded 精修  reflect-refine,但锚定术语表/行数/CPS,critic 出 MQM 分型错误;高置信干净批跳过省成本
⑦ fail-closed 质量闸  确定性(行数/时轴/标签/术语符合性)→ LLM-judge → 回译抽查;硬闸过才装,否则该行
              精修/回退留英文/整档隔离待人工
⑧ 落盘 & 持久化  外挂中文 .srt/.ass 时轴对齐落盘;术语表+摘要按剧存,下一集自动继承
```

### 触发 / 状态

现有 `sub_status` 无"可译"概念。E 引入:`embedded_langs` 含非目标可抽取轨 + 无目标外挂 →**可译候选**
(区别于 `embedded`=已有目标语内嵌轨=已覆盖)。译成功 → 落外挂中文 → 转 `covered`(标记来源=ai-translated)。
失败/低质 → 不装,留原态 + 诚实标记(不冒充覆盖)。

### agent 工具集

- `extract_embedded_sub`(ffmpeg -map,抽非目标 soft 轨)
- `read_series_existing_subs`(同剧其他集既有中字 → 播种术语表;库内直读,零网络)
- `get_tmdb_context`(剧/逐集简介 + cast,复用 B 的 TMDB 管线)
- `translate_batch` / glossary 内部状态(agent 循环内维护)
- critic/verify(独立角色,MQM 分型 + 回译)
- **[phase-2]** `wiki_lookup`(MediaWiki API 直搜直取 Fandom/萌娘/Baidu)、`web_search`(SaaS,keys 在
  本机 projects/token(1).txt + 软路由 SearXNG 容器——按需实测选型;单 SearXNG 不够=研究实锤)

## 错误处理 / 诚实降级(北极星)

- 无可抽取轨 / 抽取失败 → 非可译候选,原样(不猜)。
- 上下文攒取空(如全新剧无同剧中字、wiki 无收录)→ agent 把"搜到空"当**"未知,标记"**,绝不当"不存在",
  术语表相应留空/降级,翻译更保守。
- 质量闸任一硬闸失败 → **不装**(精修/回退留英文/隔离),诚实标记,不静默装错译。
- 时轴/样式标签**全程冻结出 LLM 视野**,只译文本 span——杜绝时轴漂移/标签损坏。

## 测试策略

- **单元**:抽取(ffmpeg map 解析)、术语表符合性检查、结构闸(行数/时轴/标签)、回译分歧判定、
  同剧中字播种术语表、场景分批切分。
- **eval**(照 `findSubtitleWorker.eval.test.ts` 手法):固定源片段 + 脚本 MockLM,断言术语一致性/结构完整/
  fail-closed 行为(坏译被拦)。
- **真机**:The Rig S2E1/E6(内嵌英文轨 + 同剧 S2E2-5 既有中字当上下文)端到端 → 出中文外挂 → 人工抽验质量。

## 范围外 / phase-2(YAGNI)

- **wiki 源(MediaWiki API)+ 通用 web 搜索 SaaS**——v1 靠同剧中字+TMDB;wiki/web 待 v1 主链跑通后加
  (用户:先证明主链在 The Rig 上跑通、质量能看,别被搜索基建拖住)。
- **CometKiwi/xCOMET 等 QE 模型**——要托管,phase-2;v1 靠确定性闸+LLM-judge+回译。
- **并行子代理翻译**——会打碎滚动记忆,除非日后配"检索式相关上下文"补偿,否则不做。
- 非英→中的其他语向、硬字幕 OCR——本轮只做"内嵌 soft 非目标轨 → 中文外挂"。
