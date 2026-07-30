// src/dashboard/subtitleCompareApi.ts
/**
 * 字幕对照图的数据供给层——给前端那张 PR 风格的双轨时间轴（参考轨 vs 待检字幕轨）
 * 一次性备齐画图所需的全部素材，**且只备画图所需的**。
 *
 * ## 与 subtitleVerifyApi.ts 的分工
 *
 * 那边回答"这一集要不要显示红芯片"（三值→两色，零数字）；本文件回答"把这两条时间轴画出来
 * 长什么样"。两者共用同一张 `subtitle_verify` 表作为**待检字幕路径的权威来源**（不接受前端
 * 传路径——那是任意文件读取的口子，见 subtitleVerifyApi.locate 的同类论证），但 DTO 完全不同：
 * 本文件要吐时间戳与台词文本，那边一个数字都不吐。
 *
 * ## 铁律②在本文件的确切边界：坐标 ≠ 评分
 *
 * 这是本文件唯一容易被误读的地方，写清楚：
 *
 *   **允许**：`startMs` / `endMs` / `durationMs`——这些是**定位坐标**。没有它们画不出图；
 *            而且它们表达的是"这句话在第几秒"这个用户可以自己按下播放键验证的客观事实。
 *   **禁止**：`offsetMs` / `score` / `referenceTier` / `detail`——这些是**质量评分与内部诊断**。
 *            "偏移 2400ms"是系统在主张一个精确度（用户无法验证），"0.93 分"是把一个内部
 *            阈值决策伪装成可读数字，两者都是铁律②要防的事故。
 *
 * 换句话说：给用户**看两条轨自己错开多少**是可以的（他用眼睛量，这恰恰是对照图的全部意义），
 * 替他**报出一个数**不可以。前者把判断权交给用户，后者假装我们比用户更确定。
 *
 * 落实手段与 toVerifyDTO 同构：`buildCompareDTO` 显式构造对象、绝不 `{...row}` 展开，
 * 且 subtitleCompareApi.test.ts 有键集合断言——将来有人往 DTO 里加 `score`，测试当场变红。
 *
 * ## 纯读，且刻意不触发检测（铁律④）
 *
 * 本模块读字幕文件、可能 spawn ffmpeg 抽内嵌轨（经 findReferenceSource），但**不写任何东西**：
 * 不改字幕、不落库、不 upsert 一行新结论。打开一张对照图不该有副作用。
 */
import type { Cue } from '../files/subtitleInspect.js'
import type { MountKind } from '../core/mountKind.js'
import type { LibraryRepo } from '../v2/libraryRepo.js'
import type { SubtitleVerifyRepo } from '../v2/subtitleVerifyRepo.js'
import type { ReferenceSource } from '../subtitleVerify/referenceSource.js'

/**
 * 单块：时间轴上一个说话时段 + 它的台词。
 *
 * `text` 可为 null 是**给将来的 VAD 参考源留的位置**，不是当前实现会走的分支：
 * ①内嵌轨与②同目录字幕都必然带文本（两者都经 parseCues 出 Cue，Cue.text 是必填）。
 * 保留 null 分支的理由是它**几乎零成本**（前端本来就要为窄块渲染省略号，多一个空文本
 * 分支不增加真实复杂度）而移除它的代价很高：VAD 落地那天，DTO 从 `string` 改成
 * `string | null` 是一次前端全量重审（每个读 text 的地方都要重新想 null 怎么画），
 * 而现在写下它只是让前端多写一个 `?? ''`。
 *
 * **不是**给"文本读取失败"用的——读不出文本的字幕解析不出 cue，那个时段压根不会出现在这里。
 */
export interface CompareBlock {
  startMs: number
  endMs: number
  text: string | null
}

/**
 * 前端画一张对照图所需的全部数据，**就这六个键**。
 *
 * `offsetMs` / `score` / `referenceTier` / `detail` 绝不出现在这里——见文件头「坐标 ≠ 评分」。
 */
