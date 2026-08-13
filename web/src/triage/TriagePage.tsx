// web/src/triage/TriagePage.tsx：甄别 tab 主体（dashboard-F5）——单列收件箱：页头 + 四区竖排
// （Pending → Excluded → Timing → Dormant，spec §5.5；后三区空则各自渲染 null，单列自然略过）。
// 数据面：GET /api/v2/triage 一次拿全 pending，翻案后手动 reload（useTriage 不轮询）；Timing/Dormant
// 两区组件自取数。认领已退役（见 src/v2/triageOps.ts 头注释）。
//
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🟡 2026-08-13「TriagePage 去留」裁决：**雪藏保留**。本段是这件事的**正本**——
 *    其余各处（shell/ 四处雪藏注释、subtitleVerifyRepo.ts、apiV2.ts 的
 *    buildDormantTasks、FRONTEND-IMPL-DESIGN.md 的清点表）一律只留指针，不重抄论证。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── 0. 为什么需要这一段 ────────────────────────────────────────────────────
 * 此前两份材料给了**相反**的处置，谁也没引用谁：
 *   · `docs/design/2026-08-11-FRONTEND-IMPL-DESIGN.md` 的旧前端清点表判「删」
 *     （依据：「已被雪藏」——但那张表把整页当成一块死肉，见下面第 2 条，那是**错的**）；
 *   · `src/v2/subtitleVerifyRepo.ts` 头注释（2026-08-12，更新）把「再把 TriagePage
 *     挂回 AppShell」写成 verify 族的**恢复路径**——即判「留」。
 * 用户裁决：**都留，把冲突文档改一致**。这一段就是那句统一的话。
 *
 * ── 1. 现状（三句，别多说也别少说）────────────────────────────────────────
 * 甄别页于 2026-08-07（spec §5）雪藏：**代码全在**（6 个源文件 + 5 个测试文件，合 11 文件
 * 1077 行；PendingBox 无独立测试，由 TriagePage.test.tsx 覆盖）、
 * **导航里没有**（`shell/tabs.ts` 的 TABS 三项无它、`shell/route.ts` 的 Tab 联合无
 * 'triage'、`shell/AppShell.tsx` 不 import 它）、**用户看不到**（旧书签 `#/triage` 由
 * `isTab()` 兜底降级到 DEFAULT_TAB，不白屏也不 404）。
 *
 * ── 2. 为什么留（三条，各自绑一族——⚠️ 不是"整页都是死肉"）──────────────
 * 四个区**分属三族，死活各不相同**。把它们当成一块处置是上一轮判「删」的成因：
 *
 *   区          数据源                              数据面死活
 *   ─────────── ─────────────────────────────────── ────────────────────────────
 *   PendingBox  GET /api/v2/triage → buildParked    ✅ **活**：parked_paths 有活
 *               → parked_paths                        写入者（ingest.ts 三处
 *                                                     upsertParkedPath，经 daemonV2
 *                                                     requestIngest / 设置页"立即
 *                                                     扫描"两条活路径可达）
 *   ExcludedBox 同上（parkReason='excluded-extra'    ✅ **活**（含写：unexclude 是
 *               分桶）+ POST /triage/unexclude          活的域操作，见 triageOps.ts）
 *   TimingBox   GET /subtitle/shifted +              ⚠️ **空转**：subtitle_verify 表
 *               POST /subtitle/{correct,revert}         的写入环封闭无入口，shifted
 *                                                     恒 []（verify 族）
 *   DormantBox  GET /workflow/dormant → jobs         ⚠️ **只剩墓碑行**：dormant 零
 *               (state='dormant')                      活写入者（jobs 族）
 *   text.ts     —（四区共用的纯函数库）             —
 *
 *   (a) **它是 verify 族唯一的恢复载体**。`subtitleVerifyRepo.ts` §「反过来，恢复它
 *       只需要」明写恢复路径 = 接 runVerifySweep + **把 TriagePage 挂回 AppShell**。
 *       TimingBox 是那 246 条用例算法资产（时间轴偏移检测/参考源选取/带备份的幂等平移）
 *       在前端的**唯一出口**。删页 = 单方面拆掉另一轮裁决的恢复路径。
 *   (b) **dormant 是三页产品里没有后继的显示位**。活动/通知/媒体库三页没有任何地方
 *       呈现「自动重试已永久停止」——而 dormant 恰恰是最不该静默的一种状态。这与
 *       同轮被删的 `buildWorkflowWorkers` 的分界线正在这里（那个的显示位已有活后继）。
 *       完整论证在 `src/dashboard/apiV2.ts` 的 buildDormantTasks 头注释。
 *   (c) **parked 事实在前端只有这一个读取面**。删页 = parked_paths 变成"有活写入者
 *       却零读取面"，那正是本仓病 A 的形状，只是换了个方向。⚠️ 这条是上一轮清点表
 *       漏掉的事实——它判「删」时以为整页都读不到活数据。
 *
 * ── 3. 什么时候可以删（**可证伪的判据：一条能跑的命令**）──────────────────
 * 🔴 **三条必须同时成立**，缺一条都不许删。它们分别对应第 2 条的 (a)(b)(c)。
 *
 * 🔴 **可执行原文在 `src/dashboard/triageShelved.orphan.test.ts` 的头注释**（那是行注释
 *    区，能原样容纳 glob 里的星号斜杠；本块注释抄进来会提前闭合，故这里只做说明）。
 *    三条依次是：
 *
 *   1. verify 族：`rg` 找 `runVerifySweep(` 在 `src/v2/daemonV2.ts` 里的调用；
 *   2. jobs 族：`rg -l` 找 `^import ... from './handleWorkerTask.js'`，
 *      排除 `*.test.ts` 与 `cli/handleWorkerTask.ts` 自身；
 *   3. parked 族：`rg -l` 找 `useTriage(` 在 `web/src` 下的调用，
 *      排除 triage 与 api 两个目录。
 *
 * **三条全部无输出（exit=1）= 三族都仍是孤儿 = 判据尚未触发 = 不许删**（2026-08-13
 * 实跑正是这个状态）。
 *
 * ⚠️ 第 2、3 条的排除项**是实跑校准过的，别按直觉简写**——两个坑都真踩过：
 *   · 第 2 条若沿用 `handleWorkerTask.orphan.test.ts` 头注释里那个旧形态
 *     （`rg -l "from './handleWorkerTask.js'" src --glob '!*.test.ts'`），今天会命中两个
 *     假阳：`dashboard/apiV2.ts`（**头注释里引用了这条命令本身**）与
 *     `cli/handleWorkerTask.ts`（自己）。锚 `^import` 挡散文，排除自身挡自指。
 *     那两处的命令行已在本轮一并更正。
 *   · 第 3 条的排除 glob 必须带 `**` 前缀：rg 的 `-g` 相对**搜索根**匹配，而搜索根是
 *     `web/src`，写成 `triage` 开头的相对式匹配不到 `web/src/triage/...`，
 *     于是把本该排除的两个文件原样吐回来。
 *
 * 任意一条**有**输出，就该重读本段而不是直接动手：
 *   (a) 第 1 条有输出 → verify 族活了（环有入口）→ TimingBox 从"空转 UI"变成"有数据
 *       却没人看得到的 UI"，必须回答它在三页产品的哪一页露出；
 *   (b) 第 2 条有输出 → jobs 队列被接回 claim → dormant 重新是活事实，同上须回答露出位；
 *   (c) 第 3 条有输出 → parked 有了第二个读取面 → (c) 这条保留理由消失。
 * 只有当 (a)(b) 两族被**整族退役**（不是复活）、且 (c) 有了替代读取面时，
 * 本页才连同 6 源 5 测试一起删。
 *
 * ⚠️ **判据与 verify 族同进退，不许一个删一个留**：TimingBox 的去留完全由
 *    `subtitleVerifyRepo.ts` §4 那条判据决定，本页不得单独裁决它；反之那份裁决要删
 *    整族时，本页的 TimingBox 必须跟着走（它已被列进那份裁决的删除清单）。
 *    同理 DormantBox ↔ jobs 族（`apiV2.ts` buildDormantTasks §4 + 那条已有守卫）。
 *
 * 🔴 **不许只删一半**（删 TimingBox 留 DormantBox、删端点留区、删页留端点，都算）：
 *    那会留下一族无出口的资产或一个无数据的 UI，是同一种病换个方向。
 *
 * ── 4. 这段话有机器载体，不是散文 ─────────────────────────────────────────
 * `src/dashboard/triageShelved.orphan.test.ts` 钉住上面全部四件事：四区完整性（阳性
 * 对照，防"删一半"与恒绿）、TriagePage 零 importer、判据第 1 条、判据第 3 条。判据第
 * 2 条不在那里重复实现（`src/cli/handleWorkerTask.orphan.test.ts` +
 * `src/dashboard/dormantReadSurface.orphan.test.ts` 已经钉着，两份判据必然漂移）。
 * **它们红了不等于错，等于"该重读本段了"。**
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { Section } from '../components/ui/section.js'
import { EmptyState } from '../components/ui/empty-state.js'
import { Button } from '../components/ui/button.js'
import { useTriage } from '../api/hooks.js'
import { api } from '../api/client.js'
import { useT } from '../i18n/useT.js'
import { PendingBox } from './PendingBox.js'
import { ExcludedBox } from './ExcludedBox.js'
import { TimingBox } from './TimingBox.js'
import { DormantBox } from './DormantBox.js'
import { groupPending } from './text.js'

