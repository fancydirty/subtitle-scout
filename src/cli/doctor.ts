import { MIGRATIONS } from '../v2/db.js'
import type { MountCapabilities } from '../files/mountCapabilities.js'

export interface DoctorResult {
  name: string
  ok: boolean
  /** 环境不满足前提、检查被跳过（不算失败） */
  skip?: boolean
  detail: string
  hint?: string
}

export async function checkAssrt(assrt: { quota(): Promise<{ status: number; user?: { quota: number } }> }): Promise<DoctorResult> {
  try {
    const q = await assrt.quota()
    if (q.status !== 0) throw new Error(`ASSRT status ${q.status}`)
    return { name: 'assrt', ok: true, detail: `ASSRT token 有效，当前配额余量 ${q.user?.quota ?? '未知'}` }
  } catch (e) {
    return {
      name: 'assrt', ok: false, detail: `配额查询失败：${String(e)}`,
      hint: '检查 ASSRT_TOKEN。注册/获取：https://assrt.net → 登录 → 用户中心复制 API token。',
    }
  }
}

/** OpenSubtitles 是可选 provider（BYO key）：未配置（os 为 null）→ skip，非失败。
 *  已配置 → 用零成本探测（The Matrix 搜索，不耗下载配额）验证 key/网络可用。 */
export async function checkOpenSubtitles(os: { search(): Promise<{ data: unknown[] }> } | null): Promise<DoctorResult> {
  if (!os) {
    return {
      name: 'opensubtitles', ok: true, skip: true,
      detail: '未配置(可选 provider)——在 dashboard 设置页配置 OPENSUBTITLES_API_KEY 启用',
    }
  }
  try {
    const r = await os.search()
    return { name: 'opensubtitles', ok: true, detail: `OpenSubtitles 可用，探测命中 ${r.data.length} 条` }
  } catch (e) {
    return {
      name: 'opensubtitles', ok: false, detail: `搜索失败：${String(e)}`,
      hint: '检查 OPENSUBTITLES_API_KEY。注册 opensubtitles.com 账号 → https://www.opensubtitles.com/en/consumers 建 API consumer。',
    }
  }
}

/** zimuku 是可选 provider(默认关闭——灰色站点,条款风险自担,开关在 dashboard 设置页)。
 *  probe=null(设置页里未开启)→ skip,非失败,规则同 checkOpenSubtitles。已启用时只探测
 *  首页可达性:命中云锁"网站防火墙"中间页是预期健康状态而非失败——运行时自动破解,doctor 不
 *  重复验证码破解链路(那是集成测试/实跑的职责)。 */
export async function checkZimuku(
  probe: { fetchHomepage(): Promise<{ ok: boolean; challenged: boolean }> } | null,
): Promise<DoctorResult> {
  if (!probe) {
    return {
      name: 'zimuku', ok: true, skip: true,
      detail: '未配置(可选 provider,灰色站点条款风险自担)——设 ZIMUKU_ENABLED=true 启用',
    }
  }
  try {
    const r = await probe.fetchHomepage()
    if (!r.ok) throw new Error('homepage did not return HTTP 200')
    return {
      name: 'zimuku', ok: true,
      detail: r.challenged
        ? 'zimuku.org 可达(命中云锁验证页,属预期——运行时会自动破解)'
        : 'zimuku.org 可达,未触发验证页',
    }
  } catch (e) {
    return {
      name: 'zimuku', ok: false, detail: `连接失败:${String(e)}`,
      hint: '检查网络能否直连 zimuku.org(灰色站点,部分网络环境可能被墙或限速);确认 ZIMUKU_ENABLED 拼写正确(区分大小写,值必须是字符串 "true")。',
    }
  }
}

/** spec A §4.5：jimaku 最便宜的鉴权调用——带 key 做一次 search。probe 由调用方组（CLI 真打、
 *  validate 端点带凭据组、测试喂假），本函数只负责结果翻译。 */
export async function checkJimaku(probe: () => Promise<unknown>): Promise<DoctorResult> {
  const name = 'jimaku'
  try {
    await probe()
    return { name, ok: true, detail: '带 key 搜索探测通过' }
  } catch (e) {
    return {
      name, ok: false, detail: `搜索探测失败:${String(e)}`,
      hint: '确认 JIMAKU_API_KEY 正确（jimaku.cc 账号设置里复制）；检查网络能否直连 jimaku.cc。',
    }
  }
}

