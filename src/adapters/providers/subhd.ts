import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, unlinkSync } from 'node:fs'
import { findNextTag } from './htmlAttrs.js'
import { JitteredIntervalLimiter, type RandomFn } from './jitter.js'

// subhd 字幕源客户端。真实链路（curl 实测 2026-07-20，见 __fixtures__/subhd/STRUCTURE.md）：
//   search: GET /search/<q> → 搜索页 HTML（cards）
//   resolve: POST /api/sub/prepare-download → tk cookie → GET /down/<id>(激活) →
//            POST /api/sub/down → CDN 文件 url（credentials omit，下载层 undici 直取）
// 无验证码、无云锁挑战、无 session store——比 zimuku 简单一半。

export interface SubhdSearchResult {
  /** /a/<base62> 的 id 段——同时是 prepare-download/api-sub-down 的 sid */
  id: string
  /** 发布名（view-text 里的长文件名）；缺 → null */
  videoName: string | null
  /** 语言徽章文本，多语用 '/' 连接（简体/繁体/繁中/双语/英语…）；缺 → null */
  language: string | null
  /** 格式徽章：SRT/ASS/SUP…；缺 → null */
  subtype: string | null
  /** 来源徽章：转载精修/官方字幕…；缺 → null */
  releaseSite: string | null
}

const A_HREF_ID_RE = /^\/a\/([A-Za-z0-9]+)$/

/** step 2：解析 POST /api/sub/prepare-download 的响应体 `{success:true,url:"/down/<id>"}`，返回
 *  `/down/<id>` 相对路径。success!==true 或缺 url → 抛（携带前 200 字节便于诊断）。 */
export function parsePrepareDownload(body: string): string {
  const d = JSON.parse(body) as { success?: boolean; url?: string }
  if (d.success !== true || typeof d.url !== 'string' || !d.url) {
    throw new Error(`subhd prepare-download failed: ${body.slice(0, 200)}`)
  }
  return d.url
}

/** step 4：解析 POST /api/sub/down 的响应体 `{success:true,pass:true,url:"https://dlus…"}`，返回真
 *  CDN 文件 url。success!==true / 缺 url → 携带站点 msg（如"时间过长本临时页面已经失效"）抛。 */
export function parseApiSubDown(body: string): string {
  const d = JSON.parse(body) as { success?: boolean; pass?: boolean; url?: string | null; msg?: string }
  if (d.success !== true || typeof d.url !== 'string' || !d.url) {
    throw new Error(`subhd api/sub/down failed: ${d.msg ?? body.slice(0, 200)}`)
  }
  return d.url
}

/** 从 Set-Cookie 行数组里提出首个匹配 `<prefix>…=<value>` 的 cookie 段（`;` 前），可直接拼进
 *  Cookie 头。无则 null。 */
export function extractCookie(setCookies: string[], prefix: string): string | null {
  const re = new RegExp(`(${prefix}[^=\\s]*=[^;\\s]+)`)
  for (const c of setCookies) {
    const m = re.exec(c)
    if (m) return m[1]
  }
  return null
}

/** 提取 `tk_…=…`——prepare-download 下发的 5 分钟临时下载令牌（Max-Age=300，path=/）。 */
export function extractTkCookie(setCookies: string[]): string | null {
  return extractCookie(setCookies, 'tk_')
}

/** 轻量 HTML 数字/命名实体解码——发布名里出现 `I&#39;ll` 之类（htmlAttrs 本身不解码实体）。
 *  只覆盖字幕站发布名里实际见过的几种，够用就好。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}

interface Anchor { id: string; start: number; textStart: number; textEnd: number }

/** 收集页面里所有 `<a href="/a/<id>">` 锚点（href 恰为 /a/<base62>，海报的 /d/<num> 不匹配）。
 *  用 htmlAttrs.findNextTag 两步解析（先定位标签边界再按属性名读 href），对属性顺序/单双引号免疫。 */
function collectAnchors(html: string): Anchor[] {
  const anchors: Anchor[] = []
  let idx = 0
  for (;;) {
    const tag = findNextTag(html, 'a', idx)
    if (!tag) break
    const m = tag.attrs.href ? A_HREF_ID_RE.exec(tag.attrs.href) : null
    if (m) {
      const close = html.indexOf('</a>', tag.end)
      if (close !== -1) anchors.push({ id: m[1], start: tag.start, textStart: tag.end, textEnd: close })
    }
    idx = tag.end
  }
  return anchors
}

/** 在卡片切片内按 span 的 class 抽字段——语言(fw-bold)/格式(p-1+text-secondary)/来源(text-white)。
 *  同样走 findNextTag，只依赖 class 里的稳定 token，不绑属性顺序。 */
