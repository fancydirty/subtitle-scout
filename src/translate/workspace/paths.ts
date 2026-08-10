import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkspacePaths } from './types.js'

export const TRANSLATE_STAGING_DIRNAME = '.subtitle-translate'

export function workspacePaths(stagingBase: string, jobId: string): WorkspacePaths {
  const jobRoot = join(stagingBase, TRANSLATE_STAGING_DIRNAME, jobId)
  const canonicalDir = join(jobRoot, 'canonical')
  const agentViewDir = join(jobRoot, 'agent_view')
  const contextDir = join(jobRoot, 'context')
  const glossaryDir = join(jobRoot, 'glossary')
  const workDir = join(jobRoot, 'work')
  const outDir = join(jobRoot, 'out')
  return {
    jobRoot,
    canonicalDir,
    agentViewDir,
    contextDir,
    glossaryDir,
    workDir,
    outDir,
    metaPath: join(jobRoot, 'meta.json'),
    sourceCleanPath: join(agentViewDir, 'source_clean.jsonl'),
    bilingualPath: join(workDir, 'bilingual.jsonl'),
    glossaryPath: join(glossaryDir, 'terms.json'),
    glossaryFrozenPath: join(glossaryDir, 'FROZEN'),
    summaryPath: join(workDir, 'summary.md'),
    criticPath: join(workDir, 'critic.md'),
    targetSrtPath: join(outDir, 'target.srt'),
    canonicalSourcePath: join(canonicalDir, 'source.srt'),
  }
}

export function ensureWorkspaceLayout(stagingBase: string, jobId: string): WorkspacePaths {
  const paths = workspacePaths(stagingBase, jobId)
  for (const dir of [
    paths.jobRoot,
    paths.canonicalDir,
    paths.agentViewDir,
    paths.contextDir,
    paths.glossaryDir,
    paths.workDir,
    paths.outDir,
  ]) {
    mkdirSync(dir, { recursive: true })
  }
  const ignorePath = join(stagingBase, TRANSLATE_STAGING_DIRNAME, '.ignore')
  if (!existsSync(ignorePath)) {
    try {
      writeFileSync(
        ignorePath,
        'subtitle-scout subtitle-translate staging — media servers should not scan this directory\n',
      )
    } catch {
      // best-effort
    }
  }
  return paths
}

/** 开工前清空这个 job 的工作台（**先删整棵、再由 ensureWorkspaceLayout 重建**）。
 *
 *  ── 为什么在 jobId 变成稳定身份之后这件事从"无所谓"变成"必须"──
 *  jobId 曾是 `daemon-${Date.now()}`，每次都是崭新目录，天然没有串味问题（代价是永久堆积，
 *  见 ownIds.translateJobId 的论证）。改成 `translateJobId(workId, path)` 之后同一个文件重试
 *  会**复用同一个目录**，于是上一次失败留下的半成品会污染这一次：
 *   · `glossary/FROZEN` 存在 → `freeze_glossary` 直接返回 "already frozen for this job"
 *     （那个工具刻意 one-shot），这一次翻译只能拿着上一次的旧术语表跑；若上次正是因为术语
 *     冲突而 held，这一行就**永久 held**——每轮一个付费 LLM session 却永远过不了闸。
 *   · `work/bilingual.jsonl` 残留 → 模型以为自己已经译过这些行（`get_window` 读得到旧 tgt）。
 *   · `work/.gate-pass` 类标记与旧 `out/target.srt` 残留 → install 的 fail-closed 判据基于
 *     "当前 bilingual 表"，半旧半新的桌面是它最不该面对的输入。
 *  故规则是：**稳定身份负责不堆积，开工前清空负责不串味**，两者缺一不可。
 *
 *  剧级术语表的继承**不受影响**：那份 canonical 存在库里（translate_glossaries，key 由
 *  seriesKeyOf(itemId) 推出），`freeze_glossary` 每次都会 load 一遍 prior 再合并。
 *  被清掉的只是这一个 job 桌面上的那份副本——它本来就只是 prior + 本次新增的物化结果。
 *
 *  best-effort（同 stagingSandbox.cleanup 的既有口径）：NAS/SMB 上残留文件句柄会让 rm 失败，
 *  不让清理失败拖垮主流程——清不掉时下面的 ensureWorkspaceLayout 仍会跑，最坏退化成
 *  "带着残留跑"，也就是改动前的行为，不比现状更差。 */
export function resetWorkspace(stagingBase: string, jobId: string): WorkspacePaths {
  const { jobRoot } = workspacePaths(stagingBase, jobId)
  try {
    rmSync(jobRoot, { recursive: true, force: true })
  } catch {
    // best-effort：清不掉就带着残留跑（= 改动前的行为），不阻塞翻译主线
  }
  return ensureWorkspaceLayout(stagingBase, jobId)
}

/** 成功收工后回收整个工作台目录（`.subtitle-translate/<jobId>/`）。
 *
 *  2026-08-08 live test 实测缺陷：翻译成功、`sub_status` 已闭环到 covered，而工作台
 *  （canonical/ + agent_view/ + context/ + glossary/FROZEN + out/target.srt，312KB）仍留在
 *  媒体目录里。字幕流早有同一条契约（findSubtitleWorker 的 finally 里 `cleanup(...)`，
 *  stagingSandbox 头注原话"job 结束(无论成败)整个沙盒目录被删除"），翻译流一直缺实现——
 *  唯一兜底是 gcOrphans，而它**只在 daemon boot 跑一次**：长期不重启的 daemon 每翻一集就
 *  永久留一个工作台。
 *
 *  **只删 `<jobId>/` 这一层，绝不动同级的 `.ignore`**：那个标记是 `.subtitle-translate/` 一级、
 *  跨 job 共用的媒体服务器屏蔽文件（Jellyfin 双保险）。跟着单个 job 一起删掉的话，下一个 job
 *  又要重建它，而中间窗口里 Jellyfin 会扫到半成品 srt。也**绝不动**刚装好的 sidecar——
 *  那已经 rename 进视频自己的目录，与工作台不在同一棵树下。
 *
 *  同样 best-effort：清理失败不许反噬一次已经成功的翻译（那 312KB 顶多等下次 boot GC）。
 *  返回是否真的删掉了，供调用方记日志——静默失败会让"每集残留一个工作台"再次隐形。 */
export function cleanupWorkspace(stagingBase: string, jobId: string): boolean {
  const { jobRoot } = workspacePaths(stagingBase, jobId)
  try {
    rmSync(jobRoot, { recursive: true, force: true })
    return !existsSync(jobRoot)
  } catch {
    return false
  }
}
