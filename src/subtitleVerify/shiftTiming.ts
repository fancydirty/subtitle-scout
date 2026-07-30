/**
 * 字幕时间轴整体平移（shift），原地改写用户的真实字幕文件。
 *
 * ⚠️ **本仓库风险最高的模块**：它改写的是用户不可替代的文件（字幕组精校版、绝版资源）。
 * 下面每条纪律都是硬约束，不是风格偏好。改动前先读完这段文件头。
 *
 * ## 符号方向（极易搞错，先记牢）
 *
 * `offsetMs` 语义与 alignDetect.ts 的 detectOffset 完全一致：
 *   **正数 = 我们的字幕比参考源晚**（字幕慢了、迟到了）。
 * 字幕晚了，就要把时间戳**往前挪**才能对上，所以是**减**：
 *
 *     newTime = oldTime - offsetMs
 *
 * 反过来 offsetMs 为负 = 字幕比参考早，减一个负数 = 加时间 = 往后挪。同一个公式覆盖两向。
 * 后人若想"顺手改成加号"，先回来重读这段：符号反转的表现是"校正后错得更远一倍"，
 * 在 UI 上和"没生效"很像，极难从现象反推。测试 shift-sign-direction 专门钉这个方向。
 *
 * ## 硬约束一：只改时间戳字节，其余一个字节都不许动
 *
 * 手段是**按字节操作、不做完整解码**。时间戳（`0:00:10.50` / `00:00:10,500`）在所有常见
 * 字幕编码（UTF-8/GBK/GB18030/BIG5/Shift_JIS/latin1…）里都是纯 ASCII，所以能在字节层
 * 定位并原地替换，完全绕开"这文件是什么编码"这个问题——GBK/BIG5 文件里的中文我们根本不解析。
 *
 * 刻意**不**走 decodeToUtf8 → 改 → 编码回去：那条路的编码往返可能有损（iconv 对非法字节、
 * 私用区、字形变体的处理都不保证 round-trip），而"非时间戳字节逐字节不变"是本模块的
 * 立命之本。宁可放弃对文本的理解，也不能放弃字节保真。
 *
 * 具体实现用 `Buffer.toString('latin1')` 做字节↔字符双射：latin1 把 0x00-0xFF 一对一映到
 * U+0000-U+00FF，`Buffer.from(s, 'latin1')` 精确还原原字节。所以这是"在字节上跑正则"的
 * 安全写法，不是"按 latin1 解码文本"——我们从不解释这些字符的含义。
 *
 * 按 0x0A/0x0D 切行对多字节编码同样安全：GBK/GB18030/BIG5/Shift_JIS 的 trail byte 范围
 * 都不含 0x0A/0x0D（GBK trail 0x40-0xFE 除 0x7F，BIG5 trail 0x40-0x7E/0xA1-0xFE），
 * 所以不会把某个汉字的后半字节误认成换行。
 *
 * 于是这些东西天然被保住，因为我们从来没碰过它们：
 *   - 原始编码（GBK/BIG5/…）、BOM（有则留、无则不加）
 *   - CRLF/LF/CR 行尾（逐行保留各自的原始行尾，不做统一）
 *   - `[Script Info]` / `[V4+ Styles]` / `[Fonts]` / `[Graphics]` /
 *     `[Aegisub Project Garbage]` 等所有非 Events 内容，含 `[Fonts]` 里的 base64 垃圾
 *   - 字幕组的 `;` 注释行、署名、免责声明
 *   - 文件末尾有无换行
 *
 * ## 为什么只改 Start/End 不会破坏 `{\move}` `{\pos}` `{\fad}` `{\t}` `{\k}`
 *
 * **已调研确认**：ASS 内联标签里的时间参数是**相对于该 Dialogue 行自身的 Start 时刻**的，
 * 不是绝对时间轴上的时刻。`\move(x1,y1,x2,y2,t1,t2)` 的 t1/t2、`\fad(in,out)` 的淡入淡出
 * 时长、`\t(t1,t2,...)` 的动画区间、`\k`/`\kf`/`\ko` 的卡拉OK音节时长——全部以行内 0 点为
 * 基准。整行 Start/End 同量平移时，行内相对时间保持不变，动画/卡拉OK效果完全等价。
 *
 * 所以**绝不要**"顺手把内联标签的时间也平移一下"——那才是真正会破坏特效字幕的操作
 * （会让 \move 的动画区间偏离行的生命期，字在屏幕上飞错位置）。测试
 * shift-inline-tags-bytes-unchanged 逐字节钉住这些标签。
 *
 * ## `Comment:` 行不改时间
 *
 * `Comment:` 是被注释掉的对话（Aegisub 里翻译/校对留下的废弃行、时间轴草稿），**不生效**，
 * 不参与播放。它不是"生效字幕"，所以不该被平移；但它也是用户文件的一部分，
 * 所以更不能删或改动它的任何字节——原样抄过去。
 *
 * ## 硬约束二：原子写 + 备份 + 幂等
 *
 * 原子写照抄 src/files/subtitleWriter.ts:117-149 的既有纪律（同一套模式，不另发明）：
 *   tmpPath = `${path}.tmp` → 清孤儿 tmp（best-effort，吞异常：NAS/SMB 上 unlink 可能 EPERM）
 *   → openSync('w') → writeAll → fsyncSync → closeSync（finally）→ renameSync
 * rename 原子性已在真实目标文件系统实测：CIFS（//192.168.100.241/share）与 rclone WebDAV
 * （阿里云盘）上 rename-over-existing 都成功、内容正确、无残留。
 *
 * **备份 + 幂等（关键设计，别改语义）**：`${path}.scout-backup` 保存**原始文件**的字节。
 *   - 备份不存在 → 先原子写出备份，再基于当前文件字节平移。
 *   - 备份已存在 → 说明之前改过。**绝不覆盖备份**（那会毁掉原始版本），
 *     而是**从备份读原始字节重新计算**再写目标文件。
 *
 * ### 三文件状态机：target × backup × meta 的合法组合
 *
 * 这个模块管三个文件：目标字幕 `T`、备份 `B`（=`T.scout-backup`）、meta `M`
 * （=`T.scout-backup.json`）。**`B` 存在与否这一个布尔位不足以决定该怎么做**——
 * 必须连同"`M` 说了什么"一起判断。曾经把两位信息压成一个 `backupExisted` 布尔，
 * 结果是"备份被删但 meta 尚存"时把**已平移的文件当原始字节**读进去当新备份，
 * 静默双倍平移且原始字节永久丢失（审计 C1）。所以合法组合在此穷举，改动前先对照：
 *
 * | B | M | 含义 | 行为 |
 * |---|---|---|---|
 * | 无 | 无 | 从未平移过（正常首次调用） | 备份 T → 基于 T 平移。prev=0 |
 * | 有 | 有(N) | 已平移 N（正常再次调用） | **基于 B 重算**，B 不覆盖。prev=N |
 * | 有 | 无 | 备份在但 meta 缺失：老版本留下的、或用户手工放的备份 | 基于 B 重算（B 仍是可信基准）。prev=null=未知，不猜 |
 * | 有 | 有但损坏 | 同上 | 同上。prev=null |
 * | **无** | **有(N≠0)** | **非法**：正常流程不可能产生 | **拒绝** |
 * | 无 | 有(0) | 退化的合法态：记录着"平移 0ms"，等价于未平移 | 按"从未平移过"处理 |
 *
 * 为什么"B 无 + M 有非零"必然非法：meta 只在备份写成功之后才写（见落盘阶段的顺序），
 * 所以这个组合只可能来自外部干预——最典型的是清理脚本只删了 `.scout-backup`
 * 却漏删 `.scout-backup.json`（而本模块的注释正明确说"清理备份是独立的显式操作"，
 * 所以这条路径是设计上可达的，不是边角）。此时磁盘上的 T 已经被平移过 N ms，
 * 却没有任何原始字节的副本——**无法确定原始基准**。
 * 唯一安全的行为是拒绝：宁可要求人工介入，也不能把已平移文件当原始基准存成新备份
 * （那会让 revert 也救不回原始版本）。这与 UTF-16 的处理同源——诚实拒绝好过损坏文件。
 *
 * 所以 `offsetMs` 的基准恒为**原始文件**，不是"当前磁盘上的文件"。这带来真幂等：
 * 同参数连调 N 次，结果字节完全一致，不会双倍平移。代价是调用方必须自己做残差累加——
 * 若在已平移 +A 的文件上又检出残差 R，要传的是 `A + R`，不是 `R`。为此我们把已应用的
 * 累计值写进 `${path}.scout-backup.json`，并在 ShiftResult.appliedOffsetMs /
 * previousOffsetMs 里回报，让调用方能算出 A+R 而不必自己记账。meta 缺失/损坏时
 * previousOffsetMs 为 null（老版本留下的备份、或用户手工放的备份），此时如实告知未知，
 * 不猜。
 *
 * ## 时间戳变负 → 钳到 0
 *
 * 平移后 <0 的时间戳钳到 0，并在 detail 里报告钳制条数。理由：越界通常只影响开头一两条
 * （常是字幕组署名那种 t≈0 的行）。为这一两条拒绝整个文件，会让另外两千条本来能修好的
 * cue 也修不了，损失更大。且 t<0 的 cue 在时间轴上本来就无法存在，钳制只是把它们
 * 降级到"从 0 开始"，不引入新的错误信息。
 * 钳制只作用于越界的那几条，其他行照常平移。
 *
 * ## 硬约束三：失败不留半成品
 *
 * 任何环节失败（UTF-16 拒绝、编码/解析异常、磁盘满、权限、写失败），最终状态必须是
 * 原文件完好无损 + 无 tmp 残留。做法：先在内存里算完新字节（纯计算，可失败但无副作用），
 * 只有全部算成功才进入写阶段；写阶段任何异常都 catch 后清理 tmp，再返回 ok:false。
 *
 * ## UTF-16 明确不支持
 *
 * UTF-16 的 ASCII 字符是双字节（'0' = 0x30 0x00），字节级正则必然失配，硬跑会写出
 * 损坏文件。检测到 UTF-16 BOM（FF FE / FE FF）就**拒绝处理**并在 detail 说明。
 * UTF-16 字幕极少见，诚实拒绝远好过损坏一个不可替代的文件。
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { writeAll } from '../files/fsUtil.js'

export interface ShiftResult {
  ok: boolean
  /** 原始文件的备份路径；仅在成功写入后有值 */
  backupPath?: string
  /** 本次实际应用的平移量（相对**原始文件**）。等于入参 offsetMs，冗余回报是为了让调用方
   *  在拿到 previousOffsetMs 后能确认基准一致。仅成功时有值。 */
  appliedOffsetMs?: number
  /** 本次调用**之前**已应用的累计平移量（相对原始文件）。
   *
   *  语义严格跟随 meta 文件，**绝不猜**：
   *    - meta 有合法值 → 该值（首次平移前无 meta，见下）
   *    - meta 缺失或损坏（老备份/手工备份/meta 写失败过）→ `null` = 未知
   *    - 确定处于"从未平移过"状态（备份与 meta 皆无）→ `0`
   *
   *  曾经在"备份不存在"时一律硬报 0，于是 meta 明明记着 2000 却回报 0——与同一次调用的
   *  detail 自相矛盾，且调用方按下面的公式叠加会欠校正 2000ms（审计 C2）。
   *  现在这个字段与 detail 里的 `prevOffsetMs=` 恒等，可交叉验证。
   *
   *  调用方要在已平移文件上叠加残差 R 时，应传 `previousOffsetMs + R`；
   *  拿到 `null`（未知）时**不要**假设 0——那正是上面那个 bug 的形状。 */
  previousOffsetMs?: number | null
  /** 被钳到 0 的时间戳个数（单个时间戳计一次，一行 Start+End 都越界记 2）。仅成功时有值。 */
  clampedCount?: number
  /** 实际改写的生效字幕行数（Dialogue / SRT 时间行）。仅成功时有值。 */
  shiftedLines?: number
  /** 内部诊断，绝不上 UI。给排障的人看的技术事实，单行，便于塞进结构化痕迹字段。 */
  detail: string
}

