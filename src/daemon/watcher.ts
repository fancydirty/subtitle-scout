import type { JellyfinItem, JellyfinSession } from '../adapters/players/jellyfin.js'
import { buildMediaContext, mediaDir, isUnderRoots, type PathMapping } from '../core/mediaContext.js'
import { isTriggerableType, needsChineseSubtitle, isChineseOrigin } from './triggers.js'
import type { MediaContext } from '../core/schemas.js'
import type { PrefetchQueue } from './queue.js'

export interface WatcherJobResult {
  decision: string
  subtitlePath?: string
  journalPath: string
  stats?: { durationMs: number; llmCalls: number; apiCalls: number }
  errorMessage?: string
}

export interface WatcherDeps {
  jellyfin: {
    getSessions: () => Promise<JellyfinSession[]>
    getItem: (id: string) => Promise<JellyfinItem>
    refreshItem: (id: string) => Promise<void>
    getRecentItems: (limit: number) => Promise<JellyfinItem[]>
    getChineseTitle: (item: JellyfinItem) => Promise<string | null>
  }
  /** 跑一次流水线：调用方（CLI）负责组装 runPipeline 与 journalDir */
  runJob: (ctx: MediaContext, outDir: string, itemId: string, opts?: { bypassNegativeCache?: boolean }) => Promise<WatcherJobResult>
  /** refresh 后验证中文字幕流出现（调用方实现内部轮询重试） */
  verify: (itemId: string) => Promise<boolean>
  pathMappings: PathMapping[]
  /** 媒体目录本地可达性预检（默认 fs.existsSync）。配错映射时避免白烧 LLM/ASSRT 配额 */
  pathExists: (path: string) => boolean
  /** 媒体目录可写性预检（默认真实试写）。只读挂载时避免白烧 LLM/ASSRT 配额 */
  isWritable: (dir: string) => boolean
  treatPgsAsMissing: boolean
  cooldownMinutes: number
  mediaRoots: string[]
  /** A4: target subtitle languages (coverage side of the split — see cli/targetLanguages.ts).
   *  In this old, zh-only pipeline it serves only as the default for originSkipLanguages below
   *  (needsChineseSubtitle stays hardcoded zh, out of A4 scope). Defaults to `['zh']`. */
  targetLanguages?: string[]
  /** A4 spec-review fix #2: replaces the old standalone skipChineseOrigin boolean. This (old,
   *  zh-only) pipeline never gained a per-language origin gate — it only ever checks
   *  isChineseOrigin. originSkipLanguages decides whether that Chinese-origin-skip heuristic
   *  applies at all: 'zh' in the set → same behavior as the old skipChineseOrigin:true default;
   *  'zh' absent (the SKIP_CHINESE_ORIGIN=false compat path) → same as skipChineseOrigin:false.
   *  Defaults to the effective targetLanguages (matching the old `?? true` default exactly). */
  originSkipLanguages?: string[]
  skipCacheMinutes?: number
  queue: PrefetchQueue
  log: (msg: string) => void
  onRunComplete?: (r: { itemId: string; name: string; source: 'playback' | 'queue'; result: WatcherJobResult }) => void
  pruneJournals?: () => void
}

export class Watcher {
  private inFlight = new Map<string, { source: 'playback' | 'queue'; name: string }>()
  private cooldownUntil = new Map<string, number>()
  private skipUntil = new Map<string, number>()
  private lastPruneDay = ''

  constructor(private deps: WatcherDeps) {}

  async tick(): Promise<void> {
    const now = Date.now()
    const today = new Date(now).toISOString().slice(0, 10)
    if (this.lastPruneDay !== today) {
      this.lastPruneDay = today
      try { this.deps.pruneJournals?.() } catch { /* 观测不影响主流程 */ }
    }
    for (const [id, until] of this.cooldownUntil) if (until <= now) this.cooldownUntil.delete(id)
    let sessions: JellyfinSession[]
    try {
      sessions = await this.deps.jellyfin.getSessions()
    } catch (e) {
      this.deps.log(`sessions poll failed: ${String(e)}`)
      return
    }
    const nowPlaying = sessions
      .filter(s => !s.PlayState?.IsPaused)
      .map(s => s.NowPlayingItem)
      .filter((i): i is JellyfinItem => !!i)
    await Promise.all(nowPlaying.map(i => this.maybeProcess(i.Id, 'playback')))
  }

