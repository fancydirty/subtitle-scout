import { copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename, extname, dirname } from 'node:path'
import type { LibraryRepo } from './libraryRepo.js'

export interface PropagateDeps {
  lib: LibraryRepo
  /** 默认接 files/streamProbe.ts 的 probeDurationSec（cli/index.ts 接线）；测试注入固定值/null,
   *  从不在测试里真的 spawn ffprobe（同 IngestDeps.probe 的既有约定）。 */
  probeDuration: (videoPath: string) => Promise<number | null>
  log: (msg: string) => void
}

/** 两个视频时长相差在这个秒数以内，认定是"同一剪辑版本的不同压制/分辨率"（编码/容器取整、偶尔
 *  的尾帧差异，真实同源重复几乎总在这个范围内）；差得更多大概率是不同剪辑版本（加长版/删减版/
 *  重制版掐掉了预告-recap），机械层不猜，原样留给下面 agent 兜底路径。 */
const DURATION_TOLERANCE_SEC = 5

/**
 * 重复源 P4b（"复制优先"机械通道——spec §4 + 目标句"字幕跨副本传播（复制优先，agent 兜底）"）：
 * 副本刚入册（ingest.ts 的 addItemFile 两个调用点）时，若主文件已有字幕、这个副本还没有——探测
 * 两个视频的时长，够接近就直接把主文件的每份字幕复制改名装到副本身边；时长差得远，或探测失败
 * （ffprobe 缺席/超时/非视频），都不猜，原样留空——"宁停不猜"同北极星，不强行降级到别的判断。
 *
 * agent 兜底（spec 原话）目前的唯一可达形态：本条目的主文件若因为自己缺字幕被正常派发
 * find_subtitle（同一条目另一次缺口），search_source 的本地候选会把副本这份现成字幕顶给 agent
 * 重新判断（见 agent/findSubtitleWorker.tools.ts 的 provider==='local' 分支 + skill 的"Local
 * candidates"判断段）——这条机械通道和那条 agent 通道各管一个方向（主缺→抄副本 vs 副本
 * 缺→抄主文件），互不依赖，谁先补齐都行。
 *
 * 幂等、零多余开销：ingest 每轮都会为同一个已入册副本重新命中调用方的 addItemFile 分支（该分支
 * 本身就是幂等 upsert），所以这个函数每轮都会被重新调用一次——第一行前置检查（副本是否已有任意
 * 字幕行）让"已经补齐"或"探测失败过一次"之外的绝大多数轮次直接短路，不重新触发 ffprobe。 */
export async function propagateSubtitleToReplica(
  deps: PropagateDeps,
  itemId: string,
  mainPath: string,
  replicaPath: string,
  now: number,
): Promise<void> {
  // 副本已有任何字幕行（不论是这条通道之前写的，还是别处写的）——没有缺口，不用管。
  if (deps.lib.listSubtitlesForFile(itemId, replicaPath, false).length > 0) return

  const mainSubs = deps.lib.listSubtitlesForFile(itemId, mainPath, true)
  if (mainSubs.length === 0) return // 主文件自己都没字幕——没有可传播的东西

  const [mainDur, replicaDur] = await Promise.all([
    deps.probeDuration(mainPath),
    deps.probeDuration(replicaPath),
  ])
  if (mainDur === null || replicaDur === null) {
    deps.log(
      `[subtitle-propagate] ${itemId}: 时长探测失败（${mainDur === null ? mainPath : replicaPath}）——` +
        `跳过机械复制，留给 agent 兜底`,
    )
    return
  }
  if (Math.abs(mainDur - replicaDur) > DURATION_TOLERANCE_SEC) {
    deps.log(
      `[subtitle-propagate] ${itemId}: 时长不一致（主 ${mainDur}s / 副本 ${replicaDur}s）——` +
        `大概率是不同剪辑版本，不机械复制`,
    )
    return
  }

  const replicaBase = basename(replicaPath, extname(replicaPath))
  const replicaDir = dirname(replicaPath)
  for (const sub of mainSubs) {
    const destPath = join(replicaDir, `${replicaBase}.${sub.language}${extname(sub.path)}`)
    // 磁盘上目标位置已经有文件了——绝不覆盖。前置的 DB 检查（本函数开头）只看得到登记进
    // subtitles 表的字幕；而副本文件是走 ingest.ts 的"撞身份→addItemFile"分支入库的，那条分支
    // 不做 sidecar 探测（不同于新文件的 classify() 路径），所以副本旁边用户亲手放的 sidecar
    // 根本不在 DB 里——这层磁盘存在性检查是它唯一的防线，少了它这条通道会拿主文件的字幕覆盖
    // 掉用户手放的那份（真实数据损失）。这里只跳过、不 addReplicaSubtitle：那份磁盘文件的语言/
    // 归属不是这条通道该猜的（宁停不猜），登记归属是 ingest 未来若加副本 sidecar 探测的职责。
    if (existsSync(destPath)) {
      deps.log(`[subtitle-propagate] ${itemId}: 目标位置已有文件，跳过不覆盖：${destPath}`)
      continue
    }
    try {
      await copyFile(sub.path, destPath)
    } catch (e) {
      deps.log(
        `[subtitle-propagate] ${itemId}: 复制失败（${sub.path} -> ${destPath}): ` +
          `${e instanceof Error ? e.message : String(e)}`,
      )
      continue
    }
    deps.lib.addReplicaSubtitle(itemId, replicaPath, destPath, sub.language, 'scout-propagate', now)
  }
}
