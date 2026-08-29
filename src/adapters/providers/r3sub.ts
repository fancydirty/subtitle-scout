import { findNextTag } from './htmlAttrs.js'
import type { R3subSessionStore } from './r3subSession.js'

/** r3sub 站点客户端。登录由 Vanilla 论坛（forum.r3sub.com）承担，成功后主站共享域 cookie。
 *  下载走两跳（download.php 中转页 → jpdown1.php 取 zip），见 spec §1.1。
 *  凭据走 DB secret（R3SUB_EMAIL/R3SUB_PASSWORD），绝不 env。 */

const FORUM_SIGNIN_URL = 'https://forum.r3sub.com/entry/signin'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

/** 登录成功的判据 cookie——收到 R3_Vid（会员数字 id）即视为已登录（匿名页从不下发）。 */
const LOGGED_IN_COOKIE_MARKER = 'R3_Vid'

export interface R3subClientOptions {
  email: string
  password: string
  sessionStore: R3subSessionStore
  fetchImpl?: typeof fetch
  onApiCall?: (r: { endpoint: string; status: number | null; durationMs: number; error?: string }) => void
}

/** 从 Vanilla 登录页抠隐藏域（TransientKey CSRF、hpt 蜜罐留空、Target、ClientHour）。
 *  页面有登录/注册两个同名表单，取先出现的登录表单那一组即可（findNextTag 顺序扫描）。 */
export function parseSigninForm(html: string): Record<string, string> {
  const wanted = new Set(['TransientKey', 'hpt', 'Target', 'ClientHour'])
  const out: Record<string, string> = {}
  let i = 0
  while (Object.keys(out).length < wanted.size) {
    const tag = findNextTag(html, 'input', i)
    if (!tag) break
    i = tag.end
    const name = tag.attrs.name
    if (name && wanted.has(name) && !(name in out)) {
      out[name] = tag.attrs.value ?? ''
    }
  }
  return out
}

/** 一条搜索结果（一部影视 + 其一份字幕上传的元信息）。 */
export interface R3subSearchRow {
  id: string            // show.php?id= 的值，作 providerId
  titleCn: string       // 中文题名
  titleEn: string       // 英文题名（不含年份）
  year: number | null
  source: string        // 来源标签，如 'iTunes官方'/'其他'（iTunes官方=强质量信号）
  langMark: string      // 语言标记拼接，如 '繁 簡 英'
  subtype: string       // SRT/SUP（可能为空）
  sizeText: string      // 如 '111KB'
  downloads: number     // 下载次数
}

/** 解析搜索结果页。每行是 `<div class="movie movie--preview ...">`，按 movie__title 锚点切行。 */
export function parseSearch(html: string): R3subSearchRow[] {
  const rows: R3subSearchRow[] = []
  // 用 movie__title 锚点定位每行起点（class 顺序稳定；用其 href 抠 id、锚文本抠中文名）。
  const titleRe = /<a href="show\.php\?id=([A-Za-z0-9]+)"[^>]*class="movie__title[^"]*"[^>]*>([^<]*)<\/a>/g
  let m: RegExpExecArray | null
  const anchors: { id: string; titleCn: string; at: number }[] = []
  while ((m = titleRe.exec(html))) anchors.push({ id: m[1], titleCn: decodeEntities(m[2].trim()), at: m.index })
  for (let k = 0; k < anchors.length; k++) {
    const seg = html.slice(anchors[k].at, anchors[k + 1]?.at ?? html.length)
    const opt = /<p class="movie__option[^"]*">([^<]*)<\/p>/.exec(seg)
    const optText = opt ? opt[1].trim() : ''
    const ym = /^(.*?)\s*\((\d{4})\)\s*$/.exec(optText)
    const titleEn = ym ? ym[1].trim() : optText
    const year = ym ? Number(ym[2]) : null
    const source = (/<span class="btn-text btn--danger">([^<]*)<\/span>/.exec(seg)?.[1] ?? '').trim()
    const langMark = [...seg.matchAll(/<span class="btn-text btn--shine">([^<]*)<\/span>/g)]
      .map(x => x[1].trim()).join(' ')
    const subtype = (/<span class="btn-text[^"]*">(SRT|SUP|ASS|SSA)<\/span>/i.exec(seg)?.[1] ?? '').trim()
    const sizeText = (/fa-hdd-o[^>]*><\/span>\s*([0-9.]+\s*[KMG]B)/i.exec(seg)?.[1] ?? '').trim()
    const downloads = Number(/fa-download[^>]*><\/span>\s*([0-9]+)/i.exec(seg)?.[1] ?? '0')
    rows.push({ id: anchors[k].id, titleCn: anchors[k].titleCn, titleEn, year, source, langMark, subtype, sizeText, downloads })
  }
  return rows
}

export interface R3subShow {
  zipName: string       // download.php 表单 filename，下载第一跳要用
  files: string[]       // 檔案內容里每条字幕文件名（data-fname 权威值）
}

