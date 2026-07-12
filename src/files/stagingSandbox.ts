// 字幕试错沙盒:候选下载到这里"打开看",agent 终审通过才原子安装进媒体目录。
// 试错本身零风险——job 结束(无论成败)整个沙盒目录被删除,写错媒体库的唯一路径是 install()。
import {
  existsSync, mkdirSync, rmSync, writeFileSync, readFileSync,
  renameSync, openSync, fsyncSync, closeSync, unlinkSync,
  readdirSync, lstatSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { writeAll } from './fsUtil.js'

const STAGING_DIRNAME = '.subtitle-staging'
const INSTALL_RETRY_DELAYS_MS = [50, 150, 400, 1000]
const RETRYABLE_CODES = new Set(['EEXIST', 'EPERM', 'EBUSY'])

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 跨设备兜底(理论上不该发生——沙盒与视频同根,见 allocate):拷到目标目录内点前缀
 *  临时名 → fsync → 同盘 rename。任何一步失败(写入/fsync/改名)都 best-effort 删掉这个
 *  临时文件再往外抛——否则它会永久留在媒体目录里,既不是试错沙盒的一部分(不会被 cleanup()
 *  回收),也不在 gcOrphans 的清扫范围内(那只扫 .subtitle-staging/ 内部)。 */
function copyThenRenameSameDir(stagedPath: string, finalPath: string): void {
  const data = readFileSync(stagedPath)
  const tmpPath = join(dirname(finalPath), `.subtitle-scout-install-${process.pid}-${Date.now()}`)
  const fd = openSync(tmpPath, 'w')
  try {
    try {
      writeAll(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmpPath, finalPath)
  } catch (e) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // best-effort: cleanup failure must never mask the original error, and the temp
      // file may already be gone (e.g. rename itself succeeded before a caller-side
      // failure elsewhere) or unlink may fail on a flaky NAS/SMB mount
    }
    throw e
  }
}

/** 每 job 独立的沙盒目录:`<mediaRootForVideo>/.subtitle-staging/<jobId>/`。必须与目标视频
 *  同一文件系统——install() 的原子 rename 单跳不容跨设备。目录带点前缀 + 同级 `.ignore`
 *  标记文件,Jellyfin 双保险扫不到。jobId 由调用方保证同一时刻内唯一。 */
export function allocate(jobId: string, mediaRootForVideo: string): string {
  const root = join(mediaRootForVideo, STAGING_DIRNAME)
  const dir = join(root, jobId)
  mkdirSync(dir, { recursive: true })
  const ignorePath = join(root, '.ignore')
  if (!existsSync(ignorePath)) {
    try {
      writeFileSync(ignorePath, 'subtitle-scout staging area — media servers should not scan this directory\n')
    } catch {
      // best-effort 标记;缺失从不阻塞试错流程,顶多让 Jellyfin 误扫到孤儿 srt
    }
  }
  return dir
}

/** job 结束(无论成败)删除整个沙盒目录——试错垃圾零残留。best-effort:NAS/SMB 上 rm
 *  可能因残留文件句柄失败,不让清理失败拖垮主流程结论(同 subtitleWriter 的孤儿 .tmp 清理先例)。 */
export function cleanup(jobId: string, mediaRootForVideo: string): void {
  const dir = join(mediaRootForVideo, STAGING_DIRNAME, jobId)
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort:清理失败不影响本次运行已产生的结论
  }
}

export interface InstallOptions {
  /** 重试退避表(毫秒),默认走生产梯度 INSTALL_RETRY_DELAYS_MS。目前没有生产调用方会传
   *  这个参数——只为测试开的口子,让"重试到耗尽"这类用例不用真等 ~1.6s 的退避总和。 */
  delaysMs?: number[]
}

/** 原子安装:沙盒里胜出的文件 rename 进媒体目录。文件名一律 NFC 归一化(群晖 SMB 的
 *  NFD/NFC 乱码坑)——finalPath 先 normalize('NFC') 再判存在性/改名。遇 EEXIST/EPERM/
 *  EBUSY(SMB oplock 抖动)退避重试;EXDEV(跨设备)兜底走拷贝+改名。不用 O_TMPFILE
 *  (网络盘不支持)。 */
export async function install(
  stagedPath: string,
  finalPath: string,
  opts?: InstallOptions,
): Promise<{ path: string }> {
  const delaysMs = opts?.delaysMs ?? INSTALL_RETRY_DELAYS_MS
  const normalizedFinal = finalPath.normalize('NFC')
  let lastError: unknown
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      renameSync(stagedPath, normalizedFinal)
      return { path: normalizedFinal }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EXDEV') {
        copyThenRenameSameDir(stagedPath, normalizedFinal)
        return { path: normalizedFinal }
      }
      lastError = e
      if (code && RETRYABLE_CODES.has(code) && attempt < delaysMs.length) {
        await sleep(delaysMs[attempt])
        continue
      }
      throw e
    }
  }
  throw lastError
}

/** 启动即回收(镜像 jobsRepo.reapAllActive 的"单实例前提,无条件回收"):删除每个
 *  mediaRoot 下所有不在 activeJobIds 里的 .subtitle-staging/<jobId> 条目——目录、
 *  文件、符号链接一视同仁,统统当垃圾清。daemon 启动时旧进程必已死,任何残留都是崩溃/
 *  被杀留下的试错垃圾——不看年龄,直接清。返回清理的条目数。
 *
 *  用 lstatSync 而非 statSync:后者会跟随符号链接——断链目标不存在时 statSync 直接抛
 *  ENOENT,命中下面的 catch 被当成"清理失败"跳过,断链就永久堆在这里出不去。lstatSync
 *  只看链接本身,断链也能正常 stat 到,进而被 rmSync 删掉。同理,rmSync 对符号链接(哪怕
 *  指向目录)只解链接本身,不会顺着链接递归删目标——指向的真实目录不受影响。 */
export function gcOrphans(mediaRoots: string[], activeJobIds: Set<string>): number {
  let cleaned = 0
  for (const root of mediaRoots) {
    const stagingRoot = join(root, STAGING_DIRNAME)
    if (!existsSync(stagingRoot)) continue
    let entries: string[]
    try {
      entries = readdirSync(stagingRoot)
    } catch {
      continue // best-effort:目录列不出来(权限/挂载抖动)跳过这一根,下次启动再试
    }
    for (const name of entries) {
      if (name === '.ignore' || activeJobIds.has(name)) continue
      const full = join(stagingRoot, name)
      try {
        lstatSync(full) // 存在性探测,不跟随链接;断链在这里也不会抛
        rmSync(full, { recursive: true, force: true })
        cleaned++
      } catch {
        // best-effort:单个条目清理失败不影响其它条目/其它根
      }
    }
  }
  return cleaned
}
