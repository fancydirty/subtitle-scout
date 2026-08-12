// web/src/workflow/rerun.ts：Rerun 扳手的请求形状——PendingLane/RunDetail（两个发起方）与
// RerunDialog（确认+提交方）共用，独立成一个纯类型文件避免这些组件互相 import 对方造成循环
// 依赖。
export interface RerunRequest {
  seriesId: string
  /** 仅用于 AlertDialog 的确认文案里报出"是哪部剧"，不参与请求体。PendingLane 从活文档行发起
   *  时总能给出；RunDetail 从一条 worker run 发起时（R2D-1，R2 复审）手头只有 seriesId，没有
   *  现成的剧名可给——可选，留空即可。 */
  seriesName?: string
  /** null = 全剧缺口（POST 请求体不带 seasons 键，走 REDISPATCH_SCHEMA 的省略键语义——数组=季
   *  子集，省略=全剧有缺口的季全部覆盖，见 src/v2/findSubtitleWorkerTask.ts 的 R-11 三态注释）。
   *  PendingLane 每行对应一个具体季，总是给出数字；RunDetail 的 Rerun 按钮（worker run 详情，
   *  不知道原任务覆盖哪些季）总是传 null。 */
  season: number | null
  includeThrottled: boolean
}
