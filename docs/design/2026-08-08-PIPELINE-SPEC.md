# Subtitle Scout 后端流水线 Spec（权威）

**日期**: 2026-08-08
**状态**: 用户已拍板全部关键决策，本文档为唯一执行依据
**前置**: 本文档取代 archive/ 下所有旧架构文档；`CURRENT-STATE.md` 记录状态，本文档记录**该做什么**

---

## 零、一句话概括

机械扫描保证数据库=磁盘真实快照 → 识别 agent 认定"这是什么影视"→ 写库 → 字幕 agent 按作品补齐 →
找不到就明天再试，满 7 次移交翻译 → 翻译独立跑，抽内嵌轨或抓源语言字幕译成中文。

---

## 一、用户裁决清单（不可违背）

| # | 裁决 | 理由（用户原话精神） |
|---|---|---|
| R1 | 走 Jellyfin 式机械扫描入队 | 不惯猴子用户瞎搞，不符约定的静默跳过 |
| R2 | 识别 agent 只交付"权威认定"——这资源属于什么影视 | 识别与字幕不粘连 |
| R3 | 识别流跑完写库，再跑字幕流；跑道=识别留下的库记录 | 靠数据库+状态机接力，不靠进程内传参 |
| R4 | 每次开跑冻结跑道（快照） | 跑的过程中队列不漂移 |
| R5 | 找到→已覆盖；找不到→放着，明天再跑 | 字幕源更新慢，短退避无意义 |
| R6 | 数据库必须真实反映磁盘情况 | 用户删了资源就不该再跑——这是必须先机械扫的根本原因 |
| R7 | 磁盘上消失的文件→**直接删除记录** | 库严格等于磁盘快照，历史不留 |
| R8 | 挂载掉线保护：目录整体空/不可访问时**跳过删除**，不清库 | 防 115 断连一次删光全库 |
| R9 | 字幕 agent：找到就是找到，找不到就是找不到；**有可能找到就要尽力找到，不许撂挑子** | 既不许编造，也不许偷懒 |
| R10 | 字幕流满 **7 次真实尝试**未果 → 移交翻译流，字幕流**忘记它、不再找** | 给无限重试一个终点 |
| R11 | 翻译流**独立**，不与识别/字幕互相阻塞 | 虽在字幕之后，但不该被队列状态挡住 |
| R12 | 翻译前提：跑到时**资源文件仍存在** | 与 R6/R7 咬合 |
| R13 | 只做源语言→中文**单跳直译，永不中继** | JP→EN→CN 丢义严重（用户早前明令） |
| R14 | 不设 agent 步数上限 | 机械底线用反编造门/超时/catch-all 保证 |
| R15 | 前端全删重做，**后端跑通后再谈** | 当前不管前端 |
| R16 | 不再用 nas_media 做测试目录；**115 网盘改为可写**做端到端验证 | 生产媒体库不当试验场 |
| R17 | "认真搜了但确实没有"= **普通失败**：计数+1、明天再试、满7次移交翻译 | 与 R5「找不到就放着留给下次」一致；不设第五态 |
| R18 | **禁止英文兜底转译**（R13 胜出，废止 2026-07-24 的 eng fallback 裁决） | 日漫无日文源 → 直接 unsolvable，不许 JP→EN→CN |
| R19 | 翻译流 = **主进程内独立循环**（非独立进程） | 无跨进程竞态/租约/GC 复杂度，运维器官不用重建 |
| R20 | MVP 阶段：**外挂抓取仅支持 en**；**内嵌轨抽取 en/ja 皆可**（有日文内嵌轨的日漫在 MVP 范围内）。其余语言后续再说 | 先能跑，再扩语言；内嵌轨抽取是纯本地操作、无 provider 依赖，天然可用 |

### 本次审计新增的裁决（我按第一性原理定，用户可推翻）

| # | 裁决 | 第一性原理依据 |
|---|---|---|
| D1 | 删除作用域 = **逐守备目录比对**，不做全局补集 | 全局补集下"根本没扫到"与"扫到但为空"不可区分，R8 保护会失效 |
| D2 | root 从 media_roots 移除 → 其下 files 行**立即删除**（独立于扫描删除） | 不属于任何守备目录的行是定义上的孤儿，留着只会被识别流永远重跑 |
| D3 | 翻译失败用**独立列** `tr_attempt` / `tr_recheck_after`，不复用字幕列 | 与 C7 同理：一列多主必然语义污染 |
| D4 | 时间闸 = 距上次巡检**开始**满 24h；巡检抛错**不推进**时间闸 | 否则周期随耗时漂移，且一次故障吃掉 24h |
| D5 | 第 3 步必须带齐 4 个运维器官才算完成 | 切换入口不得静默丢失既有能力 |
| D6 | **worker 成功后必须写 `recheck_after`（出队凭据）**，不许只清状态 | R24 删掉 covered 写入后若无出队机制，循环下一圈重选同一活 → 付费 LLM 热循环 |
| D7 | **禁止嵌套守备目录**。检测逻辑**已存在**（`apiV2.ts:809-818` findOverlappingRoot，双向重叠）——须**下移到 settingsRepo** 并补上 `seedRootsFromEnv` 这条旁路，**不要重写第二份** | 嵌套下 D1 的逐根差集会把子根的库当成"消失文件"全删（R8 灾难的实现版） |
| D8 | `needs_subtitle` 与 `sub_status` **职责切分**：needs_subtitle 只表达"这资源原则上需要中文字幕"（语言/内嵌轨事实，装盘不改它）；sub_status 表达"磁盘上当前有没有" | 两列都判 sidecar 会造成 needs_subtitle=0 但 sub_status=NULL 的卡死态（C19 换列复活） |
| D9 | `translatable` 预判必须**同时考虑内嵌轨**，不能只看 origin_lang | 日漫自带日文内嵌轨时是纯本地抽取、完全合规，只看语言会把能救的判死 |
| D10 | 翻译回写必须带**乐观并发守卫** `WHERE sub_status='handoff_translate'` | 翻译等 LLM 的几分钟内扫描可能已写 covered，无守卫会被覆盖 |
| D11 | D2 的清理必须挂在 `settingsRepo.removeRoot` 内（已确认它只清旧表、**一行 files 不碰**） | 挂错位置会导致测试绿、生产漏 |
| D12 | 字幕存在性检测分两档（具体机制见 §5 补）：**新增/指纹变化文件全量检测**；未变化文件按 `sub_recheck_at` 到点轮转，**每轮只查到点的那批** | 15 标签×4 扩展=60 次 stat/文件，115 网盘挂载放大 46 倍 |
| D13 | **停牌复查是独立的阶段 2.6**，不塞给字幕流执行 | 字幕流谓词是 `sub_status IS NULL`，看不见停牌行——让它负责复查是鸡生蛋；且强行改状态会掀掉飞行中的翻译，D10 守卫匹配 0 行 → 退避不写 → 热循环从侧门回来 |
| D14 | **周频复查的对象取决于翻译开关**（用户裁决 a）：<br>· `unsolvable` — 恒参与<br>· `handoff_translate` — **翻译未启用时参与**；已启用时不参与（归翻译流管，有自己的 tr_recheck_after 节奏） | 翻译开着时复查会打断飞行中的翻译；翻译关着时若不复查，它就成了真正的永久终态，违背 R25 |
| D15 | 复查时 **sub_attempt 不归零**；回 NULL 后下一次失败立即判 `>= 7`（**不是 `== 7`**）→ 直接回停牌 | 归零会让永远找不到的文件变成 7 次/14 天（182 session/年）；不归零 = 1 次/周（52 次/年），才符合 R25 原意"每周找一次" |
| D16 | D12 的低频复核**范围必须含停牌态**（unsolvable + handoff_translate），不能只抽样 covered | 用户手放字幕不改视频指纹，若只覆盖 covered 则停牌态的手放字幕永不被发现 → R23"用户手放的也认"失效 |
| D17 | **embedded_langs 存量回填 pass 必须同时把 `needs_subtitle` 与 `translatable` 置 NULL**，否则 judge 谓词 `needs_subtitle IS NULL` 永不再看存量行 → 回填等于白跑 ffprobe | 第三次栽在同一模式（C12→C35→本条）：写了某列却没定谁来重读它 |
| D18 | `sub_recheck_at` 的 **NULL 语义写死**：迁移时对全库随机打散到未来 7 天内（`now + random()*7天`），**不留 NULL** | 照字面写谓词 `sub_recheck_at <= now` 则 NULL 行永不命中（静默失效）；补 `IS NULL OR` 则首轮全库雪崩（几万文件 ×60 次 stat） |
| D19 | 第 3 步迁移必须含 `UPDATE files SET sub_status=NULL WHERE sub_status='unavailable'` | 顺序调整后第 2 步先上线，存量 `unavailable` 行在新谓词下既不在字幕工作台、又攒不到 7 次 → 永久出局 |
| D20 | **D1 删除逻辑必须主动跳过被嵌套污染的根**（内外层都算），只做 upsert 不做差集删除；跳过要打日志 | 第 1a 步的 detectNestedRoots 只告警、不改用户配置；若用户不理，D1 上线仍会删库——不能依赖"用户看了告警去修"这个假设 |
| D21 | `'/'` 作为守备目录时，D1 的差集**必须排除更深守备目录名下的行** | `substr(path,1,1)='/'` 对所有绝对路径为真。第 1a 步已在 removeRoot 侧修（审校 F8），D1 是另一条代码路径，不会自动继承 |
| D22 | `sub_attempt` 建列时**必须 `INTEGER NOT NULL DEFAULT 0`**，不许可空 | 与 D18 同一个坑：`sub_attempt >= 7` 在 NULL 上是三值逻辑的 unknown → 谓词永不命中 → 停牌移交静默失效。且指纹变化清空时会因 NOT NULL 约束整轮抛错（1b-3 已用 PRAGMA 读 dflt_value 兜住，但建列侧仍须写对） |
| D23 | **字幕存在性观察必须与 R8/D20 的跳过共进退**：本轮被跳过删除的根，其下文件也不做字幕观察 | R8 保护的本意是"挂载掉线时目录看起来是空的，别当真"。但 1b-4 只把这个保护给了删除，没给观察——挂载掉线时 `fileExists` 对整个根返回 false → 该根下所有 `covered` 被回退成 NULL → 挂载恢复后全部重新找一遍字幕，而字幕其实一直在磁盘上。烧的是整轮 LLM |
| R21 | **翻译可救性在 judge 阶段预判**；源语言不受支持的片子满 7 次后**直接 unsolvable**，不进 handoff_translate、不给第 8 次机会 | origin_lang 识别时已入库，O(1) 可判的终局不该塞在 7 天延迟之后 |
| R22 | 只管守备目录内的情况；**硬链接/重复源不考虑**，不修，记为已知限制 | 守备目录是唯一地界，目录外的事不管 |
| R23 | **「停牌」= 磁盘上当前没有中文字幕这一事实**，不是流程状态。解除停牌的唯一凭据是**扫描发现同名字幕文件**——翻译流领走了/在跑/跑失败期间一律仍显示停牌 | 与 R6 同源：磁盘是真源，数据库是投影 |
| R24 | 由此 `covered` 也是**事实观察**（扫到同名字幕）而非流程结果（装盘成功后写标记） | 装盘成功但文件没落地、用户手动删字幕、用户手动放字幕，三种情况都能被正确反映 |
| R25 | **停牌 ≠ 系统放弃**。停牌期间字幕流**继续每周找一次**（非每天），直到真找到字幕为止；界面在字幕真出现前一直显示停牌 | 用户没开翻译不该被判死刑；字幕组几个月后补发是常事（承接 R5/R9，恢复旧架构"永不判死刑"设计） |
| R26 | 因此**没有真正的永久终态**：`unsolvable` 也只是"当前无能为力"的界面陈述，后台仍以周频重试 | 与 R23 同理：停牌是事实陈述，不是流程终点 |

