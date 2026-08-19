// src/dashboard/mediaLibraryApi.ts —— R-F2 / R-F5 媒体库页的只读数据层。
//
// ── 为什么是新文件、新 DTO，而不是改 apiV2.ts 那 4 个 builder ──────────────────
// buildLibrary / buildSeriesDetail / buildLibraryMovieDetail / buildLibrarySeriesDetail
// 整个长在**旧表**（series / episodes / movies / subtitles）上。生产实测：
// `series` 0 行、`works` 110 行、`files` 1290 行、`tmdb_seasons` 2144 行 —— 那 4 个 builder
// 对新架构一条数据都读不出来（海报墙不是"显示旧数据"，是整个空的）。
// 而旧 `LibraryItemDTO` 里 `job: LibraryJobDTO` 挂着已死的 jobs 表、`coverage` 是旧覆盖率
// 模型，原地改会让同一个 DTO 同时背两套语义。故：新建端点 + 新 DTO，旧的原样留着不动，
// 等前端替换完成后再一并删（那是后续的事，本文件不碰它们）。
//
// ── 字段命名铁律（本仓今天栽过三次「把中间量说成结论量」）───────────────────
// 每个计数字段名都必须与它真实统计的东西逐字对应：
//   expectedEpisodeCount  = tmdb_seasons 的行数（应有集，R-F5）
//   onDiskEpisodeCount    = 磁盘上真有的**去重后**集数（实有集）
//   missingEpisodeCount   = 应有但没有 = 虚线卡片数
//   subtitledEpisodeCount = 已获取中文字幕的集数（R-F2 口径，见下）
// 绝不出现一个含混的 `episodeCount`。
import type { ScoutDb } from '../v2/db.js'
import { langOf, tagsForLanguage } from '../agent/languages.js'

// ---- 圆点三态（R-F2 用户裁决）----

/** 卡片右上角小圆点。
 *  · 'none'  = 没有中文字幕
 *  · 'blue'  = 内嵌中文轨（不需要处理）
 *  · 'green' = 外挂中文 sidecar（磁盘上真有一份可换可删的字幕文件）
 *
 *  🔴 **保持三态，不许扩**（R-F12 落地时点名的约束）：它被 MediaLibraryItemDTO 的
 *  subtitledEpisodeCount 口径、MediaLibraryEpisodeDTO.dot、MediaLibraryMovieDTO.dot 三处共用，
 *  而列表页海报卡呈现的是"底部渐变嵌进度条"不是点——往这个联合里加值会让列表页拿到它
 *  根本不会渲染的态。八态是**新增字段** `episodeState`，见下方 EpisodeState。 */
export type SubtitleDot = 'none' | 'blue' | 'green'

// ---- 八态语义（R-F12 集号染色）----

/** 一格（一集 / 电影那一格）**唯一**的语义态，供 R-F12 集号染色（`E01 ✓`）使用。
 *
 *  ── 为什么优先级链必须在后端算，不能透传原值让前端拼（R-F15）────────────────
 *  `embedded` 的判据是"embedded_langs 含**目标语言**"，而目标语言是
 *  `resolveTargetLanguages(env, settings.target_languages)` 的结果——前端根本不知道它是什么。
 *  透传 skip_reason/needs_subtitle/sub_status 三个原值让前端拼，等于把 R-F15 的后端判据
 *  复制一份到浏览器里：换目标语言那天两份判据必然漂移（C30 的原型），且前端那份没有任何
 *  测试钉着。故此列**只出结论**，原值一个都不透传。
 *
 *  ── 冲突组合是常态，不是边缘（设计文档教训八）──────────────────────────────
 *  最硬的例子来自 retarget.ts：换目标语言时它清 needs_subtitle + skip_reason，却**刻意不清
 *  sub_status**（R24 铁律，清了会掀掉飞行中的翻译）。于是"sub_status='handoff_translate' +
 *  needs_subtitle IS NULL"是一个**正常库里必然出现**的组合。若 unjudged 排在 translating
 *  前面，正在被翻译的那一集会显示成 `?`。优先级链的顺序因此是判据本身，不是排版偏好。 */
export type EpisodeState =
  /** 虚线格：TMDB 说这季有、磁盘上没有。**不染色**，也不参与下面任何判据
   *  （没有文件就没有任何字幕事实可言）。 */
  | 'absent'
  /** ✓ 绿。磁盘上真有一份外挂目标语言 sidecar（`sub_status='covered'`）。 */
  | 'covered'
  /** ⇄ 已移交翻译流（`sub_status='handoff_translate'`），正在处理。 */
  | 'translating'
  /** ⊘ 判定无解（`sub_status='unsolvable'`）。**不是永久终态**——阶段 2.6 复查闸每周放回一次
   *  （R25/R26），界面显示停牌只是"现在没辙"。 */
  | 'unsolvable'
  /** ◇ 片子原生就是目标语言（`skip_reason='origin-skip'`），压根不需要字幕。 */
  | 'origin-skip'
  /** ◆ 自带目标语言内嵌轨。 */
  | 'embedded'
  /** ▭ 机械特典（`skip_reason='extra'`）：NCOP/NCED/PV/menu 这类无对白映像。
   *  2026-08-13 用户裁决「特典都完全不算在找字幕的范围」——它与 origin-skip / embedded
   *  同属"已解决、不用人操心"那一族，只是**理由**不同（前两者是"不需要"，这个是"不算数"）。 */
  | 'extra'
  /** ··· 系统认为这一集需要找字幕、还没找到（`needs_subtitle=1`）。 */
  | 'pending'
  /** ? 第 8 态：系统**答不上来**。两种来源，见 classifyFileState 的终态分支。 */
  | 'unjudged'

/** 一个语言标签是否算**目标语言**（R-F15 目标语言可切换后的统一判据）。
 *
 *  与旧 isChineseTag 同构（两臂：tagsForLanguage 精确表 + langOf 折叠），但按 target 参数化。
 *  🔴 2026-08-19 实案（AHS / DxD）：媒体库 index 的「自带 N」与蓝点此前硬编码中文
 *  （isChineseTag），目标切到 en 后，内嵌英文轨的文件不计入自带、显示成「没字幕」，
 *  而详情页因走 judge 按目标语言写的 skip_reason 反而是对的——同一张页两个口径。
 *  isChineseTag 已由 isTargetLangTag 取代删除。 */
function isTargetLangTag(tag: string | null | undefined, target: string): boolean {
  if (!tag) return false
  const t = tag.toLowerCase()
  return tagsForLanguage(target).some((x) => x.toLowerCase() === t) || langOf(tag) === langOf(target)
}

/** `files.embedded_langs`（JSON 数组串）解析。
 *  · NULL      = 没探过 → null
 *  · '[]'      = 探过、确认零轨 → []
 *  · 坏 JSON   = 按"没探过"处理（同 cli/unidentifiedFindSubtitle.ts 的既有口径），不抛。 */
function parseEmbeddedLangs(raw: string | null): string[] | null {
  if (raw == null) return null
  try {
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr) ? (arr as string[]) : null
  } catch {
    return null
  }
}

/** 一个**文件**是否有外挂中文 sidecar。
 *
 *  判据是 `files.sub_status === 'covered'` —— R24 把这一列的唯一写入者收归扫描
 *  （"磁盘上真有同名中字"这个事实观察）。
 *
 *  ⚠️ 只认 'covered' 这一个值，**不许**用 `sub_status IS NOT NULL`：
 *  'handoff_translate'（已移交翻译流）与 'unsolvable'（判定无解）都是**流程中间态**，
 *  不是磁盘事实 —— 把它们算成"有字幕"会让排队中的集提前变绿点，正是"把中间量说成结论量"。
 *
 *  ── 「我们配的」与「用户手放的」要不要区分：**不区分**（决策与理由）────────────
 *  covered 同时包含两者（R24 是磁盘观察，不问来路）。新加的 notifications 表确实能区分
 *  （它只记我们装的），但媒体库页是**磁盘现状**的视图，不是成果账本：
 *   ① 用户视角"这一集有没有中文字幕"就是全部问题，来源不改变任何可执行动作；
 *   ② 若按 notifications 区分，用户手放的字幕会显示成"无点" → 系统看起来要去补一份
 *      它其实已经有的字幕，正是 R24 要消解的那类"库与磁盘不一致"；
 *   ③ notifications 只有一周窗（NOTIFICATION_RETENTION_MS），拿它当颜色判据会让
 *      八天前配上的字幕**自己变回无点**——一个纯粹由保留期造出的假状态变化。
 *  「我们配的成果」这条叙事归通知页（R-F3），不该挤进媒体库页的圆点。 */
