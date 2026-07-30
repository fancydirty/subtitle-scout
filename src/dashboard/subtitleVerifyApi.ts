// src/dashboard/subtitleVerifyApi.ts
/**
 * 字幕时间轴校验的 API 判断层——把 Task 3/4 的编排层暴露给前端，并在这一层把**内部诊断字段
 * 全部拦下来**。
 *
 * ## 为什么这一层必须存在（而不是让 server.ts 直接吐 repo 行）
 *
 * `subtitle_verify` 表有 `offset_ms` / `score` / `reference_tier` / `detail` 四个内部字段
 * （见 db.ts 的建表注释与 subtitleVerifyRepo.ts 头注释）。spec 铁律②是"零数字上 UI"，
 * 而防住它最可靠的手段不是叮嘱前端别渲染，是**让前端根本拿不到**：本文件是 DB 行与 HTTP
 * 响应之间唯一的通道，`toVerifyDTO` 显式构造一个只有三个键的对象，不做 `{...row}` 展开。
 * 将来有人往表里加列，DTO 不会跟着长出新字段；有人手动往 DTO 里加字段，
 * subtitleVerifyApi.test.ts 的键集合断言会当场变红。
 *
 * ## 三值 → 两色的映射在这里定死（铁律①③）
 *
 *   shifted      → 'shifted'（红，可点校正）
 *   aligned      → 'ok'（绿）
 *   unverifiable → 'ok'（绿）  ← 不是黄，不是灰，不是第三态
 *
 * `unverifiable` 判绿是产品裁决而非偷懒：诚实体现在"不假装验证过"，而不是打个黄标让用户对
 * 一件我们自己都不知道有没有问题的事焦虑。而且它是最常见的一档（大量片源没有内嵌轨也没有
 * 同目录参考字幕），把最常见的一档渲染成警告色会让整个媒体库黄成一片，那个界面没人会再看。
 * 所以 `SubtitleVisualState` 只有两个成员——第三态在类型层就不可表达。
 *
 * ## "没检测过" 与 "检测过判绿" 必须分开（但都不是红）
 *
 * `checked: false` 不是第三种颜色，是**不显示芯片**。区别在于：判绿是"我们看过了，没问题"，
 * 没检测过是"我们还没看"。两者在 UI 上都安静，但只有前者能让用户理解那个绿点的含义；把
 * 未检测的条目也渲染成绿点等于凭空捏造了一个我们没做过的保证。
 *
 * ## 写操作纪律（铁律④ + web/DESIGN.md §8）
 *
 * 本文件有两个写扳手（`correctSubtitle` / `revertSubtitle`），都只在用户显式 POST 时被调用。
 * `buildVerifyDTOs`（GET 的实现）**只读 repo，不碰文件系统、不触发检测**——顺手校正会让
 * 一次刷新页面就改写用户的字幕文件，那是本仓库最不能出的事故。
 */
import type { LibraryRepo } from '../v2/libraryRepo.js'
import type { SubtitleVerifyRepo, SubtitleVerifyRow } from '../v2/subtitleVerifyRepo.js'
import type { ShiftResult } from '../subtitleVerify/shiftTiming.js'
import type { VerifyOutcome } from '../subtitleVerify/verifySubtitle.js'

/**
 * UI 上只有两种视觉状态，**刻意没有第三个成员**（spec 铁律①"只有绿和红，绝不给黄"）。
 * 想加 'warning' / 'unknown' / 'suspect' 的人请先回去读 db.ts 的 verdict CHECK 约束注释：
 * 那一层已经把第四档做成不可表达，这一层不该把它重新发明出来。
 */
export type SubtitleVisualState = 'ok' | 'shifted'

