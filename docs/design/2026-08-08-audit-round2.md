# 第二轮对抗性审计 — PIPELINE-SPEC (R17-R24 / D1-D5 新增裁决)

状态：**审计完成**
审计员：架构审计员（第二轮，对抗性）
审计对象：`docs/design/2026-08-08-PIPELINE-SPEC.md`
基线：第一轮已修订版本（C11-C25 不重复报告）

---

## 角度 1：R24 的可实现性

### 🟡 A1-1 现成实现有两份且语言判定口径不一致，spec 未指定用哪一份
**证据**：
- 实现 A（judge 内联，`src/v2/daemonV2.ts:135-140`）：`readdirSync(dir)` + 正则 `/[.-](zh|chs|chi|zho)([.-]|$)/i`
- 实现 B（`src/files/sidecar.ts:64-81` `findExternalSidecar`）：`tag × ext` 双层构造 `<base>.<tag><ext>` 后 `fileExists`，tag 集来自 `src/agent/languages.ts:39` = `CHINESE_SIDECAR_TAGS`(7) + `CHINESE_BCP47_REGION_TAGS`(8) = **15 个 tag**

两者认得的 tag 集**不等价**：
- 实现 A 的正则**认不出** `cht`、`zh-Hant`、`zh-CN`、`zh-TW`、`zh-HK`、`zh-SG` 及全部小写地区变体（`languages.ts:30`）——`zh-CN` 里 `zh` 后面跟的是 `-C`，`([.-]|$)` 要求 `zh` 之后紧跟 `.`/`-`/结尾，`zh-CN` 实际能过（`zh` 后是 `-`），但 `cht` 完全过不了
- 实现 A **认 `.ssa`/`.vtt`**（`daemonV2.ts:140`），实现 B 的 `SUBTITLE_EXTS` 只有 `.srt/.ass/.ssa`（`sidecar.ts:12`），**不认 `.vtt`**
- 实现 A 认 `zho`/`chi`，实现 B 也认，但实现 A **漏 `cht`**

spec §4 第 1 步的 R24 用例只说"须覆盖常见 BCP-47 变体（.zh.srt / .zh-Hans.srt / .chs.ass 等）"，**没指定复用哪份实现**，也没说 `.vtt` 算不算、繁体 `.cht/.zh-Hant` 算不算 covered。

**失效场景**：用户装了 Bazarr 时代遗留的 `.cht.ass`（繁体），若实现选 A → 认不出 → 每天进字幕工作台白搜，7 天后停牌，用户看着盘上明明有字幕却显示"停牌"。反之若选 B → 用户的 `.zh-Hans.vtt` 认不出。

**建议修法**：spec 明确"R24 的存在性观察**必须**复用 `findExternalSidecar`（单一事实来源）"，并同步裁决 `.vtt` 与繁体是否计入 covered（建议：`SUBTITLE_EXTS` 加 `.vtt`；繁体计入，因为 `tagsForLanguage('zh')` 已含）。否则实现者会照 `daemonV2.ts:138` 抄那段内联正则（它就在扫描函数隔壁）。

### 🔴 A1-2 R24 的性能代价被 spec 完全忽略：每轮扫描新增 15×3=45 次 stat/文件
**证据**：
- `findExternalSidecar`（`sidecar.ts:72-79`）是 **tag(15) × ext(3) = 最多 45 次 `fileExists`**，未命中时全量跑完
- 现状扫描的快路径是 `daemonV2.ts:175-176`：指纹相同 → `continue`，**一次 DB 查 + 一次 statSync 就跳过**
- R24 要求"扫描每轮检查同名中文字幕是否存在"（spec:208、§2 阶段 1），即**未变化的文件也必须查**（否则 C19 手删字幕仍发现不了 —— 这正是 R24 的立项理由）

所以 R24 把每文件成本从 **1 次 stat** 抬到 **1 + 最多 45 次 stat**。CURRENT-STATE 量级下（几万文件），一轮扫描 syscall 数从 ~N 变成 ~46N。在 115 网盘/FUSE 挂载上（`daemonV2.ts:33` 注释确认存在只读 115 根），每次 stat 是网络往返，**45 倍放大是致命的**。

**失效场景**：3 万文件 × 45 次 FUSE stat ≈ 135 万次网络 stat，单轮扫描从分钟级变成小时级甚至跑不完；巡检整体被扫描阶段吃掉，字幕/识别永远排不上。

**建议修法**：spec 必须指定实现形态为 **每目录一次 `readdirSync` + 内存匹配**（即实现 A 的目录列举思路 + 实现 B 的 tag 表），成本 O(目录数) 而非 O(文件数 × 45)。`daemonV2.ts:137` 已经是 readdir 形态，但它在**每个文件**上重跑 readdir（judge 的 for 循环内），同目录 24 集 = 24 次 readdir，也需要按目录缓存。这条不写进 spec，实现者必然踩。

### 🟡 A1-3 语言判定不够严：`stem` 前缀匹配会把别集的字幕误判为本集
**证据**：`daemonV2.ts:136-139` 用 `e.startsWith(stem + '.')`。
`stem` 取 `basename(filename).replace(/\.[^.]+$/,'')`。若同目录存在 `Show.S01E01.mkv` 与 `Show.S01E01.1080p.mkv`（重复源，R22 明说不管硬链接但同目录重命名副本很常见），`Show.S01E01.zh.srt` 对前者是精确 sidecar，对后者不匹配；反之 `Show.S01E01.1080p.zh.srt` 会被 `startsWith('Show.S01E01.')` **误判成 `Show.S01E01.mkv` 的字幕** → 后者被错标 covered，永不补字幕。

`findExternalSidecar` 用精确构造 `<base>.<tag><ext>`（`sidecar.ts:74`）**没有这个问题**——又一条应统一到实现 B 语义的理由。

**建议修法**：R24 的匹配必须是**精确 stem + tag + ext**，不是 `startsWith(stem + '.')`。spec 第 1 步用例需加一条红线："同目录存在 `X.mkv` 与 `X.1080p.mkv`，仅有 `X.1080p.zh.srt` → 只有 `X.1080p.mkv` 是 covered，`X.mkv` 仍为 NULL"。

### 🟢 A1-4 spec 没说 covered 观察是否受 R8 挂载保护约束
**证据**：spec §2 阶段 1 把 R8 挂载保护只挂在"磁盘已消失 → DELETE"那一行。但 `covered → NULL` 的回退（spec:64「扫不到且原为 covered → 回退 NULL」）同样是**破坏性写**。
**失效场景**：115 断连导致 readdir 返回空/抛错 → 所有 covered 被回退成 NULL → 下一轮全库重进字幕工作台，几千文件白烧 LLM。这与 R8 要防的"一次断连删光全库"是**同一类灾难**，只是删的是状态不是行。
**建议修法**：spec 明确"covered 回退 NULL 同样受 R8 保护：该 root walk 失败或扫出 0 媒体文件时，跳过全部 covered 回退"。

---

## 角度 2：R24 引发的所有权冲突

### 🔴 A2-1 「worker 装盘成功 → 扫描确认」的窗口期长达一整轮巡检，期内同一文件被重复排队重跑 agent
**证据**：
- 现状 worker 成功时写两列：`subtitleScheduler.ts:173` `UPDATE files SET needs_subtitle = 0, sub_status = ?`
- 字幕工作台谓词（spec §2 阶段 3）= `needs_subtitle=1 AND sub_status IS NULL AND recheck_after 已过`
- R24 后 `sub_status='covered'` 只能由扫描写（spec:370）
- 扫描只在**巡检阶段 1** 跑一次（`daemonV2.ts:77`），字幕阶段 3 在其后（`daemonV2.ts:95-103`），**同一轮内扫描不会再跑**
- 字幕阶段 3 是 `while` 循环每圈重查队列（`daemonV2.ts:97`，即 C23 记的"无冻结"）

所以：worker 装盘成功后，若 R24 严格执行（worker 不写 covered），且 worker 也不写 `needs_subtitle=0`（因为 spec 只说 covered 唯一写入者是扫描，**没说 needs_subtitle 谁写**，见角度 3），则 `needs_subtitle=1 AND sub_status IS NULL` 仍成立 → `listSubtitleQueue` 下一圈**立刻重新选中同一 work** → **同一轮内无限重跑字幕 agent**。这是 `deadloop-fix-v2` 已经修过一次的死循环（`subtitleScheduler.ts:118-125` 注释）被 R24 原地复活。

