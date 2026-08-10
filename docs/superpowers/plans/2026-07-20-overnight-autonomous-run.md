# 整晚自主运行 · 实施计划(runbook)

> **执行者**:主循环 Claude(本账号)= 编排官 + 判官;重活交 opencode company 端点子代理。
> **串行**:Phase 1 → 2 → 3,前一相收口提交后才进下一相。checkbox 追踪。
> spec:`docs/design/2026-07-20-overnight-autonomous-run-spec.md`。E 设计:`docs/design/2026-07-20-ai-translation-design.md`。

**Goal:** 一夜内串行完成 #12 recognizer 修复、E AI 翻译(原型验证→质量闸→落项目)、全项目 agency 审计(高置信自动修)。

**Architecture:** 主循环编排 + 判断,opencode company 端点模型(强=opus-4-8/gpt-5.6-sol、弱=deepseek-v4-flash、人格=momus/oracle)干活。E 走"强模型调轮廓→弱模型测回归→打磨→质量闸门控落项目"。不用项目 Workflow 工具。

**Tech Stack:** subtitle-scout(v3 agentic,TS/vitest/better-sqlite3);opencode CLI 1.17.11;ffmpeg;软路由 `media-router-tunnel`。

---

## 前置参考(每相都用)

- **opencode 调用**(实测已验 2026-07-20 夜):
  - 强:`opencode run --model company/claude-opus-4-8 "<prompt>"`;交叉:`--model company/gpt-5.6-sol`。
  - 弱:`opencode run --model deepseek/deepseek-v4-flash "<prompt>"`。
  - 人格:`opencode run --agent momus "<prompt>"` / `--agent oracle`。
  - **大输入/输出走文件**:opencode 子代理有 Read/Write 工具——把输入写 scratch,prompt 里让它 read 输入路径 + write 输出路径,主循环再读输出文件(别塞巨型 inline)。每调带 `timeout 300`。
- **测试**:`npx vitest run`(全量 1747+);`npx tsc --noEmit -p tsconfig.json`(须 exit 0)。CWD 陷阱:每条 bash 显式 `cd /Users/dirtyfancy/projects/subtitle-scout`。
- **提交纪律**:每 Task 收口提交;docs 直提 main(小改惯例);功能用 feat 分支或直提据规模。
- **续跑**:每相收口更新本文件 checkbox + roadmap;运行日志留 scratch。

---

## Phase 1 — #12 recognizer 修(括号密集片名 park 回归)

**Files:**
- 诊断/修:`src/recognition/parseFilename.ts`、`src/recognition/identifyFromPath.ts`、`src/recognition/resolveToTmdb.ts`、`src/recognition/index.ts`(recognize)
- 测试:`src/recognition/*.test.ts`(对应文件旁)

- [ ] **Step 1.1 复现(主循环)**:写一次性脚本对两个真文件名跑 recognize() 全链,打印每层(parse→identify→resolve)输入输出。
  - 目标名:`The Astronaut (2025) [2160p] [4K] [WEB] [5.1] [YTS.MX].mkv`、`[The-Nut] High School DxD Hero - 01.mkv`。
  - 命令:`cd /Users/dirtyfancy/projects/subtitle-scout && npx tsx -e "<import recognize + 打印每层>"`(或加临时 console 到 recognize)。
  - 期望:看清在哪层标题被方括号污染 / TMDB 失配。

- [ ] **Step 1.2 定位根因(主循环判断)**:比对 parseFilename 对括号组的处理 vs 干净名。写下根因一句话(如"parseFilename 把 [YTS.MX] 并入 title / DxD Hero 的 [The-Nut]+绝对号未被剥离")。

