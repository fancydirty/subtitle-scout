// src/core/mountKind.ts：判断一个路径落在什么存储上——local / lan / cloud 三态。
//
// 为什么需要这个（2026-07-30 实测驱动）：字幕对照图要抽音频波形，而抽波形的成本在不同
// 存储上差三个数量级。生产实测（同一个 23.7 分钟文件，同一条 ffmpeg 命令）：
//   - cifs（局域网 NAS，千兆内网）  抽整轨波形 8 秒     → 可用
//   - fuse.rclone（阿里云盘 WebDAV）抽 60 秒音频 >120 秒 → 不可用
// 每次 seek 在公网对象存储上要付 ~12 秒 CDN 延迟地板，这是协议特性不是带宽问题。
//
// **关键教训**：初稿的规则是"网络挂载就禁用"，实测发现生产库 492 个条目（tv 436 / anime 46 /
// movies 10）**全在 cifs 上**——那条规则会禁掉全部，而真正跑不动的只有云盘那 27 个。
// 所以分界不是"网络 vs 本地"，是"局域网 vs 公网对象存储"。
//
// 为什么读 /proc/self/mountinfo 而不是 statfs：statfs 的 f_type magic number 把所有 FUSE
// 压成同一个值（0x65735546），分不出 fuse.rclone（云盘，慢）和 fuse.mergerfs（本地聚合，快）。
// mountinfo 带 FUSE 子类型，这个区分是本模块存在的意义。
//
// 容器内可用性已在生产容器验证：bind mount 共享 superblock，容器内 mountinfo 看到的是
// **原始 fstype**（上面那些实测数字就是从容器里读出来的）。此前担心的"容器内看不到宿主
// fstype"不成立。
import { readFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'

export type MountKind = 'local' | 'lan' | 'cloud'

/** 真本地块设备/内存文件系统——seek 无网络成本。 */
const LOCAL_FSTYPES = new Set([
  'ext2', 'ext3', 'ext4', 'btrfs', 'xfs', 'zfs', 'f2fs', 'jfs', 'reiserfs',
  'vfat', 'exfat', 'ntfs', 'ntfs3', 'hfsplus', 'apfs',
  'overlay', 'tmpfs', 'ramfs', 'squashfs', 'erofs',
])

/** 局域网文件协议——seek 毫秒级，实测 8 秒抽完 23.7 分钟整轨波形。
 *  注意 sshfs 不在这里：它既可能连局域网也可能连公网，判不出来，按保守规则落 cloud。 */
const LAN_FSTYPES = new Set([
  'cifs', 'smb3', 'smbfs', 'nfs', 'nfs4', 'nfsd', '9p', 'virtiofs',
  'fuse.mergerfs', 'fuse.glusterfs', 'ceph', 'lustre', 'afs', 'afpfs',
])

/** 公网对象存储/网盘——每次 seek 付 CDN 延迟地板，随机读不可用。 */
const CLOUD_FSTYPES = new Set([
  'fuse.rclone', 'fuse.davfs', 'davfs', 'davfs2',
  'fuse.s3fs', 's3fs', 'fuse.gcsfuse', 'fuse.blobfuse', 'fuse.blobfuse2',
  'fuse.sshfs', 'sshfs', 'fuse.jfs', 'fuse.juicefs', 'fuse.alist', 'fuse.clouddrive',
])

/** 一条 mountinfo 记录里我们关心的部分。 */
export interface MountEntry {
  mountPoint: string
  fstype: string
}

/**
 * 解析 /proc/self/mountinfo 文本。
 *
 * 格式（man 5 proc）：
 *   ID parentID major:minor root mountPoint options [optionalFields...] - fstype source superOptions
 *
 * **optionalFields 数量可变**（`shared:N` / `master:N` / `propagate_from:N` / `unbindable`
 * 可能出现零到多个），所以 fstype **必须**按分隔符 `-` 定位，不能按固定列号取。生产实测
 * 里同一个文件既有带 `master:30` 的行也有不带的行——按列号取会在一半的行上取错。
 *
 * 路径里的空白/特殊字符按 mountinfo 约定做了八进制转义（\040=空格 \011=tab \012=换行
 * \134=反斜杠），必须反转义，否则含空格的挂载点永远匹配不上。
 */
export function parseMountInfo(text: string): MountEntry[] {
  const out: MountEntry[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    const fields = line.split(' ')
    // 找分隔符 `-`：它之后紧跟 fstype。从第 6 个字段起找（前 6 个是固定字段，
    // 且挂载点/选项里理论上不会出现裸的单个 '-' 字段——真出现也在 6 之前不影响）。
    const dash = fields.indexOf('-', 6)
    if (dash === -1 || dash + 1 >= fields.length) continue
    const mountPoint = fields[4]
    const fstype = fields[dash + 1]
    if (mountPoint === undefined || fstype === undefined) continue
    out.push({ mountPoint: unescapeOctal(mountPoint), fstype })
  }
  return out
}

/** mountinfo 的八进制转义反转（\040 空格 / \011 tab / \012 换行 / \134 反斜杠）。 */
function unescapeOctal(s: string): string {
  if (!s.includes('\\')) return s
  return s.replace(/\\(0[0-7]{2}|1[0-7]{2})/g, (_m, oct: string) =>
    String.fromCharCode(parseInt(oct, 8)))
}

/**
 * 在挂载表里找覆盖 `path` 的那条记录。
 *
 * 两个必须做对的细节：
 *  - **按路径段匹配**，不是字符串 startsWith。`/media/tv-old` 不该被 `/media/tv` 命中，
 *    否则一个碰巧同前缀的目录会继承错误的存储类型。
 *  - **后出现的胜**（over-mount）：同一挂载点被挂两次时，内核里后者遮蔽前者，
 *    mountinfo 的行序反映这个顺序。
 */
export function findMountFor(path: string, entries: readonly MountEntry[]): MountEntry | null {
  let best: MountEntry | null = null
  let bestLen = -1
  for (const e of entries) {
    if (!isPathUnder(path, e.mountPoint)) continue
    // >= 而非 >：等长时取后者，实现 over-mount 的"后者胜"
    if (e.mountPoint.length >= bestLen) {
      best = e
      bestLen = e.mountPoint.length
    }
  }
  return best
}

/** path 是否在 base 之下（或就是 base）——按路径段比较，不是裸 startsWith。 */
function isPathUnder(path: string, base: string): boolean {
  if (base === sep) return true
  if (path === base) return true
  return path.startsWith(base.endsWith(sep) ? base : base + sep)
}

/** fstype → 三态。未登记的 fstype 一律 cloud，理由见 classifyPath 的注释。 */
export function classifyFstype(fstype: string): MountKind {
  if (LOCAL_FSTYPES.has(fstype)) return 'local'
  if (LAN_FSTYPES.has(fstype)) return 'lan'
  if (CLOUD_FSTYPES.has(fstype)) return 'cloud'
  return 'cloud'
}

export interface ClassifyOpts {
  /** 注入点：mountinfo 文本。默认读 /proc/self/mountinfo，非 Linux 或读不到时为 null。 */
  readMountInfo?: () => string | null
  /** 注入点：路径归一。默认 realpathSync，失败时回退原路径（文件可能还不存在）。 */
  realpath?: (p: string) => string
}

/**
 * 判断一个路径落在什么存储上。
 *
 * **判不出来时返回 'cloud'（保守）**。方向是刻意不对称的：
 *  - 误判云盘为本地 → ffmpeg 从 WebDAV 拉几 GB、挂到超时、占死 worker 槽位
 *  - 误判本地为云盘 → 灰掉一个按钮
 * 前者的代价高出好几个数量级，所以一切不确定都往 cloud 倒。
 * （现有 media_roots.type 硬编码 'local' 恰恰错在危险的那个方向。）
 *
 * 已知失败模式：宿主在容器启动**之后**才挂载 rclone 时，默认 rprivate 传播会让容器看到
 * 底层的空 ext4 → 判成 local。缓解是 bind-propagation=rslave；不缓解的话表现为
 * "抽波形超时"而非数据损坏（波形是增益功能，超时只是没有波形）。
 */
export function classifyPath(path: string, opts?: ClassifyOpts): MountKind {
  const read = opts?.readMountInfo ?? defaultReadMountInfo
  // 同下方 realpath：注入实现可能抛，兜住（判不出来即保守 cloud，见函数头注释）
  let text: string | null
  try {
    text = read()
  } catch {
    text = null
  }
  // 拿不到挂载表（非 Linux / 无 /proc / 权限不足）→ 无从判断 → 保守
  if (text === null) return 'cloud'

  const rp = opts?.realpath ?? defaultRealpath
  // try/catch 必须包在**调用点**而不是只包在 defaultRealpath 内部：注入的实现不一定守
  // "失败返回原路径"的约（测试就注入了一个会抛的），而一个增益功能的路径归一失败绝不该
  // 把调用方炸掉。同理见 referenceSource.ts 对注入点的兜底。
  let resolved: string
  try {
    resolved = rp(path)
  } catch {
    resolved = path
  }
  const entry = findMountFor(resolved, parseMountInfo(text))
  // 连 / 都没匹配上意味着挂载表畸形 → 保守
  if (entry === null) return 'cloud'
  return classifyFstype(entry.fstype)
}

function defaultReadMountInfo(): string | null {
  try {
    return readFileSync('/proc/self/mountinfo', 'utf8')
  } catch {
    // 非 Linux（macOS 开发机）或 /proc 不可读——不是错误，就是无从判断
    return null
  }
}

function defaultRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    // 文件可能还不存在（正要创建）或有权限问题——用原路径继续，
    // 前缀匹配对未归一路径仍然大多正确（只在有 symlink 时才失准）
    return p
  }
}

/** 能不能给这个路径做音频波形。仅 cloud 不行——local 与 lan 实测都是 8 秒量级。 */
export function canRenderWaveform(kind: MountKind): boolean {
  return kind !== 'cloud'
}
