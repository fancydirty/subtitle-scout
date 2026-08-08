// src/v2/settingsRepo.ts
import { isAbsolute, resolve, sep } from 'node:path'
import type { ScoutDb } from './db.js'
import { SECRET_NAMES, isSecretName, maskSecretValue, resolveSecret, type SecretName } from './secrets.js'

/** 候选路径与既有守备目录是否重叠（父/子双向），命中则返回撞上的那个根。
 *
 *  为什么两个方向都要挡：
 *   · 子目录重叠 → 该子树已在既有根的扫描范围内，再加一个根只会让 walkVideoFiles 把同一批
 *     文件走两遍（本项目实测：4 个重叠根让 scanned 从 492 涨到 3140），并让同一文件在两个根
 *     下各自登记，覆盖分类与移除防线全部按"两份不同事实"处理。
 *   · 父目录重叠 → 同上，且更糟：父目录通常还装着非媒体杂物（本项目生产实例：nas_media 根下
 *     混着 .apk/.iso/Backup_ 目录/node_modules），一次误加就把整堆垃圾拉进识别队列烧 token。
 *
 *  D7（2026-08-08）：本函数原在 dashboard/apiV2.ts 内私有，只护住 HTTP 端点这一个入口。
 *  下移到此处是因为 D1 的删除逻辑（逐守备目录比对差集）在嵌套配置下会删库——/media 与
 *  /media/115 并存时，115 挂载掉线后 /media 的 walk 仍成功，115 下的行落进 /media 的差集
 *  被当成"消失的文件"全删（缺口 C29，正是 R8 保护要防的灾难）。故 addRoot 本身必须成为闸门，
 *  连 seedRootsFromEnv 这条绕过 HTTP 层的旁路一起堵上。apiV2 改 import 同一份实现——
 *  两份会漂移。
 *
 *  边界感知（同 removeRoot 的既有手法）：比较时给两侧都补 sep，避免 "/media/tv" 被判成
 *  "/media/tv2" 的父目录。相等不算重叠——那是重复提交同一根，交给 addRoot 的幂等语义。
 *
 *  尾部斜杠归一化（审校 F3，2026-08-08）：比较前剥掉尾部分隔符。不做这步的话
 *  `'/media/tv/' + sep` 会变成 `'//'`，startsWith 永不命中——而带尾斜杠的根**真实可达**：
 *  seedRootsFromEnv 只做 trim()、零路径规范化，`MEDIA_ROOTS=/media/tv/` 就能种进库。
 *  此后加子目录绕过本闸门，D1 的逐根差集就把子根的行当成"消失的文件"全删（C29）。
 *  HTTP 入口有 resolve() 兜住，但 env 种子这条旁路没有——而 D7 的全部意义正是堵旁路。
 *
 *  返回命中的既有根（而不只是布尔）：错误文案要指名道姓说"跟哪个根撞了"，否则用户面对
 *  一串路径无从判断该删哪个。返回的是**原始形态**的根（未剥尾斜杠），因为文案要跟用户在
 *  配置里看到的字符串对得上。 */
export function findOverlappingRoot(
  candidate: string, existing: readonly string[],
): { root: string; relation: 'parent' | 'child' } | null {
  const c = stripTrailingSep(candidate)
  for (const root of existing) {
    const r = stripTrailingSep(root)
    if (c === r) continue // 相等=重复提交，非重叠（幂等交给 addRoot）
    if (c.startsWith(withSep(r))) return { root, relation: 'child' }
    if (r.startsWith(withSep(c))) return { root, relation: 'parent' }
  }
  return null
}

/** 剥掉路径尾部的分隔符，但保留根目录本身（'/' 剥成 '' 会让后续拼接全错）。 */
function stripTrailingSep(p: string): string {
  let end = p.length
  while (end > 1 && p[end - 1] === sep) end--
  return p.slice(0, end)
}

