import {
  existsSync, mkdirSync, readFileSync, renameSync, statSync,
  openSync, closeSync, fsyncSync, fstatSync, readSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { writeAll } from './fsUtil.js'

export interface ManifestHeader { seriesId: string; seriesTitle: string; startedAt: number }
export interface ManifestEntry {
  op: 'rename' | 'hardlink'
  from: string
  to: string
  size: number
  mtimeMs: number
  reason: string
  ts: number
}
export interface ManifestDoc { header: ManifestHeader; entries: ManifestEntry[] }

/** JSONL 行的四种形态：header（首行）/ entry（每次搬动一行）/ rollback（回滚完成标记，
 *  其后追加的 entries 才是"当前这轮"的账——重跑恢复时不重放已回滚的旧账）/ seal（撕裂
 *  封口：上一行是崩溃撕下的半行，本标记宣告它作废，readManifest 据此区分"撕裂"与"真损坏"）。 */
type ManifestLine =
  | ({ type: 'header' } & ManifestHeader)
  | ({ type: 'entry' } & ManifestEntry)
  | { type: 'rollback'; ts: number }
  | { type: 'seal'; ts: number }

export function manifestPath(archiveDir: string): string {
  return join(archiveDir, 'manifest.jsonl')
}

/** 目录 fsync：让刚创建的 manifest 文件的目录项也落盘（否则断电后文件本身可能"消失"，
 *  账写了等于没写）。部分平台（如 Windows）不允许对目录 fsync——尽力而为，不因此中断。 */
function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
  } catch { /* 平台不支持目录 fsync——尽力而为 */ }
}

/** 一行 JSONL 追加 + fsync。append-only 是本清单的生命线：绝不重写既有字节——
 *  truncate+rewrite 在写到一半断电时会把整本账（包括早已落盘的旧 entries）一起毁掉，
 *  纯追加的最坏情况只是撕裂一个不完整的末行（readManifest 容忍并忽略）。
 *  撕裂封口：文件末字节不是换行说明末行是上次崩溃撕下的半行——先补换行 + seal 标记行
 *  再追加本行，绝不与半行拼接（否则半行 + 新行黏成一条真损坏，恢复路径自我毁账）。 */