export interface SubtitleCompareDTO {
  itemId: string
  /** 参考轨：说话时段 + 台词。`text` 的 null 分支见 CompareBlock。 */
  reference: CompareBlock[]
  /** 待检字幕轨。当前实现下 text 恒非 null（来自 Cue.text），但类型与参考轨保持同一个
   *  CompareBlock——两条轨在前端是同一个渲染组件的两次调用，DTO 让它们形状不同会逼前端
   *  写两套块渲染逻辑，而它们本来就该长得一样。 */
  ours: CompareBlock[]
  /** 视频总时长 = 时间轴的坐标范围。探测不到时的兜底口径见 resolveDurationMs。 */
  durationMs: number
  /** 能不能画第三轨音频波形。cloud 挂载 → false，前端据此压根不渲染声音轨
   *  （而不是渲染了再转圈等一个必然超时的请求）。 */
  waveformAvailable: boolean
  /** 存储类型，供前端 hover 提示措辞（"网盘上的文件没法做对照"）。
   *  这不是"数字"也不是评分，是一个解释**为什么某个功能不可用**的事实——
   *  没有它，灰掉的波形轨对用户是无从理解的哑巴失败。 */
  mountKind: MountKind
}

/**
 * 台词单条长度上限。超出即截断（不加省略号——那是前端的排版决定，后端塞进数据里会让
 * 前端想显示别的样式时无从下手）。
 *
 * 为什么截断而不是全量返回：一集约 500~2000 条 cue。**但真正的理由不是总字节数**——
 * 2000 条 × 40 字约 160KB，gzip 后几十 KB，本地网络下无所谓。理由是**长尾的那几条**：
 * 歌词轨的整段 staff roll、字幕组在片头塞的免责声明、ASS 特效轨里一条几千字符的
 * `{\pos}` 装饰文本。这些单条能到几 KB，且**没有任何展示价值**——前端窄块显示省略号、
 * hover 显示一句话，没人 hover 一段独白读到底。不截断的结果是一条畸形 cue 把响应体
 * 撑大一个数量级，而它在界面上占的还是同一个小方块。
 *
 * 120 的取法：中文一句台词典型 10~25 字，英文一句 40~80 字符；120 足够容纳"最长的一句
 * 正常台词"外加余量，同时把上述长尾砍在一个数量级之内。刻意不做分页/按需拉取：
 * 那要求前端为一个"一次画完整张图"的视图实现滚动加载协议，复杂度远超它省下的几十 KB。
 */
export const MAX_CUE_TEXT_CHARS = 120

/**
 * 无参考源时兜底的时长口径：取待检字幕最后一条 cue 的结束时间。
 *
 * 这个乘数把它撑出一点余量——字幕最后一句到片尾字幕结束之间总有空白（ED、下集预告），
 * 直接拿最后一条 cue 当片长会让时间轴右端恰好顶在最后一块上，视觉上像是"图被截断了"。
 * 1.05 是纯排版余量，不宣称任何精度——正因如此它只在**真探测不到时长**时才被使用。
 */
const FALLBACK_DURATION_SLACK = 1.05

/** cue → DTO 块。截断在这里做，是 Cue 与 CompareBlock 之间唯一的通道。 */
function toBlock(cue: Cue): CompareBlock {
  const t = cue.text.trim()
  return {
    startMs: cue.startMs,
    endMs: cue.endMs,
    // 空文本归一成 null，与"参考源没有文本"合流成同一个前端分支：一条 cue 的文本被样式
    // 标签占满（ASS 特效轨常见）时留下的空串对前端毫无意义，让它多一个 '' 的分支只会
    // 诱使某处写出 `text ? ... : ...` 而把空串和 null 画成两种样子。
    text: t.length === 0 ? null : t.slice(0, MAX_CUE_TEXT_CHARS),
  }
}

export type BuildCompareResult =
  | { ok: true; dto: SubtitleCompareDTO }
  | { ok: false; status: number; error: string }

/**
 * 本模块的全部外部依赖，一律注入（ESM 无法 spy 模块导出，本仓库硬纪律）。
 *
 * 不注入就没法测：`findReference` 真的会 spawn ffmpeg 抽内嵌轨、`probeDuration` 真的会
 * spawn ffprobe（云盘上 10~16 秒）、`classify` 真的会读 /proc/self/mountinfo（macOS 开发机
 * 上恒 null → 恒判 cloud，那样"lan 不被误禁"这条回归锁在开发机上压根跑不起来）。
 */