function spansByClass(slice: string, ...classTokens: string[]): string[] {
  const out: string[] = []
  let idx = 0
  for (;;) {
    const tag = findNextTag(slice, 'span', idx)
    if (!tag) break
    const cls = tag.attrs.class ?? ''
    if (classTokens.every(t => cls.split(/\s+/).includes(t))) {
      const close = slice.indexOf('</span>', tag.end)
      if (close !== -1) {
        const text = stripTags(slice.slice(tag.end, close))
        if (text) out.push(text)
      }
    }
    idx = tag.end
  }
  return out
}

/**
 * 解析 subhd 搜索页 → 候选列表。每张结果卡片承载一个 /a/<id>（在标题链接 + view-text 链接里各出现
 * 一次），卡片切片 = 本卡首锚 → 下一张不同 id 的首锚（徽章行在两锚之后、下一卡之前，故切片含之）。
 * 畸形/缺字段的条目 fail-soft（字段为 null，不整卡丢弃、不整体抛）——同 assrt/zimuku 的纪律。
 * 对着 __fixtures__/subhd/search-the-rig.html 的真实 DOM 写（见 STRUCTURE.md）。
 */
export function parseSearchResults(html: string): SubhdSearchResult[] {
  const anchors = collectAnchors(html)
  if (anchors.length === 0) return []

  // 按连续同 id 分组为卡片；卡片起点 = 该组首锚 start，终点 = 下一组首锚 start（或页尾）。
  const cardStarts: { id: string; anchorIdxs: number[]; start: number }[] = []
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]
    const last = cardStarts[cardStarts.length - 1]
    if (last && last.id === a.id) last.anchorIdxs.push(i)
    else cardStarts.push({ id: a.id, anchorIdxs: [i], start: a.start })
  }

  const results: SubhdSearchResult[] = []
  for (let c = 0; c < cardStarts.length; c++) {
    const card = cardStarts[c]
    const sliceEnd = c + 1 < cardStarts.length ? cardStarts[c + 1].start : html.length
    const slice = html.slice(card.start, sliceEnd)

    // videoName：本卡锚点里最长的文本（view-text 发布名 > 短中文标题）
    let videoName: string | null = null
    for (const ai of card.anchorIdxs) {
      const t = stripTags(html.slice(anchors[ai].textStart, anchors[ai].textEnd))
      if (t && (!videoName || t.length > videoName.length)) videoName = t
    }

    const langs = spansByClass(slice, 'p-1', 'fw-bold')
    const fmts = spansByClass(slice, 'p-1', 'text-secondary')
    const sites = spansByClass(slice, 'text-white')

    results.push({
      id: card.id,
      videoName,
      language: langs.length ? langs.join('/') : null,
      subtype: fmts.length ? fmts[0] : null,
      releaseSite: sites.length ? sites[0] : null,
    })
  }
  return results
}

// ---------- SubhdClient：真 HTTP（curl 兜底）+ 限速 + 镜像 ----------

export const SUBHD_BASE = 'https://subhd.me'
// mint 响应正常 <1s；15s 超时抓真挂死，又不让偶发慢镜像把总预算吃穿（曾用 25s → 冒烟 180s 超时）。
export const SUBHD_TIMEOUT_MS = 15_000
// 礼貌节流（住宅 IP 被封是真实家庭成本）：单元之间 2-5s 随机延迟；恒定周期本身可指纹。
export const DEFAULT_MIN_INTERVAL_MS = 2_000
export const DEFAULT_JITTER_RANGE_MS = 3_000
// prepare→down→api 临时页时间窗很短，失败重试整个单元。subhd 对 mint 端点**限流很紧**（短窗口内
// ~5-6 次即开始对整个 IP 回"已失效"），故重试要克制：base 默认 2 次，靠单元间的 2-5s 限速拉开节奏
// （限流是窗口内速率/量，拉开间隔比多打更有效）。打满多次只会加深限流，不会救回已被限的 IP。
export const DEFAULT_RESOLVE_ATTEMPTS = 2
// 可用镜像（STRUCTURE.md 里站点自报）。主 base 网络不可达时依次兜底。
export const DEFAULT_MIRRORS = ['https://subhd.one', 'https://subhd.top', 'https://subhd.cc']

/** 完整浏览器请求头：UA + 简体中文 Accept-Language。CDN 文件下载也带这份（见 subhdAdapter.resolve）。 */
export const SUBHD_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9',
}

const execFileP = promisify(execFile)

