import { describe, it, expect } from 'vitest'
import { checkJellyfin, checkAssrt, checkOpenSubtitles, checkLlm, checkMediaRoots, checkPathMappings, formatDoctorReport, overallOk, withTimeout, checkDatabase, checkStuckJobs } from './doctor.js'

describe('doctor 远端三项', () => {
  it('jellyfin 可达 → ok，带会话数', async () => {
    const r = await checkJellyfin({ getSessions: async () => [{}, {}] })
    expect(r.ok).toBe(true)
    expect(r.name).toBe('jellyfin')
    expect(r.detail).toContain('2')
  })
  it('jellyfin 401 → 失败并给人话提示', async () => {
    const r = await checkJellyfin({ getSessions: async () => { throw new Error('jellyfin GET /Sessions: HTTP 401') } })
    expect(r.ok).toBe(false)
    expect(r.hint).toContain('API')
  })
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
  it('近期条目映射后的目录都存在且可写 → ok', () => {
    const r = checkPathMappings(
      [{ Path: '/data/movies/A/A.mkv' }, { Path: '/data/tv/B/S01/B.mkv' }],
      [{ from: '/data', to: '/media' }],
      { dirExists: () => true, isWritable: () => true },
    )
    expect(r.ok).toBe(true)
  })
  it('映射后的目录不存在 → 失败，报告 jellyfin 路径与映射结果', () => {
    const r = checkPathMappings(
      [{ Path: '/data/movies/A/A.mkv' }],
      [],
      { dirExists: () => false, isWritable: () => true },
    )
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('/data/movies/A')
    expect(r.hint).toMatch(/MEDIA_PATH_MAPPINGS|挂载/)
  })
  it('映射后的目录存在但不可写 → 失败，分开报告 readonly', () => {
    const r = checkPathMappings(
      [{ Path: '/data/movies/A/A.mkv' }],
      [],
      { dirExists: () => true, isWritable: () => false },
    )
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('不可写')
    expect(r.detail).toContain('/data/movies/A')
  })
  it('jellyfin 库为空 → skip', () => {
    const r = checkPathMappings([], [], { dirExists: () => true, isWritable: () => true })
    expect(r.skip).toBe(true)
  })
})

describe('doctor 报告', () => {
  const results = [
    { name: 'jellyfin', ok: true, detail: '可达' },
    { name: 'assrt', ok: false, detail: '失败', hint: '检查 token' },
    { name: 'path-mapping', ok: true, skip: true, detail: '库为空' },
  ]
  it('输出含 ✓ / ✗ / ⊘ 三种标记与 hint', () => {
    const text = formatDoctorReport(results)
    expect(text).toContain('✓ jellyfin')
    expect(text).toContain('✗ assrt')
    expect(text).toContain('⊘ path-mapping')
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
    await expect(withTimeout(never, 10, 'Jellyfin')).rejects.toThrow('Jellyfin 在 0.01s 内无响应')
  })
  it('按时完成 → 原样返回结果', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'ASSRT')).resolves.toBe('ok')
  })
})

describe('doctor v2 database checks', () => {
  it('checkDatabase：可开且版本匹配 → ✓ 显示版本', () => {
    const r = checkDatabase(() => ({ version: '5' }))
    expect(r.ok).toBe(true)
    expect(r.name).toBe('database')
    expect(r.detail).toContain('5')
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
