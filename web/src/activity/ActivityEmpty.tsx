// web/src/activity/ActivityEmpty.tsx：活动页的空态——**没有在跑的活**时这一页显示什么（spec §7.1）。
//
// 这是这个产品最常见的状态（守护进程大部分时间无事可做），所以它不是"边缘情况的兜底"，
// 而是用户看得最多的一屏。
//
// ── 裁决 L6：不写「字幕都齐了」──────────────────────────────────────────────
//
// 用户原话：「Steam 只显示完成列表」。所以这个组件里**没有**"都齐了 / 全部完成 / 一切正常"
// 那一族**断言句**，连一个可以被填上那句话的横幅槽位都不存在（同 ActivityDone 的手法）。
// 测试有回归锁扫那一族措辞。
//
// 这条比它看起来更容易被改坏——"空态嘛，加一句『全部完成！』更友好"是个极自然的改进，而它
// 恰恰是用户明确否掉的东西。而且它**还是假话**：前端手上只有 running/pending/recent 三个窗口，
// 压根看不到"库里还缺不缺"。pending 空只意味着"没有待办"，不意味着"没有缺口"——被 park /
// dormant 的条目根本不在 pending 里。断言"齐了"是编造（DESIGN.md §8：前端只呈现事实）。
//
// 取而代之的是 idleLine()：一句**此刻运行态**的诚实事实（"现在没有在处理的字幕"）。它断言的
// 东西正好就是调用方决定渲染空态的判据本身，所以它恒为真。
//
// ── 为什么**必须**有新鲜度时间戳（这一条是本文件的核心，不许省）──────────────────
//
// 时间戳是唯一「崩掉的系统 produce 不出来」的廉价元件。
//
// 一个只说"没有在处理"的空态有两种可能——真的没活可干，或者守护进程已经死了——而用户**无从
// 分辨**。NN/G 记载：未加限定的空态是最伤信任的设计。加上"3 分钟前刚检查过"之后，这一屏就从
// 一句可能是谎话的安慰变成一个**可核对的事实**：时间戳会自己变旧，守护死了它就停在那里发臭，
// 用户下次进来一眼看见"最近检查 6 天前"。
//
// 所以 idleLine + lastCheckedLine 这两行是**无条件渲染**的：它们保证空态永远不是一张白页，
// 哪怕 recent 为空、哪怕这台机器从没扫过盘。
//
// ⚠️ lastScanAt 为 null 时**绝不编一个时刻**（"刚刚"）——那句谎话恰好谎在上面这段论证的要害上：
// 它把"从没扫过 / 守护死了"伪装成"刚刚检查过，一切正常"。如实说"还没扫过"，判断留给用户。
// 落地在 text.ts 的 lastCheckedLine，测试对着这个分支有回归锁。
//
// ── 铁律 ────────────────────────────────────────────────────────────────
//
// 铁律①只有绿和红，没有黄：这一屏**一个状态色都不用**。空态不是"好"也不是"坏"，它是中性
//    事实——所以全屏走灰（--color-text-gray / secondary），没有绿钩、没有红点，尤其没有黄。
//    "空 = 一切正常 = 打个绿勾"是另一版同型的错误：绿勾也是在断言库的完备性。
//
// 铁律②零数字：不显示百分比、不显示分数。在场的数字只有相对时间（"3 分钟前"——时间事实）
//    与"12 / 282 已检查"（**裸计数**，不是评分也不是百分比，spec 判据 5 明确允许）。
//
// 铁律③不暴露机械：文案里不出现 agent/orchestrator/worker/pass/asset/ledger/job。
//
// L4「必须有图」在空态的落地：图由下面的**完成列表**（ActivityDone，38px 2:3 海报）提供——
//    spec §7.1 逐字要求"用与 hero 同几何的海报"，ActivityDone 用的正是 .act-row-poster 那一档。
//    recent 为空时这一段整个不渲染：此刻**没有任何主语可以配图**，凭空放一张图/一个插画空态
//    是装饰而不是信息（且 L4 那条裁决讲的是"活动页不能没有内容图"，不是"必须填满像素"）。
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'
import { useT } from '../i18n/useT.js'
import type { WorkflowFreshnessDTO, WorkflowRecentRunDTO } from '../api/types.js'
import { ActivityDone } from './ActivityDone.js'
import { checkedCountLine, idleLine, lastCheckedLine } from './text.js'

interface Props {
  /** GET /api/v2/workflow/pending 的 `meta`——新鲜度事实的唯一来源。 */
  meta: WorkflowFreshnessDTO
  /** WorkflowWorkersDTO.recent[]。空数组 → 完成段不渲染（见文件头 L4 那段）。 */
  recent: readonly WorkflowRecentRunDTO[]
  /** 渲染时刻，算相对时间用。由调用方注入（不在组件内读 Date.now）——同 hero/ActivityDone 的
   *  既有口径：时间是入参而非副作用，测试才能确定性地断言读数。 */
  now: number
  /** 完成行的「查看」被点。缺席 → 不渲染按钮（同 ActivityDone 的口径）。 */
  onOpen?: (row: WorkflowRecentRunDTO) => void
}

export function ActivityEmpty({ meta, recent, now, onOpen }: Props) {
  const { lang } = useT()
  // 字幕校验巡检的推进度。显示条件抄 SummaryLine.tsx:71 的既有裁决（已过审计），**不在
  // text.ts 里判**——那层是纯格式化：
  //  - 巡检从未跑过（lastVerifySweepAt === null）→ 不显示。此时 "0 / 282" 会读成"这功能坏了"，
  //    而真相是它还没到第一个时间门。
  //  - 已铺满（done >= total）→ 不显示。"282 / 282 已检查"是一句没有信息的废话，而这一页的
  //    既有哲学是不给不携带信息的占位。
  const showChecked =
    meta.lastVerifySweepAt !== null && meta.verifiableItems > 0 && meta.verifiedItems < meta.verifiableItems

  return (
    // ⚠️ 这一段里**只有**两行事实（+ 可选的裸计数）+ 完成列表。没有横幅、没有插画、没有绿勾、
    //    没有"全部完成"——L6。也没有任何按钮：空态没有需要用户做的决定。
    <section className="act-empty" data-testid="activity-empty">
      <VStack gap={1} className="act-empty-facts">
        {/* 诚实状态行。**无条件渲染**——它是空态永不为白页的第一道保证。 */}
        <Text type="body" color="secondary" data-testid="activity-empty-idle">
          {idleLine(lang)}
        </Text>
        <HStack gap={2} vAlign="center">
          {/* 新鲜度时间戳。同样**无条件渲染**（lastScanAt 为 null 时如实说"还没扫过"，
              不是不渲染也不是编一个时刻）——见文件头那段论证：这是唯一崩掉的系统
              produce 不出来的元件，它不能有"缺席"这个状态。 */}
          <Text type="code" className="act-empty-stamp" data-testid="activity-empty-stamp">
            {lastCheckedLine(meta.lastScanAt, now, lang)}
          </Text>
          {showChecked ? (
            <Text type="code" className="act-empty-stamp" data-testid="activity-empty-checked">
              {checkedCountLine(meta.verifiedItems, meta.verifiableItems, lang)}
            </Text>
          ) : null}
        </HStack>
      </VStack>
      {/* 完成列表：复用 ActivityDone（38px 2:3 海报 = spec §7.1 要求的"与 hero 同几何"）。
          它自己在 recent 为空时返回 null——空态因此优雅退化成上面那两行事实，而不是一段
          带标题的空壳。 */}
      <ActivityDone recent={recent} now={now} onOpen={onOpen} />
    </section>
  )
}
