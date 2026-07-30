import type { ScoutDb } from './db.js'

/**
 * 字幕时间轴校验结论的持久层（表 subtitle_verify，schema v28）。
 *
 * 三值封闭，且**在 UI 上只映射两种颜色**（spec 铁律①）：
 * - `shifted`      → 红：验过，确认时间轴偏了，且偏移量可信到能拿去校正
 * - `aligned`      → 绿：验过，没问题（沉默，不打任何标）
 * - `unverifiable` → 绿：**没能**验证（无参考源、或分数不够不敢下结论）
 *
 * `unverifiable` 是绿色而非黄色是刻意的产品裁决：诚实体现在"不假装验证过"，
 * 而不是打个黄标让用户对一件我们自己都不知道有没有问题的事焦虑。所以这里
 * 没有"警告/可疑"这第四档——CHECK 约束在 schema 层就让它不可表达。
 *
 * `offset_ms` / `score` / `reference_tier` 是**内部字段**（铁律②：UI 不展示任何数字），
 * 只供排障与 trace。本 repo 如实读写它们，但读出来做面向用户的文案是被禁止的。
 */

export type SubtitleVerdict = 'aligned' | 'shifted' | 'unverifiable'

/** DB 行形状（snake_case 直出，同 libraryRepo/runsRepo 的既有惯例）。 */
export interface SubtitleVerifyRow {
  item_id: string
  verdict: SubtitleVerdict
  offset_ms: number | null
  score: number | null
  reference_tier: string | null
  subtitle_path: string
  subtitle_hash: string | null
  checked_at: number
  detail: string | null
}

export interface UpsertVerifyParams {
  itemId: string
  verdict: SubtitleVerdict
  subtitlePath: string
  checkedAt: number
  /** 仅 verdict='shifted' 时有意义；其余档位传 null/省略。 */
  offsetMs?: number | null
  score?: number | null
  referenceTier?: string | null
  /** 内容哈希，用于日后判"字幕文件变了需重检"。算不出（文件读不动）传 null——
   *  needsRecheck 会把 NULL 当"无从比较"而判需重检，不会误以为"没变过"。 */
  subtitleHash?: string | null
  detail?: string | null
}

export class SubtitleVerifyRepo {
  constructor(private db: ScoutDb) {}

  /** 落库一次检测结论。同 item 重复检测覆盖旧行（PRIMARY KEY(item_id) 一行一集：
   *  校验结论是可重算的派生数据，不留历史——需要历史的是决策史 runs 表，不是这里）。 */
  upsertVerifyResult(params: UpsertVerifyParams): void {
    this.db
      .prepare(
        `INSERT INTO subtitle_verify
           (item_id, verdict, offset_ms, score, reference_tier,
            subtitle_path, subtitle_hash, checked_at, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET
           verdict = excluded.verdict,
           offset_ms = excluded.offset_ms,
           score = excluded.score,
           reference_tier = excluded.reference_tier,
           subtitle_path = excluded.subtitle_path,
           subtitle_hash = excluded.subtitle_hash,
           checked_at = excluded.checked_at,
           detail = excluded.detail`,
      )
      // 刻意**全列无条件覆盖**，不用 COALESCE 保护旧值（对照 libraryRepo.upsertSeries 的
      // 富化语义）：一次新检测是对同一问题的完整重新回答，把上一轮的 offset_ms 留在
      // 一行新的 unverifiable 结论旁边只会造出自相矛盾的行——"没能验证，但偏移量是 2000ms"。
      .run(
        params.itemId,
        params.verdict,
        params.offsetMs ?? null,
        params.score ?? null,
        params.referenceTier ?? null,
        params.subtitlePath,
        params.subtitleHash ?? null,
        params.checkedAt,
        params.detail ?? null,
      )
  }

  getVerifyResult(itemId: string): SubtitleVerifyRow | null {
    return (this.db
      .prepare(`SELECT * FROM subtitle_verify WHERE item_id = ?`)
      .get(itemId) as SubtitleVerifyRow | undefined) ?? null
  }

  /** UI 需要知道"哪些集有问题"——即哪些集要显示红芯片 + 校正入口。
   *  只有 shifted 一档会返回：另两档在 UI 上都是绿色，不需要被列举。 */
  listShifted(): SubtitleVerifyRow[] {
    return this.db
      .prepare(`SELECT * FROM subtitle_verify WHERE verdict = 'shifted' ORDER BY checked_at DESC`)
      .all() as SubtitleVerifyRow[]
  }

  /**
   * 这个 item 是否需要（重新）检测。
   *
   * 判 true 的三种情形，都是"上次的结论不能代表当前磁盘上的这个文件"：
   * - 从未检测过（无行）
   * - 检的是**另一个**字幕文件（subtitle_path 不同：换装了不同来源的字幕）
   * - 内容哈希不一致，**或任一侧哈希缺失**（NULL=当时/此刻算不出 → 无从证明没变，
   *   保守判需重检；把"不知道"当成"没变"会让被替换过的字幕永远挂着旧结论）
   *
   * 哈希必须参与判断，否则同名原地替换（下载新字幕覆盖旧文件、或平移过时间轴后回写）
   * 路径不变，会被误判"检过了不用再检"而永久沿用作废结论。
   */
  needsRecheck(itemId: string, subtitlePath: string, subtitleHash: string | null): boolean {
    const row = this.getVerifyResult(itemId)
    if (row === null) return true
    if (row.subtitle_path !== subtitlePath) return true
    if (row.subtitle_hash === null || subtitleHash === null) return true
    return row.subtitle_hash !== subtitleHash
  }

  /** 清理派生数据：item 行被删（磁盘文件消失）或字幕被卸载时调用，不留孤儿结论。
   *  返回删除行数（0=本就没有，非错误）。 */
  deleteForItem(itemId: string): number {
    return this.db.prepare(`DELETE FROM subtitle_verify WHERE item_id = ?`).run(itemId).changes
  }
}
