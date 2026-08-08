# 实施计划 + HANDOFF：语言泛化(A) + 自研识别(C) + 自研巡检触发(B)

> **对接手的 fresh Claude**：这份文档是计划**也是交接**。你没有前面的对话上下文,先读「Part 0 交接」把状态和铁律吃进去,再按「Part 1 计划」用 **subagent-driven-development**(sonnet 子代理逐 Task 执行、你编排验收)推进。设计依据是同目录 `2026-07-15-language-generalization-and-self-hosted-scan-design.md`(commit 45b9332)。

---

# Part 0 · 交接(接手前必读)

## 你是谁、在哪、干什么
- 项目 **subtitle-scout**,仓在 `/Users/dirtyfancy/projects/subtitle-scout`(**不是** `subtitle-plugin`——那是会话 CWD 的另一个陈旧仓,别在里面干活;`git worktree` 隔离会误建到它,所以**subtitle-scout 的活别用 worktree 隔离**,用非隔离子代理走绝对路径)。
- 产品定位(用户 2026-07-15 锐化):**agent 驱动的 Bazarr 替代品**,最终把 Jellyfin 降为纯刮削器。详见记忆 `product-vision-beyond-sidecar.md`。
- 用户是「哥们」,中文、非正式、气势足、爱喷愿景但一旦 overwhelmed 会焦虑——你的活是**攥住方向盘、把愿景一块块焊成真、别把整座山压回他肩上**。

## 先读这些(按序)
1. 记忆索引 `~/.claude/projects/-Users-dirtyfancy-projects-subtitle-plugin/memory/MEMORY.md`,尤其 `project-v3-agentic-rebirth.md`(最高优先级,顶部有接续点)、`product-vision-beyond-sidecar.md`、`feedback-*.md`(铁律)。
2. 设计文档 `docs/design/2026-07-15-language-generalization-and-self-hosted-scan-design.md`。
3. 本文档 Part 1。

## Git 状态(交接时刻)
- 分支 `main`,HEAD 应为本文档提交。全部已提交,树干净。
- 测试基线 **1345 绿**、tsc 干净。每个 Task 后 `npx tsc --noEmit` + `npx vitest run` 必须绿。
- 今晚已完成并合并 main 的(别重做):v3 核心真站验证、B 层 12/12、withConnectRetry、旧pipeline **墙①(captcha,479f157)+ 墙②(realign→v3 worker,94457bd,真站 PASS)**、A层矩阵铺满 + 矩阵逻辑纠正(ed1db75)。**旧 pipeline 大删除(Phase3)故意暂缓**——blocked 在本计划的 B(自动触发)落地,别去删。

## 真站/软路由访问(A/C 的实测、B 的验证会用到)
- 在家:`ssh media-router`(直连 LAN,root)。在公司:`ssh media-router-tunnel`(cloudflared,~/.ssh/config 已配)。**直连不通=用户在公司,切 tunnel**。家网/隧道都会抖 → 长作业一律 **detached(`nohup … >log 2>&1 </dev/null &`)+ 重试轮询**,断连不影响作业。
- 部署路径 **`/mnt/nvme0n1-4/scout-test`(持久 nvme)**——**绝不用 `/tmp`(tmpfs,重启抹光)**。`.env`(真 LLM_*/assrt/TMDB_API_KEY)+ node_modules 命名卷都在。跑法:本地 `git archive --format=tar.gz -o <scratch>/h.tgz HEAD` → `scp` 到 `/mnt/nvme0n1-4/` → 路由上 `cd /mnt/nvme0n1-4/scout-test && tar xzf`(保 .env + 卷)→ `docker compose -f docker-compose.test.yml run --rm test npx tsx <script>`。NAS 媒体在 `/mnt/nvme0n1-4/nas_media`。别扰其他容器(subtitle-scout/scout-jellyfin/mediary-scout 等在跑生产)。
- **用户明确授权**:真站测试可在 NAS 建隔离测试目录、拷真实资源进去、随便瞎搞排序,不怕坏/删,只要辐射限于该测试目录。realign 真站验证时建过 `/mnt/nvme0n1-4/nas_media/_scout_realign_test/`(My Hero Academia flat 1..30)可参考/复用。