/** 解析详情页：zip 名（download.php 表单 filename 隐藏域）+ 檔案清单（所有 data-fname）。 */
export function parseShow(html: string): R3subShow {
  let zipName = ''
  // download.php 表单里的 filename 隐藏 input。
  let i = 0
  while (true) {
    const tag = findNextTag(html, 'input', i)
    if (!tag) break
    i = tag.end
    if (tag.attrs.name === 'filename' && tag.attrs.value) { zipName = tag.attrs.value; break }
  }
  const files = [...html.matchAll(/data-fname="([^"]+)"/g)].map(x => x[1])
  // 去重（同一文件名可能预览按钮出现多次）
  return { zipName, files: [...new Set(files)] }
}

/** 轻量 HTML 命名/数字实体解码（题名可能含 `&amp;` `&#39;` 等）。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

/** 收集响应的 Set-Cookie，拼成后续请求可直接带的 `k=v; k=v` 串。合并进已有 cookie（新值覆盖同名）。 */
function mergeSetCookies(existing: string, res: Response): string {
  const jar = new Map<string, string>()
  for (const pair of existing.split(';')) {
    const t = pair.trim()
    if (!t) continue
    const eq = t.indexOf('=')
    if (eq > 0) jar.set(t.slice(0, eq), t.slice(eq + 1))
  }
  // undici 的 Headers 支持 getSetCookie()（多值）；退化时用 get('set-cookie') 单串。
  const raw =
    typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (res.headers as { getSetCookie: () => string[] }).getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : [])
  for (const sc of raw) {
    const first = sc.split(';')[0].trim()
    const eq = first.indexOf('=')
    if (eq > 0) jar.set(first.slice(0, eq), first.slice(eq + 1))
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

export class R3subClient {
  private email: string
  private password: string
  private store: R3subSessionStore
  private fetchImpl: typeof fetch
  private onApiCall?: R3subClientOptions['onApiCall']

  constructor(opts: R3subClientOptions) {
    this.email = opts.email
    this.password = opts.password
    this.store = opts.sessionStore
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.onApiCall = opts.onApiCall
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    const started = Date.now()
    try {
      const res = await this.fetchImpl(url, init)
      this.onApiCall?.({ endpoint: url, status: res.status, durationMs: Date.now() - started })
      return res
    } catch (e) {
      this.onApiCall?.({ endpoint: url, status: null, durationMs: Date.now() - started, error: String(e) })
      throw e
    }
  }

  /** 邮箱密码登录 → 跨域 cookie 落 session。失败（密码错/未验证）抛错，不写 session。 */
  async login(): Promise<void> {
    const getRes = await this.call(FORUM_SIGNIN_URL, { headers: { 'User-Agent': UA } })
    const html = await getRes.text()
    const form = parseSigninForm(html)
    let cookie = mergeSetCookies('', getRes)

    const body = new URLSearchParams({
      Email: this.email,
      Password: this.password,
      TransientKey: form.TransientKey ?? '',
      hpt: form.hpt ?? '',
      Target: form.Target ?? '/',
      ClientHour: form.ClientHour ?? '',
      'Sign In': 'Sign In',
    }).toString()

    const postRes = await this.call(FORUM_SIGNIN_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookie,
      },
      body,
      redirect: 'manual',
    })
    cookie = mergeSetCookies(cookie, postRes)

    if (!cookie.includes(LOGGED_IN_COOKIE_MARKER)) {
      throw new Error('r3sub 登录失败：请检查邮箱/密码，并确认已在 r3sub.com 完成邮箱验证')
    }
    this.store.put({ cookie, capturedAt: Date.now() })
  }

  /** 当前 session cookie（无则先登录一次）。搜索/详情/下载消费它。 */
  private async cookie(): Promise<string> {
    const sess = this.store.get()
    if (sess?.cookie.includes(LOGGED_IN_COOKIE_MARKER)) return sess.cookie
    await this.login()
    return this.store.get()!.cookie
  }

  /** 带 session cookie 的 GET；若响应命中登录墙（signin 特征）则重登一次后重试。 */
  private async getWithSession(url: string): Promise<string> {
    const doGet = async (cookie: string) =>
      this.call(url, { headers: { 'User-Agent': UA, Cookie: cookie } })
    let res = await doGet(await this.cookie())
    let html = await res.text()
    if (isLoginWall(html)) {
      this.store.invalidate()
      res = await doGet(await this.cookie())
      html = await res.text()
    }
    return html
  }

  /** 搜索（GET search.php，type=movie）。返回结构化结果行。 */
  async search(query: string): Promise<R3subSearchRow[]> {
    const url = `https://r3sub.com/search.php?s=${encodeURIComponent(query)}&type=movie`
    return parseSearch(await this.getWithSession(url))
  }

  /** 详情（GET show.php?id=）。返回 zip 名 + 檔案清单。 */
  async detail(id: string): Promise<R3subShow> {
    return parseShow(await this.getWithSession(`https://r3sub.com/show.php?id=${encodeURIComponent(id)}`))
  }
}

/** 响应是否是登录墙——download.php 匿名/失效时返回的登录表单页特征。 */
function isLoginWall(html: string): boolean {
  return /Form_User_SignIn|entry\/signin/.test(html) && !/movie__title|檔案內容/.test(html)
}