/**
 * 前端能看到的全部信息，就这三个键。
 *
 * **`offsetMs` / `score` / `referenceTier` / `detail` 绝不出现在这里**（铁律②）。它们在
 * DB 里、在 trace 里，供排障的人看；前端拿不到就不可能误显示成"偏移 2.4 秒"这种既没用
 * （用户无法验证）又制造焦虑（数字暗示精确度）的文案。
 */
export interface SubtitleVerifyDTO {
  itemId: string
  /** 'ok' = 绿（含 aligned 与 unverifiable 两档）；'shifted' = 红，可点校正。 */
  state: SubtitleVisualState
  /** 有没有检测过。false = 还没查过 → UI 不显示芯片（既不是绿也不是红，见文件头）。 */
  checked: boolean
}

/**
 * 单行 DB 结论 → DTO。**唯一**的 verdict→颜色映射点。
 *
 * 显式列三个键而不是 `{...row, state}`：后者会把 offset_ms/score/detail 一并漏给前端，
 * 而那正是铁律②要防的事故。这个函数的形状本身就是那道防线。
 */
export function toVerifyDTO(itemId: string, row: SubtitleVerifyRow | null): SubtitleVerifyDTO {
  if (row === null) {
    // 从未检测过。state 仍给 'ok' 而非留空/给第三值：类型上只有两态，且 checked:false 已经
    // 完整表达了"别显示芯片"，让 state 承担第三种含义会诱使前端 switch 出一个黄色分支。
    return { itemId, state: 'ok', checked: false }
  }
  return {
    itemId,
    // 铁律①③：只有 shifted 是红。aligned（验过没问题）与 unverifiable（没能验证）都是绿。
    // 这一行是整个功能的产品裁决落点，改它等于改产品，不是改实现。
    state: row.verdict === 'shifted' ? 'shifted' : 'ok',
    checked: true,
  }
}

/** GET 的响应体。恒定一种形状（单条也是长度 1 的数组）——单查/批查两种响应形状会让前端
 *  写两条解析分支，而剧集页拿整季与详情页拿单条本来就是同一个渲染逻辑。 */
export interface SubtitleVerifyListDTO {
  items: SubtitleVerifyDTO[]
}

/** 一次批查的 id 上限。一整季约 10~50 集，500 已远宽于任何真实用法；越界即拒，
 *  免得一个 `?itemIds=` 拼上几万个 id 让服务端白跑几万次 prepared statement。 */
export const MAX_BATCH_ITEM_IDS = 500

export type BuildVerifyResult =
  | { ok: true; dto: SubtitleVerifyListDTO }
  | { ok: false; error: string }

/**
 * GET /api/v2/subtitle/verify 的实现。**纯读**：只查 repo，不碰文件系统，不触发检测，
 * 不写任何东西（铁律④——是否校正是用户的选择，GET 里绝不顺手做事）。
 *
 * 库里没有该 item 的行 → `checked:false`，不是 404：GET 的语义是"这条要不要显示芯片"，
 * 而"没检测过"和"id 压根不存在"对这个问题是同一个答案（都不显示）。为不存在的 id 报 404
 * 会让剧集页的批量查询因为一集刚被删就整季失败。
 */
export function buildVerifyDTOs(
  repo: Pick<SubtitleVerifyRepo, 'getVerifyResult'>,
  itemIds: readonly string[],
): BuildVerifyResult {
  if (itemIds.length === 0) {
    return { ok: false, error: 'itemId or itemIds query param is required' }
  }
  if (itemIds.length > MAX_BATCH_ITEM_IDS) {
    return { ok: false, error: `too many ids (max ${MAX_BATCH_ITEM_IDS} per request)` }
  }
  return {
    ok: true,
    dto: { items: itemIds.map((id) => toVerifyDTO(id, repo.getVerifyResult(id))) },
  }
}

/** query 参数 → id 列表。`itemId`（单条）与 `itemIds`（逗号分隔批量）都接受，两者可同时出现
 *  （合并去重）。空片段被丢弃：`?itemIds=a,,b` 里的空串不是一个 id，当成 id 去查会得到一条
 *  itemId:'' 的假 DTO。 */