---

## 二、目标流水线

```
每天一次巡检（距上次满 24h）：

阶段 1  机械扫描
        ├─ 新增/变更视频文件 → upsert files（指纹 mtime+size 跳过未变的）
        ├─ **字幕存在性观察**（R24 + D12 两档机制，详见 §5）：
        │    A 档 新增/指纹变化 → 全量检测；B 档 sub_recheck_at 到点 → 轮转复核
        │    扫到中字 → sub_status='covered'；扫不到且原为 covered → 回退 NULL
        └─ 磁盘已消失 → DELETE FROM files（R7），受挂载保护约束（R8）

阶段 2  识别工作流（上游）
        工作台 = work_id IS NULL 且 next_retry_at 已过
        有活就一直跑（逐作品目录），跑空才进下一步
        识别不出 → next_retry_at = 明天

阶段 2.5 judge
        ① 识别绑定后判 needs_subtitle（国产/内嵌中文 → 跳过）
           **不判 sidecar**（D8/C27，1b-5 已落地）：外挂字幕是磁盘事实，归 sub_status 管。
           两列都判同一个事实会造出永久卡死态——用户手删字幕后 sub_status 回退 NULL 了，
           但 needs_subtitle=0 留着，既不满足 judge 谓词 `IS NULL`、又不满足工作台谓词 `=1`。
        ② 判 translatable（R21）：works.origin_lang 是否在可抓源集合内（MVP=仅 en）
           → 写入独立事实列 translatable（0/1），不进 sub_status

阶段 2.6 停牌复查闸（独立阶段 / D13，**不由字幕流执行**）
        对象（D14，取决于翻译开关）：
          · sub_status='unsolvable' 且 recheck_after 已过        —— 恒参与
          · sub_status='handoff_translate' 且 recheck_after 已过 —— **仅当翻译未启用时**参与
        动作 = sub_status 改回 NULL；**sub_attempt 保持不动**（D15）
        效果 = 该文件重进阶段 3 字幕工作台；下次失败即判 >=7 → 立刻回停牌
        节奏 = 一年约 52 次尝试，符合 R25「每周找一次」
        翻译开关一开 → handoff_translate 不再被复查，自然被翻译流领走（无需状态迁移）

阶段 3  字幕工作流（下游）
        工作台 = needs_subtitle=1 且 sub_status IS NULL 且 recheck_after 已过
        开跑冻结快照（R4），消费前逐文件 stat（不存在则剔除且不计数）
        装盘成功  → **不写 covered**（R24：covered 只由扫描写）
                    只写 recheck_after=明天 出队（D6），等下次扫描确认
        找不到    → sub_attempt+1，recheck_after=明天
        满 7 次   → 看 translatable 预判（R21/D9）：
                     可救  → sub_status='handoff_translate'（界面：停牌，归翻译流）
                     不可救 → sub_status='unsolvable'（界面：停牌，周频复查）
                    recheck_after=+7天；由阶段 2.6 负责放回（D13/D14/D15）

阶段 4  巡检结束，歇到明天

────────────────────────────────────────────────
翻译工作流（主进程内独立循环，不阻塞主巡检 / R19）
        工作台 = sub_status='handoff_translate' 且 tr_recheck_after 已过 且文件仍存在（R12）
        ① 有同语言内嵌文本轨 → 抽轨 → 译 → 装 sidecar
        ② 无内嵌轨 → 抓源语言外挂字幕（OpenSubtitles，靠 imdb 命中）→ 译
        ③ 无源 / 源语言不在单跳集合 → sub_status='unsolvable'（界面：停牌）
        装盘成功 → **不写 covered**（R24），清 tr_attempt + 写 tr_recheck_after 出队（D6）
                   等下次扫描确认后才变 covered
        回写必须带守卫 WHERE sub_status='handoff_translate'（D10）
```

---

## 三、我核实出的真实缺口（与代码实况对齐）

以下每条都已在代码中确认，不是推测。

### C1 扫描完全不处理删除 🔴 地基
`src/v2/scanner.ts` 中 `DELETE`/`missing`/`exist` 零命中。当前只做新增入库。
后果：用户删了资源，files 表仍留记录，字幕流明天继续为幽灵文件跑一轮 → 违背 R6。

### C2 daemonV2 没接上容器 🔴 地基
`Dockerfile` CMD = `dist/cli/index.js watch` → `cmdWatch()` → **旧 Daemon（30s tick）**。
新架构目前只靠手动 `node v2/watchV2.js`，**容器一重启就退回旧架构**。

### C3 翻译流不在 daemonV2 中，且旧设计与 R11 相反 🔴
`daemonV2.ts` 里 `translate` 出现 **0 次**。
旧 `daemon.ts` 的设计是"translate 只在巡检世界全空时才领"——即翻译被巡检**阻塞**，与 R11 正相反。
故此项不是搬运，是按 R11 重做调度。

### C4 翻译的数据入口整体长在旧表上 🔴 致命
- `src/cli/fetchSourceSub.ts` 的 locate：`FROM episodes JOIN series` / `FROM movies WHERE path=?`
- `TranslateTask.itemId` 注释：`Own id (episodes.id / movies.id)`
- 新架构是 files/works → 按 path 查旧表**查无此行返回 null**，杀手锏腿**静默失效**
这解释了为何"AI 翻译链路在新架构下从未验证过"：它接不上。

### C5 works 表缺 imdb / provider_ids 列 🟡
`fetchSourceSub` 注释明言"兜底搜索必须带 imdb（文本 query 假阴性多，imdb 命中率高得多）"。
但 `works` 表只有 id/title/original_title/year/media_type/origin_lang/overview/poster_path/chinese_titles。
→ 翻译的外挂抓取腿在新架构下即便接通，也会因缺 imdb 而命中率骤降。

### C6 jimaku 未落地，日漫走不到抓取腿 🟡
`SUPPORTED_SOURCE_LANGS = ['en','ja']` 但注释写明 `日漫(origin ja)在 F2 jimaku 日文源落地前宁可 no-source`。
实际可抓源语言**仅 en**。日语/韩语/法语等一律 no-source。
注：这部分是 R13 单跳原则的自然结果，非 bug，但需让用户知道覆盖范围。

