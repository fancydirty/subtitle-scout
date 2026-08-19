// src/core/mountKind.test.ts：挂载类型判定。
//
// **fixture 是生产容器里 dump 出来的真实 mountinfo**（2026-07-30，subtitle-scout 容器），
// 不是手写的想象格式。这一点很要紧：真实数据里同一个文件既有带 `master:30` 可选字段的行、
// 也有不带的行，正是这个可变性让"按固定列号取 fstype"的写法在一半的行上取错。
import { describe, it, expect } from 'vitest'
import {
  parseMountInfo, findMountFor, classifyFstype, classifyPath, canRenderWaveform,
  type MountEntry,
} from './mountKind.js'

/** 生产容器 /proc/self/mountinfo 的真实片段（长选项串已截断，与解析无关）。 */
const REAL = [
  '1018 73 0:28 / / rw,relatime master:30 - overlay overlay rw,lowerdir=/a:/b,upperdir=/c,workdir=/d',
  '1019 1018 0:31 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw',
  '1034 1018 0:32 /TV /media/tv rw,relatime - cifs //test-nas/share rw,vers=3.1.1,cache=strict',
  '1035 1018 0:32 /anime /media/anime rw,relatime - cifs //test-nas/share rw,vers=3.1.1',
  '1036 1018 0:429 / /media/aliyun rw,nosuid,nodev,relatime - fuse.rclone aliyun-dav:subtitle-scout-test rw,user_id=0',
  '1037 1018 0:32 /Movies /media/movies rw,relatime - cifs //test-nas/share rw,vers=3.1.1',
].join('\n')

const realEntries = () => parseMountInfo(REAL)
const withReal = { readMountInfo: () => REAL, realpath: (p: string) => p }

describe('parseMountInfo：真实格式解析', () => {
  it('解析出全部 6 条，挂载点与 fstype 正确', () => {
    const e = realEntries()
    expect(e).toHaveLength(6)
    expect(e.find((x) => x.mountPoint === '/media/tv')?.fstype).toBe('cifs')
    expect(e.find((x) => x.mountPoint === '/media/aliyun')?.fstype).toBe('fuse.rclone')
    expect(e.find((x) => x.mountPoint === '/')?.fstype).toBe('overlay')
  })

  // 回归锁：可选字段（master:30 / shared:N / propagate_from:N / unbindable）数量可变，
  // fstype 必须按分隔符 '-' 定位。第一行带 master:30，第二行不带——若按固定列号取，
  // 两行必有一行取错。
  it('可选字段数量可变时仍取对 fstype（必须按 - 定位而非列号）', () => {
    const e = parseMountInfo([
      '1 2 0:1 / /withopt rw shared:1 master:2 propagate_from:3 - ext4 /dev/sda1 rw',
      '1 2 0:1 / /noopt rw - ext4 /dev/sda1 rw',
      '1 2 0:1 / /unbind rw unbindable - btrfs /dev/sdb1 rw',
    ].join('\n'))
    expect(e.map((x) => x.fstype)).toEqual(['ext4', 'ext4', 'btrfs'])
  })

  it('八进制转义的挂载点被反转义（含空格的路径否则永远匹配不上）', () => {
    const e = parseMountInfo('1 2 0:1 / /media/My\\040Movies rw - cifs //nas/share rw')
    expect(e[0]?.mountPoint).toBe('/media/My Movies')
  })

  it('畸形行被跳过而不是崩掉（无 - 分隔符 / 字段不足 / 空行）', () => {
    const e = parseMountInfo([
      '1 2 0:1 / /ok rw - ext4 /dev/sda1 rw',
      'garbage',
      '1 2 0:1 / /nodash rw ext4',
      '',
      '1 2 0:1 / /trailing rw -',
    ].join('\n'))
    expect(e).toHaveLength(1)
    expect(e[0]?.mountPoint).toBe('/ok')
  })
})

describe('findMountFor：最长路径段前缀匹配', () => {
  it('嵌套目录归属最近的挂载点', () => {
    const e = realEntries()
    expect(findMountFor('/media/tv/Silo/S01E01.mkv', e)?.fstype).toBe('cifs')
    expect(findMountFor('/media/aliyun/Movie/a.mkv', e)?.fstype).toBe('fuse.rclone')
  })

  it('挂载点自身命中', () => {
    expect(findMountFor('/media/aliyun', realEntries())?.mountPoint).toBe('/media/aliyun')
  })

  it('未被任何 /media/* 覆盖的路径落到根挂载', () => {
    expect(findMountFor('/app/dist/index.js', realEntries())?.fstype).toBe('overlay')
  })

  // 回归锁：按路径段比较，不是裸 startsWith。/media/tv-old 与 /media/tv 同前缀但
  // 是完全不同的目录，若用 startsWith 会继承错误的存储类型。
  it('同前缀但不同目录不被误命中（/media/tv-old ≠ /media/tv 之下）', () => {
    const e = realEntries()
    const hit = findMountFor('/media/tv-old/x.mkv', e)
    expect(hit?.mountPoint).toBe('/')      // 落到根，不是 /media/tv
    expect(hit?.fstype).toBe('overlay')
  })

  // over-mount：同一挂载点被挂两次，内核里后者遮蔽前者，mountinfo 行序反映这个顺序。
  it('同一挂载点出现两次时后者胜（over-mount 语义）', () => {
    const e = parseMountInfo([
      '1 2 0:1 / /media/x rw - ext4 /dev/sda1 rw',
      '2 2 0:2 / /media/x rw - fuse.rclone remote: rw',
    ].join('\n'))
    expect(findMountFor('/media/x/f.mkv', e)?.fstype).toBe('fuse.rclone')
  })

  it('挂载表为空时返回 null', () => {
    expect(findMountFor('/media/tv/a.mkv', [] as MountEntry[])).toBeNull()
  })
})

