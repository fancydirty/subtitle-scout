import { homedir } from 'node:os'
import { join } from 'node:path'
import { AssrtClient } from '../adapters/providers/assrt.js'
import { OpenSubtitlesClient } from '../adapters/providers/opensubtitles.js'
import { ZimukuClient } from '../adapters/providers/zimuku.js'
import { ZimukuSessionStore } from '../adapters/providers/zimukuSession.js'
import type { FetchAdapter, FetchEvent } from './fetchLib.js'
import { makeAssrtAdapter } from './adapters/assrtAdapter.js'
import { makeOpenSubtitlesAdapter } from './adapters/opensubtitlesAdapter.js'
import { makeZimukuAdapter } from './adapters/zimukuAdapter.js'
import { createLlmRuntime } from '../agent/runtime.js'
import { ProfileStore } from '../agent/profile.js'
import { solveNumericCaptcha } from '../agent/solveNumericCaptcha.js'

function requireEnvForZimuku(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`ZIMUKU_ENABLED=true requires ${name} (captcha solving needs a multimodal LLM) — set it alongside your other LLM_* vars`)
  return v
}

/** 从 env 变量组装真实 FetchAdapter[]（Assrt/OpenSubtitles/Zimuku，各自按其 env 是否配置决定
 *  是否入列）。v3 phase ⑦ 从 subtitle-fetch.ts 提取出来——那个文件顶层的 `main().catch()`
 *  在 import 时就会触发副作用（见 subtitle-fetch.test.ts 头部注释：只能 spawnSync 测，不能直接
 *  import 单测），没法被新增的 in-process find-subtitle worker（cli/index.ts 的 cmdWatch）安全
 *  地 import——先把这个纯组装函数搬到这里，subtitle-fetch.ts 反过来 import 回去，两边共用同一份
 *  实现（"reuse, don't reinvent"），不再各写一份。 */
export async function buildAdapters(emit: (e: FetchEvent) => void = () => {}): Promise<FetchAdapter[]> {
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const adapters: FetchAdapter[] = []

  if (process.env.ASSRT_TOKEN) {
    const client = new AssrtClient({
      token: process.env.ASSRT_TOKEN,
      cacheDir: join(cacheRoot, 'assrt-responses'),
      onApiCall: r => emit({ event: 'api_call', provider: 'assrt', ...r }),
    })
    adapters.push(makeAssrtAdapter(client))
  }

  if (process.env.OPENSUBTITLES_API_KEY) {
    const client = new OpenSubtitlesClient({
      apiKey: process.env.OPENSUBTITLES_API_KEY,
      appUserAgent: 'subtitlescout v0.2.0',
      username: process.env.OPENSUBTITLES_USERNAME,
      password: process.env.OPENSUBTITLES_PASSWORD,
      onApiCall: r => emit({ event: 'api_call', provider: 'opensubtitles', ...r }),
    })
    adapters.push(makeOpenSubtitlesAdapter(client))
  }

  if (process.env.ZIMUKU_ENABLED === 'true') {
    // 验证码破解需要多模态 LLM——子进程独立构建一份 LlmRuntime(继承父进程 env,含 LLM_* 变量;
    // ProfileStore 磁盘缓存,冷启动只探测一次)。只在真的撞见挑战页时才会被调用,不是每次
    // search/resolve 都要打一次 LLM。
    const llm = await createLlmRuntime({
      baseUrl: requireEnvForZimuku('LLM_BASE_URL'),
      apiKey: requireEnvForZimuku('LLM_API_KEY'),
      model: requireEnvForZimuku('LLM_MODEL'),
    }, new ProfileStore(join(cacheRoot, 'llm-profiles')))
    const client = new ZimukuClient({
      sessionStore: new ZimukuSessionStore(join(cacheRoot, 'zimuku-session')),
      solve: async png => (await solveNumericCaptcha(llm, png)).parsed,
      onApiCall: r => emit({ event: 'api_call', provider: 'zimuku', ...r }),
    })
    adapters.push(makeZimukuAdapter(client))
  }
  return adapters
}