/** 给路径补一个尾部分隔符用于前缀比较，**根目录不重复补**（审校 F1，2026-08-08）。
 *
 *  为什么单独一个函数：裸写 `r + sep` 在 r='/' 时得到 '//'，startsWith 永不命中 →
 *  根目录 '/' 双向逃过嵌套闸门。而 '/' 是 100% 的嵌套配置（它覆盖所有其他根）：
 *  库里有 /media/tv 再加 '/' 之后，/media/tv 挂载掉线时 '/' 的 walk 仍成功，
 *  /media/tv 下的 files 行落进 '/' 的差集被当成"消失的文件"全删（C29）。
 *  成因正是 stripTrailingSep 刻意保留 '/' 那一步——保留是对的，补 sep 时必须配套判断。 */
function withSep(p: string): string {
  return p.endsWith(sep) ? p : p + sep
}

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
  /** D11 / C33（2026-08-08）：新架构 files 表的清理数。旧表计数保留是因为迁移未完成，
   *  第 7 步清掉旧表后这里只剩 files。 */
  files: number
}

/** 嵌套冲突事实：撞上的既有根（原始形态，未剥尾斜杠——错误文案要跟用户在配置里
 *  看到的字符串对得上）+ 方向。 */
export interface RootConflict {
  root: string
  relation: 'parent' | 'child'
}

/** addRoot 的结果（D7）。用返回值而非抛异常，因为 seedRootsFromEnv 批量种入时
 *  单条冲突不该中断整批。 */
export type AddRootResult = { ok: true } | { ok: false; conflict: RootConflict }

/** seedRootsFromEnv 的结果（D7）：调用方据此打告警——env 顺序会静默决定守备范围
 *  （先写的赢），不让运维看见的话"为什么少了一个根"无从排查。
 *
 *  rejected 分两种原因（审校 F6）：
 *   · 'nested'      —— 与既有根嵌套，conflict 说明撞上谁、哪个方向
 *   · 'not-absolute' —— 相对路径。必须拒绝而非 resolve()，否则 MEDIA_ROOTS=media/tv 会
 *     静默落成 <cwd>/media/tv（容器里 = /app/media/tv），运维完全看不出守备目录跑哪去了。
 *     apiV2 那条路早有 isAbsoluteMediaPath 门，env 这条路一直没有——宁可拒绝也不要猜。 */
export interface SeedRootsResult {
  seeded: string[]
  rejected: SeedRootRejection[]
}

export type SeedRootRejection =
  | { path: string; reason: 'nested'; conflict: RootConflict }
  | { path: string; reason: 'not-absolute' }

/** 一对存量嵌套守备目录（D7 附加）：root 是外层、nested 是内层，与插入顺序无关。
 *  每一对单独就足以让 D1 的逐根差集把内层的 files 行当成"消失的文件"清掉（C29）。 */
export interface NestedRootPair {
  root: string
  nested: string
  relation: 'child'
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

  /** 前缀枚举（quota_state_* 旁路键消费用）。不用 LIKE——键名虽然目前不含 %/_，但仓库同文件
   *  media_roots 一带已确立 substr 判前缀的先例（LIKE 通配符语义陷阱），沿用同款。 */
  listByPrefix(prefix: string): Array<{ key: string; value: string }> {
    return this.db.prepare(
      'SELECT key, value FROM settings WHERE substr(key, 1, ?) = ? ORDER BY key'
    ).all(prefix.length, prefix) as Array<{ key: string; value: string }>
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }

  // ── 启动面（spec A §4.1）：secret:* 键空间。明文存 settings 表（决策与理由见 spec §4.1），
  // 任何读回都走 listSecretMeta 打码；getSecret 只供进程内消费（buildAdapters/assemble/setupApi）。
  // 每次写入/删除都 bump secrets_version 计数行——watch 每 tick 比对它决定要不要热重建长命客户端。

  getSecret(name: SecretName): string | null {
    return this.get(`secret:${name}`)
  }

  setSecret(name: SecretName, value: string, now: number): void {
    if (!isSecretName(name)) throw new Error(`unknown secret name: ${name}`)
    this.set(`secret:${name}`, value, now)
    this.bumpSecretsVersion(now)
  }