/** spec A §4.5：subhd 首页可达性（无 key 服务，HTTP 2xx/3xx 即通）。probe 返回状态码——
 *  调用方必须用 curlFetch（subhd.ts:224，Node 原生 fetch 的 TLS 指纹会被 subhd 拒）。 */
export async function checkSubhd(probe: () => Promise<number>): Promise<DoctorResult> {
  const name = 'subhd'
  try {
    const status = await probe()
    if (status >= 200 && status < 400) return { name, ok: true, detail: `首页可达（HTTP ${status}）` }
    return { name, ok: false, detail: `首页返回 HTTP ${status}`, hint: 'subhd.me 可达性异常——检查本机网络/代理。' }
  } catch (e) {
    return { name, ok: false, detail: `首页探测失败:${String(e)}`, hint: '检查本机能否直连 subhd.me（注意必须走 curlFetch，Node fetch 的 TLS 指纹会被拒）。' }
  }
}

/** TMDB 是 watch/reconcile-all 的**硬前置**(识别文件、拉 origin_lang/季表全靠它——缺 key 时
 *  cmdWatch/cmdReconcileAll 直接 requireEnv 崩溃退出)。故它不是可选 provider:cmdDoctor 在缺 key 时
 *  直接推一条 ✗(而非 skip),配了 key 才走这里用零成本搜索探测 key/网络可用。这条检查的存在本身
 *  就是修复"doctor 全绿但 watch 立刻因缺 TMDB_API_KEY 退出"的假信心。 */
export async function checkTmdb(probe: () => Promise<number>): Promise<DoctorResult> {
  try {
    const hits = await probe()
    return { name: 'tmdb', ok: true, detail: `TMDB API key 有效，探测命中 ${hits} 条` }
  } catch (e) {
    return {
      name: 'tmdb', ok: false, detail: `搜索失败：${String(e)}`,
      hint: 'TMDB_API_KEY 无效或网络不通。获取：https://www.themoviedb.org → 账户设置 → API → 复制 API Key(v3 auth)。墙内环境可配 TMDB_PROXY_URL 或 TMDB_BASE_URL 走反代。',
    }
  }
}

/** model 可选：传入时成功行报出接的是哪个模型并给一句档位预期——「LLM 通了」和「LLM 够格」
 *  是两回事，太弱的模型跑多步工具调用不报错、只会自信地编造（表现为识别错却全绿），
 *  doctor 是唯一能在装好当天就把这句话递到用户眼前的位置。 */
export async function checkLlm(minimalChat: () => Promise<string>, model?: string): Promise<DoctorResult> {
  try {
    await minimalChat()
    const modelSuffix = model
      ? `（模型：${model}）。识别质量差时先怀疑模型档位，见 README「模型选择」`
      : ''
    return { name: 'llm', ok: true, detail: `LLM 端点可用，最小对话成功${modelSuffix}` }
  } catch (e) {
    return {
      name: 'llm', ok: false, detail: `调用失败：${String(e)}`,
      hint: 'LLM_BASE_URL、LLM_API_KEY、LLM_MODEL 三个配置必须来自同一个 AI 服务商（比如都用 DeepSeek）。BASE_URL 通常以 /v1 结尾。',
    }
  }
}

/** R2D-11（R2 复审）：source 标注这份 roots 清单从哪来——MEDIA_ROOTS env 只是"首启种子"，
 *  dashboard G4 之后真正生效的守备目录活在 DB media_roots 表（可动态增删，早已不是唯一真源）。
 *  可选、省略时不标注（向后兼容既有调用点/测试文案）——调用方（cmdDoctor）db 文件存在时传
 *  'db'、否则传 'env seed'，让报告诚实回答"你在看的是不是当前真正生效的清单"。 */
export function checkMediaRoots(
  roots: string[], isWritable: (dir: string) => boolean, source?: 'db' | 'env seed',
): DoctorResult {
  const sourceSuffix = source ? `（来源：${source}）` : ''
  if (roots.length === 0) {
    return {
      name: 'media-roots', ok: true, skip: true,
      detail: `MEDIA_ROOTS 未配置，跳过（建议配置写入白名单）${sourceSuffix}`,
    }
  }
  const bad = roots.filter(r => !isWritable(r))
  if (bad.length > 0) {
    return {
      name: 'media-roots', ok: false, detail: `以下根目录不可写：${bad.join(', ')}${sourceSuffix}`,
      hint: '确认挂载不是只读（ro）、容器用户有写权限。只读网盘/WebDAV 挂载无法写入 sidecar 字幕。',
    }
  }
  return { name: 'media-roots', ok: true, detail: `${roots.length} 个媒体根目录全部可写${sourceSuffix}` }
}

