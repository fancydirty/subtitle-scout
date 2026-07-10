// web/src/components/states.tsx：加载/错误/空 三态。加载=海报形状骨架屏（非转圈）。
export function WallSkeleton() {
  return (
    <div className="wall" aria-busy="true" aria-label="载入中">
      {Array.from({ length: 12 }).map((_, i) => (
        <div className="card" key={i}>
          <div className="poster skel" />
          <div className="meta">
            <div className="skel-line" />
            <div className="skel-line short" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="state">
      <div className="state-line">读取失败：{message}</div>
      <button className="btn" onClick={onRetry}>
        重试
      </button>
    </div>
  )
}

export function EmptyState({ text }: { text: string }) {
  return (
    <div className="state">
      <div className="state-line dim">{text}</div>
    </div>
  )
}
