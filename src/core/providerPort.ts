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
  resolveDownload: (ref: CandidateRef) => Promise<{ url: string; filename?: string }>
}

const ResolveOutSchema = z.object({ url: z.string(), filename: z.string().optional() })
const here = dirname(fileURLToPath(import.meta.url))
/** 默认命令：npx tsx <repo>/src/cli/subtitle-fetch.ts（容器与本机同构，无编译步） */
const DEFAULT_COMMAND = ['npx', 'tsx', resolve(here, '../cli/subtitle-fetch.ts')]

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
      const killGroup = () => {
        try {
          if (child.pid != null) process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch { /* ESRCH：进程组已消亡，兜底直杀 */ child.kill('SIGKILL') }
      }
      const timer = setTimeout(() => { killGroup(); reject(new Error(`subtitle-fetch timeout after ${timeoutMs}ms`)) }, timeoutMs)
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
        else reject(new Error(`subtitle-fetch exit ${code}: ${stderrTail}`))
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
