// 去 Jellyfin 化战役 P2（design: docs/design/2026-07-16-de-jellyfin-design.md §P2）：
// 自有 id 空间的唯一构造/解析入口。series/movies.id = 'tmdb:<TMDB id>'；
// episodes.id = 'tmdb:<TMDB id>/s<N>e<M>'（无零填充——s1e2，非 s01e02）。
// id 即身份：库行 id 本身就能换回 TMDB id，不再需要 jf.getItem 这类"拿 id 换身份"的缝。
// 命名锁定给下游消费：T3 摄取层用 seriesId/episodeId 写行；T5 orchestrator 缝、T7 realign
// port 用 tmdbIdFromOwnId 读行——三处都复用这里，不允许各写各的解析逻辑。
import { createHash } from 'node:crypto'

/** series/movies 的自有主键：tmdb:<id>（TMDB id 原样嵌入，不做零填充/格式化）。 */
export function seriesId(tmdbId: string): string {
  return `tmdb:${tmdbId}`
}

/** episodes 的自有主键：tmdb:<id>/s<N>e<M>（无零填充，如 s1e2，非 s01e02）。 */
export function episodeId(tmdbId: string, season: number, episode: number): string {
  return `tmdb:${tmdbId}/s${season}e${episode}`
}

// episodes 形状先匹配（更具体），否则 series 形状的宽松 [^/]+ 会拒绝任何带 '/' 的输入，
// 两个正则互斥不会误判。
const EPISODE_ID_RE = /^tmdb:([^/]+)\/s\d+e\d+$/
const SERIES_ID_RE = /^tmdb:([^/]+)$/

/**
 * 从自有 id 的任一形状提取 TMDB id：series/movies 的 'tmdb:<id>' 或 episodes 的
 * 'tmdb:<id>/s<N>e<M>'。非本形状（如遗留合成 id 'self-scan-trigger'、空串、格式错误）
 * 返回 null，不抛错——调用方拿到 null 按"非自有 id"分支处理，不该整个工具因为一个
 * 意外形状的 id 而崩溃。
 */