### C7 attempt 列被识别与字幕共用 🟡
`identifyScheduler` 写 attempt（识别成功时归零），`subtitleScheduler` 也读写 attempt 做退避阶梯。
R10 的"7 次"若复用此列，语义会被识别重试污染 → **需独立列 sub_attempt**。

### C8 字幕退避阶梯注释与实现不一致 🟢
`subtitleScheduler.ts:138` `backoffFor = () => 24h`（已按 R5 统一），
但上方注释仍写 `15min→1h→4h→24h`，且 144-145 行有大段解释旧阶梯的注释 → 误导后人。

### C9 死代码 🟢
`daemon.ts`（旧）、`dispatcher.ts`、`orchestratorAgent*`（5 文件，用户从未同意的 orchestrator）。
注意：翻译当前仍挂在旧 daemon 上 → **须先完成 C3 才能删 daemon.ts**。

### C10 旧表仍在 🟢
`db.ts` 中 episodes 21 / movies 18 / series 14 / subtitles 6 处引用。不挡当前流水线，但 C4 修完后应清理。

---

## 三补、自审 + 对抗审计新增缺口（C11–C24）

以下为主 agent 第一性原理自审（C11–C14）与子代理对抗审计（C15–C24）的发现，全部经代码验证。

### C11 文件被替换时状态残留 🔴 违背 R6
`daemonV2.ts:159-162` 的 `ON CONFLICT DO UPDATE SET` 只覆盖 dir/filename/size/mtime/work_dir/season/episode/parse_confidence/updated_at。
**未覆盖**：work_id / needs_subtitle / sub_status / sub_attempt / embedded_langs / duration_sec。
失效场景：用户把某集 720p 换成 1080p（同路径不同文件）→ 旧的 `sub_status='covered'` 残留 → 新文件明明无字幕，系统认为已覆盖，永不补。
修法：指纹变化（mtime/size 不同）时，同时清空 needs_subtitle/sub_status/sub_attempt/recheck_after/embedded_langs/duration_sec。work_id 可保留（同路径通常仍是同作品）。

### C12 files.embedded_langs 从未被写入 🔴 judge 规则静默失效
judge 第 2 条规则依赖 embedded_langs 判"已有内嵌中文轨"（`subtitleJudge.ts:6`），
但全仓只有旧表在写（`libraryRepo.ts:1203-1207` UPDATE episodes/movies），files 表的 upsert 不写此列 → **永远 NULL**。
后果：本该跳过的内嵌中字片子被送进字幕流白找一圈。
修法：扫描阶段（或 judge 前置）对新增/指纹变化的文件跑一次 probe，写入 embedded_langs + duration_sec。

### C13 sub_attempt 可能不单调递增 🟡
异常路径/进程被杀导致失败未走退避回写时，计数不涨 → 永远到不了 7 次。
修法：把"领取即计数"或"finally 保证回写"作为不变量，TDD 覆盖异常路径。

### C14 字幕流与翻译流的 sub_status 所有权未定义 🟡
R19 定为主进程内独立循环后风险大降（无跨进程竞态），但仍需明确：
同一轮内一个文件不得同时出现在两个工作台的快照里。
修法：翻译工作台谓词严格 `sub_status='handoff_translate'`，字幕工作台严格 `sub_status IS NULL`，两者互斥。

### C15 `unavailable` 幽灵第五态 🔴 致命（已由 R17 裁决）
见 §5。`subtitleScheduler.ts:227-229` 写 `unavailable` 且不调 bump()。
**这是最常见失败路径**，加上 spec 的 `sub_status IS NULL` 谓词后该行永久出局且永攒不到 7 次 → 翻译流永远收不到活。
附带不对称：`no_safe_match` 反解 itemId 只认 `/s(\d+)e(\d+)` 正则（`subtitleScheduler.ts:207`）→
**电影（season/episode 为 NULL）永远匹配不上**，走另一分支。同一个"找不到"，电影能攒计数、剧集不能。
修法：按 R17 并入 NULL + 计数；反解归属改按 path 而非 itemId 正则。

### C16 第 3 步会静默切掉 4 个运维器官 🔴 执行顺序依赖倒置（已由 D5 裁决）
以下只挂在 `cmdWatch` 上，daemonV2/watchV2 零命中：
- `dbMaintenance`（`cli/index.ts:683` → `wal_checkpoint(TRUNCATE)` + 每日 `VACUUM INTO` 备份）
- `gcStaging`（`cli/index.ts:649` → `gcOrphans`，清 `.subtitle-staging` 和 `.subtitle-translate`）
- `traceRetentionDays`（`cli/index.ts:694`）
- `sweepWriteProbes`（仅 `ingest.ts:894`）
`db.ts:579-584` 注释记有实案：2026-07-21 软路由掉电，WAL 里 4MB 未 checkpoint 数据连库一起报废。
修法：第 3 步验收清单必须含这 4 项；切换方式改为"cmdWatch 内部把 ScoutDaemon 换成 daemonV2"而非换入口文件。

### C17 eng 兜底转译违背 R13 🔴（已由 R18 裁决废止）
`resolveSource.ts:73-78`：日漫无日文源时抽英文内嵌轨译成中文，sourceRef 前缀 `fallback:`。
注释自陈"用户裁决 2026-07-24：jimaku 确实没有就 eng 兜底"——与 R13 直接冲突。
另 `resolveSource.ts:84` 把 `origin === ''`（TMDB 未刮到语言）当英语处理，**语言完全未经证实**。
修法：删除 ja 分支的 eng 兜底（返回 no-source）；`origin === ''` 一律 no-source，不许臆断。
第 4 步须有红线 TDD 用例：origin=ja + 只有 en 轨 → 必须 no-source，不许 installed。

### C18 识别队列不按守备目录过滤 🔴 幽灵队列永久烧 LLM
`subtitleScheduler.ts:42-45` 有 roots 过滤（注释明言防"已移除根的残留数据"），
但 `identifyScheduler.ts:29-40` **无任何 roots 条件**。
失效场景：115 挂载点变更或 root 被移除 → 旧 root 下 files 行不再被 walk 访问；
字幕流靠过滤免疫，**识别流会永远为不存在的文件跑识别 agent**，每天烧一轮 TMDB+LLM，永不终止。
修法：`listIdentifyQueue` 补 roots 过滤（与字幕队列对齐）；并按 D2 处置孤儿行。

### C19 sidecar 被用户手动删除后永远发现不了 🟡 **已由 R24 从根上消解**
- judge 只挑 `needs_subtitle IS NULL`（`daemonV2.ts:125`）
- 装盘后写 `needs_subtitle=0`（`subtitleScheduler.ts:173`）
- 扫描指纹只看视频文件（`daemonV2.ts:176`），sidecar 不在 `DEFAULT_VIDEO_EXTS` 内（`selfScan.ts:28`），**不产生 files 行**
失效场景：用户嫌翻译质量差手动删掉 `.zh-Hans.srt` → 视频 mtime/size 未变 → 扫描跳过 → judge 不看 → 字幕流不排 → **永久失覆盖，系统认为 covered**。
修法（R24）：covered 改为**扫描的事实观察**而非 worker 的成功报告——扫描每轮检查同名中文字幕是否存在，
在则 covered、不在则回退 NULL。这样"手删字幕"、"装盘声称成功但文件没落地"、"用户手动放字幕"三种情况同时被正确处理。
不需要额外的"回滚"逻辑，因为根本没有单向门。

### C20 itemId 改造会静默摧毁剧级术语表继承 🟡 测试抓不到
`translateWorker.tools.ts:346,663` 用 `seriesKeyOf(task.itemId)` 加载/保存术语表。
`glossaryRepo.ts:46-49` 的实现假定 itemId 形如 `tmdb:123/s1e2`：`indexOf('/')`>0 时取前段。
若 itemId 改成含绝对路径（`/mnt/...` 开头）→ `indexOf('/')===0` → 返回整串 → **每个文件一个 key**。
后果：同剧第 2 集拿不到第 1 集冻结的术语表 → 人名地名每集换译法（`db.ts:353` 注释记有实案：同剧两 run 选出"东国/奥斯塔尼亚"）。**纯静默退化，测试不会红。**
修法：第 4 步明确 itemId 精确形态并保持 `seriesKeyOf` 可解（建议 `<work_id>/<稳定file标识>`，work_id 内无 `/`），或 glossary key 改为直接取 work_id。

### C21 works 缺 imdb 的存量回填无触发者 🟡
C5 只说"识别时一并落库"，但识别成功后 `work_id` 非 NULL → **永不再进识别队列**（`identifyScheduler.ts:32`）。
且采 imdb 需额外调 `getExternalIds`（`tmdb.ts:365`），现在只调 `getDetails`。
后果：CURRENT-STATE 记录的 83 个已识别作品 `provider_ids` 永远 NULL → 翻译抓源腿退化成文本 query（假阴性多）→
第 6 步 e2e 会在退化状态下验证，误以为这就是真实命中率。
修法：第 4 步补一个纯机械的存量回填 pass（按 works.id 逐个 getExternalIds），列为第 6 步前置。