  deleteSecret(name: SecretName, now: number): void {
    if (!isSecretName(name)) throw new Error(`unknown secret name: ${name}`)
    this.delete(`secret:${name}`)
    this.bumpSecretsVersion(now)
  }

  /** 任何 secret 写入自增的计数器；无行/脏值视为 0。 */
  secretsVersion(): number {
    const raw = this.get('secrets_version')
    const n = raw === null ? 0 : Number(raw)
    return Number.isFinite(n) ? n : 0
  }

  private bumpSecretsVersion(now: number): void {
    this.set('secrets_version', String(this.secretsVersion() + 1), now)
  }

  /** 只回哪些已设置 + 打码预览 + source；永不回明文（Providers 区/setup status 的唯一读面）。 */
  listSecretMeta(env: NodeJS.ProcessEnv): SecretMeta[] {
    return SECRET_NAMES.map((name) => {
      const r = resolveSecret(name, env, (n) => this.getSecret(n))
      return {
        name,
        set: r.source !== 'none',
        source: r.source,
        masked: r.value === null ? null : maskSecretValue(r.value),
      }
    })
  }

  // ---- media_roots(path,type,added_at)：守备目录 ----

  listRoots(): MediaRoot[] {
    return (
      this.db.prepare('SELECT path, type, added_at FROM media_roots ORDER BY path').all() as
        { path: string; type: string; added_at: number }[]
    ).map((r) => ({ path: r.path, type: r.type, addedAt: r.added_at }))
  }

  /** 加一个守备目录。**嵌套闸门在此**（D7，2026-08-08）。
   *
   *  返回值而非抛异常：seedRootsFromEnv 是批量种入，单条冲突不该中断整批——env 里配了
   *  3 个根、第 2 个跟第 1 个嵌套时，第 3 个（好的那个）必须还能进。
   *
   *  为什么闸门必须在这一层：apiV2.addMediaRoot 早就有重叠校验，但它只护住 HTTP 这一个
   *  入口；seedRootsFromEnv 那条 env 种子路零规范化、零校验直接写库。而 D1 的删除逻辑是
   *  「逐守备目录比对差集」——/media 与 /media/115 并存时，115 挂载掉线后 /media 的 walk
   *  仍成功，115 下的 files 行落进 /media 的差集被当成"消失的文件"全删（C29 = R8 要防的灾难）。
   *
   *  重复加同一路径仍是幂等的（INSERT OR IGNORE：path 是主键，已存在则什么都不改，包括
   *  不刷新 added_at——"何时首次加入"是该行的出生事实，不因为重复提交同一路径而改写）。
   *  尾斜杠形态的重复提交（'/media/tv/' vs 已有 '/media/tv'）经 findOverlappingRoot 的
   *  归一化判为"相等"→ 落到 INSERT OR IGNORE，同样幂等。
   *
   *  **入库前归一化**（resolve）：数据库存规范形态，否则 '/media/tv/' 与 '/media/tv' 会各插一行
   *  ——INSERT OR IGNORE 的主键是原始字符串，两者不等，幂等根本不生效（本 task TDD 抓到的真 bug）。
   *  只在比较侧归一化是不够的。resolve 同时收拾尾斜杠、重复斜杠、'..'，与 apiV2 入口的既有
   *  归一化口径一致（那边一直在 addRoot 前 resolve，env 种子那条路没有——正是要堵的旁路）。
   *
   *  事务：读既有根 + 写新根包进 immediate 事务（照 removeRoot 的既有手法），
   *  否则两个并发 addRoot 各自读到"无冲突"的旧快照，双写出一对嵌套根。 */
  addRoot(path: string, now: number): AddRootResult {
    const canonical = resolve(path)
    const tx = this.db.transaction((): AddRootResult => {
      const existing = (
        this.db.prepare('SELECT path FROM media_roots').all() as { path: string }[]
      ).map((r) => r.path)
      const conflict = findOverlappingRoot(canonical, existing)
      if (conflict) return { ok: false, conflict }
      this.db
        .prepare("INSERT OR IGNORE INTO media_roots (path, type, added_at) VALUES (?, 'local', ?)")
        .run(canonical, now)
      return { ok: true }
    })
    return tx.immediate()
  }

