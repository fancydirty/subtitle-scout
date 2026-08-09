// src/v2/daemonV2.ts：新架构 daemon（巡检模型）。
// spec: docs/design/2026-08-08-daemon-inspection-model.md
//
// 用户裁决：工作台语义是"有活就一直跑，跑完歇，明天再巡检"（对齐 Jellyfin 库扫描频率），
// **不是 30s tick 轮询**（旧架构 orchestrator 残留思维）。
//
// 每天一次巡检（距上次满 24h）：
//   阶段 1：机械扫描守备目录 → files 表（新文件入库，指纹跳过）
//   阶段 2：识别工作流（上游）——识别工作台有活就一直跑，跑空才进下一步
//   阶段 2.5：judge（B-1 补齐）——识别绑定后判 needs_subtitle
//   阶段 3：字幕工作流（下游）——字幕工作台有活就一直跑，跑空才结束
//   阶段 4：停，歇着，等明天
import { walkVideoFiles } from '../daemon/selfScan.js'
import { statSync } from 'node:fs'
import { toMediaFileRow, isScannable } from './scanner.js'
import type { ScoutDb } from './db.js'
import { listIdentifyQueue, runIdentifyWorkDir, type IdentifySchedulerDeps } from './identifyScheduler.js'
import { listSubtitleQueue, runSubtitleWorkDir, type SubtitleQueueItem } from './subtitleScheduler.js'
import { judgeSubtitle } from './subtitleJudge.js'
import { langOf } from '../agent/languages.js'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, basename } from 'node:path'
import { isDirWritable } from '../core/mediaContext.js'
import { SettingsRepo } from './settingsRepo.js'
import type { EmbeddedSubtitleTrack } from '../files/streamProbe.js'
import { mapWithConcurrency } from './probeConcurrency.js'

export const INSPECT_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface DaemonV2Deps {
  db: ScoutDb
  roots: string[]
  identify: IdentifySchedulerDeps
  subtitleWorker: (task: import('../agent/findSubtitleWorker.schemas.js').FindSubtitleTask) => Promise<import('../agent/findSubtitleWorker.schemas.js').FindSubtitleBatchReport>
  targetLanguage: string
  /** 只读根缓存（115 测试目录——字幕派发会 ENOENT，识别照常）。检测一次缓存。 */
  writableRoots?: Map<string, boolean>
  log: (msg: string) => void
  /** 测试注入：距上次巡检满这个时间才算到点。默认 INSPECT_INTERVAL_MS。 */
  inspectEveryMs?: number
  now?: () => number
  /** 测试注入：遍历一个守备目录。默认 walkVideoFiles。
   *  抽成注入点是删除逻辑的刚性需求——R8 的两种"不许删"场景（目录不可访问 / 目录看起来是空的）
   *  在真实文件系统上无法稳定复现，而这两条正是"一次删光全库"的唯一防线。 */
  listVideoFiles?: (root: string) => string[]
  /** 测试注入：stat 一个文件。默认 statSync；返回 null 视为不可 stat。 */
  statFile?: (p: string) => { mtimeMs: number; size: number } | null
  /** C12：内嵌字幕轨探针。**必须可注入**——这是 spawn ffprobe 的重 IO，测试里从不真的跑
   *  （同 IngestDeps.probe 的既有约定）。缺省时退化成"只入库、不探测"：探测是增益，
   *  绝不能因为构造点忘了接线就让阶段 1 整个失效。
   *
   *  返回值三态由 streamProbe.ts 的契约定死，**消费方不许折叠**：
   *  null = 探测不可用（二进制缺席/超时/损坏）；[] = 探过、容器里确实零字幕轨。 */
  probe?: (videoPath: string) => Promise<EmbeddedSubtitleTrack[] | null>
  /** C12：时长探针（复用 files/streamProbe.ts 的 probeDurationSec，不是第二份实现）。 */
  probeDuration?: (videoPath: string) => Promise<number | null>
  /** 跨文件探针并发上限。默认 2 沿用 IngestDeps.probeConcurrency 的实测结论：阿里云盘经
   *  rclone WebDAV 的单文件 ffprobe 是 12-16s（~12s 是 CDN 延迟地板，串行不可优化），
   *  并发才买得到吞吐；而 CIFS NAS 上探针只 1.09s，高并发只是白白放大挂载压力。 */
  probeConcurrency?: number
}

