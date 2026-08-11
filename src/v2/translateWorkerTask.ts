// E AI 翻译。本文件现在有两批住户,分界线在下方"新架构翻译工作台"那道横线:
//
// ① 新架构（活的,第 4 步接线,daemonV2 的 translate 循环用）:
//    listNewTranslateCandidates / applyTranslateOutcome / FETCHABLE_SOURCE_LANGS /
//    EXTRACTABLE_SOURCE_LANGS —— 读 files/works,状态机在 sub_status=handoff_translate +
//    tr_attempt/tr_recheck_after 上。
// ② runTranslateWorkerTask:claims-and-runs 一行 jobs 表 worker_task(镜像 rescueWorkerTask
//    形状)。installed→done+踢 ingest;held/extract-failed→completeError(可重试,fail-closed
//    不装);already-covered/no-embedded→done(无事可做)。它仍被 cli/index.ts 的
//    handleWorkerTask translate 分支调用——而 handleWorkerTask 本身是零调用者孤儿(见
//    cli/index.ts 该函数头注释),所以这条路径今天也不跑;jobs 队列整体退役是独立决策。
//
// 第 7 步删掉的旧世界两件套（原 ① ②,勿再照抄任何残留注释）:
//    · listTranslateCandidates —— 双重死亡:查 episodes/movies JOIN series(旧表),且谓词
//      sub_status='unavailable' 是 R17 废止的第五态(3-2 拆掉唯一写入点、v33 迁移洗掉存量行),
//      在今天的库上永远选不出行。连带 isChineseTag/hasNonChineseTrack/isSupportedSourceLang
//      三个私有辅助与 TranslateCandidate 接口一并随之零引用。
//    · dispatchTranslateTasks(+ TRANSLATE_DONE_RECHECK_MS) —— 它的迭代源只有上面那一个,
//      而它自己也零生产调用者(唯一调用点是旧 daemon 的 dispatchTranslate 钩子,随
//      src/v2/daemon.ts 于第 7 步 B 组删除)。留个恒 return 0 的空壳比删掉更糟。
import type { ScoutDb } from './db.js'
import type { Job, JobsRepo } from './jobsRepo.js'
import type { RunsRepo } from './runsRepo.js'
import { translateItemId } from './ownIds.js'
import { traceBus } from '../core/traceBus.js'
import { recordFound } from './notificationsRepo.js'

/** runItem 的报告形状(legacy translate/translateItem.ts 已随审计 D 波退役——类型就地定义,
 *  与 cli/translateItemCommand.ts 的 DaemonTranslateRunItemResult 同构)。 */
