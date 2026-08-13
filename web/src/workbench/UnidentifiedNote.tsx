// web/src/workbench/UnidentifiedNote.tsx —— 「有几个目录我认不出来」的**可见形态**。
//
// ══════════════════════════════════════════════════════════════════════════════
// 病 A 第 7 例的最后一跳
// ══════════════════════════════════════════════════════════════════════════════
// 链条：daemonV2.scanOnce 写 `files`（新文件 `work_id` NULL）→ identifyScheduler 按
//   `work_id IS NULL` 取件识别 → 识别不出则退避、`tmdb-404` 则**永久退出队列**
//   → `buildUnidentifiedHealth` 汇总（谓词刻意含 404 那批）→ `/api/v2/health` 的
//     `unidentified` → **本组件**（第一个把它画出来的地方）。
// 此前这条链的终点是"什么都没有"：用户媒体库里有文件永远不被处理，他无从得知。
//
// ── 为什么落在活动页状态条，而不是新页面 / 媒体库 / 通知页 ────────────────────
// ① **不新增第四个页面**（三页产品：活动 / 通知 / 媒体库 + 设置）。
// ② **不进媒体库页**：R-F2「识别失败的孤儿不露出」的作用域正是那一页的海报墙。
//    且结构上也做不到——卡片要标题/海报/年份/季集网格，那些全来自 `works` 行，
//    识别失败时它们不存在。
// ③ **不进通知页**：那一页是「成果流水」（R-F3 保留一周的 found 事件）。
//    "有东西认不出来"是一个**持续状态**，不是一次性成果——塞进倒序流水里，
//    它会在用户下次刷新时被新成果推走，而问题还在。
// ④ **不占显眼位置**（R-F1 的精神：识别耗时短、用户能做的只有改文件名）。故它与
//    `RootHealthNote` 同形、并列在状态条里：一个标记 + 一句话，**零为 0 时不占一个字**。
//    三行说的是同一个问题的三个侧面——「引擎在不在动」「引擎看不看得见我的库」
//    「引擎认不认得我的库里的东西」。用户不必学第二套语汇。
//
// ── 为什么不给任何按钮（R-F1「未识别资源不给用户改」）────────────────────────
// 想过并否掉的两个：
//  · 「重新识别」——它是拿**同一批没变过的字节**再跑一遍同一个 agent。identifyScheduler
//    已经每天自动重试一次（retryDelayMs 恒 24h）；`tmdb-404` 那批则是"TMDB 确认没有这个
//    东西"，重跑一万次结果一样。这个按钮的真实效果是让用户**付费重摇 LLM**，且失败时
//    他会以为是自己点得不对。唯一能改变结果的输入是**文件名**，而那不在浏览器里。
//  · 「忽略」——它要往库里写一条"用户说这个不用管"的状态。那正是 R-F1 禁的「改」
//    （用户在 UI 里指派/压制未识别资源的处置），且会立刻长出第二个问题：忽略之后
//    用户改好了名字，系统还认不认？（要么它永久哑掉，要么这个按钮其实没生效。）
// 与 RootHealthNote 同一条既有裁决：「这条提示对应的动作在**用户的机器上**，
// 界面上没有任何按钮能替他做，画一个只会是打不通的按钮。」
// 故本组件的动作面就是**那句文案里的 `片名 (年份)`**——它把"该干什么"说清楚了。
//
// ── Carbon 双通道（R-F11 拒绝投影）────────────────────────────────────────
// ① 文字自己把话说全（去掉全部 CSS 信息量一个字不少）；
// ② 形状：**空心方块**，复用 `root-health-mark` 那一族——刻意不发明第三种形状。
//    状态条里现有两个圆点（巡检态 / 实时读数过期）+ 方块（守备目录），已经是两种形状
//    四个语义的上限；再造一种（三角/菱形）会让用户与色觉障碍者需要记第五个符号。
//    空心而非实心：这**不是故障**（库是好的、目录读得到，只是名字没按规范写），
//    语气必须与 `root_health_unknown` 那一档一致，绝不用 failed 的 amber。
// ③ 颜色只是第三重（走 `unknown` 那档的 muted 灰）。
import { useT } from '../i18n/useT.js'
import type { UnidentifiedHealthDTO } from '../api/types.js'

/**
 * 认不出来的目录提示。**`dirCount === 0` → 返回 null（整段不渲染）**。
 *
 * `unidentified` 为 undefined/null（`/health` 还没回来，或这一页没拿到）时同样返回 null：
 * 不知道就不说话——绝不因为"没拿到"而报一句"都认出来了"（那是 fail-open 报绿，
 * 正是这整条链要防的那句假话，同 RootHealthNote 的既有论证）。
 */
export function UnidentifiedNote({ unidentified }: { unidentified: UnidentifiedHealthDTO | null | undefined }) {
  const { t } = useT()
  if (!unidentified) return null
  const { dirCount, dirs } = unidentified
  if (dirCount === 0) return null

  // 🔴 尾巴按 `dirCount - dirs.length` 算，**不是** `dirCount > MAX_LISTED_DIRS`：
  // 上限是后端的常量，前端复述一份必然漂移（C30 老教训）。差值 > 0 就说"另外还有 N 个"，
  // 后端把上限改成 20 时这里自动正确。
  const hiddenCount = dirCount - dirs.length

  return (
    // role="status" + aria-live="polite"：这是一条**背景事实**，不是对用户操作的回应，
    // 也不是需要抢读的故障（role="alert" 留给真正打断用户的东西）。同 RootHealthNote。
    <span
      className="root-health-line"
      data-kind="unknown"
      data-testid="wb-unidentified-line"
      role="status"
      aria-live="polite"
    >
      <span className="root-health-mark root-health-mark-hollow" aria-hidden="true" />
      {' '}
      {t('unidentified_note')}
      {': '}
      {/* 目录名走 mono——同守备目录路径那套"技术性读数"的排印语言。
          **必须列出来**：用户有好几个目录认不出来时，只说"有 3 个"等于让他挨个去猜。
          这不是排障细节，这是这条提示唯一可操作的部分（同 root-health-paths 的裁决）。
          ⚠️ 出的是**目录名**（后端已剥掉挂载点前缀），不是绝对路径。 */}
      <span className="root-health-paths">
        {dirs.map((d) => d.dirName).join(', ')}
      </span>
      {/* 截断尾巴。`dirs` 只有前 8 个，总数一律读 dirCount——拿 dirs.length 当总数
          会在超过上限时对用户**少报**，而那正是这条提示最该说清楚的时刻。 */}
      {hiddenCount > 0 && (
        <span data-testid="wb-unidentified-more">
          {t('unidentified_more').replace('{n}', String(hiddenCount))}
        </span>
      )}
    </span>
  )
}
