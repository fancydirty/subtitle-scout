// src/v2/settingsRepo.ts
import type { ScoutDb } from './db.js'

/** dashboard 重建战役 G4（spec §7，照抄 Jellyfin 分界）：settings 表是行为级设置的薄封装——
 *  挂载（compose volume）是部署层，守备目录（media_roots）与行为键（settings）都是产品层，
 *  在 dashboard 里增删/改。这一层只管字符串存取，不做任何值域校验（白名单/取值范围校验是
 *  调用方边界的事，见 dashboard/server.ts 的 zod 门）——repo 保持对"settings 表里到底有哪些
 *  key"零知识，未来新增行为键不需要碰这个文件。 */

export interface MediaRoot {
  path: string
  type: string
  addedAt: number
}

export interface RemoveRootResult {
  episodes: number
  movies: number
  series: number
  parked: number
}

export class SettingsRepo {
  readonly db: ScoutDb

  constructor(db: ScoutDb) {
    this.db = db
  }

  // ---- settings(key,value,updated_at)：任意行为键的字符串存取 ----

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  set(key: string, value: string, now: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run(key, value, now)
  }

  // ---- media_roots(path,type,added_at)：守备目录 ----

  listRoots(): MediaRoot[] {
    return (
      this.db.prepare('SELECT path, type, added_at FROM media_roots ORDER BY path').all() as
        { path: string; type: string; added_at: number }[]
    ).map((r) => ({ path: r.path, type: r.type, addedAt: r.added_at }))
  }

  /** 重复加同一路径是幂等的（INSERT OR IGNORE：path 是主键，已存在则什么都不改，包括
   *  不刷新 added_at——"何时首次加入"是该行的出生事实，不因为重复提交同一路径而改写）。 */
  addRoot(path: string, now: number): void {
    this.db
      .prepare("INSERT OR IGNORE INTO media_roots (path, type, added_at) VALUES (?, 'local', ?)")
      .run(path, now)
  }

  /** 首启种子：media_roots **当前为空**且 envRaw 解析非空（逗号分隔，trim+filter，沿
   *  cli/index.ts 旧 mediaRoots() 同一套解析法）时逐条写入；否则空操作。注意判据是"当前
   *  count=0"而非"从未有过根"——在 dashboard 里删光全部根后重启进程，env 值会重新种入。
   *  这是可接受的（复审修复 3 确认，符合计划原文"空→种子"）：零守备目录的守护进程本无事
   *  可做，env 种子是合理的恢复路径；部署层想彻底清空应同时清掉 MEDIA_ROOTS env。 */
  seedRootsFromEnv(envRaw: string | undefined, now: number): void {
    const existing = this.db.prepare('SELECT COUNT(*) as c FROM media_roots').get() as { c: number }
    if (existing.c > 0) return
    const roots = (envRaw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    for (const root of roots) this.addRoot(root, now)
  }

  /** 移除一个守备目录：单事务级联清理该根下的索引行——**磁盘文件不动，只清索引行**（用户
   *  在 dashboard 里删的是"扫描范围"，不是委托本软件去删用户的媒体文件）。
   *
   *  存在性守卫（复审修复 1，安全脚枪）：path 必须是 media_roots 里登记在册的守备目录，否则
   *  返回 null、不进事务、不删任何行——没有这道门，对现存根的公共父目录（如 /media 甚至 /）
   *  发一次 DELETE 就会把该前缀下全部索引行静默清光，而它根本不是守备目录。
   *
   *  前缀匹配用 `substr(path,1,length(?)) = ?`（? = root+'/'），不用 LIKE——媒体路径可以合法
   *  含有 % 和 _（如 "100% Pascal-sensei"、"Look_Back"），LIKE 的通配符语义会把这些字面字符
   *  误当模式展开，造成误删/漏删；substr 定长字面量比较没有这个陷阱。root 后缀补一个 '/' 是
   *  避免 "/media/tv" 前缀匹配到兄弟目录 "/media/tv2" 这类同名前缀误伤。
   *
   *  级联顺序：episodes/movies 各自先删 subtitles 子行（借 LibraryRepo.deleteSeriesRows 的
   *  既有手法——subtitles 未声明外键到 episodes/movies(id)，同属一份账目一并清理）→ 受影响
   *  series 中因此变空壳的一并删除（连带清它的 tmdb_seasons 应有集缓存——G2 的缓存跟着 series
   *  走，留着就是永久性孤儿行）→ 删该根下的 parked_paths 户口。jobs 队列行不动：mapper 对
   *  "目标消失"已有防御（claim 时目标已被删的行走 idempotent no-op），登记册后续清算。 */
  removeRoot(path: string): RemoveRootResult | null {
    const isRoot = this.db.prepare('SELECT 1 FROM media_roots WHERE path = ?').get(path)
    if (!isRoot) return null

    const prefix = path.endsWith('/') ? path : `${path}/`

    const tx = this.db.transaction((): RemoveRootResult => {
      const affectedSeries = this.db
        .prepare('SELECT DISTINCT series_id FROM episodes WHERE substr(path,1,length(?)) = ?')
        .all(prefix, prefix) as { series_id: string }[]

      const episodeIds = this.db
        .prepare('SELECT id FROM episodes WHERE substr(path,1,length(?)) = ?')
        .all(prefix, prefix) as { id: string }[]
      const movieIds = this.db
        .prepare('SELECT id FROM movies WHERE substr(path,1,length(?)) = ?')
        .all(prefix, prefix) as { id: string }[]

      const delSub = this.db.prepare('DELETE FROM subtitles WHERE item_id = ?')
      for (const e of episodeIds) delSub.run(e.id)
      for (const m of movieIds) delSub.run(m.id)

      const episodesResult = this.db
        .prepare('DELETE FROM episodes WHERE substr(path,1,length(?)) = ?')
        .run(prefix, prefix)
      const moviesResult = this.db
        .prepare('DELETE FROM movies WHERE substr(path,1,length(?)) = ?')
        .run(prefix, prefix)

      let seriesDeleted = 0
      const delCatalog = this.db.prepare('DELETE FROM tmdb_seasons WHERE series_id = ?')
      const delSeries = this.db.prepare('DELETE FROM series WHERE id = ?')
      const countRemaining = this.db.prepare('SELECT COUNT(*) as c FROM episodes WHERE series_id = ?')
      for (const { series_id } of affectedSeries) {
        const remaining = countRemaining.get(series_id) as { c: number }
        if (remaining.c === 0) {
          delSeries.run(series_id)
          delCatalog.run(series_id)
          seriesDeleted++
        }
      }

      const parkedResult = this.db
        .prepare('DELETE FROM parked_paths WHERE substr(path,1,length(?)) = ?')
        .run(prefix, prefix)

      this.db.prepare('DELETE FROM media_roots WHERE path = ?').run(path)

      return {
        episodes: episodesResult.changes,
        movies: moviesResult.changes,
        series: seriesDeleted,
        parked: parkedResult.changes,
      }
    })

    return tx()
  }
}