## 铁律(用户反复强调,违反 = 掉价)
- **实现交给 sonnet 子代理,你编排/分派/验收,别啥都自己写**(`impl-use-sonnet-subagents`)。写好 spec/Task 派下去,回来**亲自复核 diff**(尤其碰 realign 的,拿 diff 对着"5 重安全层一行没动"验)。
- **绝不用 Workflow 工具**(用户不要它在其端冒 session,`feedback-subagents-over-workflow`)——直批 Agent 子代理。
- **skill 只有人 + 主控 Claude 改,跑活的 agent 无权改任何 skill**。
- **realign 的 5 重安全层(restructuring/manifest/reveal/rollback)绝不削弱**。
- **别停摆**:能自己做的净赚小事直接做,别拿开放问题堆用户(`feedback-dont-stall-just-do`);但真需要拍板/思考逻辑的叉子才叫他。
- **`.research/`** 里 clone 了 `video-filename-parser`(gitignored)供读源码,C 会用到。

## 老规矩工作流
brainstorming(已完成,设计文档在)→ writing-plans(本文档)→ **subagent-driven-development**:逐 Task 派 sonnet 子代理执行 + 你两阶段复核 + 合并。A 和 C 可并行(改的文件基本不重叠,但都提交 main,**要么串行提交、要么各自非隔离顺序做**);**B 必须等 C 落地**。

---

# Part 1 · 实施计划

**Goal**:让目标字幕语言可配(A)、让系统自己识别媒体文件→tmdbId(C)、让系统自己周期巡检并触发工作流(B),使项目从 Jellyfin sidecar 迈向独立产品。

**Architecture**:A=把已有的"跳中文原音"门泛化成参数化 + 把写死的 zh-Hans/zh-Hant 二值域泛化;C=新的路径感知识别模块(`video-filename-parser` 拆各段 + 我们合并 + TMDB 搜 + 消歧/park);B=daemon 周期扫 + 差异检测 + 经 C 识别 + 触发 orchestrator。

**Tech Stack**:TypeScript ESM(`.js` specifier)、vitest、zod、`@ctrl/video-filename-parser`(新增依赖)、既有 TmdbClient。

## Gate 纪律
每个 Task 后 `npx tsc --noEmit`(干净)+ `npx vitest run`(绿)。逐 Task 提交,conventional message + 结尾 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

## 子系统 A：目标语言泛化 + 同语言跳过门

**关键情报(今晚摸清,省你重踩)**:
- **同语言跳过门已经存在,只是写死中文**:`scanLibrary`(`src/v2/scanner.ts:176`)有 `skipChineseOrigin: boolean`;`classifyItemDetailed`(scanner.ts:~70)用 `isChineseLang(originLang)`(权威门,TMDB original_language)+ `isChineseOrigin(item)`(ProductionLocations 兜底)+ `looksChineseTitle`(汉字启发式兜底)。`libraryRepo` 已缓存 `origin_lang`(db.ts:97 `origin_lang` 列,解析一次不重查)。经 `SKIP_CHINESE_ORIGIN` env 接线(cli/index.ts:319,368)。helper 在 `src/daemon/triggers.ts`(`CHINESE_LANG_TAGS`、`isChineseLang`、`isChineseOrigin`、`looksChineseTitle`、`needsChineseSubtitle`、`usableChineseSubtitleStreams`)。
- **设计取舍(重要,别做错)**:权威门(TMDB original_language)**要泛化成参数化**(目标语言 L,跳 original_language===L 的内容);但**中文专属的启发式兜底(汉字识别、CHINESE_ORIGIN 地名、needsChinese)不要硬泛化成"每种语言各一套启发式"——那是设计味不对**。做法:启发式兜底**保持中文专属,仅当目标语言集合含 `zh` 时才生效**;其他语言只走权威 TMDB original_language 门(拿不到就放行,宁多查勿漏配)。
- **zh-Hans/zh-Hant 二值域焊死在多处**(泛化必须全扫,否则装英文字幕会在 schema/DB 上炸或不被识别导致每轮重抓):
  - `src/agent/findSubtitleWorker.schemas.ts`:`FindSubtitleDecisionSchema.installedLanguage = nullableTolerant(z.enum(['zh-Hans','zh-Hant']))`。
  - `src/agent/findSubtitleWorker.tools.ts:94`:install 工具 `langTag: z.enum(['zh-Hans','zh-Hant'])`;:66 有 `langTag:'zh-Hans'` 默认。
  - `src/files/subtitleWriter.ts:19`:`langTag: 'zh-Hans' | 'zh-Hant'`。
  - `src/v2/scanner.ts`:`SubtitleLanguage = 'zh-Hans'|'zh-Hant'`、`CHINESE_TAGS`(磁盘 sidecar 探测,**只认中文字幕→装了英文字幕认不出→每轮重抓,必须泛化**)、`LANGUAGE_BY_TAG`、`findExternalChineseSidecar`。
  - `src/v2/findSubtitleWorkerTask.ts:180`、`libraryRepo.markCovered` 默认 `'zh-Hans'`。
  - `src/v2/db.ts:69` `subtitles.language` 注释 zh-Hans/zh-Hant(**纯 TEXT 无 CHECK 约束,DB 无需迁移**,存任意 BCP-47 tag 即可)。
  - `src/files/subtitleInspect.ts`:`detectedScript` 简繁探测——**这是中文专属的简繁判别,保留**,只是它的产物不再是唯一语言域。