### C22 巡检抛错也推进时间闸 → 一次故障吃掉 24h 🟡（已由 D4 裁决）
`daemonV2.ts:59-66`：`writeLastInspectAt` 在 catch **之外**无条件执行，而外层门是 `now - lastInspectAt >= 24h`。
日志文案自称"下轮重试"，实际睡 24 小时。挂载抖动 5 分钟修好也无事发生——与 R8 保护的本意（优雅恢复）正相反。
附带：时间闸用巡检**结束**时刻 → 真实周期 = 24h + 本轮耗时，逐轮漂移（大库跑 10h → 周期变 34h）。
修法：按 D4——距**开始**满 24h；失败不推进时间闸（或用独立的短 failure backoff）。

### C23 冻结快照尚未实现，且字幕流缺存在性校验 🟡
- R4 要求冻结，但 `daemonV2.ts:97` 的 while 每圈重查 `listSubtitleQueue` 取 `queue[0]` → **现状无冻结**（C1–C10 漏记此项）
- R12 的"文件仍存在"校验只给了翻译流，字幕流无任何 stat（`subtitleScheduler.ts:127` 直接把 path 塞进 targets）
失效场景：大库巡检跑 10h，快照第 0 分钟冻结，用户第 3h 删掉一整部剧，第 7h 字幕流处理到它 →
staging 沙盒在已删目录 ENOENT → catch 里 bump 全部文件 → sub_attempt 白涨。连 7 天白涨 7 次后"移交翻译流"，
翻译流才用 R12 检出文件不存在。**7 天 LLM 花在幽灵上。**
修法：消费快照前逐文件 stat，不存在则跳过并剔除，**不计 sub_attempt**；spec 缺口清单补记"冻结未实现"。

### C24 非英语片白烧 7 次字幕重试 🟡 信息可用性问题
`works.origin_lang` 在识别时就已落库（`identifyScheduler.ts:128`），即 **第 0 天就知道翻译救不救得了**。
但 spec 把"源语言不在单跳集合"的判定放在翻译流内部（③ 分支）= 7 天之后。
失效场景：韩剧/法国片无中字 → 字幕 agent 认真穷尽搜 7 天（7 个完整 LLM session + 全 provider 网络调用）→
第 8 天移交翻译流 → 100ms 内判定 unsupported → unsolvable。
修法（**已由 R21 裁决：采 (a)**）：
judge 阶段加 `translatable` 独立事实列（不进 sub_status，避免污染状态机）。
字幕流**照常搜 7 次**（也许真有现成中字），但满 7 次时看这一列：
- translatable=1 → handoff_translate
- translatable=0 → **直接 unsolvable，不进翻译流，不给第 8 次机会**

### C25 其他（🟢 建议，实现时顺手处理）
- `written===0` 的绑定被当成功且无退避 → 单轮内可无限重跑识别（`identifyScheduler.ts:140-150`）
- 识别失败回写波及整个 work_dir，未加 `AND work_id IS NULL` → 已 covered 文件被写脏 last_error（三处：165/184/197）
- 退避阶梯注释债务共 **5 处**（不止 C8 说的 1 处）：`subtitleScheduler.ts` 138 上方、144-145、203、218、250
- 硬链接/重复源产生两条独立跑道 → **已按 R22 裁决不修**，记为已知限制
- 翻译开关运行中关闭的语义 → 已定"只断新领取，在飞行中的跑完"

---

## 三补二、第二轮审计新增缺口（C26–C33）

以下为 R23/R24/R17–R22 等修订**新引入**的问题，全部经代码验证。详细报告见 `2026-08-08-audit-round2.md`。

### C26 R24 删掉 covered 写入后无出队机制 → 付费 LLM 热循环 🔴 已由 D6 裁决
`daemonV2.ts:95-103` 阶段 3 是 `while` 循环每圈重查队列取 `queue[0]`。
若按 R24 删掉 `subtitleScheduler.ts:173` 的 covered 写入而**不补 recheck_after**，
该文件仍满足工作台谓词 → 下一圈重选同一活 → 跑完整 agent session → 一直烧到下次扫描。
§5 翻译表原写 `installed` 时"清退避"，等于主动放回队列，同一 bug。
修法（D6）：worker 成功后必须写 `recheck_after`（字幕）/ `tr_recheck_after`（翻译）作为出队凭据。

### C27 needs_subtitle 与 sub_status 双列都判 sidecar → C19 换列复活 🔴 已由 D8 裁决
`subtitleJudge.ts:39` 规则 3 已在判 sidecar 并写 `needs_subtitle=0`；R24 又让扫描为同一磁盘事实写 `sub_status='covered'`。
失效场景：用户删字幕 → 扫描把 covered 回退 NULL，但 `needs_subtitle=0` 仍在 →
既不满足 judge 谓词 `needs_subtitle IS NULL`（`daemonV2.ts:125`）、又不满足字幕工作台谓词 `needs_subtitle=1` → **永久卡死**。
修法（D8）：职责切分——`needs_subtitle` 只表达"这资源原则上需要中文字幕"（语言/内嵌轨事实，**装盘与手动删字幕都不改它**）；
`sub_status` 表达"磁盘上当前有没有"。judge 规则 3（sidecar 检测）**从 needs_subtitle 移除**，改由扫描写 sub_status。

### C28 §2 流水线图与 §5 状态机自相矛盾 🔴 已修
原 §2 写"找到 → sub_status='covered'"、翻译"→ covered"，与 §5"唯一有权写 covered 的是扫描"直接冲突。
实现者会照流水线图做。已在本次修订中统一。

### C29 嵌套守备目录会让 D1 删光子根整个库 🔴 已由 D7 裁决
`settingsRepo.addRoot`（`:115`）是裸 `INSERT OR IGNORE`，**无嵌套检测**。
失效场景：`/media` 与 `/media/115` 同时是 root。115 断连 → `/media` 的 walk 成功（它自己没空）→
按 D1 逐根差集 → **115 下所有 files 行被当成"消失文件"全删**。这正是 R8 要防的灾难的实现版。
修法（D7）：addRoot 时检测祖先/后代关系并拒绝；已存在的嵌套配置在迁移时告警。

### C30 R24 的 stat 代价 45 次/文件，115 网盘放大 46 倍 🟡 已由 D12 裁决
现成实现 `findExternalSidecar`（`sidecar.ts:72-79`）是 15 种语言标签 × 4 种扩展名。
R24 要求连**未变化**文件也检测 → 大库几万文件 × 60 次 stat，115 是 FUSE 网盘挂载。
另有两处实现标签集**互不兼容**：`daemonV2.ts:140` 正则漏 `cht`；`sidecar.ts:12` 漏 `.vtt`。
且 `startsWith(stem+'.')` 会把 `X.1080p.zh.srt` 误归给 `X.mkv`。
修法（D12）：新增/指纹变化文件全量检测；未变化文件走低频复核（每周一轮或对 covered 抽样）。
同时统一两处实现为单一函数，修正误归属。

### C31 R21 translatable 只看 origin_lang 会误判死能救的片子 🟡 已由 D9 裁决
`resolveSource.ts:56-65`：`origin=ja` 时若有**日文内嵌轨**可直接抽取翻译——纯本地操作，完全符合 R13/R18 单跳原则。
但 R21 的预判仅看 `origin_lang ∈ 可抓源集合`（MVP=仅 en）→ BD 压制的日漫（普遍带日文内嵌轨）被判 `translatable=0` → 永久停牌。
另：spec 写"MVP 仅 en"，而 `translateWorkerTask.ts:49` 实为 `['en','ja']`，口径不一。
修法（D9）：预判须为"origin_lang 在可抓源集合 **或** 存在同语言内嵌文本轨"。
利用 C12 已写入的 embedded_langs，judge 阶段即可判定，无需额外 probe。

### C32 R19 缺形态约束与并发守卫 🟡 已由 D10 裁决
spec 只说"主进程内独立循环，互不阻塞"，未约束具体形态。而 daemonV2 现为顺序 `await` 单线程 async 循环。
翻译流是 SELECT → `await` LLM（数分钟）→ UPDATE；这几分钟内扫描可能已写 `covered`，翻译回写会**覆盖**它。
修法（D10）：全部回写带 `WHERE sub_status='handoff_translate'` 乐观守卫；
并在第 4 步明确循环形态（建议：主循环每轮末尾插入一次翻译推进，单次只处理一个作品，避免长时间占用）。

### C33 D2 指向了错误的文件 🟡 已由 D11 裁决
唯一的 root 移除入口 `settingsRepo.removeRoot`（`:159-215`）级联清理 8 张旧表
（item_files/episodes/movies/pending_removals 等），**一行 files 都不碰**（已验证）。
spec 原把 D2 归在"扫描删除清理"下 → 用裸 SQL 造数据的测试会绿，生产环境照漏。
修法（D11）：清理逻辑挂进 `removeRoot` 内部；测试须走 `removeRoot` 真实入口而非直接 SQL。

