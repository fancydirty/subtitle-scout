import type { ScoutDb } from './db.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🟡 2026-08-12「无活 UI 端点」裁决：**本族保留，但它今天在生产是一个封闭空转的环**
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 本轮裁决把 `/api/v2/library` 一族（4 条端点）删了，字幕校验这 6 条**留下**。留的理由
 * 与"还有人在用"无关——它今天**没有任何活 UI**。留是因为下面第 3 条。以下是实测事实，
 * 写在这里是为了让下一个清理的人不必再考古一遍。
 *
 * ── 1. 六条端点今天各自的活 UI：一个都没有 ──────────────────────────────────
 *   GET  /api/v2/subtitle/verify         ← api.subtitleVerify ← useSubtitleVerify ← 零调用
 *   GET  /api/v2/subtitle/compare        ← api.subtitleCompare ← useSubtitleCompare ← 零调用
 *   GET  /api/v2/subtitle/waveform-peaks ← api.waveformPeaks ← web/src/subtitleVerify/
 *                                          InspectPanel.tsx ← **零模块 import 它**
 *   GET  /api/v2/subtitle/shifted        ← useShiftedSubtitles ← triage/TimingBox
 *   POST /api/v2/subtitle/correct        ← api.subtitleCorrect ← triage/TimingBox
 *   POST /api/v2/subtitle/revert         ← api.subtitleRevert  ← triage/TimingBox
 *   而 TimingBox ← TriagePage ← **没有任何地方渲染 TriagePage**（甄别 tab 于 2026-08-07
 *   雪藏，AppShell 不 import 它，'triage' 也不在 route.ts 的 Tab 联合里）。
 *
 * ── 2. 更要紧的事实：这张表在生产**永远不会有第一行** ──────────────────────
 * 唯一的写入者是 `upsertVerifyResult`，它唯一的生产调用点是
 * `subtitleVerify/verifySubtitle.ts:verifyAndRecord`。而 `verifyAndRecord` 的生产调用点
 * 只剩一个：`dashboard/server.ts` 里 `subDeps.reverify`——它只在 correct/revert 内部被调。
 * 而 correct/revert 都以 `subtitleVerifyApi.locate()` 开头，**没有已存在的行就直接 404**。
 *
 *   → 想写入，先得有行；想有行，得先写入。**环是封闭的，没有入口。**
 *
 * 本该打破这个环的是巡检 `runVerifySweep`（它 `LEFT JOIN subtitle_verify … IS NULL`
 * 专挑没结论的条目）——但它于 2026-08-07 随巡检注入一并雪藏，今天**被 cli/index.ts import
 * 却从未被调用**（apiV2.ts 的 `lastVerifySweepAt` 头注释里已独立记过同一事实）。
 *
 * 所以今天对这 6 条端点 curl 的实际结果是：verify 恒 `checked:false`、shifted 恒 `[]`、
 * compare/correct/revert 恒 404。**它不是一个"没人点的运维工具"，是一个没有燃料的引擎。**
 * 这条要写明，是因为"留着给运维 curl"是最容易被编出来的留存理由，而它是假的。
 *
 * ── 3. 那为什么还留？──────────────────────────────────────────────────────
 * 因为**缺的只是一根接线，而资产是真的**：`src/subtitleVerify/` 下的 alignDetect /
 * referenceSource / shiftTiming / subtitleSpans / verifySubtitle / verifySweep 是 246 条
 * 用例覆盖的真实算法（时间轴偏移检测、参考源选取、带备份的幂等平移），删掉是不可逆的
 * 损失，而重新接上巡检注入是**一处 wiring**。删 6 条端点省不下什么，却把这份资产的
 * 唯一出口堵死。
 *
 * 另有两处**已经活着**的依赖，删表会连带打断：
 *   · `subtitleSpans.ts` 的 readSubtitleText / parseCues / hashSubtitleContent 被
 *     server.ts 直接 import（compare 端点与写扳手的哈希守卫共用）。
 *   · `apiV2.buildWorkflowPending` 会 `SELECT COUNT(*) FROM subtitle_verify` 产出
 *     verifiedItems/verifiableItems 两个计数——那条端点是**活的**（顶栏新鲜度行）。
 *     删表会让一个活端点 500。
 *
 * ── 4. 什么时候可以删（**可证伪的判据，不是"跑稳后再说"**）────────────────
 * 满足**任意一条**即可整族删除（6 条端点 + 本 repo + subtitle_verify 表 +
 * src/subtitleVerify/ + web/src/subtitleVerify/ + triage 的 TimingBox）：
 *
 *   (a) 产品明确放弃"字幕时间轴校正"这个功能——那就连算法一起删，别留半截；
 *   (b) 距 2026-08-12 起再过一个发布周期，`runVerifySweep` 仍**没有**被接进 daemonV2
 *       的任何 pass（判据：`rg 'runVerifySweep\(' src/v2/daemonV2.ts` 无输出）。
 *       雪藏满两轮 = 没人真的要它。
 *
 * 反过来，**恢复**它只需要：在 daemonV2 加一个 pass 调 runVerifySweep（并写
 * `last_verify_sweep_at` meta 键），再把 TriagePage 挂回 AppShell。环一旦有了入口，
 * 上面 6 条端点立刻全部有意义。
 *
 * ⚠️ 2026-08-13 补记：上一句里的「把 TriagePage 挂回 AppShell」曾与
 * `docs/design/2026-08-11-FRONTEND-IMPL-DESIGN.md` 的旧前端清点表直接打架——那张表判
 * 「triage 已被雪藏 → 删」。用户裁决：**都留**，那张表已更正为「雪藏保留」。
 * TriagePage 去留的**正本**在 `web/src/triage/TriagePage.tsx` 头注释（本处不重抄），
 * 那里写明 TimingBox 与本族**同进退**：本族整族删除时 TimingBox 必须跟着走（它已列在
 * 上面第 4 条的删除清单里），本族恢复时它是那份资产在前端的唯一出口。
 *
 * 上面第 4 条判据 (b) 现在有机器载体了：`src/dashboard/triageShelved.orphan.test.ts` 的
 * ③ 钉着 `runVerifySweep` 仍未接进 daemonV2 这个事实——它红了 = 本族活了 = 该重读本段。
 * 此前那条判据只是这段散文里的一行 `rg` 命令，没有任何东西会在它失效时变红。
 *
 * 🔴 不要只删一半（比如"UI 反正没了，把端点删了留算法"）：那会留下一族无出口的算法，
 *    与本仓病 A 是同一形状，只是换了个方向。要么整族留，要么整族删。
 * ═══════════════════════════════════════════════════════════════════════════
 */

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

