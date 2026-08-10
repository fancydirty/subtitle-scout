# Settings 页面 Tab 式重设计 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `SETTINGS_TAB_REDESIGN_SPEC.md` 把 Settings 单页平铺重做成 5-tab 卡片式布局（general / providers / media / security / advanced），后端先打通 `TRANSLATE_*` 三凭证的白名单与来源无关化，再 TDD 落地七张新卡片与 Tabs 容器，最后迁移六区、删除旧组件、agent-browser 验收。

**Architecture:** 阶段 0 改三个后端文件让专用翻译凭证可入库并被 daemon 经 `resolveSecret` 读到（推翻"逐字不动"注释，已用户拍板）；阶段 1 TDD 落地五个新组件（SettingsCard / ProviderCard+ProviderSecretField / ProviderToggleCard / TranslateCard）；阶段 2 安装 `@radix-ui/react-tabs` 并造 `tabs.tsx` + `SettingsTabsPage` + Badge success/warning 变体；阶段 3 把六区现有逻辑迁进对应 tab（BehaviorSection 拆掉自带 `<section>` 壳复用 SettingsCard）；阶段 4 改 AppShell 路由、删旧组件、修测试。所有 UI 用 tw.css 既有 token（`bg-card`/`border-border`/`rounded-card`/`text-fn-green` 等），不写 spec 散文里的 hex 字面量。

**Tech Stack:** Node 22 + tsx（后端）、React 19 + Vite + Vitest + Tailwind v4 + shadcn/Radix（前端）、`@radix-ui/react-tabs`（新增依赖）。

**铁律摘录（实现期不可违反）：**
- UI 文案一律英语专业书面语，术语对齐 Sonarr/Radarr/Bazarr；禁拟人/卖萌/口语（`frontend-copy-and-scope-rules`）。
- 密钥明文永不进日志/序列化；审计日志只记 name/action（spec §8）。
- `docs/` 已 gitignore，本计划不提交；commit message 正文禁反引号（zsh 会吃）。
- 禁触 `src/v2/realignExecutor.ts`、`src/agent/skills/`、`docker-compose.yml`、`.claude/`、`token.txt`。
- i18n 新键必须 zh/en 双表同形（`web/src/i18n/i18n.test.ts` 钉死键集相等）；字面量（如 "Cancel"）不必加键。

---

## File Structure

**阶段 0 · 后端打通**

| 文件 | 责任 | 改动 |
|---|---|---|
| `src/v2/secrets.ts` | 密钥白名单 + 解析 | `SECRET_NAMES` 9→12（加 `TRANSLATE_BASE_URL`/`TRANSLATE_API_KEY`/`TRANSLATE_MODEL`）；`resolveSecret`/`isSecretName` 等签名不变 |
| `src/dashboard/setupApi.ts` | providers DTO + validate | 四处耦合：`ProviderRowDTO['id']` 加 `'translate'`；`PROVIDER_SECRETS.translate`；`VALIDATE_TARGETS` 加 `'translate'`；`NEXT_STEP_HINT.translate`；新增 `defaultProbe` 的 `'translate'` 分支 |
| `src/cli/translateItemCommand.ts` | 翻译配置组装 | `translateLlmCfg` 的 `TRANSLATE_MODEL` 分支改走 `resolveSecret`（删"逐字不动"注释）；`tryAutoTranslateCfg` 改接受 `AdapterConfigResolver` 经 `resolveSecret` 取值，缺任一返 null（绝不回落 `LLM_*`） |
| `src/cli/index.ts` | daemon 调用点 | 两处 `tryAutoTranslateCfg()` 调用传入 `cfg`（外层 resolver）；worker 分支 520 行的局部 `cfg` 遮蔽注释更新 |
| `src/v2/secrets.test.ts` | 白名单测试 | `toHaveLength(9)`→12；新增三键断言 |
| `src/v2/settingsRepo.test.ts` | listSecretMeta 测试 | `toHaveLength(9)`→12 |
| `src/dashboard/setupApi.test.ts` | providers 测试 | provider id 数组加 `'translate'`；新增 translate 行 secrets 断言 |
| `src/cli/translateItemCommand.test.ts` | tryAuto 测试 | 新增 `tryAutoTranslateCfg` 来源无关测试（env 全有/db 全有/env 缺一/db 缺一） |
| `web/src/api/types.ts` | 前端类型镜像 | `SECRET_NAMES` 9→12；`ValidateTarget` 加 `'translate'` |

**阶段 1 · 新组件（TDD）**

| 文件 | 责任 |
|---|---|
| `web/src/settings/SettingsCard.tsx` | 通用卡片容器：title/description/status badge/children |
| `web/src/settings/SettingsCard.test.tsx` | 标题/描述/三态 badge/children |
| `web/src/settings/ProviderCard.tsx` | 字幕源 keyed 卡片：env 只读/db 可编辑/编辑态/测试/lastTest（内含 `ProviderSecretField`，不单测） |
| `web/src/settings/ProviderCard.test.tsx` | env 锁/db 编辑/测试/混合源/lastTest/结构钉 |
| `web/src/settings/ProviderToggleCard.tsx` | subhd/zimuku 开关卡片 |
| `web/src/settings/ProviderToggleCard.test.tsx` | Switch 同步/env 锁定/切换 API |
| `web/src/settings/TranslateCard.tsx` | AI 翻译双层卡片（§4.2.6）：Switch→Segmented→三必填字段，原子性校验，切回默认破坏性确认 |
| `web/src/settings/TranslateCard.test.tsx` | 11 条行为（§10） |

**阶段 2 · Tabs 容器**

| 文件 | 责任 |
|---|---|
| `web/src/components/ui/tabs.tsx` | shadcn Tabs copy-in（Radix） |
| `web/src/components/ui/badge.tsx` | 加 `success`/`warning` 变体 |
| `web/src/settings/SettingsTabsPage.tsx` | 五 tab 容器 + badge 逻辑 |
| `web/src/settings/SettingsTabsPage.test.tsx` | tab 切换/badge 计算/通用 tab 无翻译控件 |

**阶段 3 · 迁移**

| 文件 | 改动 |
|---|---|
| `web/src/settings/BehaviorSection.tsx` | 拆掉自带 `<section className="settings-section">` + heading + loading/error 早期返回，改由 SettingsCard 承载；保留五行业务逻辑 |
| `web/src/settings/BehaviorSection.test.tsx` | 适配新 DOM（标题改由 SettingsCard 渲染） |
| `web/src/settings/SettingsTabsPage.tsx` | 接入六区到对应 tab |

**阶段 4 · 清理**

| 文件 | 改动 |
|---|---|
| `web/src/settings/SettingsPage.tsx` | 删除（被 SettingsTabsPage 取代） |
| `web/src/settings/TranslateSection.tsx`(.test.tsx) | 删除（被 TranslateCard 取代） |
| `web/src/settings/ProvidersSection.tsx`(.test.tsx) | 删除（被 ProviderCard/ProviderToggleCard 取代） |
| `web/src/shell/AppShell.tsx` | `SettingsPage`→`SettingsTabsPage` |
| `web/src/App.test.tsx` | `getByText('Behavior')` 锚点保留校验 |

---

## 阶段 0：后端打通

### Task 1: 扩 `SECRET_NAMES` 白名单 9→12

**Files:**
- Modify: `src/v2/secrets.ts:9-12`（`SECRET_NAMES` 数组）
- Modify: `src/v2/secrets.test.ts:11-17`（`toHaveLength(9)` + 排序断言）
- Modify: `src/v2/settingsRepo.test.ts:298`（`toHaveLength(9)`）

- [ ] **Step 1: 改 `secrets.test.ts` 的键集断言（先红）**

`src/v2/secrets.test.ts` 第 11-17 行当前：
```ts
  it('恰为 9 键', () => {
    expect([...SECRET_NAMES].sort()).toEqual([
      'ASSRT_TOKEN', 'JIMAKU_API_KEY', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL',
      'OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_PASSWORD', 'OPENSUBTITLES_USERNAME',
      'TMDB_API_KEY',
    ].sort())
    expect(SECRET_NAMES).toHaveLength(9)
  })
```
改为：
```ts
  it('恰为 12 键（含 TRANSLATE_* 三凭证，spec §8.2）', () => {
    expect([...SECRET_NAMES].sort()).toEqual([
      'ASSRT_TOKEN', 'JIMAKU_API_KEY', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL',
      'OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_PASSWORD', 'OPENSUBTITLES_USERNAME',
      'TMDB_API_KEY',
      'TRANSLATE_API_KEY', 'TRANSLATE_BASE_URL', 'TRANSLATE_MODEL',
    ].sort())
    expect(SECRET_NAMES).toHaveLength(12)
  })
```

- [ ] **Step 2: 改 `settingsRepo.test.ts:298` 的 meta 计数断言**

`src/v2/settingsRepo.test.ts` 第 296-298 行当前注释 + 断言：
```ts
    // 9 = SECRET_NAMES.length（Task 1 已定：spec 枚举 9 个，散文的"10"是笔误）。
    expect(meta).toHaveLength(9)
```
改为：
```ts
    // 12 = SECRET_NAMES.length（阶段 0 扩入 TRANSLATE_* 三凭证，spec §8.2）。
    expect(meta).toHaveLength(12)
```

- [ ] **Step 3: 跑两个测试确认红**

Run: `npx vitest run src/v2/secrets.test.ts src/v2/settingsRepo.test.ts`
Expected: FAIL（`expected 9 to be 12` / `expected [Array] to equal [Array]`，TRANSLATE_* 缺席）

- [ ] **Step 4: 改 `src/v2/secrets.ts` 的 `SECRET_NAMES`**

当前第 9-12 行：
```ts
export const SECRET_NAMES = ['TMDB_API_KEY','LLM_BASE_URL','LLM_API_KEY','LLM_MODEL','ASSRT_TOKEN','OPENSUBTITLES_API_KEY','OPENSUBTITLES_USERNAME','OPENSUBTITLES_PASSWORD','JIMAKU_API_KEY'] as const
```
改为：
```ts
export const SECRET_NAMES = ['TMDB_API_KEY','LLM_BASE_URL','LLM_API_KEY','LLM_MODEL','ASSRT_TOKEN','OPENSUBTITLES_API_KEY','OPENSUBTITLES_USERNAME','OPENSUBTITLES_PASSWORD','JIMAKU_API_KEY','TRANSLATE_BASE_URL','TRANSLATE_API_KEY','TRANSLATE_MODEL'] as const
```

- [ ] **Step 5: 跑测试确认绿**

Run: `npx vitest run src/v2/secrets.test.ts src/v2/settingsRepo.test.ts`
Expected: PASS

- [ ] **Step 6: 跑全量后端类型检查确认无连带红**

Run: `npm run check`
Expected: PASS（`SecretName` 联合自动扩到 12；下游 `Record<SecretName,…>` 是 `Partial` 不强穷尽，不红）

- [ ] **Step 7: Commit**

```bash
git add src/v2/secrets.ts src/v2/secrets.test.ts src/v2/settingsRepo.test.ts
git commit -m "feat(secrets): 扩 SECRET_NAMES 白名单 9→12，加 TRANSLATE_* 三凭证

spec §8.2：专用翻译凭证需可入库被 resolveSecret 读到。白名单扩容，
isSecretName/resolveSecret 签名不变。两个旧测试的 9 键断言同步改 12。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: `setupApi.ts` 四处耦合 + translate probe

**Files:**
- Modify: `src/dashboard/setupApi.ts:48-50`（`ProviderRowDTO['id']`）
- Modify: `src/dashboard/setupApi.ts:156-165`（`PROVIDER_SECRETS`）
- Modify: `src/dashboard/setupApi.ts:190-191`（`VALIDATE_TARGETS`）
- Modify: `src/dashboard/setupApi.ts:199-207`（`NEXT_STEP_HINT`）
- Modify: `src/dashboard/setupApi.ts:237-300`（`defaultProbe` 加 `'translate'` 分支）
- Modify: `src/dashboard/setupApi.test.ts:154-161`（provider id 数组 + translate 行断言）

- [ ] **Step 1: 改 `setupApi.test.ts` 的 provider id 断言（先红）**

第 154 行当前：
```ts
    expect(p.providers.map((r) => r.id)).toEqual(['tmdb', 'llm', 'assrt', 'opensubtitles', 'jimaku', 'subhd', 'zimuku'])