### C34 其他第二轮发现（🟢）
- `files.sub_status` 无 CHECK 约束，`db.ts:513` 注释仍列已废止的取值；加约束需 SQLite 12 步重建表，成本需预算
- 旧翻译候选谓词是 `sub_status='unavailable'`（`translateWorkerTask.ts:69`）→ R17 废止该值后，
  旧翻译流从第 2 步起饿死，直到第 4 步重接（窗口期翻译不可用，须在验收里注明）
- `gcStaging` 的 in-flight 集合传的是 `new Set()`（`cli/index.ts:649`）→ 新架构下无来源，
  会 GC 掉正在跑的翻译工作台；D5 只检查"接线了"，未检查"接对了"

---

## 三补三、第三轮审计新增缺口（C35–C39）

以下为 R25/R26 与 D6–D12 引入的问题。**共同特征：spec 逻辑自洽 + 实现缺写入者 + 单元测试会全绿**——
与已栽过的 C12（embedded_langs 从未被写入）完全同型。详见 `2026-08-08-audit-round3.md`。

### C35 R25 周频复查无执行者（鸡生蛋）🔴 已由 D13/D14 裁决
原 §5 转换表把周频复查的写入者标为"字幕流"，但字幕流入口谓词是 `sub_status IS NULL`——
**停牌行根本不在它视野内**，无人改它 → R25 静默失效（测试因直接调函数而绿）。
更糟：若强行让字幕流改状态，会掀掉飞行中的 `handoff_translate` →
翻译回写的 D10 乐观守卫匹配 0 行 → `tr_recheck_after` 不写 → **D6 要防的付费热循环从侧门放回来**。
修法：新增独立**阶段 2.6 停牌复查闸**（D13）；只处理 `unsolvable`，不碰 `handoff_translate`（D14）。

### C36 sub_attempt 归零导致成本 3.5 倍 🟡 已由 D15 裁决
原写"复查时 sub_attempt 归零"→ 回 NULL 后要重新攒 7 次才再停牌 →
一个永远找不到字幕的文件变成 **7 次 / 14 天 = 约 182 session/年**。
而 R25 原话是"每周找一次"= 约 52 次/年。差 3.5 倍，且 spec 未记录这个取舍。
修法（D15）：不归零。回 NULL 后下次失败立即判 `≥7` → 直接回停牌 → 稳定每周 1 次。

### C37 D12 与 R23/R24 互相掐死 🔴 已由 D16 裁决
D12（性能优化）说未变化文件"按 covered 抽样"复核；
但**用户手放字幕不改视频指纹**（这正是 C19 的根因）→ 停牌态文件永远不在复核范围 →
spec 承诺的"用户手放的也认"（R23/R24 的附带收益）**永不生效**。
两条单独看都对，合起来废掉整个 R23 设计意图。
修法（D16）：低频复核范围必须含停牌态（unsolvable + handoff_translate），不能只抽样 covered。

### C38 D9 的前提在存量数据上不存在 🔴 已由 D17 裁决（第四轮验证后加强）
D9 说"利用 C12 已写入的 embedded_langs 判 translatable"。但：
- 115 上现有 248 行是无 probe 情况下入库的，`embedded_langs` **全 NULL**
- judge 谓词是 `needs_subtitle IS NULL` 且 judge 已跑完 → **存量行永不重判**
spec 为 `provider_ids` 安排了回填（C21），**唯独漏了 embedded_langs**——
而它是 D9、judge 规则 2、C12 的共同前提。

**第四轮验证发现原修法不完整**（这是第三次栽在同一模式上：C12 → C35 → 本条）：
只写"补一个回填 pass"是不够的——回填 embedded_langs **不会改 needs_subtitle**，
而 judge 谓词是 `needs_subtitle IS NULL`（`daemonV2.ts:125`）→ judge 永不再看存量行 →
**回填等于白跑 ffprobe**。

修法（D17 加强版），三者缺一不可：
1. **回填内容**：probe 写 embedded_langs + duration_sec
2. **同时置 NULL**：`needs_subtitle = NULL` 与 `translatable = NULL` —— 打通重判通路
3. **明确执行位置**：作为第 3 步的**一次性迁移 pass**（不是每轮巡检的常驻阶段），
   在 daemonV2 启动时检查"是否有 embedded_langs IS NULL 的行"，有则分批 probe（每批上限 200 行，
   失败的行记 last_error 并留待下一轮，不阻塞主巡检）

### C39 我在 spec 里的一处断言有误（反向纠错）🟡 已修
spec 原写"`addRoot` 是裸 INSERT OR IGNORE，无嵌套检测"——**不准确**。
`apiV2.ts:809-818` 的 `findOverlappingRoot` 已有完整双向重叠检测（parent/child 双向），
且 `addMediaRoot` 在用（已验证）。真实缺口只剩 `seedRootsFromEnv` 这条旁路绕过检测。
修法（D7 已改）：**下移**已有实现到 settingsRepo + 补 seedRootsFromEnv 旁路，
**不要重写第二份**（否则两份实现会漂移）。

### C40 待补的零碎（🟢）
- §5 转换表缺 `translatable IS NULL` 时的分流行为 → 已补（视为"暂不可判"，不得判死）
- `translatable` 在换片源后需重算（新片源可能带内嵌轨）→ 已补入转换表
- MVP 边界口径已统一（R20）："外挂抓取仅 en；内嵌轨抽取 en/ja 皆可"

---

## 三补四、第四轮聚焦验证新增（C41–C44）

第四轮只验证三条致命是否闭合 + D13–D17 有无新洞，结果：C35 部分闭合、C37 部分闭合、C38 未闭合。
以下为补齐项，均已在本次修订中落地。

### C41 handoff_translate 在"翻译未启用"时成了真正的永久终态 🔴 已由 D14 裁决（用户选 a）
D14 原写"只有 unsolvable 参与周频复查"，本意是避免打断飞行中的翻译。
但**默认场景下用户并未开启翻译**（双门控：TRANSLATE_* 凭证 + `ai_translate_enabled='true'`），
于是满 7 次 → judge 判 translatable=1 → 写 handoff_translate → 翻译流不启动 → 复查闸又不管它
→ **永久卡死**，字幕流再也不找它。这正是上一轮刚修掉的"永久判死"原地复活。
修法（用户裁决 a）：复查对象取决于翻译开关——翻译未启用时 handoff_translate 也参与复查；
已启用时不参与。保住 R23"开关与文件状态解耦"（开关变化无需批量改库，只是取件范围变化）。

### C42 sub_recheck_at 的 NULL 语义未定义，两条路都是坑 🔴 已由 D18 裁决
- 照字面写谓词 `sub_recheck_at <= now` → 迁移后全库 NULL，**永不命中**（C12 同型静默失效）
- 补 `IS NULL OR sub_recheck_at <= now` → 首轮全库命中，几万文件 × 60 次 stat **雪崩**
修法（D18）：迁移时随机打散到未来 7 天内，**不留 NULL**，谓词保持纯粹。

### C43 存量回填缺重判通路 🔴 已由 D17 加强版裁决
见 C38。**第三次栽在同一模式**：写了某列却没定谁来重读它。
修法：回填时同时置 `needs_subtitle = NULL` 与 `translatable = NULL`，并明确执行位置与分批策略。

### C44 顺序调整后存量 unavailable 行会永久出局 🟡 已由 D19 裁决
顺序改为 1→2(daemonV2接容器)→3(状态机) 后，第 2 步先上线，但此时 `subtitleScheduler.ts:227`
仍在写 `unavailable`；到第 3 步启用新谓词 `sub_status IS NULL` 时，这批存量行
既不在字幕工作台、又攒不到 7 次 → 永久出局。
修法（D19）：第 3 步迁移必须含 `UPDATE files SET sub_status=NULL WHERE sub_status='unavailable'`。

### C45 我的一处表述有误（第四轮纠错）🟢 已修
spec 原称"顺序调整把翻译窗口期从两步缩到一步"——**不准确**。
`DaemonV2Deps`（`daemonV2.ts:27-39`）无 `ingestTrigger`/`dispatchTranslate` 钩子，
第 2 步换掉 ScoutDaemon 即同时停掉旧 ingest 与翻译派活 → 翻译从**第 2 步**起饿死。
真实窗口仍是两步（第 2→4 步），顺序调整只把起点提前、长度未变。已在第 2/3 步验收注记中更正。

---

## 四、执行顺序（依赖排序，审计后修正）

### 第 1a 步：守备目录地界加固（D7 + D11，零 schema 变更，可立即开工）
**拆分理由**（第四轮审计建议）：这两条都在 settingsRepo、不碰 scanner、无 schema 变更，
且 **D7 必须早于 D1 删除逻辑上线**——否则存量嵌套配置下 C29 删库风险依然成立。

- D7：把 `apiV2.ts:809-818` 的 `findOverlappingRoot`（已存在，双向重叠检测）**下移到 settingsRepo**，
  补上 `seedRootsFromEnv` 这条旁路。**不要重写第二份实现**（C39）
- D7 附加：对**存量**已配置的嵌套 root 做检测并告警（不自动删，只报警）
- D11：root 移除时的 files 清理挂进 `settingsRepo.removeRoot` 内部
  （已验证它只清 8 张旧表、一行 files 不碰 / C33）