export interface TranslateRunItemResult {
  status:
    | 'installed' | 'held' | 'no-source' | 'extract-failed'
    | 'no-embedded' | 'already-covered' | 'write-failed' | 'probe-failed'
  sidecarPath?: string
  reason?: string
  sourceRef?: string
  llmCalls?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 源语言集合的**唯一定义处**（C31 末段 / 第 4 步任务 G 的口径收敛）。
//
// 为什么必须是**两个**集合而不是一个（这就是 C31 记的那处口径不一）：
//  · FETCHABLE  = 能从 provider **抓到外挂源语言字幕**的语言。MVP 仅 en——OpenSubtitles
//    靠 imdb 精确命中；日语要等 F2 的 jimaku 落地（C6）。
//  · EXTRACTABLE = 能**抽内嵌文本轨**的语言。en/ja 皆可——抽轨是纯本地 ffmpeg 操作、
//    零 provider 依赖，天然比抓取宽。
// 原 `SUPPORTED_SOURCE_LANGS = ['en','ja']` 把这两件事混成一个集合，spec 正文却写"MVP 仅 en"
// ——两处都不算错，它们说的是不同的事，混在一起才是错。合成一个的后果各有一半是错的：
// 取 ['en'] 会判死一抽轨就能救的日漫（C31）；取 ['en','ja'] 会让**无内嵌轨**的日漫被判可救
// → 移交翻译流 → 翻译流发现抓不到日文源 → unsolvable，白绕一圈 7 天（C24 想省的正是这种绕路）。
//
// 收敛方向是"3-2 建的那两个搬过来、旧的那一个变成派生量"，而不是反过来：3-2 的
// `TRANSLATABLE_LANGS`（daemonV2.ts）是 judge 的真实喂料、语义已经拆对了；本文件这个是
// 混的。故这里放定义，daemonV2 与 judge 从这里 import。
//
// F1/R13/R18 铁原则不变：只做"源语言→中文"单跳直译，永不中继（JP→EN→CN 丢义严重，
// 用户 2026-08-08 以 R18 重新拍板废止 eng 兜底）。值域 = TMDB original_language 小写码，
// 比对方负责 lower+trim 防脏值。
// ─────────────────────────────────────────────────────────────────────────────

/** 能抓到外挂源语言字幕的语言（MVP 仅 en，靠 imdb 命中）。 */
export const FETCHABLE_SOURCE_LANGS = ['en']

/** 能抽内嵌文本轨的语言（纯本地 ffmpeg，故比抓取宽）。 */
export const EXTRACTABLE_SOURCE_LANGS = ['en', 'ja']

/** 翻译流整体能处理的源语言 = 两条腿的并集（派生量，**不是第三份定义**）。
 *
 *  为什么保留这个名字而不是就地改掉所有调用点：它今天有一个**语义正确**的消费者——
 *  `cli/fetchSourceSub.ts` 的语言门。那个门看似属于"抓取腿"（照 FETCHABLE 就该是 ['en']），
 *  但它实际是 `resolveSource` 在**抽轨失败之后**调的兜底腿，而 resolveSource 的 ja 分支
 *  会先试日文内嵌轨、抽不到才 fetch（resolveSource.ts:56-72）。把那个门收窄到 ['en'] 会让
 *  ja 分支的 fetch 调用变成永远返回 null 的死代码 —— 那不是"收敛口径"，是**砍掉一条腿**，
 *  且会让 F2 的 jimaku 落地时无处接入（届时只需把 jimaku adapter 挂进 fetch，语言门已经通）。
 *  fetchSourceSub.test.ts 有一条用例正钉着"origin ja 过门、search languages=[ja]"，
 *  它断言的是这个设计意图，不是实现细节。故这里改的是**定义的组织方式**（一份变量、
 *  语义写清、拆出两个精确集合），不是任何一处的行为。 */
export const SUPPORTED_SOURCE_LANGS = [...new Set([...FETCHABLE_SOURCE_LANGS, ...EXTRACTABLE_SOURCE_LANGS])]

// ─────────────────────────────────────────────────────────────────────────────
// 新架构翻译工作台（spec §2「翻译工作流」+ §5 映射表 / C3 + D3 + D6 + D10 + R24）
// ─────────────────────────────────────────────────────────────────────────────

/** 翻译轨的退避步长 = 1 天（spec §5：held 等失败态 `tr_recheck_after=明天`）。
 *  成功态（installed/already-covered）**同样用它出队**——见 applyTranslateOutcome 的 D6 论证。 */
export const TRANSLATE_RECHECK_MS = 24 * 3_600_000

/** held / extract-failed / probe-failed / write-failed 的失败额度，满即转 unsolvable（spec §5）。
 *
 *  为什么四种状态**共用一个额度**而不是各记一套：它们是同一件事的不同表征——"这个文件
 *  翻译流搞不定"。分开记的话一个交替出现 held / extract-failed 的文件每种都攒不满，
 *  永远停在退避轨上每天烧一个付费 LLM session（旧世界的实案就是这个形状：
 *  job29 重试 11 次全同样错误）。 */
export const TRANSLATE_HELD_LIMIT = 3

/** 停牌行的复查窗（转 unsolvable 时写进 `recheck_after`，供阶段 2.6 复查闸取件）。
 *  与 subtitleScheduler 的 PARK_RECHECK_MS 同值（7 天 / R25「每周找一次」）——刻意**不 import**
 *  那个私有常量，两条轨各自声明自己的节奏；同值是巧合而非契约（字幕轨改周期不该连带改翻译轨）。 */
export const TRANSLATE_PARK_RECHECK_MS = 7 * 24 * 3_600_000

/** 新架构的一个翻译活。 */
export interface NewTranslateCandidate {
  /** `<work_id>/<sha1(path)前12>`，**唯一构造入口是 ownIds.translateItemId**（C20）。 */
  itemId: string
  videoPath: string
  workId: string
  title: string
  /** works.origin_lang（TMDB 两字母码），NULL=未刮到。单跳选源要用。 */
  originLang: string | null
}

/** 翻译工作台（spec §2）：`sub_status='handoff_translate'` 且 `tr_recheck_after` 到点。
 *
 *  ── 为什么谓词必须是这三条，逐条对应一处曾经/可能的静默失效 ──
 *  ① `sub_status = 'handoff_translate'`：旧谓词是 `sub_status='unavailable'`，而那个第五态
 *     已被 R17 废止（3-2 拆写入点、v33 洗存量）→ 旧翻译流从第 2 步起**零候选静默饿死**
 *     （C34 明记这个窗口期）。这一条就是把翻译接回来的那一行。
 *  ② `tr_recheck_after IS NULL OR <= now`：NULL 的语义在 v37 迁移里写死了 = "从没被翻译流
 *     碰过" = 立刻可领。**照字面只写 `<= now` 会让全部新行永不命中**（NULL 上的比较是
 *     三值逻辑的 unknown）→ 又一次"加了列但谓词读不到"的静默失效，本仓栽过五次（C12/C35/
 *     D17/D18/D22）。反过来漏了 `<= now` 这一半就是 D6 要防的付费 LLM 热循环。
 *  ③ `INNER JOIN works`：没有 work_id 就构造不出合法 itemId（第一段就是 work_id）。
 *     LEFT JOIN + 占位值会让 glossary key 退化成每文件一个（C20 的实质伤害），
 *     而那是纯质量漂移、没有任何断言会红。故未识别行整行不取。
 *
 *  **不做可救性预筛**（不看 origin_lang / embedded_langs）：那是 judge 在阶段 2.5 的活
 *  （R21/D9 的 translatable 列），能进 handoff_translate 就意味着 judge 已判 translatable=1。
 *  在这里再判一次是第二份实现，两份漂移时没人知道该信哪个。 */
export function listNewTranslateCandidates(db: ScoutDb, now: number): NewTranslateCandidate[] {
  const rows = db.prepare(
    `SELECT f.path AS path, f.work_id AS workId, w.title AS title, w.origin_lang AS originLang
       FROM files f JOIN works w ON f.work_id = w.id
      WHERE f.sub_status = 'handoff_translate'
        AND (f.tr_recheck_after IS NULL OR f.tr_recheck_after <= ?)
      ORDER BY f.work_id, f.season, f.episode, f.path`,
  ).all(now) as Array<{ path: string; workId: string; title: string; originLang: string | null }>
  return rows.map((r) => ({
    // 🔴 唯一构造入口（C20 + 4-2 的交接）：**不许在这里手拼** `${r.workId}/${...}`。
    // C20 的既有红线用例测的是构造器 translateItemId 本身，手拼一份同形字符串它们一条都不会红
    // ——直到某天两份形态漂移（比如有人在这里改成拼 basename），同剧术语表继承静默断掉。
    itemId: translateItemId(r.workId, r.path),
    videoPath: r.path,
    workId: r.workId,
    title: r.title,
    originLang: r.originLang,
  }))
}

/** applyTranslateOutcome 的回执。 */
export interface TranslateOutcomeWrite {
  /** 乐观守卫（D10）匹配 0 行 = 这几分钟里扫描已经改过状态，本次回写整个作废。
   *  **必须可观察**：否则"翻译回写被静默丢弃"这件事在日志和库里都留不下痕迹，
   *  而它同时意味着 tr_recheck_after 没写上 → D6 要防的热循环从侧门回来（C32 原话）。 */
  guardMissed: boolean
  /** 落库后的 sub_status（守卫未命中时是库里的现值）。供调用方记日志。 */
  status: string
}

/** 把一次 worker 报告按 §5 映射表落库，**全部回写带乐观守卫**（D10）。
 *
 *  ── D10：为什么每一条 UPDATE 都要 `WHERE sub_status='handoff_translate'` ──
 *  翻译流的形状是 SELECT → `await` LLM（**数分钟**）→ UPDATE。这几分钟里扫描可能已经扫到
 *  磁盘上出现了中文字幕并写了 `covered`（R24：扫描独占 covered）。无守卫的回写会把那个
 *  **磁盘事实**覆盖成 handoff_translate / unsolvable → 界面显示停牌，而字幕明明已经在盘上了。
 *  守卫让"世界变了"这件事表现为 changes===0，而不是表现为一次静默的事实覆盖。
 *
 *  ── D6 + R24：为什么 installed **不写 covered、却必须写 tr_recheck_after** ──
 *  不写 covered：sub_status 是"磁盘上现在什么情况"的投影，worker 只负责把文件放上去，
 *  有没有由扫描说了算（R23/R24）。翻译报 installed 而写盘其实失败的情况真实存在
 *  （权限/满盘/原子改名失败），直接写 covered 就是让系统相信一个没被验证的成功。
 *  必须写 tr_recheck_after：这条是 D6 的红线。成功后状态**仍是** handoff_translate
 *  （要等扫描确认），于是它**依然满足工作台谓词**——不写出队时刻的话，主进程内独立循环
 *  下一圈（几秒后）立刻重领同一行，每圈一个付费 LLM session。R24 删掉 covered 写入之后
 *  "出队"的唯一凭据就只剩这一列了（C26 记的正是这个链条）。 */
export function applyTranslateOutcome(
  db: ScoutDb,
  videoPath: string,
  status: TranslateRunItemResult['status'],
  now: number,
): TranslateOutcomeWrite {
  const GUARD = ` AND sub_status = 'handoff_translate'`
  let changes = 0

  if (status === 'installed' || status === 'already-covered') {
    // 成功轨：状态一列不动（等扫描确认 / R24），清失败额度，写出队时刻（D6）。
    //
    // **并且把 sub_recheck_at 拉到"立即到点"**（第 8 步 live test 第五轮实测缺陷，字幕轨
    // 已在 subtitleScheduler.markInstalled 修过同一条，见 commit 12e4ab6）。不拉的话这一行
    // 既不在扫描 A 档（翻译不改视频指纹）也不在 B 档（上一轮 A 档已把 recheck 推到 now+7 天）
    // → 翻译装好的字幕要等 7 天才被观察成 covered，这 7 天里它 sub_status 仍非 covered，
    // 于是继续满足工作台谓词、被反复重找/重翻，白烧付费 LLM。
    //
    // 这条轨比字幕轨更隐蔽：daemonV2 在 installed 后**已经**调了 requestIngest() 踢扫描
    // （注释写着"新 sidecar 越早被扫到、covered 越早落库"），但踢的那轮扫描两档谓词同样
    // 选不中它——**踢了扫描而扫描什么都不看**，这条衔接一直是装饰性的。
    //
    // 哨兵取 0 而非 now-1：这一列的唯一读者是 daemonV2 的 B 档谓词 `sub_recheck_at <= ?`，
    // 喂的是可注入时钟 deps.now()；写者这里的 now 来自调用方。两个时钟源不同源时
    // （测试注入 2001 年、读者用真实时间）now-1 对读者是"未来 25 年"→ 谓词永不命中，
    // 而单元测试全绿。0 在任何时钟源下都已过期，且被观察后由 observeSubtitle 推回 +7 天，
    // 天然自清除。**不写 NULL**（D18：NULL 行永不命中 `<= now`）。
    changes = db.prepare(
      `UPDATE files SET tr_attempt = 0, tr_recheck_after = ?, sub_recheck_at = 0, updated_at = ?`
      + ` WHERE path = ?${GUARD}`,
    ).run(now + TRANSLATE_RECHECK_MS, now, videoPath).changes
  } else if (status === 'no-source' || status === 'no-embedded') {
    // 诚实无源 → 停牌。**必须同时写 recheck_after**（不是 tr_recheck_after）：
    // 阶段 2.6 复查闸的取件谓词是 `recheck_after IS NOT NULL AND recheck_after <= now`
    // （daemonV2.reviewParkedOnce），只写 tr_recheck_after 的话这一行再也不会被任何闸门看见
    // → R26"无永久终态"被静默破坏，那一集永远不再被找字幕。状态列断言看不出这一条。
    changes = db.prepare(
      `UPDATE files SET sub_status = 'unsolvable', tr_recheck_after = ?, recheck_after = ?, updated_at = ?`
      + ` WHERE path = ?${GUARD}`,
    ).run(now + TRANSLATE_RECHECK_MS, now + TRANSLATE_PARK_RECHECK_MS, now, videoPath).changes
  } else {
    // 失败退避轨（held / extract-failed / probe-failed / write-failed）：额度+1，退避到明天；
    // 满额转 unsolvable。分流在 SQL 里用 CASE 一条语句做完，而不是"先 SELECT 再判再 UPDATE"：
    // 后者在两步之间掉电（软路由掉电是本项目常态）会留下"读了但没写"的半状态，且那个 SELECT
    // 读到的 sub_status 与 UPDATE 的守卫之间还有一道竞态缝——守卫的意义就是让判断与写入原子。
    changes = db.prepare(
      `UPDATE files SET tr_attempt = tr_attempt + 1,
              sub_status = CASE WHEN tr_attempt + 1 >= ? THEN 'unsolvable' ELSE sub_status END,
              recheck_after = CASE WHEN tr_attempt + 1 >= ? THEN ? ELSE recheck_after END,
              tr_recheck_after = ?, updated_at = ?
        WHERE path = ?${GUARD}`,
    ).run(
      TRANSLATE_HELD_LIMIT, TRANSLATE_HELD_LIMIT, now + TRANSLATE_PARK_RECHECK_MS,
      now + TRANSLATE_RECHECK_MS, now, videoPath,
    ).changes
  }

  const row = db.prepare('SELECT sub_status FROM files WHERE path = ?').get(videoPath) as
    { sub_status: string | null } | undefined

  // ── R-F3：通知流水（通知页的持久化数据源）──────────────────────────────────
  // 翻译装盘成功同样是"找到了字幕"——对用户而言"从哪来的"是实现细节，结果都是"这一集现在
  // 有中文字幕了"，故与抓源装盘**同走一条流水**（通知页不分两个池子，同 daemonV2 的 found
  // 事件口径）；但 via 列如实记 'translate'，因为机翻与抓来的质量期望不同，用户看到
  // 「翻译完成」时对质量的预期应该被如实告知。
  //
  // 三个门必须同时成立，逐条对应一种"会谎报成果"的形态：
  //  ① `status === 'installed'` —— **不含 already-covered**：那是"字幕本来就在盘上"，
  //     不是这一轮的新成果，报它等于每轮巡检都往通知页灌一条同文。
  //  ② `changes > 0`（乐观守卫 D10 命中）—— 守卫匹配 0 行意味着这几分钟里扫描已经改过
  //     sub_status，**本次回写整个作废**。回写作废却报"找到了"，是通知页上一条凭空的成果。
  //  ③ `work_id`/`title` 齐备 —— 未识别文件没有作品维度可展示（通知页按作品+季聚合）。
  //
  // 为什么在这里补一次查询（多一次 SELECT）：季集号与标题必须取自**库里的事实**
  // （files.season/episode + works.title），而 applyTranslateOutcome 的入参只有 videoPath。
  // 从路径反解文件名是识别层的活，在这里再来一份正则就是第二份实现。这条 SELECT 只在
  // installed 且守卫命中时才跑（翻译轨一天几个活的量级），不在任何热路径上。
  if (status === 'installed' && changes > 0) {
    try {
      const meta = db.prepare(
        `SELECT f.season AS season, f.episode AS episode, f.work_id AS workId, w.title AS title
           FROM files f JOIN works w ON f.work_id = w.id
          WHERE f.path = ?`,
      ).get(videoPath) as { season: number | null; episode: number | null; workId: string; title: string } | undefined
      if (meta) {
        recordFound(db, {
          workId: meta.workId, title: meta.title,
          season: meta.season, episode: meta.episode, via: 'translate',
        }, now)
      }
    } catch {
      // 吞掉：recordFound 自己已整体 try/catch，这一层兜的是上面那条 SELECT
      // （表缺失/JOIN 意外）。通知是增益，绝不许反噬翻译回写——回写没写上的代价是
      // D6 的付费 LLM 热循环。
    }
  }

  return { guardMissed: changes === 0, status: row?.sub_status ?? '(row gone)' }
}

export interface TranslateWorkerTaskDeps {
  /** 端到端翻译一个视频(workspace agent 报告;状态集含 probe-failed——else 分支同样走
   *  completeError,语义对齐)。 */
  runItem: (videoPath: string) => Promise<TranslateRunItemResult>
  /** installed 后踢一脚 ingest,让新 sidecar 尽快记账成 covered(镜像 rescue 的先例)。 */
  requestIngest?: () => void
  runs?: Pick<RunsRepo, 'insert'>
}

export async function runTranslateWorkerTask(
  job: Job,
  deps: TranslateWorkerTaskDeps,
  jobs: Pick<JobsRepo, 'completeDone' | 'completeError' | 'completeHeld' | 'park'>,
  now: () => number,
): Promise<void> {
  const startedAt = now()
  // 审计 UX-P0:翻译 run 的 trace 快照落库(此前恒 null,RunDetail 回放永远空白)。
  // 与 findSubtitleWorkerTask 的 G3 同款:traceBus.snapshot 有清空副作用,一次任务收官只取一次,
  // 多行 recordRun 共享同一份(held 与 installed 只会写一行,但 catch 路径可能补写,语义一致)。
  const runKey = `job-${job.id}`
  let traceJsonCache: string | null | undefined
  const traceJsonForThisRun = (): string | null => {
    if (traceJsonCache === undefined) {
      const events = traceBus.snapshot(runKey)
      traceJsonCache = events.length > 0 ? JSON.stringify(events) : null
    }
    return traceJsonCache
  }
  const recordRun = (decision: string, detail: string, llmCalls = 0): void => {
    deps.runs?.insert({
      jobId: job.id, startedAt, finishedAt: now(), decision, detail: detail.slice(0, 200), journalPath: null,
      llmCalls,
      traceJson: traceJsonForThisRun(),
    })
  }

  let videoPath: string | undefined
  try {
    const payload = JSON.parse(job.payload ?? '{}') as Record<string, unknown>
    if (typeof payload.videoPath === 'string' && payload.videoPath) videoPath = payload.videoPath
  } catch { /* fallthrough 到下方缺 videoPath 处理 */ }
  if (!videoPath) {
    jobs.completeError(job.id, `translate job ${job.id} payload 缺 videoPath`, now())
    return
  }

  try {
    const r = await deps.runItem(videoPath)
    const llmCalls = r.llmCalls ?? 0
    if (r.status === 'installed') {
      jobs.completeDone(job.id, now())
      // F1:sourceRef(外挂搜索腿的 'provider:id')进 detail 供追溯;内嵌轨腿无此值,不加尾巴。
      recordRun('translate:installed', `${videoPath} → ${r.sidecarPath ?? '?'}${r.sourceRef ? ` (source: ${r.sourceRef})` : ''}`, llmCalls)
      deps.requestIngest?.()
    } else if (r.status === 'already-covered' || r.status === 'no-embedded' || r.status === 'no-source') {
      // 候选预筛与现场重探之间世界变了(有人装了字幕/轨其实不可抽)——无事可做,不算错。
      // no-source(F1)同口径:外挂搜索穷尽也没有=诚实无源;unavailable 的衰减复查会周期性再给机会。
      jobs.completeDone(job.id, now())
      recordRun(`translate:${r.status}`, videoPath, llmCalls)
    } else if (r.status === 'held') {
      // held(fail-closed 质量闸拦下):衰减重试(用户裁决 2026-07-22——首周每天,然后隔三差
      // 五,之后周级;模型 nondeterministic 值得再给机会,但绝不热循环烧配额)。
      // 同签名熔断:同一 held 失败签名反复出现 = 模型对这条字幕系统性过不了闸,衰减重试只烧配额
      // 不产结果(job29 重试 11 次全同样错误实案)→ park 成 dormant,转人工审查(不再自动重试)。
      const heldError = `translate held: ${r.reason ?? ''}`
      const prevSig = (job.last_error ?? '').slice(0, 80)
      const newSig = heldError.slice(0, 80)
      if (job.last_error !== null && prevSig === newSig) {
        jobs.park(job.id, `translate held 签名重复,转人工审查: ${r.reason ?? ''}`, now())
        recordRun('translate:held-parked', `${videoPath} 同签名熔断: ${r.reason ?? ''}`, llmCalls)
      } else {
        jobs.completeHeld(job.id, heldError, now())
        recordRun('translate:held', `${videoPath} ${r.reason ?? ''}`, llmCalls)
      }
    } else {
      // extract/write 失败:诚实失败,completeError 走瞬时退避梯。
      jobs.completeError(job.id, `translate ${r.status}: ${r.reason ?? ''}`, now())
      recordRun(`translate:${r.status}`, `${videoPath} ${r.reason ?? ''}`, llmCalls)
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    jobs.completeError(job.id, msg, now())
    recordRun('error', msg, 0)
  }
}