/** 一个**文件**是否有外挂目标语言 sidecar（sub_status='covered'，R24 扫描独占）。
 *  覆盖判据与目标语言无关——covered 这一列由扫描按 `tagsForLanguage(target)` 找 sidecar 写入，
 *  写入侧已经是目标语言驱动的（daemonV2:2056）。故此处不参数化。 */
function fileHasSidecar(subStatus: string | null): boolean {
  return subStatus === 'covered'
}

/** 一个**文件**是否有内嵌**目标语言**轨。没探过（NULL）→ false（没有证据就没有蓝点）。
 *  🔴 2026-08-19（AHS/DxD 实案）：此前叫 fileHasEmbeddedChinese、硬编码中文——目标切到 en
 *  后内嵌英文轨不计入「自带」，index 与详情页两个口径。参数化为目标语言。 */
function fileHasEmbeddedTarget(embeddedLangs: string[] | null, target: string): boolean {
  return embeddedLangs != null && embeddedLangs.some((t) => isTargetLangTag(t, target))
}

// ---- 八态判定（R-F12）----

/** 一个**文件**的八态判定（不含 'absent'——那是格级的、由 onDisk=false 决定，见 aggregateState）。
 *
 *  ── 优先级链的顺序与理由（这是本函数的全部内容，顺序即判据）──────────────────
 *  链条是 covered → translating → unsolvable → origin-skip → embedded → pending → unjudged，
 *  分三段，每一段的段内顺序都有各自的理由：
 *
 *  【第一段 sub_status 三态（covered / translating / unsolvable）优先于一切】
 *  因为它们是**这一行当前正处在流水线的哪个位置**，而 needs_subtitle / skip_reason 是
 *  "当初判定它原则上需不需要字幕"。D8 把这两组切得很干净：needs_subtitle 只看语言事实、
 *  一次判完就不再动（谓词 `needs_subtitle IS NULL`），sub_status 则随磁盘与流程持续变化。
 *  拿一个**不再更新的判决**去盖一个**持续更新的状态**，显示的就是过期信息。
 *  具体到必然出现的组合：满 7 次失败的行被 subtitleScheduler.ts:326 写成 handoff_translate /
 *  unsolvable，而它的 needs_subtitle 一直是 1（装盘与停牌都不改 needs_subtitle / D8）——
 *  若 pending 排在前面，**每一个**停牌/在翻译的集都显示 `···`，⇄ 与 ⊘ 两个态在真实库里
 *  永远不会出现。
 *
 *  【第一段段内：covered 最先】
 *  covered 是 R24 的**磁盘事实观察**（扫描独占写入），另外两个是流程中间态。
 *  实测这个组合会真实发生：daemonV2.ts:1603 的 observeSubtitle 对扫到 sidecar 的行
 *  **无条件**写 covered（"不论原状态是 NULL 还是停牌态"，停牌的解除凭据就是它 / R23）——
 *  也就是说 handoff_translate → covered 的跃迁靠的正是这条无条件写，此后该行不会再是
 *  handoff_translate。反过来 translateWorkerTask.ts:182 的 D10 乐观守卫
 *  `AND sub_status='handoff_translate'` 保证翻译回写**永远不会**覆盖 covered。
 *  两侧都咬死了：字幕已经在盘上时不许显示"还在翻译"。
 *
 *  【第二段 skip_reason/embedded 优先于 pending】
 *  origin-skip 与 embedded 都来自 `needs_subtitle=0`（judgeSubtitle 的两条 needs:false 分支），
 *  与 pending 的 `needs_subtitle=1` **互斥**，段内没有真正的冲突可言。列成链只是为了让
 *  "0 却没有 reason"这种旧库形态有明确落点（见下方 needs===0 的兜底）。
 *
 *  【第二段段内：origin-skip 与 embedded **不存在**优先级——它们是同一列的两个互斥值】
 *  ⚠️ 审计 A-2/A-3 纠正：这里原先写着"origin-skip 先于 embedded，照抄 judgeSubtitle 的规则顺序"，
 *  并声称该顺序经变异验证。**两句都不成立**——审计实测把两个 if 调换、把 STATE_RANK 里两者
 *  调换，**测试都是 0 红**，因为 `skip_reason` 是**单值列**，两个守卫天然互斥，调换是空操作。
 *  真正会红的是把**返回值**互换（那是映射错了，不是顺序错了）。
 *
 *  skip_reason 由 judge 按当时的 target_languages 写入。needs 已经落成 0 时，
 *  必须听 reason，不许拿 langs 重算（换语言后 origin-skip 与 embedded 命运相反）。
 *  needs 仍是 NULL 时 judge 还没写过这一行——列表页蓝点用的已经是 langs，
 *  详情若仍报 unjudged，同一份 chi 轨会一边「自带」一边「还没判定」。
 *  故 NULL 这一支与 aggregateDot 共用 fileHasEmbeddedTarget，不是第二套语言表。
 *
 *  【第三段 unjudged 兜底在最后】
 *  它是"系统答不上来"，只有在前面所有判据都不成立时才成立——这正是兜底的定义。
 *
 *  ── sub_status 的真实值域是怎么确认的（**不信 db.ts:555 的注释**）───────────────
 *  db.ts:555 写的是 `'missing'/'covered'/'embedded'/'unavailable'`，四个值里**三个是错的**：
 *  该列无 CHECK 约束，注释是 v29 时代照 episodes/movies 表抄来的、早已过期。
 *  grep 全部生产写入点（`UPDATE files SET ... sub_status`，排除测试）得到的实际值域：
 *    · daemonV2.ts:1603       → 'covered'                     （R24 扫描独占的磁盘事实）
 *    · subtitleScheduler.ts:326 → 'handoff_translate' | 'unsolvable'（满 7 次分流，:323 那行三元）
 *    · translateWorkerTask.ts:213/223 → 'unsolvable'           （翻译流判死 / 满次数）
 *    · daemonV2.ts:1011 / 1611、retarget.ts:119、db.ts:695 → NULL（复查闸放回 / 回退 / v33 迁移）
 *    · retarget.ts:116        → 'covered'                      （换语言按 sidecar_langs 重导）
 *    · daemonV2.ts:1249 的 INSERT 不写这一列 → 新行默认 NULL
 *  即 files.sub_status ∈ { NULL, 'covered', 'handoff_translate', 'unsolvable' }。
 *  注释里的 'missing'/'embedded'/'unavailable' 在 files 表上**没有任何生产写入点**：
 *  前两个只属于旧 episodes/movies 表（那两张表有 CHECK 约束，是另一套值域），
 *  'unavailable' 是被 D19/C44 废止的第五态，v33 迁移（db.ts:695）已把存量洗成 NULL。
 *
 *  故本函数**不为 'missing'/'embedded'/'unavailable' 写分支**：给一个生产永不出现的值
 *  安排一个态，就是在测试里造一份只有测试会走的代码路径。未知值一律落到最后的 unjudged
 *  兜底（见下）。 */
