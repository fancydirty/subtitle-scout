/** provider 怪癖档案库：探针按数组顺序尝试。新怪癖 = 加一行（注明来源）。
 *  参考来源：官方文档、LiteLLM provider 参数映射源码、实测 journal。 */
export interface QuirkEntry {
  id: string
  body: Record<string, unknown>
}

export const QUIRK_BODIES: QuirkEntry[] = [
  // DeepSeek v4 系列默认 thinking，thinking 拒绝非 auto tool_choice（2026-07-06 实测）
  { id: 'deepseek-thinking-disabled', body: { thinking: { type: 'disabled' } } },
  // Qwen/DashScope 风格思考开关（来源：官方文档）
  { id: 'qwen-enable-thinking-false', body: { enable_thinking: false } },
  // vLLM 自托管常见形态（来源：vLLM 文档）
  { id: 'vllm-chat-template-kwargs', body: { chat_template_kwargs: { enable_thinking: false } } },
]