describe('classifyFstype：三态分级', () => {
  it('本地块设备/内存文件系统 → local', () => {
    for (const fs of ['ext4', 'btrfs', 'xfs', 'zfs', 'overlay', 'tmpfs', 'exfat']) {
      expect(classifyFstype(fs), fs).toBe('local')
    }
  })

  // 这一档是本模块存在的理由：实测 cifs 抽整轨波形 8 秒，与本地同量级。
  // 初稿把它归进"网络挂载→禁用"，会禁掉生产库 492 个条目中的全部。
  it('局域网协议 → lan（不是 cloud——实测 8 秒抽完整轨）', () => {
    for (const fs of ['cifs', 'smb3', 'nfs', 'nfs4', '9p', 'virtiofs', 'fuse.mergerfs']) {
      expect(classifyFstype(fs), fs).toBe('lan')
    }
  })

  it('公网对象存储 → cloud', () => {
    for (const fs of ['fuse.rclone', 'fuse.davfs', 'fuse.s3fs', 'fuse.sshfs', 'fuse.juicefs']) {
      expect(classifyFstype(fs), fs).toBe('cloud')
    }
  })

  // 裸 fuse 分不出是 rclone（慢）还是 mergerfs（快）——statfs 的 magic number 也是同一个值，
  // 这正是本模块读 mountinfo 而不用 statfs 的原因。判不出来就保守。
  it('裸 fuse（无子类型）→ cloud（判不出来，保守）', () => {
    expect(classifyFstype('fuse')).toBe('cloud')
  })

  it('未登记的 fstype → cloud（保守兜底）', () => {
    expect(classifyFstype('some_future_fs')).toBe('cloud')
    expect(classifyFstype('')).toBe('cloud')
  })
})

describe('classifyPath：端到端（真实生产挂载表）', () => {
  // 这四条直接对应生产实测：cifs 三个目录共 492 个条目必须可用，云盘 27 个必须禁用。
  it('生产库的三个 cifs 目录判为 lan（492 个条目不被误禁）', () => {
    expect(classifyPath('/media/tv/Silo/S01E01.mkv', withReal)).toBe('lan')
    expect(classifyPath('/media/anime/Gachiakuta/S01E21.mkv', withReal)).toBe('lan')
    expect(classifyPath('/media/movies/Dune.mkv', withReal)).toBe('lan')
  })

  it('阿里云盘目录判为 cloud（实测 >120s 抽 60s 音频）', () => {
    expect(classifyPath('/media/aliyun/Movie/a.mkv', withReal)).toBe('cloud')
  })

  it('容器内 overlay 判为 local', () => {
    expect(classifyPath('/app/x.srt', withReal)).toBe('local')
  })

  it('拿不到挂载表（非 Linux/无 /proc）→ cloud，不抛错', () => {
    expect(classifyPath('/media/tv/a.mkv', { readMountInfo: () => null })).toBe('cloud')
  })

  it('挂载表畸形到无任何匹配 → cloud', () => {
    expect(classifyPath('/media/tv/a.mkv', {
      readMountInfo: () => 'garbage\nmore garbage',
      realpath: (p) => p,
    })).toBe('cloud')
  })

  it('realpath 归一后再匹配（symlink 指向云盘时不能被绕过）', () => {
    const kind = classifyPath('/link/to/cloud.mkv', {
      readMountInfo: () => REAL,
      realpath: () => '/media/aliyun/real.mkv',
    })
    expect(kind).toBe('cloud')
  })

  it('realpath 抛错（文件还不存在）时用原路径继续，不崩', () => {
    const kind = classifyPath('/media/tv/notyet.srt', {
      readMountInfo: () => REAL,
      realpath: () => { throw new Error('ENOENT') },
    })
    expect(kind).toBe('lan')
  })
})

describe('canRenderWaveform：只有 cloud 不行', () => {
  it('local 与 lan 都能画波形（实测同为 8 秒量级）', () => {
    expect(canRenderWaveform('local')).toBe(true)
    expect(canRenderWaveform('lan')).toBe(true)
  })
  it('cloud 不能', () => {
    expect(canRenderWaveform('cloud')).toBe(false)
  })
})

// 回归锁（这两条抓到过真实缺陷）：注入的实现不一定守约。原实现只在 defaultRealpath 内部
// try/catch，注入一个会抛的 realpath 就能把 classifyPath 炸穿——而这是个增益功能，
// 绝不该因为路径归一失败而让调用方崩。readMountInfo 同理。
describe('注入点抛错必须被兜住（增益功能不许反噬调用方）', () => {
  it('readMountInfo 抛错 → cloud，不冒泡', () => {
    expect(classifyPath('/media/tv/a.mkv', {
      readMountInfo: () => { throw new Error('EACCES') },
    })).toBe('cloud')
  })
})