function classifyFileState(f: FileRow, target: string): Exclude<EpisodeState, 'absent'> {
  // 第一段：sub_status —— 这一行当前在流水线的哪个位置。
  if (f.sub_status === 'covered') return 'covered'
  if (f.sub_status === 'handoff_translate') return 'translating'
  if (f.sub_status === 'unsolvable') return 'unsolvable'
  // 非 NULL 的未知值 → 不往下走。该列无 CHECK 约束，将来加一种停牌态而忘了跟这里时，
  // 继续往下会拿 needs_subtitle 把它报成 'pending'（'···' = 系统正要去找字幕）——而它其实
  // 停在一个我们不认识的流水线位置上，很可能根本不在字幕工作台里。把未知说成已知就是病 B。
  // 落 unjudged（'?'）是唯一诚实的选择，也与 web/src/library/episodeState.ts:53 对未知
  // sub_status 走防御性兜底、不静默吞掉的既有口径同源。
  if (f.sub_status != null) return 'unjudged'

  // 第二段：judge 的判决（needs_subtitle）+ 理由（skip_reason）。
  // 判据用 needs_subtitle 而非"skip_reason 非空"：skip_reason 是 v40 才加的列（db.ts:1039），
  // **存量行在被重判之前这一列是 NULL**，而 needs_subtitle 从 v1 就在。以 reason 为准的话，
  // 滚更窗口里"判过但还没轮到重判"的行会全部落进 unjudged —— 那是把已知说成未知。
  //
  // ⚠️ 这里原先写着「生产实测 1192 行全 NULL」——**那是假数字，审计实测推翻**（2026-08-11）：
  //   skip_reason: origin-skip 808 / missing 212 / embedded 172，合计 1192，**一行 NULL 都没有**；
  //   needs_subtitle=0 且 skip_reason IS NULL 的行数 = 0。
  // 那个数字来自设计文档里一份写于 v40 迁移 + 一轮 judge 跑完之前的过期观察，被逐级照抄成了
  // "生产实测"。判据的选择本身没错（当前库上两种判据等价），但**支撑它的论据当时是编的**——
  // 记在这里，因为"把转述包装成实测"正是本仓的病 B。真论据是上面那条结构性理由，与行数无关。
  if (f.needs_subtitle === 0) {
    if (f.skip_reason === 'origin-skip') return 'origin-skip'
    if (f.skip_reason === 'embedded') return 'embedded'
    // 机械特典（2026-08-13 用户裁决）。与上面两个同族——needs=0 的三种理由，单值列互斥，
    // 三个 if 之间不存在优先级可言（同 A-2/A-3 审计对 origin-skip/embedded 的结论）。
    //
    // 🔴 判据走 isJudgedExtra（T2-a 收敛，2026-08-14）——这里原先自己写了一遍
    // `f.skip_reason === 'extra'`，与那个函数构成同一条判据的第二个定义点。
    // 「格子上标 ▭」与「不进 unplacedFileCount」必须同生同死，故共用同一个裁决者。
    if (isJudgedExtra(f)) return 'extra'
    // needs=0 但 reason 缺失/不认识（v40 之前判定的存量行；或将来新增了一种 reason 而这里
    // 忘了跟）。**不许猜**成 origin-skip 或 embedded：两者在换目标语言后的命运完全相反
    // （db.ts:983 的原话），猜错就是给用户一个与事实相反的 ◇/◆ 标记且无从察觉。
    // 落 unjudged（`?` = 系统答不上来）是唯一诚实的选择——它同时是"该重判了"的可见信号。
    return 'unjudged'
  }
  if (f.needs_subtitle === 1) return 'pending'

  // 第 8 态。sub_status IS NULL 且 needs_subtitle IS NULL：judge 还没写 skip_reason。
  // langs 已经证明有中文内嵌轨时，与列表页蓝点用同一份证据，不再把已知说成「还没判」。
  if (fileHasEmbeddedTarget(parseEmbeddedLangs(f.embedded_langs), target)) return 'embedded'
  return 'unjudged'
}

/** 一格（可能多份文件）的八态聚合。
 *
 *  🔴 与 aggregateDot 同源的 R-F2 条款：**任一份**最好的状态代表这一格。用户原话是两个
 *  「绝命毒师」目录只要有一处 S01E03 有字幕就算已获取——同一条口径必须覆盖到八态上，
 *  否则圆点说"已获取"而集号染色说"待处理"，同一张卡上两个控件自相矛盾。
 *
 *  取法 = 按下面那条**聚合序**取最靠前的那一份，而不是取第一行：取首行的实现会因入库
 *  顺序不同给出相反结论（aggregateDot 的注释里钉过同一个坑，那次是 `.some()` 治的）。
 *
 *  ⚠️⚠️ **聚合序 ≠ 分类链**（审计 A-4 抓到的 R-F2 违反，本仓第一次踩这个形态）：
 *
 *    分类链（classifyFileState）问的是「**这一份**处在流水线的哪个位置」，
 *    所以 sub_status 三态优先——它是持续变化的现状，盖过一次判完就不再动的 needs_subtitle。
 *
 *    聚合序问的是「**哪一份**代表这一格」，判据完全不同：**已解决 > 未解决**。
 *    origin-skip / embedded 是「压根不需要字幕」的**终态**，unsolvable / translating 是
 *    「还没搞定」的**流程态**。原先照抄分类链，把 unsolvable 排在了 embedded 前面，于是
 *    一份配不到字幕，就把另一份「压根不需要」的事实盖掉了——同一格上圆点说 blue（不需处理）、
 *    集号染色说 ⊘（无解），两个控件互相打脸。**这正是 R-F2 要防的形态，只是换了个控件。**
 *
 *    判据统一为：与 aggregateDot 的 `.some()` 同向——只要有一份「不用管了」，这一格就不用管了。
 *
 *  ⚠️⚠️ **`extra` 是这条口径的例外，它必须垫底**（审计抓到的 R-F2 同型复发，方向更糟）：
 *
 *    上面那条「有一份不用管 ⇒ 这一格不用管」对 covered / origin-skip / embedded 成立，
 *    因为那三个说的都是**关于这一格的**事实：「这一集已经有字幕了」「这一集的母语就是中文」
 *    「这一集自带内嵌轨」——任一份成立，这一集确实就不用管了。
 *
 *    `extra` 说的**不是**这种事实。它只说「**这一份文件**不算数」，推不出「这一格不用管」。
 *    把它排进已解决段（原先在第 4 档）会造出这个形态，审计用真代码造数据实测：
 *      同一格：一份 PV（skip_reason='extra'）+ 一份真需要字幕的正片（needs_subtitle=1）
 *      → episodeState = 'extra'，界面报「特典 · 不找字幕」，
 *        而那份**正在排队等找字幕的正片被完全盖掉**。
 *    与 A-4 那两条锁（unsolvable 盖住 embedded）逐字同形，但方向反过来、**更糟**：
 *    A-4 被盖掉的是「已解决」的事实（顶多让人多看一眼），这里被盖掉的是**未解决**的事实
 *    ——用户永远不会去点开那一格，那集字幕永远不会有人管。
 *    电影分支尤其危险：aggregateDot 把一部电影的**全部**文件聚成一格，
 *    一个 `Trailer.mkv` 就能让正片从界面上消失。
 *
 *    正确的判据：**只有当这一格的全部文件都是 extra 时，这一格才该报 extra**。
 *    把 extra 放在序列**最末**恰好精确等价于这句话——取最小 rank 的聚合下，
  *    extra 胜出 ⟺ 没有任何一份文件的 rank 更小 ⟺ 每一份都是 extra。不需要特判。
 *
 *  ── 🔴 前端图例顺序钉在这条序列上（T2-b，2026-08-14）─────────────────────────
 *  `web/src/media/episodeStateMeta.ts` 的 `LEGEND_STATES` 必须与本序列**逐位相同**
 *  （图例顺序 = 聚合优先级顺序：用户在图例里看到的先后，就是同一格多份文件时谁代表
 *  这一格的先后）。此前这条约束只写在两侧注释里，改一边忘另一边不会有人红。
 *  现在由 `web/src/api/typeContract.ts` 的 `C_LegendOrder` 在**编译期**对拍
 *  （`cd web && npx tsc --noEmit`），凭据就是下面这个 `as const` 定长元组——
 *  它一旦退化成 `string[]`，位置信息就没了，那条契约会静默失效。所以 `as const` 不许删。
 */
