// web/src/triage/ClaimDialog.tsx：认领流核心——DESIGN.md §1 铁律的明确例外（"destructive 之外
// 不用 modal——但 ClaimDialog 是录入流对话框，Astryx Dialog 合法，不是详情板替代品"）。
// purpose="form"：录入过程中点击背板不会意外丢数据（同 astryx 官方 DialogFormDialog 模板的
// 既有推荐用法）。
//
// 流程：打开时列出选中路径（原始未去重列表，>5 条折叠）→ TMDB 搜索（type 切换 + 400ms 防抖）
// 或手动 tmdbId 兜底 → 提交（同 dirname 去重成一条 POST，claimParked 的 override 覆盖粒度是
// 整个目录前缀，见 web/src/triage/text.ts 的 dedupeByDirname 注释）→ 逐行 ✓/✗ 进度 → 全部成功
// 关闭+刷新两箱，部分失败保留对话框展示结果（DESIGN.md §8：数据诚实，不假装全部顺利）。
import { useEffect, useState } from 'react'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { Layout, LayoutContent, LayoutFooter, HStack, VStack } from '@astryxdesign/core/Layout'
import { Button } from '@astryxdesign/core/Button'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { NumberInput } from '@astryxdesign/core/NumberInput'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { SelectableCard } from '@astryxdesign/core/SelectableCard'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { api } from '../api/client.js'
import type { TmdbSearchResultDTO } from '../api/types.js'
import { PosterThumb } from '../library/PosterThumb.js'
import { useT, type Lang } from '../i18n/useT.js'
import { selectedCountLabel, moreLabel, dedupeByDirname, pathTail } from './text.js'

type MediaType = 'tv' | 'movie'
type Phase = 'idle' | 'submitting' | 'done'
interface RowResult {
  path: string
  status: 'pending' | 'ok' | 'error'
  error?: string
}

const SEARCH_DEBOUNCE_MS = 400
const PATH_LIST_COLLAPSE_AT = 5

function PathList({ paths, lang }: { paths: string[]; lang: Lang }) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? paths : paths.slice(0, PATH_LIST_COLLAPSE_AT)
  const hidden = paths.length - visible.length
  return (
    <div className="triage-dialog-path-list">
      {visible.map((p) => (
        <div key={p} className="triage-dialog-path-item" title={p}>
          {p}
        </div>
      ))}
      {hidden > 0 ? (
        <button type="button" className="triage-dialog-more" onClick={() => setExpanded(true)}>
          {moreLabel(hidden, lang)}
        </button>
      ) : null}
    </div>
  )
}

function SearchResultCard({
  hit, isSelected, onSelect,
}: {
  hit: TmdbSearchResultDTO
  isSelected: boolean
  onSelect: (selected: boolean) => void
}) {
  return (
    <SelectableCard label={hit.name} isSelected={isSelected} onChange={onSelect} padding={2}>
      <HStack gap={3} vAlign="center">
        <div className="triage-search-poster">
          <PosterThumb posterPath={hit.posterPath} name={hit.name} />
        </div>
        <VStack gap={0}>
          <Text type="body">{hit.name}</Text>
          <Text type="supporting" color="secondary">
            {hit.year ?? '—'}
          </Text>
        </VStack>
      </HStack>
    </SelectableCard>
  )
}

function ProgressRow({ result }: { result: RowResult }) {
  const variant = result.status === 'ok' ? 'success' : result.status === 'error' ? 'error' : 'neutral'
  // 状态词是技术词表（同 Workflow 区 decision 词的口径，永不翻译），可见渲染而不只是
  // aria-label——DESIGN.md §4：状态 = 圆点 + 一个同色词，色盲/截图场景不能只靠点色。
  const word = result.status === 'ok' ? 'claimed' : result.status === 'error' ? 'failed' : 'pending'
  return (
    <div className="triage-progress-row">
      <StatusDot variant={variant} label={word} />
      <span className={`triage-progress-word triage-progress-word-${result.status}`}>{word}</span>
      <span className="triage-progress-path" title={result.path}>
        {pathTail(result.path)}
      </span>
      {result.error ? <span className="triage-progress-error">{result.error}</span> : null}
    </div>
  )
}

interface Props {
  /** null＝对话框关闭。非空数组＝打开时刻的选中路径快照（原始、未去重）。 */
  paths: string[] | null
  onClose: () => void
  /** 全部认领成功后调用——父级借此刷新两箱（TriagePage 传 triage.reload）。 */
  onSuccess: () => void
}