/** 备份后缀。确定性命名 = 用户/清理脚本能稳定找回原始文件。
 *  本模块**只创建、绝不删除**备份：删除属于"撤销/清理"职责，写入路径拥有删原始备份的能力
 *  本身就是一个风险面。撤销走 revertSubtitleTiming()。 */
export const BACKUP_SUFFIX = '.scout-backup'

/** meta 后缀：记录已应用的累计平移量，让调用方能算残差叠加。
 *  meta 是**辅助**信息，不是正确性依赖——它缺失/损坏只会让 previousOffsetMs 变 null，
 *  绝不影响"基于备份重算"这条主路径的正确性（那条只依赖备份文件本身）。 */
export const META_SUFFIX = '.scout-backup.json'

/** `|offsetMs|` 的理智上界（±6 小时）。超出即拒绝。
 *
 *  真实的字幕不同步从来不会这么大：常见成因是版本差异（片头 logo 长度、导演剪辑版）、
 *  帧率换算（23.976 vs 25，整片累积也就分钟级）、或时区式的整段错位。±6h 已经远宽于
 *  任何真实场景，所以越界必然是上游 bug 而非用户的真实意图。
 *
 *  为什么要有这道闸：实测 offsetMs=1e15 会把整片每条 cue 全部钳到 0（时间轴被"写平"，
 *  字幕全挤在开头），-1e12 会产出 `277777:46:50,500` 这种没有播放器认得的时间戳。
 *  两者都是"成功写入"、ok:true，用户拿到一个彻底废掉的文件。
 *
 *  刻意比 alignDetect 的 MAX_SHIFT_MS（60s）宽松得多：那个是**检测侧**的搜索窗上界
 *  （超过 60s 的偏移它不去找），而这里是**写入侧**的理智性检查。人工指定的大幅平移
 *  （比如给整季字幕补一个几分钟的片头差）是合法用法，不该被检测侧的窗口限制卡死。 */