const STATE_RANK = [
  // ── 已解决（这一格不需要人再操心）──────────────────────────────────────────
  'covered',      // 有外挂字幕（R24 磁盘事实，与 .some() 同向）
  'origin-skip',  // 母语即目标语言，压根不需要字幕
  'embedded',     // 已有内嵌目标语言轨
  // ── 未解决（还在流水线上 / 卡住了）─────────────────────────────────────────
  'translating',  // 在翻译台上
  'unsolvable',   // 配不到也翻不了
  'pending',      // 排队等找
  'unjudged',     // 系统还答不上来
  // ── 「这一份不算数」——不是关于这一格的事实，故垫底（见上方那段论证）───────────
  'extra',        // 机械特典。只有**全部**文件都是 extra，这一格才报 extra
] as const satisfies readonly Exclude<EpisodeState, 'absent'>[]

/** 聚合序的**元组类型**（含位置信息），供前端 typeContract.ts 对拍图例顺序（T2-b）。
 *
 *  为什么导出 type 而不是让前端 import STATE_RANK 这个值：前端只需要在编译期读到
 *  "第 n 位是哪个态"，`import type` 会被完整擦除，不把后端代码拖进 bundle
 *  （typeContract.ts 头注释里那条实测：产物字节级不变）。导出值给前端则会在 web 侧
 *  制造一条真实的运行时依赖，且 Docker 的 web 构建阶段根本没有 `../src`。 */
export type StateRankOrder = typeof STATE_RANK

/** 同一条序列的**值**，仅供后端测试（legendOrder.contract.test.ts）做运行时逐位对拍。
 *
 *  为什么不直接导出 STATE_RANK：那个名字是本模块的内部实现，导出它会让"聚合序"看起来
 *  像是可供别处消费的公开资产（本仓病 A 的温床——导出即邀请调用）。这个别名把用途
 *  写进名字里：**for contract**，除了那条契约测试没有第二个消费者。
 *  ⚠️ 前端**不许** import 它（运行时依赖 + Docker 阶段无 ../src），前端那侧走上面的 type。 */
export const STATE_RANK_FOR_CONTRACT: StateRankOrder = STATE_RANK

function aggregateState(files: readonly FileRow[], target: string): EpisodeState {
  // 零文件 → 'absent'（审计 A-6）。这一格磁盘上什么都没有，不是"系统还没判它"。
  // 走得到这里的真实路径：buildMediaLibraryDetail 的电影分支是 `FROM works WHERE id = ?`，
  // **没有列表页那个 INNER JOIN files**，所以按 workId 直接打详情端点就能拿到空壳 works。
  // 原先落进下面的兜底返回 unjudged，把 absent 说成 unjudged——病 B 的形态。
  if (files.length === 0) return 'absent'
  // 初值取 STATE_RANK.length（**越界哨兵**，不是 length-1）：写成 length-1 时，"初值"
  // 与"序列最后一个态"是同一个下标，于是垫底那一态究竟是被文件选中的、还是根本没人选中
  // 时的默认值，两种情形无法分辨。extra 移到垫底之后这一点会真的咬人——空循环会静默
  // 返回 'extra'（"这一格全是特典"），而它其实什么都没判。哨兵让它变成显式的不可达分支。
  // RANK = STATE_RANK 的**放宽视图**。`as const` 让 STATE_RANK 成为定长元组（穷尽守卫
  // 需要那个字面量类型），而定长元组上的 indexOf 只接受元组成员、下标也被收成字面量联合
  // ——哨兵 `length` 会当场类型错误。放宽一次，本函数内统一用它。
  const RANK: readonly Exclude<EpisodeState, 'absent'>[] = STATE_RANK
  let best = RANK.length
  for (const f of files) {
    const rank = RANK.indexOf(classifyFileState(f, target))
    if (rank < best) best = rank
  }
  // files 非空 + classifyFileState 的返回类型被 STATE_RANK 穷尽覆盖 ⇒ best 必然已被赋值。
  // 兜底成 unjudged（"系统答不上来"）而不是 extra：万一将来加了第十态而忘了进 STATE_RANK，
  // indexOf 给 -1 会被上面的 `< best` 收下（-1 最小）——那是另一个坑，由下方穷尽守卫挡。
  return RANK[best] ?? 'unjudged'
}

/** 编译期穷尽守卫：`EpisodeState` 加了新态而忘了排进 STATE_RANK → tsc 立刻红。
 *
 *  为什么需要它：aggregateState 用 `indexOf` 定位，漏排的态会拿到 **-1**，而 -1 比任何
 *  真实 rank 都小 ⇒ 那个态会**无条件赢下每一格**，且 `STATE_RANK[-1]` 是 undefined。
 *  这是纯运行期故障，测试不特意造那个态就永远绿。extra 这次的教训正是"新态进了序列但
 *  位置错了"——位置对不对没法让编译器管，**在不在序列里**可以，那就至少把这一半钉死。
 *
 *  ⚠️ 写法有讲究，第一版写成 `Object.fromEntries(...) as Record<...>` 是**假守卫**
 *  （变异实测：把 extra 整条从序列删掉，tsc 照样退出码 0）——`Object.fromEntries` 的返回
 *  类型是 `{[k:string]:T}`，字面量信息在那一步就全丢了，末尾的 `as` 再把剩下的检查也压掉。
 *  真守卫必须让**字面量元组**直接参与类型运算：STATE_RANK 上的 `as const satisfies`
 *  锁住"每个元素都是合法态"，下面这个 never 赋值锁住"每个态都在元组里"，两个方向缺一不可。
 *  （赋给 `never[]` 之类也不行——空数组对任何数组类型都成立，同样是假守卫。） */
type _MissingFromStateRank = Exclude<Exclude<EpisodeState, 'absent'>, typeof STATE_RANK[number]>
const _stateRankExhaustive: never = undefined as unknown as _MissingFromStateRank
void _stateRankExhaustive

// ---- R-F2「不管来源」的聚合 ----

/** 一格（一集，或电影的那一格）在**聚合后**的字幕事实。 */
interface DotAggregate {
  /** 该格下的文件份数（同一集在两个目录各一份 → 2）。 */
  fileCount: number
  /** 其中有外挂中文 sidecar 的份数（R-F2 原话"另一处那份仍要单独去配"的可见依据）。 */
  subtitledFileCount: number
  dot: SubtitleDot
  /** 八态（R-F12）。与 dot 走**同一条** R-F2「任一份算」口径，只是判据更细，见 aggregateState。
   *
   *  两条路径会得到 'absent'：① 剧集的虚线格由调用方直接覆盖成 'absent'（这里拿不到 onDisk）；
   *  ② **零文件的电影格**——详情端点没有列表页那个 INNER JOIN，空壳 works 打得进来（审计 A-6）。
   *  故这里不能收窄成 Exclude<..., 'absent'>。 */
  episodeState: EpisodeState
}

