import { findNextTag } from './htmlAttrs.js'
import { JitteredIntervalLimiter, type RandomFn } from './jitter.js'
import { detectChallenge, solveYunsuoChallenge, ZimukuChallengeError } from './yunsuo.js'
import type { ZimukuSessionStore } from './zimukuSession.js'

// apex host,不带 www。2026-07-19 单源大考实弹根因:`www.zimuku.org` 现返回 301 到 apex,但
// nginx 的 Location 拼接坏了——`/search?q=x` 被重写成 `https://zimuku.orgsearch?q=x`(host 与
// path 之间漏了斜杠),Node fetch 默认自动跟随 → getaddrinfo ENOTFOUND `zimuku.orgsearch` → 全站
// 请求静默炸成 "TypeError: fetch failed"。apex 直连正常:`/detail/N.html` 直出 200、`/search` 直出
// 云锁挑战页(detectChallenge 接手)。回归锁见 zimuku.test.ts describe('ZIMUKU_BASE')。
export const ZIMUKU_BASE = 'https://zimuku.org'

export interface ZimukuSearchResult {
  id: string
  title: string
}

/**
 * 搜索结果列表解析:只依赖 /detail/<id>.html 详情页链接这个最稳定的锚点(不绑定具体的
 * class/容器结构——版面改版风险最低的选择,"够用就好",见设计文档)。
 *
 * 两步解析(先用 findNextTag 定位每个 <a> 标签的边界和属性映射,再按 href 过滤、按文本取标题)
 * 而不是单条手搓正则——href 在真实页面里可能不是第一个属性、可能和 class/title 等属性混在一起、
 * 引号可能是单引号,这些都不该让解析直接失配(对抗性评审发现:原正则对属性顺序/引号极度敏感,
 * 手工构造的 fixture 只是恰好长成正则期望的样子,并不能证明解析器扛得住真实版面)。
 */
export function parseSearchResults(html: string): ZimukuSearchResult[] {
  const results: ZimukuSearchResult[] = []
  // 真站(2026-07-19 抓包)的结果 href 是协议相对绝对 URL `//zimuku.org/detail/<id>.html`,不是
  // 路径式 `/detail/<id>.html`。去掉起始锚 `^` 后,前缀允许 `//zimuku.org` / `https://zimuku.org` /
  // 纯 `/`(合成 fixture 仍匹配,向后兼容);末尾锚 `$` 保留,继续拒 `/detailed/`、拒带 query 的 href。
  const detailHrefRe = /\/detail\/(\d+)\.html$/
  let idx = 0
  for (;;) {
    const tag = findNextTag(html, 'a', idx)
    if (!tag) break
    const closeIdx = html.indexOf('</a>', tag.end)
    if (closeIdx === -1) { idx = tag.end; continue }
    const hrefMatch = tag.attrs.href?.match(detailHrefRe)
    if (hrefMatch) {
      const title = html.slice(tag.end, closeIdx).replace(/<[^>]*>/g, '').trim()
      if (title) results.push({ id: hrefMatch[1], title })
    }
    idx = closeIdx + '</a>'.length
  }
  return results
}

export interface ZimukuDetailResult {
  dldUrl: string
}

/**
 * 详情页解析:定位下载锚点。真站(2026-07-19 抓包)的下载按钮是 `<a id="down1" href="/dld/<id>.html">`
 * ——一个间接的高速下载页,不是直链 static URL。**按 href 形状匹配**(`/dld/<数字>.html`)而不是
 * 绑定具体 id 名(真站是 down1、合成页可能是别的;href 形状是版面改版最稳的锚点)。返回相对 baseUrl
 * 解析后的绝对 dld URL(filename 不再在此派生——真实链路的文件名由下载层的 Content-Disposition
 * 或候选 title 提供)。解析不出锚点视为页面结构漂移,fail closed 抛错而不是静默返回空。
 *
 * 同 parseSearchResults:用 findNextTag 按属性名读 href,不管 id/href 谁先出现、引号是单是双。
 */
export function parseDetailPage(html: string, baseUrl: string): ZimukuDetailResult {
  const dldHrefRe = /\/dld\/\d+\.html/
  let hrefRaw: string | null = null
  let idx = 0
  for (;;) {
    const tag = findNextTag(html, 'a', idx)
    if (!tag) break
    if (tag.attrs.href && dldHrefRe.test(tag.attrs.href)) { hrefRaw = tag.attrs.href; break }
    idx = tag.end
  }
  if (!hrefRaw) throw new Error('zimuku detail page has no /dld download link — page shape drift?')
  return { dldUrl: new URL(hrefRaw, baseUrl).toString() }
}

export interface ZimukuDldResult {
  mirrorUrls: string[]
}