**失效场景**：用户开着 daemon，某剧 12 集字幕全部找到并装盘成功 → 阶段 3 的 while 不退出 → 每圈重跑 12 集的 find-subtitle agent session，付费 LLM 热循环，直到进程被杀。

**建议修法**：spec 必须区分**两个正交事实**：
- `sub_status`（磁盘事实）→ 扫描独占，R24 成立
- 「本轮已处理过，别再排」→ 必须有独立机制。最小改动：worker 成功后写 `recheck_after = 明天`（不写 covered、不写 needs_subtitle）。这样本轮出队、明天扫描若确认落地则变 covered、若没落地则重进工作台——**R24 语义与防重排两者兼得**。
spec §4 第 1/2 步必须写明这条，否则实现者按字面照做必出死循环。

### 🟡 A2-2 窗口期内 sub_attempt 会白涨：B-2「无结局」兜底把已装盘文件也 bump
**证据**：`subtitleScheduler.ts:250-263` 的 B-2 兜底：不在任何桶的文件 → `bump(f,'no-outcome')`，bump 内 `attempt+1`（:143）。判断"在 covered 桶"依赖 `coveredPaths`（:255）——而 `coveredPaths` 的填充依赖 `report.installed` 的 itemId 反解（:180-195）。
R24 之后若把 `markCovered`（:173）删掉但保留 `coveredPaths` 计算，尚可；但若实现者理解成"R24 说 covered 不由 worker 管，那 installed 的处理整段删掉"，则 `coveredPaths` 为空 → 装盘成功的文件落入 B-2 → **sub_attempt 每轮 +1**。7 轮后装盘成功的文件被判 `handoff_translate`/`unsolvable`（spec §2 阶段 3）。
**失效场景**：字幕明明找到并装上了，7 天后系统把它标成"停牌"；下一轮扫描又把它标 covered——状态在 covered 与 unsolvable 间抖动，取决于扫描与字幕的相对时序。
**建议修法**：spec 明确"worker 报 installed 时**仍须**从 B-2 兜底中排除并写 `recheck_after=明天`、`sub_attempt` 不变"。这与 §5 翻译流映射表已有的口径（spec:409「installed → 清 tr_attempt；等扫描确认」）对齐——字幕流缺了这条对应表述。

### 🟡 A2-3 §5 翻译映射表的 installed 处置有同一个漏洞：只说清 tr_attempt，没说出队
**证据**：spec:409 `installed | 清 tr_attempt；等扫描确认后才变 covered`。翻译工作台谓词 = `sub_status='handoff_translate'`（spec:90）。清 tr_attempt 后 `sub_status` 仍是 `handoff_translate` → **翻译循环下一圈立刻重领同一行**。spec:415 自己警告过这个风险（"无退避列则独立循环下一圈立刻重领同一行 → 付费 LLM 热循环"），却在 installed 分支上重新犯了——因为它把 `tr_recheck_after` 只用在失败轨（:412-413），成功轨反而**清空**退避。
**失效场景**：翻译成功装盘 → 下一圈重领 → 再翻一遍（覆盖刚装的字幕）→ 无限翻译热循环，比字幕流更贵（翻译是逐行 LLM）。
**建议修法**：`installed`/`already-covered` 也必须写 `tr_recheck_after=明天`（"等扫描确认"这句话必须落地成一个退避写入，不是一句期望）。

---

## 角度 3：R24 与 needs_subtitle 的关系

### 🔴 A3-1 spec 只改了 sub_status 的所有权，`needs_subtitle` 的所有权与语义完全没定义 —— 这是最大的实现歧义
**证据**：
- spec §5 状态机表只列 `sub_status` 四态，**全文没有一处定义 `needs_subtitle` 的写入者**
- 现状有三个写入者：judge（`daemonV2.ts:129,146` 写 0/1）、字幕 worker 成功（`subtitleScheduler.ts:173` 写 0）、扫描指纹变化时应清空（spec:278 C11 要求清成 NULL）
- judge 的挑选谓词是 `f.needs_subtitle IS NULL`（`daemonV2.ts:125`），**且 judge 规则 3 就是 sidecar 检测**（`subtitleJudge.ts:39`，由 `daemonV2.ts:138` 的 sidecar 喂入）

R24 之后，**扫描和 judge 在做同一件事**（都检测同名中文字幕），但写不同列、语义不同：
- 扫描写 `sub_status='covered'`
- judge 写 `needs_subtitle=0 reason='sidecar'`

spec 没说 judge 规则 3 是否废除。若不废除 → 同一个磁盘事实被两个阶段分别投影成两列，**必然产生下述矛盾态**。

### 🔴 A3-2 矛盾态 1：`needs_subtitle=0`（judge 判 sidecar）+ 用户删字幕 → 扫描把 covered 回退 NULL，但文件永远进不了工作台
**证据**：
- 用户手放 `.zh.srt` → judge 规则 3 命中 → `needs_subtitle=0`（`daemonV2.ts:146` + `subtitleJudge.ts:39`）
- 同轮扫描也把 `sub_status='covered'`
- 用户后来删掉字幕 → 扫描回退 `sub_status=NULL`（spec:64）
- 字幕工作台谓词 = `needs_subtitle=1 AND sub_status IS NULL`（spec:78）→ `needs_subtitle=0` **不满足**
- judge 谓词 = `needs_subtitle IS NULL`（`daemonV2.ts:125`）→ `needs_subtitle=0` **也不满足**

→ **文件永久卡死**：既不重判、也不排队、sub_status 是 NULL 所以界面显示"缺字幕"却永不处理。**这正是 C19 要消解的 bug，R24 没消解它，只是把它从 sub_status 挪到了 needs_subtitle。**

**建议修法**（择一，必须在 spec 里定）：
- (a) **废除 judge 规则 3**（sidecar 检测），把"有无中文字幕"完全交给 R24 的 `sub_status`。judge 只保留规则 1（origin 国产）+ 规则 2（内嵌轨）——这两条是**文件内在属性**，与 sidecar 的"磁盘旁物"性质不同，正好干净分层。同时扫描的 covered 回退必须**同时**把 `needs_subtitle` 从 0 复位（若它是因 sidecar 被判 0）。
- (b) 或者：扫描回退 covered 时**同时**写 `needs_subtitle=NULL`（强制 judge 重判）。
建议 (a)——它让"文件内在属性"（needs_subtitle，指纹不变则不变）与"磁盘旁物事实"（sub_status，每轮重新观察）职责彻底分离，也自动消掉 A3-3。

### 🟡 A3-3 矛盾态 2：`needs_subtitle=0` + `sub_status='covered'`，指纹变化后两列清空时序不一致
**证据**：spec:278 要求指纹变化时清空 `needs_subtitle/sub_attempt/recheck_after/embedded_langs/duration_sec`——**清单里没有 `sub_status`**。而 spec:156（C11 修法）也明确列举了要清的列，同样漏了 `sub_status`。
但 C11 自己的失效场景描述（spec:155）恰恰就是"旧的 `sub_status='covered'` 残留 → 新文件明明无字幕，系统认为已覆盖"。
R24 之后这条**部分被消解**（扫描每轮重新观察 covered），但只在"扫描确实每轮观察每个文件"的前提下成立——而这个前提正是 A1-2 指出的性能悬崖。若实现者为了性能只对"指纹变化的文件"做 R24 观察（很自然的优化），则 C11 原样复活，且 spec 的清列清单**明文漏了 sub_status**。
**建议修法**：spec:156 与 spec:278 的清空列清单**补上 `sub_status`**，并明文写死"R24 的存在性观察必须对**每个** files 行执行，不得按指纹跳过（这是 R24 的立项前提）"，与 A1-2 的按目录 readdir 优化配套。

### 🟡 A3-4 judge 谓词 `needs_subtitle IS NULL` 在 R24 下仍成立，但 judge 里的 sidecar 检测成为纯浪费
**证据**：`daemonV2.ts:137` 在 judge 的 for 循环内对每个文件 `readdirSync(dir)`。若采纳 A3-2(a) 废除规则 3，这段 readdir 可整段删除，judge 退化成纯 SQL + 内存判断（`subtitleJudge.ts` 只剩规则 1/2，无 IO）。spec 未指出这个化简，实现时会保留两处重复的 sidecar 检测代码。
**建议修法**：spec 第 1 步验收清单加一条"judge 的 sidecar 分支（`daemonV2.ts:135-140` + `subtitleJudge.ts:39`）随 R24 一并删除，磁盘旁物只由扫描观察一次"。

---

## 角度 4：R23 停牌语义的边界

