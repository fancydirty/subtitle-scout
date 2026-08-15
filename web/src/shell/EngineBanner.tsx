// web/src/shell/EngineBanner.tsx：**四页全局**的"引擎不会干活"细条。
//
// ══════════════════════════════════════════════════════════════════════════════
// 终局审计 🟡-4：此前它读的是 setup/status 的 `engineEnabled`，那是**错的判据**
// ══════════════════════════════════════════════════════════════════════════════
// 原来这一行是 `if (!data || data.engineEnabled) return null`。
// 后果：`engineEnabled === true && setupSatisfied === false` 时它判定"引擎开着"，
// 整条 banner 不渲染——而 daemon 此时**整轮跳过什么都不做**。
// 这个组合下，四个页面里只有活动页说得出真话（它的状态条读 `workPermitted`，
// 见 inspectFreshness.workPermission），媒体库/通知/设置三页**完全无提示**。
// 而 banner 存在的全部理由就是覆盖那三页。
//
// 改：判据换成 `/api/v2/health` 的 `workPermitted`（= engineEnabled && setupSatisfied，
// **后端同源计算**——与 daemon 派活调的是同一个函数，不是前端自己合取两个布尔）。
// 判决折叠复用 `workPermission()`，与活动页状态条**同一个函数**：
// 两处对"引擎为什么不干活"给出不同答案是本仓最典型的漂移形态，共用一个纯函数
// 在结构上就排除了它。
//
// ── 🔴 两种成因必须分开，因为用户的下一步动作**完全相反** ────────────────────
//   engine-off        开关关了      → 拨开关。banner 自己带按钮，一步到位。
//   setup-incomplete  凭据没配好    → 去 setup 页填 key。
//
// **setup 那一档绝不能给"开启"按钮**——这是本次改动里最要紧的一条：
// 那个 PUT 会成功（engine_enabled 是个独立的键，写它不需要凭据），banner 会变成
// 另一句话，用户于是以为自己修好了；而 daemon 照样一动不动，因为缺的是 TMDB/LLM。
// 一个"点了会成功、但什么也没解决"的按钮比没有按钮坏得多。故这一档给的是**导航**
// （去设置页），不是动作。
//
// ── fail-open 保留（§4.6 脏值哲学）──────────────────────────────────────────
// 加载中 / 拉取失败 → 不渲染。宁可少一条 banner，不可误报"引擎已关"。
// ⚠️ 这条与上面的"不许 `?? true` 兜底"（守备目录三态）**不矛盾**，两者的默认值方向
// 是各自算过的：守备目录那边报绿会掩盖一个真实存在的故障（挂载掉了，数据在烂）；
// 这边报红只会在一个健康的系统上挂一条假警报。两种错的代价不对称，故默认值不同。
//
// 用 shadcn Button——新 chrome 件直接落新栈。
import { useState } from 'react'
import { api } from '../api/client.js'
import { useHealth } from '../api/hooks.js'
import { useT } from '../i18n/useT.js'
import { localizeErrorValue } from '../lib/errorText.js'
import { Button } from '../components/ui/button.js'
import { workPermission } from '../workbench/inspectFreshness.js'
import { go } from './route.js'

export function EngineBanner() {
  const { t, lang } = useT()
  const { data, reload } = useHealth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // fail-open：还没拿到 /health 就不说话（见文件头）。
  if (!data) return null
  const perm = workPermission(data)
  // 🔴 判据是 workPermitted 的三态折叠，**不是** `data.engineEnabled`。
  // 'permitted' = daemon 真的会干活 → 没什么要说的。
  if (perm === 'permitted') return null

  const turnOn = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.updateSettings({ engine_enabled: 'true' })
      // reload 打的是 /health（不是 setup/status）：拨完开关之后 banner 该不该消失，
      // 取决于 workPermitted 而不是那个键本身——凭据仍缺时它**必须**留下来，
      // 换成 setup-incomplete 那一句。读 engineEnabled 的老写法在这里会直接消条，
      // 那就是"点了一下，提示没了，系统仍然什么都不做"。
      reload()
    } catch (e) {
      // PUT 失败不能静默——banner 留着、按钮复活、行内红字告知（同 wizard 步件的
      // saveError 先例）。reload 只在成功路径调，失败时状态未变，不需要重拉。
      setError(localizeErrorValue(e, lang))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="flex items-center gap-2 border-b border-border bg-card px-4 py-2 text-sm"
      data-perm={perm}
    >
      <span>{perm === 'engine-off' ? t('engine_banner_off') : t('engine_banner_setup')}</span>
      {perm === 'engine-off' ? (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void turnOn()}>
          {t('engine_banner_turn_on')}
        </Button>
      ) : (
        // setup 档：**导航**而不是动作（见文件头）。用 go() 而不是裸 <a href="#/settings">
        // ——route.ts 拥有 hash 的写法，两处各拼一份字符串是既有的漂移形态。
        <Button variant="ghost" size="sm" onClick={() => go('settings')}>
          {t('engine_banner_go_setup')}
        </Button>
      )}
      {error && <span className="text-fn-red">{error}</span>}
    </div>
  )
}