/** 🔴 R-F2 防猴子用户核心条款：**任一份**有字幕 → 该格算已获取。
 *
 *  用户原话：两个「绝命毒师」目录，只要有一处 S01E03 有字幕，媒体库就显示这一集已获取
 *  ——即使另一处那份仍要单独去配。合并键 = work_id（TMDB id）。
 *
 *  实现要点（每一条都有用例钉着）：
 *   · 用 `.some()` 跨该格的**全部**文件求或，绝不能取"第一行"——取首行的实现会因入库
 *     顺序不同给出相反结论，而测试若恰好按"有字幕的在前"写就永远绿。
 *   · 绿点优先于蓝点：外挂那份是用户能换能删的可操作对象，内嵌轨不是。
 *   · fileCount / subtitledFileCount 如实呈报，"另一处仍要单独去配"这个事实不许被聚合吞掉。
 *
 *  ── fileCount 会不会把特典算进"这一格有几份"？（2026-08-14 实测裁决：不会，不修）──
 *
 *  滚动债务清单里挂过一条「fileCount 未随 extra 调整，用户会看到电影格 fileCount=2 而
 *  其中一份是 Trailer」。**实测证伪**：生产 16 个 `skip_reason='extra'` 的文件，
 *  解析出集号的是 **0 个**，全部 `episode IS NULL` → 一个都进不了网格 → 进不了这个聚合。
 *
 *  这不是巧合，是两档标记表（extrasFilter.ts）的结构后果：
 *   · `NCOP/NCED` 这类压制圈行话，命名里本就不带季集号（`[NCOP][1080P]...`）；
 *   · `[PV]/[menu]` 这类必须方括号包裹的普通词，同样出现在无季集号的花絮文件上。
 *  也就是说「被判特典」与「解析出季集」在现有规则下几乎互斥。
 *
 *  ⚠️ 但这是**规则的后果、不是不变量**。反例形态已经在生产里躺着：
 *      `[DBD-Raws][...S1][25][Commentary][...].mkv`  ← 正片集号 + 特典性质标记并存
 *  它今天没被判特典（`Commentary` 不在铁案表里），一旦哪天进表，这一格就会
 *  `fileCount=2` 而其中一份是评论音轨。
 *
 *  所以判据是：**在特典能带季集号之前，这里不需要过滤**。真要修的那天，
 *  要先想清楚 fileCount 到底该回答哪个问题——"这一格有几份文件"（如实报数，
 *  用户点开能看到那份 Commentary）还是"这一格有几份要管的"（过滤，但用户会
 *  发现数字与展开后的列表对不上）。两个都自洽，别在没有真实用户困惑时先选一个。 */
function aggregateDot(files: readonly FileRow[], target: string): DotAggregate {
  const subtitledFileCount = files.filter((f) => fileHasSidecar(f.sub_status)).length
  const anyEmbedded = files.some((f) => fileHasEmbeddedTarget(parseEmbeddedLangs(f.embedded_langs), target))
  const dot: SubtitleDot = subtitledFileCount > 0 ? 'green' : anyEmbedded ? 'blue' : 'none'
  return { fileCount: files.length, subtitledFileCount, dot, episodeState: aggregateState(files, target) }
}

// ---- 行形状 ----

interface WorkRow {
  id: string
  title: string
  year: number | null
  media_type: string
  poster_path: string | null
  chinese_titles: string | null
}

interface FileRow {
  work_id: string
  season: number | null
  episode: number | null
  /** 详情电影格才 SELECT；列表查询没有这一列。 */
  filename?: string
  sub_status: string | null
  embedded_langs: string | null
  /** NULL=judge 还没判（谓词 `needs_subtitle IS NULL`）/ 0=不需要 / 1=需要。
   *  SQLite 存的是 INTEGER，读出来就是 number|null——**不要**在判据里用真值性
   *  （`if (f.needs_subtitle)` 会把 0 和 NULL 判成同一件事，而它们是完全相反的两个态）。 */
  needs_subtitle: number | null
  /** judgeSubtitle 的 verdict.reason 原值：'origin-skip'/'embedded'/'missing'（v40 加的列，
   *  db.ts:997 定义了它的三件事）。存量行为 NULL——那是"判的时候还没这一列"，不是 judge 没判。 */
  skip_reason: string | null
}

/** `works.chinese_titles` 是 JSON 数组（中文译名变体）；取首个作为展示名。
 *  坏 JSON / 空数组 / NULL → null（前端回落到 title）。 */
function firstChineseTitle(raw: string | null): string | null {
  if (raw == null) return null
  try {
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr) && typeof arr[0] === 'string' && arr[0] !== '' ? arr[0] : null
  } catch {
    return null
  }
}

/** 只有 tv/movie 两种；库里理论上不会有别的，防御性收敛到 'tv'。 */
function mediaTypeOf(raw: string): 'tv' | 'movie' {
  return raw === 'movie' ? 'movie' : 'tv'
}

/** 一集的分组键。season/episode 均非空才成格 —— 见 buildMediaLibraryDetail 的 unplaced 说明。 */
const epKey = (season: number, episode: number): string => `${season}\u0000${episode}`

/** 这一行是否是 judge 判定的机械特典（`skip_reason='extra'`，2026-08-13 用户裁决）。
 *
 *  🔴 **本文件里这条判据的唯一定义点**（T2-a，2026-08-14 收敛）。三个消费点全部调它：
 *    · classifyFileState  → episodeState='extra'，格子上画 ▭「特典 · 不找字幕」
 *    · buildMediaLibrary  → 从列表页 unplacedFileCount 里扣除
 *    · buildMediaLibraryDetail → 从详情页 unplacedFileCount 里扣除
 *
 *  ── 收敛前是什么样、为什么那是真故障（不是洁癖）───────────────────────────────
 *  这个函数的头注释此前写着「两处各写一遍 `f.skip_reason === 'extra'` 是 C30 的原型」，
 *  指的是两个 unplaced 消费点——那一半确实已经收敛。但它**自己就是第二份**：
 *  classifyFileState 里另有一行 `if (f.skip_reason === 'extra') return 'extra'`。
 *  也就是说判据在同一个文件里有两个定义点，分别喂给两个**必须互相自洽**的控件：
 *  「格子上标了 ▭」与「不计入待办数」是同一条裁决（用户原话「不值得为它增加心智负担」）
 *  的一体两面。加判据时改一处忘一处，用户就会看到一个格子标着 ▭ 说"系统不管它"、
 *  而概览数字同时把它算进"解析器没能归位的真实文件"催他去改名——两个控件对同一份文件
 *  说相反的话，正是 unplacedFileCount 这个字段当初被引入所要修的那条自相矛盾。
 *
 *  ── 入参刻意收窄成 `{ skip_reason }`，不是整个 FileRow ──────────────────────
 *  判据读什么，签名就写什么。收窄之后"这条判据不看 needs_subtitle"从一句注释变成
 *  **编译器管着的事实**：有人想加 `&& f.needs_subtitle === 0` 时得先改签名，
 *  那一步会逼他到这里读完下面这段论证。同时它让判据可以脱离数据库单独被测。
 *
 *  🔴 判据**不看 needs_subtitle**：skip_reason 是单值列，只有 judge 会写它，
 *  写 'extra' 的那一条分支必然同时写 needs_subtitle=0（同一条 UPDATE，daemonV2.ts:1092
 *  ——那条 UPDATE 刻意合并的理由见其头注释：分两条会在掉电时留下永不重判的行）。
 *  再加一条 `&& needs_subtitle === 0` 是冗余守卫，且会在"judge 写了一半掉电"这种
 *  本来就不可能的形态上制造第二种行为。
 *
 *  ⚠️ 导出仅供 extraCriterion.singleSource.test.ts 的真值表用（判据的行为规格）。
 *  它不是 DTO 的一部分，不要在 dashboard 之外调用。 */
export function isJudgedExtra(f: { skip_reason: string | null }): boolean {
  return f.skip_reason === 'extra'
}

// ---- 列表页 ----