### 🔴 A4-1 `handoff_translate` 在翻译开关永不开启时是**永久停牌且无任何出口**，spec 自认这是"符合预期"但它同时冻结了字幕重搜
**证据**：
- spec:393-394 明文："翻译开关关闭时满 7 次的文件仍写 `handoff_translate`……只是翻译流不启动、它一直显示停牌"
- 字幕工作台谓词 = `sub_status IS NULL`（spec:78）→ `handoff_translate` 的行**永久出局字幕流**
- R10 明文"字幕流**忘记它、不再找**"（spec:29）

后果：默认不开翻译开关的用户（多数），任何一部 7 天没搜到字幕的片子从此**永久不再被搜索**。而 R5 的立项理由是"字幕源更新慢"——即**源会在未来出现**。7 天后源出现了，系统再也不看。

这与 R9"有可能找到就要尽力找到"直接冲突：第 8 天源上线了，系统的行为是"再也不找"。

**失效场景**：用户 2026-08 加入新番，字幕组延期 10 天发布 → 第 7 天被判 handoff_translate → 用户没开 AI 翻译 → 第 10 天字幕组发布了 → 系统永不再搜 → 用户永远看不到，界面只显示"停牌"。唯一出路是用户自己手动下字幕（此时 R24 才救得回来）。

**建议修法**：spec 必须裁决"停牌是否需要长周期复活"。建议：`handoff_translate` 与 `unsolvable` 都带一个**长周期复查**（如 30 天后 `sub_status` 回 NULL、`sub_attempt` 归零重新入字幕流）。这与 R5「明天再试」是同一原理，只是周期更长；jobsRepo 已有先例（`src/v2/jobsRepo.ts:383` 注释："之后周级(+7d)。永不热循环烧配额,**也永不判死刑(unavailable 衰减复查语义一致)**"）——**旧架构明确设计过"永不判死刑"，新 spec 把它丢了**。

### 🟡 A4-2 `unsolvable` 在 spec 内部被同时当作"终态"和"非终态"，两处描述互斥
**证据**：
- 非终态侧：spec:376/390-391 R24 说扫到字幕就变 covered；spec:430「不靠状态跳转解除，只靠扫描发现字幕自然解除」
- 终态侧：spec:84「**直接判死**，不给第 8 次」；spec:93「**彻底终止**，归入"无能为力"清单」；spec:412「满 3 次 → unsolvable」
- §5 状态机表的"出口"列（spec:378）对 unsolvable 只写"界面显示停牌；见下方解除规则"，**没写它是否还会被任何工作台排到**

关键歧义：`unsolvable` 的行**被扫描回退成 covered** 是清楚的（有字幕时）。但**没有字幕时**它是否永远不回 NULL？按 spec 字面是"永远不回"。那么 spec:93 的"无能为力清单"要靠什么谓词查？spec 全文**没有定义任何清单/统计的谓词**，而 §7:4 又说"停牌在界面上的具体呈现——前端重做时落地"，把这个决策推给了不在本轮范围的前端（R15 说"当前不管前端"）。
**失效场景**：实现者写统计时不知道 `unsolvable` 该不该计入"待处理"，两处代码各写各的口径；后端跑通验收时无法判断"停牌 12 集"是否正确。
**建议修法**：§5 补一行 `unsolvable` 的完整出口："唯一出口 = 扫描发现字幕 → covered。无其他出口"（或按 A4-1 加长周期复活）。并在 §5 明文给出"无能为力清单"的谓词 `sub_status IN ('handoff_translate','unsolvable')`——这正是 R23 定义的"停牌"，spec 已有此定义（:382）但没绑到清单上。

### 🟡 A4-3 `unsolvable` 的两个来源被合并成一态，但它们的可恢复性完全不同
**证据**：spec:378 的 `unsolvable` 含两类：
- (a) 满 7 次且 `translatable=0`（源语言不支持，如韩剧/法国片）
- (b) 翻译判无源（`no-source`/`no-embedded`，spec:411）或质量闸满 3 次（spec:412）

(a) 的不可解性来源是**MVP 只支持 en**（R20），是**软件能力问题**——一旦 jimaku 落地（C6，spec:429 说"属另一轮任务"），全部 origin=ja 的 unsolvable 都**应该**变回可救。但 spec 没有任何机制让它们回来：`sub_status='unsolvable'` 永久，`translatable` 列也是一次写死。
(b) 的不可解性是**这部片确实没源**，性质不同。

**失效场景**：jimaku 落地后上线，用户库里 300 部日漫全在 unsolvable，**没有任何东西会重新评估它们**，除非手工 SQL。第 6 步 e2e 也测不出来（测试库里日漫被排除，spec:355）。
**建议修法**：spec 补一条——`translatable=0 → unsolvable` 时须记录判据（如 `last_error='untranslatable:ja'`），并在 §4 第 7 步或"待后续"里明文列出"扩语言时必须跑一次 unsolvable 复评 pass"。或按 A4-1 的长周期复活自然覆盖。

### 🟢 A4-4 `handoff_translate` 与"翻译开关关闭"的组合下，`tr_attempt` 语义未定
**证据**：D3 加 `tr_attempt`/`tr_recheck_after`（spec:328）。开关关闭时翻译流不领活（spec:330），所以 `tr_attempt` 停在 0。开关打开后从 0 开始计 —— 这没问题。但 spec:330 "关闭时不领新活，在飞行中的跑完"与 C25 的建议一致，**只有 spec 一句话，没有 TDD 用例**（§4 第 4 步的红线用例只有 eng 兜底与 glossary key 两条）。
**建议修法**：第 4 步补用例"运行中关闭开关 → 翻译循环不再领新行，在飞行任务正常完成并写 tr_recheck_after"。

---

## 角度 5：R21 translatable 预判的正确性

### 🔴 A5-1 预判依据（`works.origin_lang`）与真实解析逻辑（`resolveSource.ts`）不同构，会**误判死**有日文内嵌轨的日漫
**证据**：
- R21 预判规则（spec:74）：`works.origin_lang 是否在可抓源集合内（MVP=仅 en）` → origin=ja ⇒ `translatable=0` ⇒ 满 7 次直接 `unsolvable`（spec:84）
- 真实逻辑 `resolveSource.ts:56-65`：`isJa(origin)` 时**第一条路就是找日文内嵌轨** `tracks.findIndex(t => !t.isImageBased && isJaTrack(t))`，命中则 `extract` → `{status:'ok', sourceLangName:'日文'}`。**这是纯本地抽轨，完全不需要 jimaku，也完全符合 R13 单跳与 R18（不用英轨）**
- `SUPPORTED_SOURCE_LANGS`（`fetchSourceSub.ts:96-97` 引用自 `translateWorkerTask.ts`）只管**外挂抓取腿**的语言门，不管内嵌抽轨腿

所以 R21 用"可**抓源**集合"（外挂腿的门）去预判整个翻译流的可救性，**漏掉了内嵌抽轨腿**。origin=ja 且带日文内嵌软字幕轨的片子（日区 BD 压制极常见）在 `resolveSource.ts` 下是**100% 可救**的，R21 会把它们判死。

**失效场景**：用户库里日漫 BD 版内嵌 `jpn` 字幕轨 → 识别得 origin_lang=ja → judge 写 `translatable=0` → 7 天后 `unsolvable`，永久停牌（A4-1/A4-3 无复活机制）。而系统本来只要 ffmpeg 抽一条轨就能译出中文。**这是 R21 引入的净新增回归**，第一轮没有这个 bug（旧流程会走到翻译流内部才判）。

**建议修法**（择一）：
- (a) `translatable` 预判须为 **`origin_lang ∈ SUPPORTED_SOURCE_LANGS` OR `embedded_langs 含 langOf(origin_lang)`**。C12 已经要求扫描阶段写 `embedded_langs`（spec:279），judge 时这个信息**已经在库里**，仍是 O(1)。
- (b) 或把 R21 的适用范围收窄为"origin_lang 既不在抓源集合、**且**无同语言内嵌轨"才判 0。
无论哪条，spec §2 阶段 2.5 ②（spec:74）与 §4 第 2 步（spec:291）的规则表述都必须改写。