export const MAX_ABS_OFFSET_MS = 6 * 3600_000

/** 支持的后缀。与 shift/revert 两侧共用——守卫必须对称，否则 revert 会成为绕过
 *  shift 全部前置检查的后门（审计 I2：revert 曾能给一个 shift 明确拒绝的 .vtt
 *  创建出原本不存在的文件）。 */
const SUPPORTED_EXTS = ['.ass', '.ssa', '.srt'] as const

function extOf(path: string): string {
  return (path.match(/\.[^.\\/]+$/)?.[0] ?? '').toLowerCase()
}

function isSupportedExt(ext: string): boolean {
  return (SUPPORTED_EXTS as readonly string[]).includes(ext)
}

export interface ShiftOptions {
  /** 注入点：写文件。ESM 无法 spy 模块导出，外部 IO 必须可注入才能测"写失败"这类路径。
   *  与 extractEmbeddedSub.ts 的 execFileImpl / referenceSource.ts 的 opts 形状同源。 */
  writeFileImpl?: (path: string, data: Buffer) => void
  /** 注入点：读文件 */
  readFileImpl?: (path: string) => Buffer
  /** 注入点：判存在 */
  existsImpl?: (path: string) => boolean
}

/** ASS/SSA 时间戳：h:mm:ss.cc（厘秒，2 位）。小时位不定长（长片可能 10:xx:xx）。 */
const ASS_TS = /^(\d+):([0-5]\d):([0-5]\d)\.(\d{2})$/
/** SRT 时间行：hh:mm:ss,mmm --> hh:mm:ss,mmm（毫秒，3 位）。
 *  箭头两侧的空白宽度不固定（实际文件里见过多空格/无空格），所以分组捕获后原样保留。 */
const SRT_TIME_LINE = /^(\s*)(\d+:[0-5]\d:[0-5]\d,\d{3})(\s*-->\s*)(\d+:[0-5]\d:[0-5]\d,\d{3})(.*)$/
const SRT_TS = /^(\d+):([0-5]\d):([0-5]\d),(\d{3})$/

/** ASS 时间戳 → 毫秒。不合法返回 null（调用方据此整行原样保留，不猜）。 */
function assTimeToMs(s: string): number | null {
  const m = ASS_TS.exec(s)
  if (!m) return null
  return Number(m[1]) * 3600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(m[4]) * 10
}

