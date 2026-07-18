import { copyFile } from 'node:fs/promises'
import { constants as fsConstants, statSync, existsSync } from 'node:fs'
import { join, basename, extname, dirname } from 'node:path'
import type { FileFingerprint, LibraryRepo, VerdictFingerprint } from './libraryRepo.js'
import { findExternalSidecar, KNOWN_LANGUAGE_TAGS } from '../files/sidecar.js'

export interface PropagateDeps {
  lib: LibraryRepo
  /** 默认接 files/streamProbe.ts 的 probeDurationSec（cli/index.ts 接线）；测试注入固定值/null,
   *  从不在测试里真的 spawn ffprobe（同 IngestDeps.probe 的既有约定）。 */
  probeDuration: (videoPath: string) => Promise<number | null>
  log: (msg: string) => void
  /** B3-4（专项#1，判决指纹记忆化）：读取一个文件当前的 (mtimeMs,size) 快照，用于跟上次判决
   *  时刻的快照比对——"文件没变，判决就还有效"。测试注入点；默认 node:fs statSync 包一层
   *  try/catch（失败→null，同 ingest.ts defaultStatFile 的既有约定）。 */
  statFile?: (p: string) => FileFingerprint | null
  /** C-3（状态收敛,批③a）：EEXIST 分支识别磁盘已存在文件的语言 tag 时用——默认真实 existsSync
   *  （同 ingest.ts 的既有默认口径）。测试从不需要覆写：subtitlePropagation.test.ts 全程用真实
   *  临时文件+真实 DB，从不 mock fs（见文件顶部注释），真实 existsSync 天然够用。 */
  fileExists?: (path: string) => boolean
}

/** 两个视频时长相差在这个秒数以内，认定是"同一剪辑版本的不同压制/分辨率"（编码/容器取整、偶尔
 *  的尾帧差异，真实同源重复几乎总在这个范围内）；差得更多大概率是不同剪辑版本（加长版/删减版/
 *  重制版掐掉了预告-recap），机械层不猜，原样留给下面 agent 兜底路径。 */
const DURATION_TOLERANCE_SEC = 5

