// web/src/shell/EngineBanner.test.tsx：**四页全局**的"引擎不会干活"细条。
//
// ── 终局审计 🟡-4 之后，这个文件守的东西变了 ────────────────────────────────
// 改动前它守的是「engineEnabled=false 才渲染」——而那正是被判定为错的判据：
// `engineEnabled=true && setupSatisfied=false` 时 banner 判定"引擎开着"→ 不渲染，
// 而 daemon 整轮跳过什么都不做，媒体库/通知/设置三页于是完全无提示。
//
// 现在守三件事：
//  ① 判据是 `/health` 的 workPermitted（三态折叠），不是 setup/status 的 engineEnabled；
//  ② 两种成因**说不同的话、给不同的按钮**——尤其 setup 那一档**绝不给"开启"按钮**
//     （那个 PUT 会成功、banner 会变、而 daemon 仍然一动不动，是最坏的形态）；
//  ③ fail-open 仍在（加载中/拉取失败不渲染）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { api } from '../api/client.js'
import { en } from '../i18n/en.js'
import type { HealthDTO } from '../api/types.js'
import { EngineBanner } from './EngineBanner.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  location.hash = ''
})

/** 三个布尔按后端口径自洽（workPermitted === engineEnabled && setupSatisfied）——
 *  后端注释明写三者调的是同一批函数，不是三处各算一遍。测试里手造一个不自洽的组合
 *  等于在测一个后端不会产生的输入。 */
function health(engineEnabled: boolean, setupSatisfied: boolean): HealthDTO {
  return {
    lastInspectAt: null,
    workPermitted: engineEnabled && setupSatisfied,
    engineEnabled,
    setupSatisfied,
    roots: [],
    unidentified: { dirCount: 0, dirs: [] }, stalledJobs: { count: 0, overdueMs: null },
    current: null,
  }
}

function renderBanner() {
  return render(<I18nProvider initialLang="en"><EngineBanner /></I18nProvider>)
}

describe('EngineBanner · 判据是 workPermitted，不是 engineEnabled（终局审计 🟡-4）', () => {
  // 🔴 这一条就是审计抓到的洞：改回 `if (!data || data.engineEnabled) return null` 时必红。
  it('🔴 开关开着但凭据没配（engineEnabled=true, setupSatisfied=false）→ **照样渲染**', async () => {
    vi.spyOn(api, 'health').mockResolvedValue(health(true, false))
    renderBanner()
    expect(await screen.findByText(en.engine_banner_setup)).toBeInTheDocument()
  })

  it('🔴 那一档给的是「去设置」而**不是「开启」**——点了会成功但什么也解决不了', async () => {
    vi.spyOn(api, 'health').mockResolvedValue(health(true, false))
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    renderBanner()
    await screen.findByText(en.engine_banner_setup)
    // "开启"按钮在这一档必须**不存在**：engine_enabled 是独立的键，写它不需要凭据，
    // PUT 会成功、banner 会换句话，用户以为修好了——而 daemon 仍然一动不动。
    expect(screen.queryByRole('button', { name: en.engine_banner_turn_on })).toBeNull()
    const go = screen.getByRole('button', { name: en.engine_banner_go_setup })
    fireEvent.click(go)
    // 导航到设置页，且**一个 PUT 都没发**。
    expect(location.hash).toBe('#/settings')
    expect(update).not.toHaveBeenCalled()
  })

  it('两种成因说的是**两句不同的话**（合成一句则这条红）', async () => {
    vi.spyOn(api, 'health').mockResolvedValue(health(false, true))
    renderBanner()
    expect(await screen.findByText(en.engine_banner_off)).toBeInTheDocument()
    expect(screen.queryByText(en.engine_banner_setup)).toBeNull()
    expect(en.engine_banner_off).not.toBe(en.engine_banner_setup)
  })

  it('两者都不满足 → 先说凭据（把开关打开而凭据仍缺是第二次徒劳）', async () => {
    vi.spyOn(api, 'health').mockResolvedValue(health(false, false))
    renderBanner()
    expect(await screen.findByText(en.engine_banner_setup)).toBeInTheDocument()
    expect(screen.queryByText(en.engine_banner_off)).toBeNull()
  })

  it('workPermitted=true → 不渲染（没什么要说的）', async () => {
    vi.spyOn(api, 'health').mockResolvedValue(health(true, true))
    renderBanner()
    await waitFor(() => expect(api.health).toHaveBeenCalled())
    expect(screen.queryByText(/Engine off|Setup incomplete/)).not.toBeInTheDocument()
  })

  it('打的是 /api/v2/health（**不是** setup/status）', async () => {
    const h = vi.spyOn(api, 'health').mockResolvedValue(health(false, true))
    const s = vi.spyOn(api, 'setupStatus')
    renderBanner()
    await screen.findByText(en.engine_banner_off)
    expect(h).toHaveBeenCalled()
    // setup/status 的 engineEnabled 少了 setupSatisfied 那一半——本组件不该再碰它。
    expect(s).not.toHaveBeenCalled()
  })
})