export interface MediaLibraryItemDTO {
  /** works.id（'tmdb:<id>'）。**这就是详情页的路由 id**，也是 R-F2 的合并键。 */
  workId: string
  title: string
  /** works.chinese_titles 的首个译名；无则 null（前端回落 title）。 */
  chineseTitle: string | null
  year: number | null
  /** TMDB poster_path（如 '/abc.jpg'），前端自拼 image.tmdb.org 前缀；无海报 null。 */
  posterPath: string | null
  mediaType: 'tv' | 'movie'
  /** 应有集数 = tmdb_seasons 行数（R-F5）。**电影恒 0**（没有季集）；
   *  剧集为 0 表示该剧的应有集缓存还没回填 —— 不是"这剧只有 0 集"。 */
  expectedEpisodeCount: number
  /** 实有集数 = 磁盘上有文件的**去重后**集数（同一集两份文件只算 1）。
   *  电影是文件份数去重后的格数（恒 0 或 1）。 */
  onDiskEpisodeCount: number
  /** 虚线卡片数 = max(0, 应有 - 实有)。
   *  夹 0 是必需的：应有集缓存缺失（expected=0）而磁盘有 12 集时，裸减法得 -12，
   *  前端会显示"缺 -12 集"。 */
  missingEpisodeCount: number
  /** **外挂**中文字幕（sidecar）已就位的格数 —— 「已配」。
   *
   *  🔴 判据 = 该格聚合后 `dot === 'green'`，等价于详情页 `subtitledFileCount > 0`
   *  （aggregateDot 里 green 的定义就是它）。**这条等价是跨页一致性的凭据**，
   *  由 mediaLibraryApi.test.ts 的「列表页 subtitledEpisodeCount === 详情页
   *  subtitledFileCount>0 的格数」用例钉住。
   *
   *  ── 🔴 2026-08-14 语义修正：内嵌轨**不再**计入（用户裁决③「分开显示」）────────
   *  此前判据是 `aggregateDot(rows).dot !== 'none'`，把 green（外挂 sidecar）与
   *  blue（内嵌轨）算成了同一件事。生产实测 53/75 部作品命中，最刺眼的形态：
   *  《翘楚》(tmdb:289271) 列表页说「已配 5」，点进详情 24 格**全是**「原生语言不需要
   *  字幕」，库里外挂 sidecar 是 **0** 个 —— 那 5 集是片源自带的内嵌轨。
   *
   *  为什么这是真错而不是口径之争：本字段的定义（本文件头注释:17）写的是
   *  「已**获取**中文字幕的集数」。内嵌轨不是获取来的 —— 磁盘上没有任何一份可换可删的
   *  字幕文件，系统也从没为它做过一件事。把它算进"已配"，用户看到的就是一份**我们并
   *  没有做过的工作**的成绩单，而详情页同时告诉他这 24 集我们一份都没配。
   *
   *  ── 为什么是「改语义」而不是「加新字段、旧字段维持原样」────────────────────
   *  旧语义（green+blue 的合计）在任何一个页面上都**没有消费者需要它**：详情页从来只数
   *  sidecar（subtitledFileCount），列表页的字段名与定义注释说的也是"已获取"。
   *  也就是说旧值不是"另一种正确口径"，它就是这个字段一直以来的**错误实现**。
   *  保留它需要再起一个名字（`subtitledOrEmbeddedEpisodeCount` 之类），那会在 DTO 里
   *  留下一个"名字对、没人读、且与另外两个数恒等"的第三个计数 —— 本仓病 A 的温床。
   *  语义修正的代价（下游静默变小）由下面这条兜住：**唯一的读取方**是
   *  MediaLibraryPage 的 coverageParts（全仓 grep 只此一处生产读取点），
   *  且它同屏渲染新增的 embeddedEpisodeCount —— 数字变小的同时旁边就出现了差额去处。 */
  subtitledEpisodeCount: number
  /** **内嵌**中文轨（片源自带）的格数 —— 「自带」。
   *
   *  🔴 判据 = 该格聚合后 `dot === 'blue'`。与上面那个字段**互斥**（green 优先于 blue，
   *  aggregateDot 的既有裁决：外挂那份是用户能换能删的可操作对象，内嵌轨不是）。
   *  互斥是这两个数**可加**的前提：不互斥的话，一格同时有外挂与内嵌就会被数两次，
   *  卡片上出现 `已配 3 · 自带 3 · 磁盘 3`，用户当场看出至少有一个数是假的。
   *
   *  故恒有 `subtitledEpisodeCount + embeddedEpisodeCount ≤ onDiskEpisodeCount`。
   *  完整的就绪分子由 `readyEpisodeCount` 返回；它额外包含没有字幕轨也不需要处理的
   *  `originLanguageEpisodeCount`，因此前端不许再用前两个数自行相加。
   *
   *  ⚠️ 它**不是**待办：内嵌轨意味着这一集不需要人操心（judge 会给 needs_subtitle=0），
   *  前端据此在 `> 0` 时才渲染（沉默即好消息），绝不恒挂一个"自带 0"。 */
  embeddedEpisodeCount: number
  /** 原生语言就是目标语言、且没有外挂或内嵌目标语言轨的格数 —— 「原生」。
   *
   *  与 `embeddedEpisodeCount` 刻意互斥：生产里 judge 的 `origin-skip` 可能同时存在
   *  `embedded_langs=['eng']`（例如德里镇 7 集、和平使者 S2 8 集），但列表的展示分区
   *  必须优先呈现更具体的"确有内嵌轨"事实；只有 dot='none' 的 origin-skip 格才进这里。
   *  这样「自带」仍然只表示真实的内嵌字幕轨，「原生」表示不需要字幕这个独立事实。 */
  originLanguageEpisodeCount: number
  /** 本地格里已就绪的格数 = 已下载 + 自带 + 原生。**后端直接返回**，前端不重算。 */
  readyEpisodeCount: number
  /** 本地格里既无外挂、无自带、也非原生目标语言的格数 = max(0, onDisk − ready)。
   *  海报卡黄字只读这个，不读 missingEpisodeCount。 */
  uncoveredEpisodeCount: number
  /** 属于本作品、但 `season/episode` 解析不出因而**进不了季集网格**的文件数，
   *  **已扣除机械特典**。电影恒 0（电影的文件本来就不该有季集，它们全部落进那唯一一格）。
   *
   *  🔴 2026-08-13 新增，与详情页的同名字段**同一口径**（两页同一个数）。这是修复
   *  「同一部剧，列表说磁盘 78 / 缺 7，详情说磁盘 77 / 缺 8」那条自相矛盾的另一半：
   *  此前这些文件被塞进一个 key 为 `''` 的**假格**，于是 67 个文件给 `cells.size`
   *  贡献 +1（列表页多算一集），而详情页按 `tmdb_seasons` 逐格铺、它们一个都进不去。
   *  两页对同一部剧给出的"磁盘上有几集"必然差 1。
   *
   *  现在它们**不进任何格**、只在这里如实计数。为什么不算进"磁盘上有几集"：
   *   · 算术上讲不通：`missingEpisodeCount = expected - onDisk`，而 expected 来自
   *     `tmdb_seasons`——这些文件**不在 TMDB 的集表里**。把它们计进 onDisk 就是拿分母里
   *     没有的东西去减分母，一部有 67 个此类文件的剧会被算成"倒欠 67 集"（夹 0 掩盖了
   *     负号，但"缺几集"这个结论已经错了）。
   *   · 反过来"直接丢掉不报"同样不行：解析器**会**在正常剧集上失败，丢掉的话用户看不出
   *     "有文件没进网格"，会以为系统把文件弄丢了。故：不计入集数，但**数出来**。
   *
   *  ── 🔴 为什么要扣除机械特典（2026-08-13 用户裁决「不值得为它增加心智负担」）──────
   *  此前这个数把特典与解析失败**混成一个数**。生产实测 Re:ZERO 报 67，其中
   *  **16 个是 NCOP/NCED/PV/menu**（我们**主动**决定不管它们，见 subtitleJudge 规则 0）、
   *  51 个是解析器在真剧集上失败。一个数同时表达"系统故意不管的"与"系统没搞定的"，
   *  用户无从分辨，而前者根本不需要他动一根手指——那正是用户说的"占脑子"。
   *
   *  扣除之后这个数只剩**一种**含义：「解析器没能归位的真实文件」，且**可行动**
   *  （改文件名即可修好，对所有下游工具都生效）。特典不在其中，因为它们不是"没搞定"，
   *  是"不算数"——它们的去处是季集网格里那个 ▭ 标记（episodeState='extra'），
   *  在**格子层面**如实可见，并没有被藏掉。
   *
   *  ⚠️ 判据是 `skip_reason='extra'`（judge 的判决）而**不是**在这里重跑一次
   *  `isMechanicalExtra(filename)`：后者是第二份判据，改 EXTRA_MARKERS 那天两处必然漂移
   *  （C30 的原型），且这一层压根没有 filename 列可读。代价是 judge 还没轮到的行会短暂
   *  被算进 unplaced——那是诚实的"还没判"，不是错。 */
  unplacedFileCount: number
}

