/**
 * 云锁(Yunsuo)WAF 破解模块——zimuku.org 命中的"网站防火墙"中间页处理。与 LLM/zimuku 客户端
 * 解耦:验证码识别通过注入的 solve 回调完成(生产接线用 solveNumericCaptcha,测试注入假实现),
 * 网络请求通过注入的 fetchImpl 完成,全部离线可测。
 *
 * 挑战页特征(实测证据,见 docs/design/2026-07-13-zimuku-provider-design.md):
 * body 含 "YunsuoAutoJump"(JS 跳转函数名)或 "security_verify_img"(验证码图片标记)。
 *
 * 挑战页有两种实测形状(见 fixtures/zimuku/challenge.html 与 fixtures/zimuku/real-challenge.html):
 *  1. "form" 形状(早期合成 fixture 假设的形状,保留作向后兼容):标准 <form action=...> +
 *     隐藏 token 字段 + 验证码填空框,POST 提交。
 *  2. "redirect" 形状(2026-07-12 从 zimuku.org 活页面实测抓包确认,真实生产形状):没有
 *     <form>,验证码输入框是 id="intext" 的裸 <input>,验证码图是内嵌 base64 的
 *     <img class="verifyimg" src="data:image/bmp;base64,...">,"提交"是 YunsuoAutoJump()
 *     里的 JS 跳转——`self.location = "/?security_verify_img=" + stringToHex(text)`(GET,
 *     不是表单 POST),跳转前还会设一个 srcurl cookie(hex 编码的当前页面 URL)。
 */

import { findNextTag, type TagMatch } from './htmlAttrs.js'
import { jitteredDelayMs, type RandomFn } from './jitter.js'

export function detectChallenge(html: string): boolean {
  return /YunsuoAutoJump|security_verify_img/.test(html)
}

export interface YunsuoChallengeForm {
  kind: 'form'
  /** 表单提交的绝对 URL(相对路径已相对 baseUrl 解析) */
  action: string
  /** 表单里除验证码输入框外的所有字段(隐藏 token 等),提交时原样带上 */
  fields: Record<string, string>
  /** 用户输入验证码数字的那个 <input> 的 name 属性 */
  captchaFieldName: string
  /** 验证码图片的绝对 URL(或 data: URI——见 resolveImageUrl) */
  imageUrl: string
}

/** 真实 zimuku.org 挑战页的"JS 跳转"提交形状(无 <form>,GET 跳转带 hex 编码验证码数字)。 */
export interface YunsuoChallengeRedirect {
  kind: 'redirect'
  /** GET 跳转提交的 URL 前缀(已相对 baseUrl 解析为绝对 URL),以查询串的 `=` 结尾——
   *  最终提交 URL = submitUrlPrefix + stringToHex(digits),复刻 YunsuoAutoJump() 里的
   *  `self.location = "/?security_verify_img=" + stringToHex(text)`。 */
  submitUrlPrefix: string
  /** 跳转前 YunsuoAutoJump() 会设置的 srcurl cookie 值——hex 编码的"当前页面 URL"。真实浏览器里
   *  是 window.location.href;这里没有真实导航历史,用 baseUrl(挑战发生的站点)作为替身。 */
  srcurlCookieValue: string
  /** 验证码图片的绝对 URL 或 data: URI(真实页面是内嵌 base64 的 data:image/bmp;base64,...)。 */
  imageUrl: string
}

export type YunsuoChallenge = YunsuoChallengeForm | YunsuoChallengeRedirect

