// web/src/shell/placeholders.tsx：新页面的占位实现（Task ⑦ 只建壳，⑧⑨⑩ 填肉）。
//
// 2026-08-12（Task ⑨）：**三个页面全部填肉，本文件已无任何占位实现**。
//
// 文件本身留着（而不是删掉）只为下面三段"墓碑注释"：它们记的是各页面的真身在哪。
// 整个文件与 PlaceholderPage.tsx 的去留随 Task ⑪ 一并裁决——那时若确实没有第四个
// 待建页面，两者都该删。

/** 活动页（Task ⑨）**已填肉**——占位实现随之删除，见 web/src/workbench/ActivityPage.tsx。
 *
 *  i18n 的 `placeholder_activity_purpose` 键**一并删除**（en/zh 两侧），同下面两条的理由：
 *  留着就是键集里的死条目。⚠️ 组件落在 `workbench/` 不是 `activity/`——后者是旧活动页
 *  （#/workflow 今天渲染的那个），两套并存到 Task ⑪。 */

/** 通知页（Task ⑩）**已填肉**——占位实现随之删除，见 web/src/notifications/NotificationsPage.tsx。
 *
 *  留这段注释而不是留一个不再被引用的 NotificationsPlaceholder：孤儿组件会在下一次有人搜
 *  "notifications placeholder" 时被当成"还没做完"的证据（同 MediaPlaceholder 的既有处置）。
 *  i18n 的 `placeholder_notifications_purpose` 键也**一并删除**（en/zh 两侧），理由同——
 *  留着就是键集里的死条目。 */

/** 媒体库页（Task ⑧）**已填肉**——占位实现随之删除，见 web/src/media/MediaLibraryPage.tsx。
 *
 *  留这段注释而不是留一个不再被引用的 MediaPlaceholder：孤儿组件会在下一次有人搜
 *  "media placeholder" 时被当成"还没做完"的证据。i18n 的 `placeholder_media_purpose`
 *  键也**一并删除**（en/zh 两侧），理由同——留着就是键集里的死条目。 */