- [ ] **Step 1.3 派 opencode 实现子代理写失败测试**:
  - `opencode run --model company/gpt-5.6-sol "在 subtitle-scout 仓 src/recognition/ 加回归测试:输入文件名 'The Astronaut (2025) [2160p][4K][WEB][5.1][YTS.MX].mkv' 期望 parseFilename 提取 title='The Astronaut' year=2025;输入 '[The-Nut] High School DxD Hero - 01.mkv' 期望识别到系列(TMDB DxD)。只写测试、先让它红。用 vitest,照现有 *.test.ts 风格。"`
  - 主循环复核测试合理,`npx vitest run src/recognition` 确认红。

- [ ] **Step 1.4 修根因(opencode 实现 + 主循环复核)**:据 1.2 根因,派 opencode 在 parseFilename/identifyFromPath 清方括号组噪声(保留真标题);DxD Hero 力争识别到 tmdb:45950 S4。**北极星:只修"该识别没识别出",绝不放宽成瞎认。** 复核 diff 只在解析层、无模糊打分门。

- [ ] **Step 1.5 测试绿 + 全量回归**:`npx vitest run src/recognition`(新测绿)→ `npx vitest run`(1747+ 全绿)→ `npx tsc --noEmit`(exit 0)。

- [ ] **Step 1.6 真机复核**:部署(rsync + detached build,见 D 手法)→ 清 parked / 重跑识别(`reconcile-all` 或重置 parked_paths 让 rescue-identify 重跑)→ 查 movies 是否回 The Astronaut、DxD Hero 是否建集不再 park。
  - 查:`docker exec -i subtitle-scout node -e "...select count from parked_paths / movies..."`。

- [ ] **Step 1.7 提交 + 收口**:`git commit -m "fix(recognition): 括号密集/非常规发布名解析(D#2 回归)"`;更新 roadmap #12→完成、task #12→completed;更新本文件 Phase 1 checkbox。

---

## Phase 2 — E AI 翻译(原型先行 → 质量闸 → 落项目)

### 2a 原型语料

- [ ] **Step 2a.1 抽真英文字幕**:从 NAS 抽 1-2 份真英文字幕当原型输入(要有专名/世界观/角色名硬骨头)。
  - 内嵌 eng 轨:软路由上 `ffmpeg -i <video> -map 0:s:<engTrackIdx> /path/out.srt`(先 `ffprobe` 找 eng 轨号)。候选:任何带内嵌 eng 的媒体(不限 The Rig——用户已解绑)。
  - scp 抽出的 .srt 到本地 scratch:`<scratchdir>/e-proto/source-<name>.srt`。
  - 期望:2 份不同题材的真英文字幕(如一部剧 + 一部电影),各 ≥200 cue。

### 2b 强模型调轮廓("好"长什么样)

- [ ] **Step 2b.1 派强模型按 E pipeline 译原型**:prompt 编码 E 设计的方法(术语表先行→场景分批带滚动记忆→CJK 约束 ≤~16全角/行 ~9CPS→时轴/样式标签冻结不译)。
  - `opencode run --model company/claude-opus-4-8 "read <scratch>/e-proto/source-X.srt。第一步:通读全片,产出 EN→ZH 专名记录(角色名/地名/世界观术语/敬称),写 <scratch>/e-proto/glossary-X.json。第二步:按场景分批(10-40行,2秒间隔切场)译成简体中文,每批钉死术语表 + 带上批滚动摘要,冻结时轴/样式标签只译文本。写 <scratch>/e-proto/ref-X.zh.srt。"`
  - 交叉:同样任务派 `company/gpt-5.6-sol` 出第二版参照,主循环比对取优。

- [ ] **Step 2b.2 主循环判质量**:读 ref-X.zh.srt,人肉核:专名跨场景一致?通顺?CPS 合理?时轴/标签没动?锚定"好译文"标准,记入 `<scratch>/e-proto/quality-notes.md`。

### 2c 弱模型测回归(制造失败模式)

