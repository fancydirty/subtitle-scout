// web/src/workbench/StalledJobsNote.tsx —— 「有几件活记着失败了，而且再也没人去重试」。
//
// ══════════════════════════════════════════════════════════════════════════════
// 它补的那个洞
// ══════════════════════════════════════════════════════════════════════════════
// 生产实测（2026-08-13）：`jobs` 表 2 行 `state='failed'`（67 小时前挂载掉线期间失败），
// `next_retry_at` 过期 66 小时，而 jobs 队列**已无认领者**。三页产品没有任何地方读 jobs
// ——这两条在界面上**完全不存在**。用户既看不到它们，也无从知道系统对它们不再做任何事。
//
// ── 为什么"显示"而不是"清理"（后端 stalledJobsHealth.ts 有完整论证，此处只记结论）──
// 清理会抹掉挂载掉线期间的唯一账目，而且**不解决问题只让问题隐身**：jobs 今天仍有一个
// 活写入者（redispatch 端点），清理上线后用户每按一次就写一行悄悄被扫掉的记录。
// 采用的第三条路是：把**真相**说出来——「记着失败了，已经 X 没有再重试」。
// 这句话不声称"会重试"（那是假的），也不声称"永远不会"（那是把当前实现钉成结论）。
//
// ── 落点：活动页状态条，与另外三行并列 ──────────────────────────────────────
// 「引擎在不在动」（巡检态）/「引擎看不看得见我的库」（RootHealthNote）/
// 「引擎认不认得库里的东西」（UnidentifiedNote）/ **「引擎记着有活没干完」**（本行）。
// 同一个问题的第五个侧面，同形同语汇（一个标记 + 一句话），用户不必学第二套。
// count 为 0 时组件自己返回 null，健康的队列一个字都不占屏。
//
// ── 为什么不给按钮 ──────────────────────────────────────────────────────────
// 唯一可能的按钮是 `POST /api/v2/workflow/redispatch`，而它写出来的那一行**同样没人领**。
// 那是一个打不通的按钮——`UnidentifiedNote` 头注释里已经否掉的同一形态。
//
// ── 信息量边界（R-F9/R-F10）─────────────────────────────────────────────────
// 出：条数 + 最久那件过期了多久。不出 jobId / last_error / taskType / payload
// （排障读数，去处是 doctor 与日志，同 rootHealth / unidentifiedHealth 的既有裁决）。
//
// ── Carbon 双通道（R-F11 拒绝投影）────────────────────────────────────────
// ① 文字自己把话说全；② 形状复用 `root-health-mark`（**不发明第四种符号**）；
// ③ 颜色只是第三重。用 `failed` 那一档（实心）而不是 `unknown`（空心）：这**不是**
//    "我们不知道"——我们很确定这些活没在动，那是一个确定的坏消息。
import { useT } from '../i18n/useT.js'
import type { StalledJobsDTO } from '../api/types.js'
import { relAgo } from './inspectFreshness.js'

/**
 * 停摆的活提示。**`count === 0` → 返回 null（整段不渲染）**。
 *
 * `stalledJobs` 为 undefined/null（`/health` 还没回来 / 老后端没有这个字段）时同样返回
 * null：不知道就不说话——绝不因为"没拿到"而报一句"都好着呢"（fail-open 报绿，
 * 同 RootHealthNote / UnidentifiedNote 的既有论证）。
 */
export function StalledJobsNote({ stalledJobs }: { stalledJobs: StalledJobsDTO | null | undefined }) {
  const { t } = useT()
  if (!stalledJobs) return null
  const { count, overdueMs } = stalledJobs
  if (count === 0) return null

  return (
    <span
      className="root-health-line"
      data-kind="failed"
      data-testid="wb-stalled-jobs-line"
      role="status"
      aria-live="polite"
    >
      <span className="root-health-mark" aria-hidden="true" />
      {' '}
      {t('stalled_jobs_note').replace('{n}', String(count))}
      {/* 「已经 X 没有再重试」。**时长缺席时整段不出现**——不编一个时长出来
          （同 ActivityPage 里退避那一行的既有处置）。这个读数是用户判断"这值不值得管"
          的唯一依据：过期 10 分钟与过期 66 小时是完全不同的两件事。 */}
      {typeof overdueMs === 'number' && overdueMs > 0 && (
        <span data-testid="wb-stalled-jobs-age">
          {' '}
          {t('stalled_jobs_age').replace('{d}', relAgo(overdueMs))}
        </span>
      )}
    </span>
  )
}
