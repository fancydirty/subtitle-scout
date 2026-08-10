# Milestone 1.5 Design: LLM Capability Adapter

Status: approved by user on 2026-07-06
Scope: 让任何 OpenAI 兼容 provider 只配三凭证（`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`）即可工作。
自动探测并适配 provider 怪癖，用户无需知道 `LLM_EXTRA_BODY` 的存在。

## 用户画像修正（本设计的动因）

用户只会配 LLM 三凭证。任何"请为你的 provider 加上 X 参数"的要求都是产品缺陷。
已实测的怪癖证明这不是假设场景：

- MiMo：`response_format: json_schema` 被静默忽略；`anyOf` union 类型输出成字符串。
- DeepSeek v4（现役全系，旧别名 2026-07-24 废弃）：默认 thinking 模式，拒绝一切非
  auto 的 `tool_choice`（`'required'` 也被拒）；需请求体 `{"thinking":{"type":"disabled"}}`。

## 为什么不用 LiteLLM 做聚合层

LiteLLM 是 Python SDK + Python proxy，无 TS 库。作为依赖意味着多一个用户要运维的
网关容器，违背三凭证画像。它的两个真实角色：

1. **受支持的上游**：用户已有的 LiteLLM proxy 就是一个 OpenAI 兼容端点，
   `LLM_BASE_URL` 直接指过去，无需任何改动（与 new-api/one-api 同待遇）。
2. **档案库参考来源**：扩充怪癖档案时优先查阅 LiteLLM 源码的 provider 参数映射，
   避免重新踩坑。

## 设计

### 1. 探针阶梯（`src/agent/capability.ts`）

首次使用某 `(baseUrl, model)` 组合时，按序发送 trivial-schema、小 token 的探针调用：

```
Mode 1  forced-tool     强制 tool_choice（现状标准姿势）
Mode 2  forced-tool + quirk body   按档案库顺序逐个尝试
Mode 3  prompt-json     json_object / 纯 prompt 约束 + Zod 双层校验
失败    清晰报错：该模型无法产出结构化输出，请换模型
```

探针 schema 用极简对象（如 `{ok: boolean, echo: string}`），`maxOutputTokens` 给足
（reasoning 模型探针也要过），但 prompt 极短。成功标准：拿到通过 Zod 校验的输出。

成本上限：被拒梯级立即中止（不重试），最坏情况 4 次强制梯级 + prompt-json 最多 2 次 ≈ 6 次调用。

### 2. 怪癖档案库（seed，社区可扩展）

```ts
const QUIRK_BODIES: Array<{ id: string; body: Record<string, unknown> }> = [
  { id: 'deepseek-thinking-disabled', body: { thinking: { type: 'disabled' } } },
  { id: 'qwen-enable-thinking-false', body: { enable_thinking: false } },
  { id: 'vllm-chat-template-kwargs', body: { chat_template_kwargs: { enable_thinking: false } } },
]
```

数组顺序即尝试顺序。新怪癖 = 一行 PR。来源标注（官方文档/LiteLLM 映射/实测）写注释。

### 3. 档案持久化与运行时自愈

- 存 `<cacheRoot>/llm-profiles/<sha1(baseUrl|model)>.json`：
  `{ mode, extraBody?, quirkId?, probedAt, evidence }`；TTL 30 天。
- **运行时失效**：正常任务中若出现 tool_choice/thinking 类 API 错误（provider 行为
  变更），当场作废档案 → 重探一次 → 用新档案继续当次任务。对用户透明。
- `LLM_EXTRA_BODY` 保留为最高优先级人工 override：配置了就跳过探测，直接用
  Mode 1 + 该 body。高级用户与调试通道。

### 4. callStructured 按 mode 分派

- Mode 1/2：现有路径，Mode 2 多一个 extraBody（复用 `injectExtraBody` fetch 注入）。
- Mode 3（降级）：`generateText` 无 tools；prompt 附加 JSON schema 文本描述与
  "只输出 JSON" 指令；`response_format: {type:'json_object'}` 若端点接受（探针确定）；
  响应 text 解析 JSON → 同一套 Zod 校验 + 带错误重试一次。
- **gate 不变**。降级模式可靠性略降，但校验不过就是 no_safe_match——错字幕依然
  进不来，产品底线不动。
- journal 每次运行记录 `llm_profile: { mode, quirkId? }`。

### 5. 测试

- 单测：探针状态机用 mock 模型枚举拒绝/接受组合（Mode1 直通、Mode2 第 N 个解药
  命中、全拒降 Mode3、彻底失败）；Mode 3 的 JSON 提取与校验路径；档案读写与失效。
- 真实验证（手动）：MiMo（应定 Mode 1）、DeepSeek v4 裸三凭证（应自动定 Mode 2，
  quirkId=deepseek-thinking-disabled）、`deepseek-chat`（Mode 1，7-24 前有效）。

### 6. 不做什么

- 不做 provider 白名单/型号识别——探测行为，不猜身份。
- 不捆绑 LiteLLM proxy。
- 不做多模型负载均衡/failover（用户的网关的职责）。
- CLI 之外的接入方式（sidecar 常驻模式）等 Milestone 2。
