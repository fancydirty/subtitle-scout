// web/src/shell/placeholders.tsx：三个新页面的占位实现（Task ⑦ 只建壳，⑧⑨⑩ 填肉）。
//
// 三个都用同一个 PlaceholderPage 壳，各自只给"这页回答什么问题"与"谁来填、数据源是什么"。
// 文案里的数据源与 task 号是可核对的事实（对得上 FRONTEND-SPEC §六·七 的数据源表），
// 不是占位废话——下一个人接手时这三行就是他的入口索引。
//
// **刻意不放任何假数据/骨架屏**：见 PlaceholderPage 头注释的论证。
import { PlaceholderPage } from './PlaceholderPage.js'
import { useT } from '../i18n/useT.js'

/** 活动页（Task ⑨）——Steam 下载页那种"现在怎么样了，我可以不管了吗"。 */
export function ActivityPlaceholder() {
  const { t } = useT()
  return (
    <PlaceholderPage
      title={t('nav_activity')}
      purpose={t('placeholder_activity_purpose')}
      buildNote="Task ⑨ · GET /api/v2/events (SSE: activity/progress) + GET /api/v2/health"
    />
  )
}

/** 通知页（Task ⑩）——完成的成果流水，保留一周、倒序、不做已读。 */
export function NotificationsPlaceholder() {
  const { t } = useT()
  return (
    <PlaceholderPage
      title={t('nav_notifications')}
      purpose={t('placeholder_notifications_purpose')}
      buildNote="Task ⑩ · notifications 表（一周窗）+ SSE found 实时推"
    />
  )
}

/** 媒体库页（Task ⑧）——应有集 vs 实有集 vs 字幕情况。 */
export function MediaPlaceholder() {
  const { t } = useT()
  return (
    <PlaceholderPage
      title={t('nav_media')}
      purpose={t('placeholder_media_purpose')}
      buildNote="Task ⑧ · GET /api/v2/mediaLibrary + /:workId"
    />
  )
}