/** GET /api/v2/mediaLibrary：海报墙列表。
 *
 *  🔴 R-F2「识别失败的孤儿不露出」：`files.work_id IS NULL` 的行在 SQL 谓词层就被滤掉
 *  （INNER JOIN works + work_id NOT NULL），不进任何聚合。那是用户的命名问题，
 *  底线是按 `title (year)` 命名。
 *
 *  🔴 用 INNER JOIN 而非 LEFT JOIN：一个文件都没有的 works 行（用户移除了守备目录后
 *  残留的空壳）不该在海报墙上冒出一张空卡片 —— 媒体库页描述的是"磁盘上有什么"。 */
export function buildMediaLibrary(db: ScoutDb, targetLanguage: string = 'zh'): MediaLibraryItemDTO[] {
  const works = db
    .prepare(
      `SELECT DISTINCT w.id, w.title, w.year, w.media_type, w.poster_path, w.chinese_titles
       FROM works w JOIN files f ON f.work_id = w.id
       WHERE f.work_id IS NOT NULL
       ORDER BY w.title ASC, w.id ASC`,
    )
    .all() as WorkRow[]
  if (works.length === 0) return []

  const files = db
    .prepare(
      `SELECT work_id, season, episode, sub_status, embedded_langs, needs_subtitle, skip_reason
       FROM files WHERE work_id IS NOT NULL`,
    )
    .all() as FileRow[]

  const expectedByWork = new Map<string, number>()
  for (const r of db
    .prepare(`SELECT series_id, COUNT(*) AS n FROM tmdb_seasons GROUP BY series_id`)
    .all() as { series_id: string; n: number }[]) {
    expectedByWork.set(r.series_id, r.n)
  }

  // work → 格键 → 该格的文件们。
  //
  // 🔴 2026-08-13：**剧集**里 season/episode 解析不出的文件**不再进任何格**。
  // 旧实现把它们全塞进 key 为 `''` 的一格，于是无论 1 个还是 67 个都 `cells.size` +1
  // —— 列表页因此比详情页多算一集（详情页按 tmdb_seasons 逐格铺，它们进不去）。
  // 完整论证见 MediaLibraryItemDTO.unplacedFileCount。
  //
  // 🔴 2026-08-13（同日、第二处裁决）：机械特典**不进 unplaced 计数**。判据是
  // `skip_reason='extra'`（judge 的判决，不在这里重跑正则——见那个字段的注释）。
  // 它们既不进格、也不被数——因为它们不是"系统没搞定"，是"系统故意不管"。
  //
  // ⚠️ **电影例外**：电影的文件本来就没有季集，`''` 对它们不是"解析失败"而是正常形态
  // （详情页的电影分支也是把全部文件聚成一格：`aggregateDot(files)`）。两页在电影上
  // 一直是一致的，这次改动不许碰它——故这里按 media_type 分流，而不是一刀切按 NULL 判。
  const mediaTypeById = new Map(works.map((w) => [w.id, mediaTypeOf(w.media_type)]))
  const cellsByWork = new Map<string, Map<string, FileRow[]>>()
  const unplacedByWork = new Map<string, number>()
  for (const f of files) {
    const placed = f.season != null && f.episode != null
    if (!placed && mediaTypeById.get(f.work_id) !== 'movie') {
      if (!isJudgedExtra(f)) {
        unplacedByWork.set(f.work_id, (unplacedByWork.get(f.work_id) ?? 0) + 1)
      }
      continue
    }
    const key = placed ? epKey(f.season!, f.episode!) : ''
    let cells = cellsByWork.get(f.work_id)
    if (!cells) { cells = new Map(); cellsByWork.set(f.work_id, cells) }
    const bucket = cells.get(key)
    if (bucket) bucket.push(f)
    else cells.set(key, [f])
  }

  return works.map((w) => {
    const cells = cellsByWork.get(w.id) ?? new Map<string, FileRow[]>()
    const expected = expectedByWork.get(w.id) ?? 0
    // 🔴 去重后的格数，不是 files 行数：两个目录各一份的库，COUNT(*) 会把"实有 1 集"
    // 报成 2 集，进而算出负的缺集数（missing 的夹 0 会掩盖它，但概览数字就已经错了）。
    const onDisk = cells.size
    // 🔴 2026-08-14（用户裁决③）：外挂与内嵌**分开计数**，不再用 `dot !== 'none'` 混算。
    //   · subtitled = dot 'green'（外挂 sidecar 就位）→ 等价于详情页 `subtitledFileCount > 0`，
    //     这条等价就是跨页一致性的凭据（同名用例钉住）。
    //   · embedded  = dot 'blue'（内嵌轨，片源自带；green 优先于 blue，故两者互斥不重叠）。
    // 互斥来自 aggregateDot 的三态本身：green/blue/none 三选一，所以外挂与内嵌两个计数
    // 不会重复；ready 再把 dot='none' 且 origin-skip 的原生语言格纳入完整分子。
    const aggregates = [...cells.values()].map((rows) => aggregateDot(rows, targetLanguage))
    const subtitled = aggregates.filter((a) => a.dot === 'green').length
    const embedded = aggregates.filter((a) => a.dot === 'blue').length
    // 🔴 2026-08-19（Young Sheldon / Derry / Peacemaker 实案）：origin-skip 不能只从
    // uncovered 中扣掉，还必须成为列表分子，否则会出现「0/16」或「7/8」这种看似缺字幕的卡片。
    // 但 origin-skip 与 embedded_langs 在生产中可以同时存在：列表按更具体的 dot 事实分桶，
    // 只有 dot='none' 的 origin-skip 才算「原生」，保证 downloaded/built-in/native 三者互斥。
    const originLanguage = aggregates.filter(
      (a) => a.dot === 'none' && a.episodeState === 'origin-skip',
    ).length
    const ready = subtitled + embedded + originLanguage
    return {
      workId: w.id,
      title: w.title,
      chineseTitle: firstChineseTitle(w.chinese_titles),
      year: w.year,
      posterPath: w.poster_path,
      mediaType: mediaTypeOf(w.media_type),
      expectedEpisodeCount: expected,
      onDiskEpisodeCount: onDisk,
      missingEpisodeCount: Math.max(0, expected - onDisk),
      subtitledEpisodeCount: subtitled,
      embeddedEpisodeCount: embedded,
      originLanguageEpisodeCount: originLanguage,
      readyEpisodeCount: ready,
      uncoveredEpisodeCount: Math.max(0, onDisk - ready),
      unplacedFileCount: unplacedByWork.get(w.id) ?? 0,
    }
  })
}

// ---- 详情页（季集网格）----

export interface MediaLibraryEpisodeDTO {
  episode: number
  /** 应有集带来的集标题（tmdb_seasons.title）；只在磁盘上有、应有集里没有时为 null。 */
  title: string | null
  /** **实线 vs 虚线的唯一判据**（R-F2）：true=磁盘上真有文件（实线）；
   *  false=TMDB 说这季有、磁盘上没有（虚线）。 */
  onDisk: boolean
  /** 圆点三态。onDisk=false 时恒 'none'（没有文件就没有字幕事实）。 */
  dot: SubtitleDot
  /** R-F12 集号染色的**唯一**判据（八态，优先级链已在后端算完，见 classifyFileState）。
   *  onDisk=false 时恒 'absent'（虚线格不染色）。
   *  与 `dot` **刻意共存而不互相推导**：dot 回答"有没有中文字幕"（三态，列表页海报卡与
   *  电影格共用），episodeState 回答"这一集现在处在什么状态"（八态，只服务集号染色）。
   *  前者是后者的有损投影（covered→green、embedded→blue、其余五态→none），反向推不回来。 */
  episodeState: EpisodeState
  /** 该集在磁盘上的文件份数（同一集在两个目录各一份 → 2）。虚线格为 0。 */
  fileCount: number
  /** 其中有外挂中文 sidecar 的份数。R-F2「另一处那份仍要单独去配」的可见依据：
   *  `subtitledFileCount < fileCount` 即"还有份没配上"。 */
  subtitledFileCount: number
}