  /** 把存量守备目录归一化成规范形态（审校 F2，2026-08-08）。
   *
   *  为什么必须有这一步：Task 1a-2 给 addRoot 加了入库前 resolve()，但那只管**新写入**。
   *  闸门上线前写进库的非规范形态（尾斜杠 '/media/tv/'、重复斜杠 '/media//tv'）会留下三个病：
   *   1. findOverlappingRoot 比较时剥尾斜杠所以能识别嵌套，但 INSERT OR IGNORE 的幂等靠
   *      **主键字符串相等**——存量 '/media/tv/' 与新写的 '/media/tv' 不等 → 两行共存
   *      （实测确认），逻辑同一个目录，此后每轮扫描把同一批文件走两遍
   *   2. 这行用户**从 UI 删不掉**：removeRoot 按 path 精确匹配，而 dashboard 传下来的路径
   *      已经 resolve() 过，与库里的非规范字符串对不上
   *   3. D1 的删除逻辑按守备目录逐个比对差集——两行"同一目录"各算一次
   *
   *  去重时 added_at 取较早的：'何时首次加入'是该目录的出生事实，不因为存在过一个
   *  非规范别名而改写。 */
  normalizeRoots(): void {
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare('SELECT path, added_at FROM media_roots').all() as
        { path: string; added_at: number }[]
      const del = this.db.prepare('DELETE FROM media_roots WHERE path = ?')
      const upd = this.db.prepare('UPDATE media_roots SET path = ?, added_at = ? WHERE path = ?')
      const fixAddedAt = this.db
        .prepare('UPDATE media_roots SET added_at = ? WHERE path = ? AND added_at > ?')

      // canonical → 该规范形态下最早的 added_at（含已规范的行）。
      // "何时首次加入"是该目录的出生事实，不因为存在过一个非规范别名而改写。
      const earliest = new Map<string, number>()
      for (const r of rows) {
        const c = resolve(r.path)
        const prev = earliest.get(c)
        if (prev === undefined || r.added_at < prev) earliest.set(c, r.added_at)
      }

      // 审校 F7 修复：live 集合而非一次性快照。原实现用循环前的 rows 判"规范形态是否已存在"，
      // 当两个不同别名（'/media/tv/' 与 '/media//tv'）指向同一规范形态、且规范形态本身不在库里时，
      // 两条都判"不存在"、都走 UPDATE → 第二条撞 UNIQUE → 事务全回滚，脏数据一行不修。
      // 而两处调用点都没有 try/catch，daemon 启动即死且重启不自愈。
      const present = new Set(rows.map((r) => r.path))
      for (const r of rows) {
        const c = resolve(r.path)
        if (c === r.path) continue // 已是规范形态
        if (present.has(c)) {
          del.run(r.path)          // 规范形态已在（原本就有，或前一轮迭代刚改出来）→ 删别名
        } else {
          upd.run(c, earliest.get(c)!, r.path)
          present.add(c)           // ← 关键：让后续别名看见它，避免重复 UPDATE 撞 UNIQUE
        }
        present.delete(r.path)
      }

      // 规范形态本身的 added_at 可能晚于被删掉的别名——补正为最早的。
      // 条件 `added_at > ?` 是必要的：只在当前值确实更晚时才改，避免把已经正确的更早值写坏。
      for (const [c, at] of earliest) fixAddedAt.run(at, c, at)
    })
    tx.immediate()
  }

  /** 检出存量的嵌套守备目录对（D7 附加，2026-08-08）。
   *
   *  闸门（addRoot）只挡新增。库里可能已有闸门上线前配好的嵌套根——程序**不擅自删**
   *  （守备目录是用户的配置意图），但必须让运维看见：每一对嵌套都会让 D1 的逐根差集
   *  把内层根的 files 行当成"消失的文件"清掉（C29）。
   *
   *  报**全部成对关系**而非只报相邻层：三层嵌套 /a ⊃ /a/b ⊃ /a/b/c 里三对都要报，
   *  因为每一对单独就足以让 D1 删错。
   *
   *  返回 root=外层、nested=内层，与插入顺序无关——文案要能直接说"X 套着 Y"。
   *
   *  注意调用时机：应在 normalizeRoots() 之后。非规范形态（'/media/tv/'）在归一化前
   *  会因 '//' 拼接而漏检（F1 同一漏洞面），归一化后才看得见。 */
  detectNestedRoots(): NestedRootPair[] {
    const paths = (
      this.db.prepare('SELECT path FROM media_roots ORDER BY path').all() as { path: string }[]
    ).map((r) => r.path)
    const pairs: NestedRootPair[] = []
    for (const a of paths) {
      for (const b of paths) {
        if (a === b) continue
        // 只在 a 是 b 的祖先时记一次——这样每对关系恰好产出一条，且 root 恒为外层
        const hit = findOverlappingRoot(b, [a])
        if (hit?.relation === 'child') pairs.push({ root: a, nested: b, relation: 'child' })
      }
    }
    return pairs
  }

  /** 首启种子：media_roots **当前为空**且 envRaw 解析非空（逗号分隔，trim+filter，沿
   *  cli/index.ts 旧 mediaRoots() 同一套解析法）时逐条写入；否则空操作。注意判据是"当前
   *  count=0"而非"从未有过根"——在 dashboard 里删光全部根后重启进程，env 值会重新种入。
   *  这是可接受的（复审修复 3 确认，符合计划原文"空→种子"）：零守备目录的守护进程本无事
   *  可做，env 种子是合理的恢复路径；部署层想彻底清空应同时清掉 MEDIA_ROOTS env。
   *
   *  D7（2026-08-08）：逐条过 addRoot 的嵌套闸门，冲突的**跳过并收集**，不中断整批也不抛。
   *  返回 {seeded, rejected} 供调用方打告警——env 顺序会静默决定守备范围（先写的赢），
   *  这个事实必须让运维看见，否则"为什么少了一个根"无从排查。
   *
   *  相对路径直接拒绝（审校 F6）：addRoot 内部的 resolve() 是相对 process.cwd() 解析的，
   *  MEDIA_ROOTS=media/tv 会静默落成 <cwd>/media/tv（容器里 = /app/media/tv）。
   *  apiV2 那条路早有 isAbsoluteMediaPath 门，env 这条一直没有。宁可拒绝也不要猜。
   *
   *  冲突判定针对**累积集合**：因为闸门在 addRoot 内部按当次实际库状态判，
   *  第 3 条与第 2 条嵌套时同样会被挡（不是只跟初始空快照比）。 */
  seedRootsFromEnv(envRaw: string | undefined, now: number): SeedRootsResult {
    const existing = this.db.prepare('SELECT COUNT(*) as c FROM media_roots').get() as { c: number }
    if (existing.c > 0) return { seeded: [], rejected: [] }
    const roots = (envRaw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const seeded: string[] = []
    const rejected: SeedRootRejection[] = []
    for (const root of roots) {
      if (!isAbsolute(root)) {
        rejected.push({ path: root, reason: 'not-absolute' })
        continue
      }
      const r = this.addRoot(root, now)
      if (r.ok) seeded.push(root)
      else rejected.push({ path: root, reason: 'nested', conflict: r.conflict })
    }
    return { seeded, rejected }
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

    // 审校 F8 修复（2026-08-08）：根目录 '/' 的 prefix 补完还是 '/'，而
    // `substr(path,1,1) = '/'` 对**每一条绝对路径都为真** → files/episodes/movies/parked
    // 全表清空，包括属于其他仍然有效的守备目录的行。
    //
    // 实测的真实剧本：存量库里 '/' 与 '/media/tv' 并存（闸门上线前配的），而 1a-3 的告警
    // 正好引导用户去删 '/'——照着警告操作，/media/tv 下所有行被清空，可它还是守备目录 →
    // 下轮巡检全库重识别 + 重找字幕，烧一整轮 LLM。
    //
    // 修法：一个根"自己管的行" = 在它前缀下、且**不在任何更深守备目录前缀下**的行。
    // 闸门（D7）禁止嵌套，故正常情况 siblingPrefixes 为空、退化成纯 prefix 匹配，
    // 与改动前行为完全一致；只有存量嵌套（含 '/'）才会走排除分支。
    const siblingPrefixes = (
      this.db.prepare('SELECT path FROM media_roots WHERE path != ?').all(path) as
        { path: string }[]
    )
      .map((r) => (r.path.endsWith('/') ? r.path : `${r.path}/`))
      .filter((p) => p !== prefix && p.startsWith(prefix))
    const scopeSql = `substr(path,1,length(?)) = ?`
      + siblingPrefixes.map(() => ' AND substr(path,1,length(?)) != ?').join('')
    const scopeArgs: string[] = [prefix, prefix, ...siblingPrefixes.flatMap((p) => [p, p])]

    const tx = this.db.transaction((): RemoveRootResult => {
      const affectedSeries = this.db
        .prepare(`SELECT DISTINCT series_id FROM episodes WHERE ${scopeSql}`)
        .all(...scopeArgs) as { series_id: string }[]

      const episodeIds = this.db
        .prepare(`SELECT id FROM episodes WHERE ${scopeSql}`)
        .all(...scopeArgs) as { id: string }[]
      const movieIds = this.db
        .prepare(`SELECT id FROM movies WHERE ${scopeSql}`)
        .all(...scopeArgs) as { id: string }[]

      const delSub = this.db.prepare('DELETE FROM subtitles WHERE item_id = ?')
      for (const e of episodeIds) delSub.run(e.id)
      for (const m of movieIds) delSub.run(m.id)

      // DB 审计🟡:item_files/pending_removals 同级级联——libraryRepo.deleteSeriesRows 的
      // "SEVERE 数据腐蚀"修复珠玉在前:owner 删除后 item_files 孤儿行会让副本路径对 ingest
      // 永久隐形(B3-3 短路命中孤儿行,ownerPath null → 不重新识别,磁盘有片库里永远没有,
      // 非自愈)。removeRoot 必须遵守同一约定。
      const delFiles = this.db.prepare('DELETE FROM item_files WHERE item_id = ?')
      for (const e of episodeIds) delFiles.run(e.id)
      for (const m of movieIds) delFiles.run(m.id)
      this.db.prepare(`DELETE FROM pending_removals WHERE ${scopeSql}`).run(...scopeArgs)

      const episodesResult = this.db
        .prepare(`DELETE FROM episodes WHERE ${scopeSql}`)
        .run(...scopeArgs)
      const moviesResult = this.db
        .prepare(`DELETE FROM movies WHERE ${scopeSql}`)
        .run(...scopeArgs)

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
        .prepare(`DELETE FROM parked_paths WHERE ${scopeSql}`)
        .run(...scopeArgs)

      // D11 / C33（2026-08-08）：files 表必须一起清。上面 8 张是旧架构的表；新架构的数据
      // 在 files/works 里，留下的行会成为孤儿——识别流的队列谓词只看 work_id IS NULL、
      // 不按守备目录过滤（C18 幽灵队列），于是会永远为一个已不在任何守备目录内的文件跑
      // 识别 agent，每天烧 TMDB + LLM，永不终止。
      // 沿用同一套 scope 条件（不用 LIKE：媒体路径可含 % 和 _，见上方论证）。
      const filesResult = this.db
        .prepare(`DELETE FROM files WHERE ${scopeSql}`)
        .run(...scopeArgs)

      this.db.prepare('DELETE FROM media_roots WHERE path = ?').run(path)

      return {
        episodes: episodesResult.changes,
        movies: moviesResult.changes,
        series: seriesDeleted,
        parked: parkedResult.changes,
        files: filesResult.changes,
      }
    })

    return tx.immediate()
  }
}

export interface SecretMeta {
  name: SecretName
  set: boolean
  source: 'env' | 'db' | 'none'
  masked: string | null
}