### 🟡 A5-2 预判会误判**活**一批救不了的：origin='' / origin=en 但既无 en 轨又无 imdb
**证据**：
- `resolveSource.ts:84` `isEn(origin) || origin === ''` 分支，`:87` 对 `origin===''` 要求有 en 内嵌轨，否则 no-source
- R21 规则按字面"origin_lang 在可抓源集合内" → `origin_lang=''`（TMDB 未刮到）**不在** `['en']` 里 → `translatable=0` → 直接 unsolvable。但 `resolveSource.ts:84-98` 明确会救"origin='' 且有 en 内嵌轨"的片子 → **又是一个误判死**
- 反向：`origin_lang='en'` 但无 en 内嵌轨、且 works 缺 imdb（C5/C21：83 个已识别作品 provider_ids 永远 NULL）→ `translatable=1` → handoff_translate → 翻译流走 `fetchSourceSub`，文本 query 假阴性 → `no-source` → unsolvable。多绕一圈翻译流，尚可接受但**与 R21 的立项理由（"O(1) 可判的终局不该塞在 7 天延迟之后"）自相矛盾**——它并没真的把终局提前，只对部分情况有效。

**建议修法**：spec 明确 `translatable` 是**乐观预判**（只用来剪掉"确定救不了"的，不保证 =1 就能救成），并把判 0 的条件写成**保守的白名单补集**：`translatable=0` 仅当 `langOf(origin_lang) ∉ SUPPORTED_SOURCE_LANGS` **且** `embedded_langs` 不含 `langOf(origin_lang)` **且** `embedded_langs` 不含 `en`（覆盖 origin='' 情形）。任何不确定一律判 1，让翻译流去做权威判定。

### 🟡 A5-3 `translatable` 的重算触发者未定义 —— 与 C21 同型的"写一次就没人再写"缺陷
**证据**：judge 谓词是 `needs_subtitle IS NULL`（`daemonV2.ts:125`），判完写 `needs_subtitle=0/1` → **该行永不再进 judge**。R21 说 translatable 在 judge 阶段写（spec:75），所以它也**只写一次**。
但 `translatable` 的依赖项会变：
- `embedded_langs` 由 C12 的 probe 写入（spec:279），probe 可能失败（`streamProbe` 契约是 `null=unavailable`，`resolveSource.ts:52-54`）→ 首次 judge 时 `embedded_langs=NULL` → 按 A5-1 的修法会判 `translatable=0` → 后续 probe 成功也不会重判
- `SUPPORTED_SOURCE_LANGS` 会随 jimaku 落地而扩（C6）
**建议修法**：spec 明确 translatable 的重算时机：至少"probe 从失败变成功时"与"扩语言时"须重判。最简：让 judge 谓词改为 `needs_subtitle IS NULL OR translatable IS NULL`，且 probe 失败时写 `translatable=NULL`（而非 0），保持"未判"语义。

### 🟢 A5-4 spec 的 `translatable` 值域注释与 A5-3 冲突
**证据**：spec:291 `translatable INTEGER（NULL=未判 / 0=源语言不支持 / 1=可救）`。既然 NULL 是"未判"，而 judge 是唯一写入者且只跑一次，那 NULL 在稳定态下不可能出现——除非按 A5-3 允许 probe 失败留 NULL。三者需对齐。

---

## 角度 8：D1/D2 删除语义的落地细节

### 🔴 A8-1 D2「root 移除 → 其下 files 行立即删除」**已有一个现成实现，但它完全不动 files 表**，spec 未指出必须改它
**证据**：`src/v2/settingsRepo.ts:159-215` `removeRoot(path)` 是唯一的 root 移除入口（`:203` `DELETE FROM media_roots WHERE path = ?`）。它的级联清理覆盖：`subtitles`、`item_files`、`pending_removals`、`episodes`、`movies`、`series`、`tmdb_seasons`、`parked_paths` —— **全是旧表，一行 `files`/`works` 都没删**。
spec §4 第 1 步只把 D2 写成一条 TDD 用例（spec:277）"root 从 media_roots 移除 → 其下 files 行立即删除（D2，独立于扫描）"，**没有指名 `settingsRepo.removeRoot` 是那个必须改的函数**。
**失效场景**：实现者在扫描侧写了个"孤儿行清理"（因为 spec 把 D2 放在"第 1 步：扫描删除清理"章节里），而 dashboard 走 `removeRoot` → files 行仍在 → C18 的幽灵识别队列原样存在（`identifyScheduler.ts:29-40` 无 roots 过滤）。spec 第 1 步的验收用例若用直接 SQL 造场景（`DELETE FROM media_roots`）而不是调 `removeRoot`，**测试会绿但生产会漏**。
**建议修法**：spec 明确"D2 的实现点 = `settingsRepo.removeRoot` 的事务内补 `DELETE FROM files WHERE substr(path,1,length(?))=?`（沿用它已有的 substr 前缀手法，`settingsRepo.ts:150-157` 注释解释了为何不用 LIKE），并清理因此变空壳的 works 行"。TDD 用例必须**经 `removeRoot` 调用**，不得直接 SQL 造。

### 🟡 A8-2 `removeRoot` 的前缀是 `root + '/'`，会漏删 root 自身路径下的边界行；与 D1 的作用域界定不一致
**证据**：`settingsRepo.ts:161` `const prefix = path.endsWith('/') ? path : `${path}/``，随后所有删除都用 `substr(path,1,length(prefix)) = prefix`。
而字幕队列的 roots 过滤（`subtitleScheduler.ts:43`）用的是 `r.path === root || r.path.startsWith(root + '/')` —— **多了 `=== root` 这一支**。两处"在某 root 之下"的判定口径不同。
D1 要求"取库中该 root 下的行"（spec:268），spec **没有给出这个谓词的精确形式**。
**失效场景**：口径不一致本身在正常路径下无害（视频文件不会等于目录路径），但 D1 的"逐守备目录比对"需要用同一个谓词做**差集删除**——若删除侧用 `root+'/'` 前缀而 walk 侧用别的口径，边界行会漏删/误删。更实际的风险是：实现者各写一份谓词，三处（`identifyScheduler` 新加的过滤、`subtitleScheduler:43`、D1 的差集、D2 的级联）**四份不同实现**。
**建议修法**：spec 明确给出唯一谓词并要求抽成共享函数：`isUnderRoot(path, root) := path.startsWith(root.replace(/\/$/,'') + '/')`，四处全部复用。

### 🔴 A8-3 嵌套 root（`/media` 与 `/media/tv` 同为 root）下 D1 的差集删除会**误删**
**证据**：
- `media_roots` 是 `path TEXT PRIMARY KEY`（`db.ts:194`，见 `db.test.ts:439`），**无任何嵌套禁止约束**
- `addRoot`（`settingsRepo.ts:115`）是裸 `INSERT OR IGNORE`，**不检查新 root 是否是已有 root 的子/父目录**
- `walkVideoFiles(root)`（`daemonV2.ts:168`）逐 root 独立 walk，`/media` 的 walk **会包含 `/media/tv` 下的全部文件**
- `toMediaFileRow(f, st, this.deps.roots)`（`daemonV2.ts:177`）拿全部 roots 算 `work_dir` —— 嵌套时它算出哪个 root 为基准，spec 未定义

D1 的算法是"对每个成功 walk 的 root，取『库中该 root 下的行』vs『本次扫到的路径集』差集删除"（spec:268）。嵌套时：
- 处理 root=`/media/tv` 时，"本次扫到的路径集"只含 `/media/tv/**`，"库中该 root 下的行"也只含 `/media/tv/**` → 差集正确
- 处理 root=`/media` 时，若 `/media/tv` 这次 walk **失败**（115 断连，R8 保护对 `/media/tv` 生效跳过删除），但 `/media` 的 walk 成功（本地部分）→ `/media` 的"扫到路径集"**不含** `/media/tv/**`（walk 到那里会抛/返空），而"库中 `/media` 下的行"**包含** `/media/tv/**` → **差集把 `/media/tv` 全部行删光**

**这正是 R8 要防的灾难，而 D1 的"逐守备目录"设计在嵌套下失效**——因为 root 之间不是互斥分区，D1 的立项前提（"逐根隔离"，spec:276）不成立。

**失效场景**：用户 dashboard 里同时加了 `/media`（本地）和 `/media/115`（网盘挂载）→ 115 断连 → `/media` 的 walk 成功（跳过不可读子目录，`walkVideoFiles` 通常吞 EACCES）→ `/media` 的差集删光整个 115 库的行 → 恢复后全库重识别，几千次 TMDB+LLM。**用户"一次断连删光全库"的原始恐惧原样实现。**

**建议修法**（择一，spec 必须选）：
- (a) **禁止嵌套 root**：`addRoot` 加守卫，新 root 与任何现有 root 互为前缀则拒绝（并给出错误文案）。这是最干净的，且让 D1 的"逐根隔离"前提真正成立。
- (b) D1 的"库中该 root 下的行"改为**最长前缀归属**（每行只归属于覆盖它的最深 root），并要求"该行归属的 root walk 成功"才参与差集。复杂度高、易错。
建议 (a)，并在 §4 第 1 步加 TDD 用例"添加嵌套 root 被拒绝"+"存量已有嵌套 root 时 D1 跳过删除并告警"。

