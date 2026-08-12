import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const deployScript = readFileSync('deploy/deploy.sh', 'utf8')
const dockerfile = readFileSync('Dockerfile', 'utf8')
const mainCompose = readFileSync('docker-compose.yml', 'utf8')
const bundleCompose = readFileSync('docker-compose.bundle.yml', 'utf8')
const localCompose = readFileSync('docker-compose.local.yml', 'utf8')
const envExample = readFileSync('.env.example', 'utf8')
const gitignore = readFileSync('.gitignore', 'utf8')
const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8')
const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  repository: { url: string }
}

describe('production deployment contract', () => {
  // 8686269 把同步方式从 rsync 白名单 + `git archive HEAD` 换成 router 侧 git fetch/reset。
  // 旧断言锁的是 rsync 的实现细节（--delete / --include / --filter='protect /.env'），
  // 那些开关已不存在。但它们守的**意图**没变，只是换了载体：
  //   「完整同步受控源码」 rsync 白名单 → `git reset --hard origin/$branch`（tracked 文件）
  //   「不碰 router 自有文件」 --filter=protect → .env 未被 git 跟踪 + 全程不跑 `git clean`
  // 所以这里改锁新载体，而不是删掉这条保护。
  it('synchronizes tracked source via git reset without touching router-owned files', () => {
    expect(deployScript).toContain('git fetch --prune origin "$branch"')
    expect(deployScript).toContain('git reset --hard "origin/$branch"')
    // .env 的保护现在完全依赖「它不是 tracked 文件」——一旦有人把 .env 提交进仓库，
    // reset --hard 就会用仓库版本覆盖 router 自有的那份凭证。
    expect(gitignore).toMatch(/^\.env$/m)
    // 唯一会删除 untracked 文件的命令是 git clean；它出现即意味着 router 的 .env/备份/
    // .deploy/ 会被抹掉。脚本里只允许以注释形式提到它。
    const gitCleanLines = deployScript
      .split('\n')
      .filter((line) => /\bgit clean\b/.test(line) && !line.trimStart().startsWith('#'))
    expect(gitCleanLines, `deploy.sh 出现可执行的 git clean：${gitCleanLines.join(' | ')}`).toEqual([])
  })

  it('serializes one detached rollout and leaves one durable result marker', () => {
    expect(deployScript).toContain('#!/bin/sh\nset -eu')
    expect(deployScript).toContain('mkdir "$lock_dir"')
    expect(deployScript).toContain('trap cleanup')
    expect(deployScript).toMatch(/nohup sh (?:-c )?/)
    expect(deployScript).toContain('rollout.log')
    expect(deployScript).toContain('rollout.done')
    // 8686269 把远端 build 换成 pull：router 不再自己构建，而是领养 ghcr :latest。
    // 顺序依然是「先取到新镜像，再 recreate 容器」——反过来就是拿旧镜像重启。
    expect(deployScript).toContain('docker compose pull subtitle-scout || exit $?')
    expect(deployScript).toContain('docker compose up -d subtitle-scout || exit $?')
    expect(deployScript).toMatch(/docker compose pull subtitle-scout[\s\S]*docker compose up -d subtitle-scout/)
  })

  it('preserves rollback evidence and verifies the deployed revision', () => {
    expect(deployScript).toContain('subtitle-scout-rollback:')
    // 旧证据链是 rsync 时代的源码快照（source.tar.gz + source-manifest.sha256）。
    // 现在源码由 git 承载（commit sha 本身即清单），证据链改成 git 前后态 + compose 前后态。
    expect(deployScript).toContain('git-before.txt')
    expect(deployScript).toContain('git-after.txt')
    expect(deployScript).toContain('compose-before.sha256')
    expect(deployScript).toContain('compose-after.sha256')
    expect(deployScript).toContain('rollback-image.txt')
    // 核心：pull 下来的 :latest 必须真的是我们推的这个 commit 构建的。
    // 这是「容器 healthy 但跑的是旧代码」这类静默失败的唯一拦截点，必须是硬失败。
    expect(deployScript).toContain('org.opencontainers.image.revision')
    expect(deployScript).toMatch(
      /if \[ "\$actual_revision" != "\$revision" \]; then[\s\S]{0,200}?exit 1/,
    )
    // Dockerfile 侧：revision label 必须可注入，且落在 apt 层之后（改 commit 不该让
    // 那层 ~200MB 的 apt 缓存失效）。
    expect(dockerfile).toContain('ARG IMAGE_REVISION')
    expect(dockerfile).toContain('LABEL org.opencontainers.image.revision=$IMAGE_REVISION')
    expect(dockerfile.indexOf('LABEL org.opencontainers.image.revision')).toBeGreaterThan(dockerfile.indexOf('RUN apt-get'))
  })

  // 2026-08-12 生产事故：手工部署时 `docker build -t subtitle-scout .`，而 compose 引用的是
  // `ghcr.io/fancydirty/subtitle-scout:latest`。tag 不匹配 → compose 拿不到新镜像 → 容器起来了、
  // healthy、日志正常，但跑的是 25 小时前的旧代码。查 schema 版本才发现。
  // 这一条把「谁生产镜像」和「谁消费镜像」的名字钉成同一个。
  it('镜像名在生产者(release.yml)与消费者(compose)之间完全一致', () => {
    const slug = /github\.com\/([^/]+\/[^/.]+)/.exec(packageJson.repository.url)?.[1]
    expect(slug, 'package.json repository.url 解析不出 owner/repo').toBe('fancydirty/subtitle-scout')
    const expectedImage = `ghcr.io/${slug}:latest`

    // 消费者：所有拉取式 compose 必须引用同一个全限定名。
    for (const [name, compose] of [['main', mainCompose], ['bundle', bundleCompose]] as const) {
      const scoutImage = /^\s{4}image:\s*(\S*subtitle-scout\S*)\s*$/m.exec(compose)?.[1]
      expect(scoutImage, `${name} compose 的 subtitle-scout 镜像名与 ghcr 发布名不一致`).toBe(expectedImage)
    }

    // 生产者：release.yml 推的 registry/仓库/tag 必须能产出上面那个名字。
    expect(releaseWorkflow).toContain('registry: ghcr.io')
    expect(releaseWorkflow).toContain('images: ghcr.io/${{ github.repository }}')
    expect(releaseWorkflow).toContain('type=raw,value=latest')
    expect(releaseWorkflow).toContain('push: true')
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

  // 旧断言锁的是"MEDIA_HOST_PATH 在所有挂载点都带 :? 守卫"，意图是防止 Docker 在变量未设时
  // 静默创建空目录树。改挂宿主机根目录后该风险消失（`/` 恒存在，无需守卫），MEDIA_HOST_PATH
  // 随之退役。本锁改为钉死新契约：媒体入口恒为 /hostroot，且不得复活 MEDIA_HOST_PATH。
  it('媒体挂载恒为宿主机根目录 /hostroot（用户在 UI 里自选扫描目录），且 MEDIA_HOST_PATH 已退役', () => {
    for (const [name, compose] of [['main', mainCompose], ['bundle', bundleCompose]] as const) {
      expect(compose, `${name} 缺 /:/hostroot 挂载`).toMatch(/^\s*-\s*\/:\/hostroot\s*$/m)
      expect(compose, `${name} 仍引用已退役的 MEDIA_HOST_PATH`).not.toContain('MEDIA_HOST_PATH')
      // 硬编码子目录挂载不得复活——用户目录结构千奇百怪，Movies/TV 不是通用形态
      expect(compose, `${name} 残留硬编码媒体子目录挂载`).not.toMatch(/:\/media\/(movies|tv)\s*$/m)
      expect(compose, `${name} 缺 ./cache:/cache 挂载`).toMatch(/^\s*-\s*\.\/cache:\/cache\s*$/m)
    }
  })

  it('主 compose 透传了 .env.example 里声明的全部行为级变量（漏一个就是"配置静默无效"事故）', () => {
    const passed = passthroughKeys(mainCompose)
    // 仅 compose 自用（不进容器）或容器内固定值的变量豁免
    const composeOnly = new Set(['SUBTITLE_SCOUT_CACHE_DIR'])
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
    const bundleMissing = [...main].filter((k) => !bundle.has(k))
    expect(bundleMissing, `bundle 缺透传：${bundleMissing.join(', ')}`).toEqual([])
  })
})
