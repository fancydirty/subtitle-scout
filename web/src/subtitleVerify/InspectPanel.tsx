// web/src/subtitleVerify/InspectPanel.tsx：字幕对照检视面板——点红芯片打开。
//
// 三块（spec §4.2）：
//   1. 结论条：一句人话 + 成因猜测 + 「校正时间轴 / 保留原样」
//   2. 对照时间轴：图形化证据（CompareTimeline）
//   3. 台词列表：装错剧时扫一眼就能发现
//
// 这个面板的定位是**说服**：用户已经看到红芯片知道"有问题"，面板要回答"什么问题、
// 修得了吗、修了会怎样"。所以证据（时间轴）比结论（文字）占更大篇幅——文字结论谁都能写，
// 图形才让用户自己确认。
//
// 用 Dialog 而不是 AlertDialog：后者没有 children 插槽（只有 title/description 两个
// 字符串 prop，见其 d.ts），装不下时间轴。AlertDialog 留给"破坏性操作的二次确认"
// 那个场景（DESIGN.md §5），而这里是一个信息面板 + 一个明确的动作按钮。
import { useMemo } from 'react'
import { Dialog } from '@astryxdesign/core/Dialog'
import { DialogHeader } from '@astryxdesign/core/Dialog'
import { Text } from '@astryxdesign/core/Text'
import { CompareTimeline, type TimelineCue } from './CompareTimeline.js'
import { formatTick } from './viewport.js'
import { useT } from '../i18n/useT.js'
import type { SubtitleCompareDTO } from '../api/types.js'

/** 结论的三种形态。**没有第四种，也永远不会有黄色档**（用户裁决）。 */
export type Diagnosis = 'shift' | 'drift' | 'unknown'

interface Props {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** 数据加载中时为 null——面板先开、内容后到，比等数据到了才开更跟手 */
  data: SubtitleCompareDTO | null
  loading: boolean
  error: string | null
  /** 点「校正时间轴」。drift/unknown 时不渲染这个按钮，所以可以缺席 */
  onCorrect?: () => void
  correcting?: boolean
}

/**
 * 从两轨形状推断"平移能不能修好"。
 *
 * 判据：比较序列**前段**与**后段**的平均偏移。纯平移的话两者相等；帧率不匹配的话
 * 后段偏移显著大于前段（越往后拉越开）。
 *
 * 为什么在前端算而不用后端的 score：后端的分数是**内部诊断字段**，铁律②不让它上界面
 * （连 DTO 里都没有）。而"修得了修不了"这个判断需要的信息，两轨的时间戳本身就够了——
 * 前端从已有的展示数据里就能推出来，不需要多要一个数字。
 *
 * 阈值 1.5：后段偏移超过前段 1.5 倍才判 drift。留足余量是因为字幕组的手工微调会让
 * 单条 cue 偏移有噪声，一两条不该翻转整体结论。
 */
export function diagnose(reference: readonly TimelineCue[], ours: readonly TimelineCue[]): Diagnosis {
  const n = Math.min(reference.length, ours.length)
  // 少于 6 条没法分前后段比较——不敢判，如实说不知道
  if (n < 6) return 'unknown'
  const third = Math.floor(n / 3)
  const head = avgDelta(reference, ours, 0, third)
  const tail = avgDelta(reference, ours, n - third, n)
  if (head === null || tail === null) return 'unknown'
  const absHead = Math.abs(head)
  const absTail = Math.abs(tail)
  // 两端都几乎无偏移 → 本来就是对的（理论上不该走到这个面板，但数据可能已过期）
  if (absHead < 200 && absTail < 200) return 'unknown'
  // 后段显著大于前段 = 渐进漂移，平移修不好
  if (absTail > absHead * 1.5 + 200) return 'drift'
  return 'shift'
}

function avgDelta(
  a: readonly TimelineCue[], b: readonly TimelineCue[], from: number, to: number,
): number | null {
  let sum = 0
  let count = 0
  for (let i = from; i < to; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined || y === undefined) continue
    sum += y.startMs - x.startMs
    count++
  }
  return count === 0 ? null : sum / count
}

