/**
 * 云锁(Yunsuo)WAF 破解模块——zimuku.org 命中的"网站防火墙"中间页处理。与 LLM/zimuku 客户端
 * 解耦:验证码识别通过注入的 solve 回调完成(生产接线用 solveNumericCaptcha,测试注入假实现),
 * 网络请求通过注入的 fetchImpl 完成,全部离线可测。
 *
 * 挑战页特征(实测证据,见 docs/design/2026-07-13-zimuku-provider-design.md):
 * body 含 "YunsuoAutoJump"(JS 跳转函数名)或 "security_verify_img"(验证码图片标记)。
 */

export function detectChallenge(html: string): boolean {
  return /YunsuoAutoJump|security_verify_img/.test(html)
}

export interface YunsuoChallengeForm {
  /** 表单提交的绝对 URL(相对路径已相对 baseUrl 解析) */
  action: string
  /** 表单里除验证码输入框外的所有字段(隐藏 token 等),提交时原样带上 */
  fields: Record<string, string>
  /** 用户输入验证码数字的那个 <input> 的 name 属性 */
  captchaFieldName: string
  /** 验证码图片的绝对 URL */
  imageUrl: string
}

/**
 * 解析挑战页的表单结构:不依赖具体字段名(真实云锁部署的字段名未经实地抓包确认),只依赖
 * 通用 HTML 表单形状——<form action=...>、<input type="hidden" name=... value=...>(原样透传的
 * token)、<input type="text" name=...>(验证码填空框)、<img src=...>(验证码图)。只要挑战页
 * 是标准表单,这份解析就适用,不绑定猜测的具体字段名。
 */
export function parseChallenge(html: string, baseUrl: string): YunsuoChallengeForm {
  const formMatch = html.match(/<form[^>]*action="([^"]+)"/)
  if (!formMatch) throw new Error('yunsuo challenge page has no <form action=...> — unexpected challenge page shape')
  const action = new URL(formMatch[1], baseUrl).toString()

  const fields: Record<string, string> = {}
  const hiddenRe = /<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = hiddenRe.exec(html))) fields[m[1]] = m[2]

  const captchaFieldMatch = html.match(/<input[^>]*type="text"[^>]*name="([^"]+)"/)
  if (!captchaFieldMatch) throw new Error('yunsuo challenge page has no captcha text <input> — unexpected challenge page shape')

  const imgMatch = html.match(/<img[^>]*src="([^"]+)"/)
  if (!imgMatch) throw new Error('yunsuo challenge page has no captcha <img src=...> — unexpected challenge page shape')
  const imageUrl = new URL(imgMatch[1], baseUrl).toString()

  return { action, fields, captchaFieldName: captchaFieldMatch[1], imageUrl }
}
