import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const deployScript = readFileSync('deploy/deploy.sh', 'utf8')
const dockerfile = readFileSync('Dockerfile', 'utf8')
const mainCompose = readFileSync('docker-compose.yml', 'utf8')
const bundleCompose = readFileSync('docker-compose.bundle.yml', 'utf8')
const localCompose = readFileSync('docker-compose.local.yml', 'utf8')
const envExample = readFileSync('.env.example', 'utf8')

describe('production deployment contract', () => {
  it('synchronizes the complete whitelisted source without touching router-owned files', () => {
    expect(deployScript).toContain('git archive HEAD')
    expect(deployScript).toContain("--include='web/package-lock.json'")
    expect(deployScript).toContain('--delete')
    expect(deployScript).toContain("--filter='protect /.env'")
    expect(deployScript).toContain("--filter='protect /docker-compose.yml'")
  })

  it('serializes one detached rollout and leaves one durable result marker', () => {
    expect(deployScript).toContain('#!/bin/sh\nset -eu')
    expect(deployScript).toContain('mkdir "$lock_dir"')
    expect(deployScript).toContain('trap cleanup')
    expect(deployScript).toMatch(/nohup sh (?:-c )?/)
    expect(deployScript).toContain('rollout.log')
    expect(deployScript).toContain('rollout.done')
    expect(deployScript).toContain('docker compose build --build-arg IMAGE_REVISION="$revision" subtitle-scout || exit $?')
    expect(deployScript).toContain('docker compose up -d subtitle-scout || exit $?')
    expect(deployScript).toMatch(/docker compose build[\s\S]*docker compose up -d subtitle-scout/)
  })

  it('preserves rollback evidence and verifies the deployed revision', () => {
    expect(deployScript).toContain('subtitle-scout-rollback:')
    expect(deployScript).toContain('source-manifest.sha256')
    expect(deployScript).toContain('source.tar.gz')
    expect(deployScript).toContain('org.opencontainers.image.revision')
    expect(deployScript).toContain('--build-arg IMAGE_REVISION=')
    expect(dockerfile).toContain('ARG IMAGE_REVISION')
    expect(dockerfile).toContain('LABEL org.opencontainers.image.revision=$IMAGE_REVISION')
    expect(dockerfile.indexOf('LABEL org.opencontainers.image.revision')).toBeGreaterThan(dockerfile.indexOf('RUN apt-get'))
  })
})

// 审计三轮 R3：三个真实部署事故（MEDIA_ROOTS 硬编码、SKIP_CHINESE_ORIGIN 漏透传、
// healthcheck 的 ${port} 被 compose 插值吞掉）全部从"compose 无契约测试"这个口子漏出去。
// 这一组把 compose 的三条硬契约钉死：env 透传完整性、healthcheck 转义、跨文件一致性。
describe('docker-compose deployment contract', () => {
  /** compose environment 块里 `KEY: ${KEY...}` 形式透传的变量名集合。 */
  function passthroughKeys(compose: string): Set<string> {
    const keys = new Set<string>()
    for (const m of compose.matchAll(/^\s{6}([A-Z0-9_]+):\s*\$\{/gm)) keys.add(m[1])
    return keys
  }

  /** .env.example 里声明的变量名集合（含注释掉的说明行不算）。 */
  const envExampleKeys = new Set(
    [...envExample.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]),
  )

  it('主 compose 的 healthcheck 用 $$ 转义端口变量（否则 compose 插值吞掉 ${port}，健康检查 100% 失败）', () => {
    expect(mainCompose).toContain('healthcheck:')
    expect(mainCompose).toContain('/api/v2/auth/status')
    // 必须是 $${port}：单 $ 会被 compose 当自己的变量替换成空串
    expect(mainCompose).toContain('localhost:$${port}')
    expect(mainCompose).not.toMatch(/localhost:\$\{port\}/)
  })

  it('三份 compose 的 healthcheck 策略一致（bundle/local 不得遗漏，否则测不出健康检查回归）', () => {
    for (const [name, compose] of [['bundle', bundleCompose], ['local', localCompose]] as const) {
      expect(compose, `${name} 缺 healthcheck`).toContain('healthcheck:')
      expect(compose, `${name} 的 healthcheck 未转义 $$`).toContain('localhost:$${port}')
    }
  })

  it('MEDIA_HOST_PATH 在所有挂载点都带 :? 守卫（未设置时报错，而非让 Docker 静默创建空目录）', () => {
    for (const [name, compose] of [['main', mainCompose], ['bundle', bundleCompose]] as const) {
      const mounts = [...compose.matchAll(/\$\{MEDIA_HOST_PATH([^}]*)\}/g)].map((m) => m[1])
      expect(mounts.length, `${name} 没有 MEDIA_HOST_PATH 挂载`).toBeGreaterThan(0)
      for (const modifier of mounts) {
        expect(modifier.startsWith(':?'), `${name} 有一处 MEDIA_HOST_PATH 缺 :? 守卫`).toBe(true)
      }
    }
  })

  it('主 compose 透传了 .env.example 里声明的全部行为级变量（漏一个就是"配置静默无效"事故）', () => {
    const passed = passthroughKeys(mainCompose)
    // 仅 compose 自用（不进容器）或容器内固定值的变量豁免
    const composeOnly = new Set(['MEDIA_HOST_PATH', 'SUBTITLE_SCOUT_CACHE_DIR'])
    const missing = [...envExampleKeys].filter((k) => !passed.has(k) && !composeOnly.has(k))
    expect(missing, `.env.example 声明但 compose 未透传：${missing.join(', ')}`).toEqual([])
  })

  it('compose 透传的变量都在 .env.example 里有文档（反向：不留无人知晓的隐藏开关）', () => {
    // 无豁免：MEDIA_ROOTS / DASHBOARD_PORT 都确实在 .env.example 里有条目，之前给它们开豁免
    // 是多余的，只会掩盖将来真的漏文档的变量（审计四轮 R4 自查发现）。
    const undocumented = [...passthroughKeys(mainCompose)].filter((k) => !envExampleKeys.has(k))
    expect(undocumented, `compose 透传但 .env.example 无条目：${undocumented.join(', ')}`).toEqual([])
  })

  it('bundle/local 与主 compose 的 env 透传集合一致（避免"某份 compose 配了没用"）', () => {
    const main = passthroughKeys(mainCompose)
    const bundle = passthroughKeys(bundleCompose)
    const behavioral = [...main].filter((k) => k !== 'MEDIA_HOST_PATH')
    const bundleMissing = behavioral.filter((k) => !bundle.has(k))
    expect(bundleMissing, `bundle 缺透传：${bundleMissing.join(', ')}`).toEqual([])
  })
})