export function InspectPanel({
  isOpen, onOpenChange, title, data, loading, error, onCorrect, correcting,
}: Props) {
  const { t } = useT()
  const diag = useMemo<Diagnosis>(
    () => (data === null ? 'unknown' : diagnose(data.reference, data.ours)),
    [data],
  )
  // 云盘：检测照常做（只读字幕文件），但对照图画不出来（抽音频要 >120s，
  // 每次 seek 付 CDN 延迟地板）。这是网盘的物理限制，不是功能没做——文案要说清这个区别。
  const cloudBlocked = data !== null && data.mountKind === 'cloud'

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width="min(1080px, 94vw)" maxHeight="88vh">
      <DialogHeader title={title} onOpenChange={onOpenChange} />
      <div className="vinspect">
        {loading && data === null ? (
          <Text type="body" color="secondary">{t('verify_inspect_loading')}</Text>
        ) : error !== null ? (
          <Text type="body" color="secondary">{error}</Text>
        ) : data === null ? null : (
          <>
            <Verdict
              diag={diag}
              cloudBlocked={cloudBlocked}
              onCorrect={onCorrect}
              correcting={correcting === true}
              onDismiss={() => onOpenChange(false)}
            />

            {cloudBlocked ? (
              <div className="vinspect-cloud">
                <Text type="label" color="primary">{t('verify_cloud_title')}</Text>
                <Text type="body" color="secondary">{t('verify_cloud_body')}</Text>
              </div>
            ) : (
              <CompareTimeline
                reference={data.reference}
                ours={data.ours}
                durationMs={data.durationMs}
                waveformPeaks={null}
              />
            )}

            <CueList cues={data.ours} />
          </>
        )}
      </div>
    </Dialog>
  )
}

interface VerdictProps {
  diag: Diagnosis
  cloudBlocked: boolean
  onCorrect?: () => void
  correcting: boolean
  onDismiss: () => void
}

function Verdict({ diag, cloudBlocked, onCorrect, correcting, onDismiss }: VerdictProps) {
  const { t } = useT()
  // drift（帧率不匹配）**不给校正按钮**——平移修不好它，给了按钮就是骗人。
  // 这正是对照时间轴存在的价值：用户能从形状自己确认这个结论。
  const canCorrect = diag === 'shift' && onCorrect !== undefined
  const headKey = diag === 'drift' ? 'verify_verdict_drift_head'
    : diag === 'shift' ? 'verify_verdict_shift_head'
      : 'verify_verdict_unknown_head'
  const bodyKey = diag === 'drift' ? 'verify_verdict_drift_body'
    : diag === 'shift' ? 'verify_verdict_shift_body'
      : 'verify_verdict_unknown_body'

  return (
    <div className={`vinspect-verdict${diag === 'shift' ? '' : ' vinspect-verdict-neutral'}`}>
      <Text type="label" color="primary">{t(headKey)}</Text>
      <Text type="body" color="secondary">{t(bodyKey)}</Text>
      <div className="vinspect-btns">
        {canCorrect ? (
          <button
            type="button"
            className="vinspect-btn vinspect-btn-fix"
            onClick={onCorrect}
            disabled={correcting}
          >
            {correcting ? t('verify_correcting') : t('verify_correct_action')}
          </button>
        ) : null}
        <button type="button" className="vinspect-btn vinspect-btn-keep" onClick={onDismiss}>
          {canCorrect ? t('verify_keep_action') : t('verify_got_it')}
        </button>
      </div>
      {cloudBlocked && canCorrect ? (
        <Text type="supporting" color="secondary">{t("verify_cloud_blind_fix")}</Text>
      ) : null}
    </div>
  )
}

/** 台词列表：装错剧时扫一眼就能发现（台词跟这一集完全不搭）。 */
function CueList({ cues }: { cues: readonly TimelineCue[] }) {
  const { t } = useT()
  if (cues.length === 0) return null
  return (
    <div className="vinspect-cues">
      <div className="vinspect-cues-h">{t('verify_cues_heading')}</div>
      <div className="vinspect-cues-body">
        {cues.map((c, i) => (
          <div className="vinspect-cue" key={`${c.startMs}-${i}`}>
            <span className="vinspect-cue-t">{formatTick(c.startMs)}</span>
            <span className="vinspect-cue-x">{c.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