- **provider 语言门控缝已有**:`FetchAdapter`(src/cli/fetchLib.ts:44)有 `enabled:(args,env)=>boolean` + `FetchArgs.languages?: string[]`(默认注释 `['zh-cn','zh-tw']`)。assrt(`src/cli/adapters/assrtAdapter.ts:16`)现在 `enabled: () => true`——**改成检查 `args.languages` 含中文变体才 enabled**。
- **skill 语言硬编码**:`src/agent/skills/findSubtitleSkill.ts:100` "Your target is a CHINESE subtitle…";worker prompt 在 `src/agent/findSubtitleWorker.ts:66-88` 插值 task 字段。

### Task A1：`FindSubtitleTask` 加 `targetLanguage`,worker prompt 参数化语言
**Files**:Create `src/agent/languages.ts`(新,单一职责);Modify `src/agent/findSubtitleWorker.schemas.ts`(FindSubtitleTask 接口加 `targetLanguage: string` — BCP-47 主语言码,如 `'zh'`/`'en'`)、`src/agent/findSubtitleWorker.ts`(prompt 66-88 加一行 target-language、把语言塞进 search 工具 languages 默认)、构造 FindSubtitleTask 的三处(`src/v2/findSubtitleWorkerTask.ts`、`src/v2/realignExecutor.ts` makeRealignRunEpisode、`scripts/live-accept-find-subtitle.ts`)补 `targetLanguage`(先硬默认 `'zh'`,A4 接配置);Test `src/agent/languages.test.ts` + worker schema 测试。
- [ ] Step1 写失败测试:`languageName('zh')==='Chinese'`、`languageName('en')==='English'`、`languageName('xx')==='xx'`(fallback);FindSubtitleTask 带 `targetLanguage:'en'` 过类型。
- [ ] Step2 跑测试确认红。
- [ ] Step3 实现 `src/agent/languages.ts`:`export function languageName(code: string): string`(小表 `{zh:'Chinese',en:'English',ja:'Japanese',ko:'Korean',...}` + `?? code`);FindSubtitleTask 加 `targetLanguage: string`;worker prompt 加 `` `target subtitle language: ${languageName(task.targetLanguage)}` ``;三处构造点补 `targetLanguage: 'zh'`。
- [ ] Step4 跑绿;`npx tsc --noEmit` 干净。
- [ ] Step5 提交 `feat(lang): FindSubtitleTask.targetLanguage + languageName + parameterized worker prompt`。
- **注意**:`installedLanguage`/`langTag` 枚举本 Task 不动(A2 处理)。