TDD 用例：
- addRoot 拒绝父/子关系的嵌套 root（双向）
- `seedRootsFromEnv` 同样受嵌套检测保护（旁路封堵）
- 存量嵌套配置 → 启动时告警
- `removeRoot` 真实入口调用后，其下 files 行被清除（**测试须走 removeRoot，不许直接 SQL** / D11）

### 第 1b 步：扫描删除清理 + 指纹变化状态重置 + 字幕存在性观察（C1 + C11 + C12 + C19 + R24 + D12 + D16 + D18）

补上 R6/R7/R8/R24 与 D1/D2/D12。这是全部后续步骤的地基。

**R24 让扫描多一项职责**：它不再只回答"有哪些视频文件"，还要回答"每个视频当前有没有同名中文字幕"。
这一项是 covered 的唯一写入者，也让 C19（用户手删字幕）自然消解。

作用域语义（D1）：**逐守备目录比对**。对每个成功 walk 的 root，取"库中该 root 下的行" vs "本次扫到的路径集"，
差集删除。**不做全局补集**——否则"根本没扫到"与"扫到但为空"不可区分，R8 保护形同虚设。

**前置依赖已在第 1a 步完成**（D7/D11，commit 6c2aa90/a67aeb6/bbb2f2a/8b2a608/e3fcc8a/eb6ce7a/2eb8b9b）：
addRoot 已成闸门、存量已归一化、嵌套已告警、removeRoot 已清 files。

**D20（第 1a 步实施后新增的裁决）：删除逻辑必须主动跳过被嵌套污染的根。**
理由：第 1a 步的 `detectNestedRoots()` 只**告警**，不自动改用户配置（守备目录是用户的意图）。
若用户不理告警，D1 上线后仍会删错——所以不能依赖"用户看了告警去修配置"这个假设。
实现要求：
- 删除前先算 `detectNestedRoots()`，凡出现在任何一对里的 root（内层外层都算）**整个跳过删除**，
  只做 upsert（新增/更新照常，不做差集删除）
- 跳过时打日志说明原因，否则运维会以为删除逻辑坏了
- **`removeRoot` 已有的"排除更深守备目录前缀"手法可直接复用**（见 settingsRepo.ts 的 scopeSql 构造，
  审校 F8 修复引入）——但注意那是"删一个根时的自我限界"，D1 需要的是"这个根整体不安全就别删"，
  两者语义不同，不要混用

**D21：`'/'` 作为守备目录的特殊风险已在 F8 暴露，D1 同样适用。**
`substr(path,1,1) = '/'` 对所有绝对路径为真。若 `'/'` 是守备目录，其差集会覆盖全库。
第 1a 步已在 removeRoot 侧修掉（排除更深根的前缀），D1 侧必须独立再修一次——
两处是不同的代码路径，不会自动继承。

TDD 用例（先红后绿）：
- 文件在磁盘消失 → files 行被删除
- 整个作品目录消失 → 该目录下所有行被删除
- **守备目录不可访问 / 扫出 0 个媒体文件 → 跳过删除，不清库**（R8 安全阀）
- 挂载恢复后正常删除恢复生效
- 删除不得波及其他守备目录的行（D1 逐根隔离）
- **存量嵌套根 → 整个跳过删除且打日志**（D20，防"用户没理告警"场景删库）
- **`'/'` 作为守备目录时，差集不得覆盖其他根名下的行**（D21，F8 同一漏洞面）
- **root 从 media_roots 移除 → 其下 files 行立即删除**（D2，须走 `removeRoot` 真实入口 / D11）
- **addRoot 拒绝嵌套 root**（D7，防 C29 删库）
- 文件仍在但 mtime/size 变化 → 更新，且清空 sub_status/sub_attempt/recheck_after/embedded_langs/duration_sec（C11）
  - **需连带清 `needs_subtitle`**（订正 2026-08-08）：D8 的职责切分说它表达"原则上需要中文字幕"，
    据此曾写"不清"——**这是错的**。它的判据（origin_lang / embedded_langs）本身就随片源变，
    清掉判据却留着判决结果，正是本项目栽过三次的同型缺陷。
    真实伤害：旧 720p 有中文内嵌轨 → judge 判 `needs_subtitle=0`；换成无中文轨的 1080p 后仍是 0，
    而 judge 谓词是 `needs_subtitle IS NULL` → 永不重判 → 这集永远不补字幕。
    D8 的切分仍然成立，但它管的是"**装盘与手删字幕**不改 needs_subtitle"，不是"换片源不改"。
- 新增/指纹变化文件 → 写入 embedded_langs + duration_sec（C12，probe）

R24 专项用例：
- 视频旁有同名中文字幕 → sub_status='covered'（**即便系统从未为它跑过字幕流**，用户手放的也认）
- 原为 covered 但字幕被删 → 回退 NULL，重进字幕工作台（C19）
- 原为 covered 且字幕仍在 → 保持 covered，不重复排队
- 停牌中（handoff_translate/unsolvable）的文件突然出现字幕 → 变 covered（**停牌自然解除**，R23）
- 同名判定须覆盖常见 BCP-47 变体（.zh.srt / .zh-Hans.srt / .chs.ass 等）
- **非中文字幕（.en.srt）不得误判为 covered**
- **`X.1080p.zh.srt` 不得误归给 `X.mkv`**（C30 误归属）
- **两处标签集实现统一**：`cht` 与 `.vtt` 都须认（C30）

D12/D16/D18 两档机制用例（见 §5「字幕存在性检测的两档机制」）：
- schema 加 `sub_recheck_at INTEGER`
- **迁移时随机打散到未来 7 天内，不留 NULL**（D18 / C42 防雪崩与静默失效）
- A 档：新增/指纹变化文件 → 全量检测并写 `sub_recheck_at = now+7天`
- B 档：只挑 `sub_recheck_at <= now` 的行检测（**未到点的不查**，性能红线）
- **B 档谓词不得按 sub_status 过滤**——covered/unsolvable/handoff_translate/NULL 全都要轮到（D16 / C37）
- 停牌态文件被手放字幕 → **B 档轮到时能发现并转 covered**（防 C37 回归）
- A 档已检测的文件本轮不被 B 档重复检测（先 A 后 B，靠 `<= now` 谓词自然排除）

D8 职责切分用例（防 C27 卡死）：
- judge 规则 3（sidecar 检测）**从 needs_subtitle 移除**，改由扫描写 sub_status
- 用户删字幕后：needs_subtitle 保持 1、sub_status 回退 NULL → **能重进字幕工作台**
- 装盘成功不改 needs_subtitle（它只表达"原则上需要中文字幕"）

### 第 2 步：daemonV2 接上容器 + 运维器官（C2 + C16 + D5）
**顺序理由**（第三轮审计建议，已采纳）：本步不依赖任何 schema 变更，**提前到状态机改动之前**——
这样后续每一步都能在生产上被真实验证，且把 C34 记的"翻译窗口期不可用"从两步缩到一步。

**切换方式**：在 `cmdWatch()` 内部把 `ScoutDaemon` 换成 daemonV2，**不换入口文件**——
这样 4 个运维器官的接线天然保留。

验收清单（D5，缺一不可）：
- [ ] `dbMaintenance`（WAL checkpoint + 每日 VACUUM INTO 备份）
- [ ] `gcStaging`（gcOrphans，清 .subtitle-staging / .subtitle-translate）
- [ ] `traceRetentionDays`
- [ ] `sweepWriteProbes`
- [ ] 时间闸按 D4：距**开始**满 24h，失败不推进（C22）
- [ ] 容器重启后确认跑的是 daemonV2

### 第 3 步：状态机改造——sub_attempt + 停牌复查闸 + 废止 unavailable（C7 + C15 + R17 + R21 + R25 + C13 + C23 + C26 + C35–C38 + C41–C44）

**前置迁移（必须先跑，缺一不可）**：
1. `UPDATE files SET sub_status=NULL WHERE sub_status='unavailable'`（D19 / C44 防存量永久出局）
2. **embedded_langs 存量回填 pass**（D17 加强版 / C38 + C43）：
   - probe 写 embedded_langs + duration_sec
   - **同时置 `needs_subtitle = NULL` 与 `translatable = NULL`** ← 打通重判通路，缺这步回填等于白跑
   - 执行位置：daemonV2 启动时检查有无 `embedded_langs IS NULL` 的行，有则分批处理
     （每批上限 200 行；失败行记 last_error 留待下轮，不阻塞主巡检）

**本步改动**：
- schema 加 `sub_attempt INTEGER NOT NULL DEFAULT 0`
- schema 加 `translatable INTEGER`（NULL=暂不可判 / 0=不可救 / 1=可救），judge 阶段写入（R21 + D9）
  - 判据：`origin_lang ∈ 可抓源集合` **或** `embedded_langs 含同语言文本轨`（D9，防 C31 误判死日漫）
  - **`translatable IS NULL` 不得判死**：视为"暂不可判"，继续留在字幕流（C40）
