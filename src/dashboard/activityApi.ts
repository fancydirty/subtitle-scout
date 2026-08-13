// src/dashboard/activityApi.ts —— R-F13 活动页的**图与身份**数据层（GET /api/v2/activity）。
//
// ── 这个端点为什么存在（它补的是 SSE 结构上给不出的那一半）────────────────────
// 活动页的两段（正在跑 / 已排队）在 SSE 上只有一半数据：
//  · `activity`/`progress` 事件带 `title`（字符串）与 `data.workId`（Task ⑨ 补），
//    **不带任何图片路径**——事件通道是"变化"，往每条事件里塞两个 CDN 路径是把作品静态
//    资料当增量推，一部剧连发 24 条 progress 就重复推 24 次同样的两个字符串。
//  · **排队段在 SSE 上根本不存在**：daemon 只在开始处理某个作品时 emit，还没轮到的那些
//    作品一条事件都不会有。R-F13 却明令排队段要画竖版 poster 卡片。
//
// ── 🔴 与 /api/v2/health「刻意不返回 queue」那条裁决的关系（必须读完再改本文件）──
// health.test.ts:410 有一条断言钉死 `'queue' in body === false`，理由（§3.5:578）是：
// `listSubtitleQueue` 给的是"**现在重查**会捞到什么"，而 R4 的设计是**冻结快照**——
// 拿它算「第 i/n 个」的 n，会与 SSE 里那个冻结的 n 对不上，且随巡检推进越飘越远。
//
// **本端点不违反那条裁决，因为它不产出任何 total、不产出任何序号。**
// 它只回答一个问题：「**还有哪些作品在等**，它们叫什么、长什么样」。分工是刚性的：
//   · 「第 3/47 个」这类**计数与进度** → **只信 SSE**（冻结快照的数字，唯一真源）
//   · 「排队里有哪些作品 + 它们的图」  → 本端点（实时重查，天然会变，也**应该**会变）
// 两个数字来源在 UI 上分开呈现、**绝不互相推导**：前端不许拿 `queued.length` 当 total，
// 也不许拿 SSE 的 total 减 done 去截断 queued 列表。守卫见 activityApi.test.ts 的
// 「不产出 total/index」那条，以及前端 ActivityPage.test.tsx 的同名一条。
//
// 若哪天有人想在这里加一个 `total` 字段"方便前端"——那正是 :578 禁止的那件事，
// 它会以"两个 total 对不上"的形态在生产上表现为进度条来回跳。
//
// ── 为什么不复用 listSubtitleQueue / listNewTranslateCandidates 的返回值 ─────────
// 复用了。谓词**必须**复用（C30：两份判据必漂移），本文件不写第二套"谁在排队"的 WHERE。
// 但那两个函数返回的是**给 agent 干活用的任务体**（含 path/dir/durationSec/embeddedLangs/
// overview/originLang），把它们整个 JSON 出去等于把磁盘路径与剧情简介推给浏览器。
// 故本文件在它们之上做一层**投影**：只留 workId/title/图/这轮几集，别的一律不出。
import type { ScoutDb } from '../v2/db.js'
import {
  listSubtitleQueue, queueItemDueNow, queueItemEarliestRetryAt,
} from '../v2/subtitleScheduler.js'
import { listNewTranslateCandidates } from '../v2/translateWorkerTask.js'

/** 排队中的一个**作品**（R-F4：粒度是作品，不是集）。 */
export interface ActivityQueueItemDTO {
  /** works.id（'tmdb:<n>'）。前端拿它与 SSE 事件的 `data.workId` 对齐，
   *  **不靠标题字符串匹配**（同名作品与译名切换都会让标题匹配静默错位）。 */
  workId: string
  title: string
  /** works.chinese_titles 首个译名；无则 null（前端回落 title）。 */
  chineseTitle: string | null
  year: number | null
  mediaType: 'tv' | 'movie'
  /** 竖版海报路径（R-F13 排队段用 59×88 竖版 poster）。无图 → null，前端降级纯排印。 */
  posterPath: string | null
  /** 横版背景图路径（R-F13 在跑段用 60% 宽 / 186px 高的横版 backdrop）。
   *  ⚠️ 排队项也带它：一个作品会从排队段**走到**在跑段，那一刻前端要立刻有横版图可用，
   *  否则会闪一帧无图降级。两张图都是裸路径串，成本是每项多一个字符串。 */
  backdropPath: string | null
  /** 这一轮这个作品有几个文件在等（R-F4：「2018 · 动画 · 13 集待处理」那个 13）。
   *  🔴 **这不是 total、不是序号**——它是"这个作品自己有几集在等"，与队列长度无关。
   *  见文件头对 :578 那条裁决的论证。 */
  pendingFileCount: number
  /** 这一项**现在就能取**吗。
   *
   *  🔴 这是 2026-08-13 那条假话的修复点。此前本端点复用的是 daemon 的**取件**谓词
   *  （含退避窗），于是生产上「needs_subtitle=1 AND sub_status IS NULL」的 33 个文件
   *  全在退避窗里时，本端点返回空数组，活动页说「已排队 · 0 / 没有排队的作品」——
   *  而库里确实有 33 个在等。**空态与"全都在退避里"共用了同一句话。**
   *
   *  修法不是在这里重写一份 WHERE（那正是本文件头注释禁的），而是让
   *  `listSubtitleQueue` 的第三条谓词可短路（`includeBackoff`，见那边的论证）：
   *  归属谓词仍是同一份文本，只是本端点问的是「还有什么在等」而不是「现在该取哪件」。
   *
   *  false 时 `retryAfter` 必非 null；true 时 `retryAfter` 恒 null。 */
  dueNow: boolean
  /** `dueNow === false` 时：这一簇里**最早**的重试时刻（毫秒）。到点的项恒 null。
   *  前端拿它说「最早 16 小时后重试」——一个退避中的队列若只报"在等"而不说"等到什么
   *  时候"，用户无法区分"系统在等"与"系统卡住了"。 */
  retryAfter: number | null
}

