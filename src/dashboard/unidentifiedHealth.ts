// src/dashboard/unidentifiedHealth.ts —— 「有几个目录我认不出来」的**读出面**。
//
// ══════════════════════════════════════════════════════════════════════════════
// 病 A 的第 7 例：写入方活着、判据活着、**零读出面**
// ══════════════════════════════════════════════════════════════════════════════
// 链条此前断在最后一跳：
//   daemonV2.scanOnce 写 `files`（新文件 `work_id` 为 NULL）
//     → identifyScheduler.listIdentifyQueue 按 `work_id IS NULL` 取件、识别、回填
//       → 识别不出 → `last_error='identify-failed'` + `next_retry_at=+24h`（每天重试）
//       → `getDetails` 返回 null → `last_error='tmdb-404'`：**队列谓词把它永久排除**
//         （identifyScheduler.ts:37 `AND (last_error IS NULL OR last_error != 'tmdb-404')`）
//     → **界面上一个字都没有**
//
// 三道门各自都是对的，合起来却让"用户的媒体库里有文件永远不被处理"变成静默事实：
//  ① 媒体库页：`buildMediaLibrary` 在 SQL 谓词层就滤掉 `work_id IS NULL`
//     （mediaLibraryApi.ts:401，R-F2「识别失败的孤儿不露出」）——**这条是对的**，
//     见下方 §R-F2 的解读。
//  ② 活动页：`buildActivity` 刻意不产出识别队列（activityApi.ts，R-F1「识别不进活动页」）。
//  ③ SSE：识别事件只在**正在跑**的那一刻发（daemonV2.ts:645）。退避中的目录、
//     以及 404 终态那批**永不再进队列**的目录，一条事件都不会有。
// 于是"卡住"与"从来没有过这种文件"在界面上完全无法区分——本仓栽过 6 次的同一形状。
//
// ── §R-F2 的解读：「不露出」的作用域是**媒体库列表**，不是"任何地方都不许提" ──
// 原文（FRONTEND-SPEC §2.3，媒体库页那一节的 bullet）：
//   「**识别失败的孤儿不露出**：那是用户的命名问题，底线是按 `title (year)` 命名」
// 以及 §170 的裁决表：
//   「媒体库不管来源，按充分必要条件算，合并键 `work_id`；识别失败的孤儿不露出」
// 以及 §218：「我们靠 work_id 合并天然免疫，但前提是识别成功；识别失败的孤儿按 R-F2
//   不露出，正好绕开」
// 三处出现全部锚在**媒体库页的海报墙/季集网格**上，且理由是结构性的：一张卡片需要
// 标题、海报、年份、季集网格，而这些全部来自 `works` 行——识别失败时它们**不存在**。
// 「不露出」说的是**不给卡片**，不是"这个数字不许被用户知道"。
//
// 反证（若按"任何地方都不许提"解读会自相矛盾）：R-F1 同一句话里写着
//   「未识别资源**不给用户改**（底线是按 `title (year)` 命名）」
// 「底线是按 title (year) 命名」是一条**给用户的行动指令**。用户收不到"有东西没认出来"
// 这个信号，就永远不知道该去改哪个目录的名字——那条指令的收件人不存在。故 R-F2 与
// R-F1 只有在"数量可见、卡片不可见、编辑不可用"这个组合下才同时成立。
//
// ── 信息量边界（R-F9/R-F10：排障归排障）────────────────────────────────────
// 出：**目录名** + 数量。目录名是用户要改的那个东西本身，与 RootHealthNote 列出根路径
//     同一条理由（「这不是排障细节，这是这条提示唯一可操作的部分」）。
// 不出：`last_error` 原文（`evidence-fail: …` / `tmdb-404` / LLM 异常串）、
//       `attempt` 重试计数、`next_retry_at` 退避时刻、文件绝对路径、逐文件清单。
//       那四样全是排障读数，正确去处是 doctor 按钮与日志（同 rootHealth.ts 的既有裁决）。
// 出**目录名**而不是**绝对路径**：`work_dir` 的最后一段就是用户在文件管理器里看到、
//       要改名的那个东西；前面的挂载点前缀对他毫无信息量，
//       且把容器内路径贴给用户是纯排障噪音。
import type { ScoutDb } from '../v2/db.js'

/** 一个认不出来的作品目录。**刻意只有两个字段**——多一个就是往界面上搬排障读数。 */
export interface UnidentifiedDirDTO {
  /** 目录名（`work_dir` 的最后一段），**不是绝对路径**。用户要改名的就是这个东西。 */
  dirName: string
  /** 这个目录下有几个视频文件认不出来。用户判断"这值不值得我去改名"的唯一依据
   *  （1 个文件的目录与 24 集的目录，优先级对他完全不同）。 */
  fileCount: number
}