/**
 * dld(高速下载页)解析:抓所有镜像下载链接 `<a href="/download/<base64token>/svr/<mirror>">`
 * (mirror ∈ {d0,d1,l0,l1,y0,...},电信/联通/移动多线路)。相对 baseUrl 解析成绝对 URL 数组,
 * 保序(调用方默认取首个)。base64 token 内嵌时限时间戳,故下载须紧接 dld 之后。全无镜像 → 抛错
 * (页面结构漂移),沿用 parseDetailPage 的 fail-closed 纪律。
 *
 * 同上:用 findNextTag 按属性名读 href,只依赖 href 形状(/download/.../svr/X),不绑 class/容器。
 */
export function parseDldPage(html: string, baseUrl: string): ZimukuDldResult {
  const mirrorHrefRe = /\/download\/[^"]+\/svr\/\w+/
  const mirrorUrls: string[] = []
  let idx = 0
  for (;;) {
    const tag = findNextTag(html, 'a', idx)
    if (!tag) break
    if (tag.attrs.href && mirrorHrefRe.test(tag.attrs.href)) {
      mirrorUrls.push(new URL(tag.attrs.href, baseUrl).toString())
    }
    idx = tag.end
  }
  if (mirrorUrls.length === 0) {
    throw new Error('zimuku dld page has no /download/.../svr mirror links — page shape drift?')
  }
  return { mirrorUrls }
}

export const ZIMUKU_TIMEOUT_MS = 15_000
// 设计文档要求的礼貌节流:单站串行、请求间 2-5s 随机延迟(不是恒定值——固定周期本身就是可指纹
// 的行为特征)。住宅 IP 被封是真实家庭成本,绝不重试风暴。base 是下限、jitterRange 是上浮空间,
// 即 [DEFAULT_MIN_INTERVAL_MS, DEFAULT_MIN_INTERVAL_MS + DEFAULT_JITTER_RANGE_MS) = [2s, 5s)。
export const DEFAULT_MIN_INTERVAL_MS = 2_000
export const DEFAULT_JITTER_RANGE_MS = 3_000
// 破解成功后用 verify+high 组合 cookie 拉内容的有界重试次数——云锁验证会话跨后端节点存在
// 传播/非确定性识别窗口(2026-07-19 实测:同一有效 cookie 对前脚被拒后脚放行)。每次带礼貌限速。
export const CONTENT_VERIFY_ATTEMPTS = 4

/** 完整浏览器请求头:UA + 简体中文 Accept-Language + Referer——zimuku 对无头 HTTP 客户端的
 *  第一道防线就是这三样缺一漏出马脚。同一份头也要用在归档下载请求上(见 zimukuAdapter.ts 的
 *  resolve() 返回的 headers 字段),因为 resolveDownload 跨 CLI 子进程边界,下载本身发生在
 *  主进程的 downloadDirect() 里——必须把头随 URL 一起带出去,不能指望下载侧凭空知道。 */
export const ZIMUKU_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Referer': `${ZIMUKU_BASE}/`,
}

/** limiter 的最小结构化接口——MinIntervalLimiter(assrt.ts,恒定间隔)和 JitteredIntervalLimiter
 *  (jitter.ts,随机间隔,本客户端的默认值)都满足,测试里可以互换传入(比如想要恒定的极短
 *  间隔时传 MinIntervalLimiter,不用为此单独适配)。 */
export interface RequestLimiter {
  wait(): Promise<void>
}

export interface ZimukuClientOpts {
  fetchImpl?: typeof fetch
  limiter?: RequestLimiter
  /** 注入的随机数源(默认 Math.random)——驱动请求间隔抖动和验证码重试间隔抖动,测试用确定性桩
   *  替换以便断言延迟落在 [min, max) 区间且逐次变化,而不必对真实随机性取样断言分布。 */
  rng?: RandomFn
  sessionStore: ZimukuSessionStore
  /** 验证码识别回调——生产接线用 solveNumericCaptcha(llm, png),客户端本身不依赖 LLM */
  solve: (imageBytes: Buffer) => Promise<{ digits: string }>
  maxCaptchaAttempts?: number
  onApiCall?: (r: { endpoint: string; status: number | null; durationMs: number; error?: string }) => void
}

export class ZimukuClient {
  private fetchImpl: typeof fetch
  private limiter: RequestLimiter

  constructor(private opts: ZimukuClientOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.limiter = opts.limiter ?? new JitteredIntervalLimiter(DEFAULT_MIN_INTERVAL_MS, DEFAULT_JITTER_RANGE_MS, opts.rng)
  }