### Task A2：泛化 `installedLanguage`/`langTag` 语言域(去 zh-Hans/zh-Hant 二值锁)
**Files**:Modify schemas.ts、findSubtitleWorker.tools.ts、subtitleWriter.ts、findSubtitleWorkerTask.ts、libraryRepo.ts;Test 对应。
- [ ] Step1 写失败测试:装一个 `en` 字幕走 install 工具 → 返回 `installedLanguage:'en'` 不被 schema 拒;markCovered 记 `language:'en'`。
- [ ] Step2 红。
- [ ] Step3 `installedLanguage`/`langTag` 从 `z.enum(['zh-Hans','zh-Hant'])` 放宽为 `z.string().min(1)`(存 BCP-47/脚本 tag)。**中文简繁细分保留**:install 工具对中文候选仍用 subtitleInspect 的 detectedScript 产 `zh-Hans`/`zh-Hant`,其他语言直接用 targetLanguage code。markCovered 默认从 `'zh-Hans'` 改为调用点显式传 task.targetLanguage。DB 无迁移。
- [ ] Step4 绿 + tsc 干净。
- [ ] Step5 提交 `refactor(lang): generalize installedLanguage/langTag beyond zh-Hans/zh-Hant`。

### Task A3：磁盘 sidecar 探测泛化(否则非中文已装字幕不被识别 → 每轮重抓)
**Files**:Modify `src/v2/scanner.ts`(`CHINESE_TAGS`/`LANGUAGE_BY_TAG`/`findExternalChineseSidecar` → 参数化);Test scanner 测试。
- [ ] Step1 写失败测试:目标含 `en` 时,`.en.srt` sidecar 被识别为已覆盖(不判缺)。
- [ ] Step2 红。
- [ ] Step3 加 `tagsForLanguage(code: string): string[]`(`zh`→现 `CHINESE_TAGS`;`en`→`['en','eng']` 等);`findExternalChineseSidecar` 泛化为 `findExternalSidecar(videoPath, targetTags, fileExists)`;scanner 从 opts 收目标语言集合。
- [ ] Step4 绿 + tsc。
- [ ] Step5 提交 `feat(lang): generalize on-disk sidecar detection to target language`。

### Task A4：同语言跳过门参数化 + provider 语言门控 + 配置读取点
**Files**:Modify scanner.ts(`classifyItemDetailed`/`scanLibrary` 的 `skipChineseOrigin` 泛化)、`src/daemon/triggers.ts`、`src/v2/reconcileAll.ts`、`src/daemon/watcher.ts`、cli/index.ts(config)、`src/cli/adapters/assrtAdapter.ts`;Test 对应。
- [ ] Step1 写失败测试:①cdrama(original_language=zh)+ 目标含 zh → `ignored`;+ 目标只 `['en']` → 不 ignored。②`assrt.enabled({languages:['en']})===false`;`assrt.enabled({languages:['zh-cn']})===true`。③启发式兜底(looksChineseTitle/isChineseOrigin)在目标不含 zh 时不生效。
- [ ] Step2 红。
- [ ] Step3 `skipChineseOrigin: boolean` → `targetLanguages: string[]`(贯穿 scanner/reconcileAll/watcher/cli 接线)。权威门:`if (targetLanguages.includes(langOf(originLang))) → ignored`(`langOf` 把 TMDB original_language 归一到 BCP-47 主语言,如 `zh`)。**启发式兜底仅当 `targetLanguages.includes('zh')` 时跑**(注释写清:中文专属信号,不为其他语言泛化)。config:新增 `TARGET_LANGUAGES` env(逗号分隔,默认 `'zh'`)→ cli 读成 `string[]`;`SKIP_CHINESE_ORIGIN=false` 向后兼容=从 targetLanguages 去掉 zh 的跳过(或文档化迁移,你判)。assrt `enabled: (args) => (args.languages ?? []).some(l => /^(zh|chi|zho|chs|cht|cn)/i.test(l))`。
- [ ] Step4 绿 + tsc。
- [ ] Step5 提交 `feat(lang): parameterize same-audio-language skip gate + assrt language gating + TARGET_LANGUAGES config`。

### Task A5：skill 去中文硬编码(**主控 Claude/人来改,不派子代理**)
**File**:Modify `src/agent/skills/findSubtitleSkill.ts`;Test `findSubtitleSkill.test.ts`(锁语言参数化措辞)。
- [ ] "Language: coverage, not preference" 段 "CHINESE subtitle" 改为按目标语言参数化(skill content 模板 + worker 注入语言名);简繁"都算覆盖"话术**仅目标是中文时注入**。
- [ ] 跑测试 + tsc 绿,提交 `skill(lang): parameterize target-language wording (human/orchestrator-edited)`。
- **铁律**:skill 只人 + 主控 Claude 改——本 Task 由接手的你(主控)亲手改+提交,不派子代理。