/** `/api/v2/health` 的 `unidentified` 段。 */
export interface UnidentifiedHealthDTO {
  /** 认不出来的**目录**数（不是文件数）。粒度与 R-F4「粒度=作品不是集」一致：
   *  识别是按 `work_dir` 整体成败的（identifyScheduler 按目录取件、按目录回写退避），
   *  报文件数会把"一个目录 24 集"说成 24 个问题，而用户只需要改 1 次名字。 */
  dirCount: number
  /** 前 `MAX_LISTED_DIRS` 个目录（文件多的在前）。`dirCount` 超过上限时这里是截断的，
   *  两个字段刻意分开：前端要能说出"另外还有 N 个"，而不是让用户以为只有这几个。 */
  dirs: UnidentifiedDirDTO[]
}

/** 列出的目录上限。
 *
 *  为什么要有上限：这份数据的用途是"提醒 + 指出改哪个"，不是清单导出。用户第一次接一个
 *  没整理过的库时，认不出来的目录可能是三位数——把它们全 JSON 出去、再在活动页状态条上
 *  铺开，那一行会长到把整个页面顶掉，且第 200 个目录名对"我该去改名了"这个结论零边际
 *  信息量。8 个足够让用户认出"是我那批下载没改名"这件事，剩下的靠 `dirCount`。
 *
 *  ⚠️ 生产实测（2026-08-13）：`files.work_id IS NULL` 当前 **0 行**（1192 文件全部已识别
 *  进 110 个 works），`parked_paths` 同样 **0 行**。故这个上限今天不会被触发——它防的是
 *  "用户加一个新的没整理过的守备目录"那一刻，而那是这条提示最该好好工作的时刻。 */
export const MAX_LISTED_DIRS = 8

/**
 * `files` 里认不出来的目录汇总。
 *
 * 🔴 谓词是 `work_id IS NULL`，**不带** identifyScheduler 那两个额外条件
 * （`next_retry_at <= now` 与 `last_error != 'tmdb-404'`）。这是刻意的，也是本模块存在的
 * 核心理由：
 *   · identifyScheduler 的谓词回答「**现在该派谁去识别**」——退避窗未到的、404 终态的
 *     都该被排除，那是调度问题。
 *   · 本函数回答「**用户的库里现在有几个东西认不出来**」——一个 404 终态的目录**永远**
 *     不会再被识别，它恰恰是用户**最**需要知道的那一类（其余的至少每天还会自动重试一次）。
 * 拿调度谓词来算展示数字，会让那批永久卡住的文件在界面上也永久消失——那正是本模块要修的
 * 那个病，换个地方原地复活。
 *
 * 🔴 不读 `parked_paths`：那张表属于旧世界的 `v2/ingest.ts`（它同时写 series/episodes/movies）。
 * 生产实测坐实它已停摆——`meta.last_ingest_at` 停在 2026-08-10（58 小时前），而
 * `meta.last_inspect_at`（daemonV2 写）是 13 小时前；`series`/`episodes`/`movies`/
 * `parked_paths` 四张表**全部 0 行**，`files` 1192 行 / `works` 110 行。daemonV2 的头注释
 * （daemonV2.ts:331）自己写明「daemonV2 不跑 ingest」。给一张生产恒空的表建读出面，
 * 是造第 7 个"有能力但没人触发"，不是修第 6 个。
 */
export function buildUnidentifiedHealth(db: ScoutDb): UnidentifiedHealthDTO {
  const rows = db
    .prepare(
      `SELECT work_dir, COUNT(*) AS n
       FROM files
       WHERE work_id IS NULL
       GROUP BY work_dir
       ORDER BY n DESC, work_dir ASC`,
    )
    .all() as Array<{ work_dir: string; n: number }>

  return {
    dirCount: rows.length,
    dirs: rows.slice(0, MAX_LISTED_DIRS).map((r) => ({
      dirName: basenameOf(r.work_dir),
      fileCount: r.n,
    })),
  }
}

/** `work_dir` → 最后一段。
 *
 *  不用 `node:path` 的 `basename`：`work_dir` 存的是**被扫到时的那个平台的**路径分隔符，
 *  而 dashboard 可能跑在别的平台上（`path.basename` 在 win32 上会同时认 `/` 与 `\`，
 *  在 posix 上只认 `/`）。这里两种分隔符都切，与平台无关。
 *
 *  末尾有分隔符（`…/Show/`）时取最后一个非空段，不返回空串——空串在界面上是一行
 *  什么都没有的提示，比缺这一项更难排查。全空（`work_dir` 本身是 '/' 或 ''）时
 *  回落原串：宁可显示一个奇怪的值，也不显示空白。 */
function basenameOf(workDir: string): string {
  const segs = workDir.split(/[/\\]+/).filter((s) => s.length > 0)
  return segs.length > 0 ? segs[segs.length - 1]! : workDir
}
