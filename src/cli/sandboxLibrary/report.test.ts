import { describe, it, expect } from 'vitest'
import { evaluateFindCell, evaluateSkipCell } from './report.js'

describe('evaluateFindCell', () => {
  it('PASS when identity, target-lang sidecar, cues > 10', () => {
    expect(evaluateFindCell({
      expectedTmdbId: 603, actualTmdbId: 603,
      skipReason: null, needsSubtitle: 1, subStatus: 'covered',
      sidecarTags: ['zh-Hans'], cueCount: 11, findSubtitleRuns: 1, targetLanguage: 'zh',
    }).verdict).toBe('PASS')
  })

  it('PASS even if subStatus is null (R24) when sidecar+cues ok', () => {
    expect(evaluateFindCell({
      expectedTmdbId: 603, actualTmdbId: 603,
      skipReason: null, needsSubtitle: 1, subStatus: null,
      sidecarTags: ['zh-Hans'], cueCount: 11, findSubtitleRuns: 1, targetLanguage: 'zh',
    }).verdict).toBe('PASS')
  })

  it('FAIL-PIPE when wrong title', () => {
    expect(evaluateFindCell({
      expectedTmdbId: 603, actualTmdbId: 604,
      skipReason: null, needsSubtitle: 1, subStatus: 'covered',
      sidecarTags: ['zh-Hans'], cueCount: 11, findSubtitleRuns: 1, targetLanguage: 'zh',
    }).verdict).toBe('FAIL-PIPE')
  })

  it('FAIL-PIPE when en-viewer installs Chinese', () => {
    expect(evaluateFindCell({
      expectedTmdbId: 612399, actualTmdbId: 612399,
      skipReason: null, needsSubtitle: 1, subStatus: 'covered',
      sidecarTags: ['zh-Hans'], cueCount: 11, findSubtitleRuns: 1, targetLanguage: 'en',
    }).verdict).toBe('FAIL-PIPE')
  })

  it('FAIL-SOURCE when identity ok but no usable sidecar', () => {
    expect(evaluateFindCell({
      expectedTmdbId: 603, actualTmdbId: 603,
      skipReason: 'missing', needsSubtitle: 1, subStatus: null,
      sidecarTags: [], cueCount: 0, findSubtitleRuns: 1, targetLanguage: 'zh',
    }).verdict).toBe('FAIL-SOURCE')
  })
})

describe('evaluateSkipCell', () => {
  it('PASS when origin-skip, no worker run, no new sidecar', () => {
    expect(evaluateSkipCell({
      skipReason: 'origin-skip', needsSubtitle: 0,
      findSubtitleRuns: 0, sidecarTags: [],
    }).verdict).toBe('PASS')
  })

  it('FAIL-SKIP when worker ran', () => {
    expect(evaluateSkipCell({
      skipReason: 'origin-skip', needsSubtitle: 0,
      findSubtitleRuns: 1, sidecarTags: [],
    }).verdict).toBe('FAIL-SKIP')
  })

  it('FAIL-PIPE if skipReason missing', () => {
    expect(evaluateSkipCell({
      skipReason: null, needsSubtitle: 0,
      findSubtitleRuns: 0, sidecarTags: [],
    }).verdict).toBe('FAIL-PIPE')
  })
})