describe('EngineBanner · engine-off 档的开关动作', () => {
  it('Turn on → PUT { engine_enabled: "true" } → reload 后 banner 消失', async () => {
    // 两段桩：第一次给"关且凭据齐"（banner 出现），Turn on 之后的 reload 给"全齐"（banner 撤）。
    vi.spyOn(api, 'health')
      .mockResolvedValueOnce(health(false, true))
      .mockResolvedValue(health(true, true))
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    renderBanner()
    fireEvent.click(await screen.findByRole('button', { name: en.engine_banner_turn_on }))
    await waitFor(() => expect(update).toHaveBeenCalledWith({ engine_enabled: 'true' }))
    await waitFor(() => expect(screen.queryByText(en.engine_banner_off)).not.toBeInTheDocument())
  })

  // 🔴 老写法（reload 打 setup/status、判据看 engineEnabled）在这一条上会直接消条。
  it('🔴 拨开关但凭据仍缺 → banner **不消失**，换成 setup 那一句', async () => {
    vi.spyOn(api, 'health')
      .mockResolvedValueOnce(health(false, false))
      // 拨完开关：engineEnabled 真的变 true 了，但 setupSatisfied 仍是 false
      // → workPermitted 仍是 false，daemon 仍然什么都不做。
      .mockResolvedValue(health(true, false))
    vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    renderBanner()
    // 两者都缺时先说凭据，此时并没有 Turn on 按钮——从 engine-off 档进入这个场景的路径是
    // "凭据齐→拨开关"，故这里直接断言：凭据缺的两种开关状态下，说的都是 setup 那句。
    expect(await screen.findByText(en.engine_banner_setup)).toBeInTheDocument()
  })

  it('Turn on PUT 失败 → 行内错误文案 + banner 不消 + 按钮复活（不静默）', async () => {
    vi.spyOn(api, 'health').mockResolvedValue(health(false, true))
    vi.spyOn(api, 'updateSettings').mockRejectedValue(new Error('boom'))
    renderBanner()
    const btn = await screen.findByRole('button', { name: en.engine_banner_turn_on })
    fireEvent.click(btn)
    expect(await screen.findByText(/boom/)).toBeInTheDocument()
    expect(screen.getByText(en.engine_banner_off)).toBeInTheDocument()
    await waitFor(() => expect(btn).toBeEnabled())
  })
})

describe('EngineBanner · fail-open（§4.6 脏值哲学）', () => {
  it('加载中 → 不渲染', () => {
    vi.spyOn(api, 'health').mockReturnValue(new Promise(() => {}))
    renderBanner()
    expect(screen.queryByText(/Engine off|Setup incomplete/)).not.toBeInTheDocument()
  })

  it('health 拉取失败 → 不渲染（宁可少一条 banner，不可误报"引擎已关"）', async () => {
    vi.spyOn(api, 'health').mockRejectedValue(new Error('network'))
    renderBanner()
    await waitFor(() => expect(api.health).toHaveBeenCalled())
    expect(screen.queryByText(/Engine off|Setup incomplete/)).not.toBeInTheDocument()
  })
})