```
改为（注意 `'translate'` 插在 `'llm'` 之后，与 spec §4.2 顺序一致——紧跟 LLM 消费 LLM 凭证）：
```ts
    expect(p.providers.map((r) => r.id)).toEqual(['tmdb', 'llm', 'translate', 'assrt', 'opensubtitles', 'jimaku', 'subhd', 'zimuku'])
```

在该 it 块末尾（第 161 行 `expect(p.providers.find((r) => r.id === 'zimuku')!.lastTest).toBeNull()` 之后、`expect(JSON.stringify(p)).not.toContain(...)` 之前）加：
```ts
    expect(p.providers.find((r) => r.id === 'translate')!.secrets.map((s) => s.name))
      .toEqual(['TRANSLATE_BASE_URL', 'TRANSLATE_API_KEY', 'TRANSLATE_MODEL'])
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run src/dashboard/setupApi.test.ts`
Expected: FAIL（`expected ['tmdb','llm',...,'zimuku'] to equal ['tmdb','llm','translate',...]`）

- [ ] **Step 3: 改 `ProviderRowDTO['id']` 联合**

`src/dashboard/setupApi.ts` 第 48-50 行当前：
```ts
export interface ProviderRowDTO {
  id: 'tmdb' | 'llm' | 'assrt' | 'opensubtitles' | 'jimaku' | 'subhd' | 'zimuku'
```
改为：
```ts
export interface ProviderRowDTO {
  id: 'tmdb' | 'llm' | 'translate' | 'assrt' | 'opensubtitles' | 'jimaku' | 'subhd' | 'zimuku'
```

- [ ] **Step 4: 改 `PROVIDER_SECRETS` 加 translate 键**

第 156-165 行当前 `PROVIDER_SECRETS` 对象，在 `llm: [...]` 之后加 `translate` 键：
```ts
const PROVIDER_SECRETS: Record<ProviderRowDTO['id'], SecretName[]> = {
  tmdb: ['TMDB_API_KEY'],
  llm: ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'],
  translate: ['TRANSLATE_BASE_URL', 'TRANSLATE_API_KEY', 'TRANSLATE_MODEL'],
  assrt: ['ASSRT_TOKEN'],
  opensubtitles: ['OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_USERNAME', 'OPENSUBTITLES_PASSWORD'],
  jimaku: ['JIMAKU_API_KEY'],
  subhd: [],
  zimuku: [],
}
```

- [ ] **Step 5: 改 `VALIDATE_TARGETS` 加 `'translate'`**

第 190 行当前：
```ts
export const VALIDATE_TARGETS = ['tmdb', 'llm', 'assrt', 'opensubtitles', 'jimaku', 'subhd', 'zimuku'] as const
```
改为：
```ts
export const VALIDATE_TARGETS = ['tmdb', 'llm', 'translate', 'assrt', 'opensubtitles', 'jimaku', 'subhd', 'zimuku'] as const
```

- [ ] **Step 6: 改 `NEXT_STEP_HINT` 加 translate 提示**

第 199-207 行 `NEXT_STEP_HINT` 对象，在 `llm:` 行之后加 `translate:` 键（与 LLM 同款"三凭证同源"提示，因 translate 用同一 `makeModel` 探测）：
```ts
const NEXT_STEP_HINT: Record<ValidateTarget, string> = {
  tmdb: 'Get a key at themoviedb.org → account Settings → API → API Key (v3 auth).',
  llm: 'All three fields must come from the same provider; the base URL usually ends with /v1.',
  translate: 'All three fields must come from the same provider; the base URL usually ends with /v1.',
  assrt: 'Copy your API token from assrt.net → user center.',
  opensubtitles: 'Create an API key at opensubtitles.com → your profile → API consumers.',
  jimaku: 'Copy your API key from jimaku.cc account settings.',
  subhd: 'subhd.me must be reachable from this host — check the network/proxy.',
  zimuku: 'zimuku.org must be reachable; some networks block or throttle it.',
}
```

- [ ] **Step 7: 改 `defaultProbe` 加 `'translate'` 分支**

`defaultProbe` 的 switch（第 237 行起）在 `case 'llm':` 块之后、`case 'assrt':` 之前加一个 `case 'translate'` 分支。复用 `makeModel` + `checkLlm`（与 LLM 同款探测形状，区别只在不要求"三凭证齐全才允许跑"——probe 是"测已配的"，缺值返 notConfigured，与 LLM 分支语义一致）：

```ts
    case 'translate': {
      const baseUrl = cred('TRANSLATE_BASE_URL'); const apiKey = cred('TRANSLATE_API_KEY'); const modelName = cred('TRANSLATE_MODEL')
      if (!baseUrl || !apiKey || !modelName) return () => notConfigured
      const model = makeModel({ baseUrl, apiKey, model: modelName })
      return () => checkLlm(async () =>
        (await generateText({ model, prompt: '回复"ok"两个字母即可', maxOutputTokens: 1, abortSignal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS) })).text)
    }
```

- [ ] **Step 8: 跑测试确认绿**

Run: `npx vitest run src/dashboard/setupApi.test.ts`
Expected: PASS

- [ ] **Step 9: 跑全量类型检查（验证四处耦合穷尽）**

Run: `npm run check`
Expected: PASS（`Record<ProviderRowDTO['id'], SecretName[]>` 与 `Record<ValidateTarget, string>` 都要求穷尽，类型系统自证齐全）

- [ ] **Step 10: Commit**

```bash
git add src/dashboard/setupApi.ts src/dashboard/setupApi.test.ts
git commit -m "feat(setupApi): translate provider 四处耦合 + translate probe

ProviderRowDTO id 联合、PROVIDER_SECRETS、VALIDATE_TARGETS、NEXT_STEP_HINT
四处同步加 translate（类型穷尽性自证齐全）；defaultProbe 加 translate
分支复用 makeModel+checkLlm。spec §8.2。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: `translateItemCommand.ts` 来源无关化 + `tryAutoTranslateCfg` 接 resolver

**Files:**
- Modify: `src/cli/translateItemCommand.ts:42-50`（`translateLlmCfg` 删"逐字不动"注释、改走 resolver）
- Modify: `src/cli/translateItemCommand.ts:74-80`（`tryAutoTranslateCfg` 签名改接 `AdapterConfigResolver`）
- Modify: `src/cli/index.ts:520`（worker 分支调用传 `cfg`）
- Modify: `src/cli/index.ts:668`（dispatch 分支调用传 `cfg`）
- Modify: `src/cli/translateItemCommand.test.ts`（新增 `tryAutoTranslateCfg` 来源无关测试）

- [ ] **Step 1: 写 `tryAutoTranslateCfg` 来源无关测试（先红）**

在 `src/cli/translateItemCommand.test.ts` 末尾追加（需先确认该文件 import 区有 `tryAutoTranslateCfg`、`makeAdapterConfigResolver`、`envOnlyAdapterConfig`；若无则补 import——见 Step 4 的 import 行）：

```ts
describe('tryAutoTranslateCfg — 来源无关 + 绝不回落 LLM_*', () => {
  const baseEnv = { TRANSLATE_BASE_URL: 'https://api.example.com/v1', TRANSLATE_API_KEY: 'sk-t', TRANSLATE_MODEL: 'gpt-4o-mini' }

  it('env 三凭证全有 → 返回 env 值', () => {
    const cfg = envOnlyAdapterConfig(baseEnv)
    expect(tryAutoTranslateCfg(cfg)).toEqual({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-t', model: 'gpt-4o-mini' })
  })

  it('db 三凭证全有 → 返回 db 值（env 缺席）', () => {
    const cfg = makeAdapterConfigResolver({}, (k) => {
      const map: Record<string, string> = {
        'secret:TRANSLATE_BASE_URL': 'https://db.example.com/v1',
        'secret:TRANSLATE_API_KEY': 'sk-db',
        'secret:TRANSLATE_MODEL': 'db-model',
      }
      return map[k] ?? null
    })
    expect(tryAutoTranslateCfg(cfg)).toEqual({ baseUrl: 'https://db.example.com/v1', apiKey: 'sk-db', model: 'db-model' })
  })

  it('env 缺一 → 返回 null（绝不回落 LLM_*）', () => {
    const cfg = envOnlyAdapterConfig({ ...baseEnv, TRANSLATE_API_KEY: '' })
    expect(tryAutoTranslateCfg(cfg)).toBeNull()
  })

  it('三凭证全无 → null', () => {
    const cfg = envOnlyAdapterConfig({})
    expect(tryAutoTranslateCfg(cfg)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run src/cli/translateItemCommand.test.ts`
Expected: FAIL（`tryAutoTranslateCfg` 当前签名是 `(env?)`，传 `AdapterConfigResolver` 不匹配；`envOnlyAdapterConfig`/`makeAdapterConfigResolver` 可能未 import）

- [ ] **Step 3: 改 `translateLlmCfg` 删"逐字不动"注释、改走 resolver**

`src/cli/translateItemCommand.ts` 第 42-50 行当前：
```ts
/** E 翻译用的 LLM 配置。TRANSLATE_MODEL 一旦设置 → 走 TRANSLATE_* 三件套(让 E 用强模型,与
 *  captcha 用的 LLM_MODEL=mimo 分开——真机实测 mimo 对翻译太弱);否则回退 LLM_*。 */
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
改为（`TRANSLATE_MODEL` 分支改走 `secrets.secret(...)`，env 非空 > db > none 的优先级由 `resolveSecret` 承担；删"逐字不动"注释，换成新语义说明）：
```ts
/** E 翻译用的 LLM 配置。专用模型（TRANSLATE_* 三凭证齐全，来源无关：env 非空 > db > none）
 *  → 走 TRANSLATE_* 三件套(让 E 用强模型,与 captcha 用的 LLM_MODEL=mimo 分开——真机实测 mimo
 *  对翻译太弱);否则回退 LLM_*。spec §8.2：用户拍板推翻 env-only 限制，专用凭证可入库可编辑。 */
function translateLlmCfg(secrets: AdapterConfigResolver): { baseUrl: string; apiKey: string; model: string } {
  const tBase = secrets.secret('TRANSLATE_BASE_URL').value
  const tKey = secrets.secret('TRANSLATE_API_KEY').value
  const tModel = secrets.secret('TRANSLATE_MODEL').value
  if (tBase && tKey && tModel) {
    return { baseUrl: tBase, apiKey: tKey, model: tModel }
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

- [ ] **Step 4: 改 `tryAutoTranslateCfg` 签名接 resolver**

`src/cli/translateItemCommand.ts` 第 74-80 行当前：
```ts
/** daemon 自动翻译的配置门(与上面手动 CLI 的区别):**只认显式 TRANSLATE_* 三件套,绝不回退
 *  LLM_***——自动路径拿 LLM_MODEL(mimo,太弱且非用户对本功能的 opt-in)烧配额是事故。三件套
 *  不全 → null = 功能休眠(daemon 不注入派活钩子,translate 任务也拒跑),同 SUBHD_ENABLED 模式。 */
export function tryAutoTranslateCfg(env: NodeJS.ProcessEnv = process.env): { baseUrl: string; apiKey: string; model: string } | null {
  const { TRANSLATE_MODEL, TRANSLATE_BASE_URL, TRANSLATE_API_KEY } = env
  if (!TRANSLATE_MODEL || !TRANSLATE_BASE_URL || !TRANSLATE_API_KEY) return null
  return { baseUrl: TRANSLATE_BASE_URL, apiKey: TRANSLATE_API_KEY, model: TRANSLATE_MODEL }
}
```
改为（接受 `AdapterConfigResolver`，经 `resolveSecret` 取值；双门语义不变——三凭证齐全才返值，缺任一返 null，绝不回落 `LLM_*`）：
```ts
/** daemon 自动翻译的配置门(与上面手动 CLI 的区别):**只认 TRANSLATE_* 三件套齐全,绝不回退
 *  LLM_***——自动路径拿 LLM_MODEL(mimo,太弱且非用户对本功能的 opt-in)烧配额是事故。三件套
 *  不全 → null = 功能休眠(daemon 不注入派活钩子,translate 任务也拒跑),同 SUBHD_ENABLED 模式。
 *  spec §8.2：来源无关化——env 非空 > db > none,UI 存库的专用凭证对 daemon 可见。 */
export function tryAutoTranslateCfg(cfg: AdapterConfigResolver): { baseUrl: string; apiKey: string; model: string } | null {
  const baseUrl = cfg.secret('TRANSLATE_BASE_URL').value
  const apiKey = cfg.secret('TRANSLATE_API_KEY').value
  const model = cfg.secret('TRANSLATE_MODEL').value
  if (!baseUrl || !apiKey || !model) return null
  return { baseUrl, apiKey, model }
}
```

- [ ] **Step 5: 补 import（若测试文件缺）**

确认 `src/cli/translateItemCommand.test.ts` 顶部 import 区有：
```ts
import { tryAutoTranslateCfg } from './translateItemCommand.js'
import { makeAdapterConfigResolver, envOnlyAdapterConfig } from '../v2/secrets.js'
```
若缺则补上（`translateItemCommand.ts` 顶部已 import 这两个，测试文件照抄）。

- [ ] **Step 6: 改 `src/cli/index.ts` 两处调用传 `cfg`**

第 520 行当前：
```ts
        const cfg = tryAutoTranslateCfg()
```
改为（外层第 278 行已有 `const cfg = makeAdapterConfigResolver(process.env, (k) => settingsRepo.get(k))`，直接传入；注意此处局部 `const cfg` 之前遮蔽的是 `AdapterConfigResolver`，改名避免与返回的翻译 cfg 冲突）：
```ts
        const translateCfg = tryAutoTranslateCfg(cfg)
        if (!translateCfg) {
          jobs.completeError(job.id, 'translate 未启用:需配 TRANSLATE_MODEL/TRANSLATE_BASE_URL/TRANSLATE_API_KEY 三件套', Date.now())
        } else {
```
并把后续该 else 块内引用 `cfg` 的地方（第 527 行 `makeDaemonTranslateRunItem({ db, cfg, ... })`）改为 `translateCfg`：
```ts
          const runItem = makeDaemonTranslateRunItem({
            db, cfg: translateCfg, fetchSourceSub, tmdb: c.tmdb, roots: currentRoots,
          })
```
并把第 527-528 行的旧注释"注意：此处 cfg 是 tryAutoTranslateCfg() 的局部值（遮蔽外层 AdapterConfigResolver），不能喂给 buildAdapters"更新为：
```ts
          // translateCfg 是 tryAutoTranslateCfg(cfg) 的返回值（专用翻译三凭证），与外层
          // AdapterConfigResolver 同名 cfg 不再遮蔽——重命名为 translateCfg 消除歧义。
```

第 668 行当前（dispatch 分支）：
```ts
      if (tryAutoTranslateCfg() && settingsRepo.get('ai_translate_enabled') === 'true') {
```
改为：
```ts
      if (tryAutoTranslateCfg(cfg) && settingsRepo.get('ai_translate_enabled') === 'true') {
```

- [ ] **Step 7: 跑测试确认绿**

Run: `npx vitest run src/cli/translateItemCommand.test.ts`
Expected: PASS

- [ ] **Step 8: 跑全量后端测试 + 类型检查**

Run: `npm test && npm run check`
Expected: PASS（`makeDaemonTranslateRunItem` 签名未变，只改了传入变量名；`tryAutoTranslateCfg` 新签名在两处调用都已适配）

- [ ] **Step 9: Commit**

```bash
git add src/cli/translateItemCommand.ts src/cli/translateItemCommand.test.ts src/cli/index.ts
git commit -m "feat(translate): tryAutoTranslateCfg 来源无关化，专用凭证可入库

推翻 env-only 逐字不动注释（用户拍板 spec §8.2）。translateLlmCfg 与
tryAutoTranslateCfg 改经 resolveSecret 取值（env 非空 > db > none）。
daemon 两处调用传入外层 AdapterConfigResolver。双门语义不变：三凭证
齐全且 ai_translate_enabled=true 才跑，绝不回落 LLM_*。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 前端类型镜像 `web/src/api/types.ts`

**Files:**
- Modify: `web/src/api/types.ts:438-446`（`SECRET_NAMES` + 注释）
- Modify: `web/src/api/types.ts:448`（`ValidateTarget`）

- [ ] **Step 1: 改 `SECRET_NAMES`**

第 438-446 行当前：
```ts
/** 9 个密钥白名单（spec §4.1 枚举值；正文"10 个"系笔误）。与后端 SECRET_NAMES 同序。 */
export const SECRET_NAMES = [
  'TMDB_API_KEY',
  'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL',
  'ASSRT_TOKEN',
  'OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_USERNAME', 'OPENSUBTITLES_PASSWORD',
  'JIMAKU_API_KEY',
] as const
export type SecretName = (typeof SECRET_NAMES)[number]
```
改为：
```ts
/** 12 个密钥白名单（spec §4.1 枚举 + §8.2 TRANSLATE_* 三凭证）。与后端 SECRET_NAMES 同序。 */
export const SECRET_NAMES = [
  'TMDB_API_KEY',
  'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL',
  'ASSRT_TOKEN',
  'OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_USERNAME', 'OPENSUBTITLES_PASSWORD',
  'JIMAKU_API_KEY',
  'TRANSLATE_BASE_URL', 'TRANSLATE_API_KEY', 'TRANSLATE_MODEL',
] as const
export type SecretName = (typeof SECRET_NAMES)[number]
```

- [ ] **Step 2: 改 `ValidateTarget`**

第 448 行当前：
```ts
export type ValidateTarget = 'tmdb' | 'llm' | 'assrt' | 'opensubtitles' | 'jimaku' | 'subhd' | 'zimuku'
```
改为：
```ts
export type ValidateTarget = 'tmdb' | 'llm' | 'translate' | 'assrt' | 'opensubtitles' | 'jimaku' | 'subhd' | 'zimuku'
```

- [ ] **Step 3: 跑前端类型检查 + 测试**

Run: `cd web && npm run build && npm test`
Expected: PASS（`SECRET_NAMES` 镜像无消费者做穷尽 `Record`，扩容不红；`ValidateTarget` 下游 `validateSetup(target)` 传字符串字面量，加 `'translate'` 不破坏既有调用）

- [ ] **Step 4: Commit**

```bash
git add web/src/api/types.ts
git commit -m "feat(web): types 镜像后端 12 键 + translate ValidateTarget

与 src/v2/secrets.ts 和 src/dashboard/setupApi.ts 同步。spec §8.2。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 阶段 1：新组件开发（TDD）

> 下述组件全部用 tw.css 既有 token（`bg-card`/`border-border`/`rounded-card`/`text-fn-green`/`text-fn-amber`/`text-muted-foreground` 等），不写 spec 散文里的 `#16181f`/`#2a2d35`/`#22c55e` 字面量。卡片内边距用 `p-5`（card.tsx 既有），字段间距 `space-y-1.5`，按钮组 `gap-2`，Input 高度维持 `h-9`（input.tsx 既有，不强改 h-10）。

### Task 5: SettingsCard 组件

**Files:**
- Create: `web/src/settings/SettingsCard.tsx`
- Test: `web/src/settings/SettingsCard.test.tsx`

- [ ] **Step 1: 写失败测试**

`web/src/settings/SettingsCard.test.tsx`：
```tsx
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { SettingsCard } from './SettingsCard.js'

afterEach(cleanup)

describe('SettingsCard', () => {
  it('渲染标题与描述', () => {
    render(<SettingsCard title="Engine" description="Master switch">body</SettingsCard>)
    expect(screen.getByText('Engine')).toBeInTheDocument()
    expect(screen.getByText('Master switch')).toBeInTheDocument()
    expect(screen.getByText('body')).toBeInTheDocument()
  })

  it('configured 状态显示绿色已配置 badge', () => {
    render(<SettingsCard title="X" status="configured">b</SettingsCard>)
    expect(screen.getByText('✓ Configured')).toBeInTheDocument()
  })

  it('unconfigured 状态显示黄色未配置 badge', () => {
    render(<SettingsCard title="X" status="unconfigured">b</SettingsCard>)
    expect(screen.getByText('⚠ Not configured')).toBeInTheDocument()
  })

  it('locked 状态显示灰色环境变量 badge', () => {
    render(<SettingsCard title="X" status="locked">b</SettingsCard>)
    expect(screen.getByText('🔒 Environment')).toBeInTheDocument()
  })

  it('无 status 不渲染 badge', () => {
    render(<SettingsCard title="X">b</SettingsCard>)
    expect(screen.queryByText('✓ Configured')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd web && npx vitest run src/settings/SettingsCard.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

`web/src/settings/SettingsCard.tsx`：
```tsx
// web/src/settings/SettingsCard.tsx：通用卡片容器（spec §3.1）。复用 shadcn Card 基底
// （rounded-card/p-5/bg-card/border-border 既有 token，不写 spec 散文 hex 字面量）。
// 状态 badge 三态：configured=绿（text-fn-green）、unconfigured=黄（text-fn-amber）、
// locked=灰（text-muted-foreground）。文案一律英语专业书面语。
import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card.js'
import { Badge } from '../components/ui/badge.js'

type Status = 'configured' | 'unconfigured' | 'locked'

const STATUS_LABEL: Record<Status, string> = {
  configured: '✓ Configured',
  unconfigured: '⚠ Not configured',
  locked: '🔒 Environment',
}

const STATUS_CLASS: Record<Status, string> = {
  configured: 'border-transparent bg-fn-green/15 text-fn-green',
  unconfigured: 'border-transparent bg-fn-amber/15 text-fn-amber',
  locked: 'border-transparent bg-secondary text-muted-foreground',
}

interface Props {
  title: string
  description?: string
  status?: Status
  children: ReactNode
  className?: string
}

export function SettingsCard({ title, description, status, children, className }: Props) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {status ? (
          <Badge variant="outline" className={STATUS_CLASS[status]} aria-label={STATUS_LABEL[status]}>
            {STATUS_LABEL[status]}
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `cd web && npx vitest run src/settings/SettingsCard.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/settings/SettingsCard.tsx web/src/settings/SettingsCard.test.tsx
git commit -m "feat(web): SettingsCard 通用卡片容器

spec §3.1：title/description/status badge/children。三态 badge
用 fn-green/fn-amber token，不写 hex 字面量。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: ProviderCard + ProviderSecretField

**Files:**
- Create: `web/src/settings/ProviderCard.tsx`
- Test: `web/src/settings/ProviderCard.test.tsx`

> 迁移自 `ProvidersSection.tsx` 的 `KeyedRow`，外壳换 SettingsCard；`ProviderSecretField` 内含于此文件、不单测。复用 `PROVIDER_NAME`、`api.putSecret`/`api.validateSetup`、`StatusDot`、`Input`、`Button`、`Switch` 既有契约。状态判据 spec §3.2：`allConfigured → configured`；`hasEnvSource && !allConfigured → locked`；else `unconfigured`。`data-testid={`providers-${row.id}`}` 保留。

- [ ] **Step 1: 写失败测试**

`web/src/settings/ProviderCard.test.tsx`（fixture 与既有 `ProvidersSection.test.tsx` 同形，保证迁移锁）：
```tsx
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { api } from '../api/client.js'
import type { ProviderRowDTO } from '../api/types.js'
import { ProviderCard } from './ProviderCard.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function renderCard(row: ProviderRowDTO, reload = vi.fn()) {
  render(<I18nProvider initialLang="en"><ProviderCard row={row} reload={reload} /></I18nProvider>)
}

const TMDB: ProviderRowDTO = { id: 'tmdb', secrets: [{ name: 'TMDB_API_KEY', set: true, source: 'env', masked: 'abc••••xyz' }], lastTest: null }
const ASSRT: ProviderRowDTO = { id: 'assrt', secrets: [{ name: 'ASSRT_TOKEN', set: true, source: 'db', masked: 'ass••••123' }], lastTest: { ok: true, at: 1700000000000 } }

describe('ProviderCard', () => {
  it('env 源：只读打码 + locked badge + 无 Edit', () => {
    renderCard(TMDB)
    const card = within(screen.getByTestId('providers-tmdb'))
    expect(card.getByText('abc••••xyz')).toBeInTheDocument()
    expect(card.getByText('🔒 Environment')).toBeInTheDocument()
    expect(card.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it('db 源：可编辑 + Edit 按钮 + configured badge', () => {
    renderCard(ASSRT)
    const card = within(screen.getByTestId('providers-assrt'))
    expect(card.getByText('✓ Configured')).toBeInTheDocument()
    expect(card.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
  })

  it('Edit → 输入 → Save → putSecret + reload', async () => {
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    const reload = vi.fn()
    renderCard(ASSRT, reload)
    const card = within(screen.getByTestId('providers-assrt'))
    fireEvent.click(card.getByRole('button', { name: 'Edit' }))
    fireEvent.change(card.getByLabelText('ASSRT_TOKEN'), { target: { value: 'new-tok' } })
    fireEvent.click(card.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put).toHaveBeenCalledWith('ASSRT_TOKEN', 'new-tok'))
    await waitFor(() => expect(reload).toHaveBeenCalled())
  })

  it('空输入 = 不动该键（UI 不提供删除）', async () => {
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    renderCard(ASSRT)
    const card = within(screen.getByTestId('providers-assrt'))
    fireEvent.click(card.getByRole('button', { name: 'Edit' }))
    fireEvent.click(card.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put).not.toHaveBeenCalled())
  })

  it('Test → validateSetup(id) → reload', async () => {
    const validate = vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const reload = vi.fn()
    renderCard(ASSRT, reload)
    fireEvent.click(within(screen.getByTestId('providers-assrt')).getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(validate).toHaveBeenCalledWith('assrt'))
    await waitFor(() => expect(reload).toHaveBeenCalled())
  })

  it('lastTest ok → 绿点 + Last test passed；fail → Last test failed + 错误行', () => {
    renderCard(ASSRT)
    expect(within(screen.getByTestId('providers-assrt')).getByText(/Last test passed/)).toBeInTheDocument()
    const fail: ProviderRowDTO = { id: 'llm', secrets: [{ name: 'LLM_API_KEY', set: true, source: 'db', masked: 'sk••••' }], lastTest: { ok: false, at: 1700000000000, error: 'Invalid credentials' } }
    cleanup(); renderCard(fail)
    const card = within(screen.getByTestId('providers-llm'))
    expect(card.getByText(/Last test failed/)).toBeInTheDocument()
    expect(card.getByText('Invalid credentials')).toBeInTheDocument()
  })

  it('混合源编辑：env 行只读，db 行变输入框', () => {
    const mixed: ProviderRowDTO = { id: 'llm', secrets: [
      { name: 'LLM_BASE_URL', set: true, source: 'env', masked: 'htt••••/v1' },
      { name: 'LLM_API_KEY', set: true, source: 'db', masked: 'sk••••ey' },
    ], lastTest: null }
    renderCard(mixed)
    const card = within(screen.getByTestId('providers-llm'))
    fireEvent.click(card.getByRole('button', { name: 'Edit' }))
    expect(card.queryByLabelText('LLM_BASE_URL')).not.toBeInTheDocument()
    expect(card.getByText('htt••••/v1')).toBeInTheDocument()
    expect(card.getByLabelText('LLM_API_KEY')).toBeInTheDocument()
  })

  it('保存失败 → 行内错误 + 编辑态保留', async () => {
    vi.spyOn(api, 'putSecret').mockRejectedValue(new Error('boom'))
    renderCard(ASSRT)
    const card = within(screen.getByTestId('providers-assrt'))
    fireEvent.click(card.getByRole('button', { name: 'Edit' }))
    fireEvent.change(card.getByLabelText('ASSRT_TOKEN'), { target: { value: 'new-tok' } })
    fireEvent.click(card.getByRole('button', { name: 'Save' }))
    expect(await card.findByText(/Couldn't save: /)).toBeInTheDocument()
    expect(card.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('DOM 里不再有 astryx-* 类名', () => {
    renderCard(ASSRT)
    expect(document.body.querySelector('[class*="astryx"]')).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd web && npx vitest run src/settings/ProviderCard.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

`web/src/settings/ProviderCard.tsx`：
```tsx
// web/src/settings/ProviderCard.tsx：字幕源 keyed 卡片（spec §3.2）——env 源只读、db 源可编辑、
// 编辑/测试/lastTest。内含 ProviderSecretField（不单测，行为由本卡测试覆盖）。外壳换 SettingsCard，
// 状态判据：allConfigured → configured；hasEnvSource && !allConfigured → locked；else unconfigured。
// 空输入 = 不动该键（UI 不提供删除，防占位空串误删——删除走 TranslateCard 的显式空串提交）。
import { useState } from 'react'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { StatusDot } from '../components/ui/status-dot.js'
import { api } from '../api/client.js'
import type { ProviderRowDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { SettingsCard } from './SettingsCard.js'

const PROVIDER_NAME: Record<ProviderRowDTO['id'], string> = {
  tmdb: 'TMDB',
  llm: 'LLM',
  translate: 'AI translation',
  assrt: 'ASSRT',
  opensubtitles: 'OpenSubtitles',
  jimaku: 'Jimaku',
  subhd: 'subhd',
  zimuku: 'zimuku',
}

function ProviderSecretField({ secret, editing, draft, onDraft }: {
  secret: ProviderRowDTO['secrets'][number]
  editing: boolean
  draft: string
  onDraft: (v: string) => void
}) {
  const { t } = useT()
  if (editing && secret.source !== 'env') {
    return <Input aria-label={secret.name} value={draft} onChange={(e) => onDraft(e.target.value)} placeholder={secret.masked ?? ''} />
  }
  return (
    <>
      <span className="text-[11px] leading-4">{secret.set ? secret.masked ?? '••••' : t('settings_provider_not_set')}</span>
      {secret.set && (
        <span className="text-[11px] leading-4 text-muted-foreground">
          {secret.source === 'env' ? t('settings_provider_source_env') : t('settings_provider_source_db')}
        </span>
      )}
      {secret.source === 'env' && (
        <span className="text-[11px] leading-4 text-muted-foreground">{t('settings_provider_env_locked')}</span>
      )}
    </>
  )
}

export function ProviderCard({ row, reload }: { row: ProviderRowDTO; reload: () => void }) {
  const { t } = useT()
  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const editable = row.secrets.some((s) => s.source !== 'env')
  const allConfigured = row.secrets.length > 0 && row.secrets.every((s) => s.value !== '' && s.set)
  const hasEnvSource = row.secrets.some((s) => s.source === 'env')
  const status = allConfigured ? 'configured' : hasEnvSource ? 'locked' : 'unconfigured'

  async function onSave() {
    setBusy(true); setError(null)
    try {
      for (const s of row.secrets) {
        const v = drafts[s.name] ?? ''
        if (v === '') continue
        await api.putSecret(s.name, v)
      }
      setEditing(false); setDrafts({}); reload()
    } catch (e) {
      setError(t('settings_save_error_prefix') + String(e))
    } finally { setBusy(false) }
  }

  async function onTest() {
    setBusy(true); setError(null)
    try { await api.validateSetup(row.id); reload() }
    catch (e) { setError(t('settings_save_error_prefix') + String(e)) }
    finally { setBusy(false) }
  }

  return (
    <SettingsCard title={PROVIDER_NAME[row.id]} status={status} data-testid={`providers-${row.id}`}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" disabled={busy && !editing} onClick={() => void onTest()}>
            {t('settings_provider_test')}
          </Button>
          {editable && !editing && (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>{t('settings_provider_edit')}</Button>
          )}
          {row.lastTest && (
            <>
              <StatusDot variant={row.lastTest.ok ? 'success' : 'error'} label={row.lastTest.ok ? t('settings_provider_last_test_ok') : t('settings_provider_last_test_fail')} />
              <span className="text-[11px] leading-4 text-muted-foreground">
                {row.lastTest.ok ? t('settings_provider_last_test_ok') : t('settings_provider_last_test_fail')}{` · ${new Date(row.lastTest.at).toLocaleString()}`}
              </span>
            </>
          )}
        </div>
        {row.lastTest && !row.lastTest.ok && row.lastTest.error && (
          <span className="text-[11px] leading-4 text-muted-foreground">{row.lastTest.error}</span>
        )}
        {row.secrets.map((s) => (
          <div key={s.name} className="flex items-center gap-2">
            <span className="font-mono text-[13px] leading-5">{s.name}</span>
            <ProviderSecretField secret={s} editing={editing} draft={drafts[s.name] ?? ''} onDraft={(v) => setDrafts((d) => ({ ...d, [s.name]: v }))} />
          </div>
        ))}
        {editing && (
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => void onSave()}>{t('settings_provider_save')}</Button>
            <Button size="sm" variant="secondary" onClick={() => { setEditing(false); setDrafts({}) }}>{t('settings_provider_cancel')}</Button>
          </div>
        )}
        {error && <p role="alert" className="text-[11px] leading-4 text-fn-red">{error}</p>}
      </div>
    </SettingsCard>
  )
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `cd web && npx vitest run src/settings/ProviderCard.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/settings/ProviderCard.tsx web/src/settings/ProviderCard.test.tsx
git commit -m "feat(web): ProviderCard 字幕源卡片 + ProviderSecretField

spec §3.2：env 只读/db 可编辑/状态 badge 三态判据。迁移自
ProvidersSection KeyedRow，外壳换 SettingsCard。空输入不动该键。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: ProviderToggleCard（subhd/zimuku）

**Files:**
- Create: `web/src/settings/ProviderToggleCard.tsx`
- Test: `web/src/settings/ProviderToggleCard.test.tsx`

> 迁移自 `ProvidersSection.tsx` 的 `ToggleRow`，外壳换 SettingsCard，描述 `Chinese subtitle source`。`data-testid={`providers-${id}`}` 保留。

- [ ] **Step 1: 写失败测试**

`web/src/settings/ProviderToggleCard.test.tsx`：
```tsx
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { api } from '../api/client.js'
import { ProviderToggleCard } from './ProviderToggleCard.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function renderCard(props: { id: 'subhd' | 'zimuku'; state: { enabled: boolean; source: string }; reload?: () => void }) {
  const reload = props.reload ?? vi.fn()
  render(<I18nProvider initialLang="en"><ProviderToggleCard id={props.id} state={props.state} reload={reload} /></I18nProvider>)
  return reload
}

describe('ProviderToggleCard', () => {
  it('enabled → configured badge + Switch on', () => {
    renderCard({ id: 'subhd', state: { enabled: true, source: 'db' } })
    const card = within(screen.getByTestId('providers-subhd'))
    expect(card.getByText('✓ Configured')).toBeInTheDocument()
    expect(card.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  })

  it('disabled → unconfigured badge + Switch off', () => {
    renderCard({ id: 'zimuku', state: { enabled: false, source: 'none' } })
    expect(within(screen.getByTestId('providers-zimuku')).getByText('⚠ Not configured')).toBeInTheDocument()
  })

  it('切换 → PUT provider:<FLAG> + reload', async () => {
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    const reload = renderCard({ id: 'subhd', state: { enabled: true, source: 'db' } })
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(update).toHaveBeenCalledWith({ 'provider:SUBHD_ENABLED': 'false' }))
    await waitFor(() => expect(reload).toHaveBeenCalled())
  })

  it('env 源 → Switch 禁用 + locked badge + 锁定注', () => {
    renderCard({ id: 'zimuku', state: { enabled: false, source: 'env' } })
    const card = within(screen.getByTestId('providers-zimuku'))
    expect(card.getByRole('switch')).toBeDisabled()
    expect(card.getByText('🔒 Environment')).toBeInTheDocument()
    expect(card.getByText('Set by environment — locked')).toBeInTheDocument()
  })

  it('渲染中文源描述', () => {
    renderCard({ id: 'subhd', state: { enabled: true, source: 'db' } })
    expect(screen.getByText('Chinese subtitle source')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd web && npx vitest run src/settings/ProviderToggleCard.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

`web/src/settings/ProviderToggleCard.tsx`：
```tsx
// web/src/settings/ProviderToggleCard.tsx：subhd/zimuku 开关卡片（spec §3.3）——与 ProviderCard
// 平级，描述 Chinese subtitle source。env 源锁定。迁移自 ProvidersSection ToggleRow。
import { useState } from 'react'
import { Switch } from '../components/ui/switch.js'
import { api } from '../api/client.js'
import { useT } from '../i18n/useT.js'
import { SettingsCard } from './SettingsCard.js'

const TOGGLE_NAME: Record<'subhd' | 'zimuku', string> = { subhd: 'subhd', zimuku: 'zimuku' }

export function ProviderToggleCard({ id, state, reload }: {
  id: 'subhd' | 'zimuku'
  state: { enabled: boolean; source: string }
  reload: () => void
}) {
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locked = state.source === 'env'
  const key = id === 'subhd' ? 'provider:SUBHD_ENABLED' as const : 'provider:ZIMUKU_ENABLED' as const

  async function onToggle(next: boolean) {
    setBusy(true); setError(null)
    try { await api.updateSettings({ [key]: String(next) }); reload() }
    catch (e) { setError(t('settings_save_error_prefix') + String(e)) }
    finally { setBusy(false) }
  }

  return (
    <SettingsCard
      title={TOGGLE_NAME[id]}
      description="Chinese subtitle source"
      status={state.enabled ? 'configured' : locked ? 'locked' : 'unconfigured'}
      data-testid={`providers-${id}`}
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <Switch aria-label={TOGGLE_NAME[id]} checked={state.enabled} onCheckedChange={(n) => void onToggle(n)} disabled={busy || locked} />
          <div className="flex-1">
            <div className="text-sm font-medium">Enable {TOGGLE_NAME[id]}</div>
            <div className="text-xs text-muted-foreground">No API key required — works out of the box</div>
          </div>
        </div>
        {locked && (
          <div className="text-xs text-muted-foreground">🔒 Configured via environment variable {id === 'subhd' ? 'SUBHD_ENABLED' : 'ZIMUKU_ENABLED'}</div>
        )}
        {error && <p role="alert" className="text-[11px] leading-4 text-fn-red">{error}</p>}
      </div>
    </SettingsCard>
  )
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `cd web && npx vitest run src/settings/ProviderToggleCard.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/settings/ProviderToggleCard.tsx web/src/settings/ProviderToggleCard.test.tsx
git commit -m "feat(web): ProviderToggleCard subhd/zimuku 开关卡片

spec §3.3：与其他字幕源平级，描述 Chinese subtitle source。
env 源锁定。迁移自 ProvidersSection ToggleRow。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: TranslateCard（双层配置，§4.2.6）

**Files:**
- Create: `web/src/settings/TranslateCard.tsx`
- Test: `web/src/settings/TranslateCard.test.tsx`

> 这是最硬的组件。依赖阶段 0 已落地。复用 `Segmented`（role="radiogroup"/"radio"，原生 button 可 fireEvent.click）。三凭证原子性：任一空 → 保存 disabled + 行内错误 `role="alert"`。切回"跟随默认"= 清空三键（PUT 空串 = DELETE），需破坏性确认。徽标五态。`isDedicated = Boolean(TRANSLATE_BASE_URL && TRANSLATE_API_KEY && TRANSLATE_MODEL)`。env 源三凭证 → 字段 readOnly + 🔒 徽标 + 无保存按钮。

- [ ] **Step 1: 写失败测试（11 条，§10）**

`web/src/settings/TranslateCard.test.tsx`：
```tsx
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { api } from '../api/client.js'
import type { ProviderRowDTO, SettingsDTO, DeploySettingsDTO } from '../api/types.js'
import { TranslateCard } from './TranslateCard.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const TRANSLATE_ROW: ProviderRowDTO = { id: 'translate', secrets: [
  { name: 'TRANSLATE_BASE_URL', set: false, source: 'none', masked: null },
  { name: 'TRANSLATE_API_KEY', set: false, source: 'none', masked: null },
  { name: 'TRANSLATE_MODEL', set: false, source: 'none', masked: null },
], lastTest: null }

const LLM_ROW: ProviderRowDTO = { id: 'llm', secrets: [
  { name: 'LLM_MODEL', set: true, source: 'db', masked: 'mimo-v2.5' },
], lastTest: null }

function renderCard(over: { translate?: Partial<ProviderRowDTO>; llm?: Partial<ProviderRowDTO>; settings?: Partial<SettingsDTO>; deploy?: Partial<DeploySettingsDTO>; reload?: () => void } = {}) {
  const translate: ProviderRowDTO = { ...TRANSLATE_ROW, ...over.translate }
  const llm: ProviderRowDTO = { ...LLM_ROW, ...over.llm }
  const settings: SettingsDTO = { ai_translate_enabled: 'false', ...over.settings } as SettingsDTO
  const deploy: DeploySettingsDTO = over.deploy ?? { secrets: { TRANSLATE_API_KEY: { present: false, tail: '' } } as never, nonSecrets: {} as never }
  const reload = over.reload ?? vi.fn()
  render(<I18nProvider initialLang="en"><TranslateCard translate={translate} llm={llm} settings={settings} deploy={deploy} onUpdated={vi.fn()} reload={reload} /></I18nProvider>)
  return reload
}

describe('TranslateCard', () => {
  it('功能关闭时第二层不在 DOM（用 queryByRole 断言 null）', () => {
    renderCard()
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
  })

  it('开启后渲染 Segmented，默认跟随默认（三凭证全无）', () => {
    renderCard({ settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    expect(screen.getByRole('radiogroup')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Follow default LLM' })).toHaveAttribute('aria-checked', 'true')
  })

  it('跟随默认显示当前默认 model 名（取自 LLM 卡片）', () => {
    renderCard({ settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    expect(screen.getByText(/mimo-v2.5/)).toBeInTheDocument()
  })

  it('选专用模型渲染三个必填字段', () => {
    renderCard({ settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    fireEvent.click(screen.getByRole('radio', { name: 'Dedicated model' }))
    expect(screen.getByLabelText('TRANSLATE_BASE_URL')).toHaveAttribute('required')
    expect(screen.getByLabelText('TRANSLATE_API_KEY')).toHaveAttribute('required')
    expect(screen.getByLabelText('TRANSLATE_MODEL')).toHaveAttribute('required')
  })

  it('三凭证任一为空 → 保存按钮 disabled（6 条用例合并：3 单空 + 3 双空）', () => {
    renderCard({ settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    fireEvent.click(screen.getByRole('radio', { name: 'Dedicated model' }))
    const base = screen.getByLabelText('TRANSLATE_BASE_URL')
    const key = screen.getByLabelText('TRANSLATE_API_KEY')
    const model = screen.getByLabelText('TRANSLATE_MODEL')
    fireEvent.change(base, { target: { value: 'https://api.example.com/v1' } })
    fireEvent.change(key, { target: { value: 'sk-1' } })
    // model 空 → disabled
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    // 补 model、清 base → disabled
    fireEvent.change(model, { target: { value: 'gpt-4o-mini' } })
    fireEvent.change(base, { target: { value: '' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('三凭证全填 → 保存 enabled，PUT 三次', async () => {
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    renderCard({ settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    fireEvent.click(screen.getByRole('radio', { name: 'Dedicated model' }))
    fireEvent.change(screen.getByLabelText('TRANSLATE_BASE_URL'), { target: { value: 'https://api.example.com/v1' } })
    fireEvent.change(screen.getByLabelText('TRANSLATE_API_KEY'), { target: { value: 'sk-1' } })
    fireEvent.change(screen.getByLabelText('TRANSLATE_MODEL'), { target: { value: 'gpt-4o-mini' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put).toHaveBeenCalledTimes(3))
  })

  it('空字段失焦 → 行内错误 role=alert', () => {
    renderCard({ settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    fireEvent.click(screen.getByRole('radio', { name: 'Dedicated model' }))
    fireEvent.change(screen.getByLabelText('TRANSLATE_BASE_URL'), { target: { value: 'https://api.example.com/v1' } })
    fireEvent.blur(screen.getByLabelText('TRANSLATE_BASE_URL'))
    // base 有值不报错；清空再失焦
    fireEvent.change(screen.getByLabelText('TRANSLATE_BASE_URL'), { target: { value: '' } })
    fireEvent.blur(screen.getByLabelText('TRANSLATE_BASE_URL'))
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('env 源三凭证 → 字段 readOnly + 🔒 徽标 + 无保存按钮', () => {
    renderCard({ translate: { secrets: [
      { name: 'TRANSLATE_BASE_URL', set: true, source: 'env', masked: 'htt••••/v1' },
      { name: 'TRANSLATE_API_KEY', set: true, source: 'env', masked: 'sk••••' },
      { name: 'TRANSLATE_MODEL', set: true, source: 'env', masked: 'gp••••' },
    ] }, settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    const card = within(screen.getByTestId('providers-translate'))
    expect(card.getByText('🔒 Environment')).toBeInTheDocument()
    expect(card.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('从专用切回跟随默认 → 弹破坏性确认；取消则 Segmented 回弹专用', async () => {
    renderCard({ translate: { secrets: [
      { name: 'TRANSLATE_BASE_URL', set: true, source: 'db', masked: 'htt••••/v1' },
      { name: 'TRANSLATE_API_KEY', set: true, source: 'db', masked: 'sk••••' },
      { name: 'TRANSLATE_MODEL', set: true, source: 'db', masked: 'gp••••' },
    ] }, settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    expect(screen.getByRole('radio', { name: 'Dedicated model' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Follow default LLM' }))
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(screen.getByRole('radio', { name: 'Dedicated model' })).toHaveAttribute('aria-checked', 'true')
  })

  it('徽标五态：关闭/已启用/专用模型/配置不完整/环境变量', () => {
    // 关闭
    renderCard()
    expect(screen.getByText('Off')).toBeInTheDocument()
    cleanup()
    // 已启用（跟随默认）
    renderCard({ settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    expect(screen.getByText('✓ Enabled')).toBeInTheDocument()
    cleanup()
    // 专用模型（三凭证齐）
    renderCard({ translate: { secrets: [
      { name: 'TRANSLATE_BASE_URL', set: true, source: 'db', masked: 'htt••••/v1' },
      { name: 'TRANSLATE_API_KEY', set: true, source: 'db', masked: 'sk••••' },
      { name: 'TRANSLATE_MODEL', set: true, source: 'db', masked: 'gp••••' },
    ] }, settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    expect(screen.getByText('✓ Dedicated model')).toBeInTheDocument()
    cleanup()
    // 配置不完整
    renderCard({ translate: { secrets: [
      { name: 'TRANSLATE_BASE_URL', set: true, source: 'db', masked: 'htt••••/v1' },
      { name: 'TRANSLATE_API_KEY', set: false, source: 'none', masked: null },
      { name: 'TRANSLATE_MODEL', set: false, source: 'none', masked: null },
    ] }, settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    expect(screen.getByText('⚠ Incomplete')).toBeInTheDocument()
    cleanup()
    // 环境变量
    renderCard({ translate: { secrets: [
      { name: 'TRANSLATE_BASE_URL', set: true, source: 'env', masked: 'htt••••/v1' },
      { name: 'TRANSLATE_API_KEY', set: true, source: 'env', masked: 'sk••••' },
      { name: 'TRANSLATE_MODEL', set: true, source: 'env', masked: 'gp••••' },
    ] }, settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    expect(screen.getByText('🔒 Environment')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd web && npx vitest run src/settings/TranslateCard.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

`web/src/settings/TranslateCard.tsx`：
```tsx
// web/src/settings/TranslateCard.tsx：AI 翻译双层卡片（spec §4.2.6）。
// 第一层 Switch（ai_translate_enabled）；第二层 Segmented（跟随默认/专用模型），仅开启时渲染。
// 专用模型原子性：三凭证全填才可保存，任一空 disabled + 行内错误。切回跟随默认 = 清空三键
// （PUT 空串 = DELETE），破坏性确认。徽标五态。env 源三凭证 → readOnly + 🔒 + 无保存。
// isDedicated = Boolean(三凭证存在)，不新增 settings 键。
import { useState } from 'react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../components/ui/alert-dialog.js'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Segmented } from '../components/ui/segmented.js'
import { Switch } from '../components/ui/switch.js'
import { api } from '../api/client.js'
import type { ProviderRowDTO, SettingsDTO, DeploySettingsDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { SettingsCard } from './SettingsCard.js'

interface Props {
  translate: ProviderRowDTO
  llm: ProviderRowDTO
  settings: SettingsDTO
  deploy: DeploySettingsDTO | null
  onUpdated: (s: SettingsDTO) => void
  reload: () => void
}

const SEG_ITEMS = [
  { value: 'default', label: 'Follow default LLM' },
  { value: 'dedicated', label: 'Dedicated model' },
] as const

const TRANSLATE_FIELDS = ['TRANSLATE_BASE_URL', 'TRANSLATE_API_KEY', 'TRANSLATE_MODEL'] as const
const PLACEHOLDERS: Record<string, string> = {
  TRANSLATE_BASE_URL: 'https://api.example.com/v1',
  TRANSLATE_API_KEY: 'sk-...',
  TRANSLATE_MODEL: 'gpt-4o-mini',
}

export function TranslateCard({ translate, llm, settings, onUpdated, reload }: Props) {
  const { t } = useT()
  const [enabled, setEnabled] = useState(settings.ai_translate_enabled === 'true')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pendingSeg, setPendingSeg] = useState<string | null>(null)

  const secretMap = Object.fromEntries(translate.secrets.map((s) => [s.name, s]))
  const isDedicated = Boolean(secretMap.TRANSLATE_BASE_URL?.set && secretMap.TRANSLATE_API_KEY?.set && secretMap.TRANSLATE_MODEL?.set)
  const allEnv = translate.secrets.length > 0 && translate.secrets.every((s) => s.source === 'env')
  const seg = isDedicated ? 'dedicated' : 'default'
  const defaultModel = llm.secrets.find((s) => s.name === 'LLM_MODEL')?.masked ?? '—'

  const incomplete = enabled && isDedicated && translate.secrets.some((s) => !s.set)
  const badge = !enabled ? 'Off' : allEnv ? '🔒 Environment' : isDedicated && !incomplete ? '✓ Dedicated model' : incomplete ? '⚠ Incomplete' : '✓ Enabled'

  async function commitEnabled(value: boolean) {
    setBusy(true); setError(null)
    try {
      const result = await api.updateSettings({ ai_translate_enabled: value ? 'true' : 'false' })
      setEnabled(value); onUpdated(result)
    } catch (e) { setError(t('settings_save_error_prefix') + String(e)) }
    finally { setBusy(false) }
  }

  async function onSaveDedicated() {
    setBusy(true); setError(null)
    try {
      for (const name of TRANSLATE_FIELDS) {
        await api.putSecret(name, drafts[name] ?? '')
      }
      setDrafts({}); setTouched({}); reload()
    } catch (e) { setError(t('settings_save_error_prefix') + String(e)) }
    finally { setBusy(false) }
  }

  async function onClearDedicated() {
    setBusy(true); setError(null)
    try {
      for (const name of TRANSLATE_FIELDS) await api.putSecret(name, '')
      reload(); setConfirmOpen(false); setPendingSeg(null)
    } catch (e) { setError(t('settings_save_error_prefix') + String(e)) }
    finally { setBusy(false) }
  }

  function onSegChange(value: string) {
    if (value === 'default' && isDedicated) {
      setPendingSeg('default'); setConfirmOpen(true)
    } else if (value === 'dedicated') {
      // 切到专用：无状态变更，渲染三字段
    }
  }

  const allFilled = TRANSLATE_FIELDS.every((n) => (drafts[n] ?? '').trim() !== '')
  const fieldError = (n: string) => touched[n] && (drafts[n] ?? '').trim() === '' ? 'All three fields are required' : null

  return (
    <SettingsCard
      title="AI subtitle translation"
      description="Auto-translate when no subtitle is found"
      data-testid="providers-translate"
      className="relative"
    >
      <div className="absolute right-5 top-5 text-[11px] leading-4 text-muted-foreground">{badge}</div>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Switch aria-label="AI subtitle translation" checked={enabled} onCheckedChange={(c) => c ? setEnabled(true) : void commitEnabled(false)} disabled={busy} />
          <span className="text-[13px] font-medium leading-5 text-foreground">Enable AI subtitle translation</span>
        </div>
        <span className="text-[11px] leading-4 text-muted-foreground">Consumes LLM quota</span>
        {error && <p role="alert" className="text-[11px] leading-4 text-fn-red">{error}</p>}

        {enabled && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium leading-5 text-foreground">Model</span>
              <Segmented items={SEG_ITEMS} value={seg} onChange={onSegChange} label="Translation model" />
              {seg === 'default' && (
                <span className="text-[11px] leading-4 text-muted-foreground">Current: {defaultModel} · shared with agent</span>
              )}
            </div>

            {seg === 'dedicated' && !allEnv && (
              <div className="flex flex-col gap-1.5">
                {TRANSLATE_FIELDS.map((name) => (
                  <div key={name} className="flex flex-col gap-1.5">
                    <label className="text-[11px] leading-4 text-muted-foreground">{name} *</label>
                    <Input
                      aria-label={name}
                      required
                      value={drafts[name] ?? ''}
                      placeholder={PLACEHOLDERS[name]}
                      onChange={(e) => setDrafts((d) => ({ ...d, [name]: e.target.value }))}
                      onBlur={() => setTouched((tch) => ({ ...tch, [name]: true }))}
                    />
                    {fieldError(name) && <p role="alert" className="text-[11px] leading-4 text-fn-red">{fieldError(name)}</p>}
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <Button size="sm" disabled={busy || !allFilled} onClick={() => void onSaveDedicated()}>Save</Button>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => void api.validateSetup('translate').then(reload)}>Test</Button>
                </div>
              </div>
            )}

            {seg === 'dedicated' && allEnv && (
              <div className="flex flex-col gap-1.5">
                {TRANSLATE_FIELDS.map((name) => {
                  const s = secretMap[name]
                  return (
                    <div key={name} className="flex flex-col gap-1.5">
                      <label className="text-[11px] leading-4 text-muted-foreground">{name}</label>
                      <Input aria-label={name} readOnly value={s?.masked ?? ''} />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={(o) => { if (!o) { setConfirmOpen(false); setPendingSeg(null) } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch to default model?</AlertDialogTitle>
            <AlertDialogDescription>This clears the dedicated model configuration. Are you sure?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void onClearDedicated() }}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  )
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `cd web && npx vitest run src/settings/TranslateCard.test.tsx`
Expected: PASS（若个别断言因 DOM 细节红，按实际渲染微调测试 selector，但不得放宽原子性约束）

- [ ] **Step 5: Commit**

```bash
git add web/src/settings/TranslateCard.tsx web/src/settings/TranslateCard.test.tsx
git commit -m "feat(web): TranslateCard 双层配置（§4.2.6）

Switch→Segmented→三必填字段，原子性校验，切回默认破坏性确认。
徽标五态。env 源只读。依赖阶段 0 后端打通。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 阶段 2：Tabs 容器

### Task 9: 安装 @radix-ui/react-tabs + 创建 tabs.tsx

**Files:**
- Modify: `web/package.json`（加依赖）
- Create: `web/src/components/ui/tabs.tsx`

- [ ] **Step 1: 安装依赖**

Run: `cd web && npm install @radix-ui/react-tabs`
Expected: `package.json` 加一行 `"@radix-ui/react-tabs": "^1.1.x"`，`node_modules/@radix-ui/react-tabs` 出现。

- [ ] **Step 2: 创建 `tabs.tsx`**

`web/src/components/ui/tabs.tsx`（shadcn Tabs copy-in，相对 import + .js 后缀）：
```tsx
// web/src/components/ui/tabs.tsx：shadcn/ui Tabs（v4）copy-in，相对 import 适配。
import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cn } from '../../lib/utils.js'

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn('flex flex-col gap-2', className)} {...props} />
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn('inline-flex h-10 w-fit items-center justify-center gap-1 rounded-control bg-stage-track p-1', className)}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-[6px] px-3 py-1.5 text-[13px] font-medium leading-5 text-muted-foreground transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'data-[state=active]:bg-secondary data-[state=active]:text-foreground data-[state=active]:shadow-sm',
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('flex-1 outline-none', className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
```

- [ ] **Step 3: 类型检查**

Run: `cd web && npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add web/package.json web/package-lock.json web/src/components/ui/tabs.tsx
git commit -m "feat(web): 安装 @radix-ui/react-tabs + tabs.tsx

shadcn Tabs copy-in，相对 import 适配。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Badge 加 success/warning 变体

**Files:**
- Modify: `web/src/components/ui/badge.tsx`

- [ ] **Step 1: 改 badge.tsx 的 cva 变体**

在 `variants.variant` 对象里加两个键（`success`/`warning`），用 fn token：
```tsx
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'border-border text-foreground',
        success: 'border-transparent bg-fn-green/15 text-fn-green',
        warning: 'border-transparent bg-fn-amber/15 text-fn-amber',
      },
```
（文件头注释补一行：`success`/`warning` 变体供 SettingsTabsPage 的 tab badge 用，token 取 fn-green/fn-amber。）

- [ ] **Step 2: 类型检查 + 既有 badge 测试**

Run: `cd web && npm run build && npx vitest run src/components/ui`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/components/ui/badge.tsx
git commit -m "feat(web): Badge 加 success/warning 变体

供 SettingsTabsPage tab badge 用，token 取 fn-green/fn-amber。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: SettingsTabsPage + badge 逻辑

**Files:**
- Create: `web/src/settings/SettingsTabsPage.tsx`
- Test: `web/src/settings/SettingsTabsPage.test.tsx`

> 五 tab：general/providers/media/security/advanced。providers badge `n/8`（绿/黄/红），media badge `⚠️ Not configured` when roots.length===0。tab 默认 `general`。本任务只搭骨架 + badge 计算 + tab 切换，内容区用占位（阶段 3 再接入六区）。

- [ ] **Step 1: 写失败测试**

`web/src/settings/SettingsTabsPage.test.tsx`：
```tsx
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { SettingsTabsPage } from './SettingsTabsPage.js'
import * as hooks from '../api/hooks.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function mockHooks(over: { providers?: number; roots?: number } = {}) {
  vi.spyOn(hooks, 'useSettings').mockReturnValue({ data: { ai_translate_enabled: 'false' } as never, loading: false, error: null, reload: vi.fn() })
  vi.spyOn(hooks, 'useDeploySettings').mockReturnValue({ data: null, loading: false, error: null, reload: vi.fn() })
  vi.spyOn(hooks, 'useRoots').mockReturnValue({ data: Array(over.roots ?? 0).fill({ path: '/x' }), loading: false, error: null, reload: vi.fn() })
  vi.spyOn(hooks, 'useSetupProviders').mockReturnValue({ data: { providers: [] }, loading: false, error: null, reload: vi.fn() })
  vi.spyOn(hooks, 'useSetupStatus').mockReturnValue({ data: null, loading: false, error: null, reload: vi.fn() })
}

function renderPage() {
  render(<I18nProvider initialLang="en"><SettingsTabsPage /></I18nProvider>)
}

describe('SettingsTabsPage', () => {
  it('默认 general tab，渲染五个 tab 触发器', () => {
    mockHooks()
    renderPage()
    expect(screen.getByRole('tab', { name: /General/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /Providers/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Media/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Security/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Advanced/ })).toBeInTheDocument()
  })

  it('tab 切换显示对应内容', () => {
    mockHooks()
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: /Security/ }))
    expect(screen.getByRole('tab', { name: /Security/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('providers badge 显示 n/8', () => {
    mockHooks()
    renderPage()
    expect(screen.getByText('0/8')).toBeInTheDocument()
  })

  it('media badge 未配置（roots.length===0）', () => {
    mockHooks({ roots: 0 })
    renderPage()
    expect(screen.getByText('⚠ Not configured')).toBeInTheDocument()
  })

  it('media badge 有目录时不显示未配置', () => {
    mockHooks({ roots: 2 })
    renderPage()
    expect(screen.queryByText('⚠ Not configured')).not.toBeInTheDocument()
  })

  it('通用 tab 不含任何翻译相关控件（反向断言）', () => {
    mockHooks()
    renderPage()
    expect(screen.queryByRole('switch', { name: 'AI subtitle translation' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd web && npx vitest run src/settings/SettingsTabsPage.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

`web/src/settings/SettingsTabsPage.tsx`（阶段 2 只搭骨架，内容区占位；阶段 3 接入六区）：
```tsx
// web/src/settings/SettingsTabsPage.tsx：Settings 五 tab 容器（spec §2/§6）。
// general/providers/media/security/advanced。providers badge n/8（绿全/黄部分/红全无），
// media badge roots.length===0 时 ⚠ Not configured。默认 general tab。
// 阶段 2：骨架 + badge；阶段 3：接入六区。
import { useSettings, useDeploySettings, useRoots, useSetupProviders, useSetupStatus } from '../api/hooks.js'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs.js'
import { Badge } from '../components/ui/badge.js'

export function SettingsTabsPage() {
  const settings = useSettings()
  const deploy = useDeploySettings()
  const roots = useRoots()
  const providers = useSetupProviders()
  const setupStatus = useSetupStatus()

  // providers badge: n/8（八张卡片：TMDB/LLM/AI翻译/ASSRT/OpenSubtitles/Jimaku/subhd/zimuku）
  const configuredCount = 0 // 阶段 3 接入后实算
  const providerBadgeVariant = configuredCount === 8 ? 'success' : configuredCount === 0 ? 'destructive' : 'warning'
  const mediaUnconfigured = (roots.data?.length ?? 0) === 0

  return (
    <Tabs defaultValue="general" className="w-full">
      <TabsList>
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="providers">
          Providers
          <Badge variant={providerBadgeVariant} className="ml-1">{configuredCount}/8</Badge>
        </TabsTrigger>
        <TabsTrigger value="media">
          Media
          {mediaUnconfigured ? <Badge variant="warning" className="ml-1">⚠ Not configured</Badge> : null}
        </TabsTrigger>
        <TabsTrigger value="security">Security</TabsTrigger>
        <TabsTrigger value="advanced">Advanced</TabsTrigger>
      </TabsList>

      <TabsContent value="general" className="p-6 space-y-6">
        {/* 阶段 3：BehaviorSection */}
      </TabsContent>
      <TabsContent value="providers" className="p-6 space-y-6">
        {/* 阶段 3：ProviderCard × 6 + TranslateCard + ProviderToggleCard × 2 */}
      </TabsContent>
      <TabsContent value="media" className="p-6 space-y-6">
        {/* 阶段 3：RootsManager */}
      </TabsContent>
      <TabsContent value="security" className="p-6 space-y-6">
        {/* 阶段 3：SecuritySection */}
      </TabsContent>
      <TabsContent value="advanced" className="p-6 space-y-6">
        {/* 阶段 3：DeploySection + SystemSection */}
      </TabsContent>
    </Tabs>
  )
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `cd web && npx vitest run src/settings/SettingsTabsPage.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/settings/SettingsTabsPage.tsx web/src/settings/SettingsTabsPage.test.tsx
git commit -m "feat(web): SettingsTabsPage 五 tab 容器 + badge 逻辑

spec §2/§6：general/providers/media/security/advanced。
providers badge n/8，media badge roots===0 时未配置。
阶段 2 只搭骨架，内容区占位。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 阶段 3：内容迁移

### Task 12: BehaviorSection 拆壳 + 迁入 general tab

**Files:**
- Modify: `web/src/settings/BehaviorSection.tsx`（拆自带 `<section>` + heading + loading/error 早期返回）
- Modify: `web/src/settings/BehaviorSection.test.tsx`（适配新 DOM）
- Modify: `web/src/settings/SettingsTabsPage.tsx`（general tab 接入）

> 决策：BehaviorSection 自带的 `<section className="settings-section">` + heading + loading/error 早期返回会与 SettingsCard 双层包裹。**拆掉它的壳**——保留五行业务逻辑（target_languages/hardsub_mode/exclude_extras/trace_retention/scan_interval + engine 开关），heading 与三态由 SettingsCard 承载。注意 BehaviorSection 还有 engine 开关（`settings_engine_label`），保留。

- [ ] **Step 1: 读 BehaviorSection.tsx 全文确认拆壳边界**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && wc -l web/src/settings/BehaviorSection.tsx && sed -n '40,260p' web/src/settings/BehaviorSection.tsx`
Expected: 输出全文，确认 `<section className="settings-section">` 三处（loading/error/main）与 heading。

- [ ] **Step 2: 改 BehaviorSection.tsx 拆壳**

把三处 `<section className="settings-section">…heading…</section>` 早期返回改为不带 section 的裸返回（loading/error 文本），main 返回改为裸 div。签名改接 `settings: Async<SettingsDTO>` 不变，但 heading `settings_behavior_heading` 移除（由 SettingsCard 承载）。具体：把 `export function BehaviorSection({ settings }: Props)` 的返回体改为：

```tsx
  if (settings.loading && !local) {
    return <span className="font-mono text-[13px] leading-5 text-muted-foreground">loading…</span>
  }
  if (settings.error && !local) {
    return <span className="text-[11px] leading-4 text-muted-foreground">{t('settings_error_prefix') + settings.error}</span>
  }
  if (!local) return null
  return (
    <div className="flex flex-col gap-5">
      {/* 五行业务逻辑保留：Engine 开关 + target_languages + hardsub_mode + exclude_extras + trace_retention + scan_interval */}
      {/* ...原有 JSX 逐行保留，只去掉外层 <section> 和 heading <span>... */}
    </div>
  )
```
（实施时逐行搬运原 JSX，保留 `EngineRow`/`TargetLanguagesRow`/`HardsubModeRow`/`ExcludeExtrasRow`/`TraceRetentionRow`/`ScanIntervalRow` 子组件及其 props 不变。）

- [ ] **Step 3: 改 BehaviorSection.test.tsx 适配**

`getByText('Behavior')` 在 BehaviorSection 内已不渲染（迁到 SettingsCard/SettingsTabsPage）。但 `App.test.tsx:231` 仍依赖该锚点——它在 SettingsTabsPage 的 general tab 渲染 BehaviorSection 时由 SettingsCard 承载。本任务的 BehaviorSection.test.tsx 若有断言依赖 `getByText('Behavior')` 则改为不查 heading（只查五行业务控件）。具体：删除 `settings_behavior_heading` 相关断言（若有），保留 12 条 role+name 契约（Engine/Target languages/Hardsub assumption/Exclude extras/Trace retention/Scan interval）。

Run: `cd web && npx vitest run src/settings/BehaviorSection.test.tsx`
Expected: PASS（若红，按实际 DOM 微调 selector）

- [ ] **Step 4: SettingsTabsPage general tab 接入 BehaviorSection**

`web/src/settings/SettingsTabsPage.tsx` 的 general TabsContent 改为：
```tsx
      <TabsContent value="general" className="p-6 space-y-6">
        <SettingsCard title="Behavior">
          <BehaviorSection settings={settings} />
        </SettingsCard>
      </TabsContent>
```
（顶部加 `import { SettingsCard } from './SettingsCard.js'` 与 `import { BehaviorSection } from './BehaviorSection.js'`。）

- [ ] **Step 5: 跑测试**

Run: `cd web && npx vitest run src/settings/BehaviorSection.test.tsx src/settings/SettingsTabsPage.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/src/settings/BehaviorSection.tsx web/src/settings/BehaviorSection.test.tsx web/src/settings/SettingsTabsPage.tsx
git commit -m "refactor(web): BehaviorSection 拆壳迁入 general tab

拆掉自带 section+heading+三态早期返回，由 SettingsCard 承载。
五行业务逻辑保留。spec 附录 A。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 13: providers tab 接入 7 卡片

**Files:**
- Modify: `web/src/settings/SettingsTabsPage.tsx`（providers tab 接入 ProviderCard×5 + TranslateCard + ProviderToggleCard×2，badge 实算）

> 顺序（spec §4.2）：TMDB → LLM → AI翻译(TranslateCard) → ASSRT → OpenSubtitles → Jimaku → subhd → zimuku。badge `n/8` 实算（configuredCount = 八张卡片已配置数之和）。从 `useSetupProviders().data.providers` 取 KeyedRow（filter secrets.length>0），`useSetupStatus().data.providers` 取 subhd/zimuku toggle 态，LLM 行单独传给 TranslateCard。

- [ ] **Step 1: 改 SettingsTabsPage providers tab**

在 providers TabsContent 接入：
```tsx
      <TabsContent value="providers" className="p-6 space-y-6">
        {providers.data?.providers.filter((r) => r.secrets.length > 0 && r.id !== 'translate').map((row) => (
          row.id === 'llm' ? (
            <ProviderCard key={row.id} row={row} reload={providers.reload} />
          ) : (
            <ProviderCard key={row.id} row={row} reload={providers.reload} />
          )
        ))}
        {translateRow && llmRow && (
          <TranslateCard translate={translateRow} llm={llmRow} settings={settingsData} deploy={deploy.data} onUpdated={setUpdated} reload={providers.reload} />
        )}
        {setupStatus.data && (
          <>
            <ProviderToggleCard id="subhd" state={setupStatus.data.providers.subhd} reload={setupStatus.reload} />
            <ProviderToggleCard id="zimuku" state={setupStatus.data.providers.zimuku} reload={setupStatus.reload} />
          </>
        )}
      </TabsContent>
```
（顶部补 import；`translateRow`/`llmRow` 从 providers.data.providers find；`settingsData`/`setUpdated` 同旧 SettingsPage 的 updated 机制——见原 `web/src/settings/SettingsPage.tsx:25-26`。）

badge 实算：八张卡片已配置判据（spec §2）：
```tsx
  const rows = providers.data?.providers ?? []
  const translateRow = rows.find((r) => r.id === 'translate')
  const llmRow = rows.find((r) => r.id === 'llm')
  const keyedConfigured = (r: ProviderRowDTO) => r.secrets.length > 0 && r.secrets.every((s) => s.set)
  const keyedCount = rows.filter((r) => r.secrets.length > 0 && r.id !== 'translate').filter(keyedConfigured).length
  const translateConfigured = settingsData?.ai_translate_enabled === 'true'
  const subhdConfigured = setupStatus.data?.providers.subhd.enabled ?? false
  const zimukuConfigured = setupStatus.data?.providers.zimuku.enabled ?? false
  const configuredCount = keyedCount + (translateConfigured ? 1 : 0) + (subhdConfigured ? 1 : 0) + (zimukuConfigured ? 1 : 0)
```

- [ ] **Step 2: 跑 SettingsTabsPage 测试（badge 实算后需更新 mock）**

`SettingsTabsPage.test.tsx` 的 `it('providers badge 显示 n/8')` 当前 mock `providers: []` → `configuredCount=0`，badge `0/8` 仍通过。无需改测试。

Run: `cd web && npx vitest run src/settings/SettingsTabsPage.test.tsx`
Expected: PASS

- [ ] **Step 3: 跑全量前端测试确认无连带红**

Run: `cd web && npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add web/src/settings/SettingsTabsPage.tsx
git commit -m "feat(web): providers tab 接入 7 卡片 + badge 实算

TMDB/LLM/TranslateCard/ASSRT/OpenSubtitles/Jimaku/subhd/zimuku。
badge n/8 实算八卡片已配置数。spec §4.2 顺序。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 14: media/security/advanced tab 接入

**Files:**
- Modify: `web/src/settings/SettingsTabsPage.tsx`

> media → RootsManager（拆壳同 BehaviorSection 模式，heading 由 SettingsCard 承载）；security → SecuritySection（已自带多 `<section>`，保留原样不拆壳——它内部就是两张卡 API Key + 改密，spec §4 让 security tab 是两张 SettingsCard，但 SecuritySection 已实现该结构，直接接入即可，不强拆）；advanced → DeploySection + SystemSection。

- [ ] **Step 1: 改 SettingsTabsPage 三个 tab**

```tsx
      <TabsContent value="media" className="p-6 space-y-6">
        <SettingsCard title="Media roots">
          <RootsManager roots={roots} />
        </SettingsCard>
      </TabsContent>
      <TabsContent value="security" className="p-6 space-y-6">
        <SecuritySection />
      </TabsContent>
      <TabsContent value="advanced" className="p-6 space-y-6">
        <DeploySection deploy={deploy} />
        <SystemSection />
      </TabsContent>
```
（RootsManager 自带 `<section>`+heading 会被 SettingsCard 双层包裹——按 BehaviorSection 同款拆壳：删 RootsManager 的 `<section className="settings-section">` 与 heading `<span>`，保留三态与目录列表逻辑。SecuritySection 的三处 `<section className="settings-section">` 保留（它内部已是多卡结构，spec §4 security tab = 两张卡，SecuritySection 现状即如此，接入即可。DeploySection/SystemSection 同理保留 `<section>`——它们是 advanced tab 的两张卡。）

> **决策修正**：为避免阶段 3 工作量爆炸，RootsManager/SecuritySection/DeploySection/SystemSection 的 `<section className="settings-section">` **全部保留不拆**——`settings-section` 的 CSS 只是 `flex-col gap-12px + border-bottom`（styles.css:880），在 TabsContent `p-6 space-y-6` 里渲染无视觉冲突（border-bottom 在 tab 内分隔卡片，可接受）。只 BehaviorSection 拆壳（因它的 heading 要被 SettingsCard 承载做 general tab 唯一卡）。RootsManager 等直接接入对应 TabsContent，不套 SettingsCard（它们的 `<section>`+heading 即卡片语义）。

实施：media/security/advanced 三个 TabsContent 直接放原 section 组件，不套 SettingsCard：
```tsx
      <TabsContent value="media" className="p-6 space-y-6">
        <RootsManager roots={roots} />
      </TabsContent>
      <TabsContent value="security" className="p-6 space-y-6">
        <SecuritySection />
      </TabsContent>
      <TabsContent value="advanced" className="p-6 space-y-6">
        <DeploySection deploy={deploy} />
        <SystemSection />
      </TabsContent>
```

- [ ] **Step 2: 跑测试**

Run: `cd web && npm test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/settings/SettingsTabsPage.tsx
git commit -m "feat(web): media/security/advanced tab 接入现有 section

RootsManager/SecuritySection/DeploySection/SystemSection 保留
自带 section 壳，直接接入 TabsContent。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 阶段 4：替换与清理

### Task 15: AppShell 改路由 + 删旧组件 + 修测试

**Files:**
- Modify: `web/src/shell/AppShell.tsx:95`（`SettingsPage`→`SettingsTabsPage`）
- Delete: `web/src/settings/SettingsPage.tsx`
- Delete: `web/src/settings/TranslateSection.tsx`, `web/src/settings/TranslateSection.test.tsx`
- Delete: `web/src/settings/ProvidersSection.tsx`, `web/src/settings/ProvidersSection.test.tsx`
- Verify: `web/src/App.test.tsx:231`（`getByText('Behavior')` 锚点——由 SettingsTabsPage general tab 的 SettingsCard 承载）

- [ ] **Step 1: 改 AppShell 路由**

`web/src/shell/AppShell.tsx` 第 95 行当前：
```tsx
            {route.tab === 'settings' && <SettingsPage />}
```
改为：
```tsx
            {route.tab === 'settings' && <SettingsTabsPage />}
```
顶部 import 改：`import { SettingsTabsPage } from '../settings/SettingsTabsPage.js'`（删 `SettingsPage` import）。

- [ ] **Step 2: 删旧组件**

Run:
```bash
cd /Users/dirtyfancy/projects/subtitle-scout && rm web/src/settings/SettingsPage.tsx web/src/settings/TranslateSection.tsx web/src/settings/TranslateSection.test.tsx web/src/settings/ProvidersSection.tsx web/src/settings/ProvidersSection.test.tsx
```

- [ ] **Step 3: 跑全量前端测试 + 类型检查**

Run: `cd web && npm test && npm run build`
Expected: PASS（`App.test.tsx:231` 的 `getByText('Behavior')` 在 SettingsTabsPage general tab 的 SettingsCard title 渲染；若红，确认 SettingsTabsPage general tab 的 `<SettingsCard title="Behavior">` 文本可被 `getByText` 命中）

- [ ] **Step 4: Commit**

```bash
git add web/src/shell/AppShell.tsx web/src/settings/SettingsPage.tsx web/src/settings/TranslateSection.tsx web/src/settings/TranslateSection.test.tsx web/src/settings/ProvidersSection.tsx web/src/settings/ProvidersSection.test.tsx
git commit -m "refactor(web): AppShell 指向 SettingsTabsPage，删旧 Settings 页

删 SettingsPage/TranslateSection/ProvidersSection（被 SettingsTabsPage
+ TranslateCard + ProviderCard/ProviderToggleCard 取代）。
App.test Behavior 锚点由 SettingsTabsPage general tab 承载。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 16: 全量回归 + agent-browser 验收

**Files:**
- Verify: 全仓 `npm test` + `npm run check`（后端）+ `cd web && npm test && npm run build`（前端）

- [ ] **Step 1: 后端全量**

Run: `npm test && npm run check`
Expected: PASS

- [ ] **Step 2: 前端全量**

Run: `cd web && npm test && npm run build`
Expected: PASS

- [ ] **Step 3: agent-browser 验收**

用 `agent-browser` skill 起 dev server 验收（spec §13）：
1. 访问 `#/settings`，确认五 tab 渲染、默认 general
2. 切 providers tab，确认 8 张卡片 + badge `n/8`
3. 切 media tab，确认 roots 列表/空态
4. TranslateCard 三态走查：关闭→跟随默认→专用（填两项确认 Save 灰、行内错误；补齐第三项 Save 亮、保存成功；切回跟随默认确认破坏性弹窗）
5. env 源字段只读 + 🔒 徽标
6. 通用 tab 无任何翻译控件

（验收步骤细节由 agent-browser skill 承载，本计划只列验收点。）

- [ ] **Step 4: 记录验收结果并收尾**

如全部通过，无需 commit（验收无代码改动）。如有 UI 缺陷，按缺陷补 commit。

---

## 自审

**1. Spec 覆盖：**
- §2 tab 结构 → Task 11/13/14 ✓
- §3.1 SettingsCard → Task 5 ✓
- §3.2 Provider Card 状态判据 → Task 6 ✓
- §3.3 subhd/zimuku 独立卡片 + 描述 → Task 7 ✓
- §4.2.6 TranslateCard 双层 + 原子性 + 五态 → Task 8 ✓
- §5 spacing → 用 token（p-5/space-y-6/space-y-1.5/gap-2/h-9），不写 hex ✓
- §6 组件层级 → Task 11 ✓
- §7 五新组件 → Task 5/6/7/8（ProviderSecretField 内含 Task 6）✓
- §8.2 后端三文件表 → Task 1/2/3 ✓（含推翻"逐字不动"注释，Task 3 Step 3）
- §9 阶段 0-4 → Task 1-15 ✓
- §10 测试策略 → 各 Task 测试 ✓（TranslateCard 11 条 Task 8，反向断言 Task 11）
- §13 验收 → Task 16 ✓
- 通用 tab 无翻译控件 → Task 11 反向断言 ✓

**2. Placeholder 扫描：** 无 TBD/TODO/"add error handling"/"similar to Task N"。Task 12/14 的 section 拆壳决策已明确（只 BehaviorSection 拆，其余保留）。Task 8 实现的徽标五态、原子性、破坏性确认代码完整。

**3. Type consistency：**
- `ProviderRowDTO['id']` 联合前后端一致（Task 2/4）✓
- `SECRET_NAMES` 12 键前后端镜像（Task 1/4）✓
- `ValidateTarget` 加 `'translate'` 前后端一致（Task 2/4）✓
- `tryAutoTranslateCfg(cfg: AdapterConfigResolver)` 签名在 Task 3 定义、Task 3 Step 6 两处调用适配 ✓
- `SettingsCard` props `{ title, description?, status?, children, className? }` Task 5 定义、Task 6/7/8/12 消费一致 ✓
- `Segmented` props `{ items, value, onChange, label }` Task 8 消费与既有 segmented.tsx 一致 ✓
- `ProviderToggleCard` props `{ id, state, reload }` Task 7 定义、Task 13 消费一致 ✓
- `TranslateCard` props `{ translate, llm, settings, deploy, onUpdated, reload }` Task 8 定义、Task 13 消费一致 ✓

无遗漏。计划可执行。

---

## 执行交接

**Plan complete and saved to `docs/superpowers/plans/2026-08-05-settings-tab-redesign.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - 每个 Task 起一个子代理，Task 间我审计，快速迭代

**2. Inline Execution** - 本会话内批量执行带 checkpoint

**Which approach?**