### 🟡 A8-4 D1 的 R8 安全阀判据"扫出 0 个媒体文件"在**合法空 root** 上会永久卡住
**证据**：spec:274「守备目录不可访问 / **扫出 0 个媒体文件** → 跳过删除，不清库」。
`walkVideoFiles` + `isScannable`（`daemonV2.ts:173`）会过滤掉小于阈值的文件。若用户有一个 root 里的内容被**合法地全部删除**（清空了整个电影库），扫描扫出 0 → R8 保护触发 → 库里的行**永远不删** → 识别/字幕流永远为幽灵文件跑（C18 的场景，只是这次 root 还在所以 roots 过滤救不了）。
**失效场景**：用户清空 `/media/movies` 打算重新整理 → 库里 500 部电影的行永久残留 → 每天巡检字幕流为 500 个不存在的文件跑（C23 的 stat 剔除能救字幕流不白涨计数，但识别流按 C18 修法只有 roots 过滤、root 还在所以照跑）。
**建议修法**：spec 区分"walk 失败/目录不可访问"（真断连 → 跳过删除）与"walk 成功但结果为空"（可能是合法清空）。建议后者不无条件跳过，而是**要求人工确认或加阈值**（如"扫出 0 但库里有 >N 行 → 跳过并告警，需用户在 dashboard 确认一次"）。当前 spec 把两者合并成一个"或"，是把安全阀焊死。

### 🟡 A8-5 D2 说"独立于扫描"，但没指定它相对于巡检的**时序**，且 `removeRoot` 与巡检可能并发
**证据**：`removeRoot` 用 `tx.immediate()`（`settingsRepo.ts:215`）。dashboard 是 HTTP server（`src/dashboard/server.ts`），与 daemon 在**同一进程**（`cli/index.ts` 的 `cmdWatch` 同时起 server 与 daemon —— 需在第 3 步确认）。better-sqlite3 是同步 API，单线程下不会真并发；但**巡检的字幕阶段是 `await`（`daemonV2.ts:102`）**，await 期间事件循环会处理 HTTP 请求 → `removeRoot` 可以在**巡检中途**删掉 files 行。
此时字幕阶段 3 的 while 已经取过队列（或 C23 的冻结快照已冻结），会继续为已删行跑 agent；回写 `bump` 的 `UPDATE ... WHERE path=?` 会 0 changes 静默无效。
**失效场景**：用户在巡检进行中移除一个 root → 该 root 下的片子仍被跑完一整轮字幕 agent（钱已花），且退避回写全部丢失。
**建议修法**：spec 明确 D2 与冻结快照的关系——最小方案是"消费快照前的逐文件 stat（C23）**同时**校验该行仍在库中（`SELECT 1 FROM files WHERE path=?`），任一不满足则剔除"。C23 只写了 stat，漏了库存在性。

---
## 角度 6：R17 废止 unavailable 的连带影响

### 🔴 A6-1 废止 unavailable 会**斩断旧翻译流的唯一取活谓词**，而第 4 步之前它是翻译的仅有通路
**证据**：`src/v2/translateWorkerTask.ts:66-70` `listTranslateCandidates` 的 SQL：
```
FROM episodes e JOIN series s ON e.series_id = s.id
WHERE e.sub_status = 'unavailable'
UNION ALL ...
```
即**旧翻译流的候选谓词就是 `sub_status='unavailable'`**。它读的是 `episodes`/`movies` 旧表（C4 已记），但这解释了 R17 的一个未被 spec 提及的连带效应：
- 新表侧废止 unavailable → 新架构下**没有任何东西**会写 `episodes.sub_status='unavailable'` → 旧翻译流候选**永久为空**
- spec §4 的执行顺序是：第 2 步废止 unavailable（spec:292）→ 第 3 步切容器（spec:308）→ **第 4 步才把翻译接到新架构**（spec:320）

所以在第 2/3 步完成、第 4 步未完成的**窗口期内**，翻译能力是 0（新表不写 unavailable，旧表也没人写）。spec:141（C9）已经知道"翻译当前仍挂在旧 daemon 上 → 须先完成 C3 才能删 daemon.ts"，但**没意识到 R17 会在第 2 步就让旧翻译饿死**，比删文件更早。
**失效场景**：第 2/3 步上线后用户报"AI 翻译一个都没跑"，排查者会去查开关/凭证，而真因是候选谓词的写入者被 R17 删了。
**建议修法**：spec §4 明确"第 2 步废止 unavailable 起，旧翻译流进入饿死状态，这是预期的；第 4 步之前不得对外宣称翻译可用"。或把 R17 的落地推迟到与第 4 步同一批。

### 🟡 A6-2 dashboard 的 coverage 桶把 `unavailable` 当一等公民，废止后该桶恒为 0 但不报错（静默失效）
**证据**：
- `src/dashboard/apiV2.ts:27` `CoverageDTO.unavailable: number`
- `apiV2.ts:86` `emptyCoverage()` 含 `unavailable: 0`
- `apiV2.ts:93` `addToCoverage`：`else if (status === 'unavailable') cov.unavailable += n`
- 前端类型 `web/src/api/types.ts:2` `SubStatus = 'missing' | 'covered' | 'embedded' | 'unavailable' | 'ignored' | 'hardsub-assumed'`，`:8` 也有 `unavailable: number`

R17 之后 `addToCoverage` 的 `unavailable` 分支永不命中 → 桶恒 0。**不会报错、不会红灯**，只是界面上"确认无字幕"永远显示 0。R15 说前端全删重做所以影响有限，但 `apiV2.ts` 是**后端**代码，且它读的是旧表——第 7 步"旧表迁移或废弃"时才会碰到。
**更重要的是：新的四态里 `handoff_translate` 和 `unsolvable` 在 `addToCoverage` 里没有任何分支** → 落入 else 被静默丢弃 → 停牌的集数在 coverage 统计里**凭空消失**（既不算 covered 也不算 missing），总数不守恒。
**失效场景**：后端跑通后用现有 dashboard API 做验收，看到"covered 10 / missing 0 / unavailable 0"却有 12 集，以为数据丢了。
**建议修法**：spec §4 第 2 步的验收清单加一条"`CoverageDTO` 与 `addToCoverage` 同步：删 `unavailable` 桶，加 `stalled`（= handoff_translate + unsolvable），保证桶总和 = 文件总数"。这条不写，R15"不管前端"会被误读成"连后端的 DTO 也不用管"。

### 🟡 A6-3 `db.ts` 的 CHECK 约束值域含 unavailable 但**不含新的两态**，新表 sub_status 无约束 → 拼写错误无法被数据库拦住
**证据**：
- 旧表有 CHECK：`db.ts:37`/`:52`/`:231`/`:246` 均是 `IN ('missing','covered','embedded','unavailable','ignored','needs_review'[,'hardsub-assumed'])`
- 新 `files` 表 `sub_status TEXT`（`db.ts:513`）**无 CHECK 约束**，注释还写着 `NULL=未处理；'missing'/'covered'/'embedded'/'unavailable'` —— 与 spec §5 的四态（NULL/covered/handoff_translate/unsolvable）**完全不一致**，且注释里的 `missing`/`embedded` 两个值在新四态里根本不存在
- spec:367 说"任何写入其他值视为 bug"，但**没有任何机制保证**

**失效场景**：实现者手误写 `'handoff-translate'`（连字符 vs 下划线）→ DB 照收 → 翻译工作台谓词 `='handoff_translate'` 查不到 → 文件永久消失于所有工作台，且**没有任何报错**。这是 C15 幽灵态的同型 bug，R17 只删了一个已知的幽灵值，没有关上产生新幽灵的门。
**建议修法**：spec §4 第 2 步必须包含"给 `files.sub_status` 加 CHECK 约束 `sub_status IS NULL OR sub_status IN ('covered','handoff_translate','unsolvable')`，并同步修 `db.ts:513` 的注释"。注意这在 SQLite 里需要 12 步建新表流程（`db.ts:596` 已有该机制说明），是**非平凡工作量**，spec 完全没估到。