/**
 * 🔴 默认 fetch 实现——shell 到 curl。**Node 的 TLS(JA3) 指纹被 subhd/Cloudflare 在临时页校验上拒**
 * （undici fetch / node:https 均实测 api/sub/down 恒返回"时间过长本临时页面已经失效"，curl 恒"验证通过"，
 * 见 STRUCTURE.md）。故 SubhdClient 的默认 fetchImpl 走 curl；测试注入假 fetch，不碰 curl/真网络。
 * 只处理文本响应（搜索 HTML / mint JSON）；真文件走下载层 undici（CDN 无指纹门）。
 */
export async function curlFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  const method = init?.method ?? 'GET'
  const headers = (init?.headers ?? {}) as Record<string, string>
  const headerFile = join(tmpdir(), `subhd-h-${randomUUID()}`)
  const args = ['-sS', '--max-time', String(Math.ceil(SUBHD_TIMEOUT_MS / 1000)), '-D', headerFile, '-o', '-']
  // User-Agent→-A、Cookie→-b（curl 原生标志），其余按插入顺序 -H——这样 curl 组装出的 wire 头顺序
  // 与人肉实测通过的 flow2（`curl -A UA -b tk -H Referer -H X-Requested-With -H Origin -H Content-Type`）
  // 逐字节一致。临时页校验对请求形状敏感（Node fetch/自定义头序均被拒），必须复刻 flow2。
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase()
    if (lk === 'user-agent') args.push('-A', v)
    else if (lk === 'cookie') args.push('-b', v)
    else args.push('-H', `${k}: ${v}`)
  }
  if (method !== 'GET') args.push('-X', method)
  if (init?.body != null) args.push('--data', String(init.body))
  args.push(url)
  try {
    const { stdout } = await execFileP('curl', args, { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 })
    const headerText = readFileSync(headerFile, 'utf8')
    // 多段头（重定向/100-continue）取最后一段的状态行
    const status = Number([...headerText.matchAll(/HTTP\/[\d.]+ (\d+)/g)].pop()?.[1] ?? 0)
    const h = new Headers()
    for (const line of headerText.split(/\r?\n/)) {
      const i = line.indexOf(':')
      if (i <= 0) continue
      const name = line.slice(0, i).trim()
      const val = line.slice(i + 1).trim()
      if (!name) continue
      try { h.append(name, val) } catch { /* skip malformed header line */ }
    }
    return new Response(stdout as unknown as BodyInit, { status: status || 200, headers: h })
  } finally {
    try { unlinkSync(headerFile) } catch { /* header temp already gone */ }
  }
}

export interface RequestLimiter { wait(): Promise<void> }

export interface SubhdClientOpts {
  baseUrl?: string
  mirrors?: string[]
  fetchImpl?: typeof fetch
  limiter?: RequestLimiter
  rng?: RandomFn
  resolveAttempts?: number
  onApiCall?: (r: { endpoint: string; status: number | null; durationMs: number; error?: string }) => void
}

function getSetCookies(res: Response): string[] {
  const g = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie
  if (typeof g === 'function') return g.call(res.headers)
  const one = res.headers.get('set-cookie')
  return one ? [one] : []
}

export class SubhdClient {
  private base: string
  private mirrors: string[]
  private fetchImpl: typeof fetch
  private limiter: RequestLimiter
  private resolveAttempts: number

  constructor(private opts: SubhdClientOpts = {}) {
    this.base = (opts.baseUrl ?? SUBHD_BASE).replace(/\/+$/, '')
    this.mirrors = (opts.mirrors ?? DEFAULT_MIRRORS).map(m => m.replace(/\/+$/, ''))
    this.fetchImpl = opts.fetchImpl ?? curlFetch
    this.limiter = opts.limiter ?? new JitteredIntervalLimiter(DEFAULT_MIN_INTERVAL_MS, DEFAULT_JITTER_RANGE_MS, opts.rng)
    this.resolveAttempts = opts.resolveAttempts ?? DEFAULT_RESOLVE_ATTEMPTS
  }

  private hosts(): string[] { return [this.base, ...this.mirrors] }