/** 毫秒 → ASS 时间戳 h:mm:ss.cc。
 *  厘秒精度：ASS 格式只有 2 位小数，毫秒级余数在这个格式里无处安放。用 round 而非 floor，
 *  让平移误差在 ±5ms 内对称分布，而不是系统性地全体偏早（floor 会让每条都少 0-9ms，
 *  整片累积成一个一致的偏移，正是我们在修的那种毛病）。 */
function msToAssTime(ms: number): string {
  const cs = Math.round(ms / 10)
  const h = Math.floor(cs / 360_000)
  const m = Math.floor((cs % 360_000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  const c = cs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`
}

function srtTimeToMs(s: string): number | null {
  const m = SRT_TS.exec(s)
  if (!m) return null
  return Number(m[1]) * 3600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(m[4])
}

/** 毫秒 → SRT 时间戳 hh:mm:ss,mmm。小时位补到 2 位（SRT 惯例），但 >99h 时不截断。 */
function msToSrtTime(ms: number): string {
  const h = Math.floor(ms / 3600_000)
  const m = Math.floor((ms % 3600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const ml = ms % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ml).padStart(3, '0')}`
}

/** 平移单个时间戳，钳到 0。返回新值 + 是否发生钳制。 */
function shiftMs(oldMs: number, offsetMs: number): { ms: number; clamped: boolean } {
  // 符号方向见文件头：正 offsetMs = 字幕晚了 = 要往前挪 = 减。
  const next = oldMs - offsetMs
  if (next < 0) return { ms: 0, clamped: true }
  return { ms: next, clamped: false }
}

interface SplitLine {
  /** 行内容，不含行尾符 */
  text: string
  /** 该行原始行尾符，原样保留（''=文件末尾无换行、'\n'、'\r\n'、'\r'） */
  eol: string
}

/** 按 latin1 字符串切行，逐行保留各自的原始行尾符。
 *  不统一行尾是刻意的：CRLF 文件必须保持 CRLF（某些播放器/字幕组工具对此敏感），
 *  而混合行尾的文件（真实存在，手工合并的产物）也应逐行原样保留而非"顺手修正"。 */
function splitLinesKeepEol(s: string): SplitLine[] {
  const out: SplitLine[] = []
  let i = 0
  let start = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '\n') {
      out.push({ text: s.slice(start, i), eol: '\n' })
      i += 1
      start = i
    } else if (ch === '\r') {
      if (s[i + 1] === '\n') {
        out.push({ text: s.slice(start, i), eol: '\r\n' })
        i += 2
      } else {
        out.push({ text: s.slice(start, i), eol: '\r' })
        i += 1
      }
      start = i
    } else {
      i += 1
    }
  }
  if (start < s.length) out.push({ text: s.slice(start), eol: '' })
  return out
}

interface TransformOutcome {
  latin1: string
  clampedCount: number
  shiftedLines: number
  /** 本该被平移的生效字幕行数（ASS 的 `Dialogue:` 行 / SRT 的疑似时间行），
   *  无论其时间戳是否解析成功。用来区分两种 shiftedLines===0：
   *  "文件里本来就没有生效字幕"（正常）vs "有字幕但一条都没改成"（编码问题，须报错）。
   *  见主函数里的 I7 守卫。 */
  eligibleLines: number
}

/**
 * ASS/SSA：只改 `Dialogue:` 行的 Start / End 两个字段。
 *
 * 列位由 `[Events]` 的 `Format:` 行决定，不写死 fields[1]/[2]——少数文件把 Start/End 放在
 * 非规范列序，写死会改错字段（把 Style 名当时间戳解析 → 得 null → 静默不改，或更糟：
 * 改到别的列）。与 subtitleInspect.ts:parseAssCues 的同款纪律保持一致。
 *
 * 逐字段重组时只替换 Start/End 两格的字符串，其余字段（含 Text 里的 `{\move}` 等内联标签、
 * Text 内部的逗号）都是原样切片拼回，所以字节保真。
 */
