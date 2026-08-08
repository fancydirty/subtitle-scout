// src/cli/watchStartupWarnings.ts：watch 启动告警的纯逻辑层（index.ts 顶层有 import-time 副作用，
// 没法给它单独写单测——把纯逻辑抽出来是唯一能 TDD 覆盖这段文案的办法，同 dashboardTokenWarning.ts 先例）。

/** 零守备目录告警（DB media_roots 为空，MEDIA_ROOTS 首启种子也为空）。 */
export function zeroRootsWarningLine(): string {
  return '[watch] no media roots configured（DB media_roots 为空，MEDIA_ROOTS 首启种子也为空）— subtitle writes are not root-restricted; 去 dashboard 加一个守备目录，或设 MEDIA_ROOTS 作首启种子'
}

/** 存量嵌套守备目录告警（D7 附加，2026-08-08）。
 *
 *  闸门只挡新增；库里闸门上线前配好的嵌套根，程序不擅自删（那是用户的配置意图），
 *  但必须点名报出来——每一对嵌套都会让删除逻辑按守备目录比对差集时，把内层根的行
 *  当成"消失的文件"清掉（C29）。
 *
 *  文案要给出**可执行的下一步**（去 dashboard 删掉其中一个），否则用户看见警告
 *  也不知道该做什么。 */
export function existingNestedRootsWarning(
  pairs: ReadonlyArray<{ root: string; nested: string }>,
): string | null {
  if (pairs.length === 0) return null
  const list = pairs.map((p) => `${p.root} 套着 ${p.nested}`).join('；')
  return `[watch] ⚠️ 检测到 ${pairs.length} 对嵌套的守备目录：${list}。`
    + '嵌套根会让扫描重复走同一批文件；且删除逻辑按守备目录逐个比对差集，'
    + '内层根的记录会被当成"消失的文件"清掉。请去 dashboard 设置页删掉其中一个。'
}

/** MEDIA_ROOTS 种子里某条被闸门跳过（D7，2026-08-08）。
 *
 *  为什么必须告警：env 顺序静默决定守备范围（先写的赢）。运维配了 3 个根却只生效 2 个时，
 *  没有这行日志就只能靠猜。文案要说清"跳了谁、为什么"。
 *
 *  两种原因（审校 F6）：
 *   · nested       —— 嵌套根会让扫描重复走同一批文件，且删除逻辑按守备目录逐个比对差集，
 *                     子根的行会被当成"消失的文件"清掉（C29）
 *   · not-absolute —— 相对路径若 resolve() 会静默落成 <cwd>/... （容器里 = /app/...），
 *                     守备目录跑到哪运维完全看不出。宁可拒绝也不要猜。 */
export function nestedRootSkipWarning(
  rejection:
    | { path: string; reason: 'nested'; conflict: { root: string; relation: 'parent' | 'child' } }
    | { path: string; reason: 'not-absolute' },
): string {
  if (rejection.reason === 'not-absolute') {
    return `[watch] ⚠️ MEDIA_ROOTS 跳过 ${rejection.path}——不是绝对路径。`
      + '相对路径会被解析成进程工作目录下的路径（容器里通常是 /app/...），'
      + '守备范围会跑到你想不到的地方。请写完整的绝对路径。'
  }
  const dir = rejection.conflict.relation === 'child' ? '它是后者的子目录' : '它包含后者'
  return `[watch] ⚠️ MEDIA_ROOTS 跳过 ${rejection.path}——与守备目录 ${rejection.conflict.root} 嵌套（${dir}）。`
    + '嵌套根会让扫描重复走同一批文件；且删除逻辑按守备目录逐个比对差集，'
    + '子根的行会被当成"消失的文件"清掉。只保留其中一个。'
}

/** env/DB roots 不一致告警：MEDIA_ROOTS 只在首启播种一次，之后改 env 不生效，真正的守备目录在 DB。
 *  env 为空时不告警（清空 env 是合法操作，DB 是唯一真相）。 */
export function rootsMismatchWarningLine(envRoots: string[], dbRoots: string[]): string | null {
  if (envRoots.length === 0) return null
  const envSet = new Set(envRoots)
  const dbSet = new Set(dbRoots)
  const mismatch = envRoots.length !== dbRoots.length || ![...envSet].every(r => dbSet.has(r))
  if (!mismatch) return null
  return `[watch] ⚠️ MEDIA_ROOTS env (${envRoots.join(',')}) 与当前生效的守备目录 (${dbRoots.join(',')}) 不一致——以 dashboard 设置页为准（env 仅首启种子）`
}

/** 零字幕源告警：所有找字幕任务都会落空（配置缺失的故障和真实的"没找到"在 UI 上不可区分）。 */
export function zeroSubtitleSourcesWarningLine(env: {
  ASSRT_TOKEN?: string
  OPENSUBTITLES_API_KEY?: string
  OPENSUBTITLES_USERNAME?: string
  OPENSUBTITLES_PASSWORD?: string
  ZIMUKU_ENABLED?: string
  SUBHD_ENABLED?: string
  JIMAKU_API_KEY?: string
}): string | null {
  const hasAssrt = !!env.ASSRT_TOKEN
  const hasOpensubtitles = !!(env.OPENSUBTITLES_API_KEY && env.OPENSUBTITLES_USERNAME && env.OPENSUBTITLES_PASSWORD)
  const hasZimuku = env.ZIMUKU_ENABLED === 'true'
  const hasSubhd = env.SUBHD_ENABLED === 'true'
  const hasJimaku = !!env.JIMAKU_API_KEY
  if (hasAssrt || hasOpensubtitles || hasZimuku || hasSubhd || hasJimaku) return null
  return '[watch] ⚠️ 没有任何字幕源可用——所有找字幕任务都会落空。请至少配置 ASSRT_TOKEN（或启用其他字幕源）'
}

/** setup 模式警告（spec A §4.7 步 2）：零 key 首启时 dashboard 已起、引擎闸全关，指路 wizard——
 *  进程不 exit，这行是用户能在日志里找到的唯一路标。 */
export function setupModeWarningLine(): string {
  return '[watch] SETUP MODE: TMDB and LLM are not configured — dashboard is up, finish the setup wizard there; engine stays gated (no scanning, no dispatch) until both are configured'
}