export function formatDoctorReport(results: DoctorResult[]): string {
  const lines = results.map(r => {
    const mark = r.skip ? '⊘' : r.ok ? '✓' : '✗'
    const base = `${mark} ${r.name}  ${r.detail}`
    return r.hint && !r.ok ? `${base}\n    ↳ ${r.hint}` : base
  })
  const failed = results.filter(r => !r.ok && !r.skip).length
  lines.push(failed === 0 ? '\n接线检查通过，可以起 watch 了。' : `\n${failed} 项未通过——按上面的提示逐项修复后重跑 doctor。`)
  return lines.join('\n')
}

export function overallOk(results: DoctorResult[]): boolean {
  return results.every(r => r.ok || r.skip)
}

/** v2 数据库检查：能打开且 schema_version 匹配 → ✓；否则 → ✗ 带人话提示 */
export function checkDatabase(open: () => { version: string }): DoctorResult {
  const EXPECTED_VERSION = String(MIGRATIONS.length)  // 与 v2/db.ts MIGRATIONS 数组长度对应，不再手动同步

  try {
    const { version } = open()
    if (version === EXPECTED_VERSION) {
      return { name: 'database', ok: true, detail: `数据库可用，schema 版本 ${version}` }
    }

    // 版本不匹配
    const versionNum = parseInt(version, 10)
    const expectedNum = parseInt(EXPECTED_VERSION, 10)

    if (versionNum < expectedNum) {
      return {
        name: 'database',
        ok: false,
        detail: `数据库版本 ${version}（预期 ${EXPECTED_VERSION}）`,
        hint: '数据库版本过旧，重启 watch 即可自动升级 schema。',
      }
    }

    return {
      name: 'database',
      ok: false,
      detail: `数据库版本 ${version}（预期 ${EXPECTED_VERSION}）`,
      hint: 'CLI 版本过旧，请更新到最新版本。',
    }
  } catch (e) {
    return {
      name: 'database',
      ok: false,
      detail: `打开失败：${String(e)}`,
      hint: '数据库文件损坏或权限不足。若确认无重要数据，可删除 scout.db 重新初始化。',
    }
  }
}

/** v2 卡住任务检查：过租 job 数 0 → ✓；>0 → ✗ 带人话提示 */
export function checkStuckJobs(count: () => number): DoctorResult {
  try {
    const stuckCount = count()
    if (stuckCount === 0) {
      return { name: 'stuck-jobs', ok: true, detail: '无卡住任务' }
    }
    return {
      name: 'stuck-jobs',
      ok: false,
      detail: `有 ${stuckCount} 个任务卡住（lease 过租）`,
      hint: '重启会自动归位；若反复出现请保留日志提 issue。',
    }
  } catch (e) {
    return {
      name: 'stuck-jobs',
      ok: false,
      detail: `检查失败：${String(e)}`,
      hint: '数据库查询出错，先检查 database 项。',
    }
  }
}

/** 给远端探测包一层超时——doctor 面对黑洞端点（连上但永不回包）不能挂死。
 *  finally 清理 setTimeout，避免残留计时器把进程吊着。 */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} 在 ${ms / 1000}s 内无响应`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

/** 挂载能力画像——纯信息性，不作为失败门槛（用户开机自见挂载能力，供 realign 降级阶梯参考）。
 *  单个根的探针崩溃只影响该根的一行（报"探测失败"），绝不炸整个 doctor；
 *  'unknown'（只读/未挂载，没条件探）如实报"未知"，不假装探出了 支持/不支持。 */
export function checkMountCapabilities(
  roots: string[],
  probe: (dir: string) => MountCapabilities,
): DoctorResult {
  if (roots.length === 0) {
    return { name: 'mount-capabilities', ok: true, skip: true, detail: 'MEDIA_ROOTS 未配置，跳过' }
  }
  const fmtCap = (v: boolean | 'unknown', yes: string, no: string): string =>
    v === 'unknown' ? '未知' : v ? yes : no
  const lines = roots.map(r => {
    let c: MountCapabilities
    try {
      c = probe(r)
    } catch (e) {
      return `${r}（探测失败：${String(e)}）`
    }
    return `${r}（硬链接: ${fmtCap(c.hardlink, '支持', '不支持')}, 大小写敏感: ${fmtCap(c.caseSensitive, '是', '否')}, 可写: ${c.writable ? '是' : '否'}）`
  })
  return { name: 'mount-capabilities', ok: true, detail: `挂载能力画像 — ${lines.join('；')}` }
}
