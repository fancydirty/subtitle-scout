import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkspacePaths } from './types.js'

export const TRANSLATE_STAGING_DIRNAME = '.subtitle-translate'

export function workspacePaths(stagingBase: string, jobId: string): WorkspacePaths {
  const jobRoot = join(stagingBase, TRANSLATE_STAGING_DIRNAME, jobId)
  const canonicalDir = join(jobRoot, 'canonical')
  const agentViewDir = join(jobRoot, 'agent_view')
  const contextDir = join(jobRoot, 'context')
  const glossaryDir = join(jobRoot, 'glossary')
  const workDir = join(jobRoot, 'work')
  const outDir = join(jobRoot, 'out')
  return {
    jobRoot,
    canonicalDir,
    agentViewDir,
    contextDir,
    glossaryDir,
    workDir,
    outDir,
    metaPath: join(jobRoot, 'meta.json'),
    sourceCleanPath: join(agentViewDir, 'source_clean.jsonl'),
    bilingualPath: join(workDir, 'bilingual.jsonl'),
    glossaryPath: join(glossaryDir, 'terms.json'),
    glossaryFrozenPath: join(glossaryDir, 'FROZEN'),
    summaryPath: join(workDir, 'summary.md'),
    criticPath: join(workDir, 'critic.md'),
    targetSrtPath: join(outDir, 'target.srt'),
    canonicalSourcePath: join(canonicalDir, 'source.srt'),
  }
}

export function ensureWorkspaceLayout(stagingBase: string, jobId: string): WorkspacePaths {
  const paths = workspacePaths(stagingBase, jobId)
  for (const dir of [
    paths.jobRoot,
    paths.canonicalDir,
    paths.agentViewDir,
    paths.contextDir,
    paths.glossaryDir,
    paths.workDir,
    paths.outDir,
  ]) {
    mkdirSync(dir, { recursive: true })
  }
  const ignorePath = join(stagingBase, TRANSLATE_STAGING_DIRNAME, '.ignore')
  if (!existsSync(ignorePath)) {
    try {
      writeFileSync(
        ignorePath,
        'subtitle-scout subtitle-translate staging — media servers should not scan this directory\n',
      )
    } catch {
      // best-effort
    }
  }
  return paths
}