export function TriagePage() {
  const { t } = useT()
  const triage = useTriage()

  const head = (
    <div className="flex flex-col gap-1">
      <h1 className="m-0 text-[19px] font-semibold leading-7 text-foreground">{t('triage_page_title')}</h1>
      <span className="text-[13px] leading-5 text-muted-foreground">{t('triage_subtitle')}</span>
    </div>
  )

  if (triage.loading && !triage.data) {
    return (
      <Section>
        {head}
        <span className="font-mono text-[13px] leading-5 text-muted-foreground">loading…</span>
      </Section>
    )
  }
  if (triage.error && !triage.data) {
    return (
      <Section>
        {head}
        <EmptyState
          title={t('triage_error_prefix') + triage.error}
          actions={
            <Button variant="secondary" onClick={triage.reload}>
              {t('triage_retry_label')}
            </Button>
          }
        />
      </Section>
    )
  }
  if (!triage.data) return null

  const { actionable, excluded } = groupPending(triage.data.pending)

  const handleRestore = async (path: string) => {
    await api.unexclude(path)
    triage.reload()
  }

  return (
    <Section>
      <div className="flex flex-col gap-4">
        {head}
        <div className="triage-boxes">
          <PendingBox actionable={actionable} />
          <ExcludedBox excluded={excluded} onRestore={handleRestore} />
          <TimingBox />
          <DormantBox />
        </div>
      </div>
    </Section>
  )
}