/** C11 换片源时该清空的状态列（**意图声明**，不是 schema 快照）。
 *
 *  实际清哪些列 = 本表 ∩ `PRAGMA table_info(files)`。为什么必须取交集而不是直接写 SQL：
 *  `sub_attempt` / `translatable` 归 spec 第 3 步加列，今天的库里还没有，硬编码进 SQL 会让
 *  本轮扫描整个抛错；反过来，若只写"今天有的列"，第 3 步加完列的那天就**静默漏清**——
 *  本仓已经三次栽在"写了某列却没定谁来写/谁来读"这一模式上（C12 → C35 → D17），
 *  取交集是让这份名单先于 schema 存在、加列即自动生效的唯一办法。
 *
 *  为什么 needs_subtitle 也在名单里（spec 的 C11 与 §4 第 1b 步用例清单在这一列上自相矛盾，
 *  已报告未改 spec；用户裁决取 C11）：D8 说 needs_subtitle 表达"原则上需要中文字幕"、
 *  **装盘**不改它——它防的是 C19 那种"装盘/手删字幕改判决"的卡死，而换片源恰恰改变了
 *  needs_subtitle 赖以成立的事实本身（新片源可能自带中文轨）。更硬的理由：我们同一次就把
 *  embedded_langs 清成 NULL 了，清掉证据却留着据此做出的判决，正是 D17 点名的同型缺陷——
 *  judge 谓词是 `needs_subtitle IS NULL`，留着旧值就等于这一行永不重判。
 *  真实剧本：旧 720p 自带中文内嵌轨 → needs_subtitle=0(embedded)；换成无中文轨的 1080p 后
 *  仍是 0 → 永远不补字幕，与 C11 自己描述的失效场景是同一个洞的另一扇门。
 *
 *  work_id **不在**名单里（C11 明写"同路径通常仍是同作品"）：换片源不改身份，清了就是
 *  白烧一整轮识别 LLM。 */
const FINGERPRINT_RESET_COLUMNS = [
  'needs_subtitle',   // judge 的重判凭据（谓词 IS NULL）
  'sub_status',       // 磁盘当前有没有字幕（D8）——换了文件，旧结论作废
  'sub_attempt',      // 第 3 步加。残留 = 新片源自带失败额度，提前进停牌
  'translatable',     // 第 3 步加。基于旧文件内嵌轨算出的可救性，证据已清，判决必须跟着清
  'recheck_after',    // 未来时刻的退避会把新文件挡在字幕工作台外
] as const

export class ScoutDaemonV2 {
  private stopping = false
  private writableCache: Map<string, boolean>

  constructor(private deps: DaemonV2Deps) {
    this.writableCache = deps.writableRoots ?? new Map<string, boolean>()
  }

  async run(signal: AbortSignal): Promise<void> {
    signal.addEventListener('abort', () => { this.stopping = true }, { once: true })

    while (!this.stopping) {
      const now = this.deps.now?.() ?? Date.now()
      const lastInspectAt = this.readLastInspectAt()
      const everyMs = this.deps.inspectEveryMs ?? INSPECT_INTERVAL_MS

      if (now - lastInspectAt >= everyMs) {
        this.deps.log(`巡检开始 (距上次 ${lastInspectAt === 0 ? '(冷启动)' : `${Math.round((now - lastInspectAt) / 3600000)}h`})`)
        try {
          await this.runInspection(signal)
        } catch (e) {
          this.deps.log(`巡检失败（隔离，下轮重试）: ${String(e)}`)
        }
        this.writeLastInspectAt(this.deps.now?.() ?? Date.now())
        this.deps.log('巡检完成，歇着等明天')
      }

      if (this.stopping) break
      // "歇着"：每 5min 检查一次是否到 24h（不是轮询工作台，是轮询时间闸）
      await sleep(5 * 60 * 1000, signal)
    }
  }