const SELF_LOCATION_RE = /self\.location\s*=\s*(["'])([^"']*)\1\s*\+\s*stringToHex\s*\(/

/** 验证码图片 URL 可能是相对/绝对 http(s) URL,也可能是内嵌 base64 的 data: URI(真实页面形状)——
 *  data: URI 已经是"绝对"的,不需要也不应该拿去跑 URL 相对解析(仅为显式、避免任何转义意外)。 */
function resolveImageUrl(src: string, baseUrl: string): string {
  return src.startsWith('data:') ? src : new URL(src, baseUrl).toString()
}

/** 复刻挑战页 JS 里的 stringToHex(str):逐字符转两位十六进制(charCodeAt.toString(16),
 *  不足两位补零)并拼接。用于把验证码数字/srcurl 编码成 GET 跳转形状要求的 hex 串。 */
function stringToHex(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    out += s.charCodeAt(i).toString(16).padStart(2, '0')
  }
  return out
}

/** 从 fromIndex 起顺序扫描同名标签,返回第一个满足 attrName 属性值 predicate 的标签——
 *  用于按 id="intext"/class="verifyimg" 这类属性值定位标签,而不是"下一个同名标签就是它"。 */
function findTagByAttr(
  html: string, tagName: string, attrName: string, predicate: (value: string | undefined) => boolean,
): TagMatch | null {
  let idx = 0
  for (;;) {
    const tag = findNextTag(html, tagName, idx)
    if (!tag) return null
    idx = tag.end
    if (predicate(tag.attrs[attrName])) return tag
  }
}

/**
 * 解析挑战页的表单结构:不依赖具体字段名(真实云锁部署的字段名未经实地抓包确认),只依赖
 * 通用 HTML 表单形状——<form action=...>、<input type="hidden" name=... value=...>(原样透传的
 * token)、<input type="text" name=...>(验证码填空框,type 也可以缺省——HTML5 规范里 <input>
 * 不写 type 时默认就是 text)、<img src=...>(验证码图)。只要挑战页是标准表单,这份解析就适用,
 * 不绑定猜测的具体字段名。
 *
 * 用 findNextTag 按标签属性名读值,而不是手搓"属性必须按这个顺序、必须是双引号"的正则——
 * 对抗性评审发现原正则对 value-before-name、type 放在最后、单引号 action='...' 都会直接失配,
 * 而手工构造的 fixture 只是恰好长成正则期望的样子。
 */
function parseFormChallenge(html: string, baseUrl: string, formTag: TagMatch): YunsuoChallengeForm {
  if (!formTag.attrs.action) {
    throw new Error('yunsuo challenge page has no <form action=...> — unexpected challenge page shape')
  }
  const action = new URL(formTag.attrs.action, baseUrl).toString()

  const fields: Record<string, string> = {}
  let captchaFieldName: string | null = null
  let idx = 0
  for (;;) {
    const tag = findNextTag(html, 'input', idx)
    if (!tag) break
    idx = tag.end
    const { type, name, value } = tag.attrs
    if (type === 'hidden') {
      if (name) fields[name] = value ?? ''
    } else if (captchaFieldName === null && name && (type === undefined || type === 'text')) {
      captchaFieldName = name
    }
  }
  if (captchaFieldName === null) {
    throw new Error('yunsuo challenge page has no captcha text <input> — unexpected challenge page shape')
  }

  const imgTag = findNextTag(html, 'img')
  if (!imgTag?.attrs.src) {
    throw new Error('yunsuo challenge page has no captcha <img src=...> — unexpected challenge page shape')
  }
  const imageUrl = resolveImageUrl(imgTag.attrs.src, baseUrl)

  return { kind: 'form', action, fields, captchaFieldName, imageUrl }
}

/**
 * 解析真实 zimuku.org 挑战页的"JS 跳转"结构(2026-07-12 实测抓包确认,见模块顶部注释):没有
 * <form>,标志是 id="intext" 的验证码 <input> + class="verifyimg" 的验证码 <img>(src 常是
 * data:image/bmp;base64,... 内嵌图)+ YunsuoAutoJump() 里 `self.location = "..." +
 * stringToHex(text)` 这行 JS——从这行提取跳转 URL 前缀,提交时原样拼接 hex 编码的验证码数字。
 */
function parseRedirectChallenge(html: string, baseUrl: string): YunsuoChallengeRedirect {
  const inputTag = findTagByAttr(html, 'input', 'id', v => v === 'intext')
  if (!inputTag) {
    throw new Error(
      'yunsuo challenge page has neither <form action=...> nor id="intext" captcha <input> — unexpected challenge page shape',
    )
  }

  const imgTag = findTagByAttr(html, 'img', 'class', v => (v ?? '').split(/\s+/).includes('verifyimg'))
  if (!imgTag?.attrs.src) {
    throw new Error(
      'yunsuo redirect-challenge page has id="intext" input but no class="verifyimg" captcha <img src=...> — unexpected challenge page shape',
    )
  }

  const m = html.match(SELF_LOCATION_RE)
  if (!m) {
    throw new Error(
      'yunsuo redirect-challenge page has intext input + verifyimg img but no `self.location = "..." + stringToHex(...)` redirect script — unexpected challenge page shape',
    )
  }

  return {
    kind: 'redirect',
    submitUrlPrefix: new URL(m[2], baseUrl).toString(),
    srcurlCookieValue: stringToHex(baseUrl),
    imageUrl: resolveImageUrl(imgTag.attrs.src, baseUrl),
  }
}

/** 解析挑战页——按形状分派(先查 <form>,没有就按真实页面的 JS 跳转形状解析),见模块顶部
 *  注释的两种挑战页形状说明。 */
export function parseChallenge(html: string, baseUrl: string): YunsuoChallenge {
  const formTag = findNextTag(html, 'form')
  if (formTag) return parseFormChallenge(html, baseUrl, formTag)
  return parseRedirectChallenge(html, baseUrl)
}

/** 挑战破解耗尽/仍被拦截:瞬时错误,不是"确实没有字幕"的内容结论——上游 fetchLib.runSearch 的
 *  通用 catch 会把它转成 provider_error（这个信号本是给旧管线 pipeline.ts 的残缺候选集守卫
 *  据此拒写负缓存用的；pipeline.ts 已随旧管线退役删除，今天的消费方——search_source 工具/
 *  cli 日志分支——只把它当失败信号展示，同样不会把瞬时错误误判成"确实没有"）。 */
export class ZimukuChallengeError extends Error {}

function extractCookie(res: Response, name: string): string | null {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') ?? '']
  for (const line of raw) {
    const m = line.match(new RegExp(`${name}=([^;]+)`))
    if (m) return `${name}=${m[1]}`
  }
  return null
}

export interface SolveYunsuoChallengeDeps {
  fetchImpl: typeof fetch
  /** 验证码识别回调——生产接线用 solveNumericCaptcha(llm, png),与 LLM 解耦,测试注入假实现 */
  solve: (imageBytes: Buffer) => Promise<{ digits: string }>
}

/** 抓验证码图片字节:data: URI(真实页面形状)直接从 base64 payload 本地解码,不发网络请求;
 *  普通 http(s) URL(合成 fixture 形状)才走 fetchImpl。 */
async function fetchCaptchaImage(fetchImpl: typeof fetch, imageUrl: string): Promise<Buffer> {
  if (imageUrl.startsWith('data:')) {
    const comma = imageUrl.indexOf(',')
    const base64 = comma === -1 ? '' : imageUrl.slice(comma + 1)
    return Buffer.from(base64, 'base64')
  }
  const res = await fetchImpl(imageUrl)
  return Buffer.from(await res.arrayBuffer())
}

/** 提交识别出的验证码数字——按挑战形状分派:"form" 形状 POST 表单字段(向后兼容合成 fixture);
 *  "redirect" 形状复刻 YunsuoAutoJump() 的 GET 跳转,hex 编码数字拼到 submitUrlPrefix 后面,
 *  并带上跳转前 JS 设置的 srcurl cookie(此处没有真实浏览器 cookie jar,直接当请求头带上)。 */
async function submitChallenge(fetchImpl: typeof fetch, challenge: YunsuoChallenge, digits: string): Promise<Response> {
  if (challenge.kind === 'form') {
    const body = new URLSearchParams({ ...challenge.fields, [challenge.captchaFieldName]: digits })
    return fetchImpl(challenge.action, { method: 'POST', body })
  }
  const submitUrl = challenge.submitUrlPrefix + stringToHex(digits)
  return fetchImpl(submitUrl, { headers: { Cookie: `srcurl=${challenge.srcurlCookieValue}` } })
}

/**
 * 有界重试破解云锁验证码:抓图→识别→提交,拿到 security_session_verify cookie 即成功返回;
 * 提交被拒(cookie 没出现在响应里)则重刷验证码重试,最多 maxAttempts 次(默认 5,与设计文档
 * 一致)。攻击性节流:失败重试之间等待 jitteredDelayMs(retryDelayMs, retryJitterRangeMs, rng)——
 * 默认 jitterRangeMs=0 时就是恒定的 retryDelayMs(向后兼容/测试友好),生产调用方(zimuku.ts)
 * 显式传入非零 jitterRangeMs 以获得随机化的重试节奏,绝不无延迟重试风暴。
 *
 * deps.solve() 本身也被算作"这次尝试失败"而不是让它的异常穿透:LLM 结构化输出校验失败会抛出
 * schema 不匹配的异常,这属于"这次验证码读数拿不到"的瞬时失败,应该跟"提交
 * 被拒"走同一条重刷验证码的有界重试路径,而不是绕过重试直接把内部实现细节的错误类型甩给调用方。
 *
 * 两种挑战形状(见 parseChallenge)在这里透明地分派给 fetchCaptchaImage/submitChallenge——
 * 上层(zimuku.ts)完全不需要知道当次挑战页是哪种形状。
 */
export async function solveYunsuoChallenge(
  deps: SolveYunsuoChallengeDeps, baseUrl: string, challengeHtml: string,
  maxAttempts = 5, retryDelayMs = 2000, retryJitterRangeMs = 0, rng: RandomFn = Math.random,
): Promise<{ cookie: string }> {
  const challenge = parseChallenge(challengeHtml, baseUrl)
  let lastError = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const imgBytes = await fetchCaptchaImage(deps.fetchImpl, challenge.imageUrl)

    let digits: string
    try {
      const solved = await deps.solve(imgBytes)
      digits = solved.digits
    } catch (e) {
      lastError = `attempt ${attempt}: solve() threw: ${e instanceof Error ? e.message : String(e)}`
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, jitteredDelayMs(retryDelayMs, retryJitterRangeMs, rng)))
      }
      continue
    }

    const res = await submitChallenge(deps.fetchImpl, challenge, digits)
    const cookie = extractCookie(res, 'security_session_verify')
    if (cookie) return { cookie }
    lastError = `attempt ${attempt}: no security_session_verify cookie in response (wrong digits?)`
    if (attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, jitteredDelayMs(retryDelayMs, retryJitterRangeMs, rng)))
    }
  }
  throw new ZimukuChallengeError(`yunsuo captcha solve exhausted after ${maxAttempts} attempts: ${lastError}`)
}