export function tmdbIdFromOwnId(ownId: string): string | null {
  const episodeMatch = ownId.match(EPISODE_ID_RE)
  if (episodeMatch) return episodeMatch[1]
  const seriesMatch = ownId.match(SERIES_ID_RE)
  if (seriesMatch) return seriesMatch[1]
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// TranslateTask.itemId 的形态（spec §4 第 4 步 · 缺口 C20）。
//
// 新架构的翻译流按 **work_id + 文件** 定位一个活（旧世界是 episodes.id / movies.id）。
// 形态定为 `<work_id>/<稳定file标识>`，其中 work_id 形如 `tmdb:123`（内无 `/`）。
//
// **为什么必须是这个形态、而不是"work_id + 绝对路径"（这就是 C20 的实质）**：
// 有一个隐藏消费者——`agent/translateWorker.tools.ts:346/663` 用 `seriesKeyOf(task.itemId)`
// 加载/保存**剧级术语表**，而 `v2/glossaryRepo.ts` 的 seriesKeyOf 实现是：
//     const idx = itemId.indexOf('/'); return idx > 0 ? itemId.slice(0, idx) : itemId
// 若 itemId 以绝对路径开头（`/mnt/...`）→ `indexOf('/') === 0` → `idx > 0` 为假 →
// **返回整个字符串** → 每个文件一个 glossary key。
//
// 后果（db.ts 的 translate_glossaries 注释记有实案）：同剧第 2 集拿不到第 1 集冻结的术语表，
// 人名地名每集换译法——实案是同一模型同剧两 run 分别选出"东国 / 奥斯塔尼亚"。
// 功能"能跑"、字幕"能出"，只是质量逐集漂移，**没有任何断言会红**。故这是 spec 里唯一被标成
// "测试抓不到"的缺口，也是把形态收进本文件（自有 id 空间的唯一构造/解析入口）的理由：
// 让 `work_id` 落在第一个 `/` 之前是一条**结构不变量**，不是某个调用点的自觉。
//
// 为什么不改 glossaryRepo.seriesKeyOf 去直接取 work_id：那是"改消费者迁就生产者"。
// seriesKeyOf 同时还服务旧世界的 episodes own-id（`tmdb:123/s1e2`），改它要同时兼容两种形状；
// 而让新形态**天然满足既有契约**是零风险的一侧。新旧形态在 seriesKeyOf 眼里完全同构，
// 存量 translate_glossaries 行（key 是 `tmdb:<id>`）因此可以被新形态直接继承——
// 这是白捡的：换个形态就等于把已冻结的术语表全部作废、每部剧重决一次译名。
// ─────────────────────────────────────────────────────────────────────────────

/** 文件在 itemId 里的稳定标识。
 *
 *  三条硬要求，各自堵一个具体的坑：
 *   ① **内不含 `/`** —— 否则 itemId 里出现第二个 `/`，反解 work_id/file 段变歧义。
 *   ② **不同 path 不相撞** —— 只取 basename 会让 `Season 01/E01.mkv` 与 `Season 02/E01.mkv`
 *      撞成同一个 itemId，而 itemId 就是 job identity（`translate:<itemId>` 的 upsert 键）
 *      → 第二季第一集永远派不出活，静默少翻一批文件。故按**全路径**取摘要。
 *   ③ **稳定可重现** —— itemId 若含时间戳/随机量，每轮 upsert 出一行新 job → 同一集被反复
 *      翻译，付费 LLM 热循环。
 *
 *  用短 sha1（12 hex）而不是把路径转义进去：路径里有空格/中文/括号/连字符（生产守备目录
 *  全是这些形状），塞进 id 会让 jobs 表里的 identity 长到不可读、且转义规则本身成为第二个
 *  需要维护的契约。作为补偿，itemId 的第一段仍是人可读的 work_id，排障时 work_id + path 能
 *  重算出同一个 key（见 ownIds.test.ts 的反解用例）。
 *
 *  为什么不用 `files.id`（4-2 实现时提出、编排侧裁决保留 sha1，2026-08-08）：
 *  files.id 直接可 join、排障更方便，但它是 AUTOINCREMENT —— 行被删除重建后 id 会变，
 *  而 sha1 只认路径、不认行的生命周期。翻译工作台是 `.subtitle-translate/<jobId>/`，
 *  里面存着冻结的术语表与半成品行；id 一漂移，重建后的行就认不出自己上次跑到哪，
 *  那正是 GC 误删（gcOrphans 按 jobId 判在飞行）与重复翻译（同一集付费翻两遍）的入口。
 *  可 join 是排障便利，身份稳定是正确性——后者优先。 */
export function translateFileKey(videoPath: string): string {
  return createHash('sha1').update(videoPath).digest('hex').slice(0, 12)
}

/** TranslateTask.itemId：`<work_id>/<translateFileKey(path)>`。
 *
 *  work_id 原样嵌入（不校验形状）：库里的 work_id 由 identifyScheduler 写成 `tmdb:<id>`，
 *  而 C20 要守的不变量只有一条——**第一个 `/` 之前是完整的 work_id**。这对任何内部无 `/`
 *  的 work_id 都成立，无需把 tmdb: 前缀硬编码进这里（那样将来接第二个 provider 就得改这一行）。 */
export function translateItemId(workId: string, videoPath: string): string {
  return `${workId}/${translateFileKey(videoPath)}`
}

/** itemId → work_id（第一个 `/` 之前）。语义与 glossaryRepo.seriesKeyOf 对同一输入完全一致
 *  ——**刻意的重复**：这里是翻译流自己的反解入口，那边是 glossary 的 key 推导。
 *  两者同值这件事本身就是 C20 的不变量，由 ownIds.test.ts 的红线用例跨模块钉住；
 *  把这里改成直接调 seriesKeyOf 会让那条红线退化成同一表达式的自我比较（假绿）。 */
export function workIdFromTranslateItemId(itemId: string): string {
  const idx = itemId.indexOf('/')
  return idx > 0 ? itemId.slice(0, idx) : itemId
}

/** itemId → file 标识（第一个 `/` 之后）。无 `/` 时返回空串（不是抛错——排障工具读它，
 *  遇到一个形状意外的 id 不该让整个视图崩掉，同 tmdbIdFromOwnId 的 null 口径）。 */
export function fileKeyFromTranslateItemId(itemId: string): string {
  const idx = itemId.indexOf('/')
  return idx > 0 ? itemId.slice(idx + 1) : ''
}

/** 翻译工作台的 jobId，同时也是它的**目录名**（`<root>/.subtitle-translate/<jobId>/`，
 *  见 translate/workspace/paths.ts 的 workspacePaths）。与字幕流的 `subtitleJobId` 同职、同理由。
 *
 *  ── 为什么必须存在、且必须是稳定身份（2026-08-08 live test 实测缺陷）──
 *  旧值是 `daemon-${Date.now()}` / `cli-${Date.now()}`，实测后果是工作台**永久残留**：
 *  `_scout_live_test/TV/.subtitle-translate/daemon-1786390499859/` 312KB，翻译已成功、
 *  sub_status 已闭环到 covered，目录还在。时刻做目录名同时坏了两件独立的事：
 *   ① **循环层无法预知** → 没法在开工前把它登记进 `gcOrphans` 的 in-flight 集合（字幕流靠
 *      `subtitleJobId` 做到了这一点，C34）。于是"正在跑的翻译工作台"唯一的保护是 mtime
 *      10 分钟活性窗口，而一次 pro reasoning 的两步之间静默几十分钟是常态 → boot GC 会把
 *      跑了两小时的现场整个 rm 掉（gcOrphans 的 R6-9/R7-1 两次修复都在还这笔债）。
 *   ② **每次调用都是新值** → 同一集每次失败重试都堆一个新目录，成功后也没人按名字回收，
 *      媒体目录里的隐藏目录无界增长（用户看不见，只会看到盘满）。
 *  稳定身份把这两件事同时解掉：可预知 → 能登记；同文件复用 → 不堆积、且成功后可按名字删。
 *
 *  ── 形态：`translate-<work_id 去掉 provider 前缀>-<translateFileKey>`──
 *  **不能直接用 itemId 当目录名**（那是最省事的写法，但错）：itemId 是 `tmdb:123/<key>`，
 *  含 `/` 会让工作台埋进 `.subtitle-translate/tmdb:123/<key>/` 这样的**深层**路径，而
 *  gcOrphans 只在每个媒体根下**非递归**扫 `.subtitle-translate/` 的直接子条目——够不到就是
 *  永久泄漏（同一条论证见 stagingSandbox.allocate 的头注释）。`:` 同样不能留：生产的媒体根是
 *  群晖 SMB 与 rclone FUSE 挂载，冒号在 SMB/exFAT 上是非法文件名字符，mkdir 直接失败 →
 *  翻译流整支起不来。故 work_id 里的 `:` 一律换成 `-`。
 *
 *  仍保留可读的 work_id 段（不是纯哈希）：运维 `ls .subtitle-translate/` 时要能看出
 *  "这是哪部剧的残留"，同 itemId 的可读性要求。 */
export function translateJobId(workId: string, videoPath: string): string {
  // 只替换目录名非法/易碎的字符，其余原样保留（同 translateItemId "work_id 原样嵌入"的口径：
  // 不校验形状、不硬编码 tmdb: 前缀，将来接第二个 provider 不用改这一行）。
  const safeWorkId = workId.replace(/[/\\:]/g, '-')
  return `translate-${safeWorkId}-${translateFileKey(videoPath)}`
}