- **删除 `unavailable` 写入**，改为 sub_status 保持 NULL + sub_attempt+1 + recheck_after=明天（R17）
- **装盘成功不写 covered**，只写 `recheck_after` 出队（D6，防 C26 热循环）
- `no_safe_match` 归属反解**改按 path**，消除电影/剧集不对称（C15）
- sub_attempt **`>= 7`**（不是 `== 7`）时分流（R21/D15）：translatable=1 → `handoff_translate`；=0 → `unsolvable`
- **新增阶段 2.6 停牌复查闸**（D13 / C35）：独立阶段，**不由字幕流执行**
  - 对象随翻译开关变化（D14 / C41，用户裁决 a）：
    · `unsolvable` 恒参与
    · `handoff_translate` **仅当翻译未启用时**参与
  - 改回 NULL，**sub_attempt 不归零**（D15）→ 下次失败立即判 >=7 → 回停牌 → 稳定每周 1 次
- **实现冻结快照**：巡检开始时取一次队列，消费前逐文件 stat，不存在则剔除且**不计 sub_attempt**（C23）
- 保证计数单调（C13：finally 回写或领取即计数）
- 顺手清理 5 处退避注释债务（C25）

TDD 红线用例：
- 满 7 次 + translatable=1 → handoff_translate
- 满 7 次 + translatable=0 → **unsolvable，且绝不出现 handoff_translate**
- **translatable IS NULL → 不得进 unsolvable**（C40，防误判死）
- 「搜过确实没有」→ sub_status 仍 NULL 且 sub_attempt+1（R17，防第五态回归）
- **装盘成功后该文件不得在同轮被重选**（C26 热循环红线）
- **unsolvable 满 7 天 → 阶段 2.6 放回 NULL，且 sub_attempt 保持不变**（D15，防 3.5 倍成本回归）
- **翻译未启用 + handoff_translate 满 7 天 → 阶段 2.6 放回 NULL**（D14a / C41，防永久终态回归）
- **翻译已启用 + handoff_translate → 阶段 2.6 不触碰**（D14，防打断飞行中的翻译）
- **sub_attempt=9 的文件仍能正确分流**（`>=7` 而非 `==7`，D15）
- **回填 pass 后存量行的 needs_subtitle 与 translatable 均为 NULL**（D17 / C43 重判通路红线）
- **迁移后不存在 sub_status='unavailable' 的行**（D19 / C44）
- 电影（season/episode 为 NULL）与剧集在同一失败下计数行为一致（C15 对称性）
- 快照中文件已消失 → 剔除且 sub_attempt 不变（C23）
- **origin=ja 且有日文内嵌轨 → translatable=1**（D9 防误判死）

**验收注意**（C34 + C45 更正）：翻译功能从**第 2 步**起饿死（`DaemonV2Deps` 无 `dispatchTranslate` 钩子），
到第 4 步重接，真实窗口为**两步**。此前 spec 称"缩短为一步"有误，已更正。这是已知、可接受的过渡代价。

### 第 4 步：翻译接新架构 + 独立循环（C3 + C4 + C5 + C17 + C20 + C21 + C32 + D3 + D6 + D10 + R18 + R19）
- **废止 eng 兜底**：删 `resolveSource.ts:73-78` ja 分支的英轨回退；`origin === ''` 一律 no-source（R18 + C17）
  - 红线 TDD：origin=ja + 仅 en 轨 → 必须 no-source，不许 installed
- `fetchSourceSub` 的 locate 改读 files/works（C4）
- `TranslateTask.itemId` 精确形态定为 `<work_id>/<稳定file标识>`，保持 `seriesKeyOf` 可解（C20）
  - 红线 TDD：同剧两集必须命中同一 glossary key
- works 表加 `provider_ids`；识别时调 `getExternalIds` 落库（C5）
- **存量回填 pass**：按 works.id 逐个 getExternalIds 补 provider_ids（C21，第 6 步前置）
- schema 加 `tr_attempt` / `tr_recheck_after`（D3）
- 按 R19 实现**主进程内独立循环**，形态须明确（C32）：
  - 建议：主巡检每轮末尾推进一次翻译，单次只处理一个作品，避免长时间占用主循环
  - 全部回写带乐观守卫 `WHERE sub_status='handoff_translate'`（D10，防扫描写入被覆盖）
  - 成功后写 `tr_recheck_after` 出队，**不写 covered**（D6 + R24）
- 翻译总开关双门控（TRANSLATE_* 凭证 + `ai_translate_enabled='true'`）；关闭时不领新活，在飞行中的跑完
- 跑前校验文件仍存在（R12）
- 8 种 worker status 按 §5 映射表处置
- **修 gcStaging 的 in-flight 集合**（C34）：新架构下需真实来源，否则会 GC 掉正在跑的翻译工作台

### 第 5 步：字幕 skill 两条边界（R9）
`src/agent/skills/findSubtitleSkill.ts`（纯 prompt 改动）：
- **不许编造**：无 search_source 证据不得报"找到"
- **不许撂挑子**：还有未探索的源/查询变体时不得报"没有"；穷尽后方可
- 明确区分"限流等待"与"确实没有"（Peacemaker 误判根因）

### 第 6 步：115 改可写 + **单元式** live test（R16）
用户裁决：**先单元测，不从 0 到 1 全量**——全量出问题难查根因。

测试目录设计（用户方案）：软路由上建一个**测试守备目录**，放当前守备目录的有限子集
（一些电影、动画、电视剧），单元测与全量测都在此进行；删目录/删文件来验证"以文件为真源"。

分单元验证顺序：
1. 扫描单元（含删除/替换/sidecar 消失）
2. 识别单元
3. 识别→字幕**接线**
4. 字幕单元
5. 字幕→翻译**接线**（造 7 次移交场景）
6. 翻译单元（**最后修最后测**）
   - 用**较短的电视剧**，非电影（用户指定）
   - 有内嵌 / 无内嵌 两种场景各测
   - 不用动画（日文源未支持，见 C6）
   - 候选：和平使者（Peacemaker）有一集一直找不到字幕，适合做 handoff 场景

### 第 7 步：清理（C9 + C10 + C25）
- 删 daemon.ts / dispatcher.ts / orchestratorAgent*（须在第 4 步完成后）
- 旧表迁移或废弃
- C25 的零碎项（written===0 退避、识别回写加 work_id IS NULL 限定等）

---

## 五、状态机（sub_status 取值）

**恰好四态，无第五态**（R17）。任何写入其他值视为 bug。

**核心语义（R23/R24）**：sub_status 不是"流程走到哪一步"，而是**"磁盘上现在是什么情况"的投影**。
唯一有权把它写成 `covered` 的是**扫描**（扫到同名中文字幕），不是字幕/翻译 worker 的成功报告。
worker 只负责把文件放到磁盘上；**磁盘上有没有，由扫描说了算**。

| 值 | 含义（事实陈述） | 出口 |
|---|---|---|
| NULL | 磁盘无中字，待处理/重试中（含"搜过确实没有"） | 字幕工作台排它 |
| `covered` | **扫描确认磁盘上有同名中文字幕** | 事实态；字幕消失则下次扫描自动回退 NULL |
| `handoff_translate` | 满 7 次未果且 translatable=1，等翻译流处理 | 翻译工作台排它；**界面显示"停牌"**；仍每周复查（R25） |
| `unsolvable` | 满 7 次且 translatable=0，或翻译已判无源 | **界面显示"停牌"**；仍每周复查（R25/R26） |

### 状态转换表（唯一权威，实现须逐条对照）

| 从 | 事件 | 到 | 写入者 | 附带 |
|---|---|---|---|---|
| NULL | 扫描发现同名中字 | `covered` | **扫描** | — |
| NULL | 字幕 worker 装盘成功 | NULL（不变） | 字幕流 | 写 recheck_after 出队（D6），等扫描确认 |
| NULL | 字幕 worker 找不到 | NULL（不变） | 字幕流 | sub_attempt+1，recheck_after=明天 |
| NULL | sub_attempt 达 7 且 translatable=1 | `handoff_translate` | 字幕流 | 界面转停牌 |
| NULL | sub_attempt 达 7 且 translatable=0 | `unsolvable` | 字幕流 | 界面转停牌 |
| `covered` | 扫描发现字幕已消失 | NULL | **扫描** | 重进字幕工作台（C19 消解） |
| `covered` | 视频指纹变化（换片源） | NULL | 扫描 | 清 sub_attempt 等（C11） |
| `handoff_translate` | 翻译装盘成功 | 不变 | 翻译流 | 清 tr_attempt + 写 tr_recheck_after（D6），带守卫（D10） |
| `handoff_translate` | 翻译判无源 | `unsolvable` | 翻译流 | 带守卫（D10） |
| `handoff_translate` | 翻译失败（held 等） | 不变 | 翻译流 | tr_attempt+1，tr_recheck_after=明天 |
| `handoff_translate` | 扫描发现字幕出现 | `covered` | **扫描** | 停牌自然解除（R23） |
| `unsolvable` | 扫描发现字幕出现 | `covered` | **扫描** | 停牌自然解除；用户手放的也认 |
| `unsolvable` | 周频复查到点（阶段 2.6） | NULL | **阶段 2.6 复查闸**（非字幕流 / D13） | **sub_attempt 不归零**（D15）→ 下次失败立即回停牌 |
| `handoff_translate` | 周频复查到点 **且翻译未启用** | NULL | **阶段 2.6 复查闸**（D14a） | 同上；翻译一开则不再被复查，自然被翻译流领走 |
| `handoff_translate` | 周频复查到点 **且翻译已启用** | 不参与（D14） | — | 归翻译流管，有自己的 tr_recheck_after 节奏 |
| NULL | 视频指纹变化（换片源） | NULL | 扫描 | 清 sub_attempt/sub_status/embedded_langs 等；**translatable 需重算**（D9） |
| 任意 | 文件从磁盘消失 | 行被删除 | 扫描 | R7 |
| NULL | translatable IS NULL（judge 未判/probe 缺失） | 保持 NULL | — | **不得判死**：视为"暂不可判"，继续字幕流；待 D17 回填后重判 |