---

## 子系统 C：自研媒体识别(路径 → tmdbId)。**B 的前置**

**关键情报**:库 `@ctrl/video-filename-parser`(`.research/video-filename-parser` 已 clone 供读源码;运行用 `npm i @ctrl/video-filename-parser`)。`filenameParse(name: string, isTv): ParsedFilename`,**纯单字符串、零路径感知**(已验证)。输出 title/year/seasons/episodeNumbers/isMultiSeason/complete/quality/group/languages,**有动漫绝对集号支持**(`applyAbsoluteEpisodeNumbers`)。路径感知合并是我们要建的。元数据源=**TMDB**(自己的 `TMDB_API_KEY`,`TmdbClient`;tmdb.ts 现有 getSeasonTable/getAbsoluteOrder/originalLanguage,**search 方法可能要补**——先读 tmdb.ts 确认)。

### Task C1：加依赖 + 纯解析包装
**Files**:Modify `package.json`(`npm i @ctrl/video-filename-parser`);Create `src/recognition/parseFilename.ts`(薄包装,统一返回形状)、`src/recognition/parseFilename.test.ts`。
- [ ] Step1 写失败测试:`parseFilename('[SubGroup] My Hero Academia - 26 [ABCD1234].mkv')` → title/absoluteEpisode=26;`parseFilename('Show.Name.S01E05.1080p.WEB-DL.mkv')` → title/season=1/episode=5。
- [ ] Step2 红。Step3 `npm i` + 实现薄包装(调 `filenameParse`,把库输出映射成我们的 `ParsedName` 结构:`{title, year, season, episode, absoluteEpisode, isTv, isMultiSeason, complete}`)。Step4 绿+tsc。Step5 提交 `feat(recognition): filename parser wrapper on @ctrl/video-filename-parser`。

### Task C2：路径分段 + 合并(路径感知核心)
**Files**:Create `src/recognition/identifyFromPath.ts`、`.test.ts`。
- [ ] Step1 写失败测试(**必含**):`间谍过家家/Season 1/ep 1.mp4` → title=间谍过家家(祖父段)、season=1(父段)、episode=1(文件段);`Show (2016) [tmdbid-65930]/Season 02/Show S02E03.mkv` → embeddedTmdbId=65930、season=2、episode=3;`movies/aaa/bbb.mkv` → 无标题候选 → `{park:'no-signal'}`。
- [ ] Step2 红。Step3 实现:切「文件名/父/祖父」三段 → 各段 `parseFilename` → 合并(集:文件名段;季:文件名段已含>父段 Season 文件夹>视为不分季;标题:祖父>父>文件,防御性排除把 "Season 1" 当标题;路径含 `[tmdbid-XXX]`/`[tvdbid-XXX]` 直取)。Step4 绿+tsc。Step5 提交 `feat(recognition): path-aware segment merge (title in ancestor dir, season in parent)`。

### Task C3：TMDB 搜索 + 消歧 + park
**Files**:Create `src/recognition/resolveToTmdb.ts`、`.test.ts`;可能 Modify `src/adapters/providers/tmdb.ts`(补 `search(query, year?, isTv)`——先读确认有没有)。
- [ ] Step1 写失败测试(用录制的 TMDB 响应,复用 `src/testing/replayFetch.ts`):嵌 id 直通;唯一命中→采用;多命中且年份/类型收不窄→`{park:'ambiguous'}`;年份精确匹配消歧。
- [ ] Step2 红。Step3 实现:嵌 id→直接;否则 TMDB search(title[,year]) → 消歧(年份精确>isTv 类型过滤>唯一)→ 收窄到 1 采用,否则 `PARK{reason}`。输出 `{tmdbId, title, isTv, season, episode, absoluteEpisode?}` | `{park:string}`。Step4 绿+tsc。Step5 提交 `feat(recognition): TMDB resolve + deterministic disambiguation + park-on-uncertainty`。
- **不做**(YAGNI):模型辅助消歧、TVDB/AniDB、零信号救援(park)。