export interface MediaLibrarySeasonDTO {
  season: number
  /** 应有 ∪ 实有的并集，按集号升序。 */
  episodes: MediaLibraryEpisodeDTO[]
}

/** 电影那一格（剧集恒 null）。 */
export interface MediaLibraryMovieDTO {
  dot: SubtitleDot
  /** 同 MediaLibraryEpisodeDTO.episodeState 的八态口径。
   *
   *  ⚠️ 这里原先写着「电影那一格**恒有文件**，故不会是 'absent'」——**审计 A-6 证伪**：
   *  那条推理只对**列表页**成立（buildMediaLibrary 用 INNER JOIN files 滤掉了空壳 works）。
   *  详情页是 `FROM works WHERE id = ?`，按 workId 直接打就能拿到零文件的 movie，
   *  此时这里就是 'absent'。前端不许假设电影格必有文件。 */
  episodeState: EpisodeState
  fileCount: number
  subtitledFileCount: number
  /** 磁盘文件名。零文件或一份以上时为 null（多份时文件名不是这一格能说清的事）。 */
  filename: string | null
}

export interface MediaLibraryDetailDTO {
  work: {
    workId: string
    title: string
    chineseTitle: string | null
    year: number | null
    posterPath: string | null
    mediaType: 'tv' | 'movie'
  }
  /** 季集网格。**电影恒空数组**（R-F5：电影没有季集）。 */
  seasons: MediaLibrarySeasonDTO[]
  /** 电影那一格；剧集恒 null。 */
  movie: MediaLibraryMovieDTO | null
  /** 属于本作品、但 season/episode 解析不出因而进不了季集网格的文件数，
   *  **已扣除机械特典**（`skip_reason='extra'`）。
   *  **必须如实报**：不报的话用户看不出"有文件没进网格"，会以为系统把文件弄丢了；
   *  而按 NULL 分组又会造出一个 season=null 的幽灵季。电影恒 0
   *  （电影的文件本来就不该有季集，它们全部落进 movie 那一格）。
   *
   *  🔴 2026-08-13：与 `MediaLibraryItemDTO.unplacedFileCount` **同一口径、同一个数**
   *  （判据共用 `isJudgedExtra`）。此前只有详情页有这个字段，列表页把同一批文件塞进
   *  一个假格算进 onDisk——两页对同一部剧的"磁盘上有几集"差 1。
   *  扣除特典的完整论证在列表页那个字段的注释里。
   *
   *  ⚠️ 判据是 `season IS NULL OR episode IS NULL`，**不是** `parse_confidence='none'`
   *  （此前这里写的是后者，与代码不符——代码从来读的都是前两列）。两者高度相关但不等价：
   *  confidence='low' 的行照样可能有季集号，而 confidence 列在存量行上是 NULL。 */
  unplacedFileCount: number
}

/** GET /api/v2/mediaLibrary/:workId：季集网格详情。作品不存在 → null（404 语义）。
 *
 *  三份数据的合并：
 *   ① 应有集 —— tmdb_seasons（R-F5）。缺失时**优雅降级**：只显示实有集，不崩、不吞数据
 *      （某部剧还没被 boot 回填 pass 轮到时就是这个状态，是常态不是异常）。
 *   ② 实有集 —— files（work_id = 本作品）。
 *   ③ 字幕事实 —— 按 R-F2 逐格聚合（见 aggregateDot）。
 *
 *  季号取**应有 ∪ 实有**的并集：磁盘上有第 3 季而 TMDB 只缓存了第 1 季时（或反之），
 *  两边都不许丢。 */
export function buildMediaLibraryDetail(db: ScoutDb, workId: string, targetLanguage: string = 'zh'): MediaLibraryDetailDTO | null {
  const w = db
    .prepare(
      `SELECT id, title, year, media_type, poster_path, chinese_titles FROM works WHERE id = ?`,
    )
    .get(workId) as WorkRow | undefined
  if (!w) return null

  const files = db
    .prepare(
      `SELECT work_id, season, episode, filename, sub_status, embedded_langs, needs_subtitle, skip_reason
       FROM files WHERE work_id = ?`,
    )
    .all(workId) as FileRow[]

  const work = {
    workId: w.id,
    title: w.title,
    chineseTitle: firstChineseTitle(w.chinese_titles),
    year: w.year,
    posterPath: w.poster_path,
    mediaType: mediaTypeOf(w.media_type),
  }

  // 电影：没有季集网格，只有"有没有字幕"这一格（R-F2 同样按任一份算）。
  if (work.mediaType === 'movie') {
    const agg = aggregateDot(files, targetLanguage)
    return {
      work, seasons: [],
      movie: { ...agg, filename: files.length === 1 ? (files[0]!.filename ?? null) : null },
      unplacedFileCount: 0,
    }
  }

  // 剧集：季集网格。season/episode 任一为 NULL 的文件进不了网格，单独计数
  // （**扣除机械特典**——判据与列表页共用 isJudgedExtra，两页必须同一个数）。
  const placed = files.filter((f) => f.season != null && f.episode != null)
  const unplacedFileCount = files.filter(
    (f) => (f.season == null || f.episode == null) && !isJudgedExtra(f),
  ).length

  const onDiskCells = new Map<string, FileRow[]>()
  for (const f of placed) {
    const key = epKey(f.season!, f.episode!)
    const bucket = onDiskCells.get(key)
    if (bucket) bucket.push(f)
    else onDiskCells.set(key, [f])
  }

  const canonical = db
    .prepare(
      `SELECT season, episode, title FROM tmdb_seasons WHERE series_id = ? ORDER BY season ASC, episode ASC`,
    )
    .all(workId) as { season: number; episode: number; title: string | null }[]
  const canonicalTitles = new Map<string, string | null>()
  for (const c of canonical) canonicalTitles.set(epKey(c.season, c.episode), c.title)

  // 季号 = 应有 ∪ 实有，升序。
  const seasonNumbers = new Set<number>()
  for (const c of canonical) seasonNumbers.add(c.season)
  for (const f of placed) seasonNumbers.add(f.season!)

  const seasons: MediaLibrarySeasonDTO[] = [...seasonNumbers]
    .sort((a, b) => a - b)
    .map((season) => {
      // 该季的集号 = 应有 ∪ 实有，升序。
      const nums = new Set<number>()
      for (const c of canonical) if (c.season === season) nums.add(c.episode)
      for (const f of placed) if (f.season === season) nums.add(f.episode!)

      const episodes = [...nums]
        .sort((a, b) => a - b)
        .map((episode): MediaLibraryEpisodeDTO => {
          const key = epKey(season, episode)
          const rows = onDiskCells.get(key)
          // 虚线格（应有但磁盘没有）：没有文件就没有字幕事实，dot 恒 none、两个计数恒 0，
          // episodeState 恒 'absent'（R-F12：虚线格不染色）。
          if (!rows) {
            return {
              episode,
              title: canonicalTitles.get(key) ?? null,
              onDisk: false,
              dot: 'none',
              episodeState: 'absent',
              fileCount: 0,
              subtitledFileCount: 0,
            }
          }
          const agg = aggregateDot(rows, targetLanguage)
          return {
            episode,
            title: canonicalTitles.get(key) ?? null,
            onDisk: true,
            dot: agg.dot,
            episodeState: agg.episodeState,
            fileCount: agg.fileCount,
            subtitledFileCount: agg.subtitledFileCount,
          }
        })

      return { season, episodes }
    })

  return { work, seasons, movie: null, unplacedFileCount }
}