/** GET /api/v2/activity 的响应。两个工作台各一段。
 *
 *  🔴 **没有 identify 这一段，这是 R-F1 的后端侧执行**（前端还有一道，两道都在）：
 *  R-F1 明令「识别不进活动页」。识别的 activity 事件仍在推（有意保留：识别失败要能看见），
 *  由前端按 `workbench === 'identify'` 剔出两个 tab、降级为顶部状态条。本端点作为
 *  **排队段的数据源**，则从一开始就不产出识别队列——两个 tab 是「字幕 / 翻译」，
 *  给识别产一段数据就是在准备一个没人该渲染的第三 tab。
 *
 *  🔴 **没有 total、没有 index、没有"当前在跑的是谁"**：那三样全部只信 SSE 与
 *  /api/v2/health 的 `current`（冻结快照）。见文件头。 */
export interface ActivityDTO {
  /** 字幕工作台的排队作品（谓词复用 listSubtitleQueue）。 */
  subtitleQueue: ActivityQueueItemDTO[]
  /** 翻译工作台的排队作品（谓词复用 listNewTranslateCandidates）。 */
  translateQueue: ActivityQueueItemDTO[]
}

/** 一次查库拿齐若干作品的身份与两张图。
 *
 *  为什么单独一次 IN 查询而不是在上面两个 list 函数的 SQL 里 JOIN 出来：那两个函数是
 *  **daemon 的取件谓词**，生产路径上每轮巡检都在跑。为了 dashboard 的一个只读页面往它们的
 *  SELECT 里加两列图片路径，是让展示需求渗进调度核心（且 listNewTranslateCandidates 的
 *  返回类型被 C20 的红线用例钉着）。这里多一次 SQL，换那两个函数一行不改。 */
function loadWorkFaces(
  db: ScoutDb,
  workIds: readonly string[],
): Map<string, { title: string; chineseTitle: string | null; year: number | null; mediaType: 'tv' | 'movie'; posterPath: string | null; backdropPath: string | null }> {
  const out = new Map<string, { title: string; chineseTitle: string | null; year: number | null; mediaType: 'tv' | 'movie'; posterPath: string | null; backdropPath: string | null }>()
  if (workIds.length === 0) return out
  // 🔴 读 `works.backdrop_path`（v42 加的列），**不是** `series.backdrop_path`。
  // 旧 DTO（apiV2.buildWorkflowWorkers）读的是后者，而 `series` 表生产 **0 行** ——
  // 照抄它的 JOIN 会让活动页的横版图恒为 null，而且是**静默**的（无图降级路径本来就存在，
  // 没有任何用例会红）。这一行是本 task 与旧世界的分界。
  const rows = db
    .prepare(
      `SELECT id, title, year, media_type, poster_path, backdrop_path, chinese_titles
         FROM works WHERE id IN (${workIds.map(() => '?').join(',')})`,
    )
    .all(...workIds) as Array<{
      id: string; title: string; year: number | null; media_type: string
      poster_path: string | null; backdrop_path: string | null; chinese_titles: string | null
    }>
  for (const r of rows) {
    out.set(r.id, {
      title: r.title,
      chineseTitle: firstChineseTitle(r.chinese_titles),
      year: r.year,
      mediaType: r.media_type === 'movie' ? 'movie' : 'tv',
      posterPath: r.poster_path,
      backdropPath: r.backdrop_path,
    })
  }
  return out
}

/** `works.chinese_titles` 是 JSON 数组；取首个作为展示名。坏 JSON / 空数组 / NULL → null。
 *  与 mediaLibraryApi 的同名私有函数**逐字同形但不共享**：那边是媒体库页的私有实现，
 *  跨文件导出一个三行的解析器只会制造一条无谓的依赖；两边同时坏掉的风险由各自的用例覆盖。 */
function firstChineseTitle(raw: string | null): string | null {
  if (raw == null) return null
  try {
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr) && typeof arr[0] === 'string' && arr[0] !== '' ? arr[0] : null
  } catch {
    return null
  }
}

