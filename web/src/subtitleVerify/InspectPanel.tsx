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
import { Dialog } from '@astryxdesign/core/Dialog'
import { DialogHeader } from '@astryxdesign/core/Dialog'
import { Text } from '@astryxdesign/core/Text'
import { CompareTimeline, type TimelineCue } from './CompareTimeline.js'
import { formatTick } from './viewport.js'
import { useT, type TKey } from '../i18n/useT.js'
import type { SubtitleCompareDTO, CompareDiagnosis } from '../api/types.js'

interface Props {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** 数据加载中时为 null——面板先开、内容后到，比等数据到了才开更跟手 */
  data: SubtitleCompareDTO | null
  loading: boolean
  error: string | null
  /** 点「校正时间轴」。后端判 fixable=false 时不渲染这个按钮，所以可以缺席 */
  onCorrect?: () => void
  correcting?: boolean
}

/**
 * 结论条的文案 key。四档判读 → 两个 key，**判定不在这里做**。
 *
 * 审计 I-B1/I-B2 之前这里有一个 `diagnose()`：从两轨时间戳做几何推断，只看偏移的绝对值
 * （于是偏早的字幕拿到"字幕比画面慢了"这句说反的话），且按下标配对（于是两条完全同步
 * 但开头少 3 条 cue 的轨被判成需要平移）。更要紧的是它是**第二个判定引擎**，与后端的
 * Jaccard 结论随时可能矛盾，而它把着写按钮的闸。现在判定只在
 * src/dashboard/subtitleCompareApi.ts 的 diagnoseRow 里做一次，前端只做 key 映射。
 */
function headKeyOf(diagnosis: CompareDiagnosis): TKey {
  switch (diagnosis) {
    // 符号有了之后必须分开说：说反方向和不说一样糟——用户会按错的方向去理解那张图。
    case 'behind': return 'verify_verdict_behind_head'
    case 'ahead': return 'verify_verdict_ahead_head'
    case 'not-a-shift': return 'verify_verdict_drift_head'
    default: return 'verify_verdict_unknown_head'
  }
}

function bodyKeyOf(diagnosis: CompareDiagnosis): TKey {
  switch (diagnosis) {
    case 'behind': return 'verify_verdict_behind_body'
    case 'ahead': return 'verify_verdict_ahead_body'
    case 'not-a-shift': return 'verify_verdict_drift_body'
    default: return 'verify_verdict_unknown_body'
  }
}

export function InspectPanel({
  isOpen, onOpenChange, title, data, loading, error, onCorrect, correcting,
}: Props) {
  const { t } = useT()
  // 云盘：检测照常做（只读字幕文件），但对照图画不出来（抽音频要 >120s，
  // 每次 seek 付 CDN 延迟地板）。这是网盘的物理限制，不是功能没做——文案要说清这个区别。
  const cloudBlocked = data !== null && data.mountKind === 'cloud'
  // 无参考源（2026-07-31）：约一半条目是这一档——内嵌轨全是 PGS 位图字幕（抽不出文本
  // 时间轴）、同目录也没有第二份同集字幕。后端此时返回 200 + 空 reference 数组
  // （见 subtitleCompareApi 头注释里那三条理由），不是错误。
  //
  // 单轨视图仍然有用，这也是"让用户自己看"这条产品承诺的落点：
  //  - 能看出"字幕只翻了前半集"这类分布问题（后半段一片空白）
  //  - 用户对着画面就能自己判断偏没偏——这是我们无法自动完成的那部分
  // 音频 VAD 那条路实测走不通：偏移量准（±100ms）但相似度只有 0.36~0.54，因为
  // silencedetect 把音乐/音效都算成说话（实测音频 1953s vs 字幕 1470s）。
  const noReference = data !== null && data.reference.length === 0

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
              noReference={noReference}
              diagnosis={data.diagnosis}
              fixable={data.fixable}
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
  /** 无参考源——结论条改说"没东西可比，你自己看"，而不是含糊的"看不出问题在哪"。 */
  noReference: boolean
  diagnosis: CompareDiagnosis
  fixable: boolean
  cloudBlocked: boolean
  onCorrect?: () => void
  correcting: boolean
  onDismiss: () => void
}

function Verdict({ noReference, diagnosis, fixable, cloudBlocked, onCorrect, correcting, onDismiss }: VerdictProps) {
  const { t } = useT()
  // 平移修不好的（帧率不匹配、装错剧集）**不给校正按钮**——给了按钮就是骗人。
  // 这正是对照时间轴存在的价值：用户能从形状自己确认这个结论。
  // `fixable` 来自后端那一行结论，与 correctSubtitle 允不允许写盘同源。
  const canCorrect = fixable && onCorrect !== undefined

  return (
    <div className={`vinspect-verdict${fixable ? '' : ' vinspect-verdict-neutral'}`}>
      {/* 无参考源时给专门的文案：泛泛的"看不出问题在哪"会让用户以为我们查过了没发现问题，
          而真相是**压根没东西可比**。这个区别决定了他接下来该做什么（自己看一眼画面）。 */}
      <Text type="label" color="primary">
        {noReference ? t('verify_verdict_noref_head') : t(headKeyOf(diagnosis))}
      </Text>
      <Text type="body" color="secondary">
        {noReference ? t('verify_verdict_noref_body') : t(bodyKeyOf(diagnosis))}
      </Text>
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