function defaultStatFile(path: string): FileFingerprint | null {
  try {
    const s = statSync(path)
    return { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return null
  }
}

/** B3-4：判决那一刻记住的快照，与两个文件当前的快照是否逐项相等——任一维度（mtime/size，
 *  主/副任一文件）不等都算"文件变了"，必须重判，不能沿用旧判决。 */
function fingerprintUnchanged(
  memo: VerdictFingerprint,
  currentMain: FileFingerprint,
  currentReplica: FileFingerprint,
): boolean {
  return (
    memo.main.mtimeMs === currentMain.mtimeMs && memo.main.size === currentMain.size &&
    memo.replica.mtimeMs === currentReplica.mtimeMs && memo.replica.size === currentReplica.size
  )
}

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
 * 字幕行）让"已经补齐"或"探测失败过一次"之外的绝大多数轮次直接短路，不重新触发 ffprobe。
 *
 * B3-4（专项#1，判决指纹记忆化）：上面这条前置检查只覆盖"成功复制过"的情形——时长不匹配/探测
 * 失败这两种"判过但没能复制"的结局什么都不写，于是每轮都要对主副两个文件重新真的 ffprobe（生产
 * 实证：SPY×FAMILY 13 集×2 探测/每 pass 的探测空转）。这里补上第二条短路锚点：mismatch/
 * probe-failed 判决落地时，把判决结果 + 判决那一刻主副两个文件的 (mtimeMs,size) 快照一起记进
 * item_files（duration_verdict/verdict_fingerprint，schema v17）；下次调用时先比对两个文件的
 * 当前快照与记住的快照是否逐项相等——完全相等（文件没变）就直接沿用旧判决短路，不重新探测；任一
 * 文件变了（重新下载/替换/修复损坏文件）说明旧判决可能已经过期，照常重新判并覆写记忆。成功复制
 * 路径不需要这套记忆——有字幕行本身就是上面那条更早的短路锚点。 */
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

  const statFile = deps.statFile ?? defaultStatFile
  const fileExists = deps.fileExists ?? existsSync
  const currentMainStat = statFile(mainPath)
  const currentReplicaStat = statFile(replicaPath)

  const verdictMemo = deps.lib.getItemFileVerdict(replicaPath)
  if (
    verdictMemo && currentMainStat && currentReplicaStat &&
    fingerprintUnchanged(verdictMemo.fingerprint, currentMainStat, currentReplicaStat)
  ) {
    // 两个文件都没变——上次判过 mismatch/probe-failed，这次结果不会不同，静默短路。
    return
  }

  const [mainDur, replicaDur] = await Promise.all([
    deps.probeDuration(mainPath),
    deps.probeDuration(replicaPath),
  ])
  if (mainDur === null || replicaDur === null) {
    deps.log(
      `[subtitle-propagate] ${itemId}: 时长探测失败（${mainDur === null ? mainPath : replicaPath}）——` +
        `跳过机械复制，留给 agent 兜底`,
    )
    if (currentMainStat && currentReplicaStat) {
      deps.lib.setItemFileVerdict(replicaPath, 'probe-failed', { main: currentMainStat, replica: currentReplicaStat })
    }
    return
  }
  if (Math.abs(mainDur - replicaDur) > DURATION_TOLERANCE_SEC) {
    deps.log(
      `[subtitle-propagate] ${itemId}: 时长不一致（主 ${mainDur}s / 副本 ${replicaDur}s）——` +
        `大概率是不同剪辑版本，不机械复制`,
    )
    if (currentMainStat && currentReplicaStat) {
      deps.lib.setItemFileVerdict(replicaPath, 'mismatch', { main: currentMainStat, replica: currentReplicaStat })
    }
    return
  }

  const replicaBase = basename(replicaPath, extname(replicaPath))
  const replicaDir = dirname(replicaPath)
  for (const sub of mainSubs) {
    const destPath = join(replicaDir, `${replicaBase}.${sub.language}${extname(sub.path)}`)
    try {
      // H5（2026-07-18 数据安全审计——TOCTOU + 悬空符号链接防线）：曾经是 existsSync(destPath) 预检
      // + 无 flag 的 copyFile，中间有 TOCTOU 窗口，且 existsSync 对悬空符号链接（entry 存在但链接
      // 目标不存在）返回 false——那种情况会误判"不存在"，copyFile 穿过链接把主文件字幕写到链接
      // 指向的任意位置（可能在媒体目录之外）。COPYFILE_EXCL 让底层 open() 带 O_EXCL：目标路径只要
      // 已存在任何 dirent（哪怕是悬空符号链接本身），一律 EEXIST，从不穿透、从不覆盖。
      await copyFile(sub.path, destPath, fsConstants.COPYFILE_EXCL)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        // 磁盘上目标位置已经有文件（或悬空符号链接）了——绝不覆盖。前置的 DB 检查（本函数开头）
        // 只看得到登记进 subtitles 表的字幕；而副本文件是走 ingest.ts 的"撞身份→addItemFile"分支
        // 入库的，那条分支不做 sidecar 探测（不同于新文件的 classify() 路径），所以副本旁边用户
        // 亲手放的 sidecar 根本不在 DB 里。
        //
        // C-3（状态收敛,批③a）：B3-5 只把日志措辞升级成 warn,没有登记——但如果这份磁盘文件的
        // 文件名本身就能被认出目标语言 tag(走 findExternalSidecar 同一套 existsSync 磁盘验真
        // 机制,天然排除悬空符号链接这类"名字像但摸不到"的假阳性,H5 的 COPYFILE_EXCL 已经在
        // copyFile 层面挡过一次,这里 existsSync 跟随符号链接语义顺手又挡了一次),就不该继续装
        // 看不见——用 KNOWN_LANGUAGE_TAGS(与用户当前 target_languages 配置无关,见该常量头注释)
        // 反查 replicaPath 旁边究竟是谁,命中且正是这次撞上的 destPath 才登记(避免误认成
        // 附近另一份不相关的已知语言 sidecar)。"宁停不猜"只对"猜不出语言"成立，能确定语言时
        // 不该继续装看不见。
        const identified = findExternalSidecar(replicaPath, KNOWN_LANGUAGE_TAGS, fileExists)
        if (identified && identified.path === destPath) {
          deps.lib.addReplicaSubtitle(itemId, replicaPath, destPath, identified.language, 'preexisting', now)
          deps.log(
            `[subtitle-propagate] ${itemId}: 目标位置已有文件，从文件名识别出语言 ${identified.language}，` +
              `登记为预置字幕（不覆盖，只记账）：${destPath}`,
          )
          continue
        }
        // 识别不出（裸名/非标准 tag/悬空链接）→ 维持 B3-5 的"宁停不猜"+warn：这类文件会永久卡在
        // "磁盘有文件但 DB 不知道"的状态，运维排查覆盖率缺口时容易漏看，日志必须把这层后果说
        // 清楚，不能只说"跳过不覆盖"这种自证性但没解释后果的措辞。
        deps.log(
          `[subtitle-propagate] WARN ${itemId}: 目标位置已有文件，跳过不覆盖：${destPath}——` +
            `该文件存在但未登记，不会计入覆盖，需人工核查归属（可能是永久 stuck 的副本字幕）`,
        )
        continue
      }
      deps.log(
        `[subtitle-propagate] ${itemId}: 复制失败（${sub.path} -> ${destPath}): ` +
          `${e instanceof Error ? e.message : String(e)}`,
      )
      continue
    }
    deps.lib.addReplicaSubtitle(itemId, replicaPath, destPath, sub.language, 'scout-propagate', now)
  }
}