  private async maybeProcess(itemId: string, source: 'playback' | 'queue' = 'playback'): Promise<void> {
    if (this.inFlight.has(itemId)) return
    const until = this.cooldownUntil.get(itemId)
    if (until && Date.now() < until) return
    const skipUntil = this.skipUntil.get(itemId)
    if (skipUntil && Date.now() < skipUntil) return
    this.inFlight.set(itemId, { source, name: '…' })
    let processed = false
    let bypass = false
    try {
      // 播放路径且休眠：激活 + bypass 负缓存
      if (source === 'playback' && this.deps.queue.dormantFor(itemId)) {
        this.deps.queue.activate(itemId)
        bypass = true
      }

      const item = await this.deps.jellyfin.getItem(itemId)
      this.inFlight.get(itemId)!.name = item.Name
      // 该 item 无需处理（类型不符/国产/已有中字）：设内存 skip；若来自预热队列则移出队列，
      // 否则它会永远卡在 due() 队首把后面的条目饿死（head-of-line 阻塞）。
      const skipItem = () => {
        this.skipUntil.set(itemId, Date.now() + (this.deps.skipCacheMinutes ?? 5) * 60_000)
        if (source === 'queue') this.deps.queue.remove(itemId)
      }
      if (!isTriggerableType(item.Type)) { skipItem(); return }
      if ((this.deps.originSkipLanguages ?? this.deps.targetLanguages ?? ['zh']).includes('zh') && isChineseOrigin(item)) { skipItem(); return }
      if (!needsChineseSubtitle(item, this.deps.treatPgsAsMissing)) { skipItem(); return }

      const chineseTitle = await this.deps.jellyfin.getChineseTitle(item).catch(() => null)
      const ctx = buildMediaContext(item, this.deps.pathMappings, { chineseTitle })
      if (!isUnderRoots(mediaDir(ctx), this.deps.mediaRoots)) {
        this.deps.log(`refusing write outside media roots: ${mediaDir(ctx)} — configure MEDIA_ROOTS / MEDIA_PATH_MAPPINGS`)
        processed = true
        return
      }
      if (!this.deps.pathExists(mediaDir(ctx))) {
        this.deps.log(`media dir not accessible locally: ${mediaDir(ctx)} — check MEDIA_PATH_MAPPINGS (jellyfin path prefix = local path prefix)`)
        processed = true // 进冷却：配置不修好，重试也没用
        return
      }
      if (!this.deps.isWritable(mediaDir(ctx))) {
        this.deps.log(`media dir not writable: ${mediaDir(ctx)} — sidecar 无法写入，检查挂载读写权限（只读网盘/WebDAV?）`)
        processed = true // 进冷却：只读是永久条件，重试也没用
        return
      }
      processed = true
      this.deps.log(`processing ${item.Name} (${itemId})`)
      const result = await this.deps.runJob(ctx, mediaDir(ctx), itemId, { bypassNegativeCache: bypass })
      this.deps.log(`${item.Name}: ${result.decision}`)

      // 结果联动队列
      if (['download', 'adopted_local', 'already_exists'].includes(result.decision)) {
        this.deps.queue.remove(itemId)
      } else if (result.decision === 'no_safe_match' && source === 'queue') {
        this.deps.queue.recordFailure(itemId)
      }

      // 报告完成（包含真实 journal 与 stats）
      try { this.deps.onRunComplete?.({ itemId, name: item.Name, source, result }) } catch { /* 观测不影响主流程 */ }

      // refresh + verify（Jellyfin 可见性确认）
      // 注意：runPipeline 内部捕获所有流水线错误并返回 decision:'error'，不会抛出；
      // runJob 抛出仅表示程序员错误（未测到的边界）或 watcher 内 journal-dir 构造失败。
      try {
        if (result.decision === 'download' || result.decision === 'adopted_local') {
          await this.deps.jellyfin.refreshItem(itemId)
          const visible = await this.deps.verify(itemId)
          this.deps.log(`${item.Name}: subtitle ${visible ? 'visible in jellyfin' : 'NOT visible yet'}`)
        }
      } catch (e) {
        // refresh/verify 失败是 Jellyfin 可见性问题，不影响台账记录（已用真实 result 报告）
        this.deps.log(`refresh/verify failed for ${item.Name}: ${String(e)}`)
      }
    } catch (e) {
      // 该路径仅覆盖 runJob 抛出（程序员错误或 journal-dir 创建失败）与
      // getItem/buildMediaContext 失败。流水线内错误已被 runPipeline 捕获并返回 decision:'error'。
      processed = true // 失败也进冷却，防止对着坏 item 疯狂重试
      this.deps.log(`item ${itemId} failed: ${String(e)}`)
      // 报告完成（错误路径，无真实 journal）
      try {
        const item = await this.deps.jellyfin.getItem(itemId)
        this.deps.onRunComplete?.({
          itemId,
          name: item.Name,
          source,
          result: { decision: 'error', journalPath: '', errorMessage: String(e) }
        })
      } catch { /* 观测不影响主流程 */ }
    } finally {
      this.inFlight.delete(itemId)
      if (processed) this.cooldownUntil.set(itemId, Date.now() + this.deps.cooldownMinutes * 60_000)
      // 未处理（类型不符/已有字幕/国产）设 skipUntil，已在各分支设置
    }
  }