### 🟡 A6-4 现有测试对 unavailable 的断言分布：至少 26 处，其中 2 处会**直接变红**
**证据**（`rg -c unavailable`）：
- `src/v2/subtitleScheduler.test.ts` 4 处 —— **其中 2 条会红**：`:52` `it('no_safe_match + 有 search_source 证据 → unavailable + recheck_after 6h')` 与 `:61` `expect(row.sub_status).toBe('unavailable')`。这两条**必须按 R17 重写**（改断言 `sub_status` 为 null 且 `sub_attempt` +1）
- `src/dashboard/apiV2.test.ts` 6 处 —— 读旧表，R17 只改新表，**不会红**（但按 A6-2 改 DTO 就会红，需一并改）
- `src/v2/ingest.test.ts` 16 处 —— 全是旧 ingest 的 unavailable 复查/领养语义，读旧表，**不会红**（第 7 步废旧表时才会）
- `src/v2/translateWorkerTask.test.ts:53` 依赖 `sub_status='unavailable'` 做候选 —— 读旧表，不会红，但按 A6-1 是**已死语义的绿灯测试**（假测试）

spec §6 说"任何改动不得新增红灯"（spec:423），基线 7 红。**R17 会让 `subtitleScheduler.test.ts` 的 2 条变红**，这是预期的（TDD 先红后绿），但 spec 第 2 步的用例清单（spec:301-306）**没列出"须改写既有的 unavailable 断言"**，实现者可能为了保绿而保留 unavailable 写入。
**建议修法**：spec 第 2 步显式列出"须删除/改写 `subtitleScheduler.test.ts:52-73` 的两条 unavailable 用例"，并说明这不算"新增红灯"（是同一条契约的语义变更）。

### 🟢 A6-5 `jobsRepo.ts:383` 的注释把 unavailable 当活语义引用
**证据**：`src/v2/jobsRepo.ts:383` "永不热循环烧配额,也永不判死刑(unavailable 衰减复查语义一致)"。R17 之后这句注释指向一个不存在的态，且它记录的"永不判死刑"原则**被 spec 的 unsolvable 违反**（见 A4-1）。属注释债务 + 原则冲突双重问题。

---

## 角度 7：R19 主进程内独立循环的具体形态

### 🔴 A7-1 「并行推进、互不阻塞」在 spec 里只有一句话，没有任何形态约束 —— 这是最容易各写各的一条
**证据**：
- spec:329 全部内容："按 R19 实现**主进程内独立循环**：与识别/字幕并行推进，互不阻塞"
- 现状 `daemonV2.run` 是纯顺序 `await`：`scanOnce()` → identify while → `judgeOnce()` → subtitle while（`daemonV2.ts:75-104`），单个 `while (!this.stopping)` 主循环

"主进程内独立循环 + 并行不阻塞"在单线程 Node 里只有三种可能形态，行为差异巨大：
1. **不 await 的浮动 Promise**：`void runTranslateLoop()` 与 `daemon.run()` 同时在事件循环里跑，靠各自的 `await`（LLM 网络 IO）交错。真"并行"，但**没有任何背压/并发上限**
2. **主循环内穿插一步**：每处理完一个字幕 work 就调一次 `translateOneStep()`。实际是**协作式串行**，会被字幕阶段阻塞（违背 R11 字面）
3. **独立 setInterval / 自递归 setTimeout 循环**：与巡检时间闸解耦，形态最接近"独立循环"

spec 没选，也没给判据。第一轮审计的 C14 只说"两个工作台谓词互斥"（spec:171），那是**数据层**的互斥，不解决**调度形态**。
**失效场景**：实现者选 (2) → 用户开翻译后发现翻译要等整轮字幕跑完（大库 10h）才动 → R11 目标未达成，但测试全绿（因为没有测试规定形态）。
**建议修法**：spec 必须指定形态。建议 (3) + 显式并发 1：`translateLoop` 用自递归 `setTimeout`，每次领 1 行、跑完、写 `tr_recheck_after`、再排下一次；`stopping` 时退出。并写明"翻译循环不受巡检时间闸约束，但受 `tr_recheck_after` 约束"。

### 🔴 A7-2 共享同一个 better-sqlite3 连接 + 同步 API：两个循环的写不会交错，但**读-改-写序列会被撕开**，产生丢失更新
**证据**：
- `openDb`（`db.ts:571`）返回单个 `new Database(path)`；`watchV2.ts:17` 全进程一个 `db` 实例传给所有依赖
- better-sqlite3 是**同步**的：单条 `stmt.run()` 不会被中断（Node 单线程，无 await 点）
- 但**多条语句组成的逻辑事务**会被撕开。实例：`subtitleScheduler.ts:141-147` 的 `bump()` 是**先 SELECT 再 UPDATE**：
  ```
  const row = db.prepare('SELECT attempt FROM files WHERE path = ?').get(f.path)
  const attempt = (row?.attempt ?? 0) + 1
  db.prepare('UPDATE files SET attempt = ?, ...').run(attempt, ...)
  ```
  两条之间没有 await，所以**这一处**安全。但 `identifyScheduler.ts:163-168` 与 `:183-187`、`:196-200` 同样是 `SELECT MAX(attempt)` 然后 `UPDATE`，也无 await —— 现状全部安全，纯属运气（都恰好写成了紧邻两行）。
- **真正的撕裂点在跨 await 的读-改-写**：翻译流必然是"领一行（SELECT）→ `await` 跑 LLM（数秒到数分钟）→ 写结果（UPDATE）"。这个 await 期间字幕流/扫描完全可以修改同一行。

**失效场景**：翻译流领走 `sub_status='handoff_translate'` 的行 → await 跑翻译（3 分钟）→ 期间新一轮巡检的扫描发现用户手动放了字幕 → 写 `sub_status='covered'`（R24）→ 翻译跑完写 `sub_status`/`tr_attempt` → **把用户的 covered 覆盖掉**。R24 声称"扫描是 covered 唯一写入者"，但翻译流的 UPDATE 会**间接抹掉**它。

**建议修法**：spec 必须规定"翻译流的结果回写必须是**条件更新**（乐观并发）"：`UPDATE files SET ... WHERE path=? AND sub_status='handoff_translate'`，`changes===0` 视为"该行已被扫描重新裁决，本次结果丢弃"。同理字幕流的所有回写都要带 `AND sub_status IS NULL` 守卫（这也顺手修了 C25 的"识别回写波及整个 work_dir"同型问题）。**这一条 spec 完全没有，是 R24 + R19 组合引入的净新风险。**

### 🟡 A7-3 `busy_timeout`/`synchronous=FULL` 下的写放大未评估，且 dashboard **也在同一进程**争抢
**证据**：
- `db.pragma('synchronous = FULL')`（`db.ts:578`）—— 每次 commit 都 fsync
- `db.pragma('busy_timeout = 5000')`（`db.ts:574`）—— 但同一连接内 busy_timeout 不生效（不是多连接场景）
- `cli/index.ts:576` `startDashboard(...)` 与 daemon 在**同一进程**；`cli/index.ts:254` 注释明言"dashboard 那侧（server.ts）**自己也建一个实例**" —— 即**确实存在多连接**

所以 D5 要求的"在 cmdWatch 内部把 ScoutDaemon 换成 daemonV2"（spec:309）会让 daemonV2 与 dashboard 的第二个连接共存。加上 R19 的翻译循环，写者从 1 变 2（同进程两循环共享一连接）+ dashboard 1 连接。`synchronous=FULL` 下每 commit 一次 fsync，翻译流逐行写术语表（`translateWorker.tools.ts:663`）可能高频 commit。
**失效场景**：软路由的慢闪存上 fsync 数十 ms，翻译流高频 commit → 巡检的批量 upsert 被拖慢；dashboard 连接遇 SQLITE_BUSY，5s timeout 后 500。
**建议修法**：spec 第 4 步加一条"翻译流的多语句回写必须包在 `db.transaction()` 内（单次 commit），并明确 daemonV2 与 dashboard 的连接数与 WAL 交互已评估"。至少要写明这是已知风险，而非无声漏过。

### 🟡 A7-4 R19「非独立进程」与 D5「4 个运维器官」的交互未定：`gcStaging` 会在翻译在飞行时清掉它的工作台
**证据**：
- `gcStaging: () => gcOrphans(currentRoots(), new Set(), bootTimeMs)`（`cli/index.ts:649`），注释（`:645-647`）："R8-1：传进程启动时间——gcOrphans 的两条保留条件之一（新建未写 / 最近 10 分钟有写入），两者任一满足就不清，避免误删并发 CLI 正在用的工作台"
- 第二参 `new Set()` = "在用的 sandbox id 集合"为空 —— 旧架构靠 jobs 表能知道谁在跑，**新架构下 daemonV2 没有 jobs 表**，无法填这个集合
- 翻译单集可能跑 >10 分钟（逐行 LLM），若中途 10 分钟无写入 → 两条保留条件都不满足 → **工作台被 GC 掉**

