import { describe, it, expect } from 'vitest'
import { checkAssrt, checkOpenSubtitles, checkZimuku, checkLlm, checkTmdb, checkMediaRoots, formatDoctorReport, overallOk, withTimeout, checkDatabase, checkStuckJobs, checkMountCapabilities } from './doctor.js'
import { MIGRATIONS } from '../v2/db.js'

describe('doctor 远端三项', () => {
  it('assrt quota 正常 → ok 并显示剩余配额', async () => {
    const r = await checkAssrt({ quota: async () => ({ status: 0, user: { quota: 4 } }) })
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('4')
  })
  it('assrt token 无效（status 非 0 / 抛错）→ 失败', async () => {
    const r = await checkAssrt({ quota: async () => { throw new Error('ASSRT user/quota returned status 30900') } })
    expect(r.ok).toBe(false)
    expect(r.hint).toContain('assrt.net')
  })
  it('assrt 无 user 字段 → ok 且配额显示未知', async () => {
    const r = await checkAssrt({ quota: async () => ({ status: 0 }) })
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('未知')
  })
  it('assrt 对象形式非 0 status → 失败', async () => {
    const r = await checkAssrt({ quota: async () => ({ status: 30900, user: { quota: 0 } }) })
    expect(r.ok).toBe(false)
  })
  it('opensubtitles 未配置(null client) → skip 而非失败，hint 提到环境变量', async () => {
    const r = await checkOpenSubtitles(null)
    expect(r.skip).toBe(true)
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('OPENSUBTITLES_API_KEY')
  })
  it('opensubtitles 已配置且搜索成功 → ok 带命中数', async () => {
    const r = await checkOpenSubtitles({ search: async () => ({ data: [{}, {}] }) })
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('2')
  })
  it('opensubtitles 已配置但搜索失败 → 失败并给人话提示', async () => {
    const r = await checkOpenSubtitles({ search: async () => { throw new Error('401 Unauthorized') } })
    expect(r.ok).toBe(false)
    expect(r.hint).toContain('OPENSUBTITLES_API_KEY')
  })
  it('llm 能对话 → ok', async () => {
    const r = await checkLlm(async () => 'ok')
    expect(r.ok).toBe(true)
  })
  it('llm 端点拒绝 → 失败并提示检查 base_url/key/model', async () => {
    const r = await checkLlm(async () => { throw new Error('401 Unauthorized') })
    expect(r.ok).toBe(false)
    expect(r.hint).toMatch(/LLM_BASE_URL|LLM_API_KEY/)
  })
  it('tmdb key 有效(探测命中) → ok', async () => {
    const r = await checkTmdb(async () => 3)
    expect(r.ok).toBe(true)
    expect(r.name).toBe('tmdb')
    expect(r.detail).toMatch(/命中 3/)
  })
  it('tmdb 探测失败 → ✗ 并提示检查 key/反代', async () => {
    const r = await checkTmdb(async () => { throw new Error('401') })
    expect(r.ok).toBe(false)
    expect(r.hint).toMatch(/TMDB_API_KEY|TMDB_PROXY_URL/)
  })
})

describe('doctor zimuku (可选 provider,默认关闭)', () => {
  it('未配置(probe=null) → skip 而非失败,hint 提到 ZIMUKU_ENABLED', async () => {
    const r = await checkZimuku(null)
    expect(r.skip).toBe(true)
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('ZIMUKU_ENABLED')
  })
  it('已启用且首页可达、未触发验证页 → ok', async () => {
    const r = await checkZimuku({ fetchHomepage: async () => ({ ok: true, challenged: false }) })
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('未触发验证页')
  })
  it('已启用且命中云锁验证页 → 仍然 ok(挑战页是预期健康状态,不是失败)', async () => {
    const r = await checkZimuku({ fetchHomepage: async () => ({ ok: true, challenged: true }) })
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('验证页')
  })
  it('首页不可达 → 失败并给人话提示', async () => {
    const r = await checkZimuku({ fetchHomepage: async () => { throw new Error('ETIMEDOUT') } })
    expect(r.ok).toBe(false)
    expect(r.hint).toContain('zimuku.org')
  })
})

describe('doctor 本地两项', () => {
  it('MEDIA_ROOTS 未配置 → skip 而非失败', async () => {
    const r = checkMediaRoots([], () => true)
    expect(r.skip).toBe(true)
    expect(r.ok).toBe(true)
  })
  it('全部根目录可写 → ok', () => {
    const r = checkMediaRoots(['/media/movies', '/media/tv'], () => true)
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('2')
  })
  it('存在只读根目录 → 失败并点名', () => {
    const r = checkMediaRoots(['/media/movies', '/ro'], d => d !== '/ro')
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('/ro')
  })

  // R2D-11（R2 复审）：MEDIA_ROOTS env 只是"首启种子"——dashboard G4 之后真正生效的守备目录
  // 存活在 DB media_roots 表（可动态增删）。第三参 source 可选，标注这份 roots 清单的来源，
  // 让 doctor 报告能诚实回答"你在看的是不是当前真正生效的清单"，不假装 env 恒是唯一真源。
  it('source="db" 时 detail 标注来源为 db', () => {
    const r = checkMediaRoots(['/media/movies'], () => true, 'db')
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('db')
  })
  it('source="env seed" 时 detail 标注来源为 env seed', () => {
    const r = checkMediaRoots(['/media/movies'], () => true, 'env seed')
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('env seed')
  })
  it('source 省略时不标注来源（向后兼容既有调用点/文案）', () => {
    const r = checkMediaRoots(['/media/movies'], () => true)
    expect(r.detail).not.toContain('db')
    expect(r.detail).not.toContain('env seed')
  })
  it('skip 分支与失败分支同样带上 source 标注', () => {
    expect(checkMediaRoots([], () => true, 'db').detail).toContain('db')
    expect(checkMediaRoots(['/ro'], () => false, 'env seed').detail).toContain('env seed')
  })
})

