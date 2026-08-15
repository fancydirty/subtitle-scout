// web/src/lib/errorText.ts：后端错误串 → 用户界面文案的最后一英里。
// 审计 P0-7：后端错误契约是英文技术串（{error: 'path is not readable (permission denied?)'}），
// 它们是正确的机器事实，但中文界面直接把英文拼在中文前缀后面。这里只做 zh 映射；
// en 原样返回，且未知错误一律原样返回——绝不为了"好看"吞掉真实原因。
import type { Lang } from '../i18n/useT.js'

type Mapping = [RegExp, string | ((m: RegExpMatchArray) => string)]

const ZH_MAPPINGS: Mapping[] = [
  [/^Failed to fetch$/, '无法连接服务器，请确认服务正在运行。'],
  [/^Invalid credentials$/, '凭据无效'],
  [/^unreachable$/, '无法访问'],
  [/^path is not readable \(permission denied\?\)$/, '目录不可读（权限不足？）'],
  [/^path does not exist$/, '路径不存在'],
  [/^path must be an absolute path$/, '路径必须是绝对路径'],
  [/^path is not a directory$/, '路径不是目录'],
  [/^not a media root$/, '不是守备目录'],
  [/^not found$/, '未找到'],
  [/^db locked$/, '数据库忙，请稍后重试。'],
  [/^invalid JSON body$/, '请求格式错误'],
  [/^payload too large$/, '请求内容过大'],
  [/^method not allowed$/, '请求方法不允许'],
  [/^body must be a JSON object of setting key-value pairs$/, '请求内容格式错误'],
  [/^unknown setting key: (.*)$/, (m) => `未知设置项：${m[1]}`],
  [/^setting (.*) must be a string$/, (m) => `设置项 ${m[1]} 必须为文本`],
  [/^setting (.*): must be a positive integer string$/, (m) => `设置项 ${m[1]} 必须为正整数`],
  [/^path query param is required$/, '缺少路径参数'],
  [/^scan trigger not configured \(watch daemon not running\)$/, '扫描触发未配置（守护进程未运行）'],
  [/^scan trigger not ready \(daemon still starting up\)$/, '扫描触发尚未就绪（守护进程启动中）'],
  [/^event stream not configured \(bus missing\)$/, '实时事件流未配置'],
  [/^tmdb search not configured \(TMDB_API_KEY missing\?\)$/, 'TMDB 搜索未配置（缺少 TMDB_API_KEY）'],
  [/^tmdb search failed$/, 'TMDB 搜索失败'],
  [/^q query param is required$/, '缺少搜索词参数'],
  [/^type must be 'tv' or 'movie'$/, '类型必须是 tv 或 movie'],
  [/^itemId is required$/, '缺少 itemId'],
  [/^itemId query param is required$/, '缺少 itemId 参数'],
  [/^item not found$/, '条目不存在'],
  [/^failed to extract waveform$/, '无法生成音频波形'],
  [/^invalid URL encoding$/, 'URL 编码无效'],
  [/^too many attempts — wait a minute$/, '尝试次数过多，请一分钟后再试。'],
  [/^invalid username or password$/, '用户名或密码不正确。'],
  [/^current password is incorrect$/, '当前密码不正确。'],
  [/^username is required$/, '请输入用户名'],
  [/^password must be at least 10 characters$/, '密码至少需要 10 个字符'],
  [/^already initialized$/, '管理员账号已创建'],
  [/^not initialized$/, '尚未创建管理员账号'],
  [/^unknown secret name$/, '未知的密钥名'],
  [/^unknown validate target$/, '未知的测试目标'],
  [/^value must be a string$/, '值必须是文本'],
  [/^Error: (.+)$/, (m) => localizeError(m[1], 'zh')],
]

/** 把一条错误消息转换成当前界面语言。en 与未知错误原样返回。 */
export function localizeError(message: string, lang: Lang): string {
  if (lang !== 'zh') return message
  const text = message.trim()
  for (const [pattern, replacement] of ZH_MAPPINGS) {
    const match = pattern.exec(text)
    if (!match) continue
    return typeof replacement === 'function' ? replacement(match) : replacement
  }
  return message
}

/** 从 Error / unknown 提取消息并本地化。en 保持 JS 的 String(error) 原样（含 Error: 前缀），
 * zh 先取 message 再映射——界面不该出现 `Error:` 前缀与英文原因。 */
export function localizeErrorValue(error: unknown, lang: Lang): string {
  if (lang !== 'zh') return String(error)
  const message = error instanceof Error ? error.message : String(error)
  return localizeError(message, lang)
}