function appendLine(path: string, line: ManifestLine): void {
  const fd = openSync(path, 'a+')
  try {
    let prefix = ''
    const size = fstatSync(fd).size
    if (size > 0) {
      const last = Buffer.alloc(1)
      readSync(fd, last, 0, 1, size - 1)
      if (last.toString('utf8') !== '\n') {
        prefix = '\n' + JSON.stringify({ type: 'seal', ts: Date.now() } satisfies ManifestLine) + '\n'
      }
    }
    writeAll(fd, Buffer.from(prefix + JSON.stringify(line) + '\n'))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** 幂等初始化：manifest 已存在（崩溃恢复重跑）时不覆盖，保留原有 entries 现场。
 *  header 行 fsync 后再 fsync 父目录——两级都落盘，plan_ref 指过来时账本必须真实存在。 */
export function initManifest(archiveDir: string, header: ManifestHeader): void {
  mkdirSync(archiveDir, { recursive: true })
  const path = manifestPath(archiveDir)
  if (existsSync(path)) return
  appendLine(path, { type: 'header', ...header })
  fsyncDir(archiveDir)
}

/**
 * 逐行解析 JSONL。撕裂行的三种合法形态：
 *  1. 撕裂末行（追加半途断电、尚未续写）——忽略之，append-only 保证它之前每行完整；
 *  2. 撕裂后被封口的行（下一非空行是 seal 标记：崩溃后同一账本继续追加时补的封口）——同样忽略；
 *  3. 撕裂级联（撕裂行的后继全部也是撕裂尾行）：补封口写 seal 时又断电的产物——等同截断，
 *     此前的完整账仍然有效（否则一次 crash-mid-seal 就把账本 brick 死，恢复路径永久瘫痪）。
 * 只要坏行之后还有任何一行能解析（真数据在损坏之后），撕裂/级联都解释不了，大声抛错。
 * rollback 标记行把 entries 清零：标记之前的账已被逆序重放回原位，重跑不得再重放。
 */
export function readManifest(archiveDir: string): ManifestDoc | null {
  const path = manifestPath(archiveDir)
  if (!existsSync(path)) return null
  const lines = readFileSync(path, 'utf8').split('\n')
  let header: ManifestHeader | null = null
  let entries: ManifestEntry[] = []
  const parseLine = (raw: string): ManifestLine | null => {
    try { return JSON.parse(raw) as ManifestLine } catch { return null }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const parsed = parseLine(line)
    if (parsed == null) {
      const rest = lines.slice(i + 1).map(l => l.trim()).filter(l => l !== '')
      if (rest.length === 0) break // 撕裂末行——之前的账全部完整，忽略这半行
      const next = parseLine(rest[0])
      if (next != null && next.type === 'seal') continue // 已封口的撕裂行——跳过，账本继续有效
      if (rest.every(l => parseLine(l) == null)) break // 撕裂级联（crash-mid-seal）——按截断处理
      throw new Error(`manifest 第 ${i + 1} 行损坏（非末行且未封口，撕裂解释不了）：${path}`)
    }
    if (parsed.type === 'header') {
      header = { seriesId: parsed.seriesId, seriesTitle: parsed.seriesTitle, startedAt: parsed.startedAt }
    } else if (parsed.type === 'entry') {
      const { type: _t, ...entry } = parsed
      entries.push(entry)
    } else if (parsed.type === 'rollback') {
      entries = []
    }
    // type === 'seal'：纯封口标记，无账务含义，跳过。
  }
  if (!header) return null // header 行本身撕裂/缺失：init 尚未完成，等同"没有清单"（也就还没搬过任何文件）
  return { header, entries }
}

/** 先记后搬：调用方必须在实际执行 rename/hardlink 之前调用本函数（write-ahead），
 *  这样崩溃恢复时读到的 manifest 永远至少覆盖到"即将要做"的那一步，不会有"做完了但
 *  清单没记"的窗口。每条 entry 一行纯追加 + fsync——绝不重写整篇文档。 */
export function appendManifestEntry(archiveDir: string, entry: ManifestEntry): void {
  const path = manifestPath(archiveDir)
  if (!existsSync(path)) throw new Error(`manifest 尚未初始化：${path}——先调用 initManifest`)
  appendLine(path, { type: 'entry', ...entry })
}

/** 回滚完成标记：replayRollback 把当前账全部逆转回原位之后追加，宣告"此前的 entries 已
 *  归位作废"。同一 manifest 上的下一轮重试从零开始记账，崩溃后不会重放已回滚的旧账。 */
export function appendRollbackMarker(archiveDir: string, ts: number): void {
  const path = manifestPath(archiveDir)
  if (!existsSync(path)) throw new Error(`manifest 尚未初始化：${path}——先调用 initManifest`)
  appendLine(path, { type: 'rollback', ts })
}

/**
 * 逆序重放回滚：把 manifest 里每条 entry 的 rename 反着做一遍（to → from）。
 * 幂等：目标（也就是原 from）已存在则跳过这一条（视为已回滚过，绝不覆盖）；来源（to）
 * 不存在则警告跳过（可能被后续步骤又动过，不强行报错中断整个回滚流程）。
 * 尺寸校验：size>0 的文件条目，回滚前核对 to 的实际尺寸与记账一致——不符说明那里躺着的
 * 已经不是我们搬过去的那个文件（被覆盖/被替换），搬回去反而毁真数据，跳过并警告。
 * size=0 的条目（目录级 reveal/归档记账）不做尺寸校验。
 */
export function replayRollback(archiveDir: string, log: (msg: string) => void = () => {}): void {
  const doc = readManifest(archiveDir)
  if (!doc) throw new Error(`manifest 不存在：${manifestPath(archiveDir)}`)
  for (const entry of [...doc.entries].reverse()) {
    if (existsSync(entry.from)) {
      log(`跳过（已回滚）：${entry.to} → ${entry.from}`)
      continue
    }
    if (!existsSync(entry.to)) {
      log(`警告：回滚源缺失，跳过：${entry.to}`)
      continue
    }
    if (entry.size > 0) {
      const stat = statSync(entry.to)
      if (stat.isFile() && stat.size !== entry.size) {
        log(`警告：回滚源尺寸不符（实际 ${stat.size} vs 记账 ${entry.size}），拒绝搬动：${entry.to}`)
        continue
      }
    }
    mkdirSync(dirname(entry.from), { recursive: true })
    renameSync(entry.to, entry.from)
    log(`已回滚：${entry.to} → ${entry.from}`)
  }
}
