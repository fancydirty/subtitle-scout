import { homedir } from 'node:os'
import { join } from 'node:path'
import { AssrtClient } from './providers/assrt.js'
import { OpenSubtitlesClient } from './providers/opensubtitles.js'
import { ZimukuClient } from './providers/zimuku.js'
import { ZimukuSessionStore } from './providers/zimukuSession.js'
import { SubhdClient } from './providers/subhd.js'
import { JimakuClient } from './providers/jimaku.js'
import type { FetchAdapter, FetchEvent } from './fetchLib.js'
import { makeAssrtAdapter } from './fetch/assrtAdapter.js'
import { makeOpenSubtitlesAdapter } from './fetch/opensubtitlesAdapter.js'
import { makeZimukuAdapter } from './fetch/zimukuAdapter.js'
import { makeSubhdAdapter } from './fetch/subhdAdapter.js'
import { makeJimakuAdapter } from './fetch/jimakuAdapter.js'
import { makeModel } from '../agent/llm.js'
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
    // 验证码破解需要多模态 LLM——一次朴素 generateText 调用(solveNumericCaptcha 内部自带
    // fail-fast + 单次重试),不再走强制 tool-call 的 LlmRuntime/探测/档案磁盘缓存那一整套
    // (v3 old-pipeline-retirement Wall ①:captcha 是 v3 唯一还挂在那个栈上的调用点)。只在真的
    // 撞见挑战页时才会被调用,不是每次 search/resolve 都要打一次 LLM。
    const model = makeModel({
      baseUrl: requireEnvForZimuku('LLM_BASE_URL'),
      apiKey: requireEnvForZimuku('LLM_API_KEY'),
      model: requireEnvForZimuku('LLM_MODEL'),
    })
    const client = new ZimukuClient({
      sessionStore: new ZimukuSessionStore(join(cacheRoot, 'zimuku-session')),
      solve: async png => solveNumericCaptcha(model, png),
      onApiCall: r => emit({ event: 'api_call', provider: 'zimuku', ...r }),
    })
    adapters.push(makeZimukuAdapter(client))
  }

  if (process.env.SUBHD_ENABLED === 'true') {
    // subhd 无验证码/无云锁挑战，故不需 LLM（与 zimuku 相反）。默认走 subhd.me；SUBHD_BASE_URL 可覆盖。
    // 客户端默认 fetchImpl shell 到 curl（Node TLS 指纹被临时页校验拒，见 adapters/providers/subhd.ts）。
    const client = new SubhdClient({
      baseUrl: process.env.SUBHD_BASE_URL,
      onApiCall: r => emit({ event: 'api_call', provider: 'subhd', ...r }),
    })
    adapters.push(makeSubhdAdapter(client))
  }

  // F2:jimaku.cc 日字专门源。有 key 才入列;enabled 再按 languages 含 ja 门控(英剧搜 en 时不扇出)。
  if (process.env.JIMAKU_API_KEY) {
    const client = new JimakuClient({
      apiKey: process.env.JIMAKU_API_KEY,
      onApiCall: r => emit({ event: 'api_call', provider: 'jimaku', ...r }),
    })
    adapters.push(makeJimakuAdapter(client))
  }
  return adapters
}
