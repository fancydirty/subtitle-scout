// src/v2/secrets.test.ts：spec A §4.1/§4.2 解析优先级、打码、provider flag 语义的纯函数契约。
import { describe, it, expect } from 'vitest'
import {
  SECRET_NAMES, isSecretName, maskSecretValue,
  resolveProviderFlag, makeAdapterConfigResolver, envOnlyAdapterConfig,
} from './secrets.js'

describe('SECRET_NAMES 白名单（spec §4.1）', () => {
  // 数字的沿革（每次改这里都要把上一档留着，否则下一个人会以为"12"是凭空来的）：
  //   9  → spec §4.1 的枚举原文（散文写"10 个名字"但只列了 9 个，**以枚举为准**，是 spec 笔误）
  //   12 → 29651cd 加 TRANSLATE_* 三凭证（spec §8.2）
  //   15 → c582571 加 ZIMUKU_VISION_* 三凭证（zimuku 的视觉兜底配置）
  //
  // ⚠️ c582571 加了三个键**但没改这条断言**，于是它红了很久（接手时的 7 条既有失败之一）。
  // 那不是 bug 是**测试过时**：白名单本身是对的，只是这条断言还停在上一档。
  it('恰为 15 键（含 TRANSLATE_* 与 ZIMUKU_VISION_* 各三凭证）', () => {
    expect([...SECRET_NAMES].sort()).toEqual([
      'ASSRT_TOKEN', 'JIMAKU_API_KEY', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL',
      'OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_PASSWORD', 'OPENSUBTITLES_USERNAME',
      'TMDB_API_KEY',
      'TRANSLATE_API_KEY', 'TRANSLATE_BASE_URL', 'TRANSLATE_MODEL',
      'ZIMUKU_VISION_API_KEY', 'ZIMUKU_VISION_BASE_URL', 'ZIMUKU_VISION_MODEL',
    ].sort())
    expect(SECRET_NAMES).toHaveLength(15)
  })
  it('isSecretName 放行白名单、拒绝其他', () => {
    expect(isSecretName('TMDB_API_KEY')).toBe(true)
    expect(isSecretName('ADMIN_TOKEN')).toBe(false)
    expect(isSecretName('')).toBe(false)
  })
})

// resolveSecret（env > db > none）已于 2026-08-20 用户裁决（env 凭证删除）整函数删除。
// 这里换成守**新红线**：产品运行态的 makeAdapterConfigResolver 对 env **完全失明**——
// 塞了 env 也好、空 env 也好，答案只来自库。当年"env > db"的用例组随之退役。
describe('makeAdapterConfigResolver：env 完全失明（2026-08-20 env 凭证删除）', () => {
  it('env 塞了值 → 依然只有库里的值生效（env 不是兜底、不是优先级、什么都不算）', () => {
    const cfg = makeAdapterConfigResolver({ TMDB_API_KEY: 'env-key' } as NodeJS.ProcessEnv, () => 'db-key')
    expect(cfg.secret('TMDB_API_KEY')).toEqual({ value: 'db-key', source: 'db' })
  })
  it('env 有值而库没有 → none（compose 里塞 env 的部署在 doctor/health 上必须如实报未配置）', () => {
    const cfg = makeAdapterConfigResolver({ TMDB_API_KEY: 'env-key' } as NodeJS.ProcessEnv, () => null)
    expect(cfg.secret('TMDB_API_KEY')).toEqual({ value: null, source: 'none' })
  })
  it('库里空串视为未配置（手滑存空串不挡下次向导重存）', () => {
    const cfg = makeAdapterConfigResolver({}, () => '')
    expect(cfg.secret('TMDB_API_KEY')).toEqual({ value: null, source: 'none' })
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
