// src/cli/dashboardTokenWarning.ts
// R2D-5（R2 复审，主控裁决版）：dashboard 默认绑定 0.0.0.0，DASHBOARD_TOKEN 未配置时对局域网内
// 任何设备零鉴权开放——settings/media roots 增删、workflow/redispatch 等写端点同样不受保护。
// 裁决明确不做 403 硬拒（会砸现行无 token 的家用部署；正式鉴权归 Sonarr 式立项），只在
// cmdWatch 起 dashboard 之后高声播报这个风险，操作员自行决定要不要设 DASHBOARD_TOKEN。
//
// 独立成这个纯函数模块（不直接写在 cli/index.ts 里）是因为 index.ts 顶层有
// `main().catch(...)` 的 import-time 副作用（同 subtitle-fetch.test.ts 顶部注释记录的既有教训：
// 直接 import 那个文件会真的跑起 CLI 主流程），没法给它单独写单测——把纯逻辑抽出来是唯一能
// TDD 覆盖这段告警文案的办法，同 targetLanguages.ts/buildAdapters.ts 这些从 index.ts 抽出来
// 独立测的小模块是同一个既有先例。

/** 三行告警文案，供调用方（cmdWatch）逐行 console.error。纯函数，不做任何 I/O——是否打印、
 *  打印几次、打印到哪里，都是调用方的决定。 */
export function dashboardNoTokenWarningLines(): string[] {
  return [
    '[dashboard] 警告：未设置 DASHBOARD_TOKEN——dashboard 绑定在 0.0.0.0，对局域网内任何设备零鉴权开放。',
    '[dashboard] settings/media roots 增删、workflow/redispatch 等写端点同样不受保护——局域网内任何人都能改配置、触发重派。',
    '[dashboard] 强烈建议设置 DASHBOARD_TOKEN 环境变量，为全部请求要求携带 token。',
  ]
}
