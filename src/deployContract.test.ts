import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const deployScript = readFileSync('deploy/deploy.sh', 'utf8')
const dockerfile = readFileSync('Dockerfile', 'utf8')

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
