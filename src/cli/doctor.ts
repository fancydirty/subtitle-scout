import { dirname } from 'node:path'
import { mapPath, type PathMapping } from '../core/mediaContext.js'

export interface DoctorResult {
  name: string
  ok: boolean
  /** 环境不满足前提、检查被跳过（不算失败） */
  skip?: boolean
  detail: string
  hint?: string
}

export async function checkJellyfin(jf: { getSessions(): Promise<unknown[]> }): Promise<DoctorResult> {
  try {
    const sessions = await jf.getSessions()
    return { name: 'jellyfin', ok: true, detail: `Jellyfin 可达，当前 ${sessions.length} 个会话` }
  } catch (e) {
    return {
      name: 'jellyfin', ok: false, detail: `连接失败：${String(e)}`,
      hint: '检查 JELLYFIN_URL 是否填写正确：subtitle-scout 和 Jellyfin 都跑在 Docker 里时，主机名要用 Docker 服务名（如 http://jellyfin:8096）而不是 localhost。API key 在 Jellyfin 控制台 → API 密钥里生成。',
    }
  }
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

export async function checkLlm(minimalChat: () => Promise<string>): Promise<DoctorResult> {
  try {
    await minimalChat()
    return { name: 'llm', ok: true, detail: 'LLM 端点可用，最小对话成功' }
  } catch (e) {
    return {
      name: 'llm', ok: false, detail: `调用失败：${String(e)}`,
      hint: 'LLM_BASE_URL、LLM_API_KEY、LLM_MODEL 三个配置必须来自同一个 AI 服务商（比如都用 DeepSeek）。BASE_URL 通常以 /v1 结尾。',
    }
  }
}

export function checkMediaRoots(roots: string[], isWritable: (dir: string) => boolean): DoctorResult {
  if (roots.length === 0) {
    return {
      name: 'media-roots', ok: true, skip: true,
      detail: 'MEDIA_ROOTS 未配置，跳过（建议配置写入白名单）',
    }
  }
  const bad = roots.filter(r => !isWritable(r))
  if (bad.length > 0) {
    return {
      name: 'media-roots', ok: false, detail: `以下根目录不可写：${bad.join(', ')}`,
      hint: '确认挂载不是只读（ro）、容器用户有写权限。只读网盘/WebDAV 挂载无法写入 sidecar 字幕。',
    }
  }
  return { name: 'media-roots', ok: true, detail: `${roots.length} 个媒体根目录全部可写` }
}

export function checkPathMappings(
  items: Array<{ Path?: string | null }>,
  mappings: PathMapping[],
  deps: { dirExists: (dir: string) => boolean; isWritable: (dir: string) => boolean },
): DoctorResult {
  const paths = items.map(i => i.Path).filter((p): p is string => !!p)
  if (paths.length === 0) {
    return { name: 'path-mapping', ok: true, skip: true, detail: 'Jellyfin 库为空，无法校验路径映射（入库后重跑 doctor）' }
  }
  const dirs = [...new Set(paths.map(p => dirname(mapPath(p, mappings))))]
  const missing = dirs.filter(d => !deps.dirExists(d))
  const readonly = dirs.filter(d => deps.dirExists(d) && !deps.isWritable(d))
  if (missing.length > 0 || readonly.length > 0) {
    const parts: string[] = []
    if (missing.length > 0) parts.push(`本容器内不存在：${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` 等 ${missing.length} 处` : ''}`)
    if (readonly.length > 0) parts.push(`不可写：${readonly.slice(0, 3).join(', ')}`)
    return {
      name: 'path-mapping', ok: false,
      detail: `Jellyfin 报告的媒体路径映射后有问题——${parts.join('；')}`,
      hint: '这是最常见的接线错误：scout 容器必须以与 Jellyfin 相同的路径挂载媒体目录；无法一致时配置 MEDIA_PATH_MAPPINGS=jellyfin前缀=本地前缀。',
    }
  }
  return { name: 'path-mapping', ok: true, detail: `抽查 ${paths.length} 个条目、${dirs.length} 个目录：映射一致且可写` }
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

/** 给远端探测包一层超时——doctor 面对黑洞端点（连上但永不回包）不能挂死。
 *  finally 清理 setTimeout，避免残留计时器把进程吊着。 */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} 在 ${ms / 1000}s 内无响应`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}