/**
 * GET /api/v2/activity —— 两个工作台的**排队作品**（身份 + 图）。
 *
 * ⚠️ `roots` 与 `now` 都从参数进，理由与 listSubtitleQueue 自己一致：
 *  · roots：字幕队列的取件要按可写守备目录过滤（daemon 侧传 writableRoots()）。
 *    dashboard 侧拿不到 daemon 的那份计算结果，故由 server.ts 的 wiring 决定传什么；
 *    **不传 = 不过滤**，那是诚实的降级（多列几个作品，不会少列），不是 bug。
 *  · now：退避窗（recheck_after / tr_recheck_after）的判定基准，注入才测得了边界。
 *
 * 排序沿用两个 list 函数的既有顺序（work_id/season/episode），**不在这里重排**：
 * 重排等于给用户一个与 daemon 实际取件顺序不同的"队列"，而这一页的全部意义就是
 * "系统接下来会干什么"。
 */
export function buildActivity(
  db: ScoutDb,
  opts: { roots?: string[]; now?: number } = {},
): ActivityDTO {
  const now = opts.now ?? Date.now()

  // ── 字幕台 ──────────────────────────────────────────────────────────────
  // listSubtitleQueue 已按 work_id 聚合成"一个作品一项"（R-F4 的粒度天然一致），
  // 每项的 files.length 就是这轮这个作品有几集在等。
  //
  // 🔴 `includeBackoff: true`——本端点问的是「**还有什么在等**」，不是「现在该取哪件」。
  // 生产实测（2026-08-13）：33 个文件满足归属谓词，其中到点可取 **0**（全在退避窗，
  // 最早约 16h 后）。默认模式下本端点返回空数组 → 界面说「已排队 0 / 没有排队的作品」，
  // 而那是一句假话。谓词没有第二份，`includeBackoff` 只短路第三条，见 subtitleScheduler
  // 里 SUBTITLE_QUEUE_WHERE 的论证。
  const subtitleItems = listSubtitleQueue(db, opts.roots, now, { includeBackoff: true })

  // ── 翻译台 ──────────────────────────────────────────────────────────────
  // listNewTranslateCandidates 是**逐文件**的（翻译是每集一个 LLM session），
  // 而 R-F4 要求活动页粒度 = 作品 → 在这里按 workId 折叠，计数落到 pendingFileCount。
  // 折叠时保序（Map 保插入序，而该函数已按 work_id/season/episode 排好）。
  const translateByWork = new Map<string, number>()
  for (const c of listNewTranslateCandidates(db, now)) {
    translateByWork.set(c.workId, (translateByWork.get(c.workId) ?? 0) + 1)
  }

  const faces = loadWorkFaces(db, [
    ...new Set([...subtitleItems.map((i) => i.workId), ...translateByWork.keys()]),
  ])

  /** 作品身份缺席时的降级：**照样出这一项**，只是图为 null、标题回落到队列项自带的那个。
   *  为什么不 filter 掉：files.work_id 有值却 works 里查不到，说明库处在一个不该有的状态；
   *  把这一项静默丢掉会让用户看到的队列比 daemon 实际要跑的短，而"少了一部"这件事
   *  在界面上无从察觉。宁可画一张无图卡片。 */
  const project = (
    workId: string, fallbackTitle: string, pendingFileCount: number,
    due: { dueNow: boolean; retryAfter: number | null },
  ): ActivityQueueItemDTO => {
    const f = faces.get(workId)
    return {
      workId,
      title: f?.title ?? fallbackTitle,
      chineseTitle: f?.chineseTitle ?? null,
      year: f?.year ?? null,
      mediaType: f?.mediaType ?? 'tv',
      posterPath: f?.posterPath ?? null,
      backdropPath: f?.backdropPath ?? null,
      pendingFileCount,
      dueNow: due.dueNow,
      retryAfter: due.retryAfter,
    }
  }

  return {
    subtitleQueue: subtitleItems.map((i) =>
      project(i.workId, i.title, i.files.length, {
        dueNow: queueItemDueNow(i, now),
        retryAfter: queueItemEarliestRetryAt(i, now),
      }),
    ),
    // 🔴 翻译台恒 `dueNow: true`，这**不是**偷懒的常量：`listNewTranslateCandidates`
    // 的谓词里 `tr_recheck_after` 那一条**没有**被短路（它没有 includeBackoff 形参），
    // 所以它返回的每一行按定义都已到点。给一个不成立的 false 才是假话。
    // ⚠️ 代价如实记：翻译台因此仍有与字幕台同型的空态歧义（全在退避窗时说"0 个在等"）。
    // 未修，见报告"发现但没修"——修它要动 translateWorkerTask 的取件谓词，那是另一条链。
    translateQueue: [...translateByWork.entries()].map(([workId, n]) =>
      project(workId, workId, n, { dueNow: true, retryAfter: null }),
    ),
  }
}