export interface SubtitleCompareDeps {
  repo: Pick<SubtitleVerifyRepo, 'getVerifyResult'>
  lib: Pick<LibraryRepo, 'getEpisode' | 'getMovie'>
  /** 注入点：读+解码+解析待检字幕，拿带文本的 cue。默认 readSubtitleText + parseCues。
   *  刻意不用 loadSpans——它会剥掉 text，而本模块的全部意义就是把 text 带给前端。 */
  loadCues: (path: string) => Promise<Cue[] | null>
  /** 注入点：找参考源。默认接 findReferenceSource（① 内嵌轨 → ② 同目录字幕）。
   *  返回值里的 `cues` 字段是本任务给 referenceSource 新加的——见那边的注释，
   *  重新解析一遍意味着再 spawn 一次 ffmpeg。 */
  findReference: (videoPath: string, subtitlePath: string) => Promise<ReferenceSource | null>
  /** 注入点：探视频时长（秒）。默认接 probeDurationSec。探不到返回 null → 走字幕兜底。 */
  probeDuration: (videoPath: string) => Promise<number | null>
  /** 注入点：判存储类型。默认接 classifyPath。 */
  classify: (path: string) => MountKind
  /** 注入点：能否画波形。默认接 canRenderWaveform。单独注入而不是在本文件写
   *  `kind !== 'cloud'`：那条规则的论证（含实测数字）在 mountKind.ts，抄一份在这里
   *  就是给它开第二个真相来源，某天两边不一致。 */
  canWaveform: (kind: MountKind) => boolean
}

/**
 * 探时长：先问 ffprobe，探不到拿字幕最后一条 cue 兜底。
 *
 * ## 为什么必须有兜底而不是让端点失败
 *
 * 时长只是**时间轴的坐标范围**。探不到就画不出图，但"画不出图"和"图的右端刻度不完全精确"
 * 差得远——后者用户根本看不出来（两条轨的相对错位才是他要看的东西，那不依赖片长）。
 * 为一个纯排版参数让整个功能 500 是荒谬的成本分配。
 *
 * ## 为什么不在这里加缓存
 *
 * 云盘上 probeDurationSec 要 10~16 秒（spec §1 实测），确实值得缓存。但**云盘条目压根走不到
 * 这里的慢路径**：调用方对 cloud 挂载已经不渲染波形，而对照图本身在云盘上也是可疑的
 * （findReferenceSource 的 ① 层要 spawn ffmpeg 读远端文件）。真要缓存，正确的位置是
 * `probeDurationSec` 自己或 media 表的一列（时长是片源的固有属性，不是本端点的私有关切），
 * 不是在一个 API 判断层里挂一个 Map 而后要操心失效。所以这里如实同步等，
 * 并把这个决定写下来供下一个人推翻。
 *
 * 取两条轨的最大值而非只看待检轨：参考轨常常更完整（内嵌轨带片尾曲字幕、
 * 而外挂的翻译字幕在正片结束就没了），拿短的那条当片长会把参考轨右侧的块画到图外面去。
 */
export async function resolveDurationMs(
  deps: Pick<SubtitleCompareDeps, 'probeDuration'>,
  videoPath: string,
  tracks: readonly (readonly CompareBlock[])[],
): Promise<number> {
  const sec = await deps.probeDuration(videoPath)
  // > 0 而非 != null：ffprobe 对某些畸形容器会报 duration 0，那不是"时长为零"是"没测出来"，
  // 拿 0 当坐标范围会让前端除零（每个块的宽度 = 时长占比）。
  if (sec !== null && sec > 0) return Math.round(sec * 1000)

  let lastMs = 0
  for (const track of tracks) {
    for (const block of track) {
      if (block.endMs > lastMs) lastMs = block.endMs
    }
  }
  return Math.round(lastMs * FALLBACK_DURATION_SLACK)
}

/**
 * GET /api/v2/subtitle/compare 的实现。
 *
 * ## 无参考源（findReference 返回 null）→ 200 + 空 reference 数组，不是 404
 *
 * 这是刻意的裁决。理由三条：
 *
 * ① **404 会说谎**。资源存在——这一集有字幕、有片源、有时长、待检轨完全可画。缺的只是
 *    "拿什么跟它比"。对一个存在的资源报 not found 会让前端把它和"itemId 打错了"混为一谈。
 *
 * ② **单轨视图本身有用**。用户打开对照图看到自己那条字幕的分布（哪里密、哪里有 5 分钟空白），
 *    这在诊断"字幕只翻了前半集"这类问题上是直接有效的，不需要参考轨。
 *
 * ③ **"无参考源"是最常见的一档**，不是异常。referenceSource 的头注释写明大量片源既无内嵌轨
 *    也无同目录参考字幕（这也正是 verdict 里 `unverifiable` 判绿的理由）。把最常见的情形做成
 *    错误响应，前端就得为它写错误分支，而那个"错误"每天要发生几百次。
 *
 * 前端据 `reference.length === 0` 自行决定画一轨还是两轨——这个判断它本来就要做
 * （空数组和"有参考源但只有 3 块"在渲染上是连续的，不是两种模式）。
 *
 * ## 待检字幕读不出来 → 500
 *
 * 与上面相反：`subtitle_path` 是从**我们自己的检测记录**里取的，它读不出来意味着文件在
 * 上次检测后被删/被改坏。这不是一个正常分档，是库与磁盘不一致，如实报服务端错误。
 * （不是 404：itemId 是对的，也不是 400：请求没问题。）
 */
