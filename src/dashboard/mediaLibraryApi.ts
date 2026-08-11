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
  /** ··· 系统认为这一集需要找字幕、还没找到（`needs_subtitle=1`）。 */
  | 'pending'
  /** ? 第 8 态：系统**答不上来**。两种来源，见 classifyFileState 的终态分支。 */
  | 'unjudged'

/** 一个语言标签是否算中文。
 *
 *  🔴 C30（本仓栽过"两套字幕标签集漂移"）：**必须**复用 agent/languages.ts 的现成表，
 *  不许在这里写第二份中文标签集。
 *
 *  🔴 为什么不能只用 `langOf(tag) === 'zh'`（实测定罪）：`langOf` 只折叠
 *  ZH_ORIGIN_CODES = {zh, cn, chi, zho, cmn}，对 'chs' / 'cht' 是纯透传 ——
 *  实测 `langOf('chs') === 'chs'`，不等于 'zh'。ffprobe 的 MediaStream Language 字段
 *  在生产里 chs/cht 都出现过（db.ts 的 CHINESE_LANG_TAGS 历史注释记的就是这五种形态），
 *  只认 langOf 会让一批带简繁内嵌轨的片子丢掉蓝点。
 *
 *  🔴 也不能只用 `tagsForLanguage('zh').includes(tag)`：那张表是"sidecar 文件名 tag"集合，
 *  未来若有人往里加/减一项，单臂判据会静默改变含义。
 *
 *  两臂并列（与 v2/subtitleJudge.ts 的私有 isLang 同构——那份没导出，且它服务的是
 *  "需不需要找字幕"的判定语义，这里服务的是"呈现哪种圆点"，刻意不去 export 一个跨语义
 *  的共享函数，但**判据的两条腿完全一致**，两边任一侧扩表都能覆盖到）。 */
