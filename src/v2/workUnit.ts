import { dirname, resolve } from 'node:path'
import { containingRoot } from '../core/mediaContext.js'
import { detectSeasonFolder, CATEGORY_DIR_NAMES } from '../recognition/identifyFromPath.js'

/**
 * 作品单元（work unit）——未识别队列的粒度单位。
 * spec: docs/design/2026-08-07-work-unit-pipeline-spec.md §3
 *
 * 为什么存在：此前 buildUnidentifiedTargets 扁平取 60 个文件，导致
 *  ① 同一部剧的集数可能跨批次被切散 → 裸集号 absolute/seasonal 歧义失去唯一判据
 *    （同目录 sibling 文件），identifyMediaSkill.ts:20-26 把这记为"今夜不做"的缺口；
 *  ② 同一部剧在两批里各搜一次 TMDB，纯浪费；
 *  ③ 字幕源通常是整季/整剧合集，按批找字幕会把同一个合集页搜多次。
 *
 * 本模块是**纯路径推导**：零 I/O（不 stat、不 readdir），所有输入来自 parked_paths 行 +
 * 配置根数组。沙盒纪律的执行点在调用方的 assertDirSafe（OUTER 门），不在这里——本模块只
 * 负责"给出一个不越界的分组答案"，越界拦截是上一层职责。
 */

/** 扁平文件（配置根下没有专属作品目录的文件）的合成单元大小。
 *
 *  为什么要切（二轮审计 R2-B2）：一轮让"配置根下所有扁平文件"成为一个单元，`Movies/` 有 200
 *  个扁平电影就是一个 200 目标的 job —— 烧穿 stepCap（2026-07-28 那场 384 条编造事故的唯一
 *  诱因就是步数见底）+ 撞 findSubtitleWorker 的 1h timeout 硬顶。
 *
 *  为什么切它不违反"兄弟不切散"：扁平文件彼此**没有** sibling 关系（没有共同作品目录 = 各是
 *  各的作品），§3.1 那条原则保护的是同一部剧的集数。 */
export const FLAT_BATCH_SIZE = 8

/** 一个 job 最多带多少个目标文件。对齐 2026-07-28 事故后定的实测安全值（旧 limit=60）。
 *  单个单元自身超限时**整单元上车**（接受超限），因为切半会回到"兄弟被切散"的原始问题。 */
export const MAX_TARGETS_PER_JOB = 60

/** 一个 job 最多带多少个作品单元。
 *  3 而非 1（一轮初稿）：1 会让单个 agent 拒识的坏单元永久占据队首（活锁，spec §3.3.1）。
 *  0 是回滚开关：退回旧扁平语义（不分组），见 spec §9.2。 */
export const DEFAULT_UNIT_LIMIT = 3

export type WorkUnitKind = 'work-dir' | 'flat-batch'

export interface WorkUnit {
  /** 沙盒锚点 + prompt 的 mediaRoot。work-dir 时是真实作品目录；flat-batch 时是配置根。 */
  workRoot: string
  /** prompt 措辞分支用：flat-batch 的 target 彼此不是同一部作品，不能说"这是一部作品的完整
   *  文件集"（见 spec §3.4）。 */
  kind: WorkUnitKind
  paths: string[]
}

/** groupIntoWorkUnits 的输入行形状——只取它真正需要的三列，不绑 ParkedPath 全形状
 *  （测试可以给字面量，不用凑满十来个字段）。 */
export interface ParkedRowForGrouping {
  path: string
  last_attempt: number
  next_retry_at: number | null
  /** 已完成的退避阶数。0 = **从未被 agent 试过**（ingest 首次 park 就写 next_retry_at=now+1h，
   *  那是给 ingest 自己的"别每轮重跑昂贵 recognize"节流，不该让新文件等一小时才被识别）。
   *  退避窗只约束 retry_count>0 的行——即真的被 agent 试过且失败的行。 */
  retry_count: number
}

export interface GroupOptions {
  now: number
  /** 默认 DEFAULT_UNIT_LIMIT。0 = 回滚到旧扁平语义。 */
  unitLimit?: number
  /** 默认 MAX_TARGETS_PER_JOB。 */
  maxTargets?: number
}

