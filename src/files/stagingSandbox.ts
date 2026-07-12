// 字幕试错沙盒:候选下载到这里"打开看",agent 终审通过才原子安装进媒体目录。
// 试错本身零风险——job 结束(无论成败)整个沙盒目录被删除,写错媒体库的唯一路径是 install()。
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const STAGING_DIRNAME = '.subtitle-staging'

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