  /** 发一次请求并返回 { html, challengeCookie }——challengeCookie 是从响应 Set-Cookie 提取的
   *  pending `security_session_verify` **值**(无则 null)。命中挑战页时,这个 pending 会话
   *  cookie 必须回带给验证码提交,才能让 WAF 把答案绑到会话(见 yunsuo.ts submitChallenge)。 */
  private async fetchPath(path: string, cookie?: string): Promise<{ html: string; challengeCookie: string | null }> {
    const t0 = Date.now()
    const headers: Record<string, string> = { ...ZIMUKU_HEADERS, ...(cookie ? { Cookie: cookie } : {}) }
    try {
      const res = await this.fetchImpl(`${ZIMUKU_BASE}${path}`, {
        headers, signal: AbortSignal.timeout(ZIMUKU_TIMEOUT_MS),
      })
      const html = await res.text()
      this.opts.onApiCall?.({ endpoint: path, status: res.status, durationMs: Date.now() - t0 })
      const raw = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie') ?? '']
      let challengeCookie: string | null = null
      for (const line of raw) {
        const m = line.match(/security_session_verify=([^;]+)/)
        if (m) { challengeCookie = m[1]; break }
      }
      return { html, challengeCookie }
    } catch (e) {
      this.opts.onApiCall?.({ endpoint: path, status: null, durationMs: Date.now() - t0, error: String(e) })
      throw e
    }
  }

  /** 用(已验证)组合 cookie 拉内容,命中挑战则有界重试——云锁验证会话刚签发时未必被每个后端
   *  节点立刻识别(2026-07-19 实测铁证:同一对 verify+high cookie 前脚一个请求被判挑战、隔几秒
   *  另一个请求就放行真内容;去掉 srcurl 后 verify+high 本身是跨连接可复用的正确会话)。故内容
   *  请求有界重试 CONTENT_VERIFY_ATTEMPTS 次(每次礼貌限速),而不是拿到有效 cookie 却因一次节点
   *  不巧就前功尽弃。全部仍被挑战 → 返回 null,调用方据此判定 cookie 真失效。 */
  private async fetchContentWithVerifiedCookie(path: string, cookie: string): Promise<string | null> {
    for (let i = 0; i < CONTENT_VERIFY_ATTEMPTS; i++) {
      await this.limiter.wait()
      const res = await this.fetchPath(path, cookie)
      if (!detectChallenge(res.html)) return res.html
    }
    return null
  }

  /** 云锁破反爬 + 礼貌节流的统一入口:search()/detail() 都经过这里。先探一次(带缓存 cookie);
   *  命中挑战页则破解、缓存组合 cookie(security_session_verify + security_session_high_verify,
   *  不含 srcurl——srcurl 只用于提交步,内容步带上反而被 WAF 判为仍在挑战流程),用它有界重试内容。 */
  private async requestHtml(path: string): Promise<string> {
    await this.limiter.wait()
    const cached = this.opts.sessionStore.get()
    const first = await this.fetchPath(path, cached?.cookie)
    if (!detectChallenge(first.html)) return first.html

    // 命中挑战:缓存的 cookie(若有)已经失效——按响应失效检测,不按计时(设计文档)
    this.opts.sessionStore.invalidate()
    const href = `${ZIMUKU_BASE}${path}`
    const { cookie } = await solveYunsuoChallenge(
      {
        fetchImpl: this.fetchImpl,
        solve: this.opts.solve,
        // 每次尝试重抓新鲜挑战页(拿新图 + 配套的新 pending cookie)——redirect 形状答错后服务端
        // 会轮换 pending 会话,复用同一张图无意义。礼貌限速在每次重抓前。第一次 fetchChallenge 会
        // 再打一次挑战页(首发已消耗一次),这是可接受的——保证每次尝试都有配套的新鲜 pending cookie。
        fetchChallenge: async () => {
          await this.limiter.wait()
          const c = await this.fetchPath(path)
          return { html: c.html, pendingCookie: c.challengeCookie }
        },
      },
      ZIMUKU_BASE, href, this.opts.maxCaptchaAttempts ?? 5,
      DEFAULT_MIN_INTERVAL_MS, DEFAULT_JITTER_RANGE_MS, this.opts.rng,
    )
    this.opts.sessionStore.put({ cookie, capturedAt: Date.now() })

    const html = await this.fetchContentWithVerifiedCookie(path, cookie)
    if (html !== null) return html
    this.opts.sessionStore.invalidate()
    throw new ZimukuChallengeError(`still challenged after solving captcha for ${path} — verified cookie rejected across ${CONTENT_VERIFY_ATTEMPTS} attempts`)
  }

  async search(query: string): Promise<ZimukuSearchResult[]> {
    const html = await this.requestHtml(`/search?q=${encodeURIComponent(query)}`)
    return parseSearchResults(html)
  }

  async detail(id: string): Promise<ZimukuDetailResult> {
    const html = await this.requestHtml(`/detail/${id}.html`)
    return parseDetailPage(html, ZIMUKU_BASE)
  }
}