  /** 对某一 host 发一次请求（不含限速/镜像切换，由调用方掌控节奏）。返回 {status, body, setCookies}。
   *  POST 自动带 Content-Type/Origin/X-Requested-With（api 端点的固定契约）。 */
  private async doRequest(
    host: string, path: string,
    init: { method?: string; body?: string; cookie?: string; referer?: string } = {},
  ): Promise<{ status: number; body: string; setCookies: string[] }> {
    const method = init.method ?? 'GET'
    // 头顺序/头集刻意复刻人肉实测通过的 flow2（curlFetch 把 UA→-A、Cookie→-b）：UA, Referer,
    // [POST: X-Requested-With, Origin, Content-Type], Cookie。**不带 Accept-Language**——flow2 无它、
    // 临时页校验对请求形状敏感（多一个头就可能被判"已失效"）。CDN 文件下载另走 SUBHD_HEADERS（含它，无妨）。
    const headers: Record<string, string> = { 'User-Agent': SUBHD_HEADERS['User-Agent'] }
    if (init.referer) headers.Referer = init.referer
    if (method !== 'GET') {
      headers['X-Requested-With'] = 'XMLHttpRequest'
      headers.Origin = host
      headers['Content-Type'] = 'application/json'
    }
    if (init.cookie) headers.Cookie = init.cookie
    const t0 = Date.now()
    try {
      const res = await this.fetchImpl(`${host}${path}`, {
        method, headers,
        ...(init.body != null ? { body: init.body } : {}),
        signal: AbortSignal.timeout(SUBHD_TIMEOUT_MS),
      })
      const body = await res.text()
      this.opts.onApiCall?.({ endpoint: path, status: res.status, durationMs: Date.now() - t0 })
      return { status: res.status, body, setCookies: getSetCookies(res) }
    } catch (e) {
      this.opts.onApiCall?.({ endpoint: path, status: null, durationMs: Date.now() - t0, error: String(e) })
      throw e
    }
  }

  /** GET 一个 path，主 base 失败（网络/抛错）→依次试镜像，首个成功即返回。每次前走限速。 */
  private async getFirstOk(path: string): Promise<string> {
    let lastErr: unknown
    for (const host of this.hosts()) {
      await this.limiter.wait()
      try { return (await this.doRequest(host, path)).body } catch (e) { lastErr = e }
    }
    throw lastErr ?? new Error(`subhd all hosts failed: ${path}`)
  }

  async search(query: string): Promise<SubhdSearchResult[]> {
    const html = await this.getFirstOk(`/search/${encodeURIComponent(query)}`)
    return parseSearchResults(html)
  }

  /** 一个 host 上跑完整 prepare→GET /down(激活)→api/sub/down 单元（三步紧连、无限速间隔——临时页
   *  时间窗很短，中间插延迟会必然失效）。返回真 CDN 文件 url；任一步失败即抛。 */
  private async resolveOnce(host: string, id: string): Promise<string> {
    const prep = await this.doRequest(host, '/api/sub/prepare-download', {
      method: 'POST', body: JSON.stringify({ sid: id }), referer: `${host}/a/${id}`,
    })
    parsePrepareDownload(prep.body) // 校验 success；/down/<id> 路径就是 id 本身，无需另存
    const tk = extractTkCookie(prep.setCookies)
    if (!tk) throw new Error('subhd prepare-download returned no tk_ cookie')
    // 🔴 GET /down 不只是"访问一下激活"——它的响应 **Set-Cookie 下发第二个授权 cookie `down_<id>_<hex>`**
    // （path=/api/sub/down、HttpOnly），才是 api/sub/down 的真正凭证。人肉 flow2 用 cookie jar 天然把它
    // 带上；客户端必须显式从 down 响应里取出，连同 tk 一起回传 api——只带 tk 会被判"已失效"（血泪根因）。
    const down = await this.doRequest(host, `/down/${id}`, { cookie: tk, referer: `${host}/a/${id}` })
    const downCookie = extractCookie(down.setCookies, 'down_')
    const apiCookie = [tk, downCookie].filter(Boolean).join('; ')
    const api = await this.doRequest(host, '/api/sub/down', {
      method: 'POST', body: JSON.stringify({ sid: id }), cookie: apiCookie, referer: `${host}/down/${id}`,
    })
    return parseApiSubDown(api.body) // "已失效"/success:false 在此抛
  }

  /** 把候选 id 解析成可下载的 CDN 文件 url。CDN（dlus.subhd.me）无指纹门、credentials omit，故不带
   *  cookie（cookie 恒 null）。单元失败（临时页失效/瞬时网络）重试；每 host 重试 resolveAttempts 次，
   *  耗尽再切镜像。限速只在单元之间（不进单元内，保临时页时间窗）。 */
  async resolveDownload(id: string): Promise<{ url: string; cookie: string | null }> {
    let lastErr: unknown
    // 只打 base，克制重试（限速在单元之间拉开节奏）。不铺镜像——mint 限流是**按 IP** 的，换 host
    // 同 IP 照样"已失效"，只会多烧配额加深限流；镜像仅用于 search 的可达性兜底（getFirstOk）。
    for (let a = 0; a < this.resolveAttempts; a++) {
      await this.limiter.wait()
      try { return { url: await this.resolveOnce(this.base, id), cookie: null } } catch (e) { lastErr = e }
    }
    throw lastErr ?? new Error(`subhd resolveDownload exhausted for ${id}`)
  }
}