export async function buildCompareDTO(
  deps: SubtitleCompareDeps,
  itemId: string,
): Promise<BuildCompareResult> {
  // 待检字幕路径只从检测记录里取，绝不接受前端传路径（任意文件读取的口子）。
  const row = deps.repo.getVerifyResult(itemId)
  // 没有检测记录 = 不知道该画哪个字幕文件。同 subtitleVerifyApi.locate：404 而非 400,
  // 因为这是"无从知道"而不是"知道但拒绝"。
  if (row === null) {
    return { ok: false, status: 404, error: "this item hasn't been checked yet" }
  }
  // 片源路径从库里取。episodes 与 movies 是同一个 item_id 空间的两半，依次查。
  const item = deps.lib.getEpisode(itemId) ?? deps.lib.getMovie(itemId)
  if (item === null) {
    return { ok: false, status: 404, error: 'this item is no longer in the library' }
  }

  const ourCues = await deps.loadCues(row.subtitle_path)
  // 读不出/解析不出 → 库与磁盘不一致，如实 500（见函数头）。0 条 cue 与读失败在这里
  // 是同一件事：没有可画的轨。
  if (ourCues === null || ourCues.length === 0) {
    return { ok: false, status: 500, error: "couldn't read this subtitle file" }
  }

  const ref = await deps.findReference(item.path, row.subtitle_path)
  const ours = ourCues.map(toBlock)
  // 无参考源 → 空数组（不是 404，见函数头三条论证）
  const reference = (ref?.cues ?? []).map(toBlock)

  const durationMs = await resolveDurationMs(deps, item.path, [ours, reference])
  // 按**片源**判存储类型，不是按字幕文件：波形是从视频里抽的，决定成本的是视频落在哪。
  // 字幕可能在本地而视频在云盘（sidecar 装在别处），那种情况下波形一样抽不动。
  const mountKind = deps.classify(item.path)

  // 显式列六个键，绝不 `{...row}` / `{...ref}` 展开——后者会把 offset_ms/score/
  // reference_tier/detail 一并漏给前端，正是铁律②要防的事故。这个函数的形状本身是防线。
  return {
    ok: true,
    dto: {
      itemId,
      reference,
      ours,
      durationMs,
      waveformAvailable: deps.canWaveform(mountKind),
      mountKind,
    },
  }
}

// ---- 波形峰值（第三轨的实际数据）留到下一个任务 ----
//
// 本端点只回报 `waveformAvailable` 这个布尔值，不带峰值数组。拆开的理由是响应形状：
// 峰值是一个大数组（或二进制），跟这份 JSON 混在一起会让一个"画图元数据"请求的体积
// 随视频长度线性膨胀，且无法单独缓存/单独失败。它需要自己的端点。
//
// 已实测的数字，供下一个任务定超时与预期（同一台机器、同一条命令）：
//
//   局域网 cifs（23.7 分钟文件，整轨）：
//     ffmpeg -i F -map 0:a:0 -ac 1 -ar 100 -f s16le -
//     → 8 秒，产出 284KB
//     （-ar 100 = 每秒 100 个采样点，正是画波形要的分辨率；不需要原始采样率）
//
//   云盘 fuse.rclone（只抽 60 秒音频）：
//     → >120 秒，超时掐断
//
// 所以下一个任务的形状大致是：cloud 直接拒（本端点的 waveformAvailable 已经让前端
// 不会发这个请求，但端点自己仍要有门——前端不可信）；lan/local 走整轨抽取，
// 超时按"8 秒实测 + 几倍余量"取，不要按云盘那个数字取。
