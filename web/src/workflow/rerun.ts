// web/src/workflow/rerun.ts：Rerun 扳手的请求形状——PendingLane（发起方）与 RerunDialog（确认+
// 提交方）共用，独立成一个纯类型文件避免这两个组件互相 import 对方造成循环依赖。
export interface RerunRequest {
  seriesId: string
  /** 仅用于 AlertDialog 的确认文案里报出"是哪部剧"，不参与请求体。 */
  seriesName: string
  season: number
  includeThrottled: boolean
}