**失效场景**：翻译一集 40 分钟的剧，中间有 >10 分钟纯 LLM 等待无落盘 → gcStaging 清掉 `.subtitle-translate` 工作台 → 翻译写回时 ENOENT → `write-failed` → tr_attempt+1 → 3 次后 unsolvable。**一部片子被自己的 GC 判死。**
**建议修法**：spec 第 3/4 步必须定义"在飞行 sandbox 集合"的新来源（daemonV2 内存里维护一个 `Set<string>` 传给 gcOrphans），或把保留窗口从 10 分钟拉长到超过单集翻译上限。D5 的验收清单（spec:313-318）只打勾"gcStaging 接上了"，**不检查它接对了**。

---
## 角度 9：spec 内部一致性

### 🔴 A9-1 §2 流水线图与 §5 状态机对 covered 的写入者**直接矛盾**
**证据**：
- §5:370 "唯一有权把它写成 `covered` 的是**扫描**"
- §2:80-81 阶段 3 字幕工作流："**找到 → sub_status='covered'**；找不到 → sub_status 保持 NULL……"

§2 阶段 3 那行是**字幕流写 covered**，正是 R24 要废止的行为。§2 阶段 1（:64）也写了扫描写 covered。**同一份 spec 里 covered 有两个写入者**，而 §5 声称只有一个。
翻译流那侧 §2:91-92 同样写着 `→ covered`（"抽轨 → 译 → 装 sidecar → **covered**"），而 §5:409 明确说 installed "**等扫描确认后才变 covered**"。
**失效场景**：实现者读 §2（那是"目标流水线"，看起来最权威的图）照做 → 保留 `subtitleScheduler.ts:173` 的 covered 写入 → R24 白改。审计时两边都能引 spec 自证。
**建议修法**：§2 阶段 3 改为"找到并装盘 → 清退避出队（`recheck_after=明天`），**covered 由下轮扫描确认**"；阶段 4 翻译流的 ①② 末尾同样改为"→ 装 sidecar，等扫描确认"。这是**必须修**的——它是 R23/R24 的核心语义，而 spec 最显眼的那张图与它相反。

### 🔴 A9-2 §4 第 2 步的验收清单**遗漏"删除 covered 写入"**这一整项工作
**证据**：spec:289-299 第 2 步的动作清单里有"删除 `unavailable` 写入"（:292），有 sub_attempt、快照、注释债务，**但没有一条说要删/改 `subtitleScheduler.ts:173` 的 `markCovered`**。第 1 步（:262-287）只说扫描要新增 covered 观察，也没说要从字幕流拿掉。
即 R24 的"所有权转移"在整个 §4 执行顺序里**只写了新增方，没写移除方**。
**建议修法**：第 2 步动作清单加"删除 `subtitleScheduler.ts:173` 的 `markCovered`（含 `needs_subtitle=0` 写入），改为写 `recheck_after=明天`（见 A2-1）"，并加 TDD 用例"worker 报 installed → `sub_status` 仍为 NULL 且 `recheck_after` 已推进"。

### 🔴 A9-3 §4 第 1 步的 R24 用例**没有覆盖 R24 最关键的语义**：worker 装盘后的窗口期
**证据**：spec:281-287 的 R24 专项用例共 6 条，全部是"用户手放/手删字幕"与"tag 变体"，**没有一条测"worker 报成功但扫描还没跑"**。而这正是 R24 引入的**新**行为（角度 2 的 A2-1/A2-2 死循环与计数白涨都在这个窗口里）。
同样缺失：
- "装盘声称成功但文件没落地"（spec:209 明确把它列为 R24 的立项收益之一，**但没有对应用例**）
- "停牌中的文件出现字幕 → covered"有用例（:285），但**没有反向用例**"covered 的文件字幕被删且它曾是 unsolvable → 回到哪个态？"（回 NULL 还是回 unsolvable？spec 没定义，见 A9-5）
**建议修法**：第 1 步用例补三条：(a) worker 报 installed 但磁盘无文件 → 扫描后 `sub_status` 仍 NULL 且文件重入工作台；(b) worker 报 installed 且磁盘有文件 → 扫描后 covered；(c) 曾 unsolvable → 手放字幕变 covered → 再手删字幕 → 明确回到 NULL（重新开始 7 次）而非回到 unsolvable。

### 🟡 A9-4 §2 阶段 3 的工作台谓词与 §4 第 2 步的退避列不自洽：`recheck_after` 一列两主
**证据**：
- §2:78 字幕工作台 = `needs_subtitle=1 且 sub_status IS NULL 且 **recheck_after** 已过`
- D3 的理由（spec:47）："与 C7 同理：一列多主必然语义污染"，因此翻译用独立列
- 但按 A2-1 的必要修法，字幕流"装盘成功、等扫描确认"也要写 `recheck_after` —— 此时 `recheck_after` 同时承载**两种语义**："这次没找到，明天再搜"与"这次找到了，明天验证"。两者的下一轮行为不同（前者要重搜、后者若扫到就出队），但列值无法区分。
现状代码里 `recheck_after` 已经是字幕失败退避的专用列（`db.ts:557-570` v31 注释）。
**建议修法**：这不是致命问题（因为下一轮扫描会先把 covered 写好，字幕工作台的 `sub_status IS NULL` 谓词天然把成功的挡在外面），但 spec 应写明这个依赖关系："`recheck_after` 兼作『等扫描确认』的出队手段是安全的，前提是**扫描阶段必须严格早于字幕阶段**（§4 执行顺序保证）"。若将来有人把扫描改成异步/并行（R19 的形态歧义使这不无可能），此保证就断了。

### 🟡 A9-5 §5 状态机的"出口"列不完整：三个态的出口都没写全，且缺一张真正的转移表
**证据**：spec:373-378 的表只有"值 / 含义 / 出口"三列，出口写的是散文（"字幕工作台排它"/"事实态"/"界面显示停牌"）。缺少的转移：
- `covered` → 字幕被删 → `NULL`（:376 有写）；但 `covered` → **文件被替换（指纹变化）** → ？（C11 修法列没有 sub_status，见 A3-3）
- `handoff_translate` → 翻译 `no-source` → `unsolvable`（在 §5:411 的另一张表里）
- `handoff_translate` → 用户手放字幕 → `covered`（:390-391 散文里有）
- `unsolvable` → covered 之后又被删 → ？（A9-3(c)）
- `NULL` → `handoff_translate`/`unsolvable`（满 7 次分流，在 §2 里）
即完整的转移规则**分散在 §1 裁决表、§2 流水线图、§5 两张表、§5 两段散文，共 5 处**。这是"实现时各写各的"的典型结构。
**建议修法**：§5 补一张显式的 `(from, event, to)` 转移表，把 5 处散落的规则收敛成唯一事实来源。约 10 行，是本 spec 性价比最高的补充。

### 🟡 A9-6 §2 识别工作台谓词漏了 C18 的 roots 过滤与 404 终态，与 §3补 的修法不一致
**证据**：
- §2:68 "工作台 = `work_id IS NULL` 且 `next_retry_at` 已过"
- 实际现状 `identifyScheduler.ts:35-37` 还有 `AND (last_error IS NULL OR last_error != 'tmdb-404')`（404 终态）
- C18 的修法（spec:201）要求补 roots 过滤

所以 §2 的谓词**既落后于现状、也落后于自己的修法**。§2 是"目标流水线"，实现者会拿它当验收标准。
**建议修法**：§2:68 补全为 `work_id IS NULL 且 next_retry_at 已过 且 last_error != 'tmdb-404' 且 path 在某个成功 walk 的守备目录下`。

### 🟡 A9-7 R20「MVP 只需英语源」与 C6/代码实况冲突：`SUPPORTED_SOURCE_LANGS` 实际是 `['en','ja']`
**证据**：
- spec:74 R21 的判据："`works.origin_lang` 是否在可抓源集合内（**MVP=仅 en**）"
- spec:128 C6："实际可抓源语言**仅 en**"
- 真实代码 `src/v2/translateWorkerTask.ts:49`：`export const SUPPORTED_SOURCE_LANGS = ['en', 'ja']` —— **含 ja**
- `fetchSourceSub.test.ts:53` 有绿灯用例锁死此行为：`it('origin ja ∈ SUPPORTED_SOURCE_LANGS(F2) → 过门,search languages=[ja]')`

