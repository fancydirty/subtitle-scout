// web/src/subtitleVerify/InspectBoundary.tsx：检视面板的错误边界（审计 I-D1）。
//
// ## 为什么这条边界必须存在
//
// 面板路径上任何一个抛错都会**白屏整个应用**。审计实测到了这件事：一个
// `Cannot read properties of undefined` 从 diagnose() 抛出来，React 卸载了整棵树，
// 剩下 `root html length: 11`——用户点一下红芯片，整个媒体库消失，且没有任何提示。
//
// 面板是一个**可选的、附加的**视图：它回答"这条字幕怎么了"。它坏掉的正确降级是
// "这一个面板显示一句人话"，而不是"用户失去整个 dashboard 以及他正在看的那一季"。
// 二者的代价差了几个数量级，而分隔它们只需要这个组件。
//
// ## 为什么是 class 组件
//
// React 没有 hook 形式的错误边界——`componentDidCatch` / `getDerivedStateFromError`
// 只在 class 上可用（截至 React 19 仍如此）。这不是"没跟上新写法"，是平台唯一的入口。
//
// ## 刻意不上报、不重试
//
// 不往后端打点：这个仓库没有前端错误上报通道，凭空发一个请求只会多一个失败面。
// 不给"重试"按钮：抛错的原因几乎必然是同一份数据再渲染一次还是会抛（数据形状不对），
// 一个必然再次失败的重试按钮比没有按钮更糟。给的是"关闭"——那是真的有用的动作。
//
// 错误详情走 console.error（开发时看得到、生产时不打扰用户），**不渲染到界面上**：
// 铁律②③——堆栈里全是模块名与内部字段，对用户毫无意义。
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { Text } from '@astryxdesign/core/Text'
import { useT } from '../i18n/useT.js'

interface Props {
  children: ReactNode
  /** 面板标题，降级态也要显示——用户得知道是哪一集出的问题 */
  title: string
  /** 关闭。降级态唯一的动作。 */
  onClose: () => void
}

interface State {
  failed: boolean
}

export class InspectBoundary extends Component<Props, State> {
  override state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 只进 console：给开发者看的技术事实，不上界面（铁律②③）。
    console.error('[InspectPanel] render failed:', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return <InspectFallback title={this.props.title} onClose={this.props.onClose} />
    }
    return this.props.children
  }
}

/** 降级态：一句人话 + 一个关闭按钮。**仍然是个 Dialog**——面板是用户主动打开的，
 *  抛错时直接什么都不显示会像"点了没反应"，他只会再点一次、再抛一次。 */
function InspectFallback({ title, onClose }: { title: string; onClose: () => void }) {
  const { t } = useT()
  return (
    <Dialog isOpen onOpenChange={(o) => { if (!o) onClose() }} width="min(520px, 92vw)">
      <DialogHeader title={title} onOpenChange={(o) => { if (!o) onClose() }} />
      <div className="vinspect" data-testid="vinspect-failed">
        <Text type="body" color="secondary">{t('verify_inspect_failed')}</Text>
        <div className="vinspect-btns">
          <button type="button" className="vinspect-btn vinspect-btn-keep" onClick={onClose}>
            {t('verify_got_it')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