### Task C4：识别层整合 + 真站验证
**Files**:Create `src/recognition/index.ts`(`recognize(videoPath): Promise<Recognized | Park>` 串 identifyFromPath→resolveToTmdb)、`.test.ts`。
- [ ] 单测串起整条链;`npx tsc/vitest` 绿;提交 `feat(recognition): recognize() end-to-end (path→tmdbId)`。
- [ ] **真站验证**(路由,detached+取证,你判 PASS):部署 HEAD → 喂真实 NAS 库树(可用 `_scout_realign_test` 那类或真 anime 目录)→ 断言 recognize() 出的 tmdbId/季/集正确。

---

## 子系统 B：自研周期巡检 + 自动触发。**必须等 C4 绿**

**关键情报**:daemon 唯一自动触发是旧 `aggregate`(v2/aggregator.ts,每 15min 造 series_season/movie job)。v3 orchestrator 现只手动/dashboard 触发(`cmdReconcileAll`,cli/index.ts:309)。`cmdWatch`(cli/index.ts:338)有定时器基建可复用。`scanLibrary`(scanner.ts:176)是既有库扫描。

### Task B1：周期扫描 + 差异检测
**Files**:Create `src/daemon/selfScan.ts`(复用 cmdWatch 定时器)、`.test.ts`;Modify libraryRepo(已知路径集合查询,若无则加)。
- [ ] Step1 写失败测试:新路径→触发 `recognize()`;已知路径→不重识别;上次 PARK 路径→重试。
- [ ] Step2 红。Step3 实现:定时(默认 15min,`SCAN_INTERVAL_MS` 可配)遍历 `MEDIA_ROOTS`→对比状态机已知路径→仅新增/上次PARK 跑 `recognize()`。Step4 绿+tsc。Step5 提交 `feat(scan): self-hosted periodic filesystem scan + diff`。

### Task B2：识别→入活文档→触发 orchestrator
**Files**:Modify selfScan.ts、cli/index.ts 接线;Test 对应。
- [ ] Step1 写失败测试:有变化→触发一次 orchestrator pass(不重复);无变化→不触发;新资源经正常 orchestrator 闸门(不特殊化)。
- [ ] Step2 红。Step3 `recognize()` 成功→写活文档(既有机制,下轮 `list_missing_coverage` 可见)→本轮有变化则触发一次 orchestrator pass(**不直接派 worker_task**,保"巡检只盘点、orchestrator 才判断派活"分层,护住 B 层零误触发闸门)。Step4 绿+tsc。Step5 提交 `feat(scan): recognized-new → living-doc → trigger one orchestrator pass`。

### Task B3：真站验证 + 解锁旧pipeline退役再评估
- [ ] 路由真巡检(detached+取证,你判):放新文件进隔离测试库→断言被扫→识别→入活文档→orchestrator 派活。
- [ ] **B 落地后**:旧 pipeline 自动触发缺口被填 → Phase2/3 大删除可重新评估(**另起任务,不在本计划**;需再判 daemon 触发行为真实验证 + "手动 vs daemon 触发"产品叉,拎给用户)。

---

## 自我审查(writing-plans 要求)
- **Spec 覆盖**:设计 A/C/B 三节 → A1–A5 / C1–C4 / B1–B3 全覆盖;provider 语言门控=A4、路径感知坑=C2、同语言跳过=A4、magic-enum 辐射=A2/A3。
- **占位符**:无 TBD/TODO;每 Task 有精确文件坐标 + TDD 断言点(完整逐行代码留给执行子代理按坐标读现有代码补——本文档给零歧义 WHAT/WHERE/tricky-HOW,capable 子代理读码补全,符合"handoff 给能读码的 Claude"而非"零上下文人类")。
- **类型一致**:`targetLanguage: string`(A1)贯穿 A2/A4/B;`recognize()→Recognized|Park`(C4)被 B1/B2 消费,名字一致;`langOf`/`tagsForLanguage`/`languageName` 三个小工具职责不重叠。
- **范围**:A/C/B 各自独立实现+测试+提交;B 依赖 C,subagent-driven 逐 Task 天然串行。Phase2/3 删除明确不在范围。

## 执行方式
**subagent-driven-development**:逐 Task 派 sonnet 子代理(非隔离、绝对路径进 subtitle-scout)、你两阶段复核 diff + 跑 tsc/vitest + 提交。A 与 C 可交错但串行提交;A5 与所有碰 realign/安全的复核由你(主控)亲手。B 等 C4 绿再启动。