/**
 * 从视频路径推导它所属的作品根。spec §3.2 的四条规则 + 硬上界。
 *
 * 规则（按顺序）：
 *  1. 当前目录本身就是**最长匹配**的那个配置根 → 停，作品根 = 该配置根
 *     （扁平文件：它没有专属作品目录）
 *  2. 当前目录的父目录是某个配置根 → 停，作品根 = 当前目录
 *  3. 当前目录名匹配季目录形态 → 继续上爬
 *  4. 以上都不满足 → 继续上爬
 *
 * 硬上界：上爬过程中 containingRoot 变 null（爬出全部配置根）→ 立即停，返回最后一个仍在根内
 * 的目录。没有这条，规则 4 会让 `Show/Season 1/Part 2/ep.mkv` 这类不匹配已知形态的中间层一路
 * 爬到配置根之上（正是本轮 §2 要修的 commonDir 越界 bug 的等价形态）。
 *
 * 边界：
 *  · roots 为空（开发/测试态）→ 退化返回 dirname(videoPath)。containingRoot 在空 roots 下恒
 *    返回 null（mediaContext.ts:42），既有代码在这个场景一律降级（isUnderRoots 把空数组当
 *    "不限制"），沿用同一哲学，绝不把有测试锁的降级路径改成硬失败。
 *  · 路径完全在配置根之外 → 同样退化返回 dirname。拦截是调用方 assertDirSafe 的职责。
 *
 * 恒返回**目录**，绝不返回文件路径：findSubtitleWorker.ts:112-116 对每个 target 断言
 * isUnderRoots(dirname(videoPath), [task.mediaRoot])，返回文件路径会让 dirname 恒不在其下 →
 * 整任务抛 "escapes its own sandboxed mediaRoot"。
 */
export function workRootOf(videoPath: string, roots: readonly string[]): string {
  // resolve 归一化（审计 M-2）：containingRoot 内部对两侧都 resolve（mediaContext.ts:38,40），
  // 比较时两侧口径必须一致，否则带尾斜杠/双斜杠/`.` 段的根会让判定全部失效
  // （addRoot 是裸 INSERT 零规范化，settingsRepo.ts:113——根侧不干净真实可达）。
  const fileDir = resolve(dirname(videoPath))
  if (roots.length === 0) return fileDir
  const normRoots = roots.map((r) => resolve(r))

  const owner = containingRoot(fileDir, normRoots)
  // 路径完全在配置根之外 → 退化为文件所在目录。拦截是调用方 assertDirSafe（OUTER 门）的
  // 职责，不在这里——职责单一，避免两处各拦一半。
  if (owner === null) return fileDir
  // 文件直躺配置根下（无任何中间层）→ 作品根即配置根。必须返回**目录**：
  // findSubtitleWorker.ts:112-116 对每个 target 断言 isUnderRoots(dirname(videoPath),
  // [task.mediaRoot])，返回文件路径会让 dirname 恒不在其下 → 整任务抛 "escapes its own
  // sandboxed mediaRoot"。
  if (fileDir === owner) return owner

  // 从配置根**往下**逐层走（而不是从文件往上爬）：作品根是第一个"既非分类桶、也非季目录"的层。
  //
  // 🔴 为什么不是"父目录是配置根就停"（本轮实测踩到的错）：`media/TV/AlphaShow/E01.mkv` 在
  // 那个判据下会停在 `media/TV`——而 TV 是分类桶（CATEGORY_DIR_NAMES 里就有它），把整个 TV
  // 目录当一个作品单元，两部剧的集数会被混进同一批。作品根必须是 AlphaShow 那一层。
  const rel = fileDir.slice(owner.length).split('/').filter(Boolean)
  let current = owner
  for (const seg of rel) {
    current = `${current}/${seg}`
    const lower = seg.toLowerCase()
    // 分类桶（tv/movies/anime/电视剧/…）不是作品名 → 继续往下
    if (CATEGORY_DIR_NAMES.has(lower)) continue
    // 季目录（Season NN/S01/第N季|集|部/Specials）是作品**内部**结构 → 作品根在它之上，
    // 即上一层。能走到这里说明上一层不是分类桶也不是季目录，那就是作品根。
    if (detectSeasonFolder(seg) !== null) {
      return current.slice(0, current.length - seg.length - 1)
    }
    // 既非分类桶也非季目录 → 就是作品根
    return current
  }
  // 全程都是分类桶（如 media/TV/ 下直接躺文件）→ 最后一层即作品根
  return current
}

/**
 * parked 行 → 作品单元清单。spec §3.3 的组批链。
 *
 * 顺序（每一步都有其不可调换的理由）：
 *  1. filter 退避窗——活锁防线（spec §3.3.1）。必须在分组前：退避是路径级事实。
 *  2. groupBy 作品根
 *  3. sort 单元内最小 last_attempt ASC——"最久没被尝试的先上"。不是 first_seen ASC：
 *     后者让刚失败过的坏单元恒排队首（活锁的原始形态）。
 *  4. take unitLimit + 累加 maxTargets——整单元不切半。
 */
