// web/src/workbench/WorkbenchCards.tsx —— R-F13 的两种全背景式卡片。
//
// 「在跑」用横版 backdrop（60% 宽 / 186px 高），「排队」用竖版 poster（59×88，渐变区 118px）。
// 为什么形状不同：宽高比决定的（设计文档 §六·八 决定 2）——
//   16:9 @ 70px高 = 124px宽（太窄看不清）  vs  2:3 @ 70px高 = 47px宽（天生适合窄行）。
// 两个位置职责不同，形状不同不是缺陷是分工。
//
// 几何与渐变全在 styles.css 的 .wb-* 段（CSS 变量驱动，移动端只改变量不改组件——
// 设计文档 §七 的"留路"，且点名**不许用 clamp()**）。本文件只负责：
//  · 取哪张图（在跑取 backdrop、排队取 poster）
//  · **拿不到图时怎么降级**（见下）
//  · 三行文案的组装
//
// ── 拿不到图时的降级（§4.4 点名：这是必然分支，不是边缘兜底）─────────────────
// 两种拿不到：① 后端给的 path 就是 null（works.backdrop_path 没回填 / TMDB 确实没横版图）；
// ② path 有值但 TMDB CDN 加载失败（onError）。两种走**同一条**降级：
//   `data-noimg='true'` → 渐变层塌成纯实色、文字左边距归零。
// 🔴 **不画首字母占位块**（与媒体库页的 MediaPoster 刻意不同）：那个是 2:3 的海报槽位，
// 空着会很显眼；这里图是**背景**，缺图时最好的样子就是一张干净的实色卡片，
// 硬塞一个灰方块反而像坏了。
//
// ── 在跑卡片没有图时**不回落到竖版 poster** ────────────────────────────────
// 想过（"横版没有就用竖版顶上"），否掉：竖版图拉伸到 60%宽×186px 会严重变形，
// 而 R-F13 选横版正是因为宽高比。一张变形的图比没有图更糟。
import { useState } from 'react'
import { backdropUrl, posterUrl } from '../api/client.js'

/** 卡片的图。加载失败 → 交给父级走无图降级（父级据 `failed` 置 data-noimg）。
 *  `alt=""` 是刻意的：图是纯装饰，标题就在旁边的文字里，读屏器再念一遍片名是噪音。 */
function CardImage({ src, className, onFail }: { src: string; className: string; onFail: () => void }) {
  return <img className={className} src={src} alt="" loading="lazy" onError={onFail} />
}

export interface WorkbenchCardFace {
  title: string
  /** 「2018 · 动画 · 13 集待处理」那一行，调用方拼好（i18n 在调用方）。 */
  subtitle: string
  posterPath: string | null
  backdropPath: string | null
}

/**
 * 「正在跑」的卡片。横版 backdrop。
 *
 * `progress` 是可选的第三行（「第 3/8 集」）。**可选是刚性的**：ScoutCurrent 的
 * index/total 在 activity 之后、配对的 progress 之前是 **null**——后端注释明写
 * 那是"诚实的 null，不是缺陷"。给它编一个 "0/0" 就是把未知说成已知。
 *
 * 🟡 `staleNote`：实时通道掉了的时候，这张卡片上的「正在处理 X」可能早就不成立了
 * （SSE 是变化流，断线期间的"跑完了"根本没送到）。给了这个字符串就在卡片里多渲一行。
 *
 * 🔴 为什么标记要落在**卡片上**而不是只在顶部状态条：这张卡片才是那句谎话的本体。
 * 用户盯着的是「正在处理 Show A」这几个字，一条挂在页面顶端、与卡片隔着 tab 条的
 * 提示很容易被当成跟别的事有关。两处都说是**有意的冗余**：状态条那条覆盖"没有卡片时
 * 队列同样可能过期"，这条覆盖"卡片本身在撒谎"。
 *
 * ⚠️ 双通道（Carbon）：这一行**自己把话说全**（"可能已经跑完了"），
 * 不靠颜色、不靠图标独立承载信息——去掉 CSS 之后信息量一个字都不少。
 */
export function RunCard(
  { face, progress, staleNote }:
  { face: WorkbenchCardFace; progress?: string | null; staleNote?: string | null },
) {
  const [failed, setFailed] = useState(false)
  const url = backdropUrl(face.backdropPath)
  const noimg = !url || failed
  return (
    <div className="wb-run-card" data-noimg={noimg ? 'true' : 'false'}
         data-stale={staleNote ? 'true' : 'false'} data-testid="wb-run-card">
      {!noimg && <CardImage src={url} className="wb-run-img" onFail={() => setFailed(true)} />}
      <div className="wb-run-fade" />
      <div className="wb-run-body">
        <span className="wb-card-title">{face.title}</span>
        <span className="wb-card-sub">{face.subtitle}</span>
        {/* progress 为 null/undefined 时**整行不渲染**（不是渲染一个空 span）：
            空行会在卡片里留一道说不清的空隙。 */}
        {progress ? <span className="wb-card-progress">{progress}</span> : null}
        {/* 同上：没有这一行时整行不渲染。`role="status"` 让读屏器也拿得到这条事实。 */}
        {staleNote
          ? <span className="wb-run-stale" role="status" data-testid="wb-run-stale">{staleNote}</span>
          : null}
      </div>
    </div>
  )
}

/** 「已排队」的卡片。竖版 poster。 */
export function QueueCard({ face }: { face: WorkbenchCardFace }) {
  const [failed, setFailed] = useState(false)
  const url = posterUrl(face.posterPath)
  const noimg = !url || failed
  return (
    <li className="wb-queue-card" data-noimg={noimg ? 'true' : 'false'} data-testid="wb-queue-card">
      {!noimg && <CardImage src={url} className="wb-queue-img" onFail={() => setFailed(true)} />}
      <div className="wb-queue-fade" />
      <div className="wb-queue-body">
        <span className="wb-card-title">{face.title}</span>
        <span className="wb-card-sub">{face.subtitle}</span>
      </div>
    </li>
  )
}