- [ ] **Step 2c.1 弱模型译同一语料**:`opencode run --model deepseek/deepseek-v4-flash "read <scratch>/e-proto/source-X.srt,译成简体中文(不给术语表,单批过),写 <scratch>/e-proto/weak-X.zh.srt。"`
  - 期望:产出 plausible-but-flawed(专名漂移如"金洛克"↔"金洛奇"、CPS 超标、幻觉、术语破)。

- [ ] **Step 2c.2 攒回归语料**:主循环 diff weak-X vs ref-X,标出弱模型的每处错(专名漂移/结构破/幻觉),写 `<scratch>/e-proto/regressions-X.md`——这是质量闸**必须抓住**的已知坏译清单。

### 2d 打磨质量闸

- [ ] **Step 2d.1 原型质量闸(本地脚本/主循环)**:实现/验证 fail-closed 闸四层——①结构确定性(行数/时轴逐字节/样式标签)②术语符合性(每专名匹配术语表)③LLM-judge(派 opencode 强模型出 MQM 错误分型)④回译抽查(高风险行派模型回译比原文)。
- [ ] **Step 2d.2 闸对 ref/weak 双测**:闸放行 ref-X(好译)、拦下 weak-X 的每处 2c.2 已知错。迭代直到:好译过、坏译被拦、失败留英文+标记(绝不静默装错译)。记 `<scratch>/e-proto/gate-results.md`。

- [ ] **Step 2d.3 质量门决策(主循环判官)**:
  - **达标**(2b 好译过闸 + 2d 坏译被拦 + 结构不变量保)→ 进 2e 落项目。
  - **不达标** → **不落**,写 `docs/design/2026-07-20-e-prototype-report.md`(阻塞点 + 回归语料),Phase 2 收口留下一程,直接跳 Phase 3。

### 2e 落项目(**门控:仅 2d.3 达标才做**)

照 E 设计规格落 `translateWorker`。**Files**(照 E 设计 §架构):
- Create:`src/agent/translateWorker.ts`、`src/agent/translateWorker.tools.ts`、`src/agent/translateWorker.schemas.ts`、抽取 util `src/files/extractEmbeddedSub.ts`、`src/v2/translateWorkerTask.ts`
- Modify:sub_status 引入"可译"(`src/v2/db.ts` 迁移 + `src/v2/libraryRepo.ts`)、编排派活(`src/v2/reconcileAll.ts`)、`src/cli/index.ts`(watch 注入 worker)
- Test:各 `*.test.ts` + eval(照 `findSubtitleWorker.eval.test.ts` 手法)

- [ ] **Step 2e.1 探测/触发(TDD)**:`embedded_langs` 含非目标可抽轨 + 无目标外挂 →"可译候选";加迁移 + repo 查询。派 opencode 实现子代理,主循环复核(圣文件不碰、DB 迁移照 v7 配方)。红先验证 → 实现 → 全绿。
- [ ] **Step 2e.2 抽取 util(TDD)**:`extractEmbeddedSub`(ffmpeg -map,冻结时轴+样式)。单测 ffmpeg map 解析。
- [ ] **Step 2e.3 上下文工具(TDD)**:`read_series_existing_subs`(同剧既有中字播种术语表,库内直读零网络)+ `get_tmdb_context`(复用 B 的 TMDB 管线)。
- [ ] **Step 2e.4 translateWorker agent(TDD + eval)**:术语表先行→串行分批带滚动记忆→grounded 精修→fail-closed 闸(把 2d 验证过的闸逻辑固化)→落外挂中文 + 按剧持久化术语表。用 MockLM eval 断言术语一致/结构完整/fail-closed(坏译被拦)。
- [ ] **Step 2e.5 全量 + tsc**:`npx vitest run`(全绿)+ tsc exit 0。
- [ ] **Step 2e.6 真机端到端**:部署 → 找一部带内嵌英文轨的媒体 → 触发 translate → 出中文外挂 → 主循环人肉抽验质量 + 确认 fail-closed(低质不装、留英文+标记)。
- [ ] **Step 2e.7 提交 + 收口**:提交;更新 roadmap E→完成、task #10→completed;更新本文件。