function isChineseTag(tag: string | null | undefined): boolean {
  if (!tag) return false
  const t = tag.toLowerCase()
  return tagsForLanguage('zh').some((x) => x.toLowerCase() === t) || langOf(tag) === 'zh'
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
function fileHasSidecar(subStatus: string | null): boolean {
  return subStatus === 'covered'
}

/** 一个**文件**是否有内嵌中文轨。没探过（NULL）→ false（没有证据就没有蓝点）。 */
function fileHasEmbeddedChinese(embeddedLangs: string[] | null): boolean {
  return embeddedLangs != null && embeddedLangs.some(isChineseTag)
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
 *  【第二段段内：origin-skip 先于 embedded】
 *  这一条是**照抄 judgeSubtitle 自己的规则顺序**（origin_lang 命中在前、embedded_langs 在后），
 *  不是本文件另立的偏好。一部国产片同时带中文内嵌轨时，judge 写进 skip_reason 的就是
 *  'origin-skip'；这里若反过来先判 embedded，显示的 ◆ 会与库里 skip_reason 的值直接矛盾，
 *  排障时两处对不上。判据只有一个来源，顺序也必须只有一个来源。
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
function classifyFileState(f: FileRow): Exclude<EpisodeState, 'absent'> {
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
  // 存量库里 judge 早已判过的行这一列全是 NULL（生产实测 1192 行全 NULL）。以 reason 为准的话，
  // 那 1192 行会全部落进 unjudged —— 而它们其实判过，只是判的时候还没有这一列。
  if (f.needs_subtitle === 0) {
    if (f.skip_reason === 'origin-skip') return 'origin-skip'
    if (f.skip_reason === 'embedded') return 'embedded'
    // needs=0 但 reason 缺失/不认识（v40 之前判定的存量行；或将来新增了一种 reason 而这里
    // 忘了跟）。**不许猜**成 origin-skip 或 embedded：两者在换目标语言后的命运完全相反
    // （db.ts:983 的原话），猜错就是给用户一个与事实相反的 ◇/◆ 标记且无从察觉。
    // 落 unjudged（`?` = 系统答不上来）是唯一诚实的选择——它同时是"该重判了"的可见信号。
    return 'unjudged'
  }
  if (f.needs_subtitle === 1) return 'pending'

  // 第 8 态兜底。走到这里的都是 sub_status IS NULL 且 needs_subtitle IS NULL 的行——
  // judge 还没轮到它（谓词 `needs_subtitle IS NULL`）。新扫进来的文件、以及刚被 D17 回填 /
  // 指纹重置清空判决的行，都会在这里停留一轮。
  // 另外两条通往 unjudged 的路在上面各自就近说明：非 NULL 的未知 sub_status、
  // 以及 needs=0 但 reason 缺失/不认识。
  return 'unjudged'
}

/** 一格（可能多份文件）的八态聚合。
 *
 *  🔴 与 aggregateDot 同源的 R-F2 条款：**任一份**最好的状态代表这一格。用户原话是两个
 *  「绝命毒师」目录只要有一处 S01E03 有字幕就算已获取——同一条口径必须覆盖到八态上，
 *  否则圆点说"已获取"而集号染色说"待处理"，同一张卡上两个控件自相矛盾。
 *
 *  取法 = 按上面那条优先级链取**最靠前**的那一份，而不是取第一行：取首行的实现会因入库
 *  顺序不同给出相反结论（aggregateDot 的注释里钉过同一个坑，那次是 `.some()` 治的）。 */
const STATE_RANK: readonly Exclude<EpisodeState, 'absent'>[] = [
  'covered', 'translating', 'unsolvable', 'origin-skip', 'embedded', 'pending', 'unjudged',
]

function aggregateState(files: readonly FileRow[]): Exclude<EpisodeState, 'absent'> {
  let best = STATE_RANK.length - 1
  for (const f of files) {
    const rank = STATE_RANK.indexOf(classifyFileState(f))
    if (rank < best) best = rank
  }
  return STATE_RANK[best]
}

// ---- R-F2「不管来源」的聚合 ----

/** 一格（一集，或电影的那一格）在**聚合后**的字幕事实。 */
interface DotAggregate {
  /** 该格下的文件份数（同一集在两个目录各一份 → 2）。 */
  fileCount: number
  /** 其中有外挂中文 sidecar 的份数（R-F2 原话"另一处那份仍要单独去配"的可见依据）。 */
  subtitledFileCount: number
  dot: SubtitleDot
  /** 八态（R-F12）。与 dot 走**同一条** R-F2「任一份算」口径，只是判据更细，
   *  见 aggregateState。虚线格由调用方覆盖成 'absent'（这里拿不到 onDisk 这个信息）。 */
  episodeState: Exclude<EpisodeState, 'absent'>
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
 *   · fileCount / subtitledFileCount 如实呈报，"另一处仍要单独去配"这个事实不许被聚合吞掉。 */
function aggregateDot(files: readonly FileRow[]): DotAggregate {
  const subtitledFileCount = files.filter((f) => fileHasSidecar(f.sub_status)).length
  const anyEmbedded = files.some((f) => fileHasEmbeddedChinese(parseEmbeddedLangs(f.embedded_langs)))
  const dot: SubtitleDot = subtitledFileCount > 0 ? 'green' : anyEmbedded ? 'blue' : 'none'
  return { fileCount: files.length, subtitledFileCount, dot, episodeState: aggregateState(files) }
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
  /** 已获取中文字幕的格数（R-F2「任一份有就算」口径；绿点 + 蓝点都计入 ——
   *  用户视角"这一集有中文字幕"不分内嵌外挂）。 */
  subtitledEpisodeCount: number
}

/** GET /api/v2/mediaLibrary：海报墙列表。
 *
 *  🔴 R-F2「识别失败的孤儿不露出」：`files.work_id IS NULL` 的行在 SQL 谓词层就被滤掉
 *  （INNER JOIN works + work_id NOT NULL），不进任何聚合。那是用户的命名问题，
 *  底线是按 `title (year)` 命名。
 *
 *  🔴 用 INNER JOIN 而非 LEFT JOIN：一个文件都没有的 works 行（用户移除了守备目录后
 *  残留的空壳）不该在海报墙上冒出一张空卡片 —— 媒体库页描述的是"磁盘上有什么"。 */
export function buildMediaLibrary(db: ScoutDb): MediaLibraryItemDTO[] {
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

  // work → 格键 → 该格的文件们。电影/未解析出季集的文件统一落在 '' 这一格
  // （电影本来就一格；剧集里解析不出季集的文件也只能算作"这作品有文件"，
  //  它进不了季集网格，但它的字幕事实仍是真实的）。
  const cellsByWork = new Map<string, Map<string, FileRow[]>>()
  for (const f of files) {
    const key = f.season != null && f.episode != null ? epKey(f.season, f.episode) : ''
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
    const subtitled = [...cells.values()].filter((rows) => aggregateDot(rows).dot !== 'none').length
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
  /** 同 MediaLibraryEpisodeDTO.episodeState 的八态口径。电影那一格**恒有文件**
   *  （buildMediaLibraryDetail 只在 mediaType==='movie' 时构造它，而 works 行能露出
   *  就意味着至少有一个文件），故这里不会是 'absent'——但类型上保留完整联合：
   *  收窄成 Exclude<EpisodeState,'absent'> 会让前端为电影和剧集写两套 switch。 */
  episodeState: EpisodeState
  fileCount: number
  subtitledFileCount: number
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
  /** 属于本作品、但 season/episode 解析不出（`parse_confidence='none'`）因而进不了
   *  季集网格的文件数。**必须如实报**：不报的话用户看不出"有文件没进网格"，会以为
   *  系统把文件弄丢了；而按 NULL 分组又会造出一个 season=null 的幽灵季。电影恒 0
   *  （电影的文件本来就不该有季集，它们全部落进 movie 那一格）。 */
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
export function buildMediaLibraryDetail(db: ScoutDb, workId: string): MediaLibraryDetailDTO | null {
  const w = db
    .prepare(
      `SELECT id, title, year, media_type, poster_path, chinese_titles FROM works WHERE id = ?`,
    )
    .get(workId) as WorkRow | undefined
  if (!w) return null

  const files = db
    .prepare(
      `SELECT work_id, season, episode, sub_status, embedded_langs, needs_subtitle, skip_reason
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
    return { work, seasons: [], movie: aggregateDot(files), unplacedFileCount: 0 }
  }

  // 剧集：季集网格。season/episode 任一为 NULL 的文件进不了网格，单独计数。
  const placed = files.filter((f) => f.season != null && f.episode != null)
  const unplacedFileCount = files.length - placed.length

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
          const agg = aggregateDot(rows)
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