  /** 一轮完整巡检：扫描 → 识别跑空 → judge → 字幕跑空。 */
  private async runInspection(signal: AbortSignal): Promise<void> {
    // 阶段 1：机械扫描
    await this.scanOnce()

    // 阶段 2：识别工作流（上游）——有活跑到空
    let identifyRounds = 0
    while (!this.stopping) {
      const queue = listIdentifyQueue(this.deps.db, this.deps.now?.() ?? Date.now())
      if (queue.length === 0) break
      identifyRounds++
      const item = queue[0]
      this.deps.log(`识别 ${item.workDir} (${item.fileCount} 文件, 第 ${identifyRounds} 个)`)
      await runIdentifyWorkDir(this.deps.identify, item)
    }

    // 阶段 2.5：judge（B-1）——识别绑定后判 needs_subtitle
    await this.judgeOnce()

    // 阶段 3：字幕工作流（下游）——有活跑到空
    let subtitleRounds = 0
    while (!this.stopping) {
      const wRoots = this.writableRoots()
      const queue = listSubtitleQueue(this.deps.db, wRoots, this.deps.now?.() ?? Date.now())
      if (queue.length === 0) break
      subtitleRounds++
      const item = queue[0]
      this.deps.log(`字幕 ${item.title} (${item.files.length} 文件, 第 ${subtitleRounds} 个)`)
      await runSubtitleWorkDir(this.deps.db, this.deps.subtitleWorker, item, this.deps.targetLanguage)
    }
  }

  /** 只读根过滤：字幕只在可写根内派发（115 只读跳过）。 */
  private writableRoots(): string[] {
    const out: string[] = []
    for (const root of this.deps.roots) {
      if (!this.writableCache.has(root)) {
        this.writableCache.set(root, isDirWritable(root))
      }
      if (this.writableCache.get(root)) out.push(root)
    }
    return out
  }

  /** judge 阶段：对已识别但未判定的文件跑 judgeSubtitle（国产/内嵌/sidecar 跳过）。 */
  private async judgeOnce(): Promise<void> {
    const db = this.deps.db
    const now = this.deps.now?.() ?? Date.now()
    const rows = db.prepare(`
      SELECT f.path, f.filename, f.embedded_langs, f.work_id, w.origin_lang
      FROM files f LEFT JOIN works w ON f.work_id = w.id
      WHERE f.work_id IS NOT NULL AND f.needs_subtitle IS NULL
    `).all() as Array<{ path: string; filename: string; embedded_langs: string | null; work_id: string; origin_lang: string | null }>

    if (rows.length === 0) return
    const update = db.prepare('UPDATE files SET needs_subtitle = ?, updated_at = ? WHERE path = ?')
    let judged = 0

    for (const r of rows) {
      let embedded: string[] | null = null
      if (r.embedded_langs) { try { embedded = JSON.parse(r.embedded_langs) } catch { embedded = null } }
      const dir = dirname(r.path)
      const stem = basename(r.filename).replace(/\.[^.]+$/, '')
      const dirEntries = (() => { try { return readdirSync(dir) } catch { return [] } })()
      const sidecar = dirEntries.some((e) =>
        e !== r.filename && e.startsWith(stem + '.') &&
        /\.(srt|ass|ssa|vtt)$/i.test(e) && /[.-](zh|chs|chi|zho)([.-]|$)/i.test(e))

      const verdict = judgeSubtitle(
        { originLang: r.origin_lang, embeddedLangs: embedded, hasSidecarSubtitle: sidecar },
        { targetLanguages: [this.deps.targetLanguage] },
      )
      update.run(verdict.needs ? 1 : 0, now, r.path)
      judged++
    }
    if (judged > 0) {
      this.deps.log(`judge: ${judged} 个文件判定需字幕`)
    }
  }