export function groupIntoWorkUnits(
  rows: readonly ParkedRowForGrouping[],
  roots: readonly string[],
  opts: GroupOptions,
): WorkUnit[] {
  const unitLimit = opts.unitLimit ?? DEFAULT_UNIT_LIMIT
  const maxTargets = opts.maxTargets ?? MAX_TARGETS_PER_JOB

  // 1. 退避窗（活锁防线）：只约束**被 agent 试过且失败**的行（retry_count>0）。
  //    🔴 retry_count===0 无条件放行：ingest 的 upsertParkedPath 给新 park 的行也写
  //    next_retry_at=now+1h（libraryRepo.ts:819），那是给 ingest 自己的节流（别每轮重跑昂贵
  //    recognize）。若组批也照它过滤，新发现的文件要等整一小时才能被识别——不可接受的行为
  //    退化。next_retry_at 为 null 同样立即 eligible（同 shouldRetryParkedPath 的既有口径）。
  const eligible = rows.filter(
    (r) => r.retry_count === 0 || r.next_retry_at == null || opts.now >= r.next_retry_at,
  )
  if (eligible.length === 0) return []

  // unitLimit=0：回滚开关，退回旧扁平语义（不分组，一个伪单元装到 maxTargets 为止）。
  // 注意多根部署下必须按配置根分开——否则 workRoot 取自第一条路径却装跨全部根的 paths，
  // findSubtitleWorker.ts:112-116 断言每个 target 在 [task.mediaRoot] 之下就抛越界错。
  if (unitLimit === 0) {
    const sorted = [...eligible].sort((a, b) => a.last_attempt - b.last_attempt)
    const byRoot = new Map<string, string[]>()
    for (const row of sorted) {
      const wr = workRootOf(row.path, roots)
      const owner = roots.length > 0 ? containingRoot(wr, roots.map((r) => resolve(r))) : wr
      const key = owner ?? wr
      const bucket = byRoot.get(key)
      if (bucket) bucket.push(row.path)
      else byRoot.set(key, [row.path])
    }
    return [...byRoot.entries()].map(([root, paths]) => ({
      workRoot: root,
      kind: 'flat-batch' as const,
      paths: paths.slice(0, maxTargets),
    }))
  }

  // 2. 分组。同时按"该文件有没有专属作品目录"分流：workRoot === 它自己的归属配置根
  //    ⇒ 扁平文件（规则 1 命中），要走 FLAT_BATCH_SIZE 切分而不是整根一个单元。
  interface Bucket { workRoot: string; kind: WorkUnitKind; rows: ParkedRowForGrouping[] }
  const buckets = new Map<string, Bucket>()
  for (const row of eligible) {
    const workRoot = workRootOf(row.path, roots)
    const owner = roots.length > 0 ? containingRoot(workRoot, roots.map((r) => resolve(r))) : null
    const kind: WorkUnitKind = workRoot === owner ? 'flat-batch' : 'work-dir'
    // flat-batch 的 key 必须与 work-dir 区分：同一个配置根下既可能有扁平文件（key=根）
    // 又可能有作品目录（key=作品目录），前者聚一起后者各自成组。
    const key = `${kind}:${workRoot}`
    const bucket = buckets.get(key)
    if (bucket) bucket.rows.push(row)
    else buckets.set(key, { workRoot, kind, rows: [row] })
  }

  // 3. 排序：单元内最小 last_attempt ASC。
  const ordered = [...buckets.values()]
    // reduce 而非 Math.min(...spread)：spread 实参上限约 65535，扁平根挂 6.5 万+ 文件时
    // 会抛 RangeError（审计 m-3）。扁平根正是 §3.2 特殊处理的场景，不能留这个天花板。
    .map((b) => ({ ...b, oldest: b.rows.reduce((m, r) => Math.min(m, r.last_attempt), Infinity) }))
    .sort((a, b) => a.oldest - b.oldest)

  // 4. 展开成单元（扁平桶切成 FLAT_BATCH_SIZE 份），再按 unitLimit + maxTargets 收口。
  const out: WorkUnit[] = []
  let budget = maxTargets
  for (const bucket of ordered) {
    if (out.length >= unitLimit) break

    const rowsSorted = [...bucket.rows].sort((a, b) => a.last_attempt - b.last_attempt)
    const candidates: string[][] = bucket.kind === 'flat-batch'
      ? chunk(rowsSorted.map((r) => r.path), FLAT_BATCH_SIZE)
      : [rowsSorted.map((r) => r.path)]

    for (const paths of candidates) {
      if (out.length >= unitLimit) break
      // 超限单元（自身 > maxTargets）：按 spec §3.3.2 裁决「单独成一个 job」，直接上车不参与
      // 预算博弈，否则任何更老的小单元存在就把它挤掉（审计 M-1）。上车后立刻 return：它按
      // 定义就是"单独"，不与其它单元共存。
      if (paths.length > maxTargets) {
        out.push({ workRoot: bucket.workRoot, kind: bucket.kind, paths })
        return out
      }
      // 整单元不切半：预算不够就留到下一轮（下一轮它会更老 → 排队首）。
      if (paths.length > budget) break  // break 而非 continue：桶内 chunk 遇第一个装不下就停
      out.push({ workRoot: bucket.workRoot, kind: bucket.kind, paths })
      budget -= paths.length
      if (budget <= 0) return out
    }
  }
  return out
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