export function parseItemIds(query: { itemId?: string; itemIds?: string }): string[] {
  const raw = [query.itemId ?? '', ...(query.itemIds ?? '').split(',')]
  const seen = new Set<string>()
  for (const s of raw) {
    const t = s.trim()
    if (t !== '') seen.add(t)
  }
  return [...seen]
}

// ---- 写扳手：校正 / 撤销 ----

/** 成功回执。**同样零数字**（铁律②）：只回报新的视觉状态，不回报平移了多少毫秒、
 *  改了多少行——那些在 ShiftResult.detail 里，供排障，不上 UI。 */
export type WriteResult =
  | { ok: true; state: SubtitleVisualState }
  /** 失败。`status` 由 server.ts 写进 HTTP 状态行；`error` 是**给用户看的人话**
   *  （英文散文，同 auth.ts / apiV2.ts 既有端点的口径——前端 `t('..._error_prefix') + err`
   *  拼前缀展示，见 web/src/triage/TriagePage.tsx），**不是** shiftTiming 那种内部 detail。
   *  内部 detail 里带路径、字节数、offsetMs，既泄露诊断数字（铁律②）又对用户毫无意义。 */
  | { ok: false; status: number; error: string }

/**
 * 两个写扳手的依赖。全部可注入——ESM 无法 spy 模块导出，`shiftSubtitleTiming` 真的会改写
 * 磁盘文件、`verifyAndRecord` 真的会 spawn ffmpeg，不注入就没法测"校正后重新检测覆盖落库"
 * 这条主路径。形状同 shiftTiming.ts 的 ShiftOptions / referenceSource.ts 的 opts。
 */
export interface SubtitleWriteDeps {
  repo: Pick<SubtitleVerifyRepo, 'getVerifyResult'>
  lib: Pick<LibraryRepo, 'getEpisode' | 'getMovie'>
  /** 注入点：平移。默认接 shiftSubtitleTiming。 */
  shift: (subtitlePath: string, offsetMs: number) => Promise<ShiftResult>
  /** 注入点：撤销。默认接 revertSubtitleTiming。 */
  revert: (subtitlePath: string) => Promise<ShiftResult>
  /** 注入点：判文件存在（用于"备份是否已存在"的门）。默认 existsSync。 */
  exists: (path: string) => boolean
  /** 注入点：重新检测并覆盖落库。默认接 verifyAndRecord（它自带 needsRecheck 跳过判据）。 */
  reverify: (itemId: string, videoPath: string, subtitlePath: string) => Promise<VerifyOutcome | null>
  now: () => number
}

/** 校正/撤销前的共同前置：拿到"这条要动的字幕文件"和"它对应的片源"。
 *  两者都必须来自权威处——字幕路径来自上次检测记录的那一个（不是前端传的，前端传路径
 *  等于开一个任意文件写入的口子），片源路径来自 episodes/movies 表。 */
type Located =
  | { ok: true; row: SubtitleVerifyRow; videoPath: string }
  | { ok: false; status: number; error: string }

function locate(deps: SubtitleWriteDeps, itemId: string): Located {
  const row = deps.repo.getVerifyResult(itemId)
  // 没有检测记录 = 没有"上次检的是哪个字幕文件"这一事实。此时无从知道该动哪个文件，
  // 而不是"知道但拒绝"——所以是 404 而非 400。
  if (row === null) {
    return { ok: false, status: 404, error: "this item hasn't been checked yet" }
  }
  // 片源路径只从库里取。episodes 与 movies 是同一个 item_id 空间的两半（见 db.ts 的
  // subtitle_verify.item_id 注释），依次查。
  const item = deps.lib.getEpisode(itemId) ?? deps.lib.getMovie(itemId)
  if (item === null) {
    return { ok: false, status: 404, error: 'this item is no longer in the library' }
  }
  return { ok: true, row, videoPath: item.path }
}