  private async scanOnce(): Promise<void> {
    const db = this.deps.db
    const resetCols = this.fingerprintResetColumns()
    // 清空子句拼进 upsert 的 DO UPDATE 而不是事后另发一条 UPDATE：一条语句 = 一个原子写。
    // 分两条的话，进程在两条之间被杀（软路由掉电是常态，见 db.ts 的 synchronous=FULL 论证）
    // 会留下"机械事实已是新文件、状态列还是旧文件"的库——那正是 C11 要修的那个状态本身。
    const resetSql = resetCols.map((c) => `, ${c.name}=${c.value}`).join('')
    const upsert = db.prepare(`
      INSERT INTO files (path, dir, filename, size, mtime, work_dir, season, episode, parse_confidence, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        dir=excluded.dir, filename=excluded.filename, size=excluded.size, mtime=excluded.mtime,
        work_dir=excluded.work_dir, season=excluded.season, episode=excluded.episode,
        parse_confidence=excluded.parse_confidence, updated_at=excluded.updated_at${resetSql}
    `)
    const findExisting = db.prepare('SELECT mtime, size FROM files WHERE path = ?')
    const walk = this.deps.listVideoFiles ?? walkVideoFiles
    const stat = this.deps.statFile ?? ((p: string) => { try { return statSync(p) } catch { return null } })
    let scanned = 0, upserted = 0, skipped = 0

    // D20：删除前先算一次嵌套关系，凡出现在任何一对里的根（**内外层都算**）整轮跳过删除。
    // 为什么不能靠告警了事：第 1a 步的 detectNestedRoots 只告警、不擅自改用户配置（守备目录
    // 是用户的意图），所以不能假设"用户看了告警会去修"。真实剧本（C29）：/media 与 /media/115
    // 并存，115 的 rclone FUSE 掉线 → /media 的 walk 照样成功（它自己不空）→ 115 下的 files 行
    // 落进 /media 的差集被当成"消失的文件"全删。这正是 R8 要防的灾难的实现版。
    const nestedRoots = this.nestedRootSet()

    // C12：本轮需要探测的文件（新增 / 指纹变化）。**先收集、后统一探**，不在 upsert 循环里
    // 逐个 await：探针是 12-16s 级别的重 IO（115 是 rclone FUSE 挂载），在循环里串行会把
    // "机械扫描"这个本该秒级的阶段拖成几小时，且期间删除逻辑迟迟不生效。
    const toProbe: string[] = []

    for (const root of this.deps.roots) {
      // walk 抛错 = 守备目录不可访问（挂载掉线/权限）。此时**已扫到的路径集是不可信的**，
      // 拿它做差集就是删库，故整根跳过删除；upsert 也无从做（一个文件都没拿到）。
      let files: string[]
      try {
        files = walk(root)
      } catch (e) {
        this.deps.log(`scan: 守备目录不可访问，跳过删除（R8 挂载保护）: ${root}: ${String(e)}`)
        continue
      }

      const seen = new Set<string>()
      for (const f of files) {
        scanned++
        const st = stat(f)
        if (!st) { skipped++; continue }
        const sc = isScannable(f, st.size)
        if (!sc.ok) { skipped++; continue }
        // seen 只收**入库口径**的路径（过了 isScannable 这道门），否则差集会把
        // "扫到了但按规矩不入库"的文件当成"库里该有的行"，两边口径不一致。
        seen.add(f)
        const existing = findExisting.get(f) as { mtime: number; size: number } | undefined
        if (existing && existing.mtime === Math.round(st.mtimeMs) && existing.size === st.size) continue
        const row = toMediaFileRow(f, st, this.deps.roots)
        upsert.run(row.path, row.dir, row.filename, row.size, row.mtime,
          row.workDir, row.season, row.episode, row.parseConfidence, Date.now())
        upserted++
        // 只有走到这里（新增 or 指纹变化）才排进探测队列。指纹未变的文件在上面那行
        // `continue` 就走了，**一次 ffprobe 都不会发**——这是性能红线而非优化：
        // 生产上一个守备目录是 115 网盘的 rclone FUSE 挂载，全库重探是几万 × 12s。
        toProbe.push(f)
      }

      // R8 第二道：目录可访问但一个媒体文件都没扫到。115 的 rclone FUSE 掉线时目录**不报错、
      // 只是看起来是空的**——这是最阴的形态，无脑差集就是一次删光该根全库。
      // "空" 判据用 seen.size 而非 files.length：全部文件都被 isScannable 挡掉（比如整根都是
      // 探针残留小文件）同样意味着"没有可信的入库口径快照"，一样不该删。
      if (seen.size === 0) {
        this.deps.log(`scan: 守备目录扫出 0 个媒体文件，跳过删除（R8 挂载保护）: ${root}`)
        continue
      }

      if (nestedRoots.has(root)) {
        // 打日志是硬要求：不说原因的话运维只会看到"删除逻辑坏了"，无从排查。
        this.deps.log(`scan: 守备目录处于嵌套关系中，跳过删除（D20 / C29）: ${root}`)
        continue
      }

      this.deleteMissing(root, seen)
    }
    if (upserted > 0) {
      this.deps.log(`scan: scanned=${scanned} upserted=${upserted} skipped=${skipped}`)
    }

    await this.probeNewOrChanged(toProbe)
  }

