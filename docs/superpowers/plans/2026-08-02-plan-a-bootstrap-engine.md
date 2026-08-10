# Spec A 启动面实现计划 — Bootstrap Wizard + 密钥库 + 发动机总开关

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 首跑 bootstrap wizard（7 步全屏）+ 密钥落库（settings 表 `secret:*`，env 优先）+ validate 端点（复用 doctor 原语）+ `engine_enabled` 总开关 + watch setup 模式（零 key 不死锁、wizard 落库后同进程点火）。

**Architecture:** 新纯解析层 `src/v2/secrets.ts`（env>db>none）被 cli/adapters/dashboard 四个消费方共用；watch 启动顺序重排为 openDb → dashboard → 门禁评估，`clients.current` holder 间接层 + `secrets_version` 每 tick 比对驱动长命客户端热重建；前端 `BootstrapGate` 全屏接管 + Tailwind v4（无 preflight）/shadcn 底座进场（与 Astryx 并存，Settings 屏本身仍用 Astryx 画 Providers/Engine 行）。

**Tech Stack:** Node 22 ESM/TS · better-sqlite3 · vitest（root `maxWorkers:3`，web jsdom `maxWorkers:3`）· React 19 + Vite 7 · Tailwind v4 `@tailwindcss/vite` · shadcn copy-in（**只四个**：button/input/switch/card；radix 只装 `@radix-ui/react-switch` + `@radix-ui/react-slot`——**不抄 label.tsx、不装 radix label**，与 :51 和 Task 13 Step 3 的 dependencies JSON 一致）· zod ^4 · ai SDK ^7（`maxOutputTokens`）。

**Spec（唯一裁决来源，已 PASS）:** `docs/superpowers/specs/2026-08-01-spec-a-bootstrap-engine-design.md`

---

## 执行纪律（实现代理必读）

- **TDD**：每 task 先写失败测试 → 跑红 → 实现 → 跑绿 → commit。每 task 一个 commit，消息以 `feat:`/`fix:` 开头。
- 仓库根命令：`npm run check`（tsc --noEmit）、`npm test`（后端套件）、`cd web && npm test`（前端套件）、`cd web && npm run build`。
- **commit -m 正文禁用反引号**（zsh 命令替换会吞字）。引用标识符用单引号。
- **禁触**：`src/v2/realignExecutor.ts`、`src/agent/skills/`、`docker-compose.yml`、`.claude/`、`token.txt`。docs/ 已 gitignore，不用提交。
- **密钥明文永不进日志/序列化**（spec §8）：新增 log 调用逐个核对；validate 失败路径**不得** `String(e)` 原样回前端（可能 echo 凭据）——走 Task 6 的分类文案。doctor CLI 的既有中文 detail 维持现状（本地产出，不进 HTTP）。
- 既有测试文件落点：`secrets` 新开 `src/v2/secrets.test.ts`；settingsRepo/daemon/buildAdapters/doctor/apiV2/server/router 测试**追加到既有同名测试文件**，沿用各文件既有 fixture（`openDb(':memory:')`、`makeDeps` 等）。
- 行号锚点是写作时（2026-08-02）的实测值；若与真实代码漂移，**以真实代码为准**，在 commit 消息里注明偏差。不得静默改设计。
- 每个 task 的 verify 命令必须真跑并贴预期结果；红了不许跳。

## File Structure

**Create（后端）:**
- `src/v2/secrets.ts` — 纯解析层：SECRET_NAMES 白名单 / resolveSecret / maskSecretValue / resolveProviderFlag / AdapterConfigResolver
- `src/v2/secrets.test.ts`
- `src/cli/watchClients.ts` — `clients.current` holder 类型 + secrets_version watcher（preTick）+ setupSatisfied/engineEnabled
- `src/cli/watchClients.test.ts`
- `src/dashboard/setupApi.ts` — setup/status DTO 组装、secrets PUT、validate 薄壳、providers DTO
- `src/dashboard/setupApi.test.ts`

**Modify（后端）:**
- `src/v2/settingsRepo.ts` — secret 方法 + secrets_version（测试追加 `src/v2/settingsRepo.test.ts`）
- `src/adapters/buildAdapters.ts` — cfg resolver 参数（测试追加 `src/adapters/buildAdapters.test.ts`）
- `src/cli/doctor.ts` — checkJimaku/checkSubhd（测试追加 `src/cli/doctor.test.ts`）
- `src/v2/daemon.ts` — `preTick` + `workPermitted` 两个可选 dep + 五处产工作闸（测试追加 `src/v2/daemon.test.ts`）
- `src/cli/index.ts` — assemble null 耐受、cmdReconcileAll 双钥匙门、cmdDoctor 走 resolveSecret + 新增 jimaku/subhd 检查、cmdWatch 重排
- `src/cli/translateItemCommand.ts` — LLM/TMDB 改走 resolveSecret
- `src/cli/watchStartupWarnings.ts` — setup 模式警告行（测试追加 `src/cli/watchStartupWarnings.test.ts`）
- `src/dashboard/apiV2.ts` — SETTINGS_KEYS +3、win32 路径（测试追加 `src/dashboard/apiV2.test.ts`）
- `src/dashboard/router.ts` — setupStatus/providers 两个同步 GET（测试追加 `src/dashboard/router.test.ts`）
- `src/dashboard/server.ts` — tmdb/reconcileAll getter 化 + 两个异步路由（测试追加 `src/dashboard/server.test.ts`）

**Create（前端）:**
- `web/src/tw.css` — Tailwind v4 入口（**无 preflight**）+ @theme token
- `web/src/lib/utils.ts` — `cn()`
- `web/src/components/ui/{button,input,switch,card}.tsx` — shadcn copy-in（**只这四个**，Task 13 Step 5 逐个给了完整源码；不抄 label.tsx——本 Plan 的表单标签一律用 shadcn 之外的原生 `<label>` 或 Astryx TextInput 自带 label）
- `web/src/setup/BootstrapGate.tsx` + `web/src/setup/BootstrapWizard.tsx` + `web/src/setup/steps/*.tsx`（7 步）+ 各自测试
- `web/src/settings/ProvidersSection.tsx`（Astryx 画——Settings 屏栈随迁归 Spec C）
- `web/src/settings/EngineRow.test.tsx` — **只建这一个测试文件**：`EngineRow` 组件本体由 Task 24 写进**既有** `web/src/settings/BehaviorSection.tsx`（同文件内组件，不单独建 `EngineRow.tsx`；见 Task 24 Files 块）
- `web/src/shell/EngineBanner.tsx`

**Modify（前端）:**
- `web/package.json` / `web/vite.config.ts` / `web/src/main.tsx` — tailwind 进场
- `web/src/api/types.ts` / `client.ts` / `hooks.ts` — setup DTO + 4 个 API + useSetupStatus
- `web/src/App.tsx` — BootstrapGate（测试追加 `web/src/App.test.tsx`）
- `web/src/shell/AppShell.tsx` — EngineBanner 挂载
- `web/src/settings/SettingsPage.tsx` / `DeploySection.tsx` / `BehaviorSection.tsx` — Providers 区插入、Deploy 裁非密、Engine 行
- `web/src/i18n/en.ts` / `zh.ts` — **77 新键**（Task 15 逐字给全；两表各从 199 键长到 276 键，无一键与既有键名相撞）

---

### Task 1: `src/v2/secrets.ts` — 纯解析层

**Files:**
- Create: `src/v2/secrets.ts`
- Test: `src/v2/secrets.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/v2/secrets.test.ts`，完整内容：

```ts
// src/v2/secrets.test.ts：spec A §4.1/§4.2 解析优先级、打码、provider flag 语义的纯函数契约。
import { describe, it, expect } from 'vitest'
import {
  SECRET_NAMES, isSecretName, resolveSecret, maskSecretValue,
  resolveProviderFlag, makeAdapterConfigResolver, envOnlyAdapterConfig,
} from './secrets.js'

describe('SECRET_NAMES 白名单（spec §4.1）', () => {
  // 9 而非 10：spec §4.1 散文写"10 个名字"但枚举只列了 9 个，**以枚举为准**（下面这份列表
  // 就是 spec 的枚举原文）。这是一处已知的 spec 笔误，不要"补"第 10 个名字出来。
  it('恰为 9 键', () => {
    expect([...SECRET_NAMES].sort()).toEqual([
      'ASSRT_TOKEN', 'JIMAKU_API_KEY', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL',
      'OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_PASSWORD', 'OPENSUBTITLES_USERNAME',
      'TMDB_API_KEY',
    ].sort())
    expect(SECRET_NAMES).toHaveLength(9)
  })
  it('isSecretName 放行白名单、拒绝其他', () => {
    expect(isSecretName('TMDB_API_KEY')).toBe(true)
    expect(isSecretName('ADMIN_TOKEN')).toBe(false)
    expect(isSecretName('')).toBe(false)
  })
})

describe('resolveSecret 优先级（spec §4.2：env > db > none）', () => {
  it('env 非空 → env 胜（库里同名值被无视）', () => {
    expect(resolveSecret('TMDB_API_KEY', { TMDB_API_KEY: 'env-key' }, () => 'db-key'))
      .toEqual({ value: 'env-key', source: 'env' })
  })
  it('env 缺席 → db 兜底', () => {
    expect(resolveSecret('TMDB_API_KEY', {}, () => 'db-key'))
      .toEqual({ value: 'db-key', source: 'db' })
  })
  it('空字符串 env 视为未设（手滑 export X= 不挡库里的真 key）', () => {
    expect(resolveSecret('TMDB_API_KEY', { TMDB_API_KEY: '' }, () => 'db-key'))
      .toEqual({ value: 'db-key', source: 'db' })
  })
  it('env/db 都没有 → none；db 空串同样视为 none', () => {
    expect(resolveSecret('TMDB_API_KEY', {}, () => null)).toEqual({ value: null, source: 'none' })
    expect(resolveSecret('TMDB_API_KEY', {}, () => '')).toEqual({ value: null, source: 'none' })
  })
})

describe('maskSecretValue（spec §4.1）', () => {
  it('长度 ≥8 → 前3+••••+后3', () => {
    expect(maskSecretValue('abcdefghij')).toBe('abc••••hij')
    expect(maskSecretValue('12345678')).toBe('123••••678')
  })
  it('长度 <8 → 全 ••••', () => {
    expect(maskSecretValue('abcdefg')).toBe('••••')
    expect(maskSecretValue('')).toBe('••••')
  })
  it('打码结果不含任何长度≥4 的明文子串', () => {
    for (const v of ['sk-live-9f8e7d6c5b4a', 'abcdefgh']) {
      const masked = maskSecretValue(v)
      for (let i = 0; i + 4 <= v.length; i++) {
        expect(masked.includes(v.slice(i, i + 4))).toBe(false)
      }
    }
  })
})

describe('resolveProviderFlag（spec §4.4：env 显式 > 库 > 关；=== 精确，fail-closed）', () => {
  it('env 显式 true → 开/env', () => {
    expect(resolveProviderFlag('SUBHD_ENABLED', { SUBHD_ENABLED: 'true' }, () => null))
      .toEqual({ enabled: true, source: 'env' })
  })
  it('env 显式 false → 关/env（压过库里的 true）', () => {
    expect(resolveProviderFlag('SUBHD_ENABLED', { SUBHD_ENABLED: 'false' }, () => 'true'))
      .toEqual({ enabled: false, source: 'env' })
  })
  it('env 缺席 → 库 provider:<flag>', () => {
    expect(resolveProviderFlag('ZIMUKU_ENABLED', {}, (k) => (k === 'provider:ZIMUKU_ENABLED' ? 'true' : null)))
      .toEqual({ enabled: true, source: 'db' })
  })
  it('都没有 → 关/none（与今天 env-only 缺省一致）', () => {
    expect(resolveProviderFlag('SUBHD_ENABLED', {}, () => null))
      .toEqual({ enabled: false, source: 'none' })
  })
  it.each(['1', 'TRUE', 'True', 'yes', ' true'])('脏值 %s → 一律关（fail-closed）', (dirty) => {
    expect(resolveProviderFlag('SUBHD_ENABLED', { SUBHD_ENABLED: dirty }, () => null).enabled).toBe(false)
    expect(resolveProviderFlag('SUBHD_ENABLED', {}, () => dirty).enabled).toBe(false)
  })
  it('空串 env 视为未设，落库值', () => {
    expect(resolveProviderFlag('SUBHD_ENABLED', { SUBHD_ENABLED: '' }, () => 'true'))
      .toEqual({ enabled: true, source: 'db' })
  })
})

describe('AdapterConfigResolver 工厂', () => {
  it('makeAdapterConfigResolver：secret 读 secret:<name>、flag 读 provider:<flag>', () => {
    const store = new Map([['secret:TMDB_API_KEY', 'db-tmdb'], ['provider:ZIMUKU_ENABLED', 'true']])
    const cfg = makeAdapterConfigResolver({}, (k) => store.get(k) ?? null)
    expect(cfg.secret('TMDB_API_KEY')).toEqual({ value: 'db-tmdb', source: 'db' })
    expect(cfg.flag('ZIMUKU_ENABLED')).toEqual({ enabled: true, source: 'db' })
  })
  it('envOnlyAdapterConfig 永远不看库（一次性命令的 env-only 退化，语义与今天逐字一致）', () => {
    const cfg = envOnlyAdapterConfig({ ASSRT_TOKEN: 'tok', SUBHD_ENABLED: 'true' })
    expect(cfg.secret('ASSRT_TOKEN')).toEqual({ value: 'tok', source: 'env' })
    expect(cfg.secret('JIMAKU_API_KEY')).toEqual({ value: null, source: 'none' })
    expect(cfg.flag('SUBHD_ENABLED')).toEqual({ enabled: true, source: 'env' })
    expect(cfg.flag('ZIMUKU_ENABLED')).toEqual({ enabled: false, source: 'none' })
  })
})
```

- [ ] **Step 2: 跑红**

Run: `npx vitest run src/v2/secrets.test.ts`
Expected: FAIL（`./secrets.js` 不存在）

- [ ] **Step 3: 实现**

创建 `src/v2/secrets.ts`，完整内容：

```ts
// src/v2/secrets.ts：启动面（spec A §4.1/§4.2）——密钥解析纯逻辑层。settings 表 `secret:*` 键空间
// + env 优先解析 + 打码序列化 + provider flag 三级解析，全部纯函数无副作用，供
// settingsRepo/buildAdapters/cli/dashboard 四个消费方共用同一套语义（不各写一份）。
//
// 优先级（spec §4.2）：env 非空 → env 胜（deploy-locked，现有部署零迁移零打扰）；否则读库；
// 都没有 → none。空字符串 env 视为未设（手滑 `export TMDB_API_KEY=` 不该挡住库里的真 key）。

/** 白名单（spec §4.1）：只允许这 9 个名字进 settings 表的 `secret:*` 键空间。 */
export const SECRET_NAMES = [
  'TMDB_API_KEY',
  'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL',
  'ASSRT_TOKEN',
  'OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_USERNAME', 'OPENSUBTITLES_PASSWORD',
  'JIMAKU_API_KEY',
] as const
export type SecretName = (typeof SECRET_NAMES)[number]

export function isSecretName(name: string): name is SecretName {
  return (SECRET_NAMES as readonly string[]).includes(name)
}

export type SecretSource = 'env' | 'db' | 'none'

export interface ResolvedSecret {
  /** source='none' 时恒 null；env/db 时是非空字符串（写入侧已拒绝空值）。 */
  value: string | null
  source: SecretSource
}

/** env（非空）> db > none。dbGet 只读 `secret:<name>` 的值（不存在返回 null）。 */
export function resolveSecret(
  name: SecretName,
  env: NodeJS.ProcessEnv,
  dbGet: (name: SecretName) => string | null,
): ResolvedSecret {
  const envValue = env[name]
  if (typeof envValue === 'string' && envValue !== '') return { value: envValue, source: 'env' }
  const dbValue = dbGet(name)
  if (dbValue !== null && dbValue !== '') return { value: dbValue, source: 'db' }
  return { value: null, source: 'none' }
}

/** 打码（spec §4.1）：长度 ≥8 → 前 3 + `••••` + 后 3；<8 → 全 `••••`。 */
export function maskSecretValue(value: string): string {
  if (value.length >= 8) return `${value.slice(0, 3)}••••${value.slice(-3)}`
  return '••••'
}

export type ProviderFlagName = 'SUBHD_ENABLED' | 'ZIMUKU_ENABLED'

export interface ProviderFlagResolution {
  enabled: boolean
  source: SecretSource
}

/** provider 开关三级解析（spec §4.4）：env 显式设置（含 'false'）→ env 值；否则库
 *  `provider:<flag>`；都没有 → 关（与今天 env-only 缺省一致，fail-closed）。
 *  布尔钉死 `=== 'true'` 精确匹配：'1'/'TRUE'/脏值一律关（沿用 buildAdapters.ts 既有语义）。
 *  注意这与 engine_enabled 的 fail-open 相反——闸的性质不同：flag 默认关、engine 默认开。 */
export function resolveProviderFlag(
  flag: ProviderFlagName,
  env: NodeJS.ProcessEnv,
  dbGet: (key: string) => string | null,
): ProviderFlagResolution {
  const envValue = env[flag]
  if (typeof envValue === 'string' && envValue !== '') {
    return { enabled: envValue === 'true', source: 'env' }
  }
  const dbValue = dbGet(`provider:${flag}`)
  if (dbValue !== null) return { enabled: dbValue === 'true', source: 'db' }
  return { enabled: false, source: 'none' }
}

/** buildAdapters 的配置解析面：secret() 拿密钥、flag() 拿 provider 开关。 */
export interface AdapterConfigResolver {
  secret: (name: SecretName) => ResolvedSecret
  flag: (flag: ProviderFlagName) => ProviderFlagResolution
}

/** dbGet 读任意 settings 键（'secret:TMDB_API_KEY'、'provider:SUBHD_ENABLED' 都走它）——
 *  生产侧直接传 `settingsRepo.get.bind(settingsRepo)`，惰性读库，每次调用都是新鲜值。 */
export function makeAdapterConfigResolver(
  env: NodeJS.ProcessEnv,
  dbGet: (key: string) => string | null,
): AdapterConfigResolver {
  return {
    secret: (name) => resolveSecret(name, env, (n) => dbGet(`secret:${n}`)),
    flag: (flag) => resolveProviderFlag(flag, env, dbGet),
  }
}

/** 无库场景（一次性命令的 env-only 退化）：永远不看库，语义与今天逐字一致。 */
export function envOnlyAdapterConfig(env: NodeJS.ProcessEnv): AdapterConfigResolver {
  return {
    secret: (name) => {
      const v = env[name]
      return typeof v === 'string' && v !== '' ? { value: v, source: 'env' } : { value: null, source: 'none' }
    },
    flag: (flag) => {
      const v = env[flag]
      return typeof v === 'string' && v !== '' ? { enabled: v === 'true', source: 'env' } : { enabled: false, source: 'none' }
    },
  }
}
```

- [ ] **Step 4: 跑绿 + 类型检查**

Run: `npx vitest run src/v2/secrets.test.ts && npm run check`
Expected: 全 PASS；tsc 无错

- [ ] **Step 5: Commit**

```bash
git add src/v2/secrets.ts src/v2/secrets.test.ts
git commit -m "feat: 启动面纯解析层 src/v2/secrets.ts（spec A §4.1/§4.2）"
```

---

### Task 2: SettingsRepo — secret 方法 + secrets_version

**Files:**
- Modify: `src/v2/settingsRepo.ts`（`delete(key)` 方法之后追加，类内）
- Test: `src/v2/settingsRepo.test.ts`（文件尾追加 describe）

- [ ] **Step 1: 写失败测试**

`src/v2/settingsRepo.test.ts` 尾部追加：

```ts
describe('SettingsRepo · secret:* 键空间（spec A §4.1）', () => {
  it('setSecret/getSecret round-trip，明文落在 settings 表 secret: 前缀下', () => {
    settings.setSecret('TMDB_API_KEY', 'plain-key', NOW)
    expect(settings.getSecret('TMDB_API_KEY')).toBe('plain-key')
    expect(settings.get('secret:TMDB_API_KEY')).toBe('plain-key')
  })

  it('白名单外的名字抛错，settings 表不出现任何行', () => {
    expect(() => settings.setSecret('ADMIN_TOKEN' as never, 'x', NOW)).toThrow('unknown secret name')
    expect(settings.get('secret:ADMIN_TOKEN')).toBeNull()
    expect(() => settings.deleteSecret('ADMIN_TOKEN' as never, NOW)).toThrow('unknown secret name')
  })

  it('deleteSecret 后 getSecret → null', () => {
    settings.setSecret('LLM_API_KEY', 'k', NOW)
    settings.deleteSecret('LLM_API_KEY', NOW + 1)
    expect(settings.getSecret('LLM_API_KEY')).toBeNull()
  })

  it('每次写入/删除 bump secrets_version；无行视为 0；普通 set 不 bump', () => {
    expect(settings.secretsVersion()).toBe(0)
    settings.setSecret('ASSRT_TOKEN', 'a', NOW)
    expect(settings.secretsVersion()).toBe(1)
    settings.setSecret('ASSRT_TOKEN', 'b', NOW + 1)
    expect(settings.secretsVersion()).toBe(2)
    settings.deleteSecret('ASSRT_TOKEN', NOW + 2)
    expect(settings.secretsVersion()).toBe(3)
    settings.set('target_languages', 'zh', NOW + 3)
    expect(settings.secretsVersion()).toBe(3)
  })

  it('listSecretMeta 只回 set/source/masked，永不回明文', () => {
    settings.setSecret('JIMAKU_API_KEY', 'jimaku-plain-key-123', NOW)
    const meta = settings.listSecretMeta({ TMDB_API_KEY: 'env-tmdb-key-456' })
    // 9 = SECRET_NAMES.length（Task 1 已定：spec 枚举 9 个，散文的"10"是笔误）。
    expect(meta).toHaveLength(9)
    expect(meta.find((m) => m.name === 'JIMAKU_API_KEY'))
      .toEqual({ name: 'JIMAKU_API_KEY', set: true, source: 'db', masked: 'jim••••123' })
    expect(meta.find((m) => m.name === 'TMDB_API_KEY'))
      .toEqual({ name: 'TMDB_API_KEY', set: true, source: 'env', masked: 'env••••456' })
    expect(meta.find((m) => m.name === 'LLM_API_KEY'))
      .toEqual({ name: 'LLM_API_KEY', set: false, source: 'none', masked: null })
    expect(JSON.stringify(meta)).not.toContain('jimaku-plain-key-123')
    expect(JSON.stringify(meta)).not.toContain('env-tmdb-key-456')
  })
})
```

- [ ] **Step 2: 跑红**

Run: `npx vitest run src/v2/settingsRepo.test.ts`
Expected: FAIL（setSecret 等方法不存在）

- [ ] **Step 3: 实现**

`src/v2/settingsRepo.ts`：文件头 import 追加：

```ts
import { SECRET_NAMES, isSecretName, maskSecretValue, resolveSecret, type SecretName } from './secrets.js'
```

类内 `delete(key)` 方法之后追加：

```ts
  // ── 启动面（spec A §4.1）：secret:* 键空间。明文存 settings 表（决策与理由见 spec §4.1），
  // 任何读回都走 listSecretMeta 打码；getSecret 只供进程内消费（buildAdapters/assemble/setupApi）。
  // 每次写入/删除都 bump secrets_version 计数行——watch 每 tick 比对它决定要不要热重建长命客户端。

  getSecret(name: SecretName): string | null {
    return this.get(`secret:${name}`)
  }

  setSecret(name: SecretName, value: string, now: number): void {
    if (!isSecretName(name)) throw new Error(`unknown secret name: ${name}`)
    this.set(`secret:${name}`, value, now)
    this.bumpSecretsVersion(now)
  }

  deleteSecret(name: SecretName, now: number): void {
    if (!isSecretName(name)) throw new Error(`unknown secret name: ${name}`)
    this.delete(`secret:${name}`)
    this.bumpSecretsVersion(now)
  }

  /** 任何 secret 写入自增的计数器；无行/脏值视为 0。 */
  secretsVersion(): number {
    const raw = this.get('secrets_version')
    const n = raw === null ? 0 : Number(raw)
    return Number.isFinite(n) ? n : 0
  }

  private bumpSecretsVersion(now: number): void {
    this.set('secrets_version', String(this.secretsVersion() + 1), now)
  }

  /** 只回哪些已设置 + 打码预览 + source；永不回明文（Providers 区/setup status 的唯一读面）。 */
  listSecretMeta(env: NodeJS.ProcessEnv): SecretMeta[] {
    return SECRET_NAMES.map((name) => {
      const r = resolveSecret(name, env, (n) => this.getSecret(n))
      return {
        name,
        set: r.source !== 'none',
        source: r.source,
        masked: r.value === null ? null : maskSecretValue(r.value),
      }
    })
  }
```

文件尾（类外）追加类型：

```ts
export interface SecretMeta {
  name: SecretName
  set: boolean
  source: 'env' | 'db' | 'none'
  masked: string | null
}
```

- [ ] **Step 4: 跑绿**

Run: `npx vitest run src/v2/settingsRepo.test.ts src/v2/secrets.test.ts && npm run check`
Expected: 全 PASS（既有用例不受影响）

- [ ] **Step 5: Commit**

```bash
git add src/v2/settingsRepo.ts src/v2/settingsRepo.test.ts
git commit -m "feat: SettingsRepo secret 键空间 + secrets_version 计数器（spec A §4.1/§4.2）"
```

---

### Task 3: buildAdapters — 改走 AdapterConfigResolver

**Files:**
- Modify: `src/adapters/buildAdapters.ts`（全文件逐分支改造；现状 :18-22 `requireEnvForZimuku` 删除）
- Test: `src/adapters/buildAdapters.test.ts`（文件尾追加 describe；**既有用例只改一个**——:71-73 那条 `rejects.toThrow(/ZIMUKU_ENABLED=true requires LLM_BASE_URL/)` 锁的正是本 task 要拆掉的 throw，必须跟着改写，逐字见 Step 3；**其余既有用例一律不改**——默认 cfg = env-only，语义回归由它们锁）

**改造规则（逐分支机械执行，构造函数实参逐字不变）：**

1. import 追加：`import { envOnlyAdapterConfig, type AdapterConfigResolver } from '../v2/secrets.js'`
2. 签名改为：

```ts
export async function buildAdapters(
  emit: (e: FetchEvent) => void = () => {},
  cfg: AdapterConfigResolver = envOnlyAdapterConfig(process.env),
  warn: (msg: string) => void = () => {},
): Promise<FetchAdapter[]> {
```

3. `requireEnvForZimuku` 函数整个删除。
4. `cacheRoot` 行（:31）不动（`SUBTITLE_SCOUT_CACHE_DIR` 是路径不是密钥）。
5. ASSRT 分支：`if (process.env.ASSRT_TOKEN)` → `const assrtToken = cfg.secret('ASSRT_TOKEN').value; if (assrtToken) { ... token: assrtToken ... }`。
6. OpenSubtitles 分支：apiKey/username/password 三个直读改为 `cfg.secret('OPENSUBTITLES_API_KEY').value` 等；入列条件维持"apiKey 非空"（username/password 照旧直接透传，可为 undefined——把 `.value`（`string|null`）转成 `?? undefined` 保持构造签名不变）。
7. ZIMUKU 分支（:54-75）：

```ts
  if (cfg.flag('ZIMUKU_ENABLED').enabled) {
    // spec A §4.3：入列守卫下沉到组装层——LLM 三件套不可解析时跳过本 adapter + 一行 warn，
    // 不再像 requireEnvForZimuku 时代那样在任务执行点 throw（那会把任务打成失败）。
    const llmBaseUrl = cfg.secret('LLM_BASE_URL').value
    const llmApiKey = cfg.secret('LLM_API_KEY').value
    const llmModel = cfg.secret('LLM_MODEL').value
    if (!llmBaseUrl || !llmApiKey || !llmModel) {
      warn('zimuku is enabled but the LLM triple (base URL / API key / model) is not fully configured — skipping the zimuku adapter (captcha solving needs it)')
    } else {
      // 验证码破解：优先模板匹配（0 token），未命中时降级到多模态 LLM。
      // 只在真的撞见挑战页时才会被调用，不是每次 search/resolve 都要打一次 LLM。
      const model = makeModel({ baseUrl: llmBaseUrl, apiKey: llmApiKey, model: llmModel })
      const solve = makeCaptchaSolver({ model, emit })
      const client = new ZimukuClient({
        sessionStore: new ZimukuSessionStore(join(cacheRoot, 'zimuku-session')),
        solve: async png => {
          const result = await solve(png)
          if (result.digits === null) {
            throw new Error('验证码识别失败：模板未命中且 LLM 也无法识别')
          }
          return { digits: result.digits }
        },
        onApiCall: r => emit({ event: 'api_call', provider: 'zimuku', ...r }),
      })
      adapters.push(makeZimukuAdapter(client))
    }
  }
```

（上面这段就是**现状 :54-75 的原文**，只有两处差异：① `makeModel({...})` 的三个值从 `requireEnvForZimuku('LLM_BASE_URL' / 'LLM_API_KEY' / 'LLM_MODEL')` 换成本分支上方刚解析出的 `llmBaseUrl` / `llmApiKey` / `llmModel` 三个局部；② 整块下沉一层缩进进 `else`。`makeModel` / `makeCaptchaSolver` / `ZimukuClient` / `ZimukuSessionStore` / `makeZimukuAdapter` / `join` / `cacheRoot` / `emit` 全是本文件既有的符号，一个都不用新引。那句抛错文案是中文的**开发者内部串**——它进不了 UI，逐字保留，不要顺手翻译。）

8. SUBHD 分支（:77-85）：`process.env.SUBHD_ENABLED === 'true'` → `cfg.flag('SUBHD_ENABLED').enabled`；`baseUrl: process.env.SUBHD_BASE_URL` 保持直读 env（spec §12：env-only 高级项，wizard 不收）。
9. JIMAKU 分支（:88-94）：`if (process.env.JIMAKU_API_KEY)` → `const jimakuKey = cfg.secret('JIMAKU_API_KEY').value; if (jimakuKey) { ... apiKey: jimakuKey ... }`。

- [ ] **Step 1: 写失败测试**

`src/adapters/buildAdapters.test.ts` 尾部追加（注意 import 追加 `makeAdapterConfigResolver`）：

```ts
import { makeAdapterConfigResolver } from '../v2/secrets.js'

describe('buildAdapters · cfg resolver（spec A §4.3：DB 供凭据）', () => {
  // env 全空（beforeEach 已清），凭据全走 cfg——证明 DB 解析路径能驱动所有分支。
  const cfgOf = (secrets: Record<string, string>, flags: Record<string, string> = {}) =>
    makeAdapterConfigResolver({}, (key) => {
      if (key.startsWith('secret:')) return secrets[key.slice('secret:'.length)] ?? null
      if (key.startsWith('provider:')) return flags[key.slice('provider:'.length)] ?? null
      return null
    })

  it('cfg 供 ASSRT_TOKEN → 入列（env 全空）', async () => {
    const adapters = await buildAdapters(() => {}, cfgOf({ ASSRT_TOKEN: 'db-token' }))
    expect(adapters.map(a => a.name)).toEqual(['assrt'])
  })

  it('cfg 供 opensubtitles 三件套 → 入列', async () => {
    const adapters = await buildAdapters(() => {}, cfgOf({ OPENSUBTITLES_API_KEY: 'db-key' }))
    expect(adapters.map(a => a.name)).toEqual(['opensubtitles'])
  })

  it('zimuku：flag 开 + LLM 三件套齐 → 入列', async () => {
    const adapters = await buildAdapters(() => {}, cfgOf(
      { LLM_BASE_URL: 'https://llm.example/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm' },
      { ZIMUKU_ENABLED: 'true' },
    ))
    expect(adapters.map(a => a.name)).toEqual(['zimuku'])
  })

  it('zimuku：flag 开但 LLM 缺 → 跳过 + warn 一行（不再 throw）', async () => {
    const warns: string[] = []
    const adapters = await buildAdapters(
      () => {},
      cfgOf({ LLM_API_KEY: 'k' }, { ZIMUKU_ENABLED: 'true' }),
      (m) => warns.push(m),
    )
    expect(adapters.map(a => a.name)).toEqual([])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('zimuku')
  })

  it('subhd：flag 来自 cfg provider:SUBHD_ENABLED', async () => {
    const adapters = await buildAdapters(() => {}, cfgOf({}, { SUBHD_ENABLED: 'true' }))
    expect(adapters.map(a => a.name)).toEqual(['subhd'])
  })

  it('jimaku：key 来自 cfg', async () => {
    const adapters = await buildAdapters(() => {}, cfgOf({ JIMAKU_API_KEY: 'db-jk' }))
    expect(adapters.map(a => a.name)).toEqual(['jimaku'])
  })

  it('默认 cfg = env-only：env 供 key 的老路径逐字语义不变', async () => {
    process.env.ASSRT_TOKEN = 'env-token'
    const adapters = await buildAdapters()
    expect(adapters.map(a => a.name)).toEqual(['assrt'])
  })
})
```

- [ ] **Step 2: 跑红**

Run: `npx vitest run src/adapters/buildAdapters.test.ts`
Expected: FAIL（buildAdapters 第二/三参数不存在）

- [ ] **Step 3: 改写唯一一条与新语义冲突的既有用例**

`src/adapters/buildAdapters.test.ts` 现状 :71-73 逐字如下——它锁的是"缺 LLM 就 throw"，而本 task 把 zimuku 守卫从 throw 改成 warn+skip，所以它必然变红。**必须改，且只改这一条：**

```ts
  it('rejects with a descriptive error when ZIMUKU_ENABLED=true but LLM_* env is missing (captcha solving needs a multimodal LLM)', async () => {
    process.env.ZIMUKU_ENABLED = 'true'
    await expect(buildAdapters()).rejects.toThrow(/ZIMUKU_ENABLED=true requires LLM_BASE_URL/)
  })
```

整条替换为（env-only 路径下的 warn+skip 回归锁，与 Step 1 的 cfg 版对偶）：

```ts
  it('skips zimuku with a warning when ZIMUKU_ENABLED=true but LLM_* env is missing (captcha solving needs a multimodal LLM)', async () => {
    process.env.ZIMUKU_ENABLED = 'true'
    const warns: string[] = []
    const adapters = await buildAdapters(() => {}, undefined, (m) => warns.push(m))
    expect(adapters.map(a => a.name)).toEqual([])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('zimuku')
  })
```

第二参数显式传 `undefined` = 走默认 `envOnlyAdapterConfig(process.env)`，这样这条锁的就是 **env-only 路径也吃新守卫**（cfg 路径由 Step 1 那条锁）。

- [ ] **Step 4: 按上方改造规则实现**

- [ ] **Step 5: 跑绿**

Run: `npx vitest run src/adapters/buildAdapters.test.ts && npm run check`
Expected: 全 PASS——新 describe 7 例 + 既有 describe 全例（含 Step 3 改写后的那条）。**若除 Step 3 那条之外还有既有用例变红 = 改造规则漂了：回 Step 4 修实现，不准改测试。**

- [ ] **Step 6: Commit**

```bash
git add src/adapters/buildAdapters.ts src/adapters/buildAdapters.test.ts
git commit -m "feat: buildAdapters 改走 AdapterConfigResolver，zimuku 守卫下沉（spec A §4.3）"
```

---

### Task 4: doctor — 新增 checkJimaku / checkSubhd 原语

**Files:**
- Modify: `src/cli/doctor.ts`（追加在 checkZimuku 之后；import 无新增——纯 probe 注入）
- Test: `src/cli/doctor.test.ts`（尾部追加 describe，probe 注入风格同既有 check 用例）

- [ ] **Step 1: 写失败测试**

```ts
describe('checkJimaku / checkSubhd（spec A §4.5 新原语）', () => {
  it('checkJimaku：probe 成功 → ok', async () => {
    const r = await checkJimaku(async () => [{ title: 'x' }])
    expect(r).toMatchObject({ name: 'jimaku', ok: true })
  })
  it('checkJimaku：probe 抛错 → !ok + hint', async () => {
    const r = await checkJimaku(async () => { throw new Error('HTTP 401') })
    expect(r.name).toBe('jimaku')
    expect(r.ok).toBe(false)
    expect(r.hint).toBeDefined()
  })
  it('checkSubhd：2xx/3xx → ok', async () => {
    expect((await checkSubhd(async () => 200)).ok).toBe(true)
    expect((await checkSubhd(async () => 301)).ok).toBe(true)
  })
  it('checkSubhd：5xx → !ok；抛错 → !ok + hint', async () => {
    expect((await checkSubhd(async () => 503)).ok).toBe(false)
    const r = await checkSubhd(async () => { throw new Error('ECONNREFUSED') })
    expect(r.ok).toBe(false)
    expect(r.hint).toBeDefined()
  })
})
```

（import 行同步追加 `checkJimaku, checkSubhd`。）

- [ ] **Step 2: 跑红**

Run: `npx vitest run src/cli/doctor.test.ts`
Expected: FAIL（两个导出不存在）

- [ ] **Step 3: 实现**

`src/cli/doctor.ts` 追加（放在 checkZimuku 之后）：

```ts
/** spec A §4.5：jimaku 最便宜的鉴权调用——带 key 做一次 search。probe 由调用方组（CLI 真打、
 *  validate 端点带凭据组、测试喂假），本函数只负责结果翻译。 */
export async function checkJimaku(probe: () => Promise<unknown>): Promise<DoctorResult> {
  const name = 'jimaku'
  try {
    await probe()
    return { name, ok: true, detail: '带 key 搜索探测通过' }
  } catch (e) {
    return {
      name, ok: false, detail: `搜索探测失败:${String(e)}`,
      hint: '确认 JIMAKU_API_KEY 正确（jimaku.cc 账号设置里复制）；检查网络能否直连 jimaku.cc。',
    }
  }
}

/** spec A §4.5：subhd 首页可达性（无 key 服务，HTTP 2xx/3xx 即通）。probe 返回状态码——
 *  调用方必须用 curlFetch（subhd.ts:224，Node 原生 fetch 的 TLS 指纹会被 subhd 拒）。 */
export async function checkSubhd(probe: () => Promise<number>): Promise<DoctorResult> {
  const name = 'subhd'
  try {
    const status = await probe()
    if (status >= 200 && status < 400) return { name, ok: true, detail: `首页可达（HTTP ${status}）` }
    return { name, ok: false, detail: `首页返回 HTTP ${status}`, hint: 'subhd.me 可达性异常——检查本机网络/代理。' }
  } catch (e) {
    return { name, ok: false, detail: `首页探测失败:${String(e)}`, hint: '检查本机能否直连 subhd.me（注意必须走 curlFetch，Node fetch 的 TLS 指纹会被拒）。' }
  }
}
```

- [ ] **Step 4: 跑绿**

Run: `npx vitest run src/cli/doctor.test.ts && npm run check`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/doctor.ts src/cli/doctor.test.ts
git commit -m "feat: doctor 新增 checkJimaku/checkSubhd 原语（spec A §4.5）"
```

---

### Task 5: `src/dashboard/setupApi.ts` — setup/status DTO + secrets PUT + providers DTO

**Files:**
- Create: `src/dashboard/setupApi.ts`
- Test: `src/dashboard/setupApi.test.ts`

**模块头注释（写进文件）：** 启动面（spec A §4.4）——setup/status、secrets PUT、providers 的纯函数层。不碰 HTTP/socket，server.ts 只做接线。任何返回值都不得含密钥明文；`secret_test:*` 用 `settingsRepo.set` 直写（**不** bump secrets_version——测试不是配置变更，不能触发客户端热重建）。

- [ ] **Step 1: 写失败测试**

创建 `src/dashboard/setupApi.test.ts`：

```ts
// src/dashboard/setupApi.test.ts：spec A §4.4 DTO 形状/推导矩阵/写路径纪律。
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type ScoutDb } from '../v2/db.js'
import { SettingsRepo } from '../v2/settingsRepo.js'
import { buildSetupStatus, buildProviders, putSecret, type SetupDeps } from './setupApi.js'

let db: ScoutDb
let settings: SettingsRepo
const NOW = 1_700_000_000_000

function makeDeps(env: NodeJS.ProcessEnv = {}, over: Partial<SetupDeps> = {}): SetupDeps {
  return {
    settingsRepo: settings,
    env,
    cacheRoot: '/tmp/scout-test-cache',
    rootsCount: () => 0,
    now: () => NOW,
    ...over,
  }
}

beforeEach(() => {
  db = openDb(':memory:')
  settings = new SettingsRepo(db)
})

describe('buildSetupStatus 推导矩阵（spec §4.4 / §3 决策 1）', () => {
  it('全无 → bootstrapComplete=false，全块 none', () => {
    const s = buildSetupStatus(makeDeps())
    expect(s.bootstrapComplete).toBe(false)
    expect(s.tmdb).toEqual({ satisfied: false, source: 'none', masked: null })
    expect(s.llm).toEqual({ satisfied: false, source: 'none', model: null })
    expect(s.providers.assrt.satisfied).toBe(false)
    expect(s.providers.opensubtitles).toEqual({ satisfied: false, source: 'none', hasUsername: false, masked: null })
    expect(s.providers.subhd).toEqual({ enabled: false, source: 'none' })
    expect(s.providers.zimuku).toEqual({ enabled: false, source: 'none', captchaReady: false })
    expect(s.roots).toEqual({ count: 0 })
    expect(s.engineEnabled).toBe(true)   // fail-open 缺省
  })

  it('纯 env（现有部署形态）→ bootstrapComplete=true，source=env', () => {
    const s = buildSetupStatus(makeDeps({
      TMDB_API_KEY: 'env-tmdb-key-000', LLM_BASE_URL: 'https://x/v1', LLM_API_KEY: 'env-llm-key-000', LLM_MODEL: 'deepseek-chat',
    }))
    expect(s.bootstrapComplete).toBe(true)
    expect(s.tmdb.source).toBe('env')
    expect(s.llm).toEqual({ satisfied: true, source: 'env', model: 'deepseek-chat' })
    expect(s.providers.zimuku.captchaReady).toBe(true)   // LLM 已通 → captchaReady
  })

  it('纯 db（wizard 落库形态）→ bootstrapComplete=true，source=db', () => {
    settings.setSecret('TMDB_API_KEY', 'db-tmdb-key-000', NOW)
    settings.setSecret('LLM_BASE_URL', 'https://x/v1', NOW)
    settings.setSecret('LLM_API_KEY', 'db-llm-key-000', NOW)
    settings.setSecret('LLM_MODEL', 'm', NOW)
    const s = buildSetupStatus(makeDeps())
    expect(s.bootstrapComplete).toBe(true)
    expect(s.tmdb).toEqual({ satisfied: true, source: 'db', masked: 'db-••••000' })
    expect(s.llm.source).toBe('db')
  })

  it('混合：TMDB env + LLM db → bootstrapComplete=true', () => {
    settings.setSecret('LLM_BASE_URL', 'https://x/v1', NOW)
    settings.setSecret('LLM_API_KEY', 'k12345678', NOW)
    settings.setSecret('LLM_MODEL', 'm', NOW)
    const s = buildSetupStatus(makeDeps({ TMDB_API_KEY: 'env-tmdb-999' }))
    expect(s.bootstrapComplete).toBe(true)
    expect(s.tmdb.source).toBe('env')
    expect(s.llm.source).toBe('db')
  })

  it('LLM 三缺一直接不满足（哪怕两件都齐）', () => {
    settings.setSecret('LLM_BASE_URL', 'https://x/v1', NOW)
    settings.setSecret('LLM_API_KEY', 'k', NOW)
    const s = buildSetupStatus(makeDeps({ TMDB_API_KEY: 't' }))
    expect(s.bootstrapComplete).toBe(false)
    expect(s.llm.satisfied).toBe(false)
    expect(s.providers.zimuku.captchaReady).toBe(false)
  })

  it('opensubtitles：仅 apiKey → satisfied 且 hasUsername=false；username 单填不成对仍 false；成对才 true', () => {
    settings.setSecret('OPENSUBTITLES_API_KEY', 'os-key-12345', NOW)
    expect(buildSetupStatus(makeDeps()).providers.opensubtitles)
      .toEqual({ satisfied: true, source: 'db', hasUsername: false, masked: 'os-••••345' })
    settings.setSecret('OPENSUBTITLES_USERNAME', 'user', NOW)
    expect(buildSetupStatus(makeDeps()).providers.opensubtitles.hasUsername).toBe(false)
    settings.setSecret('OPENSUBTITLES_PASSWORD', 'pass', NOW)
    expect(buildSetupStatus(makeDeps()).providers.opensubtitles.hasUsername).toBe(true)
  })

  it('provider flags：库 provider:ZIMUKU_ENABLED=true → enabled/db；env 显式 false 压过库', () => {
    settings.set('provider:ZIMUKU_ENABLED', 'true', NOW)
    expect(buildSetupStatus(makeDeps()).providers.zimuku.enabled).toBe(true)
    expect(buildSetupStatus(makeDeps({ ZIMUKU_ENABLED: 'false' })).providers.zimuku)
      .toMatchObject({ enabled: false, source: 'env' })
  })

  it('engineEnabled：显式 false → false；脏值 → true（fail-open spec §4.6）', () => {
    settings.set('engine_enabled', 'false', NOW)
    expect(buildSetupStatus(makeDeps()).engineEnabled).toBe(false)
    settings.set('engine_enabled', '0', NOW)
    expect(buildSetupStatus(makeDeps()).engineEnabled).toBe(true)
  })

  it('整个 DTO 序列化后不含任何明文', () => {
    settings.setSecret('TMDB_API_KEY', 'super-plain-tmdb-key', NOW)
    const json = JSON.stringify(buildSetupStatus(makeDeps()))
    expect(json).not.toContain('super-plain-tmdb-key')
  })
})

describe('putSecret（spec §4.4）', () => {
  it('白名单外 name → 400，库零写入', () => {
    const logs: string[] = []
    const r = putSecret(makeDeps(), { name: 'ADMIN_TOKEN', value: 'x' }, (m) => logs.push(m))
    expect(r.status).toBe(400)
    expect(settings.get('secret:ADMIN_TOKEN')).toBeNull()
    expect(logs).toHaveLength(0)
  })

  it('正常写入 → 200 + round-trip + version bump；审计日志只有 name 没有 value', () => {
    const logs: string[] = []
    const v0 = settings.secretsVersion()
    const r = putSecret(makeDeps(), { name: 'JIMAKU_API_KEY', value: 'jk-super-secret-value' }, (m) => logs.push(m))
    expect(r.status).toBe(200)
    expect(settings.getSecret('JIMAKU_API_KEY')).toBe('jk-super-secret-value')
    expect(settings.secretsVersion()).toBe(v0 + 1)
    expect(logs.join('\n')).toContain('JIMAKU_API_KEY')
    expect(logs.join('\n')).not.toContain('jk-super-secret-value')
  })

  it('空字符串 value = 删除语义', () => {
    settings.setSecret('ASSRT_TOKEN', 'tok', NOW)
    const v0 = settings.secretsVersion()
    const r = putSecret(makeDeps(), { name: 'ASSRT_TOKEN', value: '' }, () => {})
    expect(r.status).toBe(200)
    expect(settings.getSecret('ASSRT_TOKEN')).toBeNull()
    expect(settings.secretsVersion()).toBe(v0 + 1)
  })

  it('value 非字符串 → 400', () => {
    expect(putSecret(makeDeps(), { name: 'ASSRT_TOKEN', value: 42 }, () => {}).status).toBe(400)
  })
})

describe('buildProviders（Providers 区读面）', () => {
  it('7 行分组；密钥打码；secret_test:* 反射为 lastTest；subhd/zimuku 空 secrets 数组', () => {
    settings.setSecret('TMDB_API_KEY', 'tmdb-plain-123456', NOW)
    settings.set(`secret_test:tmdb`, JSON.stringify({ ok: true, at: NOW - 60_000 }), NOW)
    const p = buildProviders(makeDeps())
    expect(p.providers.map((r) => r.id)).toEqual(['tmdb', 'llm', 'assrt', 'opensubtitles', 'jimaku', 'subhd', 'zimuku'])
    const tmdb = p.providers[0]!
    expect(tmdb.secrets).toEqual([{ name: 'TMDB_API_KEY', set: true, source: 'db', masked: 'tmd••••456' }])
    expect(tmdb.lastTest).toEqual({ ok: true, at: NOW - 60_000 })
    expect(p.providers.find((r) => r.id === 'llm')!.secrets.map((s) => s.name))
      .toEqual(['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'])
    expect(p.providers.find((r) => r.id === 'subhd')!.secrets).toEqual([])
    expect(p.providers.find((r) => r.id === 'zimuku')!.lastTest).toBeNull()
    expect(JSON.stringify(p)).not.toContain('tmdb-plain-123456')
  })

  it('secret_test:* 脏 JSON → lastTest=null（防御性解析）', () => {
    settings.set('secret_test:assrt', '{broken', NOW)
    expect(buildProviders(makeDeps()).providers.find((r) => r.id === 'assrt')!.lastTest).toBeNull()
  })
})
```

- [ ] **Step 2: 跑红**

Run: `npx vitest run src/dashboard/setupApi.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

创建 `src/dashboard/setupApi.ts`：

```ts
// src/dashboard/setupApi.ts：启动面（spec A §4.4）——setup/status DTO 组装、secrets PUT、
// providers DTO、validate 薄壳，纯函数层（不碰 HTTP/socket，server.ts 只做接线）。
// 纪律：任何返回值都不得含密钥明文（序列化面只有 masked）；validate 失败走分类文案，
// 不把原始异常 detail 回前端（可能 echo 凭据，spec §8）；secret_test:* 用 settingsRepo.set
// 直写——不 bump secrets_version（测试不是配置变更，不能触发客户端热重建）。

import { generateText } from 'ai'
import type { SettingsRepo } from '../v2/settingsRepo.js'
import { isSecretName, maskSecretValue, resolveProviderFlag, resolveSecret, type SecretName, type SecretSource } from '../v2/secrets.js'
import {
  checkAssrt, checkJimaku, checkLlm, checkOpenSubtitles, checkSubhd, checkTmdb, checkZimuku, withTimeout,
} from '../cli/doctor.js'
import { TmdbClient } from '../adapters/providers/tmdb.js'
import { AssrtClient } from '../adapters/providers/assrt.js'
import { OpenSubtitlesClient } from '../adapters/providers/opensubtitles.js'
import { JimakuClient } from '../adapters/providers/jimaku.js'
import { SUBHD_BASE, curlFetch } from '../adapters/providers/subhd.js'
import { ZIMUKU_BASE } from '../adapters/providers/zimuku.js'
import { detectChallenge } from '../adapters/providers/yunsuo.js'
import { makeModel } from '../agent/llm.js'
import { join } from 'node:path'

// ---------- DTO ----------

export interface SetupSecretStateDTO {
  satisfied: boolean
  source: SecretSource
  masked: string | null
}

export interface SetupStatusDTO {
  bootstrapComplete: boolean
  tmdb: SetupSecretStateDTO
  llm: { satisfied: boolean; source: SecretSource; model: string | null }
  providers: {
    assrt: SetupSecretStateDTO
    opensubtitles: { satisfied: boolean; source: SecretSource; hasUsername: boolean; masked: string | null }
    jimaku: SetupSecretStateDTO
    subhd: { enabled: boolean; source: SecretSource }
    zimuku: { enabled: boolean; source: SecretSource; captchaReady: boolean }
  }
  roots: { count: number }
  engineEnabled: boolean
}

export interface SecretTestDTO { ok: boolean; at: number; error?: string }

export interface ProviderRowDTO {
  id: 'tmdb' | 'llm' | 'assrt' | 'opensubtitles' | 'jimaku' | 'subhd' | 'zimuku'
  secrets: { name: SecretName; set: boolean; source: SecretSource; masked: string | null }[]
  lastTest: SecretTestDTO | null
}

export interface ProvidersDTO { providers: ProviderRowDTO[] }

export interface SetupDeps {
  settingsRepo: SettingsRepo
  env: NodeJS.ProcessEnv
  cacheRoot: string
  rootsCount: () => number
  now: () => number
  /** 测试注入点：按 target 覆盖真实 probe，不真打网络。 */
  probes?: Partial<Record<ValidateTarget, ValidateProbe>>
}

// ---------- setup/status ----------

function secretState(r: { value: string | null; source: SecretSource }, mask: (v: string) => string): SetupSecretStateDTO {
  return {
    satisfied: r.source !== 'none',
    source: r.source,
    masked: r.value === null ? null : mask(r.value),
  }
}

export function buildSetupStatus(deps: SetupDeps): SetupStatusDTO {
  const { settingsRepo, env } = deps
  const dbGet = (key: string) => settingsRepo.get(key)
  const sec = (name: SecretName) => resolveSecret(name, env, (n) => dbGet(`secret:${n}`))
  // 脱敏规则只有一份：从 secrets.ts 导入（Task 1 的 maskSecretValue，≥8 位取首尾 3 位，
  // <8 位整体 ••••）。不要在这里再写一遍——两份实现会各自漂移。
  const mask = maskSecretValue

  const tmdb = sec('TMDB_API_KEY')
  const llmBase = sec('LLM_BASE_URL')
  const llmKey = sec('LLM_API_KEY')
  const llmModel = sec('LLM_MODEL')
  // spec §4.4：LLM satisfied = 三件套全部可解析；source 是展示用近似（混合形态报 env）。
  const llmSatisfied = llmBase.source !== 'none' && llmKey.source !== 'none' && llmModel.source !== 'none'
  const llmSource: SecretSource = !llmSatisfied ? 'none'
    : [llmBase.source, llmKey.source, llmModel.source].includes('env') ? 'env' : 'db'

  const osKey = sec('OPENSUBTITLES_API_KEY')
  const osUser = sec('OPENSUBTITLES_USERNAME')
  const osPass = sec('OPENSUBTITLES_PASSWORD')
  const subhd = resolveProviderFlag('SUBHD_ENABLED', env, dbGet)
  const zimuku = resolveProviderFlag('ZIMUKU_ENABLED', env, dbGet)

  return {
    // spec §3 决策 1：推导式触发——TMDB + LLM 齐 = bootstrap 完成，无独立标志位。
    bootstrapComplete: tmdb.source !== 'none' && llmSatisfied,
    tmdb: secretState(tmdb, mask),
    llm: { satisfied: llmSatisfied, source: llmSource, model: llmModel.value },
    providers: {
      assrt: secretState(sec('ASSRT_TOKEN'), mask),
      opensubtitles: {
        satisfied: osKey.source !== 'none',
        source: osKey.source,
        // spec §4.4：username+password 成对才算 hasUsername；单填视为未填（客户端本就容忍仅 key）。
        hasUsername: osUser.source !== 'none' && osPass.source !== 'none',
        masked: osKey.value === null ? null : mask(osKey.value),
      },
      jimaku: secretState(sec('JIMAKU_API_KEY'), mask),
      subhd: { enabled: subhd.enabled, source: subhd.source },
      // spec §3 步骤 5：captchaReady = LLM 三件套可解析（wizard 展示；后端入列守卫在 buildAdapters）。
      zimuku: { enabled: zimuku.enabled, source: zimuku.source, captchaReady: llmSatisfied },
    },
    roots: { count: deps.rootsCount() },
    // spec §4.6：fail-open——只有显式 'false' 才视为关，脏值/缺省一律开。
    engineEnabled: settingsRepo.get('engine_enabled') !== 'false',
  }
}

// ---------- PUT secrets ----------

export type PutSecretResult =
  | { ok: true; name: SecretName; action: 'set' | 'deleted' }
  | { ok: false; error: string }

export function putSecret(
  deps: SetupDeps,
  body: unknown,
  log: (msg: string) => void,
): { status: number; body: PutSecretResult } {
  const b = (body ?? {}) as { name?: unknown; value?: unknown }
  if (typeof b.name !== 'string' || !isSecretName(b.name)) {
    return { status: 400, body: { ok: false, error: 'unknown secret name' } }
  }
  if (typeof b.value !== 'string') {
    return { status: 400, body: { ok: false, error: 'value must be a string' } }
  }
  const name = b.name
  if (b.value === '') {
    // spec §4.4：空字符串 = 删除语义。
    deps.settingsRepo.deleteSecret(name, deps.now())
    log(`secret deleted: ${name}`)   // 审计日志只记 name，永不记 value（spec §4.4）
    return { status: 200, body: { ok: true, name, action: 'deleted' } }
  }
  deps.settingsRepo.setSecret(name, b.value, deps.now())
  log(`secret set: ${name}`)
  return { status: 200, body: { ok: true, name, action: 'set' } }
}

// ---------- providers DTO ----------

const PROVIDER_SECRETS: Record<ProviderRowDTO['id'], SecretName[]> = {
  tmdb: ['TMDB_API_KEY'],
  llm: ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'],
  assrt: ['ASSRT_TOKEN'],
  opensubtitles: ['OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_USERNAME', 'OPENSUBTITLES_PASSWORD'],
  jimaku: ['JIMAKU_API_KEY'],
  subhd: [],
  zimuku: [],
}

function readLastTest(deps: SetupDeps, target: ValidateTarget): SecretTestDTO | null {
  const raw = deps.settingsRepo.get(`secret_test:${target}`)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as { ok?: unknown; at?: unknown; error?: unknown }
    if (typeof parsed.ok !== 'boolean' || typeof parsed.at !== 'number') return null
    return { ok: parsed.ok, at: parsed.at, ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}) }
  } catch {
    return null
  }
}

export function buildProviders(deps: SetupDeps): ProvidersDTO {
  const meta = deps.settingsRepo.listSecretMeta(deps.env)
  const rows = (Object.keys(PROVIDER_SECRETS) as ProviderRowDTO['id'][]).map((id) => ({
    id,
    secrets: PROVIDER_SECRETS[id].map((name) => meta.find((m) => m.name === name)!),
    lastTest: readLastTest(deps, id),
  }))
  return { providers: rows }
}
```

**本 task 还必须在同一文件尾部落下 validate 段的四条声明。** 理由：上面 `SetupDeps.probes` 与 `readLastTest` 都引用了 `ValidateTarget`/`ValidateProbe`，Task 5 的测试也 `import type { ValidateProbe }`——不落这四条，本 task 的 `npm run check` 必红。逐字追加：

```ts
// ---------- POST validate ----------

export const VALIDATE_TARGETS = ['tmdb', 'llm', 'assrt', 'opensubtitles', 'jimaku', 'subhd', 'zimuku'] as const
export type ValidateTarget = (typeof VALIDATE_TARGETS)[number]

export interface ValidateResultDTO { ok: boolean; detail?: string; error?: string }

/** 与 doctor DoctorResult 同构的最小面（ok/skip/detail/hint）。 */
export type ValidateProbe = () => Promise<{ ok: boolean; skip?: boolean; detail?: string; hint?: string }>
```

validate 的**实现**（`NEXT_STEP_HINT` / `classifyFailure` / `makeProbe` / `toValidateDTO` / `validateSetupTarget` / `sanitizeCredentials`）归 Task 6，接在这四条声明**下方**追加；本 task 不写实现、也不测 validate。

- [ ] **Step 4: 跑绿**

Run: `npx vitest run src/dashboard/setupApi.test.ts && npm run check`
Expected: 全 PASS（`ValidateTarget`/`ValidateProbe` 已由本 task Step 3 末尾的四条声明提供；validate 的实现与测试归 Task 6）

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/setupApi.ts src/dashboard/setupApi.test.ts
git commit -m "feat: setupApi 状态/密钥写入/providers 读面（spec A §4.4）"
```

---

### Task 6: setupApi — validate 薄壳（7 target）

**Files:**
- Modify: `src/dashboard/setupApi.ts`（追加 validate 段）
- Test: `src/dashboard/setupApi.test.ts`（追加 describe）

**设计要点（spec §4.4/§4.5）：**
- target ∈ `tmdb | llm | assrt | opensubtitles | jimaku | subhd | zimuku`；未知 target → 400。
- `credentials` 提供时测请求体里的凭据且**不落库**（wizard 先测后存）；省略时测已解析（env/db）的。
- 每项 10s 超时；未配置 → `{ ok:false, error:'<target> is not configured' }`（doctor 的 skip 语义在 HTTP 层译为红）。
- 结果写 `secret_test:<target>`（`{ok, at, error?}`，走 `settingsRepo.set` 不 bump version）。
- 错误分类（401/403→Invalid credentials；404→check base URL·model；超时/网络→Connection problem）；`detail` 给静态英文下一步提示，**永不回原始异常串**（spec §8）。
- subhd/zimuku **无条件探测可达性**（无 key 服务，wizard 步骤 5 的自动测试与 Settings Test 按钮共用本端点）。

- [ ] **Step 1: 写失败测试**

```ts
// 把 setupApi.test.ts 顶部那行 import 改成（追加 validateSetupTarget / sanitizeCredentials /
// ValidateProbe——本任务的测试三者都用到）：
// import {
//   buildSetupStatus, buildProviders, putSecret, sanitizeCredentials, validateSetupTarget,
//   type SetupDeps, type ValidateProbe,
// } from './setupApi.js'

describe('validateSetupTarget（spec §4.4）', () => {
  it('未知 target → 400', async () => {
    const r = await validateSetupTarget(makeDeps(), { target: 'plex' })
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ ok: false, error: 'unknown validate target' })
  })

  it('probe 绿 → {ok:true}，且 secret_test:tmdb 落库（不 bump secrets_version）', async () => {
    const v0 = settings.secretsVersion()
    const r = await validateSetupTarget(makeDeps({}, {
      probes: { tmdb: async () => ({ ok: true, detail: 'probe ok' }) },
    }), { target: 'tmdb' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, detail: 'probe ok' })
    const row = JSON.parse(settings.get('secret_test:tmdb')!)
    expect(row).toEqual({ ok: true, at: NOW })
    expect(settings.secretsVersion()).toBe(v0)
  })

  it('probe skip → {ok:false, error: "tmdb is not configured"}', async () => {
    const r = await validateSetupTarget(makeDeps({}, {
      probes: { tmdb: async () => ({ ok: true, skip: true, detail: '未配置' }) },
    }), { target: 'tmdb' })
    expect(r.body).toEqual({ ok: false, error: 'tmdb is not configured' })
  })

  it('失败分类：401/403 → Invalid credentials；404 → base URL·model；超时 → Connection problem；detail 给静态提示不回原文', async () => {
    const cases: [string, string][] = [
      ['HTTP 401 Unauthorized', 'Invalid credentials'],
      ['status 403', 'Invalid credentials'],
      ['404 Not Found', 'check the base URL and model'],
      ['timed out after 10000ms', 'Connection problem'],
      ['fetch failed ECONNREFUSED', 'Connection problem'],
    ]
    for (const [raw, expected] of cases) {
      const r = await validateSetupTarget(makeDeps({}, {
        probes: { llm: async () => ({ ok: false, detail: raw }) },
      }), { target: 'llm' })
      expect(r.body.ok).toBe(false)
      expect(r.body.error).toContain(expected)
      expect(r.body.error).not.toContain(raw)   // spec §8：原始串不回前端
      expect(r.body.detail).toBeTruthy()        // 静态下一步提示
    }
  })

  it('probe 自身抛错 → {ok:false}，不炸路由', async () => {
    const r = await validateSetupTarget(makeDeps({}, {
      probes: { assrt: async () => { throw new Error('boom') } },
    }), { target: 'assrt' })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(false)
  })

  it('credentials 白名单外键被丢弃；非字符串/空串被丢弃', async () => {
    let seen: Record<string, string> | null = null
    const probe: ValidateProbe = async () => ({ ok: true })
    const r = await validateSetupTarget(makeDeps({}, {
      probes: { jimaku: probe },
    }), { target: 'jimaku', credentials: { JIMAKU_API_KEY: 'jk-1', HACK: 'x', TMDB_API_KEY: 42, ASSRT_TOKEN: '' } })
    expect(r.status).toBe(200)
    // sanitize 行为由内部 defaultProbe 使用——注入 probe 时只断言路由不炸、不 400。
    // sanitize 本身的单元断言：
    expect(sanitizeCredentials({ JIMAKU_API_KEY: 'jk-1', HACK: 'x', TMDB_API_KEY: 42 as never, ASSRT_TOKEN: '' }))
      .toEqual({ JIMAKU_API_KEY: 'jk-1' })
    void seen
  })
})
```

（`sanitizeCredentials` 一并导出供测试。）

- [ ] **Step 2: 跑红**

Run: `npx vitest run src/dashboard/setupApi.test.ts`
Expected: FAIL（validateSetupTarget/sanitizeCredentials 未导出）

- [ ] **Step 3: 实现**

`src/dashboard/setupApi.ts` 尾部追加。

**注意：`// ---------- POST validate ----------` 分区标题与 `VALIDATE_TARGETS` / `ValidateTarget` / `ValidateResultDTO` / `ValidateProbe` 这四条声明已由 Task 5 Step 3 落在该文件尾部——本 task 从它们下方接着写，不要再声明一遍（同名 `export` 重复 = TS2300/TS2323 直接编译失败）。**

```ts
/** 每个 target 的静态英文下一步提示（spec §4.4 "detail 给用户可执行的下一步"；不回原始异常串）。 */
const NEXT_STEP_HINT: Record<ValidateTarget, string> = {
  tmdb: 'Get a key at themoviedb.org → account Settings → API → API Key (v3 auth).',
  llm: 'All three fields must come from the same provider; the base URL usually ends with /v1.',
  assrt: 'Copy your API token from assrt.net → user center.',
  opensubtitles: 'Create an API key at opensubtitles.com → your profile → API consumers.',
  jimaku: 'Copy your API key from jimaku.cc account settings.',
  subhd: 'subhd.me must be reachable from this host — check the network/proxy.',
  zimuku: 'zimuku.org must be reachable; some networks block or throttle it.',
}

/** spec §4.4 错误三分类。只模式匹配，永不回显原始串（spec §8：异常消息可能 echo 凭据）。 */
export function classifyFailure(rawDetail: string | undefined): string {
  const d = rawDetail ?? ''
  if (/401|403|unauthorized|forbidden|invalid api key|incorrect api key/i.test(d)) {
    return 'Invalid credentials — check the key and try again.'
  }
  if (/404|not found/i.test(d)) {
    return 'Not found — check the base URL and model name.'
  }
  if (/timeout|timed out|ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed|network|socket/i.test(d)) {
    return 'Connection problem — check the network and base URL.'
  }
  return 'Test failed — check the credentials and try again.'
}

/** credentials 入参清洗：只留白名单内的非空字符串键（防注入任意配置）。 */
export function sanitizeCredentials(input: unknown): Partial<Record<SecretName, string>> {
  const out: Partial<Record<SecretName, string>> = {}
  if (input === null || typeof input !== 'object') return out
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (isSecretName(k) && typeof v === 'string' && v !== '') out[k] = v
  }
  return out
}

const VALIDATE_TIMEOUT_MS = 10_000

/** 真实 probe 组（cmdDoctor 同款构造，逐字复刻 cli/index.ts:727-788 的探测形状）。 */
function defaultProbe(
  deps: SetupDeps,
  target: ValidateTarget,
  creds: Partial<Record<SecretName, string>>,
): ValidateProbe {
  const { env, settingsRepo, cacheRoot } = deps
  const notConfigured: ReturnType<ValidateProbe> = Promise.resolve({ ok: true, skip: true, detail: 'not configured' })
  // credentials 优先，其次 env/db 已解析值——"先测后存"与"测已配的"共用一个解析口。
  const cred = (n: SecretName): string | null =>
    creds[n] ?? resolveSecret(n, env, (x) => settingsRepo.get(`secret:${x}`)).value

  switch (target) {
    case 'tmdb': {
      const key = cred('TMDB_API_KEY')
      if (!key) return () => notConfigured
      const tmdb = new TmdbClient({ apiKey: key, baseUrl: env.TMDB_BASE_URL, proxyUrl: env.TMDB_PROXY_URL })
      return () => checkTmdb(() => withTimeout(tmdb.search('movie', 'The Matrix', 1999), VALIDATE_TIMEOUT_MS, 'TMDB').then((h) => h.length))
    }
    case 'llm': {
      const baseUrl = cred('LLM_BASE_URL'); const apiKey = cred('LLM_API_KEY'); const modelName = cred('LLM_MODEL')
      if (!baseUrl || !apiKey || !modelName) return () => notConfigured
      const model = makeModel({ baseUrl, apiKey, model: modelName })
      return () => checkLlm(async () =>
        (await generateText({ model, prompt: '回复"ok"两个字母即可', maxOutputTokens: 1, abortSignal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS) })).text)
    }
    case 'assrt': {
      const token = cred('ASSRT_TOKEN')
      if (!token) return () => notConfigured
      const assrt = new AssrtClient({ token, cacheDir: join(cacheRoot, 'assrt-responses') })
      return () => checkAssrt({ quota: () => withTimeout(assrt.quota(), VALIDATE_TIMEOUT_MS, 'ASSRT') })
    }
    case 'opensubtitles': {
      const apiKey = cred('OPENSUBTITLES_API_KEY')
      if (!apiKey) return () => notConfigured
      const os = new OpenSubtitlesClient({
        apiKey, appUserAgent: 'subtitlescout v0.2.0',
        username: cred('OPENSUBTITLES_USERNAME') ?? undefined,
        password: cred('OPENSUBTITLES_PASSWORD') ?? undefined,
      })
      // The Matrix：配额免费的探测目标（cmdDoctor 同款）。
      return () => checkOpenSubtitles({
        search: () => withTimeout(os.search({ imdbId: 133093, languages: ['zh-cn'] }), VALIDATE_TIMEOUT_MS, 'OpenSubtitles'),
      })
    }
    case 'jimaku': {
      const apiKey = cred('JIMAKU_API_KEY')
      if (!apiKey) return () => notConfigured
      const jk = new JimakuClient({ apiKey })
      return () => checkJimaku(() => withTimeout(jk.search({ query: 'test' }), VALIDATE_TIMEOUT_MS, 'Jimaku'))
    }
    case 'subhd':
      // 无 key 服务，无条件探测可达性（spec §4.4）。必须 curlFetch——Node 原生 fetch 的
      // TLS 指纹会被 subhd 拒（subhd.ts:224 注释）。
      return () => checkSubhd(() =>
        withTimeout(curlFetch(env.SUBHD_BASE_URL ?? SUBHD_BASE, { signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS) }).then((r) => r.status), VALIDATE_TIMEOUT_MS, 'subhd'))
    case 'zimuku':
      // 同上：无条件探测可达性 + 云锁挑战页识别（cmdDoctor 同款构造）。
      return () => checkZimuku({
        fetchHomepage: async () => {
          const res = await withTimeout(fetch(`${ZIMUKU_BASE}/`, { signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS) }), VALIDATE_TIMEOUT_MS, 'zimuku')
          const html = await res.text()
          return { ok: res.ok, challenged: detectChallenge(html) }
        },
      })
  }
}

function toValidateDTO(target: ValidateTarget, r: { ok: boolean; skip?: boolean; detail?: string; hint?: string }): ValidateResultDTO {
  // doctor 的 skip（未配置不算失败）在 HTTP 层译为红：对 wizard 而言"没配"就该是红（spec §4.4）。
  if (r.skip) return { ok: false, error: `${target} is not configured` }
  if (r.ok) return { ok: true, ...(r.detail ? { detail: r.detail } : {}) }
  return { ok: false, error: classifyFailure(r.detail), detail: NEXT_STEP_HINT[target] }
}

export async function validateSetupTarget(
  deps: SetupDeps,
  body: unknown,
): Promise<{ status: number; body: ValidateResultDTO }> {
  const b = (body ?? {}) as { target?: unknown; credentials?: unknown }
  if (typeof b.target !== 'string' || !(VALIDATE_TARGETS as readonly string[]).includes(b.target)) {
    return { status: 400, body: { ok: false, error: 'unknown validate target' } }
  }
  const target = b.target as ValidateTarget
  const probe = deps.probes?.[target] ?? defaultProbe(deps, target, sanitizeCredentials(b.credentials))
  let r: { ok: boolean; skip?: boolean; detail?: string; hint?: string }
  try {
    r = await probe()
  } catch (e) {
    r = { ok: false, detail: `probe threw: ${e instanceof Error ? e.name : 'Error'}` }
  }
  const dto = toValidateDTO(target, r)
  // 上次测试点落库（settingsRepo.set 直写——不 bump secrets_version，测试不是配置变更）。
  try {
    deps.settingsRepo.set(
      `secret_test:${target}`,
      JSON.stringify({ ok: dto.ok, at: deps.now(), ...(dto.error ? { error: dto.error } : {}) }),
      deps.now(),
    )
  } catch { /* 落库失败不挡响应——测试点只是展示面 */ }
  return { status: 200, body: dto }
}
```

- [ ] **Step 4: 跑绿**

Run: `npx vitest run src/dashboard/setupApi.test.ts && npm run check`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/setupApi.ts src/dashboard/setupApi.test.ts
git commit -m "feat: validate 薄壳 7 target 全落地（spec A §4.4/§4.5）"
```

---

### Task 7: daemon — preTick + workPermitted 双新 dep + 五处产工作闸

**Files:**
- Modify: `src/v2/daemon.ts`（DaemonDeps + tickInner；行号锚点基于 2026-08-02 实测）
- Test: `src/v2/daemon.test.ts`（**在 `describe('ScoutDaemon', …)` 之内**尾部追加一个嵌套 describe——复用它的 describe 局部 fixture `makeDeps`(:62)/`logs`(:43)/`seedJob`(:29)/`findJob`(:35)/`now`(:42) 与模块级 `fakeIngestTriggerResult`(:11)；精确插入点见 Step 1）

**实现要点（spec §4.6/§4.7）：**
- DaemonDeps 追加两个 optional 键（缺省 = 今天行为，回归由既有全套用例锁）：

```ts
  /** 启动面（spec A §4.7）：每 tick 最先执行的钩子——cmdWatch 接 secrets_version watcher
   *  （密钥落库 → 同进程热重建长命客户端）。optional：缺省不跑。 */
  preTick?: () => Promise<void>
  /** 启动面（spec A §4.6/§4.7）：产工作许可——engine_enabled(fail-open) ∧ setup 闸(TMDB+LLM 可解析)。
   *  返回 false 时本 tick 跳过全部产工作循环（ingest/orchestrate 心跳/dispatchTranslate/verifySweep/
   *  dispatch）；维护循环（续租/孤儿回收/过期租约回收/trace 修剪/dbMaintenance）不闸。
   *  optional：缺省视为恒 true（今天的行为）。 */
  workPermitted?: () => boolean
```

- 类字段追加：`private lastWorkPermitted: boolean | null = null`（null 初始 = 首个 tick 不记翻转日志）。
- tickInner 插入位置：紧跟 `:149` 的 `const { jobs, lib, log, now } = this.deps` 之后、`:151` 的 `// 0. Heartbeat` 注释之前（**这两行之间是唯一正确的落点**——preTick 必须早于续租/回收循环，又必须晚于 deps 解构，因为下面那句翻转日志用的就是解构出来的 `log`）：

```ts
    // 启动面（spec A §4.7）：preTick 每 tick 最先跑——secrets_version 变了在这里完成热重建，
    // 下面的许可评估与所有闭包就能立刻看到新客户端。
    if (this.deps.preTick) await this.deps.preTick()
    const permitted = this.deps.workPermitted?.() ?? true
    if (this.lastWorkPermitted !== null && this.lastWorkPermitted !== permitted) {
      log(permitted ? 'engine on — work loops resumed' : 'engine off — polling and dispatch are paused')
    }
    this.lastWorkPermitted = permitted
```

- 五处产工作闸（每处在既有条件表达式最前面加 `permitted &&`，其余逐字不动）：
  1. ingest 分支（约 :192）：`if (this.bootIngestPending || timeSinceIngest >= ingestEveryMs) {` → `if (permitted && (this.bootIngestPending || timeSinceIngest >= ingestEveryMs)) {`
  2. orchestrate 心跳（约 :270）：`if (now() - lastOrchestrate >= (this.deps.orchestrateHeartbeatMs ?? ORCHESTRATE_HEARTBEAT_MS)) {` → `if (permitted && now() - lastOrchestrate >= (this.deps.orchestrateHeartbeatMs ?? ORCHESTRATE_HEARTBEAT_MS)) {`
  3. dispatchTranslate（约 :283）：`if (this.deps.dispatchTranslate) {` → `if (permitted && this.deps.dispatchTranslate) {`
  4. verifySweep（约 :305）：`if (this.deps.verifySweep && !this.verifySweepInflight) {` → `if (permitted && this.deps.verifySweep && !this.verifySweepInflight) {`
  5. dispatch（约 :332）：`await this.dispatch()` → `if (permitted) await this.dispatch()`
- **不闸清单（逐字不动）**：step 0 续租、0b 孤儿回收、1 过期租约回收、2c trace 修剪、2d dbMaintenance。
- DaemonDeps.ingestTrigger 的注释（"非 optional：cmdWatch 现在把 TMDB_API_KEY 做成硬性前置"段）末尾追加一句：`（2026-08-02 spec A 修订：硬性前置于 setup 模式废止——缺 key 时 cmdWatch 注入兜底空实现并由 workPermitted 闸住本分支。）`

- [ ] **Step 1: 写失败测试**

`src/v2/daemon.test.ts` —— **插入点：文件第 1093 行 `  })` 之后、第 1094 行（末行）`})` 之前**，也就是追加到**外层 `describe('ScoutDaemon', …)` 之内**，**不是文件末尾**。

原因（必须照做，否则整块 `ReferenceError`）：下面 fixture 用到的 `makeDeps`(:62)、`logs`(:43)、`seedJob`(:29)、`findJob`(:35)、`now`(:42) 全是 `describe('ScoutDaemon', …)`（:18-1094）的**局部**变量，写到文件末尾一个都看不见；只有 `fakeIngestTriggerResult`(:11) 在模块作用域，两处都可见。

本仓库**没有 linter**（无 eslint/prettier/biome 配置），所以下方代码块按原样贴入即可——缩进不影响 `npm test` / `npm run check` 结果，不必为对齐重排 70 行。

```ts
describe('ScoutDaemon · 发动机闸（spec A §4.6/§4.7）', () => {
  it('permitted=false → 产工作全闸、dbMaintenance 照跑、队列原样保留', async () => {
    let permitted = true
    const ingestTrigger = vi.fn(async () => fakeIngestTriggerResult())
    const executeJob = vi.fn(async () => {})
    const dispatchTranslate = vi.fn()
    const dbMaintenance = vi.fn()
    const verifySweep = vi.fn(async () => {})
    const daemon = new ScoutDaemon(makeDeps({
      ingestTrigger, executeJob, dispatchTranslate, dbMaintenance, verifySweep,
      workPermitted: () => permitted,
    }))
    await daemon.tick()   // tick1：permitted → boot ingest 成功，bootIngestPending 清掉
    expect(ingestTrigger).toHaveBeenCalledOnce()
    ingestTrigger.mockClear(); executeJob.mockClear(); dispatchTranslate.mockClear()
    verifySweep.mockClear(); dbMaintenance.mockClear()

    seedJob('s1', 1, now)
    permitted = false
    now += 7 * 3_600_000   // ingest（15min）与 verifySweep（6h）双双到点——不到点没法区分"闸"与"门"
    await daemon.tick()    // tick2：全闸
    expect(ingestTrigger).not.toHaveBeenCalled()
    expect(dispatchTranslate).not.toHaveBeenCalled()
    expect(verifySweep).not.toHaveBeenCalled()
    expect(executeJob).not.toHaveBeenCalled()            // dispatch 被闸 → 无人 claim
    expect(findJob('s1', 1)!.state).toBe('wanted')       // 暂停语义：队列原样保留，重开后续跑
    expect(dbMaintenance).toHaveBeenCalledOnce()         // 维护循环不闸
  })

  it('workPermitted 缺省 → 一切照旧（回归：今天的行为）', async () => {
    const ingestTrigger = vi.fn(async () => fakeIngestTriggerResult())
    const executeJob = vi.fn(async () => {})
    seedJob('s1', 1, now)
    const daemon = new ScoutDaemon(makeDeps({ ingestTrigger, executeJob }))
    await daemon.tick()
    expect(ingestTrigger).toHaveBeenCalledOnce()
    expect(executeJob).toHaveBeenCalledTimes(1)
  })

  it('off→on→off 翻转各记一行日志；首个 tick 不记（null 初始）', async () => {
    let permitted = true
    const daemon = new ScoutDaemon(makeDeps({
      ingestTrigger: vi.fn(async () => fakeIngestTriggerResult()),
      executeJob: vi.fn(async () => {}),
      workPermitted: () => permitted,
    }))
    await daemon.tick()
    expect(logs.filter((l) => l.startsWith('engine '))).toHaveLength(0)
    permitted = false
    await daemon.tick()
    expect(logs.some((l) => l.includes('engine off'))).toBe(true)
    expect(logs.some((l) => l.includes('engine on'))).toBe(false)
    permitted = true
    await daemon.tick()
    expect(logs.some((l) => l.includes('engine on'))).toBe(true)
  })

  it('preTick 每 tick 最先被调用（先于 ingest/dispatch）', async () => {
    const order: string[] = []
    const daemon = new ScoutDaemon(makeDeps({
      ingestTrigger: vi.fn(async () => { order.push('ingest'); return fakeIngestTriggerResult() }),
      executeJob: vi.fn(async () => {}),
      preTick: async () => { order.push('preTick') },
    }))
    await daemon.tick()
    expect(order[0]).toBe('preTick')
    expect(order).toContain('ingest')
  })
})
```

- [ ] **Step 2: 跑红**

Run: `npx vitest run src/v2/daemon.test.ts`
Expected: FAIL（workPermitted/preTick 未实现）

- [ ] **Step 3: 按上方实现要点落地**

- [ ] **Step 4: 跑绿**

Run: `npx vitest run src/v2/daemon.test.ts && npm run check`
Expected: 全新旧 PASS

- [ ] **Step 5: Commit**

```bash
git add src/v2/daemon.ts src/v2/daemon.test.ts
git commit -m "feat: daemon 发动机闸 preTick+workPermitted（spec A §4.6/§4.7）"
```

---

### Task 8: `src/cli/watchClients.ts` — holder + secrets watcher + 闸谓词

**Files:**
- Create: `src/cli/watchClients.ts`
- Test: `src/cli/watchClients.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/cli/watchClients.test.ts：spec A §4.2/§4.7 热重建与闸谓词契约。
import { describe, it, expect, vi } from 'vitest'
import { makeSecretsWatcher, setupSatisfied, engineEnabled } from './watchClients.js'
import { makeAdapterConfigResolver } from '../v2/secrets.js'

describe('makeSecretsWatcher（spec §4.2：版本变了才重建）', () => {
  it('版本不变 → rebuild 不调用', async () => {
    const rebuild = vi.fn(async () => {})
    const tick = makeSecretsWatcher({ readVersion: () => 3, rebuild, log: () => {}, initialVersion: 3 })
    await tick(); await tick()
    expect(rebuild).not.toHaveBeenCalled()
  })

  it('版本 bump → rebuild 一次 + 记 rebuilt 日志；再 tick 不重复', async () => {
    let v = 1
    const logs: string[] = []
    const rebuild = vi.fn(async () => {})
    const tick = makeSecretsWatcher({ readVersion: () => v, rebuild, log: (m) => logs.push(m), initialVersion: 1 })
    await tick()
    expect(rebuild).not.toHaveBeenCalled()   // 首 tick 只建立基线
    v = 2
    await tick()
    expect(rebuild).toHaveBeenCalledOnce()
    expect(logs.some((l) => l.includes('clients rebuilt'))).toBe(true)
    await tick()
    expect(rebuild).toHaveBeenCalledOnce()
  })

  it('rebuild 抛错 → warn 日志 + 下一 tick 重试（seen 不前进）', async () => {
    let v = 1
    let fail = true
    const logs: string[] = []
    const rebuild = vi.fn(async () => { if (fail) throw new Error('boom') })
    const tick = makeSecretsWatcher({ readVersion: () => v, rebuild, log: (m) => logs.push(m), initialVersion: 1 })
    v = 2
    await tick()
    expect(rebuild).toHaveBeenCalledOnce()
    expect(logs.some((l) => l.includes('warn') && l.includes('retry'))).toBe(true)
    fail = false
    await tick()   // 重试成功
    expect(rebuild).toHaveBeenCalledTimes(2)
    expect(logs.some((l) => l.includes('clients rebuilt'))).toBe(true)
    await tick()   // 成功后不再重复
    expect(rebuild).toHaveBeenCalledTimes(2)
  })
})

describe('setupSatisfied（spec §4.7：TMDB + LLM 三件套全部可解析）', () => {
  const cfgOf = (secrets: Record<string, string>) =>
    makeAdapterConfigResolver({}, (k) => (k.startsWith('secret:') ? secrets[k.slice(7)] ?? null : null))
  it('全缺 → false；只有 TMDB → false；LLM 三缺一 → false；全齐 → true', () => {
    expect(setupSatisfied(cfgOf({}))).toBe(false)
    expect(setupSatisfied(cfgOf({ TMDB_API_KEY: 't' }))).toBe(false)
    expect(setupSatisfied(cfgOf({ TMDB_API_KEY: 't', LLM_BASE_URL: 'b', LLM_API_KEY: 'k' }))).toBe(false)
    expect(setupSatisfied(cfgOf({ TMDB_API_KEY: 't', LLM_BASE_URL: 'b', LLM_API_KEY: 'k', LLM_MODEL: 'm' }))).toBe(true)
  })
})

describe('engineEnabled（spec §4.6：fail-open）', () => {
  it('null → true；true → true；显式 false → false；脏值 → true', () => {
    expect(engineEnabled(() => null)).toBe(true)
    expect(engineEnabled(() => 'true')).toBe(true)
    expect(engineEnabled(() => 'false')).toBe(false)
    expect(engineEnabled(() => '0')).toBe(true)
    expect(engineEnabled(() => 'FALSE')).toBe(true)   // 只有精确 'false' 才关
  })
})
```

- [ ] **Step 2: 跑红**

Run: `npx vitest run src/cli/watchClients.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

创建 `src/cli/watchClients.ts`：

```ts
// src/cli/watchClients.ts：setup 模式（spec A §4.2/§4.7）——长命客户端 holder + secrets_version
// watcher（daemon preTick）+ 产工作许可谓词。cmdWatch boot 建一次 holder；wizard 落库
// bump version → 下一 tick rebuild 整体换 current → 同进程点火，容器零重启。
// 消费方纪律：一切长命客户端（tmdb/reasoningModel/realignAdapters/ingestPass/reconcileAll）
// 一律经 clients.current 现取，含 dashboard 注入面（getter 形式，见 Task 12）。

import type { AdapterConfigResolver } from '../v2/secrets.js'

/** 长命客户端 holder——cmdWatch 里所有闭包统一经 .current 取用（spec §4.2 钉死的替换机制）。 */
export interface ClientsHolder<T> { current: T }

export interface SecretsWatcherOpts {
  readVersion: () => number
  /** 版本变化时调用；内部负责重建并整体替换 holder.current。 */
  rebuild: (log: (msg: string) => void) => Promise<void>
  log: (msg: string) => void
  initialVersion: number
}

/** daemon preTick 钩：每 tick 比对 secrets_version，变了才 rebuild。首 tick 只建立基线
 *  （boot 已建过一轮）。rebuild 失败 → warn + seen 不前进 → 下一 tick 自动重试，
 *  旧客户端继续服役（热重建失败绝不弄死正在干活的进程）。 */
export function makeSecretsWatcher(opts: SecretsWatcherOpts): () => Promise<void> {
  let seen = opts.initialVersion
  return async () => {
    const v = opts.readVersion()
    if (v === seen) return
    try {
      await opts.rebuild(opts.log)
      opts.log(`secrets changed (version ${seen} → ${v}) — clients rebuilt`)
      seen = v
    } catch (e) {
      opts.log(`warn: secrets rebuild failed (version ${seen} → ${v}): ${e instanceof Error ? e.message : String(e)} — keeping previous clients, will retry next tick`)
    }
  }
}

/** setup 闸（spec §4.7 步 3）：TMDB + LLM 三件套全部可解析（env 或库）才算满足。
 *  cfg 的 dbGet 是惰性读库，每次调用都是新鲜值——wizard 落库后下一 tick 自然转 true。 */
export function setupSatisfied(cfg: AdapterConfigResolver): boolean {
  return cfg.secret('TMDB_API_KEY').value !== null
    && cfg.secret('LLM_BASE_URL').value !== null
    && cfg.secret('LLM_API_KEY').value !== null
    && cfg.secret('LLM_MODEL').value !== null
}

/** engine_enabled（spec §4.6）：fail-open——只有精确 'false' 才视为关，脏值/缺省一律开。 */
export function engineEnabled(get: (key: string) => string | null): boolean {
  return get('engine_enabled') !== 'false'
}
```

- [ ] **Step 4: 跑绿**

Run: `npx vitest run src/cli/watchClients.test.ts && npm run check`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/watchClients.ts src/cli/watchClients.test.ts
git commit -m "feat: watchClients holder + secrets watcher + 闸谓词（spec A §4.2/§4.7）"
```

---

### Task 9: cli 重接线 — assemble null 耐受 + reconcile-all 双钥匙 + doctor + translate-item + setup 警告行

**Files:**
- Modify: `src/cli/index.ts`（assemble :80-104；**cmdWatch :210 调用点 + :215-218 守卫——过渡桥，见改造 9f，漏了本 task 自己的 Step 3 就跑不绿**；cmdReconcileAll :153-201；cmdDoctor :719-854）
- Modify: `src/cli/translateItemCommand.ts`（`translateLlmCfg` :42-47；`cmdTranslateItem` 内 :259 调用点、:269-270 两行上移、:277 buildAdapters、:300-306 TMDB 直读）
- Modify: `src/cli/watchStartupWarnings.ts`（追加一行函数）
- Test: `src/cli/watchStartupWarnings.test.ts`（追加）
  - **本 task 只新增/改动这一个测试文件。** 另两个候选已实证不需要动：`src/cli/doctor.test.ts` 只 import `checkTmdb` 一族纯函数与 `formatDoctorReport`（`cmdDoctor` 本身没 export、无注入缝，改造 9c 的快照逻辑测不到，硬加断言只能靠造真库，超出本 task 范畴）；`src/cli/translateItemCommand.test.ts` 只 import `translateTimeoutMs / sourceLangDisplayName / sidecarPathFor / readSeriesTargetSubs / locateTranslateIdentity / makeDaemonTranslateRunItem`，六个符号本 task 一个都不碰。**两文件都要跑、都必须保持绿，但一行都不许改**（若变红 = 改造漂了，回去修实现）。

**改造 9a — assemble（:66-104）：** `Assembled.reasoningModel` 类型改 `LanguageModel | null`；`cacheRoot`/`mappings` 两键逐字保留（cmdWatch :210 与 cmdReconcileAll :154 都解构它们）；`export interface Assembled` 的 export 保留（Task 10 的 watchClients 引用此类型）。assemble 改签名 `assemble(cfg: AdapterConfigResolver, warn: (msg: string) => void): Promise<Assembled>`（保持 async），完整体：

```ts
/** 进程级长命客户端的组装产物。setup 模式（spec A §4.7）：LLM/TMDB 任一不可解析 → 对应字段
 *  null + 一行 warn，**不再 exit**——硬性要求上提到门禁层（cmdWatch setup 闸 /
 *  cmdReconcileAll 双钥匙门），由它们决定"拒启动"还是"gated 存活"。
 *  （cacheRoot/mappings 两键的既有注释逐字保留，此处不重抄。） */
export interface Assembled {
  cacheRoot: string
  mappings: PathMapping[]
  tmdb: TmdbClient | null
  reasoningModel: LanguageModel | null
}

async function assemble(cfg: AdapterConfigResolver, warn: (msg: string) => void): Promise<Assembled> {
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  // （mappings 恒 [] 的既有 P7 注释逐字保留）
  const mappings: PathMapping[] = []
  // LLM_EXTRA_BODY 维持 env-only 高级项（spec §12 明确不收进 wizard）。**畸形 JSON 维持
  // exit 2**——缺的放行、错的照死：显式写错的部署配置不是 setup 模式要救的"缺 key"，
  // 行为与今天逐字一致。
  let extraBody: Record<string, unknown> | undefined
  if (process.env.LLM_EXTRA_BODY) {
    try { extraBody = JSON.parse(process.env.LLM_EXTRA_BODY) } catch {
      console.error(`LLM_EXTRA_BODY is not valid JSON: ${process.env.LLM_EXTRA_BODY}`)
      process.exit(2)
    }
  }
  const llmBaseUrl = cfg.secret('LLM_BASE_URL').value
  const llmApiKey = cfg.secret('LLM_API_KEY').value
  const llmModelName = cfg.secret('LLM_MODEL').value
  const reasoningModel = (llmBaseUrl && llmApiKey && llmModelName)
    ? makeModel({ baseUrl: llmBaseUrl, apiKey: llmApiKey, model: llmModelName, extraBody })
    : null
  if (!reasoningModel) warn('LLM is not fully configured (env or dashboard) — reasoning work stays gated until setup completes')
  const tmdbKey = cfg.secret('TMDB_API_KEY').value
  const tmdb = tmdbKey
    ? new TmdbClient({ apiKey: tmdbKey, baseUrl: process.env.TMDB_BASE_URL, proxyUrl: process.env.TMDB_PROXY_URL })
    : null
  if (!tmdb) warn('TMDB_API_KEY is not configured (env or dashboard) — engine stays gated until setup completes')
  return { cacheRoot, mappings, tmdb, reasoningModel }
}
```

**改造 9b — cmdReconcileAll（:153-201）：** 函数头部整体重排——今天 assemble() 打头（:154）、tmdb-only 门禁其后（:155-158）、openDb 再后（:159-160）；新顺序把 openDb 提到 assemble 前（cfg 的 dbGet 需要 settingsRepo；cacheRoot 不依赖任何密钥，与 assemble 内同一表达式先算一份）。函数开头到 `const settingsRepo` 一段替换为：

```ts
async function cmdReconcileAll() {
  // spec A §4.3：assemble 的密钥解析走 cfg（env 或库），cfg 的 dbGet 需要 settingsRepo，
  // settingsRepo 需要 db——cacheRoot 的计算不依赖密钥（与 assemble 内 :81 同一表达式），先算。
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const dbPath = join(cacheRoot, 'scout.db')
  const db = openDb(dbPath)
  const settingsRepo = new SettingsRepo(db)
  // spec A §4.7 步 6：一次性命令不寄居 dashboard，缺 TMDB **或 LLM** 仍 exit 2——
  // assemble 改 null 耐受后这里必须同时查两把钥匙，否则拿 null reasoningModel 跑
  // orchestrator 会运行时炸而非人话拒启动。
  const cfgGate = makeAdapterConfigResolver(process.env, (k) => settingsRepo.get(k))
  if (!setupSatisfied(cfgGate)) {
    console.error('reconcile-all needs TMDB_API_KEY and the LLM triple (base URL, API key, model) — set them in the environment, or finish the setup wizard in the dashboard first.')
    process.exit(2)
  }
  const { tmdb, reasoningModel } = await assemble(cfgGate, (m) => console.error(`warn: ${m}`))
  if (!tmdb || !reasoningModel) {
    // 与门禁同条件的 TS 收窄兜底（闸门评估后密钥被并发删除的竞态），文案与门禁一致。
    console.error('reconcile-all needs TMDB_API_KEY and the LLM triple (base URL, API key, model) — set them in the environment, or finish the setup wizard in the dashboard first.')
    process.exit(2)
  }
```

（紧随其后的 `const jobs = new JobsRepo(db)`、`const lib = new LibraryRepo(db)` 逐字保留；原 :159-160 的 `const dbPath = join(cacheRoot, 'scout.db')` 与紧随其后的 `const db = openDb(dbPath)` 两行、以及原 :167 的 `const settingsRepo = new SettingsRepo(db)` 一行删除——已上移（**按引号里的内容定位、别按行号数**：这三行在本文件里各自唯一；:163-166 那段解释守备目录 DB 化的注释**留在原位**，它属于紧随其后的 `seedRootsFromEnv`）；函数上方 doc 注释里"TMDB_API_KEY 是硬性前置"一句改写为"TMDB_API_KEY 与 LLM 三件套是硬性前置（spec A §4.7 步 6，env 或库皆可）"。`buildIngestPass({ roots: currentRoots, lib, tmdb, ... })` 调用点不动——收窄后 tmdb 非空，签名无需变。）

**改造 9c — cmdDoctor（:719-854）：** 全部直读 env 的密钥改走 `cfg`（doctor 的"假信心"注释所述问题由此闭环）。

**先解决 cfg 从哪来。** 难点：第一个消费点是 `const tmdbKey`（:727），但现状 db 只在 :797（`const dbPath`/`const dbExists`）之后才打开，而且下方每个 `if (dbExists)` 块都各自 `openDb` + `db.close()`——`cfg` 若持一个已被 close 的 handle 会在后续检查项里炸。所以口径是**一次性快照**：在 `const results: DoctorResult[] = []`（:722）之后紧接着插入下面整块，并把原 :797-798 的 `const dbPath = join(cacheRoot, 'scout.db')` 与 `const dbExists = existsSync(dbPath)` 两行**删掉**（它们已上移，重复声明会 TS 报错；:790-796 那段解释 mediaRoots 来源的注释**留在原位**，只把其中"dbPath/dbExists 提前到这里算"一句改成"dbPath/dbExists 已在函数顶部的密钥快照块里算好，这里复用"）：

```ts
  // 启动面（spec A §4.3）：密钥来源无关化——env 与库里的 secret:*/provider:* 都算。doctor 是
  // 一次性快照式体检，这里开一条短命连接把两个键空间读进内存就立刻 close，后面所有检查项都读
  // 这份快照，绝不持有活 handle（下方每个 dbExists 块各自 openDb/close，持 handle 必炸）。
  const dbPath = join(cacheRoot, 'scout.db')
  const dbExists = existsSync(dbPath)
  const secretSnap = new Map<string, string | null>()
  if (dbExists) {
    try {
      const { openDb } = await import('../v2/db.js')
      const snapDb = openDb(dbPath)
      try {
        const repo = new SettingsRepo(snapDb)
        for (const name of SECRET_NAMES) secretSnap.set(`secret:${name}`, repo.get(`secret:${name}`))
        for (const flag of ['SUBHD_ENABLED', 'ZIMUKU_ENABLED']) secretSnap.set(`provider:${flag}`, repo.get(`provider:${flag}`))
      } finally {
        snapDb.close()
      }
    } catch {
      // openDb 抛错（迁移失败/外键违例）时快照留空 → 本次体检退化成 env-only。同一种抛错由下方
      // checkDatabase 转成 ✗ 诊断行，这里不重复报（R2D-20 的既有口径）。
    }
  }
  const cfg = dbExists
    ? makeAdapterConfigResolver(process.env, (k) => secretSnap.get(k) ?? null)
    : envOnlyAdapterConfig(process.env)
```

（`join`/`homedir`/`existsSync`/`SettingsRepo` 本文件顶部已静态 import，无需增补；`SECRET_NAMES`/`makeAdapterConfigResolver`/`envOnlyAdapterConfig` 见下方 import 追加行。）

逐项改造：
- tmdb：`const tmdbKey = cfg.secret('TMDB_API_KEY').value`；缺 key 的 detail 文案尾部追加 `（也可在 dashboard 的 setup wizard 里配置）`。
- assrt / opensubtitles / llm 三处同理换 `cfg.secret(...).value`。
- zimuku：`const zimukuEnabled = cfg.flag('ZIMUKU_ENABLED').enabled`。
- **jimaku 检查块**（新增，放 opensubtitles 之后）：

```ts
  const jimakuKey = cfg.secret('JIMAKU_API_KEY').value
  if (!jimakuKey) {
    results.push({ name: 'jimaku', ok: true, skip: true, detail: '未配置(可选 provider)', hint: '设 JIMAKU_API_KEY 启用（jimaku.cc 账号设置复制）。' })
  } else {
    const jk = new JimakuClient({ apiKey: jimakuKey })
    results.push(await checkJimaku(() => withTimeout(jk.search({ query: 'test' }), 10_000, 'Jimaku')))
  }
```

- **subhd 检查块**（新增，放 zimuku 之后；无条件探测——可达性信息对兜底源判断有用，与启用与否无关）：

```ts
  results.push(await checkSubhd(() =>
    withTimeout(curlFetch(process.env.SUBHD_BASE_URL ?? SUBHD_BASE, { signal: AbortSignal.timeout(10_000) }).then((r) => r.status), 10_000, 'subhd')))
```

- import 追加：`checkJimaku, checkSubhd`（from './doctor.js'）、`JimakuClient`（from '../adapters/providers/jimaku.js'）、`curlFetch, SUBHD_BASE`（from '../adapters/providers/subhd.js'）、`makeAdapterConfigResolver, envOnlyAdapterConfig, SECRET_NAMES`（from '../v2/secrets.js'）、`setupSatisfied`（from './watchClients.js'）。

**改造 9d — translateItemCommand.ts：**
- 顶部 import 追加 `makeAdapterConfigResolver, envOnlyAdapterConfig, SECRET_NAMES, type AdapterConfigResolver`（from '../v2/secrets.js'）、`SettingsRepo`（from '../v2/settingsRepo.js'，如未引入）。
- **`translateLlmCfg`（:42-47）改成吃 resolver。** 现状签名 `function translateLlmCfg(): { baseUrl: string; apiKey: string; model: string }`，全仓只有一个调用点（`cmdTranslateItem` :259；`makeDaemonTranslateRunItem` 不调它，`translateItemCommand.test.ts` 也不 import 它——已 grep 实证）。整个函数替换为：

```ts
function translateLlmCfg(secrets: AdapterConfigResolver): { baseUrl: string; apiKey: string; model: string } {
  if (process.env.TRANSLATE_MODEL) {
    // TRANSLATE_MODEL 分支是 env-only 高级项（spec §12，wizard 不收）——逐字不动。
    return { baseUrl: requireEnv('TRANSLATE_BASE_URL'), apiKey: requireEnv('TRANSLATE_API_KEY'), model: process.env.TRANSLATE_MODEL }
  }
  // spec A §4.3：来源无关化——env 或库都行；缺值仍报错，语义不变。
  const baseUrl = secrets.secret('LLM_BASE_URL').value
  const apiKey = secrets.secret('LLM_API_KEY').value
  const model = secrets.secret('LLM_MODEL').value
  if (!baseUrl || !apiKey || !model) {
    throw new Error('LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 未配置（env 或 dashboard setup wizard 均可）')
  }
  return { baseUrl, apiKey, model }
}
```

（`requireEnv` 仍被 TRANSLATE_* 分支使用，别顺手删它的 import。）

- **`secrets` 在 `cmdTranslateItem` 里的构造落点被三条硬约束卡死：** ① 第一个消费点是 :259 `const cfg = translateLlmCfg()`，紧接着 :261 就 `console.log` 了 `cfg.model`——`secrets` 必须早于 :259；② 现状 `cacheRoot`(:269) / `dbPath`(:270) 反而在 :259 **之后**才声明；③ :272 那个 `if (existsSync(dbPath))` 块打开的 `db` 要活到命令结束，不能提前 close。所以：把 `cacheRoot`/`dbPath` 两行**上移到 :259 之前**（原 :269-270 两行删掉，留着就是重复声明），并在其下插入一次性快照（口径与 9c 一致，独立短命连接，不碰 :272 的 `db`）：

```ts
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const dbPath = join(cacheRoot, 'scout.db')
  // 启动面（spec A §4.3）：密钥可能只在库里。开一条短命连接快照 secret:* 后立刻 close——
  // 下方 :272 区 openDb 拿到的那个 db 要活到命令结束，两者互不干扰。
  const secretSnap = new Map<string, string | null>()
  if (existsSync(dbPath)) {
    try {
      const { openDb } = await import('../v2/db.js')
      const snapDb = openDb(dbPath)
      try {
        const repo = new SettingsRepo(snapDb)
        for (const name of SECRET_NAMES) secretSnap.set(`secret:${name}`, repo.get(`secret:${name}`))
      } finally {
        snapDb.close()
      }
    } catch {
      // 库打不开就退化成 env-only；:272 区既有的 existsSync 分支照原样报它该报的错。
    }
  }
  const secrets = secretSnap.size > 0
    ? makeAdapterConfigResolver(process.env, (k) => secretSnap.get(k) ?? null)
    : envOnlyAdapterConfig(process.env)
```

  接着把 :259 改成 `const cfg = translateLlmCfg(secrets)`。**局部名 `cfg` 保持不变**（它是 LLM 三件套，:261 起的所有 `cfg.baseUrl/cfg.apiKey/cfg.model` 下游逐字不动）；**resolver 必须叫 `secrets`，绝不能也叫 `cfg`——同作用域重复声明，直接编译失败。**
- **:277 的 `await buildAdapters()` 改为吃同一个 resolver：**

```ts
        const adapters = await buildAdapters(() => {}, secrets, (m) => console.log('[translate-item] ' + m))
```

  漏了这处，wizard 存进库的 ASSRT / OpenSubtitles / jimaku 密钥对本命令的源语言外挂搜索腿就完全不可见（Task 3 已让 buildAdapters 吃 resolver，这是它在 CLI 侧的第二个调用点，不接就是半截改造）。
- :300-306 `process.env.TMDB_API_KEY` 直读 → 先存 `const tmdbKey = secrets.secret('TMDB_API_KEY').value`，:300 的条件与 :303 的 `apiKey:` 都改用它（缺值报错文案尾部追加 `（也可在 dashboard 的 setup wizard 里配置）`）。
- **`src/cli/translateItemCommand.test.ts` 不需要任何改动**——它只 import `translateTimeoutMs / sourceLangDisplayName / sidecarPathFor / readSeriesTargetSubs / locateTranslateIdentity / makeDaemonTranslateRunItem`，既不碰 `cmdTranslateItem` 也不碰 `translateLlmCfg`（已 grep 实证）。跑一遍确认全绿即可，**不要为了"适配"去动它**。

**改造 9e — watchStartupWarnings.ts：** 追加（返回 `string`，与 `zeroRootsWarningLine` 同形）：

```ts
/** setup 模式警告（spec A §4.7 步 2）：零 key 首启时 dashboard 已起、引擎闸全关，指路 wizard——
 *  进程不 exit，这行是用户能在日志里找到的唯一路标。 */
export function setupModeWarningLine(): string {
  return '[watch] SETUP MODE: TMDB and LLM are not configured — dashboard is up, finish the setup wizard there; engine stays gated (no scanning, no dispatch) until both are configured'
}
```

测试追加（watchStartupWarnings.test.ts）：

```ts
  it('setupModeWarningLine：含 dashboard 指路 + gated 事实', () => {
    const line = setupModeWarningLine()
    expect(line).toContain('SETUP MODE')
    expect(line).toContain('setup wizard')
    expect(line).toContain('gated')
  })
```

**import 行同步追加（漏了这行新用例直接 TS2304）：** `src/cli/watchStartupWarnings.test.ts:3` 现状只引三个名字——
`import { zeroRootsWarningLine, rootsMismatchWarningLine, zeroSubtitleSourcesWarningLine } from './watchStartupWarnings.js'`（已 grep 核实）——
改成四个：`import { zeroRootsWarningLine, rootsMismatchWarningLine, zeroSubtitleSourcesWarningLine, setupModeWarningLine } from './watchStartupWarnings.js'`。

**改造 9f — cmdWatch 过渡桥（`:210` 调用点 + `:215-218` 守卫）：本 task 必须做，不做的话 Task 9 自己的 Step 3 跑不绿。**

9a 把 `assemble` 改成两参、`reasoningModel` 改成 `LanguageModel | null` 之后，cmdWatch 里那个**零参调用点**立刻是 TS2554；而且 null 会顺流灌进 cmdWatch 内五个把该字段声明成非空 `model: LanguageModel` 的消费点——`:313` `makeFindSubtitleWorker`、`:392` `orchestrateWorkerTaskDeps`、`:433` `makeUnidentifiedFindSubtitleWorker`、`:454`、`:625` `runReconcileAll`（对应声明：`src/agent/findSubtitleWorker.ts:27`、`src/agent/orchestratorAgent.ts:30`、`src/cli/unidentifiedFindSubtitle.ts:108`、`src/v2/reconcileAll.ts:30` 与 `:64`）——再叠 5× TS2322。所以本 task 给 cmdWatch 搭一座**两处改动的过渡桥**，让 Task 9 结束时全仓能编译、行为与今天等价：

- `:210` 现状 `const { cacheRoot, mappings, tmdb, reasoningModel } = await assemble()` 改成：

```ts
  // Task 9 过渡桥：assemble 改两参了，这里先喂 env-only resolver——cmdWatch 的 db 要到 :230
  // 才打开（settingsRepo 在 :245），此处拿不到库背书的 cfg。**Task 10 会把整个 cmdWatch 重构掉**
  // （holder 化 + dashboard 先行 + buildCurrent 内的库背书 cfg），这座桥到那时一起消失。
  const { cacheRoot, mappings, tmdb, reasoningModel } = await assemble(envOnlyAdapterConfig(process.env), (m) => console.error(`warn: ${m}`))
```

- `:215-218` 现状那个 `if (!tmdb)` 守卫改成同时查两把钥匙（`process.exit` 返回 `never`，两个标识符就地收窄成非空，**上面五个消费点一行都不用改**）：

```ts
  if (!tmdb || !reasoningModel) {
    console.error('missing required env var: TMDB_API_KEY / LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（watch 现在依赖 v2/ingest.ts 直连 TMDB 识别文件——不再有 Jellyfin fallback 世界；LLM 三件套缺任一则推理腿无法组装）')
    process.exit(2)
  }
```

**行为等价性说明（诚实版）：** 今天缺 LLM 三件套时是 `assemble` 内的 `requireEnv('LLM_BASE_URL')` 直接 `exit 2`，9a 把这个 exit 挪走了，过渡期由这个守卫接住——**退出码与"人话拒启动"两点逐字不变，报错文案由单键报错合并成一行四键**（过渡态，Task 10 删掉整段）。另：9a 里 `warn(...)` 那行 setup 提示在这条路径上会先打印一次再 exit，属过渡期噪声，不必消除。

**别自作聪明**：过渡期**不要**在这里实现 setup 模式（"缺 key 也照起 dashboard"）——那是 Task 10 的整块重构（`buildCurrent` + `satisfied` + 双闸），提前塞进来会跟 Task 10 的代码打架，也不要给这座桥补测试（cmdWatch 是组合根、无单测束，见 Task 10 说明）。`envOnlyAdapterConfig` 的 import 已由 9c 的 import 追加行（`from '../v2/secrets.js'`，plan 内 9c 末尾那条）覆盖，**不用再加一次**。

- [ ] **Step 1: 跑红** — Run: `npx vitest run src/cli && npm run check`（类型错误 + 缺导出）

- [ ] **Step 2: 按 9a-9e 落地**

- [ ] **Step 3: 跑绿** — Run: `npx vitest run src/cli && npm run check`；再跑全量 `npm test` 确认无连带红。**`npm run check` 若报 cmdWatch 的 TS2554 / 五处 TS2322，就是漏了改造 9f 的过渡桥**（不是 9a 抄错了签名）。**`src/cli/doctor.test.ts` 与 `src/cli/translateItemCommand.test.ts` 必须原样全绿——它们没被改，变红即实现漂移。**

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts src/cli/translateItemCommand.ts src/cli/watchStartupWarnings.ts src/cli/watchStartupWarnings.test.ts
git commit -m "feat: cli 四处走 resolveSecret + setup 警告行（spec A §4.3/§4.7）"
```

---

### Task 10: cmdWatch 重构 — holder 化 + dashboard 先行 + setup 模式点火

**Files:**
- Modify: `src/cli/watchClients.ts`（追加 makeSatisfactionTracker）
- Test: `src/cli/watchClients.test.ts`（追加 2 个用例）
- Modify: `src/cli/index.ts`（cmdWatch :203-717 整体重构；锚点行号基于 2026-08-02 实测）
- Modify: `src/dashboard/server.ts`（10-3b：`DashboardOpts` 的 tmdb/reconcileAll getter 化 + 同文件三个消费点现取现判空）
- Test: `src/dashboard/server.test.ts`（10-3b-③：`start()` helper 的两行透传包装；形参签名不动）

**说明：** cmdWatch 是组合根（composition root），自身无单测束——可测逻辑全部下沉到 watchClients.ts（本任务的 makeSatisfactionTracker + Task 8 的 watcher/谓词）与 daemon.ts（Task 7 的双闸）；组合根的正确性由 `npm run check`（类型）+ 全量测试回归 + **Task 27** 的实机清单（零 key 首启 → wizard → 同进程点火）验收（**Task 26 是全量验证 + 密钥泄漏 grep，不含实机**——实机在 27，由主控执行）。这是既有惯例（cmdWatch 今天也无单测）。

- [ ] **Step 1: 写失败测试**（watchClients.test.ts 尾部追加）

```ts
describe('makeSatisfactionTracker（spec §4.7 步 4：点火日志）', () => {
  it('false→true 记一次 engine live；保持 true 不重复；true→false→true 再记', () => {
    let s = false
    const logs: string[] = []
    const track = makeSatisfactionTracker({ satisfied: () => s, log: (m) => logs.push(m) })
    track()
    expect(logs).toHaveLength(0)
    s = true; track()
    expect(logs.filter((l) => l.includes('engine live'))).toHaveLength(1)
    track()
    expect(logs.filter((l) => l.includes('engine live'))).toHaveLength(1)
    s = false; track()
    s = true; track()
    expect(logs.filter((l) => l.includes('engine live'))).toHaveLength(2)
  })

  it('初始即 true（现有 env 部署升级）→ 永不记（零打扰：不该有假点火行）', () => {
    const logs: string[] = []
    const track = makeSatisfactionTracker({ satisfied: () => true, log: (m) => logs.push(m) })
    track(); track()
    expect(logs).toHaveLength(0)
  })
})
```

import 行同步追加 `makeSatisfactionTracker`。

- [ ] **Step 2: 跑红** — Run: `npx vitest run src/cli/watchClients.test.ts`（导出不存在）

- [ ] **Step 3: watchClients.ts 追加**

```ts
/** 点火日志追踪（spec §4.7 步 4）：setup 闸从"不满足"翻成"满足"的那一刻记一行
 *  'setup complete — engine live'——同进程点火的唯一可观测标志。初始即满足（现有 env
 *  部署升级）时永不记——那一行对老部署是假新闻。 */
export function makeSatisfactionTracker(opts: {
  satisfied: () => boolean
  log: (msg: string) => void
}): () => void {
  let was = opts.satisfied()
  return () => {
    const now = opts.satisfied()
    if (!was && now) opts.log('setup complete — engine live')
    was = now
  }
}
```

- [ ] **Step 4: 跑绿** — Run: `npx vitest run src/cli/watchClients.test.ts`

- [ ] **Step 5: cmdWatch 重构（11 个改造点，全部在 `src/cli/index.ts` 的 cmdWatch 函数体内）**

**10-1 · 函数头重排（:203-255 整体替换顺序）。** 今天的顺序：assemble(:210) → TMDB 门禁 exit(:215-218) → fileLog/log(:221-226) → openDb+repos(:229-236) → settingsRepo+roots 告警（:245-255)。新顺序（setup 模式，spec §4.7 步 1-2：openDb 先行、门禁不 exit、assemble 钉在 openDb 后）：

```ts
async function cmdWatch() {
  // （bootTimeMs/shutdown 两行 + 既有注释逐字保留，:204-219）
  const bootTimeMs = Date.now()
  const shutdown = new AbortController()

  // spec A §4.7：openDb 必须先于 assemble——cfg 的 dbGet 要读 settings 表。cacheRoot 不依赖
  // 任何密钥（与 assemble 内同一表达式），这里先算一份给 fileLog/openDb。
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const fileLog = makeFileLogger(join(cacheRoot, 'logs'), Number(process.env.LOG_RETAIN_DAYS) || 30)
  const log = (msg: string) => {
    const line = `[watch ${new Date().toISOString()}] ${msg}`
    console.log(line)
    fileLog(msg)
  }
  const warn = (msg: string) => log(`warn: ${msg}`)

  const dbPath = join(cacheRoot, 'scout.db')
  const db = openDb(dbPath)
  const jobs = new JobsRepo(db)
  const lib = new LibraryRepo(db)
  const runs = new RunsRepo(db)
  const verifyRepo = new SubtitleVerifyRepo(db)

  const settingsRepo = new SettingsRepo(db)
  settingsRepo.seedRootsFromEnv(process.env.MEDIA_ROOTS, Date.now())
  const currentRoots = (): string[] => settingsRepo.listRoots().map(r => r.path)
  if (currentRoots().length === 0) {
    console.log(zeroRootsWarningLine())
  } else {
    const envRoots = (process.env.MEDIA_ROOTS ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const dbRoots = currentRoots()
    const warning = rootsMismatchWarningLine(envRoots, dbRoots)
    if (warning) console.warn(warning)
  }

  // spec A §4.3：密钥解析器——env 优先、库兜底，dbGet 惰性读库（每 tick/每重建都是新鲜值）。
  const cfg = makeAdapterConfigResolver(process.env, (k) => settingsRepo.get(k))

  // （:257-266 的 targetLanguages/languagesNow 块逐字保留，含债务D5 注释）
```

  原 :210-218 的 assemble 调用与 TMDB 门禁 exit 块**整体删除**（门禁职责由 10-10 的 setup 闸 + 警告行接替）；:221-255 各块内容逐字保留、仅顺序前移（上方已给出）。

**10-2 · WatchClients 类型 + buildCurrent + holder（10-1 块之后插入）。**

```ts
  // spec A §4.2：一切由密钥派生的长命客户端收进 holder，secrets_version 变化时整体重建换
  // current——wizard 落库 → 同进程点火，容器零重启。消费方一律经 clients.current 现取。
  interface WatchClients {
    mappings: PathMapping[]
    tmdb: TmdbClient | null
    reasoningModel: LanguageModel | null
    /** realign 字幕先行的长驻 adapters（:308-310 既有注释：同一次 executeRealign 内几十集
     *  紧凑循环，重建只有 Zimuku session 重读盘的开销——故随 holder 代际重建，不 per-claim）。 */
    realignAdapters: FetchAdapter[]
    /** tmdb 缺席 → null（闸保证不会被调用，null 只是结构性的，spec §4.7 步 5）。 */
    ingestPass: (() => Promise<IngestResult>) | null
    /** !tmdb || !reasoningModel → null。 */
    realignDeps: RealignExecutorDeps | null
    findSubtitleWorkerTaskDeps: {
      lib: LibraryRepo; tmdb: TmdbClient; mediaRoots: string[]; targetLanguage: string; runs: RunsRepo
    } | null
    orchestrateWorkerTaskDeps: {
      lib: LibraryRepo; tmdb: TmdbClient; model: LanguageModel; now: () => number; runs: RunsRepo
    } | null
    /** dashboard POST /api/v2/reconcile-all 的执行体；setup 未满足 → null（端点 503）。 */
    reconcileAll: (() => Promise<ReconcileAllResultDTO>) | null
  }

  /** setup 模式下的 ingest 兜底空实现（spec §4.7：闸保证它实际不会被调到——bootIngestPending
   *  在 setup 期间一直被闸住；它只是让 ingestTrigger/requestIngest 的类型与形状闭合）。 */
  const EMPTY_INGEST_RESULT: IngestResult = { scanned: 0, upserted: 0, parked: 0, removed: 0, changed: false }

  const buildCurrent = async (): Promise<WatchClients> => {
    const { mappings, tmdb, reasoningModel } = await assemble(cfg, warn)
    const satisfied = tmdb !== null && reasoningModel !== null
    const realignAdapters = await buildAdapters(emitProviderEvent, cfg, warn)
    const ingestPass = tmdb
      ? buildIngestPass({
          roots: currentRoots, lib, tmdb,
          targetLanguages: () => languagesNow().targetLanguages,
          originSkipLanguages: () => languagesNow().originSkipLanguages,
          excludeExtras: () => settingsRepo.get('exclude_extras') === 'true',
          hardsubMode: () => {
            const v = settingsRepo.get('hardsub_mode')
            return v === 'agent' || v === 'aggressive' ? v : 'off'
          },
          log,
        })
      : null
    const realignRunEpisode = satisfied
      ? makeRealignRunEpisode({
          runFindSubtitleTask: makeFindSubtitleWorker({
            model: reasoningModel,
            adapters: realignAdapters,
            cacheRoot,
            tmdb,
          }),
          // 债务D5 注记（修订）：targetLanguage 随 holder 代际新鲜求值（secrets 变更驱动重建），
          // 仍非 per-task 新鲜——改语言后下轮 ingest 自然生效，realign 这条路径要等下一次重建。
          targetLanguage: languagesNow().targetLanguages[0],
          mediaRoots: currentRoots(),
        })
      : null
    const realignDeps: RealignExecutorDeps | null = (satisfied && ingestPass && realignRunEpisode)
      ? {
          lib, jobs,
          jf: makeRealignLibraryPort({ lib, roots: currentRoots(), runIngest: ingestPass }),
          tmdb: {
            getSeasonTable: (id) => tmdb.getSeasonTable(id),
            getDetails: (mediaType, id) => tmdb.getDetails(mediaType, id),
            getChineseTitles: (mediaType, id) => tmdb.getChineseTitles(mediaType, id),
          },
          fetchAnimeLists: () => fetchAnimeListsTable(),
          runEpisode: realignRunEpisode,
          now: () => Date.now(),
          log,
          sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
          getSize: (p) => { try { return statSync(p).size } catch { return null } },
          mediaRoots: currentRoots(),
          mappings,
        }
      : null
    const findSubtitleWorkerTaskDeps = satisfied
      ? { lib, tmdb, mediaRoots: currentRoots(), targetLanguage: languagesNow().targetLanguages[0], runs }
      : null
    const orchestrateWorkerTaskDeps = satisfied
      ? { lib, tmdb, model: reasoningModel, now: () => Date.now(), runs }
      : null
    const reconcileAll = (satisfied && ingestPass)
      ? () => runReconcileAll({
          ingest: ingestPass, lib, jobs, model: reasoningModel, tmdb,
          now: () => Date.now(), orchestratorJobId: null,
        })
      : null
    return {
      mappings, tmdb, reasoningModel, realignAdapters, ingestPass,
      realignDeps, findSubtitleWorkerTaskDeps, orchestrateWorkerTaskDeps, reconcileAll,
    }
  }

  const clients: ClientsHolder<WatchClients> = { current: await buildCurrent() }
```

  类型 import 追加：`IngestResult`（from '../v2/ingest.js'）、`FetchAdapter`（from '../adapters/fetchLib.js'）、`ClientsHolder`/`makeSecretsWatcher`/`setupSatisfied`/`engineEnabled`/`makeSatisfactionTracker`（from './watchClients.js'）、`ReconcileAllResultDTO`（from `'../dashboard/apiV2.js'`——**已实证**：`src/dashboard/apiV2.ts:481` `export interface ReconcileAllResultDTO`，且 `src/dashboard/server.ts:16` 就是从 `'./apiV2.js'` 这么 import 的，照抄即可，不需要再 grep）。

  原 :268-284（ingestPass）、:297-361（realignRunEpisode/realignDeps）、:374-383（findSubtitleWorkerTaskDeps）、:385-392（orchestrateWorkerTaskDeps）、:623-628（reconcileAllClosure）五个构造块**整体删除**（内容已收进 buildCurrent；各块既有注释按上方所示随迁或修订）。

  **`emitProviderEvent` 块（原 :286-296，含它上方那段 5 行注释）必须整块前移，落在 10-1 替换段的末尾、10-2 的 `interface WatchClients` 之前。** 这不是可选的整理：`buildCurrent` 的闭包体里引用 `emitProviderEvent`（`realignAdapters: await buildAdapters(emitProviderEvent, cfg, warn)`），而 10-2 末尾就会**立即调用** `buildCurrent()` 去填 holder 的首个代际——`const` 声明有 TDZ，声明点若仍在 :286 那么这次首调会抛 `ReferenceError: Cannot access 'emitProviderEvent' before initialization`（`npm run check` 抓不到，只有运行期炸，而炸点是 `scout watch` 启动，等于容器起不来）。

  前移的落点约束：该块函数体引用 `settingsRepo`（:292 `applyQuotaEvent(e, settingsRepo, Date.now())`）与 `log`，二者在 10-1 新顺序里分别是 `log`(原 :222 那段) 与 `settingsRepo`(原 :245)，所以"10-1 段末尾"同时满足两个依赖，是唯一安全落点。块内容逐字不动（含 `applyQuotaEvent` 调用与两条 provider_error/provider_notice 日志行），只挪位置；上方注释里"提到 realign 依赖块之前（Wall ②）"那句改成"提到 buildCurrent 之前（holder 化后 realign adapters 在 buildCurrent 里组装，需要同一个 emit 函数，且 const 不能被前向引用）"。

**10-3 · ingestTrigger 改 getter 形式（原 :394-398 位置，注释修订）：**

```ts
  // spec A §4.2：ingest pass 经 holder 现取——setup 模式下 ingestPass 为 null，注入兜底空
  // 实现（workPermitted 闸保证它实际不会被调到）；点火后同一闭包自然吃到新 pass。
  const ingestTrigger = makeIngestTrigger({
    ingest: () => clients.current.ingestPass?.() ?? Promise.resolve(EMPTY_INGEST_RESULT),
    jobs, now: () => Date.now(), log,
  })
```

**10-3b · 先改 `DashboardOpts` 的注入面（`src/dashboard/server.ts`），再动 10-4 的调用点。**

**顺序不能反**：10-4 重写的是一个**新建对象字面量**（`src/cli/index.ts:637` `startDashboard({`），TypeScript 对字面量做 excess property check，所以"多传几个字段"不会被当成兼容的超集放过。接口不先改，Step 6 的 `npm run check` 会直接给出四个错：`cacheRoot`/`setupDeps` 各一条 TS2353（对象字面量只能指定已知属性），`tmdb`/`reconcileAll` 各一条 TS2322（`() => …` 不能赋给当前声明的非函数类型）。

编辑 `src/dashboard/server.ts` 的 `DashboardOpts`（接口体 `:39-89`，闭合花括号在 `:89`）。把 `:50` 这行

```ts
  reconcileAll?: () => Promise<ReconcileAllResultDTO>
```

替换为

```ts
  /** spec A §4.2：reconcileAll 改 getter 注入，返回执行体或 null（setup 未满足 → 503，同既有先例）。 */
  reconcileAll?: () => (() => Promise<ReconcileAllResultDTO>) | null
```

把 `:63` 这行

```ts
  tmdb?: Pick<TmdbClient, 'getSeasonTable' | 'getSeasonEpisodes' | 'search'>
```

替换为

```ts
  /** spec A §4.2：tmdb 改 getter 注入（holder 覆盖 dashboard 注入面）——消费处现取现判空，
   *  缺席语义不变（series 详情惰性刷新跳过、tmdb/search 503）。 */
  tmdb?: () => Pick<TmdbClient, 'getSeasonTable' | 'getSeasonEpisodes' | 'search'> | null
  /** spec A：setupApi 的默认实现需要 cacheRoot（assrt 探测的缓存目录）；测试可注入临时目录。 */
  cacheRoot?: string
  /** spec A：setup 三端点的依赖注入（缺席→接真实实现，同 subtitleWriteDeps 的既有注入口惯例）。 */
  setupDeps?: Partial<SetupDeps>
```

同文件 import 追加 `import type { SetupDeps } from './setupApi.js'`（`setupApi.ts` 由 Task 5 建，此时已在）。

**接口改成 getter 之后，`server.ts` 与 `server.test.ts` 里的现有消费点当场编译不过——所以下面两组编辑必须在本步一起改完，不能留给 Task 12。** 这不是"顺手多改"：`grep` 实测这两个字段今天就在被消费（`server.ts:253` 把 `tmdb` 当**值**传进 `refreshSeriesCatalog`、`:608` 调 `tmdb.search(...)`、`:409` `await reconcileAll()`），改成 getter 后依次是 TS2345（函数不能当 `TmdbClient` 形参传）、TS2339（函数类型上没有 `search`）、以及把 `() => Promise<…>` 当 Promise await 的类型错。本 task 的 Step 6 要求 `npm run check` 全绿，这几处躲不过去。

**10-3b-② `src/dashboard/server.ts` 的三个消费点改"现取现判空"**（行号基于 2026-08-02 实测）：

⑴ `:253`（`subDeps.librarySeriesDetail` 闭包内）把

```ts
      if (detail && tmdb) void refreshSeriesCatalog(db, tmdb, id, Date.now()).catch(() => {})
```

替换为

```ts
      const tmdbClient = tmdb?.()
      if (detail && tmdbClient) void refreshSeriesCatalog(db, tmdbClient, id, Date.now()).catch(() => {})
```

（插在 `const detail = buildLibrarySeriesDetail(db, id)` 之后、`return detail` 之前。每次调用现取——holder 换实体后下一次请求自然拿到新的，这正是 getter 化的目的。）

⑵ `:394`（reconcile-all 分支）把 `if (!reconcileAll) { … }` 整段替换为

```ts
        const runReconcileAll = reconcileAll?.()
        if (!runReconcileAll) {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'reconcile-all not configured (TMDB_API_KEY missing?)' }))
          return
        }
```

并把 `:409` 的 `const result = await reconcileAll()` 改为 `const result = await runReconcileAll()`。**位置不动**：取值点就在原 `if (!reconcileAll)` 处，即 method 405 检查之后、`reconcileInFlight` 409 检查之前——非 POST 仍先吃 405，409 仍在 503 之后。503 的 body 文案逐字保留（`server.test.ts:203` 那条用例只断言状态码，但没有理由动文案）。

⑶ `:590`（tmdb/search 分支）把 `if (!tmdb) { … }` 整段替换为

```ts
        const tmdbClient = tmdb?.()
        if (!tmdbClient) {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'tmdb search not configured (TMDB_API_KEY missing?)' }))
          return
        }
```

并把 `:608` 的 `await tmdb.search(mediaType, q)` 改为 `await tmdbClient.search(mediaType, q)`。（⑴ 里也有个 `tmdbClient`，不冲突：那个在 `subDeps.librarySeriesDetail` 的闭包里，这个在 request handler 里，两个作用域不相交。）

**10-3b-③ `src/dashboard/server.test.ts` 的 `start()` helper 透传适配。** 该 helper（`:77-108`）的第 3 参 `reconcileAll` 与第 6 参 `tmdb` 都是**值形参**，`:97`/`:100` 直接透传给 `startDashboard`，接口一改就是 2 条 TS2322。**形参签名一个字都不动**（本文件 30+ 个调用点全是位置传参，动签名会静默错位），只把 `startDashboard({ … })` 字面量里那两行各包一层：

```ts
    reconcileAll: reconcileAll ? () => reconcileAll : undefined,
```

```ts
    tmdb: tmdb ? () => tmdb : undefined,
```

（用三元而不是裸 `() => tmdb ?? null`：既有用例靠"不传 → `opts.tmdb` 是 `undefined`"走缺席分支，包成恒返回 `null` 的 getter 虽语义等价，但保持 `undefined` 更贴近改动前的字节形状。Task 12 的 Step 4 会把这两行再升级成 `extra?.tmdbGetter ?? …` 优先的形式，届时以 Task 12 的写法覆盖本步。）

**留给 Task 12 的部分（本步不做）：** `:194` 解构行追加 `cacheRoot`/`setupDeps: setupDepsOverride`、`setupDeps` 构造块、`RouterDeps` 两行、两条 setup 路由、`start()` 的 `extra` 形参与新增 describe。本步之后 `server.ts` 是一个**自洽**的中间态：getter 注入面就位、缺席语义与今天逐字一致（series 详情惰性刷新跳过、reconcile-all 与 tmdb/search 各自 503），既有 dashboard 测试应全绿。

**10-4 · startDashboard 块上移 + getter 注入（原 :630-679 整块挪到 10-3 之后、daemonDeps 之前）。** 修改点：① `reconcileAll: reconcileAllClosure` → `reconcileAll: () => clients.current.reconcileAll`；② `tmdb,` → `tmdb: () => clients.current.tmdb,`；③ 新增 `cacheRoot,` 与下面这个 `setupDeps` 字段（字段集与 Task 5 的 `SetupDeps` 逐字对齐——`settingsRepo` / `env` / `cacheRoot` / `rootsCount` / `now` 五个必填，**没有** `cfg`，**也没有** `log`：`putSecret` 的 log 是它自己的第三个形参，不走 deps）：

```ts
        setupDeps: {
          env: process.env,
          settingsRepo,
          cacheRoot,
          // SettingsRepo 上的方法名是 listRoots（不是 listMediaRoots）——见 src/v2/settingsRepo.ts:59。
          rootsCount: () => settingsRepo.listRoots().length,
          now: () => Date.now(),
        },
```
④ :643-646 的"tmdb/jobs 硬前置非空"注释修订为"tmdb/reconcileAll 改 getter 注入（spec A §4.2 holder 覆盖 dashboard 注入面）——setup 模式下现取现得 null，端点照既有降级先例 503/跳过"；⑤ requestIngest 块逐字保留（ingestTrigger 已是 getter 形式）。**顺序即语义（spec §4.7 步 1）：dashboard 先于门禁评估与 worker 装配启动——容器健康检查从此在零 key 首启下也转绿。**

**10-5 · setup 模式警告行（startDashboard 块之后）：**

```ts
  // spec A §4.7 步 2：setup 模式不 exit——dashboard 已起，引擎闸全关，日志里留唯一路标。
  if (!setupSatisfied(cfg)) console.warn(setupModeWarningLine())
```

  import 追加 `setupModeWarningLine`（from './watchStartupWarnings.js'，Task 9e 已加）。

**10-6 · handleWorkerTask claim 时护栏（:412-419 payload 解析之后、分支路由之前插入）：**

```ts
    const c = clients.current
    if (!c.tmdb || !c.reasoningModel) {
      // spec §4.7 步 5：闸全关保证不会有工作流到这里——这行只在"任务在飞、密钥被并发
      // 删空"的竞态下可达。不断言、不崩，失败退避留可诊断痕迹（同下方组装兜底的既有口径）。
      jobs.completeError(job.id, 'setup incomplete — engine is gated (secrets removed mid-flight?)', Date.now())
      return
    }
```

  此后分支内所有 `reasoningModel`/`tmdb` 标识符替换为 `c.reasoningModel`/`c.tmdb`（TS 已由 early return 收窄为非空），具体：:433（unidentified 分支 `model: reasoningModel, cacheRoot, tmdb`）、:453-459（find_subtitle 分支 `model: reasoningModel, adapters: await buildAdapters(emitProviderEvent), cacheRoot, tmdb`——buildAdapters 调用同步改 `await buildAdapters(emitProviderEvent, cfg, warn)`，Task 3 新签名）。

**10-7 · 三个 worker 分支读 holder：**
- find_subtitle 分支 :465-477：`...findSubtitleWorkerTaskDeps` → `...c.findSubtitleWorkerTaskDeps`；但 c.findSubtitleWorkerTaskDeps 可空——10-6 护栏已保证 tmdb/model 非空，而 deps 的可空性由 buildCurrent 的同一 `satisfied` 条件决定，护栏通过后 deps 必非空；为不让 TS 撒谎，在 find_subtitle 分支开头加 `const fsDeps = c.findSubtitleWorkerTaskDeps; if (!fsDeps) { jobs.completeError(job.id, 'setup incomplete — engine is gated', Date.now()); return }`，然后 `...fsDeps`。
- realign 分支 :485-490：`...realignDeps` → 同款 `const rDeps = c.realignDeps; if (!rDeps) { ...completeError...; return }`；`jf: makeRealignLibraryPort({ lib, roots, runIngest: ingestPass })` → `runIngest: c.ingestPass ?? (() => Promise.resolve(EMPTY_INGEST_RESULT))`。
- orchestrate 分支 :493：`orchestrateWorkerTaskDeps` → `const oDeps = c.orchestrateWorkerTaskDeps; if (!oDeps) { ...completeError...; return }`。
- translate 分支 :506-510：`await buildAdapters(emitProviderEvent)` → `await buildAdapters(emitProviderEvent, cfg, warn)`；`makeDaemonTranslateRunItem({ db, cfg, fetchSourceSub, tmdb, roots: currentRoots })` 中的 `tmdb` → `c.tmdb`（10-6 已收窄；注意该调用行参名 `cfg` 与本任务的 AdapterConfigResolver `cfg` **撞名**——translate 分支的 `cfg` 是 tryAutoTranslateCfg() 的局部变量，在分支内部遮蔽外层，保留不动即可，TypeScript 与今天行为一致）。

**10-8 · daemonDeps 追加双闸（:535-617 对象字面量尾部、verifySweep 之后）：**

```ts
    // spec A §4.2/§4.7：preTick 每 tick 最先跑——secrets_version 变了在这里完成热重建
    // （整体换 clients.current），随后 satisfaction tracker 在"点火"那一刻记 engine live。
    preTick: async () => {
      await secretsWatcher()
      satisfactionTracker()
    },
    // spec A §4.6/§4.7 步 3：产工作许可 = engine_enabled(fail-open) ∧ setup 闸(TMDB+LLM 可解析)。
    // 维护循环（续租/孤儿回收/dbMaintenance 等）不闸——见 daemon.ts 的五处分支闸。
    workPermitted: () => engineEnabled((k) => settingsRepo.get(k)) && setupSatisfied(cfg),
```

  两者在 daemonDeps 字面量之前定义：

```ts
  const secretsWatcher = makeSecretsWatcher({
    readVersion: () => settingsRepo.secretsVersion(),
    rebuild: async () => { clients.current = await buildCurrent() },
    log,
    initialVersion: settingsRepo.secretsVersion(),
  })
  const satisfactionTracker = makeSatisfactionTracker({ satisfied: () => setupSatisfied(cfg), log })
```

**10-9 · 启动播报（:681-689 区域）逐字保留**，包括 :688-689 的 `zeroSubtitleSourcesWarningLine(process.env)` 调用——**这行不动**。（依据：Task 9 的改造 9e 只是**追加** `setupModeWarningLine()`，并没有改 `zeroSubtitleSourcesWarningLine` 的签名；该函数今天吃的是一个结构化 env 形参（`src/cli/watchStartupWarnings.ts:21-29`，七个可选字符串键），Task 9 全程没碰它。这里**不要**自作主张把它改成吃 resolver：它读的七个键里 `ASSRT_TOKEN` / `OPENSUBTITLES_*` / `JIMAKU_API_KEY` 确实也在 `SECRET_NAMES` 里，改造它是一次独立的、有真实收益的小改动，但**不属于本 plan 的范围**，做了就是漂移。）

**10-10 · 注释批量修订（不实改行为，只订正被 setup 模式推翻的前提陈述）：** :211-214（TMDB 硬前置段——随门禁删除）、:297-301（realign deps 的"tmdb 恒非空"段——改为"holder 代际内非空由 satisfied 保证，见 buildCurrent"）、:316-318（路 A 注释同款）、:386-388（orchestrate deps 同款）、:395-397（ingestTrigger 注释，10-3 已给新文）、:479-481（realign 分支"恒非空"注释）、:492（orchestrate 分支同款）、:619-622（reconcileAllClosure 注释——随 10-2 内的新注释）、:643-646（10-4 已给新文）。

**10-11 · 尾部（:691-717）逐字保留**（`new ScoutDaemon(daemonDeps)`、信号处理、`daemon.run`、db.close）。

- [ ] **Step 6: 类型与回归**

Run: `npm run check && npm test`
Expected: 全绿。类型错误的高发点：① Assembled 新签名在 cmdReconcileAll（Task 9b 已改）；② FetchAdapter/IngestResult/ReconcileAllResultDTO 的 import 路径；③ RealignExecutorDeps 的 `tmdb` 字段形状（facade 三方法——今天 :343-347 的 Pick 形状在 buildCurrent 里逐字保留）；④ buildAdapters 三参签名（Task 3）；⑤ **10-3b 三段必须已经全部落地**——只做了 10-3b 的接口替换、漏掉 10-3b-② / 10-3b-③ 的话，报错分三簇，别把它们误读成 10-4 抄错了字段名：**(a)** `src/cli/index.ts:637` 上 2×TS2353（`cacheRoot`/`setupDeps` 未知属性）+ 2×TS2322（getter 赋给非函数类型）= 接口没改；**(b)** `src/dashboard/server.ts` 上 TS2345（`:253` 把函数当 `TmdbClient` 传）、TS2339（`:608` 函数类型上没有 `search`）、以及 `:409` await 到一个函数而非 Promise = 漏了 10-3b-②；**(c)** `src/dashboard/server.test.ts:97`/`:100` 上 2×TS2322 = 漏了 10-3b-③。

- [ ] **Step 7: Commit**

```bash
git add src/cli/index.ts src/cli/watchClients.ts src/cli/watchClients.test.ts src/dashboard/server.ts src/dashboard/server.test.ts
git commit -m "feat: cmdWatch setup 模式重构——holder 化 + dashboard 先行 + 同进程点火（spec A §4.2/§4.7）"
```

---

### Task 11: apiV2 — SETTINGS_KEYS +3（engine_enabled + provider flags）+ win32 路径形状

**Files:**
- Modify: `src/dashboard/apiV2.ts`（SETTINGS_KEYS :515-518、SETTINGS_VALUE_SCHEMAS :617-626、buildSettings、addMediaRoot/listMediaSubdirs 的绝对路径门）
- Test: `src/dashboard/apiV2.test.ts`（追加 describe + 修既有三处 buildSettings 断言）
- Test: `src/dashboard/router.test.ts`（**只补一个 fixture 字面量的四个属性**，见 Step 4 ④；不加用例）
- Test: `src/dashboard/server.test.ts`（**只补两个穷举 `toEqual` 响应体字面量的四个属性**，见 Step 4 ⑤；不加用例）

- [ ] **Step 1: 写失败测试**

```ts
describe('settings · 启动面三键（spec A §4.4/§4.6）', () => {
  it('PUT 接受 engine_enabled/provider:SUBHD_ENABLED/provider:ZIMUKU_ENABLED 的 true/false', () => {
    const repo = new SettingsRepo(openDb(':memory:'))
    const r = updateSettings(repo, { engine_enabled: 'false', 'provider:SUBHD_ENABLED': 'true', 'provider:ZIMUKU_ENABLED': 'true' }, NOW)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.settings.engine_enabled).toBe('false')
      expect(r.settings['provider:SUBHD_ENABLED']).toBe('true')
    }
  })

  it('三键拒绝非 true/false 值（全有或全无）', () => {
    const repo = new SettingsRepo(openDb(':memory:'))
    expect(updateSettings(repo, { engine_enabled: 'yes' }, NOW).ok).toBe(false)
    expect(updateSettings(repo, { 'provider:ZIMUKU_ENABLED': '1' }, NOW).ok).toBe(false)
    expect(updateSettings(repo, { engine_enabled: 'true', 'provider:SUBHD_ENABLED': 'on' }, NOW).ok).toBe(false)
    expect(repo.get('engine_enabled')).toBeNull()   // 非法批次不落任何键
  })

  it('GET DTO 的 engineEnabled 布尔别名：null→true（fail-open）、false→false、脏值→true', () => {
    const repo = new SettingsRepo(openDb(':memory:'))
    expect(buildSettings(repo).engineEnabled).toBe(true)
    repo.set('engine_enabled', 'false', NOW)
    expect(buildSettings(repo).engineEnabled).toBe(false)
    repo.set('engine_enabled', '0', NOW)
    expect(buildSettings(repo).engineEnabled).toBe(true)
  })
})

describe('媒体根路径形状（spec A §11-1：win32 绝对路径不冤杀）', () => {
  it('listMediaSubdirs/addMediaRoot 接受 C:\\ 形状进入存在性检查（POSIX 上诚实报不存在），相对路径仍拒', () => {
    expect(listMediaSubdirs('C:\\media')).toEqual({ ok: false, error: 'path does not exist' })
    expect(listMediaSubdirs('relative/path')).toEqual({ ok: false, error: 'path must be an absolute path' })
    const repo = new SettingsRepo(openDb(':memory:'))
    expect(addMediaRoot(repo, 'D:/media', NOW)).toEqual({ ok: false, error: 'path does not exist' })
    expect(addMediaRoot(repo, 'media', NOW)).toEqual({ ok: false, error: 'path must be an absolute path' })
  })
})
```

（**import 只需加两个名字**：`src/dashboard/apiV2.test.ts:9-14` 那个从 `'./apiV2.js'` 来的多行 import 块里追加 `updateSettings, addMediaRoot`。**其余全都已经在了，不要重复引**——已实证：`buildSettings` / `listMediaSubdirs` / `SETTINGS_KEYS` 就在 `:11`，`SettingsRepo` 在 `:7`，`openDb` 在 `:5`。`NOW` 也**已存在**（`:22` `const NOW = 1_700_000_000_000`），**不要再声明一个**，重复 `const` 是编译期 TS2451。）

- [ ] **Step 2: 跑红** — Run: `npx vitest run src/dashboard/apiV2.test.ts`

- [ ] **Step 3: 实现（4 处编辑）**

① SETTINGS_KEYS（:515-518）追加三键（**`export` 必须保留**——`SettingsKey`/`SettingsDTO` 两个 type 就在下方靠它派生，且 `src/dashboard/apiV2.test.ts` 与 Task 11 Step 4 的断言都 import 这个常量；漏掉 `export` = 一片 TS2459/TS2304）：

```ts
export const SETTINGS_KEYS = [
  'target_languages', 'hardsub_mode', 'exclude_extras', 'trace_retention_days', 'scan_interval_ms', 'ai_translate_enabled',
  // spec A §4.6：发动机总开关（fail-open，脏值视为开——布尔别名见 buildSettings）。
  'engine_enabled',
  // spec A §4.4：免费源开关与 engine_enabled 同款通道（PUT 白名单 + zod enum），不另起端点。
  'provider:SUBHD_ENABLED', 'provider:ZIMUKU_ENABLED',
] as const
```

② SETTINGS_VALUE_SCHEMAS（:617-626）追加三行：

```ts
  engine_enabled: z.enum(['true', 'false']),
  'provider:SUBHD_ENABLED': z.enum(['true', 'false']),
  'provider:ZIMUKU_ENABLED': z.enum(['true', 'false']),
```

③ buildSettings（:524-528）尾部追加布尔别名（SettingsDTO 类型同步：`Record<SettingsKey, string | null> & { engineEnabled: boolean }`——spec §4.6"settings GET DTO 增 engineEnabled"，hero/banner 共用此数据源；fail-open 判定与 cli 侧 engineEnabled 谓词同一语义，只有精确 'false' 为关）。**函数现状逐字是：**

```ts
export function buildSettings(settingsRepo: Pick<SettingsRepo, 'get'>): SettingsDTO {
  const result = {} as SettingsDTO
  for (const key of SETTINGS_KEYS) result[key] = settingsRepo.get(key)
  return result
}
```

**局部名是 `result`（不是 `dto`）**，所以只把最后一行 `return result` 改成：

```ts
  return { ...result, engineEnabled: settingsRepo.get('engine_enabled') !== 'false' }
```

（`as SettingsDTO` 那句断言不用动：`engineEnabled` 由 return 处的对象字面量补上，交叉类型就齐了。`for` 循环也不动——`engine_enabled` 与两个 `provider:*` 已经在 `SETTINGS_KEYS` 里，循环自动把它们的原始字符串值也带进 DTO，这是 Settings 屏 Providers 区读 toggle 态所需，不要去排除它们。）

④ 绝对路径门——apiV2.ts 顶部（listMediaSubdirs 之前）加：

```ts
/** spec A §11-1：绝对路径判定——POSIX 的 `/` 或 win32 的盘符（`C:\`/`D:/`）。resolve/existsSync
 *  在各平台原生处理盘符；POSIX 上盘符路径过不了存在性检查，诚实报"不存在"而不是冤杀形状。 */
const isAbsoluteMediaPath = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)
```

`listMediaSubdirs` 与 `addMediaRoot` 里的 `if (!rawPath.startsWith('/'))` 均改为 `if (!isAbsoluteMediaPath(rawPath))`。

- [ ] **Step 4: 修既有的六处 SettingsDTO 断言，分布在三个文件（不做这步 `npm test` 必红）**

`SETTINGS_KEYS` 加了三键、DTO 多了 `engineEnabled`，穷举 `toEqual` 字面量与键集比对全部会失败。**①②③ 在 `src/dashboard/apiV2.test.ts`（`describe('buildSettings…')`）；④ 在 `src/dashboard/router.test.ts`（编译期错误 TS2739 缺属性，`npm run check` 直接红）；⑤ 是两处，在 `src/dashboard/server.test.ts`（端到端响应体，运行期 "unexpected keys" 红）——三个文件都别漏。** 逐字改：

① `:345` 附近"全部未设置时六键皆 null"的字面量（描述文字也一并改成"九键皆 null + engineEnabled 兜底为 true"）：

```ts
    expect(buildSettings(settings)).toEqual({
      target_languages: null, hardsub_mode: null, exclude_extras: null,
      trace_retention_days: null, scan_interval_ms: null, ai_translate_enabled: null,
      engine_enabled: null, 'provider:SUBHD_ENABLED': null, 'provider:ZIMUKU_ENABLED': null,
      // engine_enabled 未设置 → fail-open 兜底为 true（本任务 ③ 的布尔别名）。
      engineEnabled: true,
    })
```

② `:355` 附近"已设置的键原样带出字符串值"的字面量：

```ts
    expect(buildSettings(settings)).toEqual({
      target_languages: 'zh,en', hardsub_mode: 'aggressive', exclude_extras: null,
      trace_retention_days: null, scan_interval_ms: null, ai_translate_enabled: null,
      engine_enabled: null, 'provider:SUBHD_ENABLED': null, 'provider:ZIMUKU_ENABLED': null,
      engineEnabled: true,
    })
```

③ `:365` 的键集比对（`Object.keys(dto).sort()` 那条——它在 `it('白名单外的 key 不出现在 DTO 里…')` 里面；上一条字面量的尾行是 `:358`，别改错）——DTO 现在比白名单多一个**派生**键 `engineEnabled`，断言要显式带上它（这正是这条断言的价值：以后再加派生键必须在这里登记，不能悄悄长出来）：

```ts
    expect(Object.keys(dto).sort()).toEqual([...SETTINGS_KEYS, 'engineEnabled'].sort())
```

④ **`src/dashboard/router.test.ts:23-26`**（**另一个文件**）——文件头 fixture 区有个显式标注类型的 `SettingsDTO` 字面量（`SettingsDTO` 于 `:5` 从 `./apiV2.js` import），六键写死，加了三键 + 派生键后它缺四个属性，`tsc` 直接 TS2739。现状逐字是：

```ts
const settingsDTO: SettingsDTO = {
  target_languages: 'zh,en', hardsub_mode: null, exclude_extras: null,
  trace_retention_days: null, scan_interval_ms: null, ai_translate_enabled: null,
}
```

改为：

```ts
const settingsDTO: SettingsDTO = {
  target_languages: 'zh,en', hardsub_mode: null, exclude_extras: null,
  trace_retention_days: null, scan_interval_ms: null, ai_translate_enabled: null,
  engine_enabled: null, 'provider:SUBHD_ENABLED': null, 'provider:ZIMUKU_ENABLED': null,
  engineEnabled: true,
}
```

（这个 fixture 只是喂 router 的 fake deps 让路由表用例跑通，值本身不被断言，所以照上方补齐即可，**不要**顺手给 router.test.ts 加新用例——engine_enabled 的路由行为由 Task 11 之外的任务管。另：`grep -rn "SettingsDTO" src` 已实证，全仓只有这一处**显式标注类型**的 DTO 字面量——但**没标类型的穷举响应体字面量还有两处**，见下面 ⑤。）

⑤ **`src/dashboard/server.test.ts` 两处**（**第三个文件**）——这两条是端到端断言：请求打到真起的 server，响应体来自 `src/dashboard/server.ts:240`（`settings: () => buildSettings(settingsRepo)`）与 `:465`（`updateSettings(...)`，而 `updateSettings` 的成功分支返回的正是 `buildSettings(settingsRepo)`，`src/dashboard/apiV2.ts:657`）。两边都会各多出四个属性，而 `toEqual` 是穷举比对 → 运行期红（"unexpected keys"），`npm test` 挂。**按 `it(...)` 标题定位，别按行号数**：

- `it('GET /api/v2/settings 反映 DB 里已写入的行为键，未设置为 null')` 里的字面量（现状 `:365-368`）：

```ts
      expect(await res.json()).toEqual({
        target_languages: 'zh,en', hardsub_mode: null, exclude_extras: null,
        trace_retention_days: null, scan_interval_ms: null, ai_translate_enabled: null,
        engine_enabled: null, 'provider:SUBHD_ENABLED': null, 'provider:ZIMUKU_ENABLED': null,
        engineEnabled: true,
      })
```

- `it('写入白名单键，回显全量 settings')` 里的字面量（现状 `:443-446`，缩进比上一条多两格）：

```ts
        expect(await res.json()).toEqual({
          target_languages: 'zh,en', hardsub_mode: 'aggressive', exclude_extras: null,
          trace_retention_days: null, scan_interval_ms: null, ai_translate_enabled: null,
          engine_enabled: null, 'provider:SUBHD_ENABLED': null, 'provider:ZIMUKU_ENABLED': null,
          engineEnabled: true,
        })
```

（两处都只补属性，**不改被断言的既有值、不加新用例**：这两条用例锁的是"PUT 白名单 + GET 回显"这条既有链路，engine_enabled 自己的行为由本 task Step 1 的新 describe 在 apiV2.test.ts 里锁。`engineEnabled: true` 是因为两个用例都没写过 `engine_enabled` 键 → fail-open 兜底为 true，与 ①② 同理。）

- [ ] **Step 5: 跑绿** — Run: `npx vitest run src/dashboard/apiV2.test.ts && npm run check && npm test`
Expected: 全绿。**红在 `server.test.ts` 的两条 settings 用例上 = 漏了 Step 4 ⑤**；红在 `npm run check` 的 `router.test.ts` 上 = 漏了 ④。

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/apiV2.ts src/dashboard/apiV2.test.ts src/dashboard/router.test.ts src/dashboard/server.test.ts
git commit -m "feat: settings 白名单 +engine_enabled/provider flags + win32 路径形状（spec A §4.4/§4.6/§11-1）"
```

---

### Task 12: server.ts — setup 三路由接线 + tmdb/reconcileAll getter 化

**Files:**
- Modify: `src/dashboard/router.ts`（RouterDeps +2、路由表 +2）
- Test: `src/dashboard/router.test.ts`（fake deps +2 stub、路由用例 +2）
- Modify: `src/dashboard/server.ts`（解构行 +cacheRoot/+setupDeps、`setupDeps` 构造块、RouterDeps 两行、PUT secrets + POST validate 两个异步分支。**`DashboardOpts` 的字段变更与 tmdb/reconcileAll 三个消费点已在 Task 10 的 10-3b 落地，本 task 只核对**）
- Test: `src/dashboard/server.test.ts`（start() helper 追加 `extra` 形参 + 新增 describe。**两行 getter 透传已在 10-3b-③ 落地，本 task 把它们升级成 `extra` 优先形**）

- [ ] **Step 1: router 失败测试**（router.test.ts）

fake deps 字面量（:84-102）追加两行：

```ts
  setupStatus: () => setupStatusDTO,
  providers: () => providersDTO,
```

文件头部 fixture 区追加（形状照 Task 5 的 SetupStatusDTO/ProvidersDTO 定义，最小合法值）：

```ts
const setupStatusDTO = {
  bootstrapComplete: false,
  tmdb: { satisfied: false, source: 'none', masked: null },
  llm: { satisfied: false, source: 'none', model: null },
  providers: {
    assrt: { satisfied: false, source: 'none', masked: null },
    // masked 是必填字段（Task 5 的 opensubtitles 形状是 satisfied/source/hasUsername/masked
    // 四件套），漏了它 satisfies 直接报错。
    opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
    jimaku: { satisfied: false, source: 'none', masked: null },
    subhd: { enabled: false, source: 'none' },
    zimuku: { enabled: false, source: 'none', captchaReady: false },
  },
  roots: { count: 0 },
  engineEnabled: true,
} satisfies SetupStatusDTO
// ProvidersDTO 的字段名是 providers（不是 rows）——见 Task 5 的 `interface ProvidersDTO`。
const providersDTO = { providers: [] } satisfies ProvidersDTO
```

import 追加两类型（from './setupApi.js'）。

用例追加：

```ts
  it('GET /api/v2/setup/status → 200 + DTO 直出', () => {
    const r = call('/api/v2/setup/status')
    expect(r.status).toBe(200)
    expect(r.json).toBe(setupStatusDTO)
  })

  it('GET /api/v2/setup/providers → 200 + DTO 直出', () => {
    const r = call('/api/v2/setup/providers')
    expect(r.status).toBe(200)
    expect(r.json).toBe(providersDTO)
  })
```

- [ ] **Step 2: 跑红** — Run: `npx vitest run src/dashboard/router.test.ts`（RouterDeps 缺键类型错 + 路由 404）

- [ ] **Step 3: router.ts 实现**

RouterDeps 追加（注释照既有风格）：

```ts
  /** spec A §4.4：GET /api/v2/setup/status——bootstrap 完成度推导（wizard 入口判定）。 */
  setupStatus: () => SetupStatusDTO
  /** spec A §4.4/§5.4：GET /api/v2/setup/providers——Providers 区行数据（打码值/source/上次测试点）。 */
  providers: () => ProvidersDTO
```

路由表追加（放 settings 组之后，注释照既有分组风格）：

```ts
  // ---- setup（spec A：bootstrap wizard 与 Providers 区）----
  if (pathname === '/api/v2/setup/status') return { status: 200, json: deps.setupStatus() }
  if (pathname === '/api/v2/setup/providers') return { status: 200, json: deps.providers() }
```

import 追加 `type { SetupStatusDTO, ProvidersDTO }`（from './setupApi.js'）。

- [ ] **Step 4: server 失败测试**（server.test.ts）

start() helper 签名与透传适配（`:77-108`）。**铁律：新形参一律加在参数表末尾**——本文件 30+ 个调用点全是位置传参（如 `start(dist, 'tok', undefined, undefined, undefined, tmdbStub)`），插在中间会静默错位、且不一定报类型错。

① `tmdb?: FakeTmdb`（第 6 参）与 ② `reconcileAll`（第 3 参）两个"值形参"**原地保留**，只改透传形状；③ 在 `subtitleCompareDeps`（第 9 参）之后追加**一个**可选选项对象形参 `extra`（第 10 参）——不是三四个位置参数：十几个位置形参的调用点会写成一长串 `undefined`，抄错的概率远高于收益。

```ts
  // spec A §4.2/§4.4：新依赖统一走末尾选项对象。tmdbGetter / reconcileAllGetter 专供"点火语义"
  // 用例——同一个进程里让 getter 从 null 翻成实体，断言 503 → 200，不重启 dashboard。
  extra?: {
    setupDeps?: Partial<SetupDeps>
    cacheRoot?: string
    tmdbGetter?: () => FakeTmdb | null
    reconcileAllGetter?: () => (() => Promise<{ dispatchedFindSubtitle: number; dispatchedRealign: number; spawnedSiblings: number; summary: string }>) | null
  },
): Promise<{ base: string }> {
```

（`reconcileAllGetter` 的返回体形状**逐字照抄第 3 参 `reconcileAll` 现有的内联字面量**（`:79`）——本文件没 import `ReconcileAllResultDTO`，别为它新引类型。）

`startDashboard({...})` 里对应四键：

```ts
    tmdb: extra?.tmdbGetter ?? (tmdb ? () => tmdb : undefined),
    reconcileAll: extra?.reconcileAllGetter ?? (reconcileAll ? () => reconcileAll : undefined),
    cacheRoot: extra?.cacheRoot,
    setupDeps: extra?.setupDeps,
```

（**前两行是对 10-3b-③ 已写下的 `reconcileAll: reconcileAll ? () => reconcileAll : undefined` / `tmdb: tmdb ? () => tmdb : undefined` 的原地升级**——不是新增行，用上面的写法整行覆盖即可；后两行 `cacheRoot`/`setupDeps` 是本 task 首次新增。getter 优先于值形参；两者同时给时 getter 赢——点火用例只给 getter，既有 30+ 调用点只给值形参，互不干扰。`??` 右边的三元加了括号：这里虽然不触发 ES2020 的 `??`/`||` 混用禁令，但 `?:` 的优先级低于 `??`，不加括号语义就变了。）

新增 describe（auth 走既有 `?token=tok` 惯例）：

```ts
describe('setup 面端点（spec A §4.4）', () => {
  it('GET /api/v2/setup/status：全新零配置 → bootstrapComplete=false、engineEnabled=true（fail-open）', async () => {
    const { base } = await start(distWith('<!doctype html>'), 'tok')
    const r = await fetch(`${base}/api/v2/setup/status?token=tok`)
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.bootstrapComplete).toBe(false)
    expect(body.engineEnabled).toBe(true)
    expect(body.tmdb.satisfied).toBe(false)
  })

  it('PUT /api/v2/settings/secrets：白名单外 400、合法写入后 status 反映 source=db + 打码、空值删除', async () => {
    const { base } = await start(distWith('<!doctype html>'), 'tok')
    const bad = await fetch(`${base}/api/v2/settings/secrets?token=tok`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'AWS_SECRET', value: 'x' }),
    })
    expect(bad.status).toBe(400)
    const put = await fetch(`${base}/api/v2/settings/secrets?token=tok`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'TMDB_API_KEY', value: 'abcdefghij' }),
    })
    expect(put.status).toBe(200)
    const status = await (await fetch(`${base}/api/v2/setup/status?token=tok`)).json()
    expect(status.tmdb.satisfied).toBe(true)
    expect(status.tmdb.source).toBe('db')
    expect(status.tmdb.masked).not.toContain('abcdefghij')   // 永不回读明文
    const del = await fetch(`${base}/api/v2/settings/secrets?token=tok`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'TMDB_API_KEY', value: '' }),
    })
    expect(del.status).toBe(200)
    const after = await (await fetch(`${base}/api/v2/setup/status?token=tok`)).json()
    expect(after.tmdb.satisfied).toBe(false)
  })

  it('POST /api/v2/setup/validate：未知 target → 400；未配置 target → 200 + ok:false', async () => {
    const { base } = await start(distWith('<!doctype html>'), 'tok')
    const unknown = await fetch(`${base}/api/v2/setup/validate?token=tok`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'github' }),
    })
    expect(unknown.status).toBe(400)
    const r = await fetch(`${base}/api/v2/setup/validate?token=tok`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'assrt' }),
    })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.ok).toBe(false)
    expect(body.error).toContain('not configured')
  })

  it('两新 GET 无 token → 401（统一前置门覆盖）', async () => {
    const { base } = await start(distWith('<!doctype html>'), 'tok')
    expect((await fetch(`${base}/api/v2/setup/status`)).status).toBe(401)
    expect((await fetch(`${base}/api/v2/setup/providers`)).status).toBe(401)
  })

  it('点火语义 · GET /api/v2/tmdb/search：同进程内 getter 从 null 翻成客户端 → 503 变 200', async () => {
    const tmdbStub: FakeTmdb = {
      getSeasonTable: async () => [],
      getSeasonEpisodes: async () => [],
      search: async () => [{ id: 1, title: 'X', originalTitle: 'X', year: 2020, posterPath: null }],
    }
    let ignited = false
    // 位置参数：distDir, token, reconcileAll, env, jobs, tmdb, requestIngest,
    // subtitleWriteDeps, subtitleCompareDeps, extra —— 中间七个一律 undefined。
    const { base } = await start(distWith('<!doctype html>'), 'tok', undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      tmdbGetter: () => (ignited ? tmdbStub : null),
    })
    expect((await fetch(`${base}/api/v2/tmdb/search?q=x&type=tv&token=tok`)).status).toBe(503)
    ignited = true   // = wizard 落库 + holder 热重建的等价物：消费点现取现判空
    const after = await fetch(`${base}/api/v2/tmdb/search?q=x&type=tv&token=tok`)
    expect(after.status).toBe(200)
    expect(await after.json()).toEqual({ results: [{ id: 1, name: 'X', year: 2020, posterPath: null }] })
  })

  it('点火语义 · POST /api/v2/reconcile-all：同进程内 getter 从 null 翻成执行体 → 503 变 200', async () => {
    let ignited = false
    const { base } = await start(distWith('<!doctype html>'), 'tok', undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      reconcileAllGetter: () => (ignited
        ? async () => ({ dispatchedFindSubtitle: 1, dispatchedRealign: 0, spawnedSiblings: 0, summary: 'dispatched 1 task' })
        : null),
    })
    expect((await fetch(`${base}/api/v2/reconcile-all?token=tok`, { method: 'POST' })).status).toBe(503)
    ignited = true
    const after = await fetch(`${base}/api/v2/reconcile-all?token=tok`, { method: 'POST' })
    expect(after.status).toBe(200)
    expect((await after.json()).summary).toBe('dispatched 1 task')
  })
})
```

**这两条是 spec §9「点火后不再 503（直接断言）」的落地，也是本 task 唯一测得到 getter 化真实收益的地方。**
既有那两条"未点火 → 503"用例（`:203-206` 的 reconcile-all、`:750-753` 的 tmdb/search）**一行都不改**——它们是这对断言的前一半（缺席语义不变）；
新用例补的是后一半：**同一个进程内**从 503 翻到 200，证明"改完配置得重启 dashboard"这条旧约束已经没了。

import 追加 `type { SetupDeps }`（from './setupApi.js'）。

- [ ] **Step 5: 跑红** — Run: `npx vitest run src/dashboard/server.test.ts`（红因：`extra` 形参尚未加、setup 三路由不存在。**`DashboardOpts` 的 cacheRoot/setupDeps 与 tmdb/reconcileAll getter 化此时已由 Task 10 的 10-3b 落地**，不在本 task 的红因里）

- [ ] **Step 6: server.ts 实现（4 处编辑；原 ① 的接口变更已在 Task 10 的 10-3b 落地，此处只核对）**

① DashboardOpts（:39-89）字段变更：**已在 Task 10 的 10-3b 落地，本 task 不再重做。**

原因：Task 10 的 10-4 会把 `src/cli/index.ts:637` 的 `startDashboard({ … })` 字面量改成传 `tmdb`/`reconcileAll` 两个 getter 加 `cacheRoot`/`setupDeps`；那是个**新建对象字面量**，excess property check 生效，所以接口不先改，Task 10 的 `npm run check` 当场就是 2×TS2353（`cacheRoot`/`setupDeps` 未知属性）+ 2×TS2322（函数不能赋给非函数类型）。字段声明因此必须跟着第一个使用点走，不能留在两个 task 之后。

**执行者到这里请核对一遍**：`src/dashboard/server.ts` 的 `DashboardOpts` 里应已有 `tmdb?: () => … | null`、`reconcileAll?: () => (() => Promise<ReconcileAllResultDTO>) | null`、`cacheRoot?: string`、`setupDeps?: Partial<SetupDeps>` 四项，且 `import type { SetupDeps }` 已加。若缺，回 Task 10 的 10-3b 补齐再往下走。

② :194 解构行改为：`const { db, port, token, distDir, reconcileAll, env = process.env, jobs, tmdb, requestIngest, subtitleWriteDeps, subtitleCompareDeps, cacheRoot, setupDeps: setupDepsOverride } = opts`。

**构造块的落点：紧跟在 :195 `const settingsRepo = new SettingsRepo(db)` 之后**（即插在原 :195 与 :196 `const auth = new AuthService(settingsRepo)` 之间）。**不要**贴在解构行下面——`setupDeps` 的字面量里引用 `settingsRepo`，而它是 :195 才 `const` 出来的，贴在 :194 后面就是 TDZ，运行期 `ReferenceError`（dashboard 起不来）。

```ts
  // spec A §4.4：setup 面依赖——默认接真实实现（cfg 的 dbGet 惰性读库，wizard 落库后下一次
  // status/validate 调用自然反映），测试经 opts.setupDeps 部分覆盖（同 subDeps 先例）。
  const setupDeps: SetupDeps = {
    env,
    settingsRepo,
    cacheRoot: cacheRoot ?? (env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')),
    // SettingsRepo 上的方法名是 listRoots（不是 listMediaRoots）——见 src/v2/settingsRepo.ts:59。
    // 每次调用现取，守备目录增删后 status 立刻反映，不缓存。
    rootsCount: () => settingsRepo.listRoots().length,
    now: () => Date.now(),
    ...setupDepsOverride,
  }
```

**`cacheRoot` 那行的括号是必需的，不是风格问题：** ES2020 起 `??` 与 `||` **不允许**在同一表达式里不加括号混用（`a ?? b || c` 是 SyntaxError / TS5076「'??' 和 '||' 操作不能混用，需加括号」）。所以内层的 `env.X || join(...)` 必须自带一对括号。另：这里读的是解构出来的 `env`（默认 `process.env`）而不是直接读 `process.env`——`opts.env` 本来就是为测试注入的口子，绕过它等于让这个字段测不到。

（字段集与 Task 5 的 `SetupDeps` 逐字一致：`settingsRepo` / `env` / `cacheRoot` / `rootsCount` / `now` 五个必填 + 可选 `probes`。**没有** `cfg` 字段——validate 的各 probe 在 setupApi 内部自建客户端；**也没有** `log` 字段——`putSecret` 的 log 是它自己的第三个形参，见下面 ④ 的调用点。多写字段会触发 excess property 报错。）

**import 追加（已逐一 grep 核实过现状）：** `buildSetupStatus, buildProviders, putSecret, validateSetupTarget, type SetupDeps`（from `'./setupApi.js'`，新增整行）；`homedir`（**本文件目前完全没有 `node:os` 的 import**——`grep -n "homedir\|node:os" src/dashboard/server.ts` 零命中，所以要新加一整行 `import { homedir } from 'node:os'`）；`join` **已在 :4 `import { join, normalize, extname, resolve, sep } from 'node:path'` 里，不要重复引**。

③ deps（RouterDeps 字面量）追加两行：

```ts
    setupStatus: () => buildSetupStatus(setupDeps),
    providers: () => buildProviders(setupDeps),
```

④ tmdb/reconcileAll 的三个消费点：**已在 Task 10 的 10-3b-② 落地，本 task 不再重做。**

原因同 ①：接口一改成 getter，这三处当场编译不过（TS2345 / TS2339 / await 到函数），而 Task 10 的 Step 6 要求 `npm run check` 全绿——所以它们必须跟着接口一起走，不能滞后两个 task。

**执行者核对**：`server.ts` 里 `librarySeriesDetail` 闭包应是 `const tmdbClient = tmdb?.()` + `if (detail && tmdbClient)`；reconcile-all 分支应是 `const runReconcileAll = reconcileAll?.()` + `await runReconcileAll()`；tmdb/search 分支应是 `const tmdbClient = tmdb?.()` + `await tmdbClient.search(mediaType, q)`。若还是裸 `tmdb`/`reconcileAll`，回 Task 10 的 10-3b-② 补齐再往下走。

⑤ 两个异步分支（放 settings PUT 分支之后，形状照 :457-469 先例）：

```ts
      // spec A §4.4：PUT /api/v2/settings/secrets——wizard/Providers 区的密钥写入通道。
      // 白名单/空值删除/审计日志（只记 name）/版本自增全部收在 setupApi.putSecret 内。
      if (rawPath === '/api/v2/settings/secrets') {
        if (req.method !== 'PUT') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        const body = await readJsonBodyOrFail(req, res)
        if (body === BODY_FAILED) return
        // putSecret 是同步函数（不用 await），签名 (deps, body, log) → { status, body }：
        // log 是第三个形参，不是 deps 的字段。审计日志只记 name/action，永不记 value。
        const out = putSecret(setupDeps, body, (msg) => console.error(`[setup] ${msg}`))
        res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(out.body))
        return
      }

      // spec A §4.4：POST /api/v2/setup/validate——先测后存。未知 target → 400；
      // 测试真的跑了（含失败/未配置）→ 200，结果分类在 body。
      if (rawPath === '/api/v2/setup/validate') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        const body = await readJsonBodyOrFail(req, res)
        if (body === BODY_FAILED) return
        const outcome = await validateSetupTarget(setupDeps, body)
        res.writeHead(outcome.status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(outcome.body))
        return
      }
```

（两个 setup 函数的返回形状都是 `{ status, body }`——`putSecret` 同步、`validateSetupTarget` 异步，`status` 已经是要写的 HTTP 码，路由层不再自己判断 200/400。`body` 直接序列化：`PutSecretResult` 成功形是 `{ ok:true, name, action }`，失败形是 `{ ok:false, error }`，两种都原样出参，前端按 `ok` 分支。）

- [ ] **Step 7: 跑绿** — Run: `npx vitest run src/dashboard && npm run check && npm test`

- [ ] **Step 8: Commit**

```bash
git add src/dashboard/server.ts src/dashboard/server.test.ts src/dashboard/router.ts src/dashboard/router.test.ts
git commit -m "feat: setup 三路由接线 + tmdb/reconcileAll getter 化（spec A §4.2/§4.4）"
```

---

## 前端与收尾（Tasks 13-27）

File Structure 增补——前端新文件全部在各自 task 的 Files 块里精确定义（`web/src/tw.css`、`web/src/lib/utils.ts`、`web/src/components/ui/*`、`web/src/setup/*`）；File Structure 节未逐一登记，以 task 为准。

任务顺序说明：Task 16 是 **wizard 外壳 + 步 1（Language）合体**（不是 BootstrapGate）——Gate 依赖 wizard 存在才能接线，所以 gate+App 改线排在七步组件全部到齐之后（**Task 23**）。依赖序（逐一对齐实际任务号，别按段落数猜）：**13 底座 → 14 api → 15 i18n → 16 外壳+步1 → 17 步2 TMDB → 18 步3 LLM → 19 步4 provider → 20 步5 免费源 → 21 步6 守备目录 → 22 步7 Launch → 23 Gate/App → 24 Engine 两处控制面（EngineRow + 全局 banner）→ 25 Settings Providers/System/Deploy → 26 全量验证+密钥泄漏 grep → 27 部署+实机验收（主控执行）**。

### Task 13: Tailwind v4 + shadcn 底座（与 Astryx 并存，spec C §5.1 token 落位）

**Files:**
- Modify: `web/package.json`（dependencies 整节）
- Modify: `web/vite.config.ts`
- Modify: `web/src/main.tsx`（追加一行 import）
- Create: `web/src/tw.css`
- Create: `web/src/lib/utils.ts`
- Test: `web/src/lib/utils.test.ts`
- Create: `web/src/components/ui/button.tsx`、`input.tsx`、`switch.tsx`、`card.tsx`

设计纪律（写进每个文件的头注释）：Astryx 退役前**双栈并存**——不引 Tailwind preflight（Astryx `reset.css` 已是全局 reset，双 reset 必互踩）；新栈样式只落在 `@layer theme/base/utilities`，Astryx 组件走它自己的具名层，互不染指。token 表逐值取自 spec C §5.1（Plan A 落底座，Plan C 的四屏直接消费，不重复定义）。

- [ ] **Step 1: 加依赖并安装**

`web/package.json` 的 `dependencies` 整节替换为（devDependencies 不动）：

```json
  "dependencies": {
    "@astryxdesign/core": "^0.1.6",
    "@radix-ui/react-slot": "^1.2.3",
    "@radix-ui/react-switch": "^1.2.5",
    "@tailwindcss/vite": "^4.1.11",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "tailwind-merge": "^3.3.1",
    "tailwindcss": "^4.1.11"
  },
```

Run: `cd web && npm install`
Expected: 成功，`package-lock.json` 更新。不装 lucide（wizard 状态点自绘，无图标库需求——spec A §5.3）。

- [ ] **Step 2: 先写 cn() 的失败测试**

Create `web/src/lib/utils.test.ts`：

```ts
// web/src/lib/utils.test.ts：cn() 的两条语义——真值拼接、同族冲突后写赢（twMerge）。
import { describe, it, expect } from 'vitest'
import { cn } from './utils.js'

describe('cn()', () => {
  it('拼接真值类、丢弃假值', () => {
    expect(cn('px-2', false && 'hidden', undefined, 'block')).toBe('px-2 block')
  })

  it('同族冲突后写赢（twMerge 语义）', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4')
  })
})
```

Run: `cd web && npx vitest run src/lib/utils.test.ts`
Expected: FAIL（`./utils.js` 不存在）

- [ ] **Step 3: cn() 实现**

Create `web/src/lib/utils.ts`：

```ts
// web/src/lib/utils.ts：shadcn 惯例的 cn()——条件拼接（clsx）+ Tailwind 同族冲突合并
// （twMerge，后写赢）。所有 copy-in 组件与自绘件的 className 合成唯一入口。
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
```

Run: `cd web && npx vitest run src/lib/utils.test.ts`
Expected: PASS 2/2

- [ ] **Step 4: Tailwind v4 接线（vite 插件 + tw.css + main.tsx import）**

`web/vite.config.ts` 全文替换为：

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist' },
})
```

Create `web/src/tw.css`：

```css
/* web/src/tw.css：Tailwind v4 + 新栈 token 层（token 逐值取自 spec C §5.1 映射表，Plan A 落
   底座、Plan C 四屏直接消费）。
   Astryx 并存期纪律：不引 preflight——Astryx reset.css 已是全局 reset，双 reset 互踩；
   只取 theme（设计令牌，无级联影响）与 utilities（@layer utilities，只有新组件用到才生效）。
   本文件在 main.tsx 里于 styles.css 之后 import：Astryx 具名层在前、utilities 层在后，
   冲突时 utilities 赢——这正是新组件要的方向。 */
@layer theme, base, components, utilities;

@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);

@theme {
  /* ---- spec C §5.1 token 表（恒暗色单主题，无 light 变体） ---- */
  --color-background: #0b0c0f;            /* 页面底 */
  --color-card: #111318;                  /* 卡片底 */
  --color-accent: #16181f;                /* 面：hover/活跃 */
  --color-border: rgba(255, 255, 255, 0.07);
  --color-border-subtle: rgba(255, 255, 255, 0.05);
  --color-foreground: #e6e8ec;
  --color-muted-foreground: #9aa1ac;
  --color-weak: #6b7280;                  /* 传送带旧行、辅助行 */
  --color-faint: #4b5563;                 /* 最弱辅助 */
  --color-fn-purple: #8b7cf6;             /* hero 脉动点 */
  --color-fn-red: #e11d48;                /* 只给卡死点/事实句（draft-6 铁律 1） */
  --color-fn-green: #28bf5c;              /* covered/on */
  --color-sidebar-active: #a3e635;        /* 侧栏当前项 lime */

  /* ---- shadcn 语义别名（指同一批值；copy-in 组件消费这套名字） ---- */
  --color-primary: #e6e8ec;
  --color-primary-foreground: #0b0c0f;
  --color-secondary: #16181f;
  --color-secondary-foreground: #e6e8ec;
  --color-muted: #16181f;
  --color-accent-foreground: #e6e8ec;
  --color-destructive: #e11d48;
  --color-destructive-foreground: #ffffff;
  --color-input: rgba(255, 255, 255, 0.14);
  --color-ring: #8b7cf6;
  --color-card-foreground: #e6e8ec;
  --color-popover: #111318;
  --color-popover-foreground: #e6e8ec;

  /* v4 命名空间：--radius-* → rounded-* 工具类（卡 12 / 钮与输入 8，spec C §5.1） */
  --radius-card: 12px;
  --radius-control: 8px;

  --font-sans: -apple-system, "Helvetica Neue", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}

@layer base {
  /* 无 preflight 的最小补丁：shadcn 组件假定默认边框色不是 currentColor。
     只设边框色——body/排版在 Astryx 退役前仍归 styles.css/scout.css 管，这里不碰。 */
  *, ::before, ::after {
    border-color: var(--color-border);
  }
}
```

`web/src/main.tsx`：把 `import './styles.css'` 那一行改成两行（其余不动）：

```ts
import './styles.css'
// 新栈 token/utilities 层——必须在 styles.css 之后（Astryx 层先声明、utilities 后赢）。
//
// ⚠️ 这两行在 Astryx 卸载步（Plan C Task 31）**都保留**。那一步删的是 styles.css 里的
// 三行 `@import`（`:7-9`，reset + astryx.css + scout 主题产物）并补一个替代 preflight，
// styles.css 本体与本处的两行 import 一个都不动——`tw.css` 是新栈的 token/utilities 层，
// 删掉它等于把整套新栈连根拔了。（本注释的前一版写"连本行一起删"，语义指向不明，已改。）
import './tw.css'
```

- [ ] **Step 5: 四个 shadcn copy-in 通用件（Button/Input/Switch/Card）**

口径：照 shadcn/ui（new-york，Tailwind v4 版）公开源码抄写，**两处有意适配**——① import 全部改相对路径 + `.js` 后缀（仓库 ESM 惯例，不做 tsconfig paths 手术）；② Switch 的 checked 底色用 `--color-fn-green`（发动机"开"的语义色）而不是 shadcn 默认的 primary。其余类名与结构一字不改。

Create `web/src/components/ui/button.tsx`：

```tsx
// web/src/components/ui/button.tsx：shadcn/ui Button（new-york，v4）copy-in。
// 适配：相对 import + .js 后缀；变体裁到本应用用的五个（default/destructive/outline/secondary/ghost）。
import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils.js'

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-control text-sm font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/85',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/85',
        outline: 'border border-border bg-transparent hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 px-3 text-xs',
        lg: 'h-10 px-6',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
```

Create `web/src/components/ui/input.tsx`：

```tsx
// web/src/components/ui/input.tsx：shadcn/ui Input（v4）copy-in，相对 import 适配。
import * as React from 'react'
import { cn } from '../../lib/utils.js'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-9 w-full min-w-0 rounded-control border border-input bg-transparent px-3 py-1 text-sm text-foreground outline-none transition-colors',
        'placeholder:text-weak focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
```

Create `web/src/components/ui/switch.tsx`：

```tsx
// web/src/components/ui/switch.tsx：shadcn/ui Switch（v4）copy-in。
// 有意适配：checked 底色 = --color-fn-green（发动机"开"的语义色），非 shadcn 默认 primary。
import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cn } from '../../lib/utils.js'

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent outline-none transition-colors',
        'data-[state=checked]:bg-fn-green data-[state=unchecked]:bg-input',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block size-4 rounded-full bg-foreground shadow ring-0 transition-transform',
          'data-[state=checked]:translate-x-[18px] data-[state=unchecked]:translate-x-[2px]',
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
```

Create `web/src/components/ui/card.tsx`：

```tsx
// web/src/components/ui/card.tsx：shadcn/ui Card（v4）copy-in，相对 import 适配。
import * as React from 'react'
import { cn } from '../../lib/utils.js'

function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card"
      className={cn('rounded-card border border-border bg-card text-card-foreground', className)}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-header" className={cn('flex flex-col gap-1 p-5', className)} {...props} />
}

function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-title" className={cn('text-base font-semibold leading-none', className)} {...props} />
}

function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-description" className={cn('text-sm text-muted-foreground', className)} {...props} />
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('p-5 pt-0', className)} {...props} />
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-footer" className={cn('flex items-center gap-2 p-5 pt-0', className)} {...props} />
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter }
```

- [ ] **Step 6: 构建 + 全量前端测试 + 并存期零打扰核对**

Run: `cd web && npm run build`
Expected: vite build 成功（Tailwind 扫描 `src/**/*` 自动生成用到的 utilities）。

Run: `cd web && npx tsc --noEmit && npm test`
Expected: 类型零错误；既有测试全绿 + utils.test.ts 2 绿。

Run: `git status --short web/src/styles.css web/vitest.config.ts`
Expected: 空输出——styles.css 未被触碰（`__STYLES_CSS__` define 读的仍是原文件，cascade 三行纪律不破），vitest.config.ts 不动。

- [ ] **Step 7: Commit**

```bash
git add web/package.json web/package-lock.json web/vite.config.ts web/src/main.tsx web/src/tw.css web/src/lib web/src/components/ui
git commit -m "feat(web): Tailwind v4 + shadcn 底座进场（无 preflight，与 Astryx 并存；spec A §5.3 / spec C §5.1）"
```

### Task 14: api 层——setup DTO 类型 + client 方法 + useSetupStatus 轮询 hook

**Files:**
- Modify: `web/src/api/types.ts`（追加 setup DTO 区 + SettingsKey/SettingsDTO 扩展）
- Modify: `web/src/api/client.ts`（api 对象追加 4 方法 + import 扩展）
- Test: `web/src/api/client.test.ts`（追加 describe）
- Create: `web/src/api/hooks.test.ts`
- Modify: `web/src/api/hooks.ts`（追加 useSetupStatus）
- Modify: `web/src/settings/BehaviorSection.test.tsx`（既有 SettingsDTO 字面量补齐，见本 Task 末节）
- Modify: `web/src/settings/TranslateSection.test.tsx`（同上）

线形镜像 Task 5/6 的 `setupApi.ts`（后端唯一事实源）；DTO 键集合与 spec A §4.4 的示例 JSON 逐键对齐。注意：`SECRET_NAMES` 是 **9 个**枚举名（spec §4.1 正文枚举了 9 个、句中"10 个名字"是笔误——以枚举为准，与 Task 1 落地一致）。

- [ ] **Step 1: 先写 client 新方法的失败测试**

`web/src/api/client.test.ts` 文件尾追加：

```ts
describe('client.ts 启动面方法（spec A §4.4 线形）', () => {
  it('validateSetup 带 credentials 时请求体原样透传（"先测后存"的落库裁决在服务端，这里只锁线形）', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ ok: true, detail: 'connected' }),
    }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    const r = await api.validateSetup('tmdb', { TMDB_API_KEY: 'k' })
    expect(r).toEqual({ ok: true, detail: 'connected' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url).startsWith('/api/v2/setup/validate')).toBe(true)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ target: 'tmdb', credentials: { TMDB_API_KEY: 'k' } })
  })

  it('validateSetup 省略 credentials 时请求体只有 target（测已解析 env/db 凭据）', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ ok: true }),
    }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    await api.validateSetup('subhd')
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ target: 'subhd' })
  })

  it('putSecret 走 PUT /api/v2/settings/secrets（空值=删除的语义裁决同样在服务端）', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ ok: true, name: 'ASSRT_TOKEN', action: 'deleted' }),
    }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    const r = await api.putSecret('ASSRT_TOKEN', '')
    expect(r).toEqual({ ok: true, name: 'ASSRT_TOKEN', action: 'deleted' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url).startsWith('/api/v2/settings/secrets')).toBe(true)
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ name: 'ASSRT_TOKEN', value: '' })
  })

  it('setupStatus / setupProviders 路径正确、走 get（失败响应也吃 errorMessage 抽取）', async () => {
    const fetchMock = vi.fn(async () => ({
      // **故意用 500、不用 401**：`client.ts:58-70` 的 errorMessage 对 401 有硬编码中文兜底
      //（`return '会话未授权或已失效，请重新登录'`，早于 body.error 抽取 return），
      // 走 401 这条用例永远拿不到 'unauthorized'，下面的 rejects.toThrow 必红。
      ok: false, status: 500, json: async () => ({ error: 'unauthorized' }),
    }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    await expect(api.setupStatus()).rejects.toThrow('unauthorized')
    expect(String((fetchMock.mock.calls[0] as unknown[])[0]).startsWith('/api/v2/setup/status')).toBe(true)
  })
})
```

**那四处 `as unknown as` / `as unknown[]` 不是风格洁癖，是编译前提：** `vi.fn(async () => ...)` 的 mock 函数**零形参**，
`fetchMock.mock.calls` 因此被推成 `[][]`（空元组的数组）——`calls[0] as [string, RequestInit]` 会吃 TS2352
「两种类型无充分重叠」，`calls[0][0]` 会吃 TS2493「索引 0 超出长度为 0 的元组」。仓库自己的先例就是双 cast：
`web/src/api/client.test.ts:70` 写 `String((mock.mock.calls[0] as unknown[])[0])`、`:77` 写
`as unknown as [string, RequestInit]`。照抄，别自作聪明给 `vi.fn` 补形参（补了就得给整条 fetch 签名写类型，收益为零）。

Run: `cd web && npx vitest run src/api/client.test.ts`
Expected: FAIL（`api.validateSetup` 等不存在，TS 报错/运行时报 not a function）

- [ ] **Step 2: types.ts 追加 setup DTO 区 + SettingsKey/SettingsDTO 扩展**

`web/src/api/types.ts` 文件尾追加：

```ts
// ---------- Spec A 启动面 DTO（镜像 src/dashboard/setupApi.ts 的线形；键集合与 spec A §4.4 示例 JSON 逐键对齐） ----------

export type SecretSource = 'env' | 'db' | 'none'

/** 9 个密钥白名单（spec §4.1 枚举值；正文"10 个"系笔误）。与后端 SECRET_NAMES 同序。 */
export const SECRET_NAMES = [
  'TMDB_API_KEY',
  'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL',
  'ASSRT_TOKEN',
  'OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_USERNAME', 'OPENSUBTITLES_PASSWORD',
  'JIMAKU_API_KEY',
] as const
export type SecretName = (typeof SECRET_NAMES)[number]

export type ValidateTarget = 'tmdb' | 'llm' | 'assrt' | 'opensubtitles' | 'jimaku' | 'subhd' | 'zimuku'

export interface ValidateResultDTO { ok: boolean; detail?: string; error?: string }

export interface SetupSecretStateDTO { satisfied: boolean; source: SecretSource; masked: string | null }

export interface SetupStatusDTO {
  bootstrapComplete: boolean
  tmdb: SetupSecretStateDTO
  llm: { satisfied: boolean; source: SecretSource; model: string | null }
  providers: {
    assrt: SetupSecretStateDTO
    opensubtitles: { satisfied: boolean; source: SecretSource; hasUsername: boolean; masked: string | null }
    jimaku: SetupSecretStateDTO
    subhd: { enabled: boolean; source: SecretSource }
    zimuku: { enabled: boolean; source: SecretSource; captchaReady: boolean }
  }
  roots: { count: number }
  engineEnabled: boolean
}

export interface SecretTestDTO { ok: boolean; at: number; error?: string }

export interface ProviderRowDTO {
  id: ValidateTarget
  secrets: { name: SecretName; set: boolean; source: SecretSource; masked: string | null }[]
  lastTest: SecretTestDTO | null
}

export interface ProvidersDTO { providers: ProviderRowDTO[] }

/** PUT /api/v2/settings/secrets 的 200 体；400 时走 client.ts 既有 {error} 抽取，进不了本类型。 */
export interface PutSecretResultDTO { ok: boolean; name?: SecretName; action?: 'set' | 'deleted' }
```

然后把 :266-269 附近的 SettingsKey/SettingsDTO 改为（Task 11 后端同款三键 + engineEnabled 布尔别名）：

```ts
export type SettingsKey =
  | 'target_languages'
  | 'ai_translate_enabled'
  | 'hardsub_mode'
  | 'exclude_extras'
  | 'scan_interval_ms'
  | 'trace_retention_days'
  | 'engine_enabled'
  | 'provider:SUBHD_ENABLED'
  | 'provider:ZIMUKU_ENABLED'

export type SettingsDTO = Record<SettingsKey, string | null> & { engineEnabled: boolean }
```

**消费方核对（必做，防幽灵行）：** `engineEnabled` 布尔混进 DTO 后，任何对 settings DTO 的整表遍历都会多出一行。Run:

```bash
grep -rnE "Object\.(keys|entries)\(settings" web/src
```

Expected: 无输出（Settings 各 section 都是显式键行渲染——spec C §5.6 六键钉死）。**若有输出**：在遍历处加 `k !== 'engineEnabled'` 过滤，并在本 task 提交信息里点名。

**不要用 `grep -rn "Object.keys(\|Object.entries(" web/src --include="*.tsx" | grep -i settings` 这种宽版本**：`grep -i settings` 命中的是**文件路径**里的 `settings/`，会稳定捞出两条与本改造毫无关系的行——`web/src/settings/DeploySection.tsx:40` 与 `:66`，它们遍历的是 `deploy.data.secrets` / `deploy.data.nonSecrets`（`DeploySettingsDTO` 的两个子 Record，跟 `SettingsDTO` 不是同一个类型，加不加 `engineEnabled` 都与它们无关）。上面的窄版直接对着 `settings` 标识符匹配，`settings` / `settings.data` / `settingsDTO` 三种写法都覆盖，且不会被路径名污染。

**既有测试字面量补齐（必做，不做这步 `npx tsc --noEmit` 必红）：** `SettingsDTO` 是 `Record<SettingsKey, …>` **全量** map，加三键 + 一布尔后，既有的四处完整字面量全部变成"缺字段"。四处都在末尾追加同样四行：

```ts
  engine_enabled: null, 'provider:SUBHD_ENABLED': null, 'provider:ZIMUKU_ENABLED': null,
  engineEnabled: false,
```

四处位置（逐个改，别漏——前两处在同一文件）：
- `web/src/settings/BehaviorSection.test.tsx:12-15`（`const NULL_SETTINGS: SettingsDTO`）
- `web/src/settings/BehaviorSection.test.tsx:82-85`（"已设置值原样回显"用例里 `asyncOf({...})` 的内联字面量）
- `web/src/settings/TranslateSection.test.tsx:11-14`（`vi.mock` 里 `updateSettings` 返回的 `satisfies SettingsDTO` 字面量）
- `web/src/settings/TranslateSection.test.tsx:23-26`（`const baseSettings: SettingsDTO`）

`engineEnabled: false` 而非 true：这四处都是**既有**用例的固定桩，它们断言的是各自那一行的渲染，与 engine 无关；给 false 可以顺带保证 Task 24 新增的 EngineRow 在这些老用例里渲染为"关"，不会与它们的既有断言抢 `role="switch"` 的名字。（Task 24 自己的用例另建桩，不复用这四处。）

- [ ] **Step 3: client.ts api 对象追加 4 方法**

`web/src/api/client.ts` 顶部 `import type {...} from './types.js'` 的类型清单追加：`SetupStatusDTO, ProvidersDTO, PutSecretResultDTO, ValidateResultDTO, ValidateTarget, SecretName`（按字母序插到既有清单里）。`api` 对象内（`reconcileAll` 行之后的位置即可，保持注释分区）追加：

```ts
  // ---------- Spec A 启动面（BootstrapGate / wizard / Settings Providers 区共用） ----------
  setupStatus: (signal?: AbortSignal) => get<SetupStatusDTO>('/api/v2/setup/status', signal),
  setupProviders: (signal?: AbortSignal) => get<ProvidersDTO>('/api/v2/setup/providers', signal),
  putSecret: (name: SecretName, value: string) =>
    put<PutSecretResultDTO>('/api/v2/settings/secrets', { name, value }),
  // credentials 提供 = wizard"先测后存"（服务端测请求体凭据、不落库）；省略 = 测已解析的 env/db 凭据。
  validateSetup: (target: ValidateTarget, credentials?: Partial<Record<SecretName, string>>) =>
    post<ValidateResultDTO>('/api/v2/setup/validate', credentials === undefined ? { target } : { target, credentials }),
```

Run: `cd web && npx vitest run src/api/client.test.ts`
Expected: 全 PASS（既有 + 新 4 条）

- [ ] **Step 4: 先写 useSetupStatus 的失败测试**

Create `web/src/api/hooks.test.ts`：

```ts
// web/src/api/hooks.test.ts：useSetupStatus 的轮询节律与可见性暂停——spec A §5.5 承诺
// engineEnabled 翻转 ≤15s 上屏，锁的就是这个 hook 的 LIBRARY_POLL_MS 共用节律。
// jsdom + fake timers；api.setupStatus spy 替掉不走网络。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { api } from './client.js'
import type { SetupStatusDTO } from './types.js'
import { useSetupStatus } from './hooks.js'

const STATUS: SetupStatusDTO = {
  bootstrapComplete: true,
  tmdb: { satisfied: true, source: 'env', masked: 'abc••••xyz' },
  llm: { satisfied: true, source: 'env', model: 'm' },
  providers: {
    assrt: { satisfied: false, source: 'none', masked: null },
    opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
    jimaku: { satisfied: false, source: 'none', masked: null },
    subhd: { enabled: false, source: 'none' },
    zimuku: { enabled: false, source: 'none', captchaReady: false },
  },
  roots: { count: 0 },
  engineEnabled: true,
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useSetupStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(api, 'setupStatus').mockResolvedValue(STATUS)
    setVisibility('visible')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('首载返回 data，loading 翻 false', async () => {
    const { result } = renderHook(() => useSetupStatus())
    expect(result.current.loading).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.data?.engineEnabled).toBe(true)
    expect(result.current.loading).toBe(false)
  })

  it('15s 轮询（与其他数据 hook 同一 LIBRARY_POLL_MS 节律）', async () => {
    renderHook(() => useSetupStatus())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(api.setupStatus).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(api.setupStatus).toHaveBeenCalledTimes(2)
  })

  it('页面不可见时暂停轮询；恢复可见立即补拉一次', async () => {
    renderHook(() => useSetupStatus())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(api.setupStatus).toHaveBeenCalledTimes(1)
    act(() => setVisibility('hidden'))
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(api.setupStatus).toHaveBeenCalledTimes(1)
    await act(async () => setVisibility('visible'))
    expect(api.setupStatus).toHaveBeenCalledTimes(2)
  })
})
```

Run: `cd web && npx vitest run src/api/hooks.test.ts`
Expected: FAIL（`useSetupStatus` 未导出）

- [ ] **Step 5: hooks.ts 追加 useSetupStatus（逐行照 useLibrary 的轮询样板）**

`web/src/api/hooks.ts` 顶部类型 import 清单追加 `SetupStatusDTO`，文件尾追加：

```ts
/** setup/status：BootstrapGate 与 EngineBanner 共用。15s 轮询——engineEnabled 翻转 ≤15s 上屏
 *  （spec A §5.5 的"下 tick 生效"在前端侧的镜像）；可见性暂停与 useLibrary 同样板。 */
export function useSetupStatus(): Async<SetupStatusDTO> {
  const [data, setData] = useState<SetupStatusDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const rows = await api.setupStatus()
      setData(rows)
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const reload = useCallback(() => {
    setLoading(true)
    void load()
  }, [load])

  useEffect(() => {
    void load()
    const start = () => {
      if (timer.current == null) timer.current = setInterval(() => void load(), LIBRARY_POLL_MS)
    }
    const stop = () => {
      if (timer.current != null) {
        clearInterval(timer.current)
        timer.current = null
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void load()
        start()
      } else {
        stop()
      }
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  return { data, loading, error, reload }
}
```

Run: `cd web && npx vitest run src/api/hooks.test.ts src/api/client.test.ts`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
git add web/src/api/types.ts web/src/api/client.ts web/src/api/client.test.ts web/src/api/hooks.ts web/src/api/hooks.test.ts web/src/settings/BehaviorSection.test.tsx web/src/settings/TranslateSection.test.tsx
git commit -m "feat(web): setup DTO 类型 + client 启动面四方法 + useSetupStatus 轮询（spec A §4.4/§5.5）"
```

### Task 15: i18n——wizard_* 键区 + providers/engine/banner 键（en/zh 双写）

**Files:**
- Modify: `web/src/i18n/en.ts`（表尾追加）
- Modify: `web/src/i18n/zh.ts`（表尾追加）

纪律：wizard_* 区**双写**（spec A §5.3——"Workflow 区永不本地化"的裁决不覆盖 wizard）；`settings_provider_test` 与 `wizard_test` 值同为 'Test'/'测试' 但**键分开**——两个语义区不互相耦合，改一边不波及另一边。TKey = keyof typeof en 自动扩键，组件侧零类型改动。既有 `i18n.test.ts` 的 key-parity 用例就是本 task 的锁：先落 en（parity 红）再落 zh（parity 绿）。

- [ ] **Step 1: en.ts 表尾追加（`export const en = {` 对象的闭合 `}` 之前，保持尾逗号合法）**

```ts
  // ---------- Spec A 启动面（wizard_* 区 + providers/engine/banner；wizard 区 en/zh 双写，§5.3） ----------
  wizard_back: 'Back',
  wizard_continue: 'Continue',
  wizard_save_continue: 'Save & continue',
  wizard_skip_step: 'Skip this step',
  wizard_test: 'Test',
  wizard_testing: 'Testing…',
  wizard_test_passed: 'Connected',
  wizard_test_failed: 'Connection failed',
  // 端点自身 5xx / 网络断（spec §7）——与"凭据不对"分开的第四态，不回显原始异常串。
  wizard_test_unavailable: 'Test unavailable, retry',
  wizard_launch: 'Launch',
  wizard_env_locked: 'Configured via environment',
  wizard_retest: 'Re-test',

  wizard_step_language_title: 'Subtitle language',
  wizard_step_language_desc: 'Which languages should Scout fetch subtitles in? Your first pick also sets the UI language.',
  wizard_step_tmdb_title: 'TMDB',
  wizard_step_tmdb_desc: 'Scout identifies your shows and movies with TMDB.',
  wizard_step_llm_title: 'Language model',
  wizard_step_llm_desc: 'Powers subtitle search decisions and the zimuku captcha solver.',
  wizard_step_providers_title: 'Subtitle providers',
  wizard_step_providers_desc: 'Optional — more sources, better hit rate.',
  wizard_step_free_title: 'Free sources',
  wizard_step_free_desc: 'Built in, no account needed.',
  wizard_step_roots_title: 'Media roots',
  wizard_step_roots_desc: 'The folders Scout watches.',
  wizard_step_launch_title: 'Launch',
  wizard_step_launch_desc: 'Review your setup and start the engine.',

  wizard_language_custom_placeholder: 'Add another — e.g. fr, pt-BR',
  wizard_language_add: 'Add',
  wizard_language_invalid: 'Use a BCP-47 code, like "fr" or "pt-BR".',

  wizard_tmdb_label: 'API key',
  wizard_tmdb_placeholder: 'TMDB API key or read access token',
  wizard_tmdb_hint: 'Free at themoviedb.org → Settings → API. No key, no Scout — this step has no skip.',

  wizard_llm_base_label: 'Base URL',
  wizard_llm_base_hint: 'Usually ends with /v1.',
  wizard_llm_key_label: 'API key',
  wizard_llm_model_label: 'Model',
  wizard_llm_model_placeholder: 'Model name, as your provider calls it',
  wizard_llm_required_note: 'Search decisions and the zimuku captcha solver need a working model — this step has no skip.',

  wizard_providers_banner: 'subhd and zimuku are built-in free sources and stay on as fallback.',
  wizard_assrt_label: 'ASSRT token',
  wizard_os_apikey_label: 'OpenSubtitles API key',
  wizard_os_user_label: 'OpenSubtitles username (optional)',
  wizard_os_pass_label: 'OpenSubtitles password (optional)',
  wizard_jimaku_label: 'Jimaku API key',
  wizard_consequence_assrt: 'Without ASSRT, one fewer subtitle source.',
  wizard_consequence_os: 'Without OpenSubtitles, one fewer subtitle source.',
  wizard_consequence_jimaku: 'Without Jimaku, one fewer subtitle source.',
  wizard_providers_save_note: 'Only keys that pass the test are saved.',

  wizard_subhd_label: 'subhd',
  wizard_zimuku_label: 'zimuku',
  wizard_free_reach_checking: 'Checking reachability…',
  wizard_free_reach_ok: 'Reachable',
  wizard_free_reach_fail: 'Unreachable — stays on, retried at runtime.',
  wizard_zimuku_captcha_ready: 'Captcha solver: ready (LLM configured)',
  wizard_zimuku_captcha_not_ready: 'Captcha solver needs the LLM from step 3.',

  wizard_roots_skip_note: 'Library will stay empty until you add roots — you can do this later in Settings.',

  wizard_launch_configured: 'Configured',
  wizard_launch_skipped: 'Skipped',
  wizard_launch_engine_label: 'Engine',
  wizard_launch_engine_desc: 'Start scanning and fetching as soon as Scout launches.',

  engine_banner_off: 'Engine off — polling and dispatch are paused.',
  engine_banner_turn_on: 'Turn on',

  settings_engine_label: 'Engine',
  settings_engine_desc: 'Master switch for scanning, fetching and all automatic work.',
  settings_providers_title: 'Providers',
  settings_provider_env_locked: 'Set by environment — locked',
  settings_provider_source_env: 'environment',
  settings_provider_source_db: 'database',
  settings_provider_not_set: 'Not set',
  settings_provider_edit: 'Edit',
  settings_provider_save: 'Save',
  settings_provider_cancel: 'Cancel',
  settings_provider_test: 'Test',
  settings_provider_last_test_ok: 'Last test passed',
  settings_provider_last_test_fail: 'Last test failed',
  settings_system_rerun_wizard: 'Re-run setup wizard',
  settings_system_rerun_wizard_desc: 'Walk through bootstrap again. Steps configured via environment stay locked.',
```

Run: `cd web && npx vitest run src/i18n/i18n.test.ts`
Expected: FAIL——"zh/en 键集合完全一致"红（zh 缺 77 键）。这正是锁在工作。

- [ ] **Step 2: zh.ts 表尾追加同一键区**

```ts
  // ---------- Spec A 启动面（wizard_* 区双写，§5.3） ----------
  wizard_back: '上一步',
  wizard_continue: '继续',
  wizard_save_continue: '保存并继续',
  wizard_skip_step: '跳过此步',
  wizard_test: '测试',
  wizard_testing: '测试中…',
  wizard_test_passed: '连接成功',
  wizard_test_failed: '连接失败',
  wizard_test_unavailable: '测试服务不可用，请重试',
  wizard_launch: '启动',
  wizard_env_locked: '已通过环境变量配置',
  wizard_retest: '重新测试',

  wizard_step_language_title: '字幕语言',
  wizard_step_language_desc: 'Scout 要抓哪些语言的字幕？首选语言同时决定界面语言。',
  wizard_step_tmdb_title: 'TMDB',
  wizard_step_tmdb_desc: 'Scout 用 TMDB 识别你的剧集与电影。',
  wizard_step_llm_title: '语言模型',
  wizard_step_llm_desc: '驱动字幕搜索决策与 zimuku 验证码求解。',
  wizard_step_providers_title: '字幕源',
  wizard_step_providers_desc: '可选——来源越多，命中率越高。',
  wizard_step_free_title: '免费源',
  wizard_step_free_desc: '内置，无需账号。',
  wizard_step_roots_title: '守备目录',
  wizard_step_roots_desc: 'Scout 看守的目录。',
  wizard_step_launch_title: '点火',
  wizard_step_launch_desc: '确认配置，点火发动。',

  wizard_language_custom_placeholder: '添加其他——如 fr、pt-BR',
  wizard_language_add: '添加',
  wizard_language_invalid: '请输入 BCP-47 代码，如 "fr" 或 "pt-BR"。',

  wizard_tmdb_label: 'API 密钥',
  wizard_tmdb_placeholder: 'TMDB API key 或 read access token',
  wizard_tmdb_hint: '在 themoviedb.org → Settings → API 免费申请。没有 key 就没有 Scout——此步不可跳过。',

  wizard_llm_base_label: 'Base URL',
  wizard_llm_base_hint: '通常以 /v1 结尾。',
  wizard_llm_key_label: 'API 密钥',
  wizard_llm_model_label: '模型',
  wizard_llm_model_placeholder: '模型名，按服务商的叫法',
  wizard_llm_required_note: '搜索决策与 zimuku 验证码求解需要可用的模型——此步不可跳过。',

  wizard_providers_banner: 'subhd 与 zimuku 是内置免费源，始终保持兜底。',
  wizard_assrt_label: 'ASSRT token',
  wizard_os_apikey_label: 'OpenSubtitles API key',
  wizard_os_user_label: 'OpenSubtitles 用户名（可选）',
  wizard_os_pass_label: 'OpenSubtitles 密码（可选）',
  wizard_jimaku_label: 'Jimaku API key',
  wizard_consequence_assrt: '没有 ASSRT，少一个字幕来源。',
  wizard_consequence_os: '没有 OpenSubtitles，少一个字幕来源。',
  wizard_consequence_jimaku: '没有 Jimaku，少一个字幕来源。',
  wizard_providers_save_note: '只有测试通过的密钥才会保存。',

  wizard_subhd_label: 'subhd',
  wizard_zimuku_label: 'zimuku',
  wizard_free_reach_checking: '检查可达性…',
  wizard_free_reach_ok: '可达',
  wizard_free_reach_fail: '不可达——保持开启，运行时自动重试。',
  wizard_zimuku_captcha_ready: '验证码求解：就绪（LLM 已配置）',
  wizard_zimuku_captcha_not_ready: '验证码求解需要第 3 步的 LLM。',

  wizard_roots_skip_note: '添加守备目录前媒体库为空——之后可以在 Settings 里加。',

  wizard_launch_configured: '已配置',
  wizard_launch_skipped: '已跳过',
  wizard_launch_engine_label: '发动机',
  wizard_launch_engine_desc: '启动后立即开始扫描与抓取。',

  engine_banner_off: '发动机已关——轮询与派发暂停。',
  engine_banner_turn_on: '开启',

  settings_engine_label: '发动机',
  settings_engine_desc: '扫描、抓取与一切自动工作的总开关。',
  settings_providers_title: '字幕源',
  settings_provider_env_locked: '由环境变量设置——锁定',
  settings_provider_source_env: '环境',
  settings_provider_source_db: '数据库',
  settings_provider_not_set: '未设置',
  settings_provider_edit: '编辑',
  settings_provider_save: '保存',
  settings_provider_cancel: '取消',
  settings_provider_test: '测试',
  settings_provider_last_test_ok: '上次测试通过',
  settings_provider_last_test_fail: '上次测试失败',
  settings_system_rerun_wizard: '重跑设置向导',
  settings_system_rerun_wizard_desc: '重新走一遍启动配置。环境变量配置的步骤保持锁定。',
```

Run: `cd web && npx vitest run src/i18n/i18n.test.ts && npx tsc --noEmit`
Expected: parity 绿；类型零错误。

- [ ] **Step 3: Commit**

```bash
git add web/src/i18n/en.ts web/src/i18n/zh.ts
git commit -m "feat(web): wizard_*/providers/engine/banner i18n 键区（en/zh 双写，spec A §5.3）"
```

### Task 16: wizard 外壳 + Step 1 Language（setLang 的第一个真实调用方）

**Files:**
- Create: `web/src/setup/steps/types.ts`
- Create: `web/src/setup/BootstrapWizard.tsx`
- Test: `web/src/setup/BootstrapWizard.test.tsx`
- Create: `web/src/setup/steps/StepLanguage.tsx`
- Test: `web/src/setup/steps/StepLanguage.test.tsx`
- Create: `web/src/setup/steps/registry.ts`

结构裁决：外壳只管步进与框架（7 点步进器 + wordmark + 当前步标题/描述 + 卡片位）；**每步的表单、校验、Continue/Skip 门禁都归步组件**——硬门禁规则属于步不属于壳。外壳的 `steps` 是可注入 prop（默认取 registry），测试用 stub 步驱动外壳，不拉真步。registry 是本任务的编译闭环关键：Task 16 落地时只有 Step 1 一条登记，Tasks 17-22 每步落地追加一行，Task 23 才把 wizard 接进 App——任何中间态都可构建、可测试、不可达生产。

- [ ] **Step 1: steps/types.ts——步契约**

Create `web/src/setup/steps/types.ts`：

```ts
// web/src/setup/steps/types.ts：wizard 步契约。外壳与步的唯一接口面——步拿 status 读已满足态
// （re-run 直通）、落库成功后 patchStatus 同步向导级快照（Launch 步的汇总清单读它）、
// onAdvance/onBack 步进、onComplete 只有末步点火时调。
import type { ReactElement } from 'react'
import type { TKey } from '../../i18n/useT.js'
import type { SetupStatusDTO } from '../../api/types.js'

export interface WizardStepProps {
  status: SetupStatusDTO
  /** 浅合并（子对象整体替换，不做深合并）——步内保存成功后把新的满足态并进来。 */
  patchStatus: (patch: Partial<SetupStatusDTO>) => void
  /** re-run 模式（Settings "Re-run setup wizard" 重进）：已满足的硬门禁步显示绿色打码态、可直接 Continue。 */
  rerun: boolean
  onAdvance: () => void
  onBack: () => void
  onComplete: () => void
}

export interface WizardStepDef {
  id: string
  titleKey: TKey
  descKey: TKey
  /** optional=true 的步渲染 Skip 按钮的许可归步组件；此字段只供 Launch 步汇总清单标 Skipped 用。 */
  optional: boolean
  Component: (props: WizardStepProps) => ReactElement
}
```

- [ ] **Step 2: 先写外壳的失败测试**

Create `web/src/setup/BootstrapWizard.test.tsx`：

```tsx
// web/src/setup/BootstrapWizard.test.tsx：外壳步进语义——stub 步注入（steps prop），不拉真步。
// 锁四件事：首步渲染（title/desc 走 t()）、步进/onBack、patchStatus 浅合并、rerun 透传与
// 末步 onComplete。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import type { SetupStatusDTO } from '../api/types.js'
import { BootstrapWizard } from './BootstrapWizard.js'
import type { WizardStepDef, WizardStepProps } from './steps/types.js'

afterEach(cleanup)

const STATUS: SetupStatusDTO = {
  bootstrapComplete: false,
  tmdb: { satisfied: false, source: 'none', masked: null },
  llm: { satisfied: false, source: 'none', model: null },
  providers: {
    assrt: { satisfied: false, source: 'none', masked: null },
    opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
    jimaku: { satisfied: false, source: 'none', masked: null },
    subhd: { enabled: false, source: 'none' },
    zimuku: { enabled: false, source: 'none', captchaReady: false },
  },
  roots: { count: 0 },
  engineEnabled: true,
}

function StubA(p: WizardStepProps) {
  return (
    <div>
      <button onClick={() => p.patchStatus({ engineEnabled: false })}>patch</button>
      <button onClick={p.onAdvance}>go-b</button>
    </div>
  )
}
function StubB(p: WizardStepProps) {
  return (
    <div>
      <span>{p.status.engineEnabled ? 'ee-on' : 'ee-off'}</span>
      <span>{p.rerun ? 'rerun-mode' : 'fresh-mode'}</span>
      <button onClick={p.onBack}>go-a</button>
      <button onClick={p.onComplete}>done</button>
    </div>
  )
}

const STUB_STEPS: WizardStepDef[] = [
  { id: 'a', titleKey: 'wizard_step_language_title', descKey: 'wizard_step_language_desc', optional: false, Component: StubA },
  { id: 'b', titleKey: 'wizard_step_tmdb_title', descKey: 'wizard_step_tmdb_desc', optional: false, Component: StubB },
]

function renderWizard(over: Partial<Parameters<typeof BootstrapWizard>[0]> = {}) {
  return render(
    <I18nProvider initialLang="en">
      <BootstrapWizard initialStatus={STATUS} rerun={false} onComplete={() => {}} steps={STUB_STEPS} {...over} />
    </I18nProvider>,
  )
}

describe('BootstrapWizard 外壳', () => {
  it('渲染首步 title/desc（走 t()）与步数对应的步进点', () => {
    const { container } = renderWizard()
    expect(screen.getByRole('heading', { name: 'Subtitle language' })).toBeInTheDocument()
    expect(screen.getByText(/first pick also sets the UI language/)).toBeInTheDocument()
    expect(container.querySelectorAll('[role="img"] > span')).toHaveLength(2)
  })

  it('onAdvance 进下一步；已走过的点变绿（bg-fn-green）', () => {
    const { container } = renderWizard()
    fireEvent.click(screen.getByText('go-b'))
    expect(screen.getByRole('heading', { name: 'TMDB' })).toBeInTheDocument()
    expect(container.querySelector('[role="img"] > span')!.className).toContain('bg-fn-green')
  })

  it('patchStatus 浅合并后后续步读到新值', () => {
    renderWizard()
    fireEvent.click(screen.getByText('patch'))
    fireEvent.click(screen.getByText('go-b'))
    expect(screen.getByText('ee-off')).toBeInTheDocument()
  })

  it('onBack 回上一步；onComplete 在末步触发；rerun 透传', () => {
    const onComplete = vi.fn()
    renderWizard({ rerun: true, onComplete })
    fireEvent.click(screen.getByText('go-b'))
    expect(screen.getByText('rerun-mode')).toBeInTheDocument()
    fireEvent.click(screen.getByText('go-a'))
    expect(screen.getByRole('heading', { name: 'Subtitle language' })).toBeInTheDocument()
    fireEvent.click(screen.getByText('go-b'))
    fireEvent.click(screen.getByText('done'))
    expect(onComplete).toHaveBeenCalledTimes(1)
  })
})
```

Run: `cd web && npx vitest run src/setup/BootstrapWizard.test.tsx`
Expected: FAIL（`./BootstrapWizard.js` 不存在）

- [ ] **Step 3: 外壳实现**

Create `web/src/setup/BootstrapWizard.tsx`：

```tsx
// web/src/setup/BootstrapWizard.tsx：七步全屏首跑向导（spec A §5.2）。
// 外壳只管步进与框架（步进点 + wordmark + 当前步标题/描述 + 卡片位）；每步的文案、表单、
// Continue/Skip 门禁都在步组件内——硬门禁规则属于步不属于壳。bootstrap 完成前观测台无物可观，
// 不提供 dismiss（spec §5.1 的有意锁死）；全屏 fixed 覆盖层同时服务 re-run 模式（罩住 Shell）。
import { useState } from 'react'
import type { SetupStatusDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { WIZARD_STEPS } from './steps/registry.js'
import type { WizardStepDef, WizardStepProps } from './steps/types.js'

export function BootstrapWizard({
  initialStatus,
  rerun,
  onComplete,
  steps = WIZARD_STEPS,
}: {
  initialStatus: SetupStatusDTO
  rerun: boolean
  onComplete: () => void
  /** 测试注入点：stub 步驱动外壳；生产永远走 registry 默认。 */
  steps?: WizardStepDef[]
}) {
  const { t } = useT()
  const [index, setIndex] = useState(0)
  const [status, setStatus] = useState<SetupStatusDTO>(initialStatus)
  const step = steps[index]
  if (!step) return null

  const props: WizardStepProps = {
    status,
    patchStatus: (patch) => setStatus((s) => ({ ...s, ...patch })),
    rerun,
    onAdvance: () => setIndex((i) => Math.min(i + 1, steps.length - 1)),
    onBack: () => setIndex((i) => Math.max(i - 1, 0)),
    onComplete,
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex min-h-full w-full max-w-[560px] flex-col px-6 py-10">
        <div className="mb-8 flex items-center justify-between">
          <span className="text-sm font-semibold tracking-wide">◈ Scout</span>
          <div className="flex items-center gap-2" role="img" aria-label={`${index + 1} / ${steps.length}`}>
            {steps.map((s, i) => (
              <span
                key={s.id}
                aria-hidden
                className={
                  'size-2 rounded-full ' +
                  (i < index ? 'bg-fn-green' : i === index ? 'bg-foreground' : 'bg-input')
                }
              />
            ))}
          </div>
        </div>
        <h1 className="text-xl font-semibold">{t(step.titleKey)}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t(step.descKey)}</p>
        <div className="mt-6 flex-1">
          <step.Component {...props} />
        </div>
      </div>
    </div>
  )
}
```

Run: `cd web && npx vitest run src/setup/BootstrapWizard.test.tsx`
Expected: FAIL 仍在——`./steps/registry.js` 还不存在。这是预期的依赖序，下一步闭环。

- [ ] **Step 4: registry + Step 1 Language**

Create `web/src/setup/steps/registry.ts`：

```ts
// web/src/setup/steps/registry.ts：七步登记处。顺序即 spec A §5.2 的步序，不许乱；
// Tasks 17-22 每落地一步在此追加一行，Task 23 才接进 App——任何中间态可构建、不可达生产。
import type { WizardStepDef } from './types.js'
import { StepLanguage } from './StepLanguage.js'

export const WIZARD_STEPS: WizardStepDef[] = [
  { id: 'language', titleKey: 'wizard_step_language_title', descKey: 'wizard_step_language_desc', optional: false, Component: StepLanguage },
  // Task 17: tmdb / Task 18: llm / Task 19: providers / Task 20: free / Task 21: roots / Task 22: launch
]
```

Create `web/src/setup/steps/StepLanguage.tsx`：

```tsx
// web/src/setup/steps/StepLanguage.tsx：wizard 步 1——目标字幕语言（spec A §5.2 步 1，必填）。
// 两件事：① 首选语言即时切 UI 语言（zh* → zh，其余 → en——setLang 的第一个真实调用方，
// 联动机制的现场证明）；② Continue 时 PUT target_languages（复用既有 settings 通道，
// 值格式 = 逗号分隔无空格，与 apiV2 的 target_languages 正则同口径）。
import { useState } from 'react'
import { api } from '../../api/client.js'
import { useT } from '../../i18n/useT.js'
import { Button } from '../../components/ui/button.js'
import { Input } from '../../components/ui/input.js'
import { cn } from '../../lib/utils.js'
import type { WizardStepProps } from './types.js'

// 语言名是语言自己的自称，不是 UI 文案——不进 i18n 表（语言选择器的通行惯例）。
const PRESETS = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
] as const

// 与 apiV2.ts SETTINGS_VALUE_SCHEMAS.target_languages 单段同形（后端那条含逗号串联，这里校单码）。
// 前后端各一份：web 不 import src/ 是既定先例，不开创。
const BCP47_SINGLE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/

export function StepLanguage({ onAdvance }: WizardStepProps) {
  const { t, setLang } = useT()
  const [selected, setSelected] = useState<string[]>([])
  const [custom, setCustom] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const apply = (next: string[]) => {
    setSelected(next)
    // spec：首选语言决定 UI 语言，即时生效并持久化（useT 内部写 localStorage scout-lang）。
    if (next.length > 0) setLang(next[0].toLowerCase().startsWith('zh') ? 'zh' : 'en')
  }

  const toggle = (code: string) => {
    apply(selected.includes(code) ? selected.filter((c) => c !== code) : [...selected, code])
  }

  const addCustom = () => {
    const code = custom.trim()
    if (!BCP47_SINGLE.test(code)) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    setCustom('')
    if (!selected.includes(code)) apply([...selected, code])
  }

  const onContinue = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      await api.updateSettings({ target_languages: selected.join(',') })
      onAdvance()
    } catch (e) {
      setSaveError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const presetCodes: readonly string[] = PRESETS.map((p) => p.code)
  const customSelected = selected.filter((c) => !presetCodes.includes(c))

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('wizard_step_language_title')}>
        {PRESETS.map((p) => {
          const active = selected.includes(p.code)
          return (
            <button
              key={p.code}
              type="button"
              aria-pressed={active}
              onClick={() => toggle(p.code)}
              className={cn(
                'rounded-full border px-4 py-1.5 text-sm transition-colors',
                active
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border bg-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {p.label}
            </button>
          )
        })}
        {customSelected.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed
            onClick={() => toggle(c)}
            className="rounded-full border border-foreground bg-foreground px-4 py-1.5 text-sm text-background transition-colors"
          >
            {c}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value)
            setInvalid(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addCustom()
          }}
          placeholder={t('wizard_language_custom_placeholder')}
          aria-invalid={invalid}
          className="max-w-[260px]"
        />
        <Button variant="secondary" size="sm" onClick={addCustom}>
          {t('wizard_language_add')}
        </Button>
      </div>
      {invalid && <p className="text-sm text-fn-red">{t('wizard_language_invalid')}</p>}

      {saveError && <p className="text-sm text-fn-red">{saveError}</p>}

      <div className="mt-2 flex items-center justify-end gap-2">
        <Button disabled={selected.length === 0 || saving} onClick={() => void onContinue()}>
          {t('wizard_save_continue')}
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Step 1 组件测试**

Create `web/src/setup/steps/StepLanguage.test.tsx`：

```tsx
// web/src/setup/steps/StepLanguage.test.tsx：步 1 门禁与联动——空选择禁 Continue；
// 首选 zh 即时切中文 UI（spec §5.2 步 1 的现场证明）；自定义码 BCP-47 校验；
// Continue PUT target_languages（选择顺序即 join 顺序）后 onAdvance；PUT 失败行内报错不前进。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../../i18n/useT.js'
import { api } from '../../api/client.js'
import type { SetupStatusDTO } from '../../api/types.js'
import { StepLanguage } from './StepLanguage.js'
import type { WizardStepProps } from './types.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const STATUS: SetupStatusDTO = {
  bootstrapComplete: false,
  tmdb: { satisfied: false, source: 'none', masked: null },
  llm: { satisfied: false, source: 'none', model: null },
  providers: {
    assrt: { satisfied: false, source: 'none', masked: null },
    opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
    jimaku: { satisfied: false, source: 'none', masked: null },
    subhd: { enabled: false, source: 'none' },
    zimuku: { enabled: false, source: 'none', captchaReady: false },
  },
  roots: { count: 0 },
  engineEnabled: true,
}

function props(over: Partial<WizardStepProps> = {}): WizardStepProps {
  return {
    status: STATUS,
    patchStatus: () => {},
    rerun: false,
    onAdvance: () => {},
    onBack: () => {},
    onComplete: () => {},
    ...over,
  }
}

function renderStep(over: Partial<WizardStepProps> = {}) {
  return render(
    <I18nProvider initialLang="en">
      <StepLanguage {...props(over)} />
    </I18nProvider>,
  )
}

describe('StepLanguage', () => {
  it('空选择 → Continue 禁用（必填门禁）', () => {
    renderStep()
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled()
  })

  it('首选 zh → UI 即时切中文（setLang 联动）', () => {
    renderStep()
    fireEvent.click(screen.getByRole('button', { name: '中文' }))
    expect(screen.getByRole('button', { name: '保存并继续' })).toBeEnabled()
  })

  it('首选非 zh → UI 保持/切回英文', () => {
    renderStep()
    fireEvent.click(screen.getByRole('button', { name: '中文' }))
    fireEvent.click(screen.getByRole('button', { name: '中文' })) // 取消
    fireEvent.click(screen.getByRole('button', { name: '日本語' }))
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeEnabled()
  })

  it('自定义码：非法报 BCP-47 行；合法进选中集', () => {
    renderStep()
    const input = screen.getByPlaceholderText('Add another — e.g. fr, pt-BR')
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText(/BCP-47/)).toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'pt-BR' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.queryByText(/BCP-47/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'pt-BR' })).toBeInTheDocument()
  })

  it('Continue → PUT target_languages（join 顺序 = 选择顺序）→ onAdvance', async () => {
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as Awaited<ReturnType<typeof api.updateSettings>>)
    const onAdvance = vi.fn()
    renderStep({ onAdvance })
    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    fireEvent.click(screen.getByRole('button', { name: '中文' }))
    // 注意标签是英文：setLang 只看 next[0]（本例 = 'en'），所以选了中文之后 UI 仍是英文。
    fireEvent.click(screen.getByRole('button', { name: 'Save & continue' }))
    await waitFor(() => expect(onAdvance).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith({ target_languages: 'en,zh' })
  })

  it('PUT 失败 → 行内错误、不前进', async () => {
    vi.spyOn(api, 'updateSettings').mockRejectedValue(new Error('must be comma-separated BCP-47 primary codes'))
    const onAdvance = vi.fn()
    renderStep({ onAdvance })
    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save & continue' }))
    expect(await screen.findByText(/BCP-47 primary codes/)).toBeInTheDocument()
    expect(onAdvance).not.toHaveBeenCalled()
  })
})
```

Run: `cd web && npx vitest run src/setup`
Expected: 全 PASS（外壳 4 + 步 1 六条）

- [ ] **Step 6: Commit**

```bash
git add web/src/setup
git commit -m "feat(web): bootstrap wizard 外壳 + 步 1 Language（setLang 首个真实调用方，spec A §5.2）"
```

### Task 17: Step 2 TMDB（硬门禁：测绿才能存）+ 步件共享 ui.tsx

**Files:**
- Create: `web/src/setup/steps/ui.tsx`（StatusDot/StepFooter，Tasks 17-22 共用）
- Create: `web/src/setup/steps/StepTmdb.tsx`
- Test: `web/src/setup/steps/StepTmdb.test.tsx`
- Modify: `web/src/setup/steps/registry.ts`

门禁语义（spec A §3 矩阵 + §5.2 步 2）：**先测后存**——Test 打 `validateSetup('tmdb', { TMDB_API_KEY })`（凭据走请求体、不落库）；只有测绿的**那个值**能 Save & continue（改一个字就回到未测态）；绿了才 `putSecret` 落库。env 已配 → 锁定绿态零输入直接走；db 已配（含 re-run）→ 绿态 + Re-test（不测也能走，spec §5.1）。

- [ ] **Step 1: 共享 ui.tsx**

Create `web/src/setup/steps/ui.tsx`：

```tsx
// web/src/setup/steps/ui.tsx：wizard 步件共享的小件——状态点（灰/转/绿/红）与页脚
// （Back 在左、动作钮在右）。状态点是自绘圆点，不引图标库（spec A §5.3）。
import type { ReactNode } from 'react'
import { useT } from '../../i18n/useT.js'
import { Button } from '../../components/ui/button.js'
import { cn } from '../../lib/utils.js'

export function StatusDot({ tone }: { tone: 'gray' | 'spin' | 'green' | 'red' }) {
  return (
    <span
      data-testid={`status-dot-${tone}`}
      aria-hidden
      className={cn('size-2 shrink-0 rounded-full', {
        'bg-input': tone === 'gray',
        'animate-pulse bg-fn-purple': tone === 'spin',
        'bg-fn-green': tone === 'green',
        'bg-fn-red': tone === 'red',
      })}
    />
  )
}

export function StepFooter({ onBack, children }: { onBack?: () => void; children?: ReactNode }) {
  const { t } = useT()
  return (
    <div className="mt-2 flex items-center justify-between gap-2">
      <div>{onBack ? <Button variant="ghost" onClick={onBack}>{t('wizard_back')}</Button> : null}</div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  )
}
```

- [ ] **Step 2: 先写 StepTmdb 的失败测试**

Create `web/src/setup/steps/StepTmdb.test.tsx`：

```tsx
// web/src/setup/steps/StepTmdb.test.tsx：步 2 硬门禁——测绿才解锁 Save；改值回未测态；
// 保存才落库；env 锁定零输入；db 已配 Re-test 不带凭据（测已解析值）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../../i18n/useT.js'
import { api } from '../../api/client.js'
import type { SetupStatusDTO } from '../../api/types.js'
import { StepTmdb } from './StepTmdb.js'
import type { WizardStepProps } from './types.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const BASE: SetupStatusDTO = {
  bootstrapComplete: false,
  tmdb: { satisfied: false, source: 'none', masked: null },
  llm: { satisfied: false, source: 'none', model: null },
  providers: {
    assrt: { satisfied: false, source: 'none', masked: null },
    opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
    jimaku: { satisfied: false, source: 'none', masked: null },
    subhd: { enabled: false, source: 'none' },
    zimuku: { enabled: false, source: 'none', captchaReady: false },
  },
  roots: { count: 0 },
  engineEnabled: true,
}

function props(over: Partial<WizardStepProps> = {}): WizardStepProps {
  return {
    status: BASE, patchStatus: () => {}, rerun: false,
    onAdvance: () => {}, onBack: () => {}, onComplete: () => {}, ...over,
  }
}

function renderStep(over: Partial<WizardStepProps> = {}) {
  return render(<I18nProvider initialLang="en"><StepTmdb {...props(over)} /></I18nProvider>)
}

describe('StepTmdb', () => {
  it('初始：Save 禁用；Test 绿了才解锁 Save', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    renderStep()
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'tok-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    expect(await screen.findByText('Connected')).toBeInTheDocument()
    expect(api.validateSetup).toHaveBeenCalledWith('tmdb', { TMDB_API_KEY: 'tok-123' })
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeEnabled()
  })

  it('Test 失败 → 行内错误；Save 保持禁用', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: false, error: 'Invalid credentials' })
    renderStep()
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled()
  })

  it('测绿后改值 → 回到未测态（Save 重新禁用）', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    renderStep()
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'tok-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await screen.findByText('Connected')
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'tok-456' } })
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled()
  })

  it('Save → putSecret 落库 + patchStatus + onAdvance', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    const patchStatus = vi.fn()
    const onAdvance = vi.fn()
    renderStep({ patchStatus, onAdvance })
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'tok-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await screen.findByText('Connected')
    fireEvent.click(screen.getByRole('button', { name: 'Save & continue' }))
    await waitFor(() => expect(onAdvance).toHaveBeenCalledTimes(1))
    expect(put).toHaveBeenCalledWith('TMDB_API_KEY', 'tok-123')
    expect(patchStatus).toHaveBeenCalledWith({ tmdb: { satisfied: true, source: 'db', masked: null } })
  })

  it('env 已配 → 锁定绿态零输入，Continue 直接走', () => {
    const onAdvance = vi.fn()
    renderStep({ onAdvance, status: { ...BASE, tmdb: { satisfied: true, source: 'env', masked: 'abc••••xyz' } } })
    expect(screen.getByText(/Configured via environment/)).toBeInTheDocument()
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onAdvance).toHaveBeenCalledTimes(1)
  })

  it('db 已配（re-run）→ Re-test 不带凭据（测已解析值），不重测也能 Continue', async () => {
    const validate = vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const onAdvance = vi.fn()
    renderStep({ rerun: true, onAdvance, status: { ...BASE, tmdb: { satisfied: true, source: 'db', masked: 'abc••••xyz' } } })
    fireEvent.click(screen.getByRole('button', { name: 'Re-test' }))
    await waitFor(() => expect(validate).toHaveBeenCalledWith('tmdb'))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onAdvance).toHaveBeenCalledTimes(1)
  })

  it('validate 端点自身挂了（reject）→ 第四态文案，不回显异常串（spec §7/§8）', async () => {
    vi.spyOn(api, 'validateSetup').mockRejectedValue(new Error('HTTP 500 boom'))
    renderStep()
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'tok-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    expect(await screen.findByText('Test unavailable, retry')).toBeInTheDocument()
    expect(screen.queryByText(/HTTP 500/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled()
  })
})
```

Run: `cd web && npx vitest run src/setup/steps/StepTmdb.test.tsx`
Expected: FAIL（`./StepTmdb.js` 不存在）

- [ ] **Step 3: StepTmdb 实现**

Create `web/src/setup/steps/StepTmdb.tsx`：

```tsx
// web/src/setup/steps/StepTmdb.tsx：wizard 步 2——TMDB token。硬门禁（spec A §3）：先测后存，
// 只有测绿的那个值能 Save & continue。env 已配 → 锁定绿态；db 已配 → 绿态 + Re-test
// （Re-test 不传凭据 = 测服务端已解析值）。
import { useState } from 'react'
import { api } from '../../api/client.js'
import { useT } from '../../i18n/useT.js'
import { Button } from '../../components/ui/button.js'
import { Input } from '../../components/ui/input.js'
import { StatusDot, StepFooter } from './ui.js'
import type { WizardStepProps } from './types.js'

export function StepTmdb({ status, patchStatus, onAdvance, onBack }: WizardStepProps) {
  const { t } = useT()
  const [value, setValue] = useState('')
  const [testing, setTesting] = useState(false)
  const [testedValue, setTestedValue] = useState<string | null>(null)
  const [failMsg, setFailMsg] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const runTest = async (v: string) => {
    setTesting(true)
    setFailMsg(null)
    try {
      const r = await api.validateSetup('tmdb', { TMDB_API_KEY: v })
      if (r.ok) setTestedValue(v)
      else setFailMsg(r.error ?? r.detail ?? t('wizard_test_failed'))
    } catch (e) {
      // 端点自身挂了（5xx / 网络断）——不是"凭据不对"，文案必须区分开（spec §7）。
      // 不回显 String(e)：那会把 "Error: HTTP 500" 摆到用户脸上，且异常串来源不受我们控制。
      void e
      setFailMsg(t('wizard_test_unavailable'))
    } finally {
      setTesting(false)
    }
  }

  const retestResolved = async () => {
    setTesting(true)
    setFailMsg(null)
    try {
      const r = await api.validateSetup('tmdb')
      if (!r.ok) setFailMsg(r.error ?? r.detail ?? t('wizard_test_failed'))
    } catch (e) {
      void e
      setFailMsg(t('wizard_test_unavailable'))
    } finally {
      setTesting(false)
    }
  }

  const onSave = async () => {
    setSaving(true)
    setFailMsg(null)
    try {
      await api.putSecret('TMDB_API_KEY', value)
      // masked 是展示字段、wizard 后续不再展示本步输入值——null 如实表示"前端不算打码"，
      // 打码唯一事实源在后端（setupApi.ts 的 mask）。
      patchStatus({ tmdb: { satisfied: true, source: 'db', masked: null } })
      onAdvance()
    } catch (e) {
      setFailMsg(String(e))
      setSaving(false)
    }
  }

  if (status.tmdb.source === 'env') {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-2 text-sm">
          <StatusDot tone="green" />
          <span>{t('wizard_env_locked')}{status.tmdb.masked ? ` · ${status.tmdb.masked}` : ''}</span>
        </div>
        <StepFooter onBack={onBack}>
          <Button onClick={onAdvance}>{t('wizard_continue')}</Button>
        </StepFooter>
      </div>
    )
  }

  if (status.tmdb.satisfied) {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-2 text-sm">
          <StatusDot tone="green" />
          <span>{t('wizard_test_passed')}{status.tmdb.masked ? ` · ${status.tmdb.masked}` : ''}</span>
          <Button variant="ghost" size="sm" disabled={testing} onClick={() => void retestResolved()}>
            {testing ? t('wizard_testing') : t('wizard_retest')}
          </Button>
        </div>
        {failMsg && <p className="text-sm text-fn-red">{failMsg}</p>}
        <StepFooter onBack={onBack}>
          <Button onClick={onAdvance}>{t('wizard_continue')}</Button>
        </StepFooter>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('wizard_tmdb_hint')}</p>
      <div className="flex items-center gap-2">
        <StatusDot tone={testing ? 'spin' : testedValue === value && value !== '' ? 'green' : failMsg ? 'red' : 'gray'} />
        <Input
          aria-label={t('wizard_tmdb_label')}
          type="password"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setFailMsg(null)
          }}
          placeholder={t('wizard_tmdb_placeholder')}
          className="max-w-[360px]"
        />
        <Button variant="secondary" disabled={value === '' || testing} onClick={() => void runTest(value)}>
          {testing ? t('wizard_testing') : t('wizard_test')}
        </Button>
      </div>
      {testedValue === value && value !== '' && !failMsg && (
        <p className="text-sm text-fn-green">{t('wizard_test_passed')}</p>
      )}
      {failMsg && <p className="text-sm text-fn-red">{failMsg}</p>}
      <StepFooter onBack={onBack}>
        <Button disabled={testedValue !== value || value === '' || saving} onClick={() => void onSave()}>
          {t('wizard_save_continue')}
        </Button>
      </StepFooter>
    </div>
  )
}
```

注意：Input 用 `aria-label` 而不是 `<label>`——测试以 `getByLabelText('API key')` 定位；`type="password"` 防录屏/旁观者（wizard 输入的是密钥）。

- [ ] **Step 4: registry 登记（全文替换）**

`web/src/setup/steps/registry.ts`：

```ts
// web/src/setup/steps/registry.ts：七步登记处。顺序即 spec A §5.2 的步序，不许乱；
// Tasks 17-22 每落地一步在此追加一行，Task 23 才接进 App——任何中间态可构建、不可达生产。
import type { WizardStepDef } from './types.js'
import { StepLanguage } from './StepLanguage.js'
import { StepTmdb } from './StepTmdb.js'

export const WIZARD_STEPS: WizardStepDef[] = [
  { id: 'language', titleKey: 'wizard_step_language_title', descKey: 'wizard_step_language_desc', optional: false, Component: StepLanguage },
  { id: 'tmdb', titleKey: 'wizard_step_tmdb_title', descKey: 'wizard_step_tmdb_desc', optional: false, Component: StepTmdb },
  // Task 18: llm / Task 19: providers / Task 20: free / Task 21: roots / Task 22: launch
]
```

Run: `cd web && npx vitest run src/setup`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/setup
git commit -m "feat(web): wizard 步 2 TMDB 硬门禁（先测后存）+ 步件共享 ui（spec A §5.2）"
```

### Task 18: Step 3 LLM 三件套（硬门禁）

**Files:**
- Create: `web/src/setup/steps/StepLlm.tsx`
- Test: `web/src/setup/steps/StepLlm.test.tsx`
- Modify: `web/src/setup/steps/registry.ts`

与步 2 同一先测后存骨架，两处不同：① 三字段齐填才能 Test（三件套缺一即不满足，spec §4.4 的 llmSatisfied 同口径）；② 保存 = 三次顺序 `putSecret`（PUT 端点单键语义；中途失败已存的留下次覆盖，幂等无脏态）。`testedTriple` 用 `\n` 拼接三值做"测绿的那个组合"判等。

- [ ] **Step 1: 先写失败测试**

Create `web/src/setup/steps/StepLlm.test.tsx`：

```tsx
// web/src/setup/steps/StepLlm.test.tsx：步 3 硬门禁——三字段齐填才能 Test；测绿的组合才能存；
// 保存 = 三次顺序 putSecret；env 锁定展示 model 名（model 非密）；db 已配 Re-test 不带凭据。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../../i18n/useT.js'
import { api } from '../../api/client.js'
import type { SetupStatusDTO } from '../../api/types.js'
import { StepLlm } from './StepLlm.js'
import type { WizardStepProps } from './types.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const BASE: SetupStatusDTO = {
  bootstrapComplete: false,
  tmdb: { satisfied: true, source: 'db', masked: null },
  llm: { satisfied: false, source: 'none', model: null },
  providers: {
    assrt: { satisfied: false, source: 'none', masked: null },
    opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
    jimaku: { satisfied: false, source: 'none', masked: null },
    subhd: { enabled: false, source: 'none' },
    zimuku: { enabled: false, source: 'none', captchaReady: false },
  },
  roots: { count: 0 },
  engineEnabled: true,
}

function props(over: Partial<WizardStepProps> = {}): WizardStepProps {
  return {
    status: BASE, patchStatus: () => {}, rerun: false,
    onAdvance: () => {}, onBack: () => {}, onComplete: () => {}, ...over,
  }
}

function renderStep(over: Partial<WizardStepProps> = {}) {
  return render(<I18nProvider initialLang="en"><StepLlm {...props(over)} /></I18nProvider>)
}

function fillTriple() {
  fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.example.com/v1' } })
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-1' } })
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'm-1' } })
}

describe('StepLlm', () => {
  it('三字段未齐 → Test 禁用', () => {
    renderStep()
    expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://x/v1' } })
    expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled()
  })

  it('齐填 → Test 打三件套凭据；绿了解锁 Save', async () => {
    const validate = vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    renderStep()
    fillTriple()
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await waitFor(() =>
      expect(validate).toHaveBeenCalledWith('llm', {
        LLM_BASE_URL: 'https://api.example.com/v1', LLM_API_KEY: 'sk-1', LLM_MODEL: 'm-1',
      }),
    )
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeEnabled()
  })

  it('测绿后改任一字段 → Save 重新禁用', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    renderStep()
    fillTriple()
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await screen.findByText('Connected')
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'm-2' } })
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled()
  })

  it('Save → 三次顺序 putSecret + patchStatus(model 可见) + onAdvance', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    const patchStatus = vi.fn()
    const onAdvance = vi.fn()
    renderStep({ patchStatus, onAdvance })
    fillTriple()
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await screen.findByText('Connected')
    fireEvent.click(screen.getByRole('button', { name: 'Save & continue' }))
    await waitFor(() => expect(onAdvance).toHaveBeenCalledTimes(1))
    expect(put.mock.calls).toEqual([
      ['LLM_BASE_URL', 'https://api.example.com/v1'],
      ['LLM_API_KEY', 'sk-1'],
      ['LLM_MODEL', 'm-1'],
    ])
    expect(patchStatus).toHaveBeenCalledWith({ llm: { satisfied: true, source: 'db', model: 'm-1' } })
  })

  it('env 已配 → 锁定绿态展示 model 名（非密），零输入', () => {
    const onAdvance = vi.fn()
    renderStep({ onAdvance, status: { ...BASE, llm: { satisfied: true, source: 'env', model: 'env-model' } } })
    expect(screen.getByText(/Configured via environment/)).toBeInTheDocument()
    expect(screen.getByText(/env-model/)).toBeInTheDocument()
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onAdvance).toHaveBeenCalledTimes(1)
  })

  it('db 已配 → Re-test 不带凭据', async () => {
    const validate = vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const onAdvance = vi.fn()
    renderStep({ rerun: true, onAdvance, status: { ...BASE, llm: { satisfied: true, source: 'db', model: 'm-1' } } })
    fireEvent.click(screen.getByRole('button', { name: 'Re-test' }))
    await waitFor(() => expect(validate).toHaveBeenCalledWith('llm'))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onAdvance).toHaveBeenCalledTimes(1)
  })

  it('validate 端点自身挂了（reject）→ 第四态文案，不回显异常串（spec §7/§8）', async () => {
    vi.spyOn(api, 'validateSetup').mockRejectedValue(new Error('HTTP 500 boom'))
    renderStep()
    fillTriple()
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    expect(await screen.findByText('Test unavailable, retry')).toBeInTheDocument()
    expect(screen.queryByText(/HTTP 500/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled()
  })

  it('Test 返回 ok:false → 行内服务端分类错误；Save 保持禁用', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: false, error: 'Invalid credentials' })
    renderStep()
    fillTriple()
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled()
  })
})
```

Run: `cd web && npx vitest run src/setup/steps/StepLlm.test.tsx`
Expected: FAIL（`./StepLlm.js` 不存在）

- [ ] **Step 2: StepLlm 实现**

Create `web/src/setup/steps/StepLlm.tsx`：

```tsx
// web/src/setup/steps/StepLlm.tsx：wizard 步 3——LLM 三件套（硬门禁，spec A §3/§5.2 步 3）。
// 三字段齐填才能 Test（与 setupApi 的 llmSatisfied 同口径）；测绿的组合才能存；
// 保存 = 三次顺序 putSecret（端点单键；中途失败已存的留下次覆盖，幂等）。
import { useState } from 'react'
import { api } from '../../api/client.js'
import { useT } from '../../i18n/useT.js'
import { Button } from '../../components/ui/button.js'
import { Input } from '../../components/ui/input.js'
import { StatusDot, StepFooter } from './ui.js'
import type { WizardStepProps } from './types.js'

export function StepLlm({ status, patchStatus, onAdvance, onBack }: WizardStepProps) {
  const { t } = useT()
  const [base, setBase] = useState('')
  const [key, setKey] = useState('')
  const [model, setModel] = useState('')
  const [testing, setTesting] = useState(false)
  const [testedTriple, setTestedTriple] = useState<string | null>(null)
  const [failMsg, setFailMsg] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const tripleKey = `${base}\n${key}\n${model}`
  const filled = base !== '' && key !== '' && model !== ''
  const green = testedTriple === tripleKey && filled

  const runTest = async () => {
    setTesting(true)
    setFailMsg(null)
    try {
      const r = await api.validateSetup('llm', { LLM_BASE_URL: base, LLM_API_KEY: key, LLM_MODEL: model })
      if (r.ok) setTestedTriple(tripleKey)
      else setFailMsg(r.error ?? r.detail ?? t('wizard_test_failed'))
    } catch (e) {
      // 同 Task 17：端点自身挂了 ≠ 凭据不对（spec §7），不回显异常串。
      void e
      setFailMsg(t('wizard_test_unavailable'))
    } finally {
      setTesting(false)
    }
  }

  const retestResolved = async () => {
    setTesting(true)
    setFailMsg(null)
    try {
      const r = await api.validateSetup('llm')
      if (!r.ok) setFailMsg(r.error ?? r.detail ?? t('wizard_test_failed'))
    } catch (e) {
      void e
      setFailMsg(t('wizard_test_unavailable'))
    } finally {
      setTesting(false)
    }
  }

  const onSave = async () => {
    setSaving(true)
    setFailMsg(null)
    try {
      await api.putSecret('LLM_BASE_URL', base)
      await api.putSecret('LLM_API_KEY', key)
      await api.putSecret('LLM_MODEL', model)
      patchStatus({ llm: { satisfied: true, source: 'db', model } })
      onAdvance()
    } catch (e) {
      setFailMsg(String(e))
      setSaving(false)
    }
  }

  if (status.llm.source === 'env') {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-2 text-sm">
          <StatusDot tone="green" />
          <span>
            {t('wizard_env_locked')}{status.llm.model ? ` · ${status.llm.model}` : ''}
          </span>
        </div>
        <StepFooter onBack={onBack}>
          <Button onClick={onAdvance}>{t('wizard_continue')}</Button>
        </StepFooter>
      </div>
    )
  }

  if (status.llm.satisfied) {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-2 text-sm">
          <StatusDot tone="green" />
          <span>{t('wizard_test_passed')}{status.llm.model ? ` · ${status.llm.model}` : ''}</span>
          <Button variant="ghost" size="sm" disabled={testing} onClick={() => void retestResolved()}>
            {testing ? t('wizard_testing') : t('wizard_retest')}
          </Button>
        </div>
        {failMsg && <p className="text-sm text-fn-red">{failMsg}</p>}
        <StepFooter onBack={onBack}>
          <Button onClick={onAdvance}>{t('wizard_continue')}</Button>
        </StepFooter>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('wizard_llm_required_note')}</p>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Input
            aria-label={t('wizard_llm_base_label')}
            value={base}
            onChange={(e) => {
              setBase(e.target.value)
              setFailMsg(null)
            }}
            placeholder={t('wizard_llm_base_label')}
            className="max-w-[420px]"
          />
          <span className="text-xs text-weak">{t('wizard_llm_base_hint')}</span>
        </div>
        <Input
          aria-label={t('wizard_llm_key_label')}
          type="password"
          value={key}
          onChange={(e) => {
            setKey(e.target.value)
            setFailMsg(null)
          }}
          placeholder={t('wizard_llm_key_label')}
          className="max-w-[420px]"
        />
        <Input
          aria-label={t('wizard_llm_model_label')}
          value={model}
          onChange={(e) => {
            setModel(e.target.value)
            setFailMsg(null)
          }}
          placeholder={t('wizard_llm_model_placeholder')}
          className="max-w-[420px]"
        />
      </div>
      <div className="flex items-center gap-2">
        <StatusDot tone={testing ? 'spin' : green ? 'green' : failMsg ? 'red' : 'gray'} />
        <Button variant="secondary" disabled={!filled || testing} onClick={() => void runTest()}>
          {testing ? t('wizard_testing') : t('wizard_test')}
        </Button>
        {green && !failMsg && <span className="text-sm text-fn-green">{t('wizard_test_passed')}</span>}
      </div>
      {failMsg && <p className="text-sm text-fn-red">{failMsg}</p>}
      <StepFooter onBack={onBack}>
        <Button disabled={!green || saving} onClick={() => void onSave()}>
          {t('wizard_save_continue')}
        </Button>
      </StepFooter>
    </div>
  )
}
```

- [ ] **Step 3: registry 登记（全文替换）**

```ts
// web/src/setup/steps/registry.ts：七步登记处。顺序即 spec A §5.2 的步序，不许乱；
// Tasks 17-22 每落地一步在此追加一行，Task 23 才接进 App——任何中间态可构建、不可达生产。
import type { WizardStepDef } from './types.js'
import { StepLanguage } from './StepLanguage.js'
import { StepTmdb } from './StepTmdb.js'
import { StepLlm } from './StepLlm.js'

export const WIZARD_STEPS: WizardStepDef[] = [
  { id: 'language', titleKey: 'wizard_step_language_title', descKey: 'wizard_step_language_desc', optional: false, Component: StepLanguage },
  { id: 'tmdb', titleKey: 'wizard_step_tmdb_title', descKey: 'wizard_step_tmdb_desc', optional: false, Component: StepTmdb },
  { id: 'llm', titleKey: 'wizard_step_llm_title', descKey: 'wizard_step_llm_desc', optional: false, Component: StepLlm },
  // Task 19: providers / Task 20: free / Task 21: roots / Task 22: launch
]
```

Run: `cd web && npx vitest run src/setup`
Expected: 全 PASS

- [ ] **Step 4: Commit**

```bash
git add web/src/setup
git commit -m "feat(web): wizard 步 3 LLM 三件套硬门禁（spec A §5.2）"
```

### Task 19: Step 4 字幕 provider（可跳过，只存测绿的）

**Files:**
- Create: `web/src/setup/steps/StepProviders.tsx`
- Test: `web/src/setup/steps/StepProviders.test.tsx`
- Modify: `web/src/setup/steps/registry.ts`

软门禁语义（spec A §3 步 4 + §5.2）：每家各带 Test + 状态点；红不拦路、行内写明后果；**只保存测绿的 key**（wizard_providers_save_note 原话）；Save & continue 在零绿时禁用（全红/全空就该走 Skip）；env 已满足的家锁定展示、不占"绿"名额。OpenSubtitles 的 username/password **成对才存**（与 setupApi 的 hasUsername 同口径，单填视为未填——测试与保存都按对取舍）。

- [ ] **Step 1: 先写失败测试**

Create `web/src/setup/steps/StepProviders.test.tsx`：

```tsx
// web/src/setup/steps/StepProviders.test.tsx：步 4 软门禁——各测各的、红不拦路、只存绿的；
// 零绿时 Save 禁用走 Skip；OS 用户名密码成对才存；env 满足家锁定零输入。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../../i18n/useT.js'
import { api } from '../../api/client.js'
import type { SetupStatusDTO } from '../../api/types.js'
import { StepProviders } from './StepProviders.js'
import type { WizardStepProps } from './types.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const BASE: SetupStatusDTO = {
  bootstrapComplete: false,
  tmdb: { satisfied: true, source: 'db', masked: null },
  llm: { satisfied: true, source: 'db', model: 'm-1' },
  providers: {
    assrt: { satisfied: false, source: 'none', masked: null },
    opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
    jimaku: { satisfied: false, source: 'none', masked: null },
    subhd: { enabled: true, source: 'db' },
    zimuku: { enabled: true, source: 'db', captchaReady: true },
  },
  roots: { count: 0 },
  engineEnabled: true,
}

function props(over: Partial<WizardStepProps> = {}): WizardStepProps {
  return {
    status: BASE, patchStatus: () => {}, rerun: false,
    onAdvance: () => {}, onBack: () => {}, onComplete: () => {}, ...over,
  }
}

function renderStep(over: Partial<WizardStepProps> = {}) {
  return render(<I18nProvider initialLang="en"><StepProviders {...props(over)} /></I18nProvider>)
}

describe('StepProviders', () => {
  it('横幅与保存说明在；初始零绿 → Save 禁用；Skip 直接走', () => {
    const onAdvance = vi.fn()
    renderStep({ onAdvance })
    expect(screen.getByText(/subhd and zimuku are built-in free sources/)).toBeInTheDocument()
    expect(screen.getByText(/Only keys that pass the test are saved/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Skip this step' }))
    expect(onAdvance).toHaveBeenCalledTimes(1)
  })

  it('ASSRT 测绿 → Save 解锁；Save 只 PUT  ASSRT_TOKEN', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    const patchStatus = vi.fn()
    const onAdvance = vi.fn()
    renderStep({ patchStatus, onAdvance })
    const block = within(screen.getByTestId('provider-assrt'))
    fireEvent.change(block.getByLabelText('ASSRT token'), { target: { value: 'at-1' } })
    fireEvent.click(block.getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save & continue' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Save & continue' }))
    await waitFor(() => expect(onAdvance).toHaveBeenCalledTimes(1))
    expect(put.mock.calls).toEqual([['ASSRT_TOKEN', 'at-1']])
    // patchStatus 收到的是**整只** providers 子对象（实现里 `{ ...status.providers, ...patch }`
    // 把五家全展开了——见本 Task Step 2 的注释）。所以不能裸断言 `{ assrt: … }`：那既漏了
    // `providers` 这层包装，也漏了没动的另外四家，toHaveBeenCalledWith 是深相等，必红。
    // 只关心"assrt 那家变绿了"，就用两层 objectContaining。
    expect(patchStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.objectContaining({
          assrt: { satisfied: true, source: 'db', masked: null },
        }),
      }),
    )
    // 整只替换语义下的反向护栏：subhd/zimuku 必须原样活着（spread 不可丢家）。
    expect(patchStatus.mock.calls[0][0].providers.subhd).toEqual(BASE.providers.subhd)
    expect(patchStatus.mock.calls[0][0].providers.zimuku).toEqual(BASE.providers.zimuku)
  })

  it('一家绿一家红 → 只存绿的那家', async () => {
    vi.spyOn(api, 'validateSetup').mockImplementation(async (target) =>
      target === 'assrt' ? { ok: true } : { ok: false, error: 'Invalid credentials' },
    )
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    const onAdvance = vi.fn()
    renderStep({ onAdvance })
    const assrt = within(screen.getByTestId('provider-assrt'))
    fireEvent.change(assrt.getByLabelText('ASSRT token'), { target: { value: 'at-1' } })
    fireEvent.click(assrt.getByRole('button', { name: 'Test' }))
    const jimaku = within(screen.getByTestId('provider-jimaku'))
    fireEvent.change(jimaku.getByLabelText('Jimaku API key'), { target: { value: 'jk-bad' } })
    fireEvent.click(jimaku.getByRole('button', { name: 'Test' }))
    await screen.findByText('Without Jimaku, one fewer subtitle source.')
    fireEvent.click(screen.getByRole('button', { name: 'Save & continue' }))
    await waitFor(() => expect(onAdvance).toHaveBeenCalledTimes(1))
    expect(put.mock.calls).toEqual([['ASSRT_TOKEN', 'at-1']])
  })

  it('OS：apiKey 绿 + 只填 username（缺 password）→ 成对规则只存 apiKey', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    const onAdvance = vi.fn()
    renderStep({ onAdvance })
    const os = within(screen.getByTestId('provider-opensubtitles'))
    fireEvent.change(os.getByLabelText('OpenSubtitles API key'), { target: { value: 'osk-1' } })
    // 定位串必须是 i18n 里 `wizard_os_user_label` 的原文 'OpenSubtitles username (optional)'
    // ——不是 'Username'。三个 OS 字段的 aria-label 都由 PROVIDER_FIELDS 的 labelKey 经 t() 生成
    // （见 Step 2），字典里怎么写，测试就得怎么查。
    fireEvent.change(os.getByLabelText('OpenSubtitles username (optional)'), { target: { value: 'alice' } })
    fireEvent.click(os.getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save & continue' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Save & continue' }))
    await waitFor(() => expect(onAdvance).toHaveBeenCalledTimes(1))
    expect(put.mock.calls).toEqual([['OPENSUBTITLES_API_KEY', 'osk-1']])
    // 成对规则同样约束测试路径：单填的 username 不得进 validate 的 credentials。
    expect(vi.mocked(api.validateSetup).mock.calls[0]).toEqual(['opensubtitles', { OPENSUBTITLES_API_KEY: 'osk-1' }])
  })

  it('OS：apiKey 绿 + username/password 成对填满 → 三键全存且 hasUsername: true', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    const patchStatus = vi.fn()
    const onAdvance = vi.fn()
    renderStep({ patchStatus, onAdvance })
    const os = within(screen.getByTestId('provider-opensubtitles'))
    fireEvent.change(os.getByLabelText('OpenSubtitles API key'), { target: { value: 'osk-1' } })
    fireEvent.change(os.getByLabelText('OpenSubtitles username (optional)'), { target: { value: 'alice' } })
    fireEvent.change(os.getByLabelText('OpenSubtitles password (optional)'), { target: { value: 'pw-1' } })
    fireEvent.click(os.getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save & continue' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Save & continue' }))
    await waitFor(() => expect(onAdvance).toHaveBeenCalledTimes(1))
    expect(put.mock.calls).toEqual([
      ['OPENSUBTITLES_API_KEY', 'osk-1'],
      ['OPENSUBTITLES_USERNAME', 'alice'],
      ['OPENSUBTITLES_PASSWORD', 'pw-1'],
    ])
    // inclusion 侧钉子（Task 26 评审遗留补测）：成对填满时 validate 必须收到三键全量凭据。
    expect(vi.mocked(api.validateSetup).mock.calls[0]).toEqual([
      'opensubtitles',
      { OPENSUBTITLES_API_KEY: 'osk-1', OPENSUBTITLES_USERNAME: 'alice', OPENSUBTITLES_PASSWORD: 'pw-1' },
    ])
    expect(patchStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.objectContaining({
          opensubtitles: expect.objectContaining({ hasUsername: true }),
        }),
      }),
    )
  })

  it('env 满足的家锁定展示、无输入框、不占绿名额', () => {
    renderStep({
      status: {
        ...BASE,
        providers: { ...BASE.providers, assrt: { satisfied: true, source: 'env', masked: 'abc••••xyz' } },
      },
    })
    const block = within(screen.getByTestId('provider-assrt'))
    expect(block.getByText(/Configured via environment/)).toBeInTheDocument()
    expect(block.queryByLabelText('ASSRT token')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled()
  })

  it('测红 → 红点 + 行内错误 + 后果句；不拦其他家', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: false, error: 'Invalid credentials' })
    renderStep()
    const assrt = within(screen.getByTestId('provider-assrt'))
    fireEvent.change(assrt.getByLabelText('ASSRT token'), { target: { value: 'bad' } })
    fireEvent.click(assrt.getByRole('button', { name: 'Test' }))
    await screen.findByText('Without ASSRT, one fewer subtitle source.')
    expect(assrt.getByTestId('status-dot-red')).toBeInTheDocument()
    expect(within(screen.getByTestId('provider-jimaku')).getByLabelText('Jimaku API key')).toBeEnabled()
  })

  it('validate 端点自身挂了（reject）→ 第四态文案，不回显异常串（spec §7/§8）', async () => {
    vi.spyOn(api, 'validateSetup').mockRejectedValue(new Error('HTTP 500 boom'))
    renderStep()
    const assrt = within(screen.getByTestId('provider-assrt'))
    fireEvent.change(assrt.getByLabelText('ASSRT token'), { target: { value: 'tok-1' } })
    fireEvent.click(assrt.getByRole('button', { name: 'Test' }))
    expect(await screen.findByText('Test unavailable, retry')).toBeInTheDocument()
    expect(screen.queryByText(/HTTP 500/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled()
  })
})
```

Run: `cd web && npx vitest run src/setup/steps/StepProviders.test.tsx`
Expected: FAIL（`./StepProviders.js` 不存在）

- [ ] **Step 2: StepProviders 实现**

Create `web/src/setup/steps/StepProviders.tsx`：

```tsx
// web/src/setup/steps/StepProviders.tsx：wizard 步 4——ASSRT/OpenSubtitles/Jimaku（软门禁，
// spec A §3 步 4）。各家自测自存：只有测绿的 key 会落库；红不拦路、行内写后果；零绿时
// Save 禁用、走 Skip。OS 的 username/password 成对才存（与 setupApi hasUsername 同口径）。
import { useState } from 'react'
import { api } from '../../api/client.js'
import { useT } from '../../i18n/useT.js'
import { Button } from '../../components/ui/button.js'
import { Input } from '../../components/ui/input.js'
import { StatusDot, StepFooter } from './ui.js'
import type { SecretName, SetupStatusDTO } from '../../api/types.js'
import type { TKey } from '../../i18n/useT.js'
import type { WizardStepProps } from './types.js'

type ProviderId = 'assrt' | 'opensubtitles' | 'jimaku'

interface FieldDef {
  name: SecretName
  labelKey: TKey
  password: boolean
  required: boolean
}

const PROVIDER_FIELDS: Record<ProviderId, FieldDef[]> = {
  assrt: [{ name: 'ASSRT_TOKEN', labelKey: 'wizard_assrt_label', password: true, required: true }],
  opensubtitles: [
    { name: 'OPENSUBTITLES_API_KEY', labelKey: 'wizard_os_apikey_label', password: true, required: true },
    { name: 'OPENSUBTITLES_USERNAME', labelKey: 'wizard_os_user_label', password: false, required: false },
    { name: 'OPENSUBTITLES_PASSWORD', labelKey: 'wizard_os_pass_label', password: true, required: false },
  ],
  jimaku: [{ name: 'JIMAKU_API_KEY', labelKey: 'wizard_jimaku_label', password: true, required: true }],
}

const CONSEQUENCE_KEY: Record<ProviderId, TKey> = {
  assrt: 'wizard_consequence_assrt',
  opensubtitles: 'wizard_consequence_os',
  jimaku: 'wizard_consequence_jimaku',
}

interface BlockState {
  values: Partial<Record<SecretName, string>>
  testing: boolean
  testedKey: string | null
  failMsg: string | null
}

const EMPTY_BLOCK: BlockState = { values: {}, testing: false, testedKey: null, failMsg: null }

function currentKey(id: ProviderId, values: Partial<Record<SecretName, string>>): string {
  return PROVIDER_FIELDS[id].map((f) => values[f.name] ?? '').join('\n')
}

function testable(id: ProviderId, values: Partial<Record<SecretName, string>>): boolean {
  return PROVIDER_FIELDS[id].every((f) => !f.required || (values[f.name] ?? '') !== '')
}

export function StepProviders({ status, patchStatus, onAdvance, onBack }: WizardStepProps) {
  const { t } = useT()
  const [blocks, setBlocks] = useState<Record<ProviderId, BlockState>>({
    assrt: EMPTY_BLOCK, opensubtitles: EMPTY_BLOCK, jimaku: EMPTY_BLOCK,
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const setBlock = (id: ProviderId, patch: Partial<BlockState>) =>
    setBlocks((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))

  const green = (id: ProviderId): boolean => {
    const b = blocks[id]
    return b.testedKey !== null && b.testedKey === currentKey(id, b.values) && testable(id, b.values)
  }
  const anyGreen = (['assrt', 'opensubtitles', 'jimaku'] as ProviderId[]).some(green)

  const runTest = async (id: ProviderId) => {
    const b = blocks[id]
    setBlock(id, { testing: true, failMsg: null })
    try {
      // OS 的 username/password 成对才参与测试与保存——单填视为未填（setupApi hasUsername 同口径）。
      const credentials: Partial<Record<SecretName, string>> = {}
      for (const f of PROVIDER_FIELDS[id]) {
        const v = b.values[f.name] ?? ''
        if (v === '') continue
        if (f.name === 'OPENSUBTITLES_USERNAME' && (b.values.OPENSUBTITLES_PASSWORD ?? '') === '') continue
        if (f.name === 'OPENSUBTITLES_PASSWORD' && (b.values.OPENSUBTITLES_USERNAME ?? '') === '') continue
        credentials[f.name] = v
      }
      const r = await api.validateSetup(id, credentials)
      if (r.ok) setBlock(id, { testing: false, testedKey: currentKey(id, b.values) })
      else setBlock(id, { testing: false, failMsg: r.error ?? r.detail ?? t('wizard_test_failed') })
    } catch (e) {
      // 同 Task 17/18：端点自身挂了 ≠ 凭据不对（spec §7）。
      void e
      setBlock(id, { testing: false, failMsg: t('wizard_test_unavailable') })
    }
  }

  const onSave = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      for (const id of ['assrt', 'opensubtitles', 'jimaku'] as ProviderId[]) {
        if (!green(id)) continue
        const b = blocks[id]
        for (const f of PROVIDER_FIELDS[id]) {
          const v = b.values[f.name] ?? ''
          if (v === '') continue
          if (f.name === 'OPENSUBTITLES_USERNAME' && (b.values.OPENSUBTITLES_PASSWORD ?? '') === '') continue
          if (f.name === 'OPENSUBTITLES_PASSWORD' && (b.values.OPENSUBTITLES_USERNAME ?? '') === '') continue
          await api.putSecret(f.name, v)
        }
      }
      // patchStatus 一次性组出三家新态——只动测绿的家，其余保持 status 原值。
      const patch: Partial<SetupStatusDTO['providers']> = {}
      if (green('assrt')) patch.assrt = { satisfied: true, source: 'db', masked: null }
      if (green('opensubtitles')) {
        const b = blocks.opensubtitles
        const paired = (b.values.OPENSUBTITLES_USERNAME ?? '') !== '' && (b.values.OPENSUBTITLES_PASSWORD ?? '') !== ''
        patch.opensubtitles = { satisfied: true, source: 'db', hasUsername: paired, masked: null }
      }
      if (green('jimaku')) patch.jimaku = { satisfied: true, source: 'db', masked: null }
      patchStatus({ providers: { ...status.providers, ...patch } })
      onAdvance()
    } catch (e) {
      setSaveError(String(e))
      setSaving(false)
    }
  }

  const renderBlock = (id: ProviderId) => {
    const satisfied = status.providers[id].satisfied
    const masked = status.providers[id].masked
    const source = status.providers[id].source
    const b = blocks[id]
    if (satisfied) {
      return (
        <section key={id} data-testid={`provider-${id}`} className="flex items-center gap-2 text-sm">
          <StatusDot tone="green" />
          <span>
            {source === 'env' ? t('wizard_env_locked') : t('wizard_test_passed')}
            {masked ? ` · ${masked}` : ''}
          </span>
        </section>
      )
    }
    const isGreen = green(id)
    return (
      <section key={id} data-testid={`provider-${id}`} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusDot tone={b.testing ? 'spin' : isGreen ? 'green' : b.failMsg ? 'red' : 'gray'} />
          {PROVIDER_FIELDS[id].map((f) => (
            <Input
              key={f.name}
              aria-label={t(f.labelKey)}
              type={f.password ? 'password' : 'text'}
              value={b.values[f.name] ?? ''}
              onChange={(e) =>
                setBlock(id, { values: { ...b.values, [f.name]: e.target.value }, failMsg: null })
              }
              placeholder={t(f.labelKey)}
              className="max-w-[260px]"
            />
          ))}
          <Button variant="secondary" disabled={!testable(id, b.values) || b.testing} onClick={() => void runTest(id)}>
            {b.testing ? t('wizard_testing') : t('wizard_test')}
          </Button>
          {isGreen && <span className="text-sm text-fn-green">{t('wizard_test_passed')}</span>}
        </div>
        {b.failMsg && (
          <>
            <p className="text-sm text-fn-red">{b.failMsg}</p>
            <p className="text-sm text-weak">{t(CONSEQUENCE_KEY[id])}</p>
          </>
        )}
      </section>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('wizard_providers_banner')}</p>
      {renderBlock('assrt')}
      {renderBlock('opensubtitles')}
      {renderBlock('jimaku')}
      <p className="text-xs text-weak">{t('wizard_providers_save_note')}</p>
      {saveError && <p className="text-sm text-fn-red">{saveError}</p>}
      <StepFooter onBack={onBack}>
        <Button variant="ghost" onClick={onAdvance}>{t('wizard_skip_step')}</Button>
        <Button disabled={!anyGreen || saving} onClick={() => void onSave()}>
          {t('wizard_save_continue')}
        </Button>
      </StepFooter>
    </div>
  )
}
```

注意 `patchStatus({ providers: { ...status.providers, ...patch } })`——providers 子对象是**整体替换**语义（types.ts 的 patchStatus 契约：浅合并、子对象整体替换），所以这里先展开原三家再覆盖绿的，不丢 subhd/zimuku。

- [ ] **Step 3: registry 登记（全文替换）**

```ts
// web/src/setup/steps/registry.ts：七步登记处。顺序即 spec A §5.2 的步序，不许乱；
// Tasks 17-22 每落地一步在此追加一行，Task 23 才接进 App——任何中间态可构建、不可达生产。
import type { WizardStepDef } from './types.js'
import { StepLanguage } from './StepLanguage.js'
import { StepTmdb } from './StepTmdb.js'
import { StepLlm } from './StepLlm.js'
import { StepProviders } from './StepProviders.js'

export const WIZARD_STEPS: WizardStepDef[] = [
  { id: 'language', titleKey: 'wizard_step_language_title', descKey: 'wizard_step_language_desc', optional: false, Component: StepLanguage },
  { id: 'tmdb', titleKey: 'wizard_step_tmdb_title', descKey: 'wizard_step_tmdb_desc', optional: false, Component: StepTmdb },
  { id: 'llm', titleKey: 'wizard_step_llm_title', descKey: 'wizard_step_llm_desc', optional: false, Component: StepLlm },
  { id: 'providers', titleKey: 'wizard_step_providers_title', descKey: 'wizard_step_providers_desc', optional: true, Component: StepProviders },
  // Task 20: free / Task 21: roots / Task 22: launch
]
```

Run: `cd web && npx vitest run src/setup`
Expected: 全 PASS

- [ ] **Step 4: Commit**

```bash
git add web/src/setup
git commit -m "feat(web): wizard 步 4 字幕 provider 软门禁（只存测绿的，spec A §5.2）"
```

### Task 20: Step 5 免费源（subhd / zimuku 开关制，默认 ON）

**Files:**
- Create: `web/src/setup/steps/StepFreeSources.tsx`
- Test: `web/src/setup/steps/StepFreeSources.test.tsx`
- Modify: `web/src/setup/steps/registry.ts`

开关制语义（spec A §3 步 5 + §4.4）：无 key 的两家，**wizard 路径出厂 ON**——`source==='none'`（env 没设、库没写过）初始化 ON；env/db 已有值 → 用现值。进步骤自动并行做可达性测试（`validateSetup` 不带凭据），**只展示不拦截**（不可达也保持 ON，运行期自有重试——wizard_free_reach_fail 原话）。zimuku 行尾标注 captcha 解算器状态（= LLM 已通）。Continue 把开关写进 `provider:SUBHD_ENABLED` / `provider:ZIMUKU_ENABLED`（复用 PUT /api/v2/settings，不另起端点）；env 锁定家不写库、开关禁用。

- [ ] **Step 1: 先写失败测试**

Create `web/src/setup/steps/StepFreeSources.test.tsx`：

```tsx
// web/src/setup/steps/StepFreeSources.test.tsx：步 5 开关制——source none 出厂 ON；
// 可达性只展示不拦截；Continue 只写非 env 锁定家的 flag；zimuku captcha 状态行。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../../i18n/useT.js'
import { api } from '../../api/client.js'
import type { SetupStatusDTO } from '../../api/types.js'
import { StepFreeSources } from './StepFreeSources.js'
import type { WizardStepProps } from './types.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const BASE: SetupStatusDTO = {
  bootstrapComplete: false,
  tmdb: { satisfied: true, source: 'db', masked: null },
  llm: { satisfied: true, source: 'db', model: 'm-1' },
  providers: {
    assrt: { satisfied: false, source: 'none', masked: null },
    opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
    jimaku: { satisfied: false, source: 'none', masked: null },
    subhd: { enabled: false, source: 'none' },
    zimuku: { enabled: false, source: 'none', captchaReady: true },
  },
  roots: { count: 0 },
  engineEnabled: true,
}

function props(over: Partial<WizardStepProps> = {}): WizardStepProps {
  return {
    status: BASE, patchStatus: () => {}, rerun: false,
    onAdvance: () => {}, onBack: () => {}, onComplete: () => {}, ...over,
  }
}

function renderStep(over: Partial<WizardStepProps> = {}) {
  return render(<I18nProvider initialLang="en"><StepFreeSources {...props(over)} /></I18nProvider>)
}

describe('StepFreeSources', () => {
  it('source none 出厂双 ON；可达性从 checking 翻到 ok', async () => {
    const validate = vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    renderStep()
    expect(screen.getByRole('switch', { name: 'subhd' })).toHaveAttribute('data-state', 'checked')
    expect(screen.getByRole('switch', { name: 'zimuku' })).toHaveAttribute('data-state', 'checked')
    await waitFor(() => expect(screen.getAllByText('Reachable')).toHaveLength(2))
    expect(validate).toHaveBeenCalledWith('subhd')
    expect(validate).toHaveBeenCalledWith('zimuku')
  })

  it('关掉 subhd → Continue 写两个 flag（subhd false / zimuku true）并前进', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    const patchStatus = vi.fn()
    const onAdvance = vi.fn()
    renderStep({ patchStatus, onAdvance })
    fireEvent.click(screen.getByRole('switch', { name: 'subhd' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(onAdvance).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith({
      'provider:SUBHD_ENABLED': 'false',
      'provider:ZIMUKU_ENABLED': 'true',
    })
    // 同 Task 19：patchStatus 拿到的是整只 providers（`{ ...status.providers, ...statusPatch }`），
    // 裸断言两家会因缺 providers 包装 + 缺另外三家而红。captchaReady 取自 BASE（true），
    // 实现只是把它原样搬过去，不自己判定。
    expect(patchStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.objectContaining({
          subhd: { enabled: false, source: 'db' },
          zimuku: { enabled: true, source: 'db', captchaReady: true },
        }),
      }),
    )
  })

  it('env 锁定家：开关禁用、不写库，只写另一家', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    const onAdvance = vi.fn()
    renderStep({
      onAdvance,
      status: { ...BASE, providers: { ...BASE.providers, subhd: { enabled: true, source: 'env' } } },
    })
    expect(screen.getByRole('switch', { name: 'subhd' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(onAdvance).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith({ 'provider:ZIMUKU_ENABLED': 'true' })
  })

  it('zimuku captcha 状态行：captchaReady true → ready 文案；false → not ready', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    renderStep()
    expect(screen.getByText('Captcha solver: ready (LLM configured)')).toBeInTheDocument()
    cleanup()
    renderStep({
      status: { ...BASE, providers: { ...BASE.providers, zimuku: { enabled: false, source: 'none', captchaReady: false } } },
    })
    // 未就绪文案是 `wizard_zimuku_captcha_not_ready` = 'Captcha solver needs the LLM from step 3.'
    // ——里面**没有** "not ready" 这三个字，别照着 ready 那句取反造正则。
    expect(screen.getByText(/Captcha solver needs the LLM/)).toBeInTheDocument()
  })

  it('可达性失败 → 失败行展示但开关保持 ON（不拦截）', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: false, error: 'unreachable' })
    renderStep()
    await waitFor(() =>
      expect(screen.getAllByText('Unreachable — stays on, retried at runtime.')).toHaveLength(2),
    )
    expect(screen.getByRole('switch', { name: 'subhd' })).toHaveAttribute('data-state', 'checked')
  })

  // 以下两条为 Task 26 评审遗留补测（探针 reject 路径 + 双 env 锁定零写库）。
  it('可达性探针直接抛异常（网络断）→ 失败行展示但开关保持 ON（不拦截）', async () => {
    vi.spyOn(api, 'validateSetup').mockRejectedValue(new Error('network down'))
    renderStep()
    await waitFor(() =>
      expect(screen.getAllByText('Unreachable — stays on, retried at runtime.')).toHaveLength(2),
    )
    expect(screen.getByRole('switch', { name: 'subhd' })).toHaveAttribute('data-state', 'checked')
  })

  it('双 env 锁定 → Continue 零写库，直接前进', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    const onAdvance = vi.fn()
    renderStep({
      onAdvance,
      status: {
        ...BASE,
        providers: {
          ...BASE.providers,
          subhd: { enabled: true, source: 'env' },
          zimuku: { enabled: true, source: 'env', captchaReady: true },
        },
      },
    })
    expect(screen.getByRole('switch', { name: 'subhd' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'zimuku' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(onAdvance).toHaveBeenCalledTimes(1))
    expect(update).not.toHaveBeenCalled()
  })
})
```

Run: `cd web && npx vitest run src/setup/steps/StepFreeSources.test.tsx`
Expected: FAIL（`./StepFreeSources.js` 不存在）

- [ ] **Step 2: StepFreeSources 实现**

Create `web/src/setup/steps/StepFreeSources.tsx`：

```tsx
// web/src/setup/steps/StepFreeSources.tsx：wizard 步 5——subhd/zimuku 开关制（spec A §3 步 5）。
// wizard 路径出厂 ON（source==='none' 时初始 true）；可达性进页自动测、只展示不拦截；
// Continue 复用 PUT /api/v2/settings 写 provider flag（不另起端点）；env 锁定家不写。
import { useEffect, useState } from 'react'
import { api } from '../../api/client.js'
import { useT } from '../../i18n/useT.js'
import { Button } from '../../components/ui/button.js'
import { Switch } from '../../components/ui/switch.js'
import { StepFooter } from './ui.js'
import type { WizardStepProps } from './types.js'
// SetupStatusDTO 是下面 statusPatch 的类型来源（`Partial<SetupStatusDTO['providers']>`）。
import type { SetupStatusDTO } from '../../api/types.js'

type Reach = 'checking' | 'ok' | 'fail'

export function StepFreeSources({ status, patchStatus, onAdvance, onBack }: WizardStepProps) {
  const { t } = useT()
  const subhdLocked = status.providers.subhd.source === 'env'
  const zimukuLocked = status.providers.zimuku.source === 'env'
  // wizard 出厂 ON：只在"从没设过"（source none）时默认开；env/db 已有值用现值。
  const [subhdOn, setSubhdOn] = useState(
    status.providers.subhd.source === 'none' ? true : status.providers.subhd.enabled,
  )
  const [zimukuOn, setZimukuOn] = useState(
    status.providers.zimuku.source === 'none' ? true : status.providers.zimuku.enabled,
  )
  const [reach, setReach] = useState<{ subhd: Reach; zimuku: Reach }>({ subhd: 'checking', zimuku: 'checking' })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const probe = (target: 'subhd' | 'zimuku') =>
      api
        .validateSetup(target)
        .then((r) => alive && setReach((s) => ({ ...s, [target]: r.ok ? 'ok' : 'fail' })))
        .catch(() => alive && setReach((s) => ({ ...s, [target]: 'fail' })))
    void probe('subhd')
    void probe('zimuku')
    return () => {
      alive = false
    }
  }, [])

  const onContinue = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const patch: Partial<Record<'provider:SUBHD_ENABLED' | 'provider:ZIMUKU_ENABLED', string>> = {}
      if (!subhdLocked) patch['provider:SUBHD_ENABLED'] = String(subhdOn)
      if (!zimukuLocked) patch['provider:ZIMUKU_ENABLED'] = String(zimukuOn)
      if (Object.keys(patch).length > 0) await api.updateSettings(patch)
      // 类型是 `Partial<SetupStatusDTO['providers']>`——这个补丁攒的是 providers **子对象内部**的
      // 两家（subhd/zimuku），不是顶层快照。别写成 `Parameters<typeof patchStatus>[0]`
      // （= `Partial<SetupStatusDTO>`，顶层只有 bootstrapComplete/tmdb/llm/providers/roots/
      // engineEnabled 六个键）：那样 `statusPatch.subhd = …` 直接是 TS 报错。
      const statusPatch: Partial<SetupStatusDTO['providers']> = {}
      if (!subhdLocked) statusPatch.subhd = { enabled: subhdOn, source: 'db' }
      if (!zimukuLocked) {
        statusPatch.zimuku = {
          enabled: zimukuOn,
          source: 'db',
          captchaReady: status.providers.zimuku.captchaReady,
        }
      }
      if (Object.keys(statusPatch).length > 0) patchStatus({ providers: { ...status.providers, ...statusPatch } })
      onAdvance()
    } catch (e) {
      setSaveError(String(e))
      setSaving(false)
    }
  }

  const reachLine = (r: Reach) =>
    r === 'checking' ? t('wizard_free_reach_checking')
    : r === 'ok' ? t('wizard_free_reach_ok')
    : t('wizard_free_reach_fail')

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Switch
            aria-label={t('wizard_subhd_label')}
            checked={subhdOn}
            onCheckedChange={setSubhdOn}
            disabled={subhdLocked}
          />
          <span className="text-sm">{t('wizard_subhd_label')}</span>
          <span className="text-sm text-weak">{reachLine(reach.subhd)}</span>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Switch
            aria-label={t('wizard_zimuku_label')}
            checked={zimukuOn}
            onCheckedChange={setZimukuOn}
            disabled={zimukuLocked}
          />
          <span className="text-sm">{t('wizard_zimuku_label')}</span>
          <span className="text-sm text-weak">{reachLine(reach.zimuku)}</span>
        </div>
        <span className="text-xs text-weak">
          {status.providers.zimuku.captchaReady ? t('wizard_zimuku_captcha_ready') : t('wizard_zimuku_captcha_not_ready')}
        </span>
      </div>
      {saveError && <p className="text-sm text-fn-red">{saveError}</p>}
      <StepFooter onBack={onBack}>
        <Button disabled={saving} onClick={() => void onContinue()}>{t('wizard_continue')}</Button>
      </StepFooter>
    </div>
  )
}
```

- [ ] **Step 3: registry 登记（全文替换）**

```ts
// web/src/setup/steps/registry.ts：七步登记处。顺序即 spec A §5.2 的步序，不许乱；
// Tasks 17-22 每落地一步在此追加一行，Task 23 才接进 App——任何中间态可构建、不可达生产。
import type { WizardStepDef } from './types.js'
import { StepLanguage } from './StepLanguage.js'
import { StepTmdb } from './StepTmdb.js'
import { StepLlm } from './StepLlm.js'
import { StepProviders } from './StepProviders.js'
import { StepFreeSources } from './StepFreeSources.js'

export const WIZARD_STEPS: WizardStepDef[] = [
  { id: 'language', titleKey: 'wizard_step_language_title', descKey: 'wizard_step_language_desc', optional: false, Component: StepLanguage },
  { id: 'tmdb', titleKey: 'wizard_step_tmdb_title', descKey: 'wizard_step_tmdb_desc', optional: false, Component: StepTmdb },
  { id: 'llm', titleKey: 'wizard_step_llm_title', descKey: 'wizard_step_llm_desc', optional: false, Component: StepLlm },
  { id: 'providers', titleKey: 'wizard_step_providers_title', descKey: 'wizard_step_providers_desc', optional: true, Component: StepProviders },
  { id: 'free', titleKey: 'wizard_step_free_title', descKey: 'wizard_step_free_desc', optional: false, Component: StepFreeSources },
  // Task 21: roots / Task 22: launch
]
```

Run: `cd web && npx vitest run src/setup`
Expected: 全 PASS

- [ ] **Step 4: Commit**

```bash
git add web/src/setup
git commit -m "feat(web): wizard 步 5 免费源开关（出厂 ON + 可达性只展示，spec A §5.2）"
```

### Task 21: Step 6 守备目录（可跳过，复用既有 DirBrowser）

**Files:**
- Create: `web/src/setup/steps/StepRoots.tsx`
- Test: `web/src/setup/steps/StepRoots.test.tsx`
- Modify: `web/src/setup/steps/registry.ts`

spec A §5.2 步 6 说"复用 DirBrowser（从 RootsManager 抽成共享组件）"——**抽取已在代码库发生**：`web/src/settings/DirBrowser.tsx` 就是共享件，Props `{ startPath: string; onAdded: () => void }`，内部自带浏览/添加/调 `api.addRoot`（RootsManager `:92` 同款消费）。本步只做消费，**不再抽、不改 DirBrowser**（Astryx 栈随 C 退役，此处共存期无碍）。本地记 addedCount，每次 onAdded 同步 patchStatus roots 计数（Launch 步汇总要读）；零目录时 Continue 禁用、Skip 常驻并附后果说明。

- [ ] **Step 1: 先写失败测试**

Create `web/src/setup/steps/StepRoots.test.tsx`：

```tsx
// web/src/setup/steps/StepRoots.test.tsx：步 6 可跳过——零目录 Continue 禁用、Skip 常驻；
// DirBrowser 每加一个 → Continue 解锁 + roots 计数同步进 status（Launch 汇总读它）。
// DirBrowser 打桩：本步只验证消费契约 {startPath, onAdded}，不测浏览器内部（它有主）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nProvider } from '../../i18n/useT.js'
import type { SetupStatusDTO } from '../../api/types.js'
import { BootstrapWizard } from '../BootstrapWizard.js'
import { StepRoots } from './StepRoots.js'
import type { WizardStepDef, WizardStepProps } from './types.js'

vi.mock('../../settings/DirBrowser.js', () => ({
  DirBrowser: ({ startPath, onAdded }: { startPath: string; onAdded: () => void }) => (
    <button data-testid="dir-add" data-startpath={startPath} onClick={onAdded}>add</button>
  ),
}))

afterEach(cleanup)

const BASE: SetupStatusDTO = {
  bootstrapComplete: false,
  tmdb: { satisfied: true, source: 'db', masked: null },
  llm: { satisfied: true, source: 'db', model: 'm-1' },
  providers: {
    assrt: { satisfied: false, source: 'none', masked: null },
    opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
    jimaku: { satisfied: false, source: 'none', masked: null },
    subhd: { enabled: true, source: 'db' },
    zimuku: { enabled: true, source: 'db', captchaReady: true },
  },
  roots: { count: 0 },
  engineEnabled: true,
}

function props(over: Partial<WizardStepProps> = {}): WizardStepProps {
  return {
    status: BASE, patchStatus: () => {}, rerun: false,
    onAdvance: () => {}, onBack: () => {}, onComplete: () => {}, ...over,
  }
}

function renderStep(over: Partial<WizardStepProps> = {}) {
  return render(<I18nProvider initialLang="en"><StepRoots {...props(over)} /></I18nProvider>)
}

describe('StepRoots', () => {
  it('零目录：Continue 禁用；Skip 常驻并带后果说明', () => {
    const onAdvance = vi.fn()
    renderStep({ onAdvance })
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    expect(screen.getByText(/Library will stay empty until you add roots/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Skip this step' }))
    expect(onAdvance).toHaveBeenCalledTimes(1)
  })

  it('加一个目录 → Continue 解锁 + patchStatus 同步计数', () => {
    const patchStatus = vi.fn()
    renderStep({ patchStatus })
    fireEvent.click(screen.getByTestId('dir-add'))
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
    expect(patchStatus).toHaveBeenCalledWith({ roots: { count: 1 } })
  })

  it('re-run 已有 2 个目录 → Continue 立即可用', () => {
    renderStep({ rerun: true, status: { ...BASE, roots: { count: 2 } } })
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
  })

  it('DirBrowser 契约：startPath 固定为 /（容器部署根目录即媒体所在层）', () => {
    renderStep()
    expect(screen.getByTestId('dir-add')).toHaveAttribute('data-startpath', '/')
  })

  // 壳级集成：外壳无 key 原地重渲，patchStatus 后 status 已含本次新增——计数若再叠加
  // 本地 added 会三角漂移（2 次 add → count 3）。钉死：走真 BootstrapWizard，两次 add
  // 后推进到探针步，status.roots.count 必须如实为 2（Launch 汇总读它）。
  it('外壳集成：加两个目录后 roots.count 如实为 2（无原地重挂漂移）', () => {
    function ProbeStep(p: WizardStepProps) {
      return <span data-testid="probe-count">{p.status.roots.count}</span>
    }
    const steps: WizardStepDef[] = [
      { id: 'roots', titleKey: 'wizard_step_roots_title', descKey: 'wizard_step_roots_desc', optional: true, Component: StepRoots },
      { id: 'probe', titleKey: 'wizard_step_tmdb_title', descKey: 'wizard_step_tmdb_desc', optional: false, Component: ProbeStep },
    ]
    render(
      <I18nProvider initialLang="en">
        <BootstrapWizard initialStatus={BASE} rerun={false} onComplete={() => {}} steps={steps} />
      </I18nProvider>,
    )
    fireEvent.click(screen.getByTestId('dir-add'))
    fireEvent.click(screen.getByTestId('dir-add'))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByTestId('probe-count')).toHaveTextContent('2')
  })
})
```

Run: `cd web && npx vitest run src/setup/steps/StepRoots.test.tsx`
Expected: FAIL（`./StepRoots.js` 不存在）

- [ ] **Step 2: StepRoots 实现**

Create `web/src/setup/steps/StepRoots.tsx`：

```tsx
// web/src/setup/steps/StepRoots.tsx：wizard 步 6——守备目录（可跳过整步，spec A §3 步 6）。
// DirBrowser 是既有共享件（settings/DirBrowser.tsx，RootsManager 同款消费），本步只消费不改。
// addedCount 本地记、每次 onAdded 同步 patchStatus——步 7 Launch 的汇总清单读 roots.count。
import { useRef, useState } from 'react'
import { useT } from '../../i18n/useT.js'
import { Button } from '../../components/ui/button.js'
import { DirBrowser } from '../../settings/DirBrowser.js'
import { StepFooter } from './ui.js'
import type { WizardStepProps } from './types.js'

export function StepRoots({ status, patchStatus, onAdvance, onBack }: WizardStepProps) {
  const { t } = useT()
  const base = useRef(status.roots.count).current // 挂载时真值；换步即重挂
  const addsRef = useRef(0)
  const [added, setAdded] = useState(0)
  const total = base + added

  const onAdded = () => {
    addsRef.current += 1
    setAdded(addsRef.current)
    patchStatus({ roots: { count: base + addsRef.current } })
  }

  return (
    <div className="flex flex-col gap-5">
      <DirBrowser startPath="/" onAdded={onAdded} />
      <p className="text-sm text-weak">{t('wizard_roots_skip_note')}</p>
      <StepFooter onBack={onBack}>
        <Button variant="ghost" onClick={onAdvance}>{t('wizard_skip_step')}</Button>
        <Button disabled={total === 0} onClick={onAdvance}>{t('wizard_continue')}</Button>
      </StepFooter>
    </div>
  )
}
```

注意 `startPath="/"`：RootsManager 用 commonRootStart 从既有目录推起始点；wizard 首跑零目录，容器部署根目录即媒体所在层，`/` 是对的起点（Windows 语义列 spec §11 实现期验证项，DirBrowser 内部已处理平台差异）。

- [ ] **Step 3: registry 登记（全文替换）**

```ts
// web/src/setup/steps/registry.ts：七步登记处。顺序即 spec A §5.2 的步序，不许乱；
// Tasks 17-22 每落地一步在此追加一行，Task 23 才接进 App——任何中间态可构建、不可达生产。
import type { WizardStepDef } from './types.js'
import { StepLanguage } from './StepLanguage.js'
import { StepTmdb } from './StepTmdb.js'
import { StepLlm } from './StepLlm.js'
import { StepProviders } from './StepProviders.js'
import { StepFreeSources } from './StepFreeSources.js'
import { StepRoots } from './StepRoots.js'

export const WIZARD_STEPS: WizardStepDef[] = [
  { id: 'language', titleKey: 'wizard_step_language_title', descKey: 'wizard_step_language_desc', optional: false, Component: StepLanguage },
  { id: 'tmdb', titleKey: 'wizard_step_tmdb_title', descKey: 'wizard_step_tmdb_desc', optional: false, Component: StepTmdb },
  { id: 'llm', titleKey: 'wizard_step_llm_title', descKey: 'wizard_step_llm_desc', optional: false, Component: StepLlm },
  { id: 'providers', titleKey: 'wizard_step_providers_title', descKey: 'wizard_step_providers_desc', optional: true, Component: StepProviders },
  { id: 'free', titleKey: 'wizard_step_free_title', descKey: 'wizard_step_free_desc', optional: false, Component: StepFreeSources },
  { id: 'roots', titleKey: 'wizard_step_roots_title', descKey: 'wizard_step_roots_desc', optional: true, Component: StepRoots },
  // Task 22: launch
]
```

Run: `cd web && npx vitest run src/setup`
Expected: 全 PASS

- [ ] **Step 4: Commit**

```bash
git add web/src/setup
git commit -m "feat(web): wizard 步 6 守备目录（复用 DirBrowser，spec A §5.2）"
```

### Task 22: Step 7 Launch（汇总 + 点火）

**Files:**
- Create: `web/src/setup/steps/StepLaunch.tsx`
- Test: `web/src/setup/steps/StepLaunch.test.tsx`
- Modify: `web/src/setup/steps/registry.ts`

收官步（spec A §5.2 步 7）：汇总清单照 status 现状逐行 Configured/Skipped（八行：TMDB/LLM/ASSRT/OS/Jimaku/subhd/zimuku/roots；语言行不画——status 不带语言字段，零编造）；Engine 开关默认取 `status.engineEnabled`（缺省 true，spec §4.6）；Launch **无论开关态都显式 PUT engine_enabled**（wizard 点火语义 = 用户拍板的那一刻写库）→ onComplete。PUT 失败行内报错、不前进。

- [ ] **Step 1: 先写失败测试**

Create `web/src/setup/steps/StepLaunch.test.tsx`：

```tsx
// web/src/setup/steps/StepLaunch.test.tsx：步 7——汇总照 status 直译（Configured/Skipped）；
// 开关默认取 status.engineEnabled；Launch 显式 PUT 后 onComplete；PUT 失败不前进。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../../i18n/useT.js'
import { api } from '../../api/client.js'
import type { SetupStatusDTO } from '../../api/types.js'
import { StepLaunch } from './StepLaunch.js'
import type { WizardStepProps } from './types.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const BASE: SetupStatusDTO = {
  bootstrapComplete: true,
  tmdb: { satisfied: true, source: 'db', masked: null },
  llm: { satisfied: true, source: 'db', model: 'm-1' },
  providers: {
    assrt: { satisfied: true, source: 'db', masked: null },
    opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
    jimaku: { satisfied: false, source: 'none', masked: null },
    subhd: { enabled: true, source: 'db' },
    zimuku: { enabled: true, source: 'db', captchaReady: true },
  },
  roots: { count: 1 },
  engineEnabled: true,
}

function props(over: Partial<WizardStepProps> = {}): WizardStepProps {
  return {
    status: BASE, patchStatus: () => {}, rerun: false,
    onAdvance: () => {}, onBack: () => {}, onComplete: () => {}, ...over,
  }
}

function renderStep(over: Partial<WizardStepProps> = {}) {
  return render(<I18nProvider initialLang="en"><StepLaunch {...props(over)} /></I18nProvider>)
}

describe('StepLaunch', () => {
  it('汇总照 status 直译：满足的行 Configured、缺/关的行 Skipped', () => {
    renderStep()
    const rows = screen.getAllByText(/^(Configured|Skipped)$/)
    // 八行：tmdb✓ llm✓ assrt✓ os✗ jimaku✗ subhd✓ zimuku✓ roots✓ → 6 绿 2 跳
    expect(rows).toHaveLength(8)
    expect(screen.getAllByText('Configured')).toHaveLength(6)
    expect(screen.getAllByText('Skipped')).toHaveLength(2)
  })

  it('Launch → PUT engine_enabled true（默认 ON）→ onComplete', async () => {
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    const onComplete = vi.fn()
    renderStep({ onComplete })
    expect(screen.getByRole('switch', { name: 'Engine' })).toHaveAttribute('data-state', 'checked')
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith({ engine_enabled: 'true' })
  })

  it('关掉开关 → Launch PUT engine_enabled false', async () => {
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    const onComplete = vi.fn()
    renderStep({ onComplete })
    fireEvent.click(screen.getByRole('switch', { name: 'Engine' }))
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith({ engine_enabled: 'false' })
  })

  it('PUT 失败 → 行内错误，onComplete 不调用', async () => {
    vi.spyOn(api, 'updateSettings').mockRejectedValue(new Error('boom'))
    const onComplete = vi.fn()
    renderStep({ onComplete })
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }))
    expect(await screen.findByText(/boom/)).toBeInTheDocument()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('re-run：engineEnabled false 进场 → 开关初始 OFF，Launch 原样 PUT false', async () => {
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    const onComplete = vi.fn()
    renderStep({ onComplete, status: { ...BASE, engineEnabled: false } })
    expect(screen.getByRole('switch', { name: 'Engine' })).toHaveAttribute('data-state', 'unchecked')
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith({ engine_enabled: 'false' })
  })

  it('连点 Launch → 只 PUT 一次', async () => {
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    const onComplete = vi.fn()
    renderStep({ onComplete })
    const btn = screen.getByRole('button', { name: 'Launch' })
    fireEvent.click(btn)
    fireEvent.click(btn)
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledTimes(1)
  })
})
```

Run: `cd web && npx vitest run src/setup/steps/StepLaunch.test.tsx`
Expected: FAIL（`./StepLaunch.js` 不存在）

- [ ] **Step 2: StepLaunch 实现**

Create `web/src/setup/steps/StepLaunch.tsx`：

```tsx
// web/src/setup/steps/StepLaunch.tsx：wizard 步 7——汇总 + 点火（spec A §5.2 步 7）。
// 清单八行照 status 直译（语言行不画：status 不带语言字段，零编造）；Engine 开关默认取
// status.engineEnabled；Launch 无论开关态都显式 PUT——点火语义是"用户拍板那一刻写库"。
import { useState } from 'react'
import { api } from '../../api/client.js'
import { useT } from '../../i18n/useT.js'
import { Button } from '../../components/ui/button.js'
import { Switch } from '../../components/ui/switch.js'
import { StepFooter } from './ui.js'
import type { TKey } from '../../i18n/useT.js'
import type { WizardStepProps } from './types.js'

export function StepLaunch({ status, onBack, onComplete }: WizardStepProps) {
  const { t } = useT()
  const [engineOn, setEngineOn] = useState(status.engineEnabled)
  const [launching, setLaunching] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const rows: { labelKey: TKey; ok: boolean }[] = [
    { labelKey: 'wizard_step_tmdb_title', ok: status.tmdb.satisfied },
    { labelKey: 'wizard_step_llm_title', ok: status.llm.satisfied },
    { labelKey: 'wizard_assrt_label', ok: status.providers.assrt.satisfied },
    { labelKey: 'wizard_os_apikey_label', ok: status.providers.opensubtitles.satisfied },
    { labelKey: 'wizard_jimaku_label', ok: status.providers.jimaku.satisfied },
    { labelKey: 'wizard_subhd_label', ok: status.providers.subhd.enabled },
    { labelKey: 'wizard_zimuku_label', ok: status.providers.zimuku.enabled },
    { labelKey: 'wizard_step_roots_title', ok: status.roots.count > 0 },
  ]

  const launch = async () => {
    setLaunching(true)
    setSaveError(null)
    try {
      await api.updateSettings({ engine_enabled: String(engineOn) })
      onComplete()
    } catch (e) {
      setSaveError(String(e))
      setLaunching(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        {rows.map((r) => (
          <div key={r.labelKey} className="flex items-center justify-between text-sm">
            <span>{t(r.labelKey)}</span>
            <span className={r.ok ? 'text-fn-green' : 'text-weak'}>
              {r.ok ? t('wizard_launch_configured') : t('wizard_launch_skipped')}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Switch aria-label={t('wizard_launch_engine_label')} checked={engineOn} onCheckedChange={setEngineOn} />
        <span className="text-sm">{t('wizard_launch_engine_label')}</span>
        <span className="text-sm text-weak">{t('wizard_launch_engine_desc')}</span>
      </div>
      {saveError && <p className="text-sm text-fn-red">{saveError}</p>}
      <StepFooter onBack={onBack}>
        <Button disabled={launching} onClick={() => void launch()}>{t('wizard_launch')}</Button>
      </StepFooter>
    </div>
  )
}
```

- [ ] **Step 3: registry 最终形态（全文替换）**

```ts
// web/src/setup/steps/registry.ts：七步登记处，全员到齐。顺序即 spec A §5.2 的步序，不许乱。
import type { WizardStepDef } from './types.js'
import { StepLanguage } from './StepLanguage.js'
import { StepTmdb } from './StepTmdb.js'
import { StepLlm } from './StepLlm.js'
import { StepProviders } from './StepProviders.js'
import { StepFreeSources } from './StepFreeSources.js'
import { StepRoots } from './StepRoots.js'
import { StepLaunch } from './StepLaunch.js'

export const WIZARD_STEPS: WizardStepDef[] = [
  { id: 'language', titleKey: 'wizard_step_language_title', descKey: 'wizard_step_language_desc', optional: false, Component: StepLanguage },
  { id: 'tmdb', titleKey: 'wizard_step_tmdb_title', descKey: 'wizard_step_tmdb_desc', optional: false, Component: StepTmdb },
  { id: 'llm', titleKey: 'wizard_step_llm_title', descKey: 'wizard_step_llm_desc', optional: false, Component: StepLlm },
  { id: 'providers', titleKey: 'wizard_step_providers_title', descKey: 'wizard_step_providers_desc', optional: true, Component: StepProviders },
  { id: 'free', titleKey: 'wizard_step_free_title', descKey: 'wizard_step_free_desc', optional: false, Component: StepFreeSources },
  { id: 'roots', titleKey: 'wizard_step_roots_title', descKey: 'wizard_step_roots_desc', optional: true, Component: StepRoots },
  { id: 'launch', titleKey: 'wizard_step_launch_title', descKey: 'wizard_step_launch_desc', optional: false, Component: StepLaunch },
]
```

Run: `cd web && npx vitest run src/setup && npx tsc --noEmit`
Expected: 全 PASS + 零编译错误（七步齐，registry 无残留注释占位）

- [ ] **Step 4: Commit**

```bash
git add web/src/setup
git commit -m "feat(web): wizard 步 7 Launch 汇总点火——七步全员到齐（spec A §5.2）"
```

### Task 23: BootstrapGate + App.tsx 接线（wizard 上生产路径）

**Files:**
- Create: `web/src/setup/rerun.ts`（rerun 标记的 key 常量——BootstrapGate 与 Task 25 的 SystemSection 共用一份字面量）
- Create: `web/src/setup/BootstrapGate.tsx`
- Test: `web/src/setup/BootstrapGate.test.tsx`
- Modify: `web/src/App.tsx`

spec A §5.1 触发语义：auth 通过 → GET setup/status → `bootstrapComplete=false` → 全屏 wizard 替代 Shell；**推导式无标志位**（env/库已有 LLM+TMDB 的老部署永不进 wizard）；Settings System 区的 "Re-run setup wizard"（Task 25）以 sessionStorage 标记走 re-run 模式。两条铁律：① **status 拉取失败/加载中 → 直接渲染 Shell**（fail-open——观测台是主界面，wizard 不能因为它自己的触发探测失败而把主界面锁死）；② wizard 完成 = `window.location.reload()` 硬刷新（SessionStorage 标记一次性消费）。

- [ ] **Step 1: 先写失败测试**

Create `web/src/setup/BootstrapGate.test.tsx`：

```tsx
// web/src/setup/BootstrapGate.test.tsx：gate 五态——loading 先露 children（不闪 wizard）；
// bootstrapComplete=false → wizard 接管；true / 拉取失败 → children（fail-open）；
// sessionStorage rerun 标记 → 强制 wizard 且一次性消费；onComplete 契约——必须作为函数
// 传进 wizard（硬刷新本体 jsdom 探不了，钉"传了函数"这层）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { api } from '../api/client.js'
import type { SetupStatusDTO } from '../api/types.js'
import { BootstrapGate } from './BootstrapGate.js'
import { BootstrapWizard } from './BootstrapWizard.js'

// wizard 本体打桩——gate 只验证触发与 props 传递，七步行为有 Task 16-22 各自的测试在看。
vi.mock('./BootstrapWizard.js', () => ({
  BootstrapWizard: vi.fn(({ rerun }: { rerun: boolean }) => (
    <div data-testid="wizard" data-rerun={String(rerun)} />
  )),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  sessionStorage.clear()
})

function status(over: Partial<SetupStatusDTO> = {}): SetupStatusDTO {
  return {
    bootstrapComplete: true,
    tmdb: { satisfied: true, source: 'env', masked: null },
    llm: { satisfied: true, source: 'env', model: null },
    providers: {
      assrt: { satisfied: false, source: 'none', masked: null },
      opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
      jimaku: { satisfied: false, source: 'none', masked: null },
      subhd: { enabled: false, source: 'none' },
      zimuku: { enabled: false, source: 'none', captchaReady: false },
    },
    roots: { count: 1 },
    engineEnabled: true,
    ...over,
  }
}

function renderGate() {
  return render(
    <BootstrapGate>
      <div data-testid="shell" />
    </BootstrapGate>,
  )
}

describe('BootstrapGate', () => {
  it('status 加载中 → 先露 children，不闪 wizard', async () => {
    vi.spyOn(api, 'setupStatus').mockReturnValue(new Promise(() => {}))
    renderGate()
    await waitFor(() => expect(api.setupStatus).toHaveBeenCalled())
    expect(screen.getByTestId('shell')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard')).not.toBeInTheDocument()
  })

  it('bootstrapComplete=true → 渲染 children，无 wizard', async () => {
    vi.spyOn(api, 'setupStatus').mockResolvedValue(status())
    renderGate()
    await waitFor(() => expect(api.setupStatus).toHaveBeenCalled())
    expect(screen.getByTestId('shell')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard')).not.toBeInTheDocument()
  })

  it('bootstrapComplete=false → wizard 接管，children 不渲染', async () => {
    vi.spyOn(api, 'setupStatus').mockResolvedValue(status({ bootstrapComplete: false }))
    renderGate()
    expect(await screen.findByTestId('wizard')).toBeInTheDocument()
    expect(screen.queryByTestId('shell')).not.toBeInTheDocument()
  })

  it('status 拉取失败 → 渲染 children（fail-open：探测失败不许锁死主界面）', async () => {
    vi.spyOn(api, 'setupStatus').mockRejectedValue(new Error('network'))
    renderGate()
    await waitFor(() => expect(api.setupStatus).toHaveBeenCalled())
    expect(screen.getByTestId('shell')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard')).not.toBeInTheDocument()
  })

  it('sessionStorage rerun 标记 → 即使 bootstrapComplete=true 也进 wizard（rerun=true），标记一次性消费', async () => {
    // 这里故意写死字面量而不 import RERUN_WIZARD_KEY：测试要钉住的就是"key 是这个字符串"
    // ——用常量对拍会变成自证（改了常量测试跟着改，跨会话的死链照样溜过去）。
    sessionStorage.setItem('scout-rerun-wizard', '1')
    vi.spyOn(api, 'setupStatus').mockResolvedValue(status())
    renderGate()
    const wizard = await screen.findByTestId('wizard')
    expect(wizard.dataset.rerun).toBe('true')
    expect(sessionStorage.getItem('scout-rerun-wizard')).toBeNull()
    // onComplete 契约钉住：jsdom spy 不了 location.reload 本体，钉"gate 把函数传进了 wizard"
    // 这层——硬刷新是 impl 侧一行的事实，传没传、传的是不是函数由这里守。
    const wizMock = vi.mocked(BootstrapWizard)
    expect(wizMock.mock.calls[0][0].onComplete).toBeTypeOf('function')
  })
})
```

Run: `cd web && npx vitest run src/setup/BootstrapGate.test.tsx`
Expected: FAIL（`./BootstrapGate.js` 不存在）

注（2026-08-03 复审加固，test-side only）：App.test.tsx 追加 `App bootstrap 闸（spec A §5.1）` 集成测试——auth 已过 + setup/status 回 `bootstrapComplete:false` → 真 wizard 步 1（'Subtitle language' heading）接管、Shell 侧栏不在场。此前 App 层只练过 fail-open 缝（setup/status 404 → Shell 照出），接管路径只有 gate 单测（wizard 打桩）在看；此钉闭环 AuthGate→Gate→wizard 接缝。

- [ ] **Step 2: BootstrapGate 实现**

先 Create `web/src/setup/rerun.ts`（**只有常量**，触发器 `requestWizardRerun` 在 Task 25 消费方到场时再追加到这个文件——此刻没有调用者，先写就是 YAGNI）：

```ts
// web/src/setup/rerun.ts：Re-run wizard 的共享常量。BootstrapGate 读它、Settings System 区
// （Task 25）写它——字面量不许双写：一处漂移，"重进向导"就成死链，而且是静默的死链。
export const RERUN_WIZARD_KEY = 'scout-rerun-wizard'
```

再 Create `web/src/setup/BootstrapGate.tsx`：

```tsx
// web/src/setup/BootstrapGate.tsx：bootstrap 触发闸（spec A §5.1）。推导式无标志位——
// bootstrapComplete=false 才接管；status 拉取失败/加载中直接渲染 children（fail-open：
// wizard 不能因自己的触发探测失败把主界面锁死，观测台永远可达）。Re-run：Settings
// System 区写 sessionStorage 标记 + reload，这里首探前读标记强制 wizard 并一次性消费。
import { useEffect, useState } from 'react'
import { api } from '../api/client.js'
import type { SetupStatusDTO } from '../api/types.js'
import { BootstrapWizard } from './BootstrapWizard.js'
import { RERUN_WIZARD_KEY } from './rerun.js'

export function BootstrapGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SetupStatusDTO | null>(null)
  const [failed, setFailed] = useState(false)
  // 同步读 + 同步删：重挂载（React StrictMode 双跑）不会把 re-run 模式吞掉第二次——
  // 首次渲染时已删，第二次读到 null 是正常首跑。
  const [rerun] = useState(() => {
    const hit = sessionStorage.getItem(RERUN_WIZARD_KEY) === '1'
    if (hit) sessionStorage.removeItem(RERUN_WIZARD_KEY)
    return hit
  })

  useEffect(() => {
    let alive = true
    api
      .setupStatus()
      .then((dto) => alive && setStatus(dto))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [])

  if (failed) return <>{children}</>
  if (status === null) return <>{children}</> // 首探未回不闪 wizard（同 AuthGate 空拍纪律）
  if (status.bootstrapComplete && !rerun) return <>{children}</>
  return (
    <BootstrapWizard
      initialStatus={status}
      rerun={rerun}
      onComplete={() => {
        window.location.reload()
      }}
    />
  )
}
```

注意 gate 用**一次性 fetch** 而非 useSetupStatus 轮询——触发是首探语义，不追 15s 心跳（EngineBanner/Settings 的轮询各自有主）；wizard 打开期间步骤内 `patchStatus` 本地推进，Step 7 Launch 后硬刷新，gate 随刷新重新首探。

- [ ] **Step 3: App.tsx 接线（全文替换）**

```tsx
// web/src/App.tsx：dashboard-F2 新外壳入口 + 鉴权 A2 Task 11 门 + spec A §5.1 bootstrap 闸。
// I18nProvider 包 AuthGate——AuthGate 据 /auth/status 三态分流：未初始化→SetupWizard、
// 已初始化未登录→LoginPage、已登录→BootstrapGate 包 Shell（bootstrap 未完成 → 全屏 wizard
// 接管；推导式无标志位，老部署 env/库有 LLM+TMDB 永不进）。Theme 包在 main.tsx。
//
// 结构性白赚（调研 *arr 两 bug）：#6144 stale-cookie 死循环——AuthGate 每次读 auth/status，
// cookie 失效即 authenticated:false→LoginPage，无循环；#6454 deep-link 丢失——AuthGate 包裹
// Shell、从不改 location.hash，登录后 reload() 直接在原 hash 渲染 Shell，深链天然保留。
import { I18nProvider } from './i18n/useT.js'
import { Shell } from './shell/AppShell.js'
import { SetupWizard } from './auth/SetupWizard.js'
import { LoginPage } from './auth/LoginPage.js'
import { ConnectionError } from './auth/ConnectionError.js'
import { useAuthStatus } from './auth/useAuthStatus.js'
import { BootstrapGate } from './setup/BootstrapGate.js'

function AuthGate() {
  const { status, error, reload } = useAuthStatus()
  // 探测失败：如实显示连接错误 + 重试，不误导为 LoginPage、不永久白屏（correctness 审计 #2/#6）。
  if (error) return <ConnectionError onRetry={reload} />
  if (status === null) return null // 首探未回：加载空拍（<100ms），不闪任何内容
  if (!status.initialized) return <SetupWizard onDone={reload} />
  if (!status.authenticated) return <LoginPage onDone={reload} />
  return (
    <BootstrapGate>
      <Shell />
    </BootstrapGate>
  )
}

export function App() {
  return (
    <I18nProvider>
      <AuthGate />
    </I18nProvider>
  )
}
```

Run: `cd web && npx vitest run src/setup && npx tsc --noEmit`
Expected: 全 PASS + 零编译错误

- [ ] **Step 4: Commit**

```bash
git add web/src
git commit -m "feat(web): BootstrapGate 接线——bootstrap 未完成 wizard 全屏接管（spec A §5.1）"
```

### Task 24: Engine 两处控制面——Behavior EngineRow + 全局 EngineBanner（+ useSetupProviders hook）

**Files:**
- Modify: `web/src/settings/BehaviorSection.tsx`（EngineRow 组件 + 行首插入）
- Test: `web/src/settings/EngineRow.test.tsx`（新文件，经 BehaviorSection 整区渲染测）
- Create: `web/src/shell/EngineBanner.tsx`
- Test: `web/src/shell/EngineBanner.test.tsx`
- Modify: `web/src/shell/AppShell.tsx`（挂 banner）
- Modify: `web/src/api/hooks.ts`（+= useSetupProviders，Task 25 的 ProvidersSection 用）

spec A §5.5/§5.6：发动机开关两处绑定同一键（Settings Behavior + Spec C 的 hero——本任务落 Settings 这处；hero 那处是 C 的地盘）；引擎关闭时所有主屏顶部常驻细 banner + "Turn on" 快捷钮。banner 数据源 = `useSetupStatus().engineEnabled`（≤15s 翻转，与 wizard 步 7 写库同源）；**status 拉取失败/加载中 → 不渲染**（fail-open：宁可少一条 banner，不可误报"引擎已关"——与 §4.6 脏值哲学一致）。

- [ ] **Step 1: hooks.ts += useSetupProviders**

`web/src/api/hooks.ts` 在 useSetupStatus 之后追加（镜像样板，同 `LIBRARY_POLL_MS`）：

```ts
/**
 * useSetupProviders：Settings Providers 区的行数据（打码/source/上次测试点）。15s 轮询与
 * useSetupStatus 同节拍；编辑/测试动作后组件直接调 reload 立即刷新，不等下一拍。
 */
export function useSetupProviders(): Async<ProvidersDTO> {
  const [data, setData] = useState<ProvidersDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const dto = await api.setupProviders()
      setData(dto)
      setError(null)
    } catch (e) {
      // String(e) 而非 e instanceof Error ? e.message : String(e)——`web/src/api/hooks.ts` 里
      // 12 个既有 hook 一律 String(e)，同文件同层的 useSetupStatus（Task 14 Step 5）也是。
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const reload = useCallback(() => {
    setLoading(true)
    void load()
  }, [load])

  useEffect(() => {
    const start = () => {
      void load()
      // 守卫写法照抄既有轮询 hook（`web/src/api/hooks.ts:49/228/283/339` 四处一模一样）：
      // visibilitychange 连发或 effect 复跑时，没这道判断会叠出第二个 setInterval，
      // 旧句柄被覆盖后再也 clear 不掉——越切标签页轮询越快。
      if (timer.current == null) timer.current = setInterval(() => void load(), LIBRARY_POLL_MS)
    }
    const stop = () => {
      if (timer.current != null) {
        clearInterval(timer.current)
        timer.current = null
      }
    }
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop())
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  return { data, loading, error, reload }
}
```

（import 行把 `ProvidersDTO` 加进既有 `import type { ... } from './types.js'`。）

- [ ] **Step 2: 先写 EngineRow 失败测试（经 BehaviorSection 整区渲染）**

Create `web/src/settings/EngineRow.test.tsx`：

```tsx
// web/src/settings/EngineRow.test.tsx：Behavior 区 Engine 行——开关态直读 settings.engineEnabled
// （后端别名布尔，不经字符串解析）；翻转 = 单键 PUT engine_enabled（useFieldCommit 同管）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { api } from '../api/client.js'
import type { SettingsDTO } from '../api/types.js'
import { BehaviorSection } from './BehaviorSection.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SETTINGS: SettingsDTO = {
  target_languages: 'zh',
  ai_translate_enabled: null,
  hardsub_mode: null,
  exclude_extras: null,
  scan_interval_ms: null,
  trace_retention_days: null,
  engine_enabled: null,
  'provider:SUBHD_ENABLED': null,
  'provider:ZIMUKU_ENABLED': null,
  engineEnabled: false,
}

function renderSection(data: SettingsDTO = SETTINGS) {
  return render(
    <I18nProvider initialLang="en">
      <BehaviorSection settings={{ data, loading: false, error: null, reload: () => {} }} />
    </I18nProvider>,
  )
}

describe('EngineRow', () => {
  it('engineEnabled=false → Engine 行渲染且开关为关', () => {
    renderSection()
    expect(screen.getByText('Engine')).toBeInTheDocument()
    // 这一行的描述文案是 settings_engine_desc（Behavior 区的行说明）。
    // 注意别拿 engine_banner_off（"Engine off — polling and dispatch are paused."）来断言：
    // 那句是 Task 24 后半段那个**全局 banner** 的文案，BehaviorSection 里根本不渲染它。
    expect(
      screen.getByText('Master switch for scanning, fetching and all automatic work.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Engine' })).not.toBeChecked()
  })

  it('翻转开关 → PUT { engine_enabled: "true" }，响应回写本地', async () => {
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({ ...SETTINGS, engineEnabled: true })
    renderSection()
    // Astryx Switch 把 label 作为可及名暴露在 role="switch" 上——既有
    // `BehaviorSection.test.tsx:58` 就是这么取的（`getByRole('switch', { name: 'Exclude extras' })`）。
    // 这里**必须**带 name 限定：BehaviorSection 整区渲染时有多个 switch（Engine / Exclude extras），
    // 裸 `getByRole('switch')` 会因多重匹配直接抛错。
    fireEvent.click(screen.getByRole('switch', { name: 'Engine' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith({ engine_enabled: 'true' }))
    // 响应回写本地：mock 响应带 engineEnabled: true，useFieldCommit 用响应体更新 settings，
    // 开关必须跟着翻成开——用例名承诺的"响应回写本地"此前没有断言兜底。
    // （Task 25 评审遗留修复包 f4d284d 补的就是这一条。）
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Engine' })).toBeChecked())
  })
})
```

Run: `cd web && npx vitest run src/settings/EngineRow.test.tsx`
Expected: FAIL（Engine 行不存在）

- [ ] **Step 3: BehaviorSection 加 EngineRow（两处编辑）**

编辑一——`BehaviorSection.tsx` 在 `ExcludeExtrasRow` 之后追加组件：

```tsx
function EngineRow({ settings, onUpdated }: RowProps) {
  const { t } = useT()
  const { saving, error, commit } = useFieldCommit(onUpdated)
  // settings.engineEnabled 是后端序列化的布尔别名（apiV2 settings GET 的 engineEnabled），
  // 不经字符串解析；PUT 走 SettingsPatch 的 engine_enabled 键，响应回写同一别名。
  return (
    <VStack gap={2}>
      <Switch
        label={t('settings_engine_label')}
        value={settings.engineEnabled}
        onChange={(checked) => void commit('engine_enabled', checked ? 'true' : 'false')}
        isLoading={saving}
        status={error ? { type: 'error', message: error } : undefined}
      />
      <Text type="supporting" color="secondary">
        {t('settings_engine_desc')}
      </Text>
    </VStack>
  )
}
```

编辑二——主组件的 VStack 里把 EngineRow 放在**第一行**（总开关压顶，spec §5.4 Behavior 区首项）：

```tsx
      <VStack gap={5}>
        <EngineRow settings={local} onUpdated={setLocal} />
        <TargetLanguagesRow settings={local} onUpdated={setLocal} />
        <HardsubModeRow settings={local} onUpdated={setLocal} />
        <ExcludeExtrasRow settings={local} onUpdated={setLocal} />
```

- [ ] **Step 4: 先写 EngineBanner 失败测试**

Create `web/src/shell/EngineBanner.test.tsx`：

```tsx
// web/src/shell/EngineBanner.test.tsx：引擎关闭 banner——仅 engineEnabled=false 渲染；
// Turn on 快捷 PUT 同键 + reload 刷新；status 加载中/拉取失败 → 不渲染（fail-open，
// 不可误报"引擎已关"）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { api } from '../api/client.js'
import type { SetupStatusDTO } from '../api/types.js'
import { EngineBanner } from './EngineBanner.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function status(engineEnabled: boolean): SetupStatusDTO {
  return {
    bootstrapComplete: true,
    tmdb: { satisfied: true, source: 'env', masked: null },
    llm: { satisfied: true, source: 'env', model: null },
    providers: {
      assrt: { satisfied: false, source: 'none', masked: null },
      opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
      jimaku: { satisfied: false, source: 'none', masked: null },
      subhd: { enabled: false, source: 'none' },
      zimuku: { enabled: false, source: 'none', captchaReady: false },
    },
    roots: { count: 1 },
    engineEnabled,
  }
}

function renderBanner() {
  return render(<I18nProvider initialLang="en"><EngineBanner /></I18nProvider>)
}

describe('EngineBanner', () => {
  it('engineEnabled=false → 渲染细条 + Turn on', async () => {
    vi.spyOn(api, 'setupStatus').mockResolvedValue(status(false))
    renderBanner()
    expect(await screen.findByText('Engine off — polling and dispatch are paused.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeInTheDocument()
  })

  it('Turn on → PUT { engine_enabled: "true" } → reload 后 banner 消失', async () => {
    // 两段桩：第一次拉取给"引擎关"（banner 出现），Turn on 之后的 reload 给"引擎开"（banner 撤）。
    // 若整场都桩 status(false)，reload 拿回来的还是"关"，banner 永远不会消失——最后那个
    // waitFor 会一直等到超时，测试红得莫名。
    vi.spyOn(api, 'setupStatus')
      .mockResolvedValueOnce(status(false))
      .mockResolvedValue(status(true))
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    renderBanner()
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith({ engine_enabled: 'true' }))
    await waitFor(() =>
      expect(screen.queryByText('Engine off — polling and dispatch are paused.')).not.toBeInTheDocument(),
    )
  })

  it('engineEnabled=true → 不渲染', async () => {
    vi.spyOn(api, 'setupStatus').mockResolvedValue(status(true))
    renderBanner()
    await waitFor(() => expect(api.setupStatus).toHaveBeenCalled())
    expect(screen.queryByText(/Engine off/)).not.toBeInTheDocument()
  })

  it('status 拉取失败 → 不渲染（fail-open）', async () => {
    vi.spyOn(api, 'setupStatus').mockRejectedValue(new Error('network'))
    renderBanner()
    await waitFor(() => expect(api.setupStatus).toHaveBeenCalled())
    expect(screen.queryByText(/Engine off/)).not.toBeInTheDocument()
  })

  // 第 5 条用例——Task 24 评审抓获：turnOn 此前无 catch，PUT 失败静默（banner 在、
  // 按钮复活、用户什么都看不到）。Task 25 修复包（f4d284d）随本计划落地。
  it('Turn on PUT 失败 → 行内错误文案 + banner 不消 + 按钮复活（不静默）', async () => {
    // setupStatus 恒给"关"：PUT 失败没有 reload 的理由，banner 必须留在原地。
    vi.spyOn(api, 'setupStatus').mockResolvedValue(status(false))
    vi.spyOn(api, 'updateSettings').mockRejectedValue(new Error('boom'))
    renderBanner()
    const btn = await screen.findByRole('button', { name: 'Turn on' })
    fireEvent.click(btn)
    expect(await screen.findByText(/boom/)).toBeInTheDocument()
    expect(screen.getByText('Engine off — polling and dispatch are paused.')).toBeInTheDocument()
    await waitFor(() => expect(btn).toBeEnabled())
  })
})
```

Run: `cd web && npx vitest run src/shell/EngineBanner.test.tsx`
Expected: FAIL（`./EngineBanner.js` 不存在）

- [ ] **Step 5: EngineBanner 实现 + AppShell 挂载**

Create `web/src/shell/EngineBanner.tsx`：

```tsx
// web/src/shell/EngineBanner.tsx：引擎关闭常驻细条（spec A §5.6）——仅 engineEnabled=false
// 渲染；Turn on 快捷 PUT 同键后 reload 立即消条（不等 15s 轮询）。加载中/拉取失败 → 不渲染：
// fail-open，宁可少一条 banner 不可误报"引擎已关"（§4.6 脏值哲学）。不画任何新状态页面。
// 用 shadcn Button——新 chrome 件直接落新栈（Task 13 底座已进场），Astryx 壳随 Spec C 迁移。
import { useState } from 'react'
import { api } from '../api/client.js'
import { useSetupStatus } from '../api/hooks.js'
import { useT } from '../i18n/useT.js'
import { Button } from '../components/ui/button.js'

export function EngineBanner() {
  const { t } = useT()
  const { data, reload } = useSetupStatus()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!data || data.engineEnabled) return null

  const turnOn = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.updateSettings({ engine_enabled: 'true' })
      reload()
    } catch (e) {
      // PUT 失败不能静默——banner 留着、按钮复活、行内红字告知（同 wizard 步件的
      // saveError 先例）。reload 只在成功路径调，失败时状态未变，不需要重拉。
      // （Task 24 评审抓获的静默失败，Task 25 修复包 f4d284d 补的 catch+渲染。）
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2 border-b border-border bg-card px-4 py-2 text-sm">
      <span>{t('engine_banner_off')}</span>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void turnOn()}>
        {t('engine_banner_turn_on')}
      </Button>
      {error && <span className="text-fn-red">{error}</span>}
    </div>
  )
}
```

编辑 `web/src/shell/AppShell.tsx`——两处：

```tsx
import { CommandK } from './CommandK.js'
import { EngineBanner } from './EngineBanner.js'
```

```tsx
        sideNav={<Sidebar tab={route.tab} parked={workflow.data?.parked} />}>
        {/* 引擎关闭 banner 压所有主屏顶（spec A §5.6）；library 的 contentPadding=0 下
            它就是全宽出血细条，正好。 */}
        <EngineBanner />
        {route.tab === 'library' &&
```

Run: `cd web && npx vitest run src/shell src/settings && npx tsc --noEmit`
Expected: 全 PASS + 零编译错误

- [ ] **Step 6: Commit**

```bash
git add web/src
git commit -m "feat(web): Engine 两处控制面——Behavior EngineRow + 全局关闭 banner（spec A §5.4/§5.6）"
```

### Task 25: Settings Providers 区 + System 区 + Deploy 区瘦身

> **As-landed（2026-08-03，f73c3fd / 5086e5e / 0883503 / f4d284d）**：本任务所有 VERBATIM 块
> 逐字落地、零适配——`settings_save_error_prefix`/`settings_error_prefix` 两键在 en.ts/zh.ts
> 均已存在（Task 15 双写时备齐），未发生计划担心的键漂移。唯一越块动作：DeploySection.test.tsx
> 的头注随瘦身后新职责重写（旧头注仍在描述已删的 secrets 断言）；SettingsPage.tsx 头注按新区序
> 重写。Task 24 评审遗留修复包以第 4 个 commit（f4d284d）单独落地：EngineBanner catch+行内红字
> +第 5 条用例、EngineRow 回写断言——Task 24 的 impl/test 块已按落地形状回填（见上方两处
> "Task 25 修复包"注记）。
>
> **Follow-up（评审第二轮，第 5 commit 131f8a6，纯测试侧）**：ProvidersSection 补 4 条用例——
> ① 多密钥家选择存钉（llm 三键只填 LLM_API_KEY → `put.mock.calls` toEqual `[['LLM_API_KEY','sk-new']]`，
> Important）；② 保存失败径（行内错误 + 编辑态保留 + 草稿不丢）；③ 混合源编辑（env 行只读 /
> db 行变输入框）；④ lastTest 负向（ok 行无失败/错误文案；fail 无 error 字段 → 只有失败行，
> 用 VStack 直接子节点数做结构钉：ok assrt=2、fail+error llm=5、fail-no-error assrt=2）。
> 另随该 commit 在 onSave 的 catch 首行加评审注：循环中途抛错 = 前面的键已逐键落库（单键语义
> 不回滚），失败径不 reload，打码值旧到下一拍 15s 轮询自愈（comment-only，无行为变更）。

**Files:**
- Create: `web/src/settings/ProvidersSection.tsx`
- Test: `web/src/settings/ProvidersSection.test.tsx`
- Create: `web/src/settings/SystemSection.tsx`
- Test: `web/src/settings/SystemSection.test.tsx`
- Modify: `web/src/setup/rerun.ts`（追加 `requestWizardRerun`——`RERUN_WIZARD_KEY` 已在 Task 23 落地，**不要重建这个文件**）
- Modify: `web/src/settings/DeploySection.tsx`（删 secrets 块，只留 nonSecrets）
- Modify: `web/src/settings/DeploySection.test.tsx`（删 secrets 用例）
- Modify: `web/src/settings/SettingsPage.tsx`（挂 ProvidersSection/SystemSection）

spec A §5.4：Deploy 只读区 → Providers 区（打码值/source 徽标/上次测试点/编辑/Test；subhd·zimuku 无 key 两家 toggle 行）；System 区加 "Re-run setup wizard"；非密 env 展示保留为只读小块（DeploySection 瘦身）。**视觉栈用 Astryx**（与 Behavior/Deploy 邻区一致——本页整页随 Spec C 迁新栈，本任务不在一页内混两套）。

- [ ] **Step 1: rerun.ts 追加触发器 + SystemSection（测试先行）**

编辑 `web/src/setup/rerun.ts`——文件与 `RERUN_WIZARD_KEY` 都是 Task 23 建的，这里**只在文件尾追加**触发器（消费方到场了才写它，见 Task 23 Step 2 的说明）：

```ts
export function requestWizardRerun(): void {
  sessionStorage.setItem(RERUN_WIZARD_KEY, '1')
  window.location.reload()
}
```

BootstrapGate 这边**无需任何改动**：它从 Task 23 起就 import 的是常量，不是字面量。

Create `web/src/settings/SystemSection.test.tsx`：

```tsx
// web/src/settings/SystemSection.test.tsx：System 区 Re-run 入口——点击调 requestWizardRerun
// （sessionStorage 标记 + reload 的实现在 rerun.ts，这里验证接线不验证 reload 本身）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { requestWizardRerun } from '../setup/rerun.js'
import { SystemSection } from './SystemSection.js'

vi.mock('../setup/rerun.js', () => ({
  RERUN_WIZARD_KEY: 'scout-rerun-wizard',
  requestWizardRerun: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SystemSection', () => {
  it('点击 Re-run setup wizard → requestWizardRerun', () => {
    render(<I18nProvider initialLang="en"><SystemSection /></I18nProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Re-run setup wizard' }))
    expect(requestWizardRerun).toHaveBeenCalledTimes(1)
  })
})
```

Create `web/src/settings/SystemSection.tsx`：

```tsx
// web/src/settings/SystemSection.tsx：System 区（spec A §5.4）——Re-run setup wizard 入口。
// 重进机制 = rerun.ts 的 sessionStorage 标记 + reload：BootstrapGate 首探前读标记走 re-run 模式
// （硬门禁满足态直通、可手动 Re-test）。
import { Text } from '@astryxdesign/core/Text'
import { Button } from '@astryxdesign/core/Button'
import { VStack } from '@astryxdesign/core/VStack'
import { useT } from '../i18n/useT.js'
import { requestWizardRerun } from '../setup/rerun.js'

export function SystemSection() {
  const { t } = useT()
  return (
    <section className="settings-section">
      <Text type="label">{t('settings_system_rerun_wizard')}</Text>
      <VStack gap={2}>
        <Text type="supporting" color="secondary">{t('settings_system_rerun_wizard_desc')}</Text>
        <Button size="sm" variant="secondary" label={t('settings_system_rerun_wizard')} onClick={requestWizardRerun} />
      </VStack>
    </section>
  )
}
```

Run: `cd web && npx vitest run src/settings/SystemSection.test.tsx src/setup`
Expected: 全 PASS（gate 既有用例不受常量收敛影响）

Commit:

```bash
git add web/src
git commit -m "feat(web): System 区 Re-run wizard 入口 + rerun key 常量收敛（spec A §5.4）"
```

- [ ] **Step 2: 先写 ProvidersSection 失败测试**

Create `web/src/settings/ProvidersSection.test.tsx`：

```tsx
// web/src/settings/ProvidersSection.test.tsx：Providers 区（spec A §5.4）——打码/source 徽标/
// 上次测试点/env 锁定/编辑（仅 db 可改，空输入=不动该键，UI 不提供删除）/Test；
// subhd·zimuku 两家 toggle 行走 PUT settings 通道。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { api } from '../api/client.js'
import type { ProvidersDTO, SetupStatusDTO } from '../api/types.js'
import { ProvidersSection } from './ProvidersSection.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const PROVIDERS: ProvidersDTO = {
  providers: [
    { id: 'tmdb', secrets: [{ name: 'TMDB_API_KEY', set: true, source: 'env', masked: 'abc••••xyz' }], lastTest: null },
    { id: 'llm', secrets: [
      { name: 'LLM_BASE_URL', set: true, source: 'db', masked: 'htt••••/v1' },
      { name: 'LLM_API_KEY', set: false, source: 'none', masked: null },
      { name: 'LLM_MODEL', set: true, source: 'db', masked: '••••' },
    ], lastTest: { ok: false, at: 1700000000000, error: 'Invalid credentials' } },
    { id: 'assrt', secrets: [{ name: 'ASSRT_TOKEN', set: true, source: 'db', masked: 'ass••••123' }], lastTest: { ok: true, at: 1700000000000 } },
    { id: 'opensubtitles', secrets: [
      { name: 'OPENSUBTITLES_API_KEY', set: false, source: 'none', masked: null },
      { name: 'OPENSUBTITLES_USERNAME', set: false, source: 'none', masked: null },
      { name: 'OPENSUBTITLES_PASSWORD', set: false, source: 'none', masked: null },
    ], lastTest: null },
    { id: 'jimaku', secrets: [{ name: 'JIMAKU_API_KEY', set: false, source: 'none', masked: null }], lastTest: null },
    { id: 'subhd', secrets: [], lastTest: null },
    { id: 'zimuku', secrets: [], lastTest: null },
  ],
}

const SETUP: SetupStatusDTO = {
  bootstrapComplete: true,
  tmdb: { satisfied: true, source: 'env', masked: 'abc••••xyz' },
  llm: { satisfied: true, source: 'db', model: 'm-1' },
  providers: {
    assrt: { satisfied: true, source: 'db', masked: 'ass••••123' },
    opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
    jimaku: { satisfied: false, source: 'none', masked: null },
    subhd: { enabled: true, source: 'db' },
    zimuku: { enabled: false, source: 'env', captchaReady: true },
  },
  roots: { count: 1 },
  engineEnabled: true,
}

function renderSection(over: { providers?: Partial<Parameters<typeof ProvidersSection>[0]['providers']>; setupStatus?: Partial<Parameters<typeof ProvidersSection>[0]['setupStatus']> } = {}) {
  const providersReload = vi.fn()
  const setupReload = vi.fn()
  render(
    <I18nProvider initialLang="en">
      <ProvidersSection
        providers={{ data: PROVIDERS, loading: false, error: null, reload: providersReload, ...over.providers }}
        setupStatus={{ data: SETUP, loading: false, error: null, reload: setupReload, ...over.setupStatus }}
      />
    </I18nProvider>,
  )
  return { providersReload, setupReload }
}

describe('ProvidersSection', () => {
  it('env secret：打码 + environment 徽标 + 锁定注；全家 env 的 provider 无 Edit', () => {
    renderSection()
    const tmdb = within(screen.getByTestId('providers-tmdb'))
    expect(tmdb.getByText('abc••••xyz')).toBeInTheDocument()
    expect(tmdb.getByText('environment')).toBeInTheDocument()
    expect(tmdb.getByText('Set by environment — locked')).toBeInTheDocument()
    expect(tmdb.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    const jimaku = within(screen.getByTestId('providers-jimaku'))
    expect(jimaku.getByText('Not set')).toBeInTheDocument()
  })

  it('lastTest：ok → 绿点 + Last test passed；fail → Last test failed + 错误行', () => {
    renderSection()
    // **必须用正则、不能用全等字符串**：可见的那个 `<Text>` 内容是
    // `Last test passed · ${new Date(at).toLocaleString()}`（见下面 Step 3 的实现），
    // getByText 默认整串规范化后全等匹配，`'Last test passed'` 永远匹配不上；
    // 而 StatusDot 的 `label` 只落在 aria-label 上，压根不是文本节点。
    expect(within(screen.getByTestId('providers-assrt')).getByText(/Last test passed/)).toBeInTheDocument()
    const llm = within(screen.getByTestId('providers-llm'))
    expect(llm.getByText(/Last test failed/)).toBeInTheDocument()
    expect(llm.getByText('Invalid credentials')).toBeInTheDocument()
  })

  it('Edit（db 家）→ 输入 → Save → putSecret + providers reload', async () => {
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    const { providersReload } = renderSection()
    const assrt = within(screen.getByTestId('providers-assrt'))
    fireEvent.click(assrt.getByRole('button', { name: 'Edit' }))
    fireEvent.change(assrt.getByLabelText('ASSRT_TOKEN'), { target: { value: 'new-tok' } })
    fireEvent.click(assrt.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put).toHaveBeenCalledWith('ASSRT_TOKEN', 'new-tok'))
    await waitFor(() => expect(providersReload).toHaveBeenCalled())
  })

  it('Edit 后输入留空 → Save 不 PUT 该键（空输入=不动，UI 不提供删除）', async () => {
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    renderSection()
    const assrt = within(screen.getByTestId('providers-assrt'))
    fireEvent.click(assrt.getByRole('button', { name: 'Edit' }))
    fireEvent.click(assrt.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put).not.toHaveBeenCalled())
  })

  it('Test → validateSetup(该家) → reload（结果由 lastTest 行呈现）', async () => {
    const validate = vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const { providersReload } = renderSection()
    fireEvent.click(within(screen.getByTestId('providers-assrt')).getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(validate).toHaveBeenCalledWith('assrt'))
    await waitFor(() => expect(providersReload).toHaveBeenCalled())
  })

  it('subhd toggle → PUT provider:SUBHD_ENABLED + setupStatus reload', async () => {
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    const { setupReload } = renderSection()
    const subhd = within(screen.getByTestId('providers-subhd'))
    fireEvent.click(subhd.getByRole('switch'))
    await waitFor(() => expect(update).toHaveBeenCalledWith({ 'provider:SUBHD_ENABLED': 'false' }))
    await waitFor(() => expect(setupReload).toHaveBeenCalled())
  })

  it('zimuku 是 env 源 → toggle 禁用 + 锁定注', () => {
    renderSection()
    const zimuku = within(screen.getByTestId('providers-zimuku'))
    expect(zimuku.getByRole('switch')).toBeDisabled()
    expect(zimuku.getByText('Set by environment — locked')).toBeInTheDocument()
  })
})
```

Run: `cd web && npx vitest run src/settings/ProvidersSection.test.tsx`
Expected: FAIL（`./ProvidersSection.js` 不存在）

- [ ] **Step 3: ProvidersSection 实现**

Create `web/src/settings/ProvidersSection.tsx`：

```tsx
// web/src/settings/ProvidersSection.tsx：Providers 区（spec A §5.4）——每家一行：打码值、
// source 徽标、上次测试点、编辑（仅 db 源可改；空输入=不动该键，UI 不提供删除——删除走
// PUT secrets API 语义，界面不开放，防占位空串误删）、Test；无 key 的 subhd/zimuku 两家
// 以 toggle 行呈现（同一 PUT settings 通道）。编辑/测试后直接 reload 刷新打码与测试点。
// 与 wizard 的不对称是有意的：wizard 先测后存是首跑纪律；Settings 保存不强制测试，
// 靠上次测试点展示兜底（测试按钮常备）。Astryx 栈与邻区一致——整页随 Spec C 迁新栈。
import { useState } from 'react'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Button } from '@astryxdesign/core/Button'
import { Switch } from '@astryxdesign/core/Switch'
import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { api } from '../api/client.js'
import type { Async } from '../api/hooks.js'
import type { ProvidersDTO, ProviderRowDTO, SetupStatusDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'

// 厂牌专名不进 i18n（双表同形，同 wizard 步 1 语言自称先例）。
const PROVIDER_NAME: Record<ProviderRowDTO['id'], string> = {
  tmdb: 'TMDB',
  llm: 'LLM',
  assrt: 'ASSRT',
  opensubtitles: 'OpenSubtitles',
  jimaku: 'Jimaku',
  subhd: 'subhd',
  zimuku: 'zimuku',
}

interface Props {
  providers: Async<ProvidersDTO>
  setupStatus: Async<SetupStatusDTO>
}

function KeyedRow({ row, reload }: { row: ProviderRowDTO; reload: () => void }) {
  const { t } = useT()
  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const editable = row.secrets.some((s) => s.source !== 'env')

  const onSave = async () => {
    setBusy(true)
    setError(null)
    try {
      for (const s of row.secrets) {
        const v = drafts[s.name] ?? ''
        if (v === '') continue // 空输入 = 不动该键（UI 不提供删除，防占位空串误删）
        await api.putSecret(s.name, v)
      }
      setEditing(false)
      setDrafts({})
      reload()
    } catch (e) {
      setError(t('settings_save_error_prefix') + String(e))
    } finally {
      setBusy(false)
    }
  }

  const onTest = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.validateSetup(row.id)
      reload()
    } catch (e) {
      setError(t('settings_save_error_prefix') + String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <VStack gap={2} data-testid={`providers-${row.id}`}>
      <HStack gap={2} vAlign="center">
        <Text type="label">{PROVIDER_NAME[row.id]}</Text>
        <Button size="sm" variant="secondary" label={t('settings_provider_test')} isLoading={busy && !editing} onClick={() => void onTest()} />
        {editable && !editing && (
          <Button size="sm" variant="secondary" label={t('settings_provider_edit')} onClick={() => setEditing(true)} />
        )}
        {row.lastTest && (
          <>
            <StatusDot
              // StatusDotVariant 的域是 success|warning|error|accent|neutral 五个，**没有 danger**
              //（写 danger 是 TS2322，Step 5 的 `npx tsc --noEmit` 会直接拦下）。
              variant={row.lastTest.ok ? 'success' : 'error'}
              label={row.lastTest.ok ? t('settings_provider_last_test_ok') : t('settings_provider_last_test_fail')}
            />
            <Text type="supporting" color="secondary">
              {row.lastTest.ok ? t('settings_provider_last_test_ok') : t('settings_provider_last_test_fail')}
              {` · ${new Date(row.lastTest.at).toLocaleString()}`}
            </Text>
          </>
        )}
      </HStack>
      {row.lastTest && !row.lastTest.ok && row.lastTest.error && (
        <Text type="supporting" color="secondary">{row.lastTest.error}</Text>
      )}
      {row.secrets.map((s) => (
        <HStack key={s.name} gap={2} vAlign="center">
          <Text type="code">{s.name}</Text>
          {editing && s.source !== 'env' ? (
            <TextInput
              label={s.name}
              value={drafts[s.name] ?? ''}
              onChange={(v) => setDrafts((d) => ({ ...d, [s.name]: v }))}
              placeholder={s.masked ?? ''}
            />
          ) : (
            <>
              <Text type="supporting">{s.set ? s.masked ?? '••••' : t('settings_provider_not_set')}</Text>
              {s.set && (
                <Text type="supporting" color="secondary">
                  {s.source === 'env' ? t('settings_provider_source_env') : t('settings_provider_source_db')}
                </Text>
              )}
              {s.source === 'env' && (
                <Text type="supporting" color="secondary">{t('settings_provider_env_locked')}</Text>
              )}
            </>
          )}
        </HStack>
      ))}
      {editing && (
        <HStack gap={2}>
          <Button size="sm" variant="primary" label={t('settings_provider_save')} isLoading={busy} onClick={() => void onSave()} />
          <Button size="sm" variant="secondary" label={t('settings_provider_cancel')} onClick={() => { setEditing(false); setDrafts({}) }} />
        </HStack>
      )}
      {error && <Text type="supporting">{error}</Text>}
    </VStack>
  )
}

function ToggleRow({
  id, state, reload,
}: {
  id: 'subhd' | 'zimuku'
  state: { enabled: boolean; source: string }
  reload: () => void
}) {
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locked = state.source === 'env'
  const key = id === 'subhd' ? 'provider:SUBHD_ENABLED' as const : 'provider:ZIMUKU_ENABLED' as const

  const onToggle = async (next: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await api.updateSettings({ [key]: String(next) })
      reload()
    } catch (e) {
      setError(t('settings_save_error_prefix') + String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <VStack gap={1} data-testid={`providers-${id}`}>
      <HStack gap={2} vAlign="center">
        <Switch
          label={PROVIDER_NAME[id]}
          value={state.enabled}
          onChange={(next) => void onToggle(next)}
          isLoading={busy}
          isDisabled={locked}
        />
        {locked && <Text type="supporting" color="secondary">{t('settings_provider_env_locked')}</Text>}
      </HStack>
      {error && <Text type="supporting">{error}</Text>}
    </VStack>
  )
}

export function ProvidersSection({ providers, setupStatus }: Props) {
  const { t } = useT()
  return (
    <section className="settings-section">
      <Text type="label">{t('settings_providers_title')}</Text>
      {providers.loading && !providers.data ? (
        <Text type="code" color="secondary">loading…</Text>
      ) : providers.error && !providers.data ? (
        <Text type="supporting" color="secondary">{t('settings_error_prefix') + providers.error}</Text>
      ) : providers.data ? (
        <VStack gap={5}>
          {providers.data.providers.filter((r) => r.secrets.length > 0).map((row) => (
            <KeyedRow key={row.id} row={row} reload={providers.reload} />
          ))}
          {setupStatus.data && (
            <>
              <ToggleRow id="subhd" state={setupStatus.data.providers.subhd} reload={setupStatus.reload} />
              <ToggleRow id="zimuku" state={setupStatus.data.providers.zimuku} reload={setupStatus.reload} />
            </>
          )}
        </VStack>
      ) : null}
    </section>
  )
}
```

Astryx 各件的 prop 形状（照实测抄录，不是"大概这样"——下面每一行都能在既有文件里逐字找到）：

```tsx
// TextInput —— web/src/settings/BehaviorSection.tsx:89-96
<TextInput
  label={t('...')}
  value={draft}
  onChange={setDraft}          // 注意：直接吃新值，不是 (e) => e.target.value
  placeholder="..."
  description={t('...')}
  status={error ? { type: 'error', message: error } : undefined}
/>

// Switch —— web/src/settings/BehaviorSection.tsx:146-152
<Switch
  label={t('...')}
  value={value}                // 布尔，不是 checked
  onChange={(checked) => void commit('key', checked ? 'true' : 'false')}
  isLoading={saving}
  status={error ? { type: 'error', message: error } : undefined}
/>
// 禁用是 isDisabled（BehaviorSection.tsx:124/193 的 Selector/NumberInput 同款），不是 disabled。

// Button —— web/src/settings/BehaviorSection.tsx:97-103 / RootsManager.tsx:72-77
<Button size="sm" variant="secondary" label={t('...')} isLoading={saving} onClick={fn} />
// 文案走 label prop，**不是** children——写成 <Button>Test</Button> 按钮会是空的，
// 而且 getByRole('button', { name: 'Test' }) 查不到，测试红得没头绪。

// StatusDot —— web/src/settings/DeploySection.tsx:44-47
<StatusDot variant={ok ? 'success' : 'neutral'} label={t('...')} />

// HStack / VStack —— DeploySection.tsx:43 / BehaviorSection.tsx:88
<HStack gap={1.5} vAlign="center">…</HStack>
<VStack gap={2}>…</VStack>
```

`data-testid` 直接挂在 Astryx 的 `VStack`/`HStack` 上是**可行的**，别多包一层 div：Astryx `BaseProps` 有 `[key: \`data-${string}\`]: string | undefined` 索引签名（`node_modules/@astryxdesign/core/src/BaseProps.ts:94`），`Stack` 把剩余 props 原样 spread 到根元素上；既有生产代码 `web/src/activity/ActivityDone.tsx:62` 就是 `<HStack gap={3} vAlign="center" className="act-row" data-testid="activity-done-row">`。


Run: `cd web && npx vitest run src/settings/ProvidersSection.test.tsx`
Expected: 全 PASS

Commit:

```bash
git add web/src/settings
git commit -m "feat(web): Settings Providers 区——打码/徽标/测试点/编辑/Test + subhd·zimuku toggle（spec A §5.4）"
```

- [ ] **Step 4: DeploySection 瘦身（删 secrets 块）**

secrets 展示已归 ProvidersSection；Deploy 只留 nonSecrets（spec §5.4"纯部署信息保留为只读小块"）。**全文替换** `web/src/settings/DeploySection.tsx`：

```tsx
// web/src/settings/DeploySection.tsx：部署区（只读）——非密 env 原样展示，Jellyfin 式部署/产品
// 分界（DESIGN.md §1/§9）。secrets 展示 2026-08-02 起归 ProvidersSection（可编辑+测试，
// spec A §5.4）；本区零输入控件的传统不变：改动一律走 environment/compose。
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import type { Async } from '../api/hooks.js'
import type { DeploySettingsDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'

interface Props {
  deploy: Async<DeploySettingsDTO>
}

export function DeploySection({ deploy }: Props) {
  const { t } = useT()

  return (
    <section className="settings-section">
      <Text type="label">{t('settings_deploy_heading')}</Text>
      <Text type="supporting" color="secondary">
        {t('settings_deploy_readonly_note')}
      </Text>

      {deploy.loading && !deploy.data ? (
        <Text type="code" color="secondary">
          loading…
        </Text>
      ) : deploy.error && !deploy.data ? (
        <div className="settings-deploy-error">{t('settings_deploy_error_prefix') + deploy.error}</div>
      ) : deploy.data ? (
        <VStack gap={2}>
          <Text type="supporting" color="secondary">
            {t('settings_deploy_nonsecrets_heading')}
          </Text>
          {Object.entries(deploy.data.nonSecrets).map(([key, value]) => (
            <div className="settings-deploy-row" key={key}>
              <span className="settings-deploy-key">{key}</span>
              <span className="settings-deploy-value">
                {value ?? '—'}
                {/* MEDIA_ROOTS 是首启种子，真正生效的守备目录在 media_roots 表（本页下方
                    RootsManager）——原样展示 env 值必须带这句注解，否则用户改 .env 重启后
                    看到这行变了就以为生效了（审计四轮 R4 抓获的既有误导）。 */}
                {key === 'MEDIA_ROOTS' ? (
                  <Text type="supporting" color="secondary">
                    {t('settings_deploy_media_roots_seed_note')}
                  </Text>
                ) : null}
              </span>
            </div>
          ))}
        </VStack>
      ) : null}
    </section>
  )
}
```

再改 `web/src/settings/DeploySection.test.tsx`，三件事，缺一不可：

**⑴ 删除**所有涉及 secrets 渲染的用例（凡断言 `settings_deploy_secrets_heading` / present·absent 词 / `secretDisplay` 打码尾的测试整块移除），保留 nonSecrets 与 MEDIA_ROOTS 注解、loading/error 三态用例、以及"零输入控件"那条。

**⑵ 顶部 fixture `DATA` 的 `secrets` 字段原样保留，一个字都不要删。** `DeploySettingsDTO`（`src/dashboard/apiV2.ts:564-567`）把 `secrets` 声明为**必填** `Record`，删掉它就是 TS2739（缺少必需属性），文件直接编译不过。这个 fixture 从此只是喂类型的形状，值不再被任何断言消费——这是对的，不要"顺手清理"。

**⑶ 改一条保留下来的断言。** `it('nonSecrets：原样字符串；null 显示 em dash', …)`（`:51-62`）里最后一句今天是

```tsx
    // 两处 em dash：DASHBOARD_PORT 的 nonSecret 值 + DASHBOARD_TOKEN 的 absent secret tail。
    expect(screen.getAllByText('—')).toHaveLength(2)
```

本 Step 删掉的正是那个 absent secret tail 的渲染出处，所以计数必须跟着降到 1，注释同步改写：

```tsx
    // 一处 em dash：DASHBOARD_PORT 的 null nonSecret。secrets 打码展示 2026-08-02 起归
    // ProvidersSection，本区不再渲染 absent secret tail 的那个 em dash。
    expect(screen.getAllByText('—')).toHaveLength(1)
```

（这条不改就是本 Step 唯一会红的用例，且报错形态是 `expected length 2, received 1`——看起来像"少渲染了什么"，实际是断言过期。）

删完跑：

Run: `cd web && npx vitest run src/settings/DeploySection.test.tsx`
Expected: PASS（剩余用例全绿）

- [ ] **Step 5: SettingsPage 挂两区**

编辑 `web/src/settings/SettingsPage.tsx`——import 与 hooks、渲染序：

```tsx
import { useSettings, useDeploySettings, useRoots, useSetupProviders, useSetupStatus } from '../api/hooks.js'
import { BehaviorSection } from './BehaviorSection.js'
import { TranslateSection } from './TranslateSection.js'
import { ProvidersSection } from './ProvidersSection.js'
import { DeploySection } from './DeploySection.js'
import { RootsManager } from './RootsManager.js'
import { SystemSection } from './SystemSection.js'
import { SecuritySection } from './SecuritySection.js'
```

```tsx
export function SettingsPage() {
  const settings = useSettings()
  const deploy = useDeploySettings()
  const roots = useRoots()
  const providers = useSetupProviders()
  const setupStatus = useSetupStatus()
  const [updated, setUpdated] = useState<SettingsDTO | null>(null)
  const settingsData = updated != null ? { ...settings, data: updated } : settings

  return (
    <VStack gap={8}>
      <BehaviorSection settings={settingsData} />
      <TranslateSection settings={settingsData} deploy={deploy} onUpdated={setUpdated} />
      <ProvidersSection providers={providers} setupStatus={setupStatus} />
      <DeploySection deploy={deploy} />
      <RootsManager roots={roots} />
      <SystemSection />
      {/* 安全区排最后——低频人工操作（改密/换 key），不抢常用设置的视觉序位。 */}
      <SecuritySection />
    </VStack>
  )
}
```

同时把文件头注释第一行更新为新区序（行为/翻译/Providers/部署只读/守备目录/System/安全）。

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: 全 PASS + 零编译错误

- [ ] **Step 6: Commit**

```bash
git add web/src
git commit -m "feat(web): Deploy 区瘦身只留非密 + Settings 全新区序接线（spec A §5.4）"
```

### Task 26: 全量验证 + 密钥泄漏 grep 审计

**Files:** 无新增——纯验证闸门。

- [ ] **Step 1: 根仓验证（后端 Tasks 1-12 全量）**

Run: `npm run check && npm test`
Expected: tsc 零错误 + 全部 vitest 绿（含 secrets/settingsRepo/setupApi/daemon 闸/cli holder/apiV2/server 的新套件与全部既有回归）

- [ ] **Step 2: web 验证（前端 Tasks 13-25 全量）**

Run: `cd web && npx tsc --noEmit && npm test && npm run build`
Expected: 零编译错误 + 全测试绿 + 构建成功

- [ ] **Step 3: 密钥泄漏 grep 审计（spec A §8 强制，人工逐条核对）**

```bash
# 本次新增/改动文件的全部 log 调用——逐条确认只记 name、永不记 value：
# 本 plan 的全部提交都在这条链上；用 commit 主题里的 spec A 标记定位链首，**不要**用
# merge-base：执行者是一路在 main 上直接提交的，`git merge-base HEAD main` 就是 HEAD，
# 那条 range 恒为空，会把"什么都没改"误读成"没什么要审的"。
git diff --name-only $(git log --format=%H --grep='spec A' | tail -1)^..HEAD | grep -E '\.(ts|tsx)$'
grep -rn "console\.\|logger\.\|log(" src/v2/secrets.ts src/v2/settingsRepo.ts src/dashboard/setupApi.ts src/dashboard/server.ts src/cli/index.ts src/adapters/buildAdapters.ts web/src/setup web/src/settings/ProvidersSection.tsx web/src/shell/EngineBanner.tsx
```

逐条肉眼核对输出：**任何日志调用不得出现密钥值变量**（重点盯 catch 分支的 `String(e)`——若异常消息可能 echo 响应体/请求头，改记固定文案）。发现一处即修一处并回到 Step 1。

反向验证打码纪律：

```bash
# setup/status 与 providers 端点的测试里已有"响应不含明文子串"断言（Tasks 5-6 套件）——
# 这里再手动抽打一次真实序列化路径：
npm test -- --run src/dashboard/setupApi
```

- [ ] **Step 4: i18n parity 与文案纪律**

Run: `cd web && npx vitest run src/i18n`
Expected: zh/en 键集 parity PASS（77 个新键双表齐）；`grep -rn "卖萌\|啦\|哦\|嘛" web/src/i18n/en.ts web/src/i18n/zh.ts` 空输出（文案专业语域抽查）

- [ ] **Step 5: Commit（验证过程若有修复）**

```bash
git add -A
git commit -m "chore: spec A 全量验证收口——零泄漏审计通过"
```

### Task 27: 部署 + spec §9 实机验收（主控执行，非子代理）

**本任务由主控（编排方）亲自执行**：部署与实机验收需要视觉核对（opencode 无视觉）与 SSH 现场判断。子代理的工作在 Task 26 结束。

- [ ] **Step 1: 部署前确认**

```bash
git status --short   # 必须干净
git log --oneline -3 # 确认 Tasks 1-26 的提交链在
```

- [ ] **Step 2: 部署到 media-router**

```bash
DEPLOY_SSH_HOST=media-router-tunnel DEPLOY_TIMEOUT_SECONDS=3000 timeout 1500 ./deploy/deploy.sh
```

Expected: 部署脚本全绿，容器重启后健康检查通过（dashboard 端口可达）。

- [ ] **Step 3: 验收 ①——env 部署零打扰（spec §9 第一条）**

现有盒子 env 配齐 → `bootstrapComplete` 推导为 true → wizard 永不出现。

本步及以下所有 curl 都用环境变量带口令，**不把明文密码写进命令行**（命令行会进 shell history 与进程表；仓库刚在 4998c1d 清掉过一批硬编码凭据脚本，别又种回来）。先在本地 shell 里导出一次：

```bash
export SCOUT_ADMIN_PASS='<dashboard admin 口令>'   # 交互式输入，不要写进任何文件
```

```bash
# 打 setup/status（带 admin 鉴权），断言 bootstrapComplete: true、
# tmdb/llm source 全 "env"、engineEnabled: true：
curl -s -u "admin:$SCOUT_ADMIN_PASS" http://media-router-tunnel:<port>/api/v2/setup/status | python3 -m json.tool
```

浏览器（chrome-devtools MCP）开 dashboard：直接进主界面、**无 wizard**、活动页照常。再看容器日志确认 daemon 正常 tick、ingest/dispatch 照旧。

- [ ] **Step 4: 验收 ②——Engine 总开关（spec §9 第四条）**

```bash
# 关：
curl -s -u "admin:$SCOUT_ADMIN_PASS" -X PUT http://media-router-tunnel:<port>/api/v2/settings \
  -H 'Content-Type: application/json' -d '{"engine_enabled":"false"}'
```

浏览器：主屏顶部出现 "Engine off — polling and dispatch are paused." 细条 + Turn on。日志：随后 ≥30s 无 dispatch 行（reaper 日志不受影响可照常）。浏览器点 Turn on（或再 PUT true）→ banner 消失 → 日志恢复 dispatch。Settings Behavior 区 Engine 行同步翻转（≤15s）。

- [ ] **Step 5: 验收 ③——零 key 全新首跑（spec §9 第二条，本单的重头戏）**

⚠️ 本步要临时挪走盒子的 env key 并重启容器两次——个人盒子分钟级停机，已含在 spec 验收清单内。**先备份再动手**：

```bash
ssh media-router-tunnel 'cp /root/subtitle-scout/.env /root/subtitle-scout/.env.bak-spec-a'
# 注释掉 .env 里的 TMDB_API_KEY / LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（以及
# ASSRT/OS/JIMAKU——全挪走才能看到完整 wizard），重启容器：
ssh media-router-tunnel 'cd /root/subtitle-scout && sed -i -e "s/^TMDB_API_KEY=/#TMDB_API_KEY=/" -e "s/^LLM_/#LLM_/" -e "s/^ASSRT_TOKEN=/#ASSRT_TOKEN=/" -e "s/^OPENSUBTITLES_/#OPENSUBTITLES_/" -e "s/^JIMAKU_API_KEY=/#JIMAKU_API_KEY=/" .env && docker compose up -d --force-recreate'
```

验收点（浏览器走全程，逐步核对）：

1. 容器不再 crash-loop（`docker ps` 存活、健康检查转绿）——setup 模式存活，§4.7 的生死改动生效；
2. 开 dashboard → auth（admin 已在）→ **wizard 全屏出现**；
3. 步 1 选语言（选 zh 验证 wizard 界面即时切中文）→ Continue；
4. 步 2 输回盒子的真实 TMDB key → Test 绿 → Save & continue；
5. 步 3 三件套输回真实值 → Test 绿 → Save & continue；
6. 步 4 可跳（或把 ASSRT 输回去测绿）→ Continue；
7. 步 5 双开关 ON → Continue；
8. 步 6 已有 roots（库里原有）→ Continue 直接可用；
9. 步 7 汇总八行 Configured/Skipped 如实 → Engine ON → Launch；
10. 主界面出现、wizard 消失；**容器/进程全程零重启**；
11. 容器日志出现 `setup complete — engine live`；下一轮 ingest 日志照常扫描既有 roots。

收尾——恢复 env（env 优先于库，行为回到部署前口径）：

```bash
ssh media-router-tunnel 'cd /root/subtitle-scout && cp .env.bak-spec-a .env && docker compose up -d --force-recreate'
# 恢复后再验一次 ①：wizard 不出现、setup/status 全 env、日志正常。
```

- [ ] **Step 6: 验收 ④——Re-run wizard（spec §5.1）**

Settings → System → Re-run setup wizard → wizard 以 re-run 模式出现：TMDB/LLM 显示绿态打码 + Re-test 钮、Continue 直通；一路 Continue 到 Launch → 回主界面。

- [ ] **Step 7: 验收记录与收尾**

验收结果逐条记入实现报告（通过/偏离+原因）；`.env.bak-spec-a` 保留在盒子上一周无异常后可删。若有任何验收点不通过：回滚部署（git revert + 重新部署），不带着红灯进 Spec C。

---

## 收尾纪律

- 27 个任务全绿 + 实机验收全过 = Spec A 完成。更新任务清单（#24 done）后按管线进 **Spec C**（plan → 审计 → 实现），顺序不可乱（A→C→B 用户拍板）。
- 实现期若发现 plan 与代码现状冲突（行号漂移、prop 形状不符）：以**测试断言的语义**为准修实现，以**既有文件的用法先例**为准修调用——不回改已验函数签名；冲突大到动摇设计时停下上报主控，不擅自改设计。

---

## Task 27 实机验收记录（2026-08-03，主控执行）

部署：revision `8edfc7e`（feat/frontend-rebuild-a-c-b HEAD）经 `media-router-wan` 隧道部署成功（LAN 22 端口 banner 超时，走 localhost:9927 隧道）。容器重建健康。

**验收 ① env 零打扰：通过。** setup/status：bootstrapComplete=true、tmdb/llm/assrt/os/jimaku/subhd/zimuku 全 source=env、engineEnabled=true、打码值无泄漏。浏览器登录直达媒体库主界面，无 wizard。daemon 正常 ingest（scanned=492）+ db backup。

**验收 ② Engine 总开关：通过。** PUT engine_enabled=false → ≤15s 主屏顶部出现「发动机已关——轮询与派发暂停。」+「开启」钮；daemon 日志打 `engine off — polling and dispatch are paused`，期间零 ingest/dispatch。点「开启」→ banner 消失，日志 `engine on — work loops resumed`。Settings Behavior 区发动机行在场且同步（第一行，checked=true）。

**验收 ③ 零 key 全新首跑：通过（重头戏）。** 备份 .env → 注释 TMDB/LLM_/ASSRT/OPENSUBTITLES_/JIMAKU → force-recreate。
1. 容器不 crash-loop，SETUP MODE 存活：dashboard 起来、engine 闸住、三条警告行（LLM/TMDB 未配 + zimuku captcha 守卫）如实；
2. 登录后 wizard 全屏接管；
3. 步 1 语言联动实机验证（en↔zh 即时切换双向可见），选 zh；
4. 步 2 先喂错 key 被分类文案「Invalid credentials — check the key and try again.」正确拒掉（意外但宝贵的失败径实证），真 key 测绿才解锁保存；
5. 步 3 三件套测绿保存；
6. 步 4 ASSRT 测绿保存，OS/Jimaku 跳过；
7. 步 5 双开关 ON 且 env 锁定（禁用态）；
8. 步 6 库已有 1 root，Continue 直通；
9. 步 7 八行汇总如实（3 配 2 跳 + env 两家 + roots），Engine ON → Launch；
10. 主界面出现、wizard 消失、全程容器零重启（Up 8min 连续）；
11. 日志 `setup complete — engine live`（11:47:35），1.3s 后 ingest 照常（scanned=492）。
收尾：恢复 .env.bak-spec-a + recreate → 复验 ① 全 env 通过（备份留盒上一周）。

**验收 ④ Re-run wizard：通过。** Settings → System → 重跑设置向导 → wizard re-run 模式：TMDB「已通过环境变量配置 · eyJ••••AY4」、LLM 带 model 名、三家 provider env 锁行、zimuku captcha 就绪行、八行全「已配置」→ Launch 回主界面。步 1 空选重选为已定夺口径（DTO 不带语言字段）。

**评审立案复核：** Task 22 under-report（步 4 中途 PUT 失败 → 汇总低报）本次全程成功未现；安全方向（Settings Providers 自愈）成立，可接受。