### 2 收口
- [ ] **Step 2.done**:无论 2e 落地 or 2d.3 只出报告,更新 roadmap E 状态 + 本文件 Phase 2 checkbox,提交。

---

## Phase 3 — 全项目审计(agency 人格,高置信自动修)

**Files:** 全仓 `src/**`(读审为主);修复按发现落对应文件 + 测试。

- [ ] **Step 3.1 分维度派人格审计**:对关键子系统分维度派 opencode 人格审(正确性/安全/简化/测试覆盖)。
  - `opencode run --agent momus "审计 subtitle-scout 仓 <子系统/文件集> 的正确性与边界:找真 bug、失败场景、竞态。每条给 file:line + 复现路径 + 严重度。别报风格偏好。"`
  - `opencode run --agent oracle "审 <子系统> 的架构/简化/测试覆盖缺口:哪些逻辑没测、哪些能简化。给具体位置。"`
  - 分批覆盖:agent/*(worker/tools/skills)、cli/*(fetchLib/adapters/buildAdapters)、v2/*(db/repos/reconcile/ingest)、files/*、recognition/*、adapters/providers/*、dashboard/*。
  - 产物写 `<scratch>/audit/findings-<subsystem>.md`。

- [ ] **Step 3.2 主循环对抗式复核每条**:逐条验——是不是真问题?可复现?看真代码坐实(别信子代理一面之词)。分类:CONFIRMED-高置信 / PLAUSIBLE-待定 / 误报。写 `<scratch>/audit/verified.md`。

- [ ] **Step 3.3 高置信自动修(门控:测试须绿)**:对每条 CONFIRMED:
  - 派 opencode 实现子代理修(TDD:先加复现该 bug 的失败测试→修→绿)。
  - **门控**:改后 `npx vitest run` 全 1747+ 绿 + tsc exit 0 → 提交;**任何修破测试 → 回退 + 降级为报告**,绝不带病提交。
  - 每修一条一提交(`git commit -m "fix(<area>): <审计发现>"`)。

- [ ] **Step 3.4 出审计报告**:PLAUSIBLE + 未修的 CONFIRMED → `docs/design/2026-07-20-project-audit-report.md`(按严重度,含复核判词),留早上用户定夺。提交。

- [ ] **Step 3.5 收口**:更新 roadmap + 本文件 Phase 3 checkbox;全量测试 + tsc 终检绿;提交。

---

## 整夜收尾

- [ ] **Step Z.1 终报**:写 `docs/design/2026-07-20-overnight-run-report.md`——三相各自结果(#12 修否/E 落否/审计修了几条)、真机验证、剩余项。更新 roadmap 顶部进度实况。提交。
- [ ] **Step Z.2 内存**:更新 `project-v3-agentic-rebirth.md` 顶部接续块 + MEMORY.md hook 反映整夜战果。
- [ ] **Step Z.3 早安推送**:PushNotification 汇报整夜战果给用户。

---

## Self-Review(spec 覆盖核对)

- ✅ 三相串行、opencode 省配额、不用 Workflow → 前置参考 + 各相分工体现。
- ✅ #12 systematic-debugging+TDD+真机 → Phase 1。
- ✅ E 强→弱→打磨→质量闸门控落项目 → Phase 2(2b强/2c弱/2d闸/2e门控落)。
- ✅ 审计 momus/oracle + 对抗复核 + 高置信测试绿自动修 → Phase 3。
- ✅ 兜底:E 不达标只报告(2d.3)、审计破测即回退(3.3)。
- ⚠️ 有意保留的执行期不确定:#12 精确根因(1.1 复现坐实)、E 落项目的确切代码(依赖 2b-2d 原型结果 + E 设计规格的组件形状)——这类研究-then-实现任务的性质使然,已用"复现先行"+"质量门控"+"引用 E 设计规格具体组件"把不确定收敛到可执行。