function transformAss(latin1: string, offsetMs: number): TransformOutcome {
  const lines = splitLinesKeepEol(latin1)
  let inEvents = false
  let startIdx = 1
  let endIdx = 2
  let clampedCount = 0
  let shiftedLines = 0
  let eligibleLines = 0
  const out: string[] = []

  for (const line of lines) {
    // section 判定用 trim 后的内容（缩进的 section 头真实存在），但输出永远是原始 line.text。
    const t = line.text.trim()
    if (/^\[/.test(t)) {
      inEvents = /^\[Events\]/i.test(t)
      out.push(line.text + line.eol)
      continue
    }
    if (inEvents && /^Format\s*:/i.test(t)) {
      const fields = t.slice(t.indexOf(':') + 1).split(',').map(f => f.trim().toLowerCase())
      const si = fields.indexOf('start')
      const ei = fields.indexOf('end')
      if (si >= 0) startIdx = si
      if (ei >= 0) endIdx = ei
      out.push(line.text + line.eol)
      continue
    }
    // 只认 Dialogue。`Comment:` 是被注释掉的废弃对话，不生效，故不平移其时间——
    // 但它的字节同样原样保留（走下面的 fallthrough）。见文件头。
    if (!inEvents || !/^Dialogue\s*:/i.test(t)) {
      out.push(line.text + line.eol)
      continue
    }

    // 到这里已确认是 [Events] 里的 Dialogue 行 = 生效字幕行，无论时间戳能否解析。
    eligibleLines += 1
    const colon = line.text.indexOf(':')
    const head = line.text.slice(0, colon + 1)
    const rest = line.text.slice(colon + 1)
    const fields = rest.split(',')
    if (fields.length <= Math.max(startIdx, endIdx)) {
      out.push(line.text + line.eol)
      continue
    }
    // 时间戳字段可能带前后空白（`Dialogue: 0, 0:00:10.50, ...`），保留空白、只换数字部分。
    const rewritten = [startIdx, endIdx].map(idx => {
      const raw = fields[idx] ?? ''
      const lead = raw.slice(0, raw.length - raw.trimStart().length)
      const core = raw.trim()
      const trail = raw.slice(lead.length + core.length)
      const ms = assTimeToMs(core)
      if (ms == null) return null
      const shifted = shiftMs(ms, offsetMs)
      return { idx, value: lead + msToAssTime(shifted.ms) + trail, clamped: shifted.clamped }
    })
    // 解析不出合法时间戳 → 整行原样保留。不猜、不半改：半改会写出 Start 变了 End 没变
    // 这种自相矛盾的行（End < Start，播放器行为未定义）。
    if (rewritten.some(r => r == null)) {
      out.push(line.text + line.eol)
      continue
    }
    for (const r of rewritten) {
      if (r == null) continue
      fields[r.idx] = r.value
      if (r.clamped) clampedCount += 1
    }
    shiftedLines += 1
    out.push(head + fields.join(',') + line.eol)
  }
  return { latin1: out.join(''), clampedCount, shiftedLines, eligibleLines }
}

/**
 * SRT：只改 `-->` 时间行的两个时间戳。序号行、文本行、空行、BOM、行尾全不动。
 * 箭头周围的原始空白（`(\s*-->\s*)` 捕获组）原样保留——不同工具产出的空白宽度不同，
 * 统一它就等于改了用户的字节。
 */
function transformSrt(latin1: string, offsetMs: number): TransformOutcome {
  const lines = splitLinesKeepEol(latin1)
  let clampedCount = 0
  let shiftedLines = 0
  let eligibleLines = 0
  const out: string[] = []
  for (const line of lines) {
    // 生效行判据用宽松的"含 -->"：严格正则失配的行（时间戳格式坏了、或整个文件编码不对）
    // 也要计入 eligible，否则 I7 守卫看到 eligible=0 会把"有字幕但一条没改成"误判成
    // "本来就没字幕"而静默放过。
    if (line.text.includes('-->')) eligibleLines += 1
    const m = SRT_TIME_LINE.exec(line.text)
    if (!m) {
      out.push(line.text + line.eol)
      continue
    }
    const a = srtTimeToMs(m[2] ?? '')
    const b = srtTimeToMs(m[4] ?? '')
    if (a == null || b == null) {
      out.push(line.text + line.eol)
      continue
    }
    const sa = shiftMs(a, offsetMs)
    const sb = shiftMs(b, offsetMs)
    if (sa.clamped) clampedCount += 1
    if (sb.clamped) clampedCount += 1
    shiftedLines += 1
    out.push(`${m[1]}${msToSrtTime(sa.ms)}${m[3]}${msToSrtTime(sb.ms)}${m[5]}${line.eol}`)
  }
  return { latin1: out.join(''), clampedCount, shiftedLines, eligibleLines }
}

/** UTF-16/UTF-32 检测 → 拒绝处理。见文件头。
 *
 *  两条判据：
 *  ① BOM（FF FE / FE FF）——有 BOM 的好办。
 *  ② **NUL 字节**——抓无 BOM 的 UTF-16/UTF-32。这类文件 BOM 检测抓不到，但字节级正则
 *     对它全部失配，结果是"字节原样不变却 ok:true"的静默无操作（审计 I7）。
 *     判据很干净：任何 ASCII 兼容编码（UTF-8/GBK/GB18030/BIG5/Shift_JIS/latin1…）的
 *     **文本**字幕文件都不含 0x00——NUL 在这些编码里不是合法文本字符，也不出现在任何
 *     多字节序列的 lead/trail 范围内。而 UTF-16 的 ASCII 部分每个字符都带一个 NUL。
 *     所以"含 NUL"⇒"不是我们能按字节安全处理的文本字幕"，无误判风险。 */
function isUtf16(buf: Buffer): boolean {
  if (buf.length >= 2) {
    const b0 = buf[0]
    const b1 = buf[1]
    if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) return true
  }
  return buf.includes(0x00)
}

/** 原子写：tmp + fsync + rename。照抄 src/files/subtitleWriter.ts:117-149 的既有纪律。
 *  注入了 writeFileImpl 时走注入路径（测试模拟写失败），此时不做 tmp/rename——
 *  注入点的语义是"替换整个落盘动作"，由测试自己决定行为。 */
function atomicWrite(path: string, data: Buffer, opts?: ShiftOptions): void {
  if (opts?.writeFileImpl) {
    opts.writeFileImpl(path, data)
    return
  }
  const tmpPath = `${path}.tmp`
  // 孤儿 tmp 清理：上次可能在 rename 前崩溃，留下这个确定命名的垃圾文件。
  // best-effort —— NAS/SMB 上 unlink 可能 EPERM/EACCES/EBUSY，绝不能让清理失败
  // 把整次写入变成硬失败（openSync('w') 本身会截断复用它）。
  if (existsSync(tmpPath)) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // swallow: orphan cleanup is opportunistic, not load-bearing
    }
  }
  let renamed = false
  try {
    const fd = openSync(tmpPath, 'w')
    try {
      writeAll(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmpPath, path)
    renamed = true
  } finally {
    // 失败不留半成品：rename 没走到就把 tmp 清掉，别在用户媒体目录旁堆垃圾。
    if (!renamed && existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // swallow: 同上，清理失败不该覆盖真正的原始错误
      }
    }
  }
}

