/**
 * 云锁(Yunsuo)WAF 破解模块——zimuku.org 命中的"网站防火墙"中间页处理。与 LLM/zimuku 客户端
 * 解耦:验证码识别通过注入的 solve 回调完成(生产接线用 solveNumericCaptcha,测试注入假实现),
 * 网络请求通过注入的 fetchImpl 完成,全部离线可测。
 *
 * 挑战页特征(实测证据,见 docs/design/2026-07-13-zimuku-provider-design.md):
 * body 含 "YunsuoAutoJump"(JS 跳转函数名)或 "security_verify_img"(验证码图片标记)。
 */

export function detectChallenge(html: string): boolean {
  return /YunsuoAutoJump|security_verify_img/.test(html)
}
