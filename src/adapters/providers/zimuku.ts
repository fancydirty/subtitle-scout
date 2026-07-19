import { basename } from 'node:path'
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
  const detailHrefRe = /^\/detail\/(\d+)\.html$/
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
  downloadUrl: string
  filename: string
}

/**
 * 详情页解析:抓 id="down" 的下载锚点(社区脚本/实地侦察共同印证的下载按钮标记)。文件名从
 * 下载 URL 的 basename 派生(zimuku 静态文件名通常已含语言/季信息,比详情页标题更适合直接
 * 落盘);解析不出锚点视为页面结构漂移,fail closed 抛错而不是静默返回空。
 *
 * 同 parseSearchResults:用 findNextTag 按属性名读 id/href,不管两者谁先出现、引号是单是双、
 * 中间夹了多少个 class/title 之类的其它属性。
 */
export function parseDetailPage(html: string, baseUrl: string): ZimukuDetailResult {
  let hrefRaw: string | null = null
  let idx = 0
  for (;;) {
    const tag = findNextTag(html, 'a', idx)
    if (!tag) break
    if (tag.attrs.id === 'down' && tag.attrs.href) { hrefRaw = tag.attrs.href; break }
    idx = tag.end
  }
  if (!hrefRaw) throw new Error('zimuku detail page has no download link (id="down") — page shape drift?')
  const downloadUrl = new URL(hrefRaw, baseUrl).toString()
  const filename = basename(new URL(downloadUrl).pathname) || 'subtitle.zip'
  return { downloadUrl, filename }
}

export const ZIMUKU_TIMEOUT_MS = 15_000
// 设计文档要求的礼貌节流:单站串行、请求间 2-5s 随机延迟(不是恒定值——固定周期本身就是可指纹
// 的行为特征)。住宅 IP 被封是真实家庭成本,绝不重试风暴。base 是下限、jitterRange 是上浮空间,
// 即 [DEFAULT_MIN_INTERVAL_MS, DEFAULT_MIN_INTERVAL_MS + DEFAULT_JITTER_RANGE_MS) = [2s, 5s)。
export const DEFAULT_MIN_INTERVAL_MS = 2_000
export const DEFAULT_JITTER_RANGE_MS = 3_000

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

  /** 云锁破反爬 + 礼貌节流的统一入口:search()/detail() 都经过这里。命中挑战页时破解一次、
   *  缓存组合 cookie(security_session_verify + security_session_high_verify)、用它重试恰好一次。 */
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

    await this.limiter.wait()
    const retry = await this.fetchPath(path, cookie)
    if (detectChallenge(retry.html)) {
      this.opts.sessionStore.invalidate()
      throw new ZimukuChallengeError(`still challenged after solving captcha for ${path} — verified cookie rejected`)
    }
    return retry.html
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


