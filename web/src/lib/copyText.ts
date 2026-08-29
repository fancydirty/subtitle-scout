// web/src/lib/copyText.ts：剪贴板写入，带非安全上下文兜底。
//
// 为什么需要（2026-08-29 NAS 实测）：navigator.clipboard 只在安全上下文存在（https 或
// localhost）。自托管场景里用户经常走 LAN 纯 http（http://192.168.x.x:8099）——此时
// clipboard 是 undefined，旧代码 catch 静默，用户看到的就是"复制按钮点不动"（wizard 的
// 一次性 API key 屏是重灾区：那是最需要复制成功的一屏）。
//
// 兜底走 document.execCommand('copy')：虽被标记 deprecated，但它不受安全上下文限制，
// 是 http 环境下唯一的程序化复制通道，Chrome/Firefox/Safari 都仍然支持。临时 textarea
// 用完即拆；position:fixed 避免页面滚动跳动。
//
// 返回 boolean 而非 throw：两条通道都失败（极老内核/权限拒绝）时调用方必须给可见反馈
// ——"静默失败"正是本次 bug 的根因，这个签名让它无法再犯。
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // clipboard 存在但被权限策略拒绝——落到 execCommand 兜底再试一次。
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}