/**
 * 重新检测并把新结论覆盖落库，返回新的视觉状态。
 *
 * **这一步是校正/撤销的必要组成，不是收尾的锦上添花**：DB 里那行结论是 UI 唯一的信息来源，
 * 不覆盖它，用户校正完看到的还是红芯片（因为库里还是旧结论），会以为按钮没生效并反复点。
 *
 * `reverify` 返回 null = 编排层判"不必重检"（哈希未变）。校正/撤销都必然改变文件内容因而
 * 改变哈希，所以正常路径下不会是 null；真出现（比如平移量恰好导致字节不变）就如实回退到
 * 库里现有的结论，而不是凭空断言一个 'ok'。
 */
async function reverifyAndMapState(
  deps: SubtitleWriteDeps,
  itemId: string,
  videoPath: string,
  subtitlePath: string,
): Promise<SubtitleVisualState> {
  const outcome = await deps.reverify(itemId, videoPath, subtitlePath)
  if (outcome !== null) {
    return outcome.verdict === 'shifted' ? 'shifted' : 'ok'
  }
  return toVerifyDTO(itemId, deps.repo.getVerifyResult(itemId)).state
}

/** 平移后的备份路径。与 shiftTiming.BACKUP_SUFFIX 同一常量（由调用方传入，避免本文件
 *  与那边各写一份字符串而某天不一致）。 */
export interface CorrectOpts {
  backupSuffix: string
}

/**
 * POST /api/v2/subtitle/correct 的实现：平移 → 重新检测 → 覆盖落库 → 回报新状态。
 *
 * ## 只有 shifted 能校正（铁律④）
 *
 * `aligned` 是"验过没问题"，`unverifiable` 是"没能验证"——对这两档动用户的文件，前者是
 * 无故改写一个好文件，后者是拿一个我们自己都不敢下结论的偏移量去改写。两者都拒（400）。
 *
 * ## 为什么"已校正过一次"要拒（409）而不是叠加
 *
 * `shiftSubtitleTiming` 的 `offsetMs` 基准恒为**原始文件**（它从 `.scout-backup` 重算，
 * 见那边文件头「备份 + 幂等」）。而 DB 里的 `offset_ms` 是对**当前磁盘文件**测出来的残差。
 * 于是第二次校正要传的是 `已应用量 + 残差`，不是残差本身——直接传残差会把一个已平移
 * 2000ms 的文件重置成只平移 400ms，比校正前**更错**。
 *
 * 而"已应用量"只存在于 `.scout-backup.json` 里，读它的 `readMeta` 是 shiftTiming 的模块
 * 私有函数；`shiftSubtitleTiming` 虽然回报 `previousOffsetMs`，但那是**写盘之后**的事，
 * 拿到时已经晚了。所以这里不猜、不试探，直接拒绝并告诉用户走"撤销 → 重新校正"：
 * 撤销会把文件还原、删掉 meta，下一次校正就又是一次干净的首次校正，基准明确。
 *
 * 代价是用户多点一次撤销；换来的是**永远不会把用户的字幕文件改得比校正前更错**。
 * 在本仓库风险最高的写入路径上，这个交换比划得来。日后若 shiftTiming 导出读 meta 的能力，
 * 这道门可以换成 `shift(path, previousOffsetMs + residual)`，改动限于本函数。
 */