**无永久终态**（R26）：`covered` 会因字幕消失回退，`unsolvable` 会因周频复查回到 NULL。
唯一的"离开"是文件本身从磁盘消失。

**长期行为**（D15）：一个永远找不到字幕、且翻译救不了的文件，稳定在"每周尝试 1 次"（约 52 次/年）。
若 sub_attempt 归零则会变成"每 14 天烧 7 次"（约 182 次/年），是前者的 3.5 倍——故不归零。

### 字幕存在性检测的两档机制（D12 + D16 具体化）

R24 让扫描承担"每个视频当前有没有同名中文字幕"这项职责，但全量做代价是 60 次 stat/文件
（15 语言标签 × 3 扩展名），在 115 FUSE 网盘上放大约 46 倍。故分两档：

**A 档 · 全量检测**（每轮巡检必做）
触发对象：新增文件、指纹（mtime/size）变化的文件。
理由：这些文件的字幕状态必然未知或已失效，不查不行。

**B 档 · 到点轮转复核**（每轮只查到点的那批）
新增列 `sub_recheck_at INTEGER`，语义="下次该复核字幕存在性的时刻"。
- 每次检测（A 档或 B 档）后写 `sub_recheck_at = now + 7天`
- 每轮巡检只挑 `sub_recheck_at <= now` 的行做检测
- 效果：全库自然摊平成"每个文件每周复核一次"，单轮开销 ≈ 全库 1/7

**NULL 语义写死**（D18，防首轮雪崩）：
迁移时对全库随机打散 —— `sub_recheck_at = now + abs(random() % (7*86400*1000))`，**不留 NULL**。
- 若照字面写 `sub_recheck_at <= now`，NULL 行永不命中 → 静默失效（同 C12 模式）
- 若补 `IS NULL OR sub_recheck_at <= now`，首轮全库命中 → 几万文件 × 60 次 stat 雪崩
- 故第三条路：迁移即打散，谓词保持纯粹的 `sub_recheck_at <= now`

**范围必须含停牌态**（D16 / C37）：B 档的挑选谓词**不得按 sub_status 过滤**——
`covered`（可能被手删）、`unsolvable`（用户可能手放）、`handoff_translate`（同上）、`NULL` 全都要轮到。
若只抽样 covered，则"用户手放字幕也认"（R23/R24）对停牌态**永不生效**，废掉 R23 设计意图。

**A/B 档不重复检测**：A 档命中的文件（新增/指纹变化）在本轮已检测并写了 `sub_recheck_at = now+7天`，
故 B 档的 `<= now` 谓词自然不会再选中它。实现时 A 档先跑、B 档后跑即可，无需额外去重。

**已删除的行不做检测**：阶段 1 的删除清理先于字幕检测执行，故 B 档不会对已消失的文件跑 stat。

**与阶段 2.6 的分工**（勿混淆）：
- B 档复核 = 查"磁盘上有没有字幕"（事实观察，可能让 unsolvable → covered）
- 阶段 2.6 = 让 `unsolvable` 回 NULL 去**重新搜一次**（重试调度）
两者节奏都是 7 天但**目的不同、互不替代**：前者发现"已经有了"，后者驱动"再去找"。

### 「停牌」的界面语义与解除规则（R23/R25/R26）

用户看到的**停牌** = `handoff_translate` 或 `unsolvable` 二者之一，即"这一集当前没有中文字幕"。

触发（用户原话）：过了七天不进字幕工作流，且 ①翻译开关没开 或 ②开了但翻译也搞不定。

**停牌 ≠ 系统放弃**（R25，用户裁决）：
- 后台**继续每周找一次**（非每天），字幕组几个月后补发是常事
- 但界面在字幕真出现前**一直显示停牌**，不因"后台还在找"而改口
- 即停牌是**当前事实陈述**，不是流程终点

**执行者是独立的阶段 2.6 复查闸**（D13），不是字幕流——
字幕流谓词为 `sub_status IS NULL`，看不见停牌行，让它负责复查是鸡生蛋。

**复查对象取决于翻译开关**（D14，用户裁决 a）：
- `unsolvable` — 恒参与复查
- `handoff_translate` — **翻译未启用时参与**（否则它成了真正的永久终态，违背 R25）；
  翻译已启用时不参与（归翻译流管，复查会打断飞行中的翻译）

这个设计保住了 R23"开关与文件状态解耦"的好性质：开关变化时**不需要批量改库**，
只是复查闸的取件范围随开关变化；开关一开，停在 handoff_translate 的文件自然被翻译流领走。

**复查时 sub_attempt 不归零**（D15）：回 NULL 后下次失败立即判 `>= 7`（**不是 `== 7`**）→ 直接回停牌。
故稳定节奏 = 每周 1 次尝试（约 52 次/年）。若归零会变成每 14 天烧 7 次（182 次/年）。

**解除的唯一凭据 = 扫描发现同名字幕文件**：
- 翻译流领走了它 / 正在跑 / 跑失败 → 仍显示停牌（磁盘还没东西）
- 翻译装盘成功、字幕落到磁盘 → **下次扫描扫到 → 自然变 covered**
- 用户自己手动放了一个字幕进去 → 同样扫到就认（R24 的附带收益）
- 周频复查真找到了 → 同样经扫描确认后解除

**不存在"因为开关开了就把状态改回去"这种跳转**。翻译开关关闭时满 7 次的文件仍写 `handoff_translate`
（表示"该由翻译处理"这个客观归属），只是翻译流不启动、它一直显示停牌；开关一开翻译流自然领到它。
故 R23 让"开关状态"与"文件状态"彻底解耦——不需要在开关变化时批量改库。

**关键：`unavailable` 这个第五态必须废止**（R17）。
现状 `subtitleScheduler.ts:227` 在"有搜索证据但确实没找到"时写 `sub_status='unavailable'` 且**不递增计数**。
这是最常见的失败路径。若保留：该行既不在字幕工作台（sub_status 非 NULL）、又永攒不到 7 次 → **翻译流永远收不到活**。
改法：这条路径改为 `sub_status` 保持 NULL + `sub_attempt+1` + `recheck_after=明天`，与其他失败路径同轨。

### 翻译流内部状态（不进 sub_status）

翻译 worker 返回 8 种 status，映射如下。
**注意（R24）**：worker 报 installed 不直接写 covered，只清退避、等扫描确认。

| worker status | 处置 |
|---|---|
| `installed` | **不写 covered**（R24）；清 tr_attempt + 写 tr_recheck_after 出队（D6）；等扫描确认 |
| `already-covered` | 同上（扫描本就会认） |
| `no-source` / `no-embedded` | sub_status='unsolvable'（停牌，仍周频复查）|
| `held`（质量闸拦下） | tr_attempt+1，tr_recheck_after=明天；满 3 次 → unsolvable |
| `extract-failed` / `probe-failed` / `write-failed` | 同上退避轨 |

**全部回写必须带守卫** `WHERE sub_status='handoff_translate'`（D10）——
翻译等 LLM 的几分钟内扫描可能已把状态写成 covered，无守卫会被覆盖。

**必须有独立退避列**（D3）：无退避列则独立循环下一圈立刻重领同一行 → 付费 LLM 热循环。
旧架构靠 jobs 表的 attempt/park 解决过这个（`translateWorkerTask.ts:167` 注释记有实案：job29 重试 11 次全同样错误）。

---

## 六、当前测试基线

后端 2768 条，7 红全为既有债务（deployContract 3 / buildAdapters 2 / secrets 1 / settingsRepo 1），
早于本次工作即存在。**任何改动不得新增红灯。**

---

## 七、待用户后续确认

1. C6 覆盖范围（实际仅 en 可抓源）已按 R20 接受为 MVP；日漫走翻译流需 jimaku 落地，属另一轮任务
2. `unsolvable`（停牌）已按 R23 处理：不靠状态跳转解除，只靠扫描发现字幕自然解除
3. 硬链接/重复源已按 R22 裁决：不修，只管守备目录，记为已知限制
4. 停牌在界面上的具体呈现（写在集数上）——前端重做时落地
