# Phase 2 破反爬 sidecar:zimuku 字幕源接入(轻量版)

日期:2026-07-13。状态:设计定案(用户已授权跳过审阅门,直接进实现)。
前置证据:(a) 亲用 agent-browser 实地侦察 zimuku(截图 scratchpad/zimuku-landing.png);(b) 调研 agent 实测五站反爬现状(会话 tasks/aa12b8648571d61af.output)。
验收素材:间谍过家家(93 集 unavailable 主体,zimuku 几乎必有其字幕)。

## 用户裁定(设计公理)

1. **逐源啃,不分散**:v1 只接 zimuku 一个站;打通端到端(反爬→搜索→下载→交给现有 staging 验证流水)再谈第二站。
2. **够用就好**:不追全能,不预建多站抽象层(每站保护/页面结构不同,无真实反馈前的抽象必返工)。
3. 软路由线可裸连 zimuku(用户确认+亲验),无需国内出口代理。

## 铁证推翻老设计(Camoufox+Xvfb+标签页池+视觉验证码 大幅过度工程)

实地+调研确认:
- zimuku.org 是**国产云锁(Yunsuo)WAF,非 Cloudflare**。首页 `/` 弹 JS「网站防火墙」中间页,但**内容页 `/detail/N.html` 直出,无需 Cookie**(调研实测)。
- 验证码=**5 位纯数字像素图**(样例 74504),无扭曲/无干扰线/无粘连——Tesseract 白名单 `0123456789` 即破(GreasyFork 现成脚本佐证),多模态模型更稳,刷新无限可重试。
- 云锁 `security_session_verify` Cookie **可复用、不绑 IP、跨路径**(调研从美国 IP 实测复现)。
- **zmk.pw 镜像才是真 Cloudflare(403)——避开它,只用 .org 源。**

## 架构:HTTP 客户端优先,浏览器仅作偶发兜底(v1 甚至不建浏览器)

沿用现有 `src/adapters/providers/assrt.ts` 的 provider 形状(MinIntervalLimiter + 磁盘响应缓存):

```
新 provider: zimuku (src/adapters/providers/zimuku.ts + src/cli/adapters/zimukuAdapter.ts)
  1. TLS 指纹 HTTP 客户端请求(Node:先用现有 fetch+完整浏览器 UA/zh-CN 头;若被 TLS 指纹拒,升 got-scraping/cycletls——按实测需要再上)
  2. 命中「网站防火墙」中间页(检测:body 含 YunsuoAutoJump/security_verify_img)→
     a. 抓验证码图 → 多模态 agent 识别 5 位数字(新 agent src/agent/solveNumericCaptcha.ts,喂图返数字串,无置信度)
     b. 提交验证码 → 拿 security_session_verify Cookie → 落盘缓存(带过期/失效检测)
  3. 持 Cookie 走廉价 HTTP 客户端:搜索(标题+年份)→ 解析候选列表 → 下载字幕压缩包(.zip/.rar)
  4. 交给现有 providerPort/pipeline:候选进 staging 沙盒 → 开箱体检 → verify agent 终审 → 原子安装
  (zimuku 返回的是压缩包,解压取 .srt/.ass 后走既有 staging 流水,与 assrt/OS 候选同轨)
```

**不建浏览器**:v1 用"HTTP 客户端 + 验证码 OCR/视觉一次拿 Cookie"覆盖全部;若日后 zimuku 升级到真浏览器挑战,再加 nodriver(Chromium 真无头,非 Camoufox——单一住宅 IP 场景 nodriver 胜 Camoufox 负)短命子进程兜底。**本期不做:Camoufox、Xvfb、标签页池、付费打码。**

## 会话复用与礼貌(住宅 IP 被封是真实家庭成本)

- Cookie 缓存复用(云锁 Cookie 不绑 IP,过一次长期用);失效检测按响应(再遇中间页)而非计时。
- 单站串行、请求间 2-5s 随机延迟、聚合缓存、下载即止(压缩包一次到手);**绝不重试风暴**(云锁重试风暴会招致永久 IP 封禁)。复用 assrt 的 MinIntervalLimiter 纪律。

## 验证码识别(唯一"真障碍",但是最弱的)

- 新 agent `solveNumericCaptcha(llm, imageBytes): { digits: string }`——喂验证码 PNG,返 5 位数字,无置信度(符合"无计算器"公理)。
- 识别错→重刷验证码重试(有界次数,如 5 次,超限该 job 转瞬时错误退避,不毒负缓存)。
- 备选:本地 Tesseract(`0123456789` 白名单)作零成本快路径,LLM 作兜底——待实现期实测哪个更稳,择一或级联。

## 影响面与不做清单

- **新增**:`src/adapters/providers/zimuku.ts`(WAF 破解+搜索+下载)+ `src/cli/adapters/zimukuAdapter.ts`(接 providerPort NDJSON)+ `src/agent/solveNumericCaptcha.ts` + 压缩包解压工具(adm-zip 已在依赖;.rar 需 node-unrar 或降级跳过)+ Cookie 缓存件。zimuku 注册进 provider 列表(doctor 加探测)。
- **零改动**:staging 验证流水、gate、pipeline——zimuku 只是多一个候选源,候选形态与现有 assrt/OS 一致。
- **不做**:多站抽象层;subhd/subf2m(排队,第二/三站);浏览器/Camoufox/Xvfb/标签页池/付费打码;.rar 若无纯 JS 解压则本期跳过(记 backlog)。
- **风险台账**:住宅 IP 封禁靠礼貌兜底(低频+随机延迟+无重试风暴+响应式失效检测);验证码错误有界重试不毒缓存;Cookie 失效自愈(重破)。灰色站点,operational 礼貌为唯一自保。

## 测试策略

- 单元:云锁中间页检测、验证码提交流程、Cookie 缓存/失效、搜索结果解析、压缩包解压——全用录制的真实 zimuku 响应夹具(离线,不打站点)。
- 集成:mock provider 端到端(中间页→破解→搜索→下载→解压→候选)。
- 实弹:软路由线对真 zimuku 跑间谍过家家,礼貌限速,人工核对下到的字幕正确性(生产=测试环境已授权)。