export async function correctSubtitle(
  deps: SubtitleWriteDeps,
  itemId: string,
  opts: CorrectOpts,
): Promise<WriteResult> {
  const located = locate(deps, itemId)
  if (!located.ok) return located
  const { row, videoPath } = located

  // 铁律④：只有红的才校正。
  if (row.verdict !== 'shifted') {
    return { ok: false, status: 400, error: "this subtitle isn't out of sync — nothing to correct" }
  }
  // 防御：schema 允许 offset_ms 为 NULL，而 verdict='shifted' 的行按 verifySubtitle.ts 的
  // 约定必然带偏移量。真遇到 NULL（手工改库/旧数据）说明这行不可信，拒绝而不是拿 0 去平移
  // （平移 0 会创建一个"原始文件"备份并报成功，把一条坏数据固化成"已校正过"状态）。
  if (row.offset_ms === null) {
    return { ok: false, status: 409, error: 'this result is incomplete — re-check this item first' }
  }

  // 已校正过一次 → 拒。见上方大段论证。
  if (deps.exists(`${row.subtitle_path}${opts.backupSuffix}`)) {
    return {
      ok: false,
      status: 409,
      error: 'this subtitle has already been corrected once — undo first, then correct again',
    }
  }

  const shifted = await deps.shift(row.subtitle_path, row.offset_ms)
  if (!shifted.ok) {
    // shiftTiming 保证失败时原文件完好无损、无 tmp 残留（它的硬约束三），所以这句人话是
    // 如实的。**不把 shifted.detail 透给用户**：那里面有路径、字节数、offsetMs——
    // 既是铁律②禁止的数字，对用户也毫无可操作性。它已经如实存在于 ShiftResult 里供排障。
    return { ok: false, status: 500, error: "couldn't correct this subtitle — your file was left untouched" }
  }

  const state = await reverifyAndMapState(deps, itemId, videoPath, row.subtitle_path)
  return { ok: true, state }
}

/**
 * POST /api/v2/subtitle/revert 的实现：从备份还原 → 重新检测 → 覆盖落库 → 回报新状态。
 *
 * **刻意不看 verdict**：校正成功后 verdict 会变成 aligned/unverifiable，而那恰恰是用户最想
 * 撤销的时刻（"校正后我觉得更难看了"）。要求 verdict='shifted' 才能撤销等于把撤销做成
 * 只在校正失败时才可用，与 spec §3.4"支持撤销"的意图相反。唯一的前置是**有备份可还原**。
 *
 * 备份本身由 revertSubtitleTiming 保留不删（见那边注释：删除原始字节副本不可逆）。但它会
 * 删掉 meta，所以撤销后再校正是一次基准明确的干净首次校正——正是 correctSubtitle 那道
 * 409 门指望的出路。
 */
export async function revertSubtitle(
  deps: SubtitleWriteDeps,
  itemId: string,
  opts: CorrectOpts,
): Promise<WriteResult> {
  const located = locate(deps, itemId)
  if (!located.ok) return located
  const { row, videoPath } = located

  // 无备份 = 没有"我们改过这个文件"的痕迹，没有可撤销的操作。400 而非 404：
  // item 和结论都在，是这个**动作**不适用，不是资源不存在。
  if (!deps.exists(`${row.subtitle_path}${opts.backupSuffix}`)) {
    return { ok: false, status: 400, error: "there's nothing to undo for this subtitle" }
  }

  const reverted = await deps.revert(row.subtitle_path)
  if (!reverted.ok) {
    // 同 correct：revertSubtitleTiming 的三道守卫失败时目标文件未被触碰（它的守卫注释里
    // 每条都写了 "Target untouched"），所以这句人话如实。detail 同样不外泄。
    return { ok: false, status: 500, error: "couldn't undo this correction — your file was left untouched" }
  }

  const state = await reverifyAndMapState(deps, itemId, videoPath, row.subtitle_path)
  return { ok: true, state }
}

/** POST body 的 itemId 提取。非字符串/空串一律 null（调用方 400）——`{itemId: 123}` 和
 *  `{}` 对我们是同一件事：没告诉我们要动哪个条目。 */
export function parseItemIdBody(body: unknown): string | null {
  const b = (body ?? {}) as { itemId?: unknown }
  if (typeof b.itemId !== 'string') return null
  const t = b.itemId.trim()
  return t === '' ? null : t
}