/** Plan C（spec §4.1）：shifted 行 + 媒体标识的 join 行。**刻意不是 `SubtitleVerifyRow` 的
 *  超集**——`offset_ms`/`score`/`reference_tier`/`detail` 四个禁出字段从 SELECT 列表里就不选，
 *  这样 DTO 层即使写错（比如手滑 spread）也无从泄漏。`subtitle_path` 是唯一一个"进得来、
 *  出不去"的字段：DTO 层要用它探备份文件是否存在（hasPriorCorrection），但它自己不进 DTO。
 *  四个媒体字段可 null：item_id 是电影 id（movies.id）或库里已被删掉的集时 LEFT JOIN 不中，
 *  行仍然要出（用户仍该看到这条偏移事实），前端按既有降级惯例回落 mono itemId 占位。 */
export interface ShiftedMediaRow {
  item_id: string
  checked_at: number
  subtitle_path: string
  series_id: string | null
  series_name: string | null
  season: number | null
  episode: number | null
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

  /** Plan C（spec §4.1）：shifted 行连媒体标识一起取，供 Triage 第三区与 Library 详情偏移行。
   *  与 listShifted() 并存而不是取代它——后者是既有调用方的契约，签名不动。
   *  纯读，无写路径。verdict 索引（src/v2/db.ts:145）已覆盖 WHERE，无需新索引。 */
  listShiftedWithMedia(): ShiftedMediaRow[] {
    return this.db
      .prepare(
        `SELECT v.item_id       AS item_id,
                v.checked_at    AS checked_at,
                v.subtitle_path AS subtitle_path,
                e.series_id     AS series_id,
                s.name          AS series_name,
                e.season        AS season,
                e.episode       AS episode
           FROM subtitle_verify v
           LEFT JOIN episodes e ON e.id = v.item_id
           LEFT JOIN series   s ON s.id = e.series_id
          WHERE v.verdict = 'shifted'
          ORDER BY v.checked_at DESC`,
      )
      .all() as ShiftedMediaRow[]
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