spec 说"仅 en"是把 C6 的**结论**（jimaku 未落地所以日文实际抓不到）写成了**常量的值**，但常量本身是 `['en','ja']`。实现者若照 spec 写 `translatable = (origin_lang === 'en')`，会与 `SUPPORTED_SOURCE_LANGS` 产生两套真相；若照代码写 `SUPPORTED_SOURCE_LANGS.includes(...)`，则 ja 会被判 `translatable=1` → handoff_translate → 翻译流走 fetchSourceSub → 无 jimaku adapter → `no-source` → unsolvable，**多绕一圈但结果对**（且这一圈还救回了 A5-1 的日文内嵌轨场景）。
**建议修法**：spec 必须指名"`translatable` 的判据 = `isSupportedSourceLang()`（`translateWorkerTask.ts:51`）这个既有函数，值域随该常量演进"，并把"MVP=仅 en"改成"MVP 实际可抓源=en（ja 在门内但无 adapter，走到翻译流后判 no-source）"。这同时消解 A5-1 的一半（因为 ja 会被判可救）。

### 🟡 A9-8 §4 执行顺序倒置：第 1 步依赖 D2，而 D2 的实现点在第 4 步才会被碰到的代码里
**证据**：第 1 步标题（spec:262）含 D2，用例（:277）也含 D2。但 D2 的唯一实现点是 `settingsRepo.removeRoot`（A8-1），而 §4 里 `settingsRepo` 只在第 3 步（`cmdWatch` 接线）与第 4 步（翻译开关读 settings）间接出现。第 1 步的标题是"扫描删除清理"，实现者的注意力全在 `daemonV2.scanOnce`。
**建议修法**：把 D2 从第 1 步拆成独立子项并指名文件：`settingsRepo.ts:159 removeRoot` 事务内补 files/works 级联。

### 🟢 A9-9 §2 流水线图漏了 C12 的 probe 步骤，与第 1 步用例矛盾
**证据**：§2 阶段 1 只列三件事（upsert / R24 观察 / 删除）。但第 1 步用例（spec:279）要求"新增/指纹变化文件 → 写入 embedded_langs + duration_sec（C12，probe）"。probe 是 ffprobe **子进程**，是扫描阶段最贵的操作（远贵于 R24 的 stat），却在流水线图里完全不可见。
**建议修法**：§2 阶段 1 补一行 "├─ 新增/指纹变化 → ffprobe 写 embedded_langs + duration_sec（C12）"，并注明"仅对新增/变化文件，不对全量"（与 R24 的全量观察形成对比，避免实现者把两者写在同一个 if 里）。

### 🟢 A9-10 R22（不管硬链接）与 R24 的组合产生一个 spec 未承认的可见退化
**证据**：R22（spec:51）说硬链接不管。R24 让 covered 成为逐文件的磁盘观察。C25（spec:255）记录旧架构有 `item_files` + `subtitlePropagation.ts` 做副本传播。
组合结果：同一部片的硬链接副本 A、B 各自独立跑字幕流 → A 找到装盘 covered，B 找不到 → 7 天后 B 停牌。用户在界面上看到"同一集既 covered 又停牌"。R22 说这是"已知限制"，但 spec 没说明**这个限制在 R24 下会变得可见**（旧架构靠传播掩盖）。
**建议修法**：§7 待确认项补一句"R22 的已知限制在 R24 下表现为『同片副本状态不一致』，界面需要能表达（前端重做时一并考虑）"。

### 🟢 A9-11 §2 阶段 2.5 的执行位置与 R24 的观察时机之间缺一条依赖声明
**证据**：judge 依赖 `embedded_langs`（C12，扫描阶段写）与 `works.origin_lang`（识别阶段写），所以它必须在阶段 2 之后 —— §2 位置正确。但 R21 新增的 `translatable` 判定同时依赖 `origin_lang`（阶段 2）与（按 A5-1 修法）`embedded_langs`（阶段 1）。若某文件在阶段 1 probe 失败，judge 时 `embedded_langs` 为 NULL，`translatable` 会被误判（A5-3）。
**建议修法**：§2 阶段 2.5 加一句"probe 失败（embedded_langs IS NULL）时 `translatable` 留 NULL 不判，下轮重判"，并把 judge 谓词改成 `needs_subtitle IS NULL OR translatable IS NULL`。

---

## 总结论

### 能否进入实现阶段：**不能。**

R23/R24 的方向是对的（磁盘为真源、状态为投影，与 R6 同源，且干净地消解了 C19），但它作为**所有权重构**只写了"新写入者是谁"，没写"旧写入者怎么拆、拆掉之后靠什么防重排"。这留下的不是细节缺口，而是**照字面实现必然产生付费 LLM 热循环**的洞。R21 与 R19 同样是"一句话裁决 + 零形态约束"。

### 必须先补的（阻塞级，共 8 条）

| # | 缺口 | 对应发现 |
|---|---|---|
| 1 | **worker 成功后的出队机制**：删掉 covered 写入的同时必须写 `recheck_after=明天`，否则阶段 3 的 while 同轮无限重跑 agent | A2-1、A2-3、A9-2 |
| 2 | **`needs_subtitle` 的所有权与 judge 规则 3 的去留**：不定义就会出现 `needs_subtitle=0 + sub_status=NULL` 的永久卡死态（C19 换个列复活） | A3-1、A3-2、A3-4 |
| 3 | **§2 流水线图改写**：§2 阶段 3/4 现在明文写着字幕流与翻译流写 covered，与 §5 直接矛盾 | A9-1 |
| 4 | **R24 的实现形态与性能**：必须指定"每目录一次 readdir + 复用 `findExternalSidecar` 的 tag 表 + 精确 stem 匹配"，否则是每文件 45 次 stat（FUSE 上跑不完） | A1-1、A1-2、A1-3 |
| 5 | **R21 的判据修正**：现判据会把"origin=ja 且有日文内嵌轨"（BD 压制常见）误判死，且与 `SUPPORTED_SOURCE_LANGS=['en','ja']` 的实际值域不符 | A5-1、A5-2、A9-7 |
| 6 | **R19 的调度形态 + 乐观并发守卫**：翻译流跨 await 的回写必须带 `WHERE sub_status='handoff_translate'`，否则会抹掉扫描写的 covered | A7-1、A7-2 |
| 7 | **嵌套 root 的处置**：`addRoot` 无嵌套守卫，D1 的"逐根隔离"前提不成立，`/media` + `/media/115` 断连时会删光全库 —— R8 要防的灾难原样实现 | A8-3 |
| 8 | **D2 的实现点指名**：唯一 root 移除入口 `settingsRepo.removeRoot` 完全不动 files 表，spec 把 D2 放在"扫描"章节会让实现者改错地方、测试假绿 | A8-1、A9-8 |

### 强烈建议同批补（非阻塞但会造成静默退化）

- **停牌是否永久**（A4-1）：默认不开翻译的用户，7 天没搜到就永久不再搜，与 R9/R5 精神冲突；旧架构 `jobsRepo.ts:383` 明确设计过"永不判死刑"，新 spec 丢了。这是产品级决策，需用户拍板。
- **`files.sub_status` 的 CHECK 约束**（A6-3）：新表无约束、注释还写着已废止的四个值；拼写错误会造出新幽灵态且零报错。注意这需要 SQLite 12 步建表流程，工作量非平凡，spec 未估。
- **R17 的连带**：旧翻译候选谓词就是 `sub_status='unavailable'`（A6-1），第 2 步起旧翻译饿死；`CoverageDTO` 的桶总和会不守恒（A6-2）；2 条既有测试会红且 spec 未列（A6-4）。
- **§5 补一张 `(from, event, to)` 转移表**（A9-5）：当前转移规则散落 5 处，约 10 行即可收敛，是性价比最高的一处补充。
- **`gcStaging` 会 GC 掉在飞行的翻译工作台**（A7-4）：D5 只验收"接上了"，不验收"接对了"；`new Set()` 的在飞行集合在新架构下无来源。

### 判断依据

第一轮的 C11-C25 是"现有代码有洞"。本轮的 8 条阻塞项性质不同：**它们是修订本身引入的**，且集中在同一个模式——把一个所有权/形态决策写成一句裁决，而不写"拆掉旧路径后靠什么维持原有不变量"。R24 拆掉了 covered 的写入者却没补出队机制；R21 换了判据却没对齐真实解析逻辑；R19 换了并发形态却没补并发守卫；D1 换了删除作用域却没保证 root 互斥。

补齐上述 8 条后，spec 可进入实现。当前状态下进入实现，最可能的结局是第 1/2 步上线即出付费 LLM 热循环（A2-1），且 A8-3 在 115 断连时会一次删光全库。

---

状态：**审计完成**