  /** C11 的清空名单 ∩ 库里实际有的列，且每列的"清空值"取**该列自己声明的 DEFAULT**而不是
   *  一律 NULL（见 FINGERPRINT_RESET_COLUMNS 的论证）。
   *
   *  为什么不能一律写 NULL：`sub_attempt` 在 spec 第 3 步会照既有 `attempt` 列的样子建成
   *  `INTEGER NOT NULL DEFAULT 0`，`x=NULL` 直接撞 NOT NULL 约束 → **整轮扫描抛错**。
   *  这不是理论风险：本仓的 files 表已经有一列 `attempt INTEGER NOT NULL DEFAULT 0` 就是这个
   *  形状，第 3 步加 sub_attempt 时必然照抄。从 PRAGMA 读 notnull/dflt_value 让"清空"的语义
   *  变成"回到该列的出厂值"，加列的人不需要回来改这里。
   *
   *  读不到 PRAGMA（不该发生，但扫描不能因为它挂）时退化成空 → 只更新机械事实，
   *  等同于改动前的行为，不会把库写坏。 */
  private fingerprintResetColumns(): Array<{ name: string; value: string }> {
    try {
      const info = this.deps.db.prepare('PRAGMA table_info(files)').all() as
        Array<{ name: string; notnull: number; dflt_value: string | null }>
      const byName = new Map(info.map((c) => [c.name, c]))
      const out: Array<{ name: string; value: string }> = []
      for (const name of FINGERPRINT_RESET_COLUMNS) {
        const col = byName.get(name)
        if (!col) continue
        // NOT NULL 列回落到它的 DEFAULT；DEFAULT 也没有的 NOT NULL 列**跳过**——没有任何
        // 安全的"空值"可写，硬猜一个（0？''？）就是替 schema 作者发明语义。
        if (col.notnull) {
          if (col.dflt_value === null) continue
          out.push({ name, value: col.dflt_value })
        } else {
          out.push({ name, value: 'NULL' })
        }
      }
      return out
    } catch { return [] }
  }

