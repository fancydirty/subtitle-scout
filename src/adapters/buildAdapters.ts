import { homedir } from 'node:os'
import { join } from 'node:path'
import { AssrtClient } from './providers/assrt.js'
import { OpenSubtitlesClient } from './providers/opensubtitles.js'
import { ZimukuClient } from './providers/zimuku.js'
import { ZimukuSessionStore } from './providers/zimukuSession.js'
import { SubhdClient } from './providers/subhd.js'
import { JimakuClient } from './providers/jimaku.js'
import { R3subClient } from './providers/r3sub.js'
import { R3subSessionStore } from './providers/r3subSession.js'
import { SubdlClient } from './providers/subdl.js'
import type { FetchAdapter, FetchEvent } from './fetchLib.js'
import { makeAssrtAdapter } from './fetch/assrtAdapter.js'
import { makeOpenSubtitlesAdapter } from './fetch/opensubtitlesAdapter.js'
import { makeZimukuAdapter } from './fetch/zimukuAdapter.js'
import { makeSubhdAdapter } from './fetch/subhdAdapter.js'
import { makeJimakuAdapter } from './fetch/jimakuAdapter.js'
import { makeR3subAdapter } from './fetch/r3subAdapter.js'
import { makeSubdlAdapter } from './fetch/subdlAdapter.js'
import { makeModel } from '../agent/llm.js'
import { makeCaptchaSolver } from './captchaSolver.js'
import type { AdapterConfigResolver } from '../v2/secrets.js'

/** 从配置组装真实 FetchAdapter[]（Assrt/OpenSubtitles/Zimuku，各自按其配置是否齐全决定
 *  是否入列）。v3 phase ⑦ 从 subtitle-fetch.ts 提取出来——那个文件顶层的 `main().catch()`
 *  在 import 时就会触发副作用（见 subtitle-fetch.test.ts 头部注释：只能 spawnSync 测，不能直接
 *  import 单测），没法被新增的 in-process find-subtitle worker（cli/index.ts 的 cmdWatch）安全
 *  地 import——先把这个纯组装函数搬到这里，subtitle-fetch.ts 反过来 import 回去，两边共用同一份
 *  实现（"reuse, don't reinvent"），不再各写一份。
 *
 *  2026-08-20 用户裁决：删除 env 凭证路径——cfg 从带默认值改为**必传**。曾经的默认值
 *  `envOnlyAdapterConfig(process.env)` 让漏传 cfg 的调用点静默退回 env（而 daemon 运行态的
 *  env 凭证从来不生效），实测就漏了一处：handleWorkerTask 翻译分支的 buildAdapters(emit)
 *  没传 cfg，翻译抓源腿的凭证面一直是空的。改成必传后这类漏接在编译期就红。 */