  busy(): boolean { return this.inFlight.size > 0 }

  private playbackBusy(): boolean {
    for (const v of this.inFlight.values()) {
      if (v.source === 'playback') return true
    }
    return false
  }

  /** 当前正在处理的条目（内存态，供只读监控展示真实 in-flight，不落盘、不伪造）。 */
  inFlightItems(): { itemId: string; name: string; source: 'playback' | 'queue' }[] {
    return [...this.inFlight.entries()].map(([itemId, v]) => ({ itemId, name: v.name, source: v.source }))
  }

  async arrivalsTick(): Promise<void> {
    try {
      const items = await this.deps.jellyfin.getRecentItems(50)
      const wm = this.deps.queue.watermark()
      const wmTs = wm ? Date.parse(wm) : -Infinity
      const fresh = items.filter(i => i.DateCreated && Date.parse(i.DateCreated) > wmTs)
      for (const item of fresh) {
        if (!isTriggerableType(item.Type)) continue
        if ((this.deps.originSkipLanguages ?? this.deps.targetLanguages ?? ['zh']).includes('zh') && isChineseOrigin(item)) continue
        if (!needsChineseSubtitle(item, this.deps.treatPgsAsMissing)) continue
        this.deps.queue.upsert(item.Id, item.Name)
        this.deps.log(`queued new arrival: ${item.Name}`)
      }
      const newest = items
        .map(i => i.DateCreated)
        .filter((d): d is string => !!d)
        .sort((a, b) => Date.parse(a) - Date.parse(b))
        .pop()
      if (newest && Date.parse(newest) > wmTs) this.deps.queue.setWatermark(newest)
    } catch (e) { this.deps.log(`arrivals poll failed: ${String(e)}`) }
  }

  async consumeTick(): Promise<void> {
    if (this.playbackBusy()) { this.deps.log('prefetch yielding to in-flight playback job'); return }
    const entry = this.deps.queue.due()
    if (!entry) return
    this.deps.log(`prefetching ${entry.name}`)
    await this.maybeProcess(entry.itemId, 'queue')
  }
}
