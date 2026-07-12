import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { SubtitleCandidateSchema, type CandidateRef, type SubtitleCandidate } from './schemas.js'
import type { FetchEvent } from '../cli/fetchLib.js'

export interface ProviderSearchArgs {
  queries: string[]
  imdb?: string; year?: number; season?: number; episode?: number
  filename?: string; languages?: string[]
  deep: boolean
}
export interface ProviderSearchResult {
  candidates: SubtitleCandidate[]
  /** 本次调用里 CLI 上报的 provider 局部故障（部分失败 fail-soft 后的残留证据）。
   *  零候选 + 非空 providerErrors ≠ "确实没有字幕"——调用方据此拒写负缓存。 */
  providerErrors: { provider: string; message: string }[]
}
export interface ProviderPort {
  search: (args: ProviderSearchArgs) => Promise<ProviderSearchResult>
  resolveDownload: (ref: CandidateRef) => Promise<{ url: string; filename?: string; headers?: Record<string, string> }>
}

const ResolveOutSchema = z.object({
  url: z.string(),
  filename: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
})

/**
 * 子进程入口按运行形态自动切换——不依赖环境变量或硬编码路径假设。
 * 判据：本模块自身 import.meta.url 的扩展名。tsx/vitest 跑 src 时保留 .ts，
 * `tsc` 编译到 dist 后是 .js；两条腿天然互斥，用同一份代码原地推断，不会和实际部署形态错位。
 *   .ts → 开发态：npx tsx <repo>/src/cli/subtitle-fetch.ts
 *   .js → 编译态：node <repo>/dist/cli/subtitle-fetch.js（同级 sibling，tsc rootDir/outDir 镜像 src 布局）
 */
export function resolveSubtitleFetchCommand(moduleUrl: string): string[] {
  const modulePath = fileURLToPath(moduleUrl)
  const moduleDir = dirname(modulePath)
  if (modulePath.endsWith('.js')) {
    return ['node', resolve(moduleDir, '../cli/subtitle-fetch.js')]
  }
  return ['npx', 'tsx', resolve(moduleDir, '../cli/subtitle-fetch.ts')]
}

const DEFAULT_COMMAND = resolveSubtitleFetchCommand(import.meta.url)

/**
 * subtitle-fetch 子进程退出非零前，若 stderr 里出现过 code:'quota_exhausted' 的 provider_error 事件——
 * run() 用这个类型化错误代替裸 Error 去 reject，让调用方（pipeline.ts）能按 resetAt 精确退避，
 * 而不是把"配额耗尽"和其它瞬时故障混为一谈都走盲的 ERROR_BACKOFF_MS 阶梯（v2/jobsRepo.ts）。
 */
export class ProviderQuotaExhaustedError extends Error {
  readonly code = 'quota_exhausted' as const
  constructor(message: string, public resetAt: string | null) {
    super(message)
  }
}

export function makeCliProviderPort(opts: {
  command?: string[]
  onEvent?: (e: FetchEvent) => void
  timeoutMs?: number
} = {}): ProviderPort {
  const command = opts.command ?? DEFAULT_COMMAND
  const timeoutMs = opts.timeoutMs ?? 180_000   // assrt 限速 15s/查 ×2 + gems + OS，宽松上限

  function run(argv: string[]): Promise<{ stdout: string; providerErrors: { provider: string; message: string }[] }> {
    return new Promise((resolvePromise, reject) => {
      const [bin, ...pre] = command
      // detached：子进程自成进程组，超时可整组 SIGKILL（否则只杀 npx，tsx 孙进程孤儿化继续跑）
      const child = spawn(bin, [...pre, ...argv], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      // setEncoding → StringDecoder 保证多字节 UTF-8 跨 chunk 边界不撕裂（中文候选名跨 64KB 会碎成 �）
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      let stdout = '', stderrTail = ''
      const providerErrors: { provider: string; message: string }[] = []
      // 最后一次观察到的 quota_exhausted provider_error（若有）；进程以非零码退出时用它构造类型化错误。
      let quotaExhausted: { resetAt: string | null } | null = null
      const killGroup = () => {
        try {
          if (child.pid != null) process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch { /* ESRCH：进程组已消亡，兜底直杀 */ child.kill('SIGKILL') }
      }
      const timer = setTimeout(() => {
        killGroup()
        // MINOR-1: 超时前若已经观察到 quota_exhausted 事件，优先用类型化错误 reject——否则调用方
        // （pipeline.ts）拿到的是泛型超时 Error，没法按 resetAt 精确退避，只能当成普通瞬时故障。
        reject(quotaExhausted
          ? new ProviderQuotaExhaustedError(`subtitle-fetch timeout after ${timeoutMs}ms`, quotaExhausted.resetAt)
          : new Error(`subtitle-fetch timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      child.stdout.on('data', (d: string) => { stdout += d })
      let stderrBuf = ''
      child.stderr.on('data', (d: string) => {
        stderrBuf += d
        let nl: number
        while ((nl = stderrBuf.indexOf('\n')) >= 0) {
          const line = stderrBuf.slice(0, nl).trim(); stderrBuf = stderrBuf.slice(nl + 1)
          if (!line) continue
          stderrTail = line
          try {
            const parsed = JSON.parse(line)
            if (parsed.event) {
              if (parsed.event === 'provider_error') {
                providerErrors.push({ provider: String(parsed.provider), message: String(parsed.message) })
                if (parsed.code === 'quota_exhausted') {
                  quotaExhausted = { resetAt: typeof parsed.resetAt === 'string' ? parsed.resetAt : null }
                }
              }
              opts.onEvent?.(parsed as FetchEvent)
            }
          } catch { /* 非 JSON 行照单忽略（如 npx 噪音） */ }
        }
      })
      child.on('error', e => { clearTimeout(timer); reject(e) })
      child.on('close', code => {
        clearTimeout(timer)
        if (code === 0) resolvePromise({ stdout, providerErrors })
        else reject(quotaExhausted
          ? new ProviderQuotaExhaustedError(`subtitle-fetch exit ${code}: ${stderrTail}`, quotaExhausted.resetAt)
          : new Error(`subtitle-fetch exit ${code}: ${stderrTail}`))
      })
    })
  }

  return {
    async search(args) {
      const argv: string[] = []
      for (const q of args.queries) argv.push('--query', q)
      if (args.imdb) argv.push('--imdb', args.imdb)
      if (args.year != null) argv.push('--year', String(args.year))
      if (args.season != null) argv.push('--season', String(args.season))
      if (args.episode != null) argv.push('--episode', String(args.episode))
      if (args.filename) argv.push('--filename', args.filename)
      if (args.languages?.length) argv.push('--languages', args.languages.join(','))
      if (args.deep) argv.push('--deep')
      argv.push('--format', 'json')
      const { stdout, providerErrors } = await run(argv)
      return { candidates: z.array(SubtitleCandidateSchema).parse(JSON.parse(stdout)), providerErrors }
    },
    async resolveDownload(ref) {
      const argv = ['resolve', '--provider', ref.provider, '--id', ref.providerId]
      if (ref.fileIndex != null) argv.push('--file-index', String(ref.fileIndex))
      const { stdout } = await run(argv)
      return ResolveOutSchema.parse(JSON.parse(stdout))
    },
  }
}
