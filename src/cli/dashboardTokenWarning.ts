// src/cli/dashboardTokenWarning.ts
// 鉴权 A4 Task 15：R2D-5 裸奔告警退役。鉴权战役上线后 dashboard 有了统一前置门——DASHBOARD_TOKEN
// 未设不再等于"零鉴权裸奔"，而是"尚未建管理员账号，首访进向导"。启动播报据此三态化：
//   ① DASHBOARD_TOKEN 已设（无论初始化否）：legacy token 仍等价 api key 被接受，建议迁移到账号
//      密码后移除该变量。
//   ② 未初始化 + 无 token：一行中性指路——首访进创建管理员向导（不是告警，向导即门）。
//   ③ 已初始化 + 无 token：零输出（健康态，不聒噪）。
//
// 独立成纯函数模块（不直接写在 cli/index.ts 里）是因为 index.ts 顶层有 main().catch(...) 的
// import-time 副作用（同 subtitle-fetch.test.ts 顶部注释记录的既有教训：直接 import 那个文件会
// 真的跑起 CLI 主流程），没法给它单独写单测——把纯逻辑抽出来是唯一能 TDD 覆盖这段文案的办法。

export interface DashboardAuthStartupState {
  /** 是否配置了 legacy DASHBOARD_TOKEN 环境变量。 */
  tokenSet: boolean
  /** 是否已建管理员账号（settings.auth_password_hash 非空）。 */
  initialized: boolean
}

/** 启动播报文案，供调用方（cmdWatch）逐行 console 播报。纯函数，不做任何 I/O。 */
export function dashboardAuthStartupLines(state: DashboardAuthStartupState): string[] {
  if (state.tokenSet) {
    return [
      '[dashboard] DASHBOARD_TOKEN 已设置，将作为 legacy api key 继续被接受。建议在 dashboard 完成账号设置后移除该变量，改用账号密码登录。',
    ]
  }
  if (!state.initialized) {
    return [
      '[dashboard] 尚未设置管理员账号——首次访问 dashboard 将进入创建管理员向导。',
    ]
  }
  return []
}