describe('doctor 报告', () => {
  const results = [
    { name: 'llm', ok: true, detail: '可达' },
    { name: 'assrt', ok: false, detail: '失败', hint: '检查 token' },
    { name: 'media-roots', ok: true, skip: true, detail: '未配置' },
  ]
  it('输出含 ✓ / ✗ / ⊘ 三种标记与 hint', () => {
    const text = formatDoctorReport(results)
    expect(text).toContain('✓ llm')
    expect(text).toContain('✗ assrt')
    expect(text).toContain('⊘ media-roots')
    expect(text).toContain('检查 token')
  })
  it('有失败 → overallOk false；skip 不算失败', () => {
    expect(overallOk(results)).toBe(false)
    expect(overallOk(results.filter(r => r.name !== 'assrt'))).toBe(true)
  })
})

describe('withTimeout', () => {
  it('超时 → reject 并说明哪个远端无响应', async () => {
    const never = new Promise<string>(() => { /* never resolves */ })
    await expect(withTimeout(never, 10, 'TMDB')).rejects.toThrow('TMDB 在 0.01s 内无响应')
  })
  it('按时完成 → 原样返回结果', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'ASSRT')).resolves.toBe('ok')
  })
})

describe('doctor v2 database checks', () => {
  it('checkDatabase：可开且版本匹配 → ✓ 显示版本', () => {
    // 版本值随 v2/db.ts MIGRATIONS 数组长度走——checkDatabase 内部用 MIGRATIONS.length 算
    // EXPECTED_VERSION。此前这里硬编码字面量，每次追加迁移 entry 都会假红一次（胶水层战役
    // v10/v11 各断一回）；改为直接派生同一来源，只断言"匹配"分支本身。
    const current = String(MIGRATIONS.length)
    const r = checkDatabase(() => ({ version: current }))
    expect(r.ok).toBe(true)
    expect(r.name).toBe('database')
    expect(r.detail).toContain(current)
  })
  it('checkDatabase：打开抛错 → ✗ 人话 hint', () => {
    const r = checkDatabase(() => { throw new Error('SQLITE_CANTOPEN') })
    expect(r.ok).toBe(false)
    expect(r.hint).toBeTruthy()
  })
  it('checkDatabase：版本不符（比预期旧）→ ✗ 提示', () => {
    const r = checkDatabase(() => ({ version: '0' }))
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('0')
    expect(r.hint).toBeTruthy()
  })
  it('checkDatabase：版本不符（比预期新）→ ✗ 提示旧版 CLI', () => {
    const r = checkDatabase(() => ({ version: '999' }))
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('999')
    expect(r.hint).toContain('CLI')
  })
  it('checkStuckJobs：0 个卡住 → ✓', () => {
    const r = checkStuckJobs(() => 0)
    expect(r.ok).toBe(true)
    expect(r.name).toBe('stuck-jobs')
  })
  it('checkStuckJobs：>0 个卡住 → ✗ 带人话提示', () => {
    const r = checkStuckJobs(() => 3)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('3')
    expect(r.hint).toContain('重启')
    expect(r.hint).toContain('issue')
  })
})

describe('checkMountCapabilities', () => {
  it('汇报每个根的挂载能力画像，信息性、恒 ok=true', () => {
    const result = checkMountCapabilities(
      ['/media/tv', '/media/movies'],
      (dir) => ({ writable: true, hardlink: dir === '/media/tv', caseSensitive: true }),
    )
    expect(result.ok).toBe(true)
    expect(result.skip).toBeFalsy()
    expect(result.detail).toContain('/media/tv')
    expect(result.detail).toContain('/media/movies')
    expect(result.detail).toContain('硬链接: 支持')
    expect(result.detail).toContain('硬链接: 不支持')
  })

  it('roots 为空时 skip', () => {
    const result = checkMountCapabilities([], () => ({ writable: true, hardlink: true, caseSensitive: true }))
    expect(result.skip).toBe(true)
    expect(result.ok).toBe(true)
  })

  it('单个根的探针崩溃不许炸整个 doctor——该根报探测失败，其余根照常汇报', () => {
    const result = checkMountCapabilities(
      ['/media/dead', '/media/tv'],
      (dir) => {
        if (dir === '/media/dead') throw new Error('EIO: input/output error')
        return { writable: true, hardlink: true, caseSensitive: true }
      },
    )
    expect(result.ok).toBe(true) // 信息性检查，不作为失败门槛
    expect(result.detail).toContain('/media/dead')
    expect(result.detail).toContain('探测失败')
    expect(result.detail).toContain('/media/tv')
    expect(result.detail).toContain('硬链接: 支持')
  })

  it("探针结果 'unknown'（只读/未挂载，无法探测）→ 报 未知 而非假的 支持/不支持", () => {
    const result = checkMountCapabilities(
      ['/media/ro'],
      () => ({ writable: false, hardlink: 'unknown', caseSensitive: 'unknown' }),
    )
    expect(result.detail).toContain('硬链接: 未知')
    expect(result.detail).toContain('大小写敏感: 未知')
    expect(result.detail).toContain('可写: 否')
    expect(result.detail).not.toContain('不支持')
  })
})