/** meta 读取。任何异常/字段不合法都返回 null = "未知"，绝不猜。
 *  meta 只影响 previousOffsetMs 这个信息性字段，不参与正确性。 */
function readMeta(path: string, opts?: ShiftOptions): number | null {
  const exists = opts?.existsImpl ?? existsSync
  if (!exists(path)) return null
  try {
    const read = opts?.readFileImpl ?? readFileSync
    const parsed: unknown = JSON.parse(read(path).toString('utf8'))
    if (parsed == null || typeof parsed !== 'object') return null
    const v = (parsed as { appliedOffsetMs?: unknown }).appliedOffsetMs
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

/**
 * 给 `subtitlePath` 的时间轴整体平移 `offsetMs`（正数=字幕晚了=往前挪=减），写回磁盘。
 *
 * `offsetMs` 的基准恒为**原始文件**（首次调用时的磁盘内容，已存进 `.scout-backup`），
 * 不是"当前磁盘上的文件"。所以同参数连调 N 次结果字节完全一致（幂等）。
 * 要在已平移的文件上叠加残差 R，传 `previousOffsetMs + R`。见文件头「备份 + 幂等」。
 *
 * 失败时（ok:false）保证原文件完好无损、无 tmp 残留。
 */
export async function shiftSubtitleTiming(
  subtitlePath: string,
  offsetMs: number,
  opts?: ShiftOptions,
): Promise<ShiftResult> {
  const path = resolve(subtitlePath)
  const backupPath = `${path}${BACKUP_SUFFIX}`
  const metaPath = `${path}${META_SUFFIX}`
  const exists = opts?.existsImpl ?? existsSync
  const read = opts?.readFileImpl ?? readFileSync

  if (!Number.isFinite(offsetMs)) {
    return { ok: false, detail: `refused: offsetMs is not a finite number (${String(offsetMs)})` }
  }
  if (Math.abs(offsetMs) > MAX_ABS_OFFSET_MS) {
    // 上游 bug 传进离谱值（实测 1e15 会把整片钳到 0，-1e12 产出 277777:46:50）会把整条
    // 时间轴写平/写飞。本函数是 public export，不能假设调用方一定给了合理值。见常量注释。
    return {
      ok: false,
      detail: `refused: |offsetMs| ${Math.abs(offsetMs)}ms exceeds sanity bound ${MAX_ABS_OFFSET_MS}ms (±6h); a real subtitle sync error is never this large, so this is almost certainly a caller bug`,
    }
  }
  if (!exists(path)) {
    return { ok: false, detail: `refused: subtitle file does not exist: ${path}` }
  }

  const ext = extOf(path)
  if (!isSupportedExt(ext)) {
    return { ok: false, detail: `refused: unsupported extension ${ext || '(none)'} (only .ass/.ssa/.srt)` }
  }

  const previousOffsetMs = readMeta(metaPath, opts)
  const backupExisted = exists(backupPath)

  // ── C1 守卫：备份缺失但 meta 记录着非零平移 = 三文件状态机里的非法组合。 ──
  // 见文件头状态机表。此时磁盘上的文件已被平移过，却没有任何原始字节副本，
  // 无法确定原始基准。若照常往下走，会把**已平移的文件当原始字节**存成新备份
  // （双倍平移 + 原始永久丢失 + revert 也救不回）。宁可拒绝、要求人工介入。
  // 检测所需信息本来就在手边：previousOffsetMs 刚从 meta 读到。
  // meta 记 0 不算：那等价于"未平移过"，按正常首次调用处理（退化的合法态）。
  if (!backupExisted && previousOffsetMs != null && previousOffsetMs !== 0) {
    return {
      ok: false,
      previousOffsetMs,
      detail: `refused: backup missing at ${backupPath} but meta records an applied shift of ${previousOffsetMs}ms — cannot determine the original baseline, and treating the already-shifted file as the original would double-shift it and destroy the original bytes irrecoverably. Restore the backup, or (after confirming the file is unshifted) delete ${metaPath} manually.`,
    }
  }

  // ── 阶段一：纯计算，无副作用。任何失败在这里返回，磁盘一个字节都没动。 ──
  let source: Buffer
  try {
    // 幂等的核心：备份已存在 → 从**备份**（原始字节）重算，而不是在当前文件上再平移一次。
    // 这样连点两次校正不会双倍平移。备份绝不覆盖（那会毁掉原始版本）。
    source = read(backupExisted ? backupPath : path)
  } catch (e) {
    return { ok: false, detail: `refused: cannot read source (${backupExisted ? 'backup' : 'original'}): ${errText(e)}` }
  }

  if (isUtf16(source)) {
    // 诚实拒绝好过损坏文件：UTF-16 的 ASCII 是双字节，字节级正则会失配。见文件头。
    return {
      ok: false,
      previousOffsetMs,
      detail: 'refused: UTF-16/UTF-32 detected (BOM or NUL bytes); byte-level timestamp rewriting is unsafe for these encodings (not supported this release), original file untouched',
    }
  }

  let outcome: TransformOutcome
  try {
    // latin1 双射：0x00-0xFF ↔ U+0000-U+00FF 一对一，Buffer.from(s,'latin1') 精确还原。
    // 这是"在字节上跑正则"，不是"按 latin1 解码文本"——非 ASCII 字节只是被搬运，从不解释。
    const latin1 = source.toString('latin1')
    outcome = ext === '.srt'
      ? transformSrt(latin1, offsetMs)
      : transformAss(latin1, offsetMs)
  } catch (e) {
    return { ok: false, detail: `refused: transform failed: ${errText(e)}, original file untouched` }
  }
  // ── I7：一条都没改却报成功 = 静默无操作，调用方看不出"这文件我没能处理"。 ──
  // 最典型是**无 BOM 的 UTF-16**：它不构成损坏（字节级正则全失配 → 字节原样不变），
  // 但 ok:true / shiftedLines:0 会让调用方以为校正已生效。BOM 检测抓不到这种文件。
  // 判据用"源文件里确实存在生效字幕行"——空的 [Events]、纯注释文件（只有 Comment:）
  // 本来就无可平移，那种 0 行是正常的，不该报错。
  if (outcome.shiftedLines === 0 && outcome.eligibleLines > 0) {
    return {
      ok: false,
      previousOffsetMs,
      detail: `refused: found ${outcome.eligibleLines} subtitle line(s) but rewrote 0 timestamp(s) — the file's timestamps are not byte-level ASCII as required (BOM-less UTF-16/UTF-32 is the usual cause; BOM-less encodings cannot be detected up front). Original file untouched rather than silently reporting success.`,
    }
  }
  const next = Buffer.from(outcome.latin1, 'latin1')

  // ── 阶段二：落盘。先备份（若无），再原子写目标文件。 ──
  if (!backupExisted) {
    try {
      // 备份也走原子写：半截备份比没备份更危险（它会让下次调用以为"原始字节在这儿"）。
      atomicWrite(backupPath, source, opts)
    } catch (e) {
      return { ok: false, detail: `refused: backup write failed: ${errText(e)}, original file untouched` }
    }
  }

  try {
    atomicWrite(path, next, opts)
  } catch (e) {
    // 目标写失败：原文件仍是旧内容（rename 没发生），tmp 已在 atomicWrite 的 finally 清掉。
    // 备份留着不删——它是本次刚写的原始字节副本，留下只会帮助恢复，删除才是风险。
    return { ok: false, detail: `write failed: ${errText(e)}, original file intact (backup at ${backupPath})` }
  }

  // meta 是辅助信息：写失败不该让一次成功的平移变成失败（时间轴已经正确落盘了）。
  // 代价只是下次调用 previousOffsetMs 变 null（如实报"未知"），主路径不受影响。
  let metaOk = true
  try {
    const payload = Buffer.from(JSON.stringify({ appliedOffsetMs: offsetMs }), 'utf8')
    if (opts?.writeFileImpl) opts.writeFileImpl(metaPath, payload)
    else writeFileSync(metaPath, payload)
  } catch {
    metaOk = false
  }

  // ── C2：previousOffsetMs 必须如实反映 meta，且与 detail 里的 prevOffsetMs= 恒等。 ──
  // 曾经写成 `backupExisted ? previousOffsetMs : 0`——把"备份在否 × meta 说什么"两位信息
  // 压成一个布尔，于是备份不存在时一律硬报 0。后果有两种，都被审计实测到：
  //   ① 备份被删但 meta 记着 2000 → 返回 0 而 detail 写 2000（自相矛盾，且调用方按
  //      previousOffsetMs + R 叠加会欠校正 2000ms）。该状态现在已被 C1 守卫提前拒掉。
  //   ② 正常首次调用（备份无 + meta 无）→ 返回 0 而 detail 写 unknown（同样自相矛盾）。
  // 现在两者同源于 effectivePrevOffsetMs，不可能再打架。
  //
  // "备份与 meta 皆无" ⇒ 确定处于从未平移过的状态 ⇒ 报 0 是事实而非猜测；
  // 其余一切情况都如实转述 meta（含 null=未知）。见文件头状态机表。
  const neverShifted = !backupExisted && previousOffsetMs == null
  const effectivePrevOffsetMs = neverShifted ? 0 : previousOffsetMs
  const prevText = effectivePrevOffsetMs == null ? 'unknown' : String(effectivePrevOffsetMs)

  const parts = [
    `shifted ${outcome.shiftedLines} line(s) by ${offsetMs}ms (newTime = oldTime - offsetMs)`,
    `format=${ext}`,
    backupExisted ? 'recomputed from existing backup (idempotent)' : 'created backup',
    `prevOffsetMs=${prevText}`,
  ]
  if (outcome.clampedCount > 0) parts.push(`clamped ${outcome.clampedCount} timestamp(s) to 0`)
  if (!metaOk) parts.push('meta write failed (previousOffsetMs will read as unknown next time)')

  return {
    ok: true,
    backupPath,
    appliedOffsetMs: offsetMs,
    previousOffsetMs: effectivePrevOffsetMs,
    clampedCount: outcome.clampedCount,
    shiftedLines: outcome.shiftedLines,
    detail: parts.join('; '),
  }
}

/**
 * 撤销：把 `.scout-backup` 的原始字节原子写回，并删掉 meta。
 *
 * **备份本身不删**——用户可能想再校正一次，而删除原始字节副本是不可逆的。
 * 清理备份是独立的显式操作（人工/清理脚本），刻意不放在这里。
 *
 * **守卫必须与 shiftSubtitleTiming 对称**（审计 I1/I2）。曾经这里一道守卫都没有，
 * 而备份是本模块刻意设计成"用户可见可动"的普通文件，于是：
 *   - 手工放 8 字节垃圾当备份 → revert 直接把用户文件覆盖成 8 字节垃圾，还报 ok:true。
 *     一个 SIGKILL 留下的截断备份就够触发（备份自身走原子写，但用户/脚本放的不走）。
 *   - `revert('/x/gone.vtt')` 在只有 `.vtt.scout-backup` 时**创建**出原本不存在的文件——
 *     而 shift 对 `.vtt` 是明确拒绝的。少了守卫的 revert 成了绕过 shift 全部前置检查的后门。
 * 所以这里补齐三道：扩展名白名单、目标必须已存在（revert 是"还原"，不是"凭备份造文件"）、
 * 备份内容基本合理性（能看出是字幕，不是任意字节）。
 */
export async function revertSubtitleTiming(
  subtitlePath: string,
  opts?: ShiftOptions,
): Promise<ShiftResult> {
  const path = resolve(subtitlePath)
  const backupPath = `${path}${BACKUP_SUFFIX}`
  const metaPath = `${path}${META_SUFFIX}`
  const exists = opts?.existsImpl ?? existsSync
  const read = opts?.readFileImpl ?? readFileSync

  // 守卫①：扩展名。与 shift 同一份白名单，否则 revert 成为 shift 检查的后门。
  const ext = extOf(path)
  if (!isSupportedExt(ext)) {
    return { ok: false, detail: `refused: unsupported extension ${ext || '(none)'} (only .ass/.ssa/.srt)` }
  }
  // 守卫②：目标必须已存在。revert 的语义是"把改过的文件还原回去"，不是"凭一个备份
  // 无中生有地造出文件"。目标不存在时备份多半是别的东西的残留（或路径写错了），
  // 照着写会在用户目录里凭空生出文件。
  if (!exists(path)) {
    return { ok: false, detail: `refused: target does not exist: ${path}; revert restores a modified file, it does not create one from a stray backup` }
  }
  if (!exists(backupPath)) {
    return { ok: false, detail: `refused: no backup at ${backupPath}; nothing to revert` }
  }
  let original: Buffer
  try {
    original = read(backupPath)
  } catch (e) {
    return { ok: false, detail: `refused: cannot read backup: ${errText(e)}, target untouched` }
  }
  // 守卫③：备份内容合理性。宁可拒绝一个可疑的备份，也不能用它覆盖用户的文件——
  // 覆盖是不可逆的，而"拒绝"只是让用户手工确认一下。
  const sanity = looksLikeSubtitle(original, ext)
  if (!sanity.ok) {
    return {
      ok: false,
      backupPath,
      detail: `refused: backup at ${backupPath} does not look like a valid ${ext} subtitle (${sanity.why}); refusing to overwrite the target with it — inspect the backup manually. Target untouched.`,
    }
  }
  try {
    atomicWrite(path, original, opts)
  } catch (e) {
    return { ok: false, detail: `revert write failed: ${errText(e)}, target untouched (backup at ${backupPath})` }
  }
  try {
    if (exists(metaPath)) unlinkSync(metaPath)
  } catch {
    // swallow: 陈旧的 meta 只会让下次 previousOffsetMs 读到一个已撤销的值，
    // 而那个字段是信息性的；撤销本身（字节已写回）已经成功，不该因此报失败。
  }
  return { ok: true, backupPath, detail: `reverted from backup (${original.length} bytes); backup kept at ${backupPath}` }
}

/**
 * 备份内容的基本合理性检查——只用于 revert 前，防止拿一个截断/垃圾备份覆盖用户文件。
 *
 * **刻意宽松**：这里的失败模式是不对称的。误拒一个真字幕 = 用户手工改个名就能绕过（烦但无损）；
 * 误放一个垃圾备份 = 用户的文件被不可逆覆盖。所以只拒"明显不是字幕"的东西：
 *   - 空文件 / 极短文件
 *   - 含 NUL（UTF-16/UTF-32/二进制——本模块按字节处理不了，也不该写回去）
 *   - 一条时间戳都找不到
 * 不检查的东西：section 完整性、Format 行、cue 数量、编码合法性。字幕组的文件千奇百怪
 * （无 [Script Info] 的、只有 [Events] 的、自定义 section 的都真实存在），
 * 把那些判成"不合理"会误拒真文件。判据只要能区分"字幕"和"垃圾"就够了。
 */
function looksLikeSubtitle(buf: Buffer, ext: string): { ok: true } | { ok: false; why: string } {
  if (buf.length === 0) return { ok: false, why: 'empty file' }
  if (buf.includes(0x00)) return { ok: false, why: 'contains NUL bytes (binary or UTF-16/UTF-32)' }
  const s = buf.toString('latin1')
  if (ext === '.srt') {
    // SRT 的最小可信特征：一个 `-->` 时间行。
    // 这里刻意不复用 SRT_TIME_LINE——它是 ^...$ 行锚定且无 /m，对整份多行文本永远失配。
    if (!/\d+:[0-5]\d:[0-5]\d,\d{3}\s*-->/.test(s)) {
      return { ok: false, why: 'no SRT timestamp line (hh:mm:ss,mmm --> hh:mm:ss,mmm) found' }
    }
    return { ok: true }
  }
  // ASS/SSA 的最小可信特征：一条带合法时间戳的 Dialogue/Comment 行。
  // 不要求 [Events] 头——真实文件里见过缺 section 头但 Dialogue 完好的。
  if (!/^\s*(?:Dialogue|Comment)\s*:/im.test(s)) {
    return { ok: false, why: 'no Dialogue:/Comment: line found' }
  }
  if (!/\d+:[0-5]\d:[0-5]\d\.\d{2}/.test(s)) {
    return { ok: false, why: 'no ASS timestamp (h:mm:ss.cc) found' }
  }
  return { ok: true }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