export async function buildAdapters(
  cfg: AdapterConfigResolver,
  emit: (e: FetchEvent) => void = () => {},
  warn: (msg: string) => void = () => {},
): Promise<FetchAdapter[]> {
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const adapters: FetchAdapter[] = []

  const assrtToken = cfg.secret('ASSRT_TOKEN').value
  if (assrtToken) {
    const client = new AssrtClient({
      token: assrtToken,
      cacheDir: join(cacheRoot, 'assrt-responses'),
      onApiCall: r => emit({ event: 'api_call', provider: 'assrt', ...r }),
    })
    adapters.push(makeAssrtAdapter(client))
  }

  const opensubtitlesApiKey = cfg.secret('OPENSUBTITLES_API_KEY').value
  if (opensubtitlesApiKey) {
    const client = new OpenSubtitlesClient({
      apiKey: opensubtitlesApiKey,
      appUserAgent: 'subtitlescout v0.2.0',
      username: cfg.secret('OPENSUBTITLES_USERNAME').value ?? undefined,
      password: cfg.secret('OPENSUBTITLES_PASSWORD').value ?? undefined,
      onApiCall: r => emit({ event: 'api_call', provider: 'opensubtitles', ...r }),
    })
    adapters.push(makeOpenSubtitlesAdapter(client))
  }

  if (cfg.flag('ZIMUKU_ENABLED').enabled) {
    // zimuku 验证码破解：优先模板匹配（纯算法，0 token，~100ms），未命中时降级到多模态 LLM
    // 兜底。模板匹配命中率高时（实测 zimuku.org 现行验证码基本全中），完全无需视觉模型就能正常
    // 运行。ZIMUKU_VISION_* 三件套可选——缺席时模板未命中直接失败，不会尝试 LLM；配置时作为
    // fallback（仅在模板失效或站点改版导致字形漂移时才调用，发出 captcha_template_miss notice）。
    const visionBaseUrl = cfg.secret('ZIMUKU_VISION_BASE_URL').value
    const visionApiKey = cfg.secret('ZIMUKU_VISION_API_KEY').value
    const visionModel = cfg.secret('ZIMUKU_VISION_MODEL').value
    const hasVision = visionBaseUrl && visionApiKey && visionModel

    const solve = hasVision
      ? (() => {
          const model = makeModel({ baseUrl: visionBaseUrl, apiKey: visionApiKey, model: visionModel })
          return makeCaptchaSolver({ model, emit })
        })()
      : makeCaptchaSolver({
          model: makeModel({ baseUrl: 'http://localhost', apiKey: 'dummy', model: 'none' }),
          emit,
          solveVision: async () => { throw new Error('视觉兜底未配置') }
        })

    const client = new ZimukuClient({
      sessionStore: new ZimukuSessionStore(join(cacheRoot, 'zimuku-session')),
      solve: async png => {
        const result = await solve(png)
        if (result.digits === null) {
          throw new Error(
            hasVision
              ? '验证码识别失败：模板未命中且视觉 LLM 也无法识别'
              : '验证码识别失败：模板未命中，且未配置 ZIMUKU_VISION_* 兜底（通常模板匹配已够用）'
          )
        }
        return { digits: result.digits }
      },
      onApiCall: r => emit({ event: 'api_call', provider: 'zimuku', ...r }),
    })
    adapters.push(makeZimukuAdapter(client))
  }

  if (cfg.flag('SUBHD_ENABLED').enabled) {
    // subhd 无验证码/无云锁挑战，故不需 LLM（与 zimuku 相反）。默认走 subhd.me；SUBHD_BASE_URL 可覆盖。
    // 客户端默认 fetchImpl shell 到 curl（Node TLS 指纹被临时页校验拒，见 adapters/providers/subhd.ts）。
    const client = new SubhdClient({
      baseUrl: process.env.SUBHD_BASE_URL,
      onApiCall: r => emit({ event: 'api_call', provider: 'subhd', ...r }),
    })
    adapters.push(makeSubhdAdapter(client))
  }

  // F2:jimaku.cc 日字专门源。有 key 才入列;enabled 再按 languages 含 ja 门控(英剧搜 en 时不扇出)。
  const jimakuKey = cfg.secret('JIMAKU_API_KEY').value
  if (jimakuKey) {
    const client = new JimakuClient({
      apiKey: jimakuKey,
      onApiCall: r => emit({ event: 'api_call', provider: 'jimaku', ...r }),
    })
    adapters.push(makeJimakuAdapter(client))
  }

  // r3sub：台版官方中文字幕站。邮箱+密码齐才入列（enabled 再按中文门控）。下载走两跳，adapter
  // 的 resolve 抛错——真实下载由 find-subtitle worker 的 r3sub 旁路走 R3subClient.download
  // （worker 装配处另注入 client，见 cli/index.ts）。
  const r3subEmail = cfg.secret('R3SUB_EMAIL').value
  const r3subPassword = cfg.secret('R3SUB_PASSWORD').value
  if (r3subEmail && r3subPassword) {
    const client = new R3subClient({
      email: r3subEmail,
      password: r3subPassword,
      sessionStore: new R3subSessionStore(join(cacheRoot, 'r3sub-session')),
      onApiCall: r => emit({ event: 'api_call', provider: 'r3sub', ...r }),
    })
    adapters.push(makeR3subAdapter(client))
  }

  // SubDL：subscene 接班的国际源。有免费 API key 才入列；enabled 恒真（不做语言门控）。
  const subdlKey = cfg.secret('SUBDL_API_KEY').value
  if (subdlKey) {
    const client = new SubdlClient({
      apiKey: subdlKey,
      onApiCall: r => emit({ event: 'api_call', provider: 'subdl', ...r }),
    })
    adapters.push(makeSubdlAdapter(client))
  }
  return adapters
}

/** r3sub 下载客户端（find-subtitle worker 的 r3sub 旁路用）——凭据齐时构造，否则 null。
 *  与 buildAdapters 里的 r3sub adapter 共用同一 session store 目录（复用登录 cookie）。 */
export function buildR3subClient(cfg: AdapterConfigResolver): R3subClient | null {
  const email = cfg.secret('R3SUB_EMAIL').value
  const password = cfg.secret('R3SUB_PASSWORD').value
  if (!email || !password) return null
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  return new R3subClient({
    email,
    password,
    sessionStore: new R3subSessionStore(join(cacheRoot, 'r3sub-session')),
  })
}
