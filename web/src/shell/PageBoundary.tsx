// web/src/shell/PageBoundary.tsx：**每页一条**的错误边界。
//
// ## 为什么需要它，以及为什么放在这一层
//
// 触发它的实测缺陷：`SettingsTabsPage` 读 `setupStatus.data?.providers.subhd.enabled`，
// 可选链只挡到 `data`，`providers` 缺席时抛 `Cannot read properties of undefined`。
// React 19 对未捕获的渲染异常的处理是**卸载整棵树**——用户丢的不是设置页，是整个
// 外壳：侧栏、顶栏、他正在看的那一页，全没了，且屏幕上不留一个字。
//
// 这是架构问题而不是那两行的问题：任何一页的任何一次解引用失手都有同样的后果。
// 所以修法分两层，这个文件是第二层（第一层是让 SettingsTabsPage 自己把契约违例
// 说清楚，见那边的 `readProviders`）。
//
// ## 放哪一层：每个 tab 一条，不是全局一条
//
// 全局一条（包在 `<App>` 外）**不够**：它接住异常之后能渲染的只有一块光板，侧栏和
// 顶栏一起没了——用户还是走不到别的页面去，只能刷新。那把"白屏"换成了"有字的白屏"，
// 改善有限。
//
// 放在 `<main>` 里、每条 tab 分支各包一条，坏掉的范围正好等于**真正坏掉的那部分**：
// 侧栏还在、顶栏还在、⌘K 还在，用户点一下就能去别的页面，甚至不用刷新。这也是
// InspectBoundary 已经在用的同一条推理（"降级的代价应当与故障的范围相称"），
// 这里只是把它从面板级搬到页面级。
//
// 更细的粒度（每个 tab 内部再按区块包）**不做**：Settings 五个 tab 里的六个区已经
// 各自有 error 态降级（BehaviorSection / RootsManager 等的 `settings.error` 分支），
// 那是数据层失败的正常路径；这条边界只兜"正常路径没兜住的"，再细分就是在给
// 每个组件配一个它不需要的保姆。
//
// ## 重试：清 failed 就够了，**不需要** key 强制重挂载
//
// 起初这里写了 `retryKey` 自增 + `key={retryKey}`，理由是"清 state 不会让子树重新
// 挂载、hook 不会重发请求"。实测（mutation 验证时顺手量的）**那是错的**：边界进入
// failed 态时渲染的是 fallback，React 已经把原来的子树卸载了；退出 failed 态时子树
// 是重新挂载的（useEffect 会重跑，计数实测 =1）。加 key 与不加 key 行为逐字节相同。
//
// 于是把 key 删了。留着它不是"多一层保险"，是一行**看起来在解决某个问题、实际什么都
// 没做**的代码——下一个读到它的人会以为不加 key 就会有 bug，然后在别处照抄这个误解。
//
// InspectBoundary 刻意**不**给重试（那里抛错的原因是数据形状不对，再渲染一次必然
// 再抛）。这里给，是因为页面级的抛错来源更宽：一次抖动的响应、一个尚未 settle 的
// 空数组，重挂载重新取一次数据是有真实成功率的。按钮文案说的是"重新加载这一页"
// 而不是"重试"——它描述的是实际发生的事。
//
// ## 刻意不上报
//
// 同 InspectBoundary：这个仓库没有前端错误上报通道，凭空发一个请求只会多一个失败面。
// 技术细节走 console.error，界面上一个字都不吐（铁律②③）。
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { EmptyState } from '../components/ui/empty-state.js'
import { Button } from '../components/ui/button.js'
import { useT } from '../i18n/useT.js'

interface Props {
  children: ReactNode
  /** 出错页面的标识，只进 console 前缀，**不上界面**——用户不需要知道内部 tab id。 */
  name: string
}

interface State {
  failed: boolean
}

export class PageBoundary extends Component<Props, State> {
  override state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[page:${this.props.name}] render failed:`, error, info.componentStack)
  }

  private readonly retry = (): void => {
    this.setState({ failed: false })
  }

  override render(): ReactNode {
    if (this.state.failed) return <PageFallback onRetry={this.retry} />
    return this.props.children
  }
}

/** 降级 UI：一句人话 + 一个真的有用的按钮，居中在主区里。
 *
 *  视觉走 `EmptyState`（R-F11：Linear 基准，四层 surface + hairline，**拒绝投影**）——
 *  不自绘卡片、不加 border、不加 shadow、不用红色底。理由：这不是一条需要用户立刻
 *  处置的告警（那是 Banner 的活），是"这块地方本来该有东西、现在没有"，与 RootsManager
 *  的 error 态、BehaviorSection 的 error 态是同一种东西，就该长得一样。红色留给
 *  destructive 动作确认。 */
function PageFallback({ onRetry }: { onRetry: () => void }) {
  const { t } = useT()
  return (
    <EmptyState
      data-testid="page-failed"
      title={t('page_failed_title')}
      description={t('page_failed_desc')}
      actions={
        <Button variant="secondary" onClick={onRetry}>
          {t('page_failed_retry')}
        </Button>
      }
    />
  )
}