  /** C12：对新增/指纹变化的文件探测内嵌字幕轨 + 时长，写 files.embedded_langs / duration_sec。
   *
   *  为什么这一列非写不可：judge 规则 2（"已有内嵌中文轨 → 不用找字幕"）读的就是它，而全仓
   *  从来没人写过 files.embedded_langs → 该规则在新架构下**静默失效**，本该跳过的片子被送进
   *  字幕流白烧一轮付费 LLM；D9 的 translatable 预判（日漫有日文内嵌轨 = 纯本地抽取、可救）
   *  同样以它为前提，缺了会误判死一批能救的片子。
   *
   *  三态语义**忠实转录**，不折叠（streamProbe.ts 的 load-bearing 契约）：
   *   · 探针返回 null（二进制缺席/超时/JSON 解析不出）→ embedded_langs 留 NULL = "没探测过"。
   *     绝不能写成 []：[] 是"探过、确认零轨"，D9 会据此判"无同语言内嵌轨 → 不可救 → unsolvable"，
   *     把一个只是网盘超时过一次的日漫**永久判死**。留 NULL 还能被 D17 的回填 pass
   *     （谓词 `embedded_langs IS NULL`）捞回来重探——那是失败重试的唯一凭据。
   *   · 探针返回 [] → 写 '[]'，不写 NULL。反过来同样有害：把"确认零轨"记成 NULL 会让回填 pass
   *     每次启动都重探这批文件，在 FUSE 挂载上就是永不收敛的重探循环。
   *
   *  逐文件 try/catch + allSettled 语义（mapWithConcurrency 已是 allSettled）：一个损坏文件
   *  或一次网盘超时不许掀翻整轮巡检（ingest 的既有铁律）。失败行留 NULL，天然进入下轮/回填的
   *  重试范围，不需要额外记账。 */
  private async probeNewOrChanged(paths: string[]): Promise<void> {
    const probe = this.deps.probe
    const probeDuration = this.deps.probeDuration
    if (paths.length === 0 || (!probe && !probeDuration)) return

    const db = this.deps.db
    const write = db.prepare('UPDATE files SET embedded_langs = ?, duration_sec = ?, updated_at = ? WHERE path = ?')
    let ok = 0, failed = 0

    const results = await mapWithConcurrency(paths, this.deps.probeConcurrency ?? 2, async (p) => {
      // 同一文件的两个探针**串行**（沿用 ingest 的既有口径）：并发只在跨文件那一层买得到
      // 吞吐，同文件并发两次 ffprobe 只是把同一份网络读放大一倍。
      let langs: string[] | null = null
      let duration: number | null = null
      if (probe) {
        const tracks = await probe(p)
        // 剔图形字幕轨（PGS/DVD/DVB/XSub 是位图叠加，没法当文本比对）与无语言标签的轨——
        // 复用 ingest.ts usableEmbeddedLangs 的同一套"图形字幕不算覆盖"裁决。不剔的话
        // judge 规则 2 会把一条读不了的 PGS 中文轨当成"已有内嵌中字"，永久跳过找字幕。
        // tracks 为 null 时保持 langs=null（不可用 ≠ 零轨，见上方三态论证）。
        if (tracks !== null) {
          langs = [...new Set(tracks.filter((t) => !t.isImageBased && t.lang !== null).map((t) => t.lang as string))]
        }
      }
      if (probeDuration) duration = await probeDuration(p)
      // 探测失败（null）不写 '[]'、也不覆盖已有值为 NULL——这里 langs/duration 本轮必然是
      // 该文件的最新事实（指纹刚变过，旧值已在 upsert 里被清），直写即可。
      write.run(langs === null ? null : JSON.stringify(langs), duration, Date.now(), p)
      return p
    })

    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.status === 'fulfilled') { ok++; continue }
      failed++
      // 逐个记日志而不是只记个数：事后排障要能分辨"这片子真没内嵌轨"与"这台机器的 ffprobe 坏了"
      // （referenceSource.ts 的同一条论证）。失败行的两列保持 NULL，下轮/回填 pass 会重探。
      this.deps.log(`scan: probe 失败（隔离，留 NULL 待重探）: ${paths[i]}: ${String(r.reason)}`)
    }
    if (ok > 0 || failed > 0) {
      this.deps.log(`scan: probe ok=${ok} failed=${failed}`)
    }
  }

  /** 出现在任何一对嵌套关系里的守备目录（内层外层都算）——D20 的跳过名单。
   *
   *  判据取 media_roots **表**（复用 settingsRepo.detectNestedRoots 这一份既有实现，不重写
   *  第二份），而不是 deps.roots——两者会漂移：watchV2 启动时读表读一次就再不刷新，运行期
   *  用户在 dashboard 里加根不会反映到进程内快照。
   *
   *  漂移方向决定了为什么防线 3 必须独立存在：表里已成嵌套但 deps.roots 还没看见时，防线 2
   *  会照实跳过（安全）；反之 deps.roots 里有嵌套而表里还没落库时，防线 2 静默失效——此时
   *  唯一顶住的就是 deleteMissing 里的"排除更深根前缀"（D21）。两条防线保护的对象也不同：
   *  防线 3 救的是**内层根**名下的行（被外层的差集吃掉），防线 2 额外救的是**外层根**名下
   *  那些确实没扫到的行——那些行前缀上就归外层管，防线 3 帮不上，只能整根不删。
   *
   *  表读不到（旧库无 media_roots / 测试用裸库）时返回空集：宁可让防线 3 单独顶，也不能因为
   *  读表抛错就让整轮扫描挂掉。 */
  private nestedRootSet(): Set<string> {
    const out = new Set<string>()
    try {
      for (const pair of new SettingsRepo(this.deps.db).detectNestedRoots()) {
        out.add(pair.root)     // 外层
        out.add(pair.nested)   // 内层——两边都算，内层的行会被外层的差集吃掉，外层自己也不可信
      }
    } catch { /* 无表/读失败：交给防线 3，不阻断扫描 */ }
    return out
  }

  /** 差集删除：库中归 root 管的行里，本轮没扫到的那些（R7 直接删，历史不留）。
   *
   *  D1 逐根比对，**不做全局补集**——把所有根扫到的路径并成一个大集合再删补集的话，
   *  "这个根根本没扫到（挂载掉线）"与"这个根扫到了但是空的"不可区分，R8 保护形同虚设。
   *
   *  D21（'/' 防护）："归 root 管的行" = 在 root 前缀下、且**不在任何更深守备目录前缀下**。
   *  若 '/' 是守备目录，裸前缀条件 `substr(path,1,1)='/'` 对每一条绝对路径都为真 → '/' 的
   *  差集覆盖全库，把仍然有效的 /media/tv 名下的行一起清光。removeRoot 侧已在审校 F8 修过
   *  同一漏洞面，但那是"删一个根时的自我限界"、这里是"查库中归这个根管的行"，两条独立代码
   *  路径不会自动继承，故必须独立再修一次。
   *  正常（无嵌套）配置下 deeperPrefixes 为空，退化成纯前缀匹配。
   *
   *  前缀比较用 `substr(path,1,length(?)) = ?` 而不是 LIKE：媒体路径可以合法含 % 和 _
   *  （"100% Pascal-sensei"、"Look_Back"），LIKE 会把这些字面字符当通配符展开 → 兄弟目录
   *  的行被卷进别人的差集误删。substr 定长字面量比较没有这个陷阱（沿用 removeRoot 的论证）。
   *  root 后补 '/' 是避免 "/media/tv" 前缀吃到兄弟目录 "/media/tv2"。 */
  private deleteMissing(root: string, seen: Set<string>): void {
    const db = this.deps.db
    const prefix = root.endsWith('/') ? root : `${root}/`
    const deeperPrefixes = this.deps.roots
      .filter((r) => r !== root)
      .map((r) => (r.endsWith('/') ? r : `${r}/`))
      .filter((p) => p !== prefix && p.startsWith(prefix))
    const scopeSql = `substr(path,1,length(?)) = ?`
      + deeperPrefixes.map(() => ' AND substr(path,1,length(?)) != ?').join('')
    const scopeArgs: string[] = [prefix, prefix, ...deeperPrefixes.flatMap((p) => [p, p])]

    // 事务包住"读该根名下的行 → 逐条删"（照 removeRoot 的 transaction().immediate() 手法）：
    // 中途崩溃留下半删状态的库，比不删更糟——库不再是任何一个时刻的磁盘快照。
    const tx = db.transaction((): number => {
      const rows = db.prepare(`SELECT path FROM files WHERE ${scopeSql}`).all(...scopeArgs) as { path: string }[]
      const del = db.prepare('DELETE FROM files WHERE path = ?')
      let deleted = 0
      for (const r of rows) {
        if (seen.has(r.path)) continue
        del.run(r.path)
        deleted++
      }
      return deleted
    })
    const deleted = tx.immediate()
    if (deleted > 0) {
      this.deps.log(`scan: 删除磁盘上已消失的文件 ${deleted} 行（R7）: ${root}`)
    }
  }

  /** last_inspect_at 持久化到 meta（M-3：重启读它判 24h，冷启动立即跑）。 */
  private readLastInspectAt(): number {
    try {
      const row = this.deps.db.prepare(`SELECT value FROM meta WHERE key = 'last_inspect_at'`).get() as { value: string } | undefined
      const v = row ? Number(row.value) : 0
      return Number.isFinite(v) ? v : 0
    } catch { return 0 }
  }

  private writeLastInspectAt(now: number): void {
    this.deps.db.prepare(`INSERT INTO meta (key, value) VALUES ('last_inspect_at', ?)
                          ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(now))
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); resolve() }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