export function ClaimDialog({ paths, onClose, onSuccess }: Props) {
  const { t, lang } = useT()

  const [mediaType, setMediaType] = useState<MediaType>('tv')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const [searchResults, setSearchResults] = useState<TmdbSearchResultDTO[] | null>(null)
  const [selectedHitId, setSelectedHitId] = useState<number | null>(null)
  const [manualTmdbId, setManualTmdbId] = useState<number | null>(null)
  const [season, setSeason] = useState<number | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [results, setResults] = useState<RowResult[]>([])

  // 每次打开（paths 换一份新引用）重置整个表单态——同一个对话框元素在 TriagePage 里常驻，
  // 不会因为 paths→null 而卸载（同 RerunDialog 的既有先例）。
  useEffect(() => {
    setMediaType('tv')
    setQuery('')
    setDebouncedQuery('')
    setSearching(false)
    setSearchError(false)
    setSearchResults(null)
    setSelectedHitId(null)
    setManualTmdbId(null)
    setSeason(null)
    setPhase('idle')
    setResults([])
  }, [paths])

  // 400ms 防抖。
  useEffect(() => {
    const h = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(h)
  }, [query])

  // 防抖后的真实搜索请求——debouncedQuery 为空时不发请求，也不残留上一次的结果。
  useEffect(() => {
    if (!paths) return
    if (!debouncedQuery) {
      setSearchResults(null)
      setSearchError(false)
      setSearching(false)
      return
    }
    const ctrl = new AbortController()
    setSearching(true)
    setSearchError(false)
    api
      .tmdbSearch(mediaType, debouncedQuery, ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return
        setSearchResults(res.results)
      })
      .catch(() => {
        if (ctrl.signal.aborted) return
        setSearchError(true)
        setSearchResults(null)
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setSearching(false)
      })
    return () => ctrl.abort()
  }, [debouncedQuery, mediaType, paths])

  if (!paths) return null

  const effectiveTmdbId = selectedHitId != null ? String(selectedHitId) : manualTmdbId != null ? String(manualTmdbId) : null
  const canSubmit = effectiveTmdbId != null && phase === 'idle'
  const hasFailures = results.some((r) => r.status === 'error')

  const handleSubmit = async () => {
    if (!effectiveTmdbId) return
    const deduped = dedupeByDirname(paths)
    setPhase('submitting')
    setResults(deduped.map((p) => ({ path: p, status: 'pending' as const })))
    let allOk = true
    for (const p of deduped) {
      try {
        await api.claimTriage({
          path: p,
          tmdbId: effectiveTmdbId,
          isTv: mediaType === 'tv',
          ...(mediaType === 'tv' && season != null ? { season } : {}),
        })
        setResults((prev) => prev.map((r) => (r.path === p ? { ...r, status: 'ok' as const } : r)))
      } catch (e) {
        allOk = false
        setResults((prev) => prev.map((r) => (r.path === p ? { ...r, status: 'error' as const, error: String(e) } : r)))
      }
    }
    setPhase('done')
    if (allOk) {
      onSuccess()
      onClose()
    }
  }

  const showForm = phase === 'idle'

  return (
    <Dialog isOpen onOpenChange={(open) => { if (!open) onClose() }} purpose="form" width={480}>
      <Layout
        header={
          <DialogHeader
            title={t('triage_dialog_title')}
            subtitle={selectedCountLabel(paths.length, lang)}
            onOpenChange={() => onClose()}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={4}>
              {showForm ? (
                <>
                  <PathList paths={paths} lang={lang} />

                  <SegmentedControl
                    value={mediaType}
                    onChange={(v) => {
                      setMediaType(v as MediaType)
                      setSelectedHitId(null)
                      setSearchResults(null)
                    }}
                    label="Claim as">
                    <SegmentedControlItem value="tv" label={t('triage_type_tv')} />
                    <SegmentedControlItem value="movie" label={t('triage_type_movie')} />
                  </SegmentedControl>

                  <TextInput
                    label={t('triage_search_placeholder')}
                    isLabelHidden
                    placeholder={t('triage_search_placeholder')}
                    value={query}
                    onChange={setQuery}
                    hasClear
                    startIcon="search"
                  />
                  {searchError ? (
                    <Text type="supporting" color="secondary">
                      {t('triage_search_unreachable')}
                    </Text>
                  ) : !searching && searchResults && searchResults.length === 0 ? (
                    <Text type="supporting" color="secondary">
                      {t('triage_search_no_results')}
                    </Text>
                  ) : null}
                  {searchResults && searchResults.length > 0 ? (
                    <VStack gap={2}>
                      {searchResults.map((hit) => (
                        <SearchResultCard
                          key={hit.id}
                          hit={hit}
                          isSelected={selectedHitId === hit.id}
                          onSelect={(sel) => setSelectedHitId(sel ? hit.id : null)}
                        />
                      ))}
                    </VStack>
                  ) : null}

                  <NumberInput
                    label={t('triage_tmdbid_label')}
                    value={manualTmdbId}
                    onChange={(v) => {
                      setManualTmdbId(v)
                      if (v != null) setSelectedHitId(null)
                    }}
                    isIntegerOnly
                    min={1}
                    hasClear
                  />
                  {mediaType === 'tv' ? (
                    <NumberInput
                      label={t('triage_season_label')}
                      value={season}
                      onChange={setSeason}
                      isIntegerOnly
                      min={1}
                      placeholder={t('triage_season_placeholder')}
                      hasClear
                    />
                  ) : null}
                </>
              ) : (
                <VStack gap={2}>
                  <Text type="label">{t('triage_results_heading')}</Text>
                  {results.map((r) => (
                    <ProgressRow key={r.path} result={r} />
                  ))}
                  {phase === 'done' && hasFailures ? (
                    <Text type="supporting" color="secondary">
                      {t('triage_partial_failure_desc')}
                    </Text>
                  ) : null}
                </VStack>
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button
                label={phase === 'done' ? t('triage_close_label') : t('triage_cancel_label')}
                variant="secondary"
                onClick={onClose}
              />
              {phase !== 'done' ? (
                <Button
                  label={t('triage_submit_label')}
                  variant="primary"
                  isDisabled={!canSubmit}
                  isLoading={phase === 'submitting'}
                  onClick={handleSubmit}
                />
              ) : null}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}
