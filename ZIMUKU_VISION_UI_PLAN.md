# zimuku Vision Fallback UI Implementation Plan

## 背景
用户裁决：zimuku 模板匹配已够用（命中率高，纯算法 <100ms），视觉 LLM 改为可选兜底。需要在 Settings 页面添加配置界面，并提供视觉能力检测功能，避免用户配置无视觉能力的模型。

## 已完成
- ✅ adapter 层语言过滤（zimuku/subhd 仅中文启用）
- ✅ 后端 secrets 配置（ZIMUKU_VISION_BASE_URL/API_KEY/MODEL）
- ✅ buildAdapters.ts 改为可选 vision 三件套

## 待实现任务

### Task 1: i18n 文案（中英文）
**文件：** `web/src/i18n/en.ts`, `web/src/i18n/zh.ts`

**新增键：**
```typescript
// zimuku vision card
settings_zimuku_vision_heading: 'zimuku vision fallback (optional)'
settings_zimuku_vision_description: 'Template matching handles most captchas without LLM. Configure a vision-capable model here only as fallback for template misses (rare). Unset = template-only.'
settings_zimuku_vision_model_label: 'Vision model'
settings_zimuku_vision_base_url_label: 'Vision base URL'
settings_zimuku_vision_api_key_label: 'Vision API key'
settings_zimuku_vision_test_label: 'Test vision'
settings_zimuku_vision_testing: 'Testing…'
settings_zimuku_vision_test_ok: 'Vision capable — can recognize digits in images'
settings_zimuku_vision_test_fail: 'Not a vision model — test image was not recognized'
settings_zimuku_vision_clear_confirm_title: 'Clear vision fallback?'
settings_zimuku_vision_clear_confirm_body: 'Template matching will still work. Vision LLM is only called when templates miss (rare).'
settings_zimuku_vision_clear_action: 'Clear'
```

**中文对应：**
```typescript
settings_zimuku_vision_heading: 'zimuku 视觉兜底（可选）'
settings_zimuku_vision_description: '模板匹配已能处理绝大多数验证码，无需 LLM。这里配置的视觉模型仅在模板未命中时作为兜底（罕见）。不配置 = 纯模板模式。'
settings_zimuku_vision_model_label: '视觉模型'
settings_zimuku_vision_base_url_label: '视觉 API 地址'
settings_zimuku_vision_api_key_label: '视觉 API 密钥'
settings_zimuku_vision_test_label: '测试视觉能力'
settings_zimuku_vision_testing: '测试中…'
settings_zimuku_vision_test_ok: '具备视觉能力 — 能识别图片中的数字'
settings_zimuku_vision_test_fail: '非视觉模型 — 无法识别测试图片'
settings_zimuku_vision_clear_confirm_title: '清除视觉兜底配置？'
settings_zimuku_vision_clear_confirm_body: '模板匹配依然有效。视觉 LLM 仅在模板未命中时调用（罕见情况）。'
settings_zimuku_vision_clear_action: '清除'
```

**验收标准：**
- 所有键添加到 en.ts 和 zh.ts
- 文案符合 DESIGN.md 规范（简洁、技术向、不卖萌）
- 中英文语义对齐

---

### Task 2: 视觉能力检测 API
**文件：** `src/api/routes.ts` 或新建 `src/api/testVision.ts`

**端点：** `POST /api/test-vision`

**请求体：**
```typescript
{
  baseUrl: string
  apiKey: string
  model: string
}
```

**响应：**
```typescript
// 成功
{ success: true, digits: string }  // digits 是识别出的数字

// 失败
{ success: false, error: string }
```

**实现逻辑：**
1. 使用内置测试图片（简单的 5 位数字验证码 BMP）
2. 调用 `solveNumericCaptcha(model, testImageBuffer)`
3. 检查返回的 digits 是否匹配预期值
4. 超时 10 秒

**测试图片准备：**
- 使用 `fixtures/zimuku/` 下现有的验证码图片（如 `captcha1.bmp`）
- 或创建新的简单测试图片（5 位数字，已知答案）

**验收标准：**
- 端点正常响应
- 视觉模型返回正确 digits → `success: true`
- 非视觉模型返回错误 → `success: false`
- 超时或网络错误正确处理

---

### Task 3: ZimukuVisionCard 组件
**文件：** `web/src/settings/ZimukuVisionCard.tsx`

**功能：**
- 三层结构：BASE_URL / API_KEY / MODEL（对齐 TranslateCard）
- "Test vision" 按钮（调用 `/api/test-vision`）
- 显示测试结果（成功 = 绿色勾，失败 = 红色叉 + 错误信息）
- "Clear" 按钮（清空三个 secret）
- Confirm dialog（清空前确认）

**状态管理：**
```typescript
const [testing, setTesting] = useState(false)
const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
const [busy, setBusy] = useState(false)
const [error, setError] = useState<string | null>(null)
const [confirmOpen, setConfirmOpen] = useState(false)
```

**UI 布局：**
```
┌─ ZimukuVisionCard ────────────────────────────┐
│ zimuku vision fallback (optional)             │
│ [description text]                            │
│                                               │
│ Vision base URL    [input]                   │
│ Vision API key     [input masked]            │
│ Vision model       [input]                   │
│                                               │
│ [Test vision] [Clear]                        │
│ [test result indicator if present]           │
└───────────────────────────────────────────────┘
```

**验收标准：**
- UI 风格对齐现有 TranslateCard
- Test 按钮能调用 API 并显示结果
- Clear 按钮能清空配置（带确认）
- 输入框正确绑定 secret 状态
- 错误处理完整

---

### Task 4: ZimukuVisionCard 测试
**文件：** `web/src/settings/ZimukuVisionCard.test.tsx`

**测试用例：**
1. ✅ 渲染三个输入框
2. ✅ Test 按钮调用 `/api/test-vision`
3. ✅ 测试成功显示绿色指示
4. ✅ 测试失败显示错误信息
5. ✅ Clear 按钮清空三个 secret
6. ✅ Clear 前显示确认 dialog
7. ✅ 输入框保存后刷新状态

**验收标准：**
- 所有测试通过
- 覆盖主要交互路径

---

### Task 5: 集成到 SettingsTabsPage
**文件：** `web/src/settings/SettingsTabsPage.tsx`

**改动点：**
1. Import ZimukuVisionCard
2. 在 providers tab 的 zimuku toggle 后添加 ZimukuVisionCard
3. 更新 badge 计数逻辑（8 providers → 9 providers？或保持 8，vision 不单独计数？）

**位置：**
```tsx
<ProviderToggleCard id="zimuku" state={setupStatus.data.providers.zimuku} reload={setupStatus.reload} />
{/* 新增 */}
{setupStatus.data?.providers.zimuku.enabled && (
  <ZimukuVisionCard reload={providers.reload} />
)}
```

**决策点：**
- zimuku vision 是否计入 badge？
  - **建议：不计入**，因为它是 optional fallback，不是独立 provider
  - badge 保持 "n/8"

**验收标准：**
- ZimukuVisionCard 只在 zimuku 启用时显示
- UI 布局正确
- 不影响现有卡片

---

### Task 6: API types 更新
**文件：** `web/src/api/types.ts` 或 `src/api/types.ts`

**新增类型：**
```typescript
export interface TestVisionRequest {
  baseUrl: string
  apiKey: string
  model: string
}

export interface TestVisionResponse {
  success: boolean
  digits?: string
  error?: string
}
```

**验收标准：**
- 类型定义完整
- 前后端共用（如果可能）

---

## 实施顺序
1. **Task 1**: i18n 文案（前置依赖）
2. **Task 2**: 后端 API（核心功能）
3. **Task 6**: API types（Task 2 和 3 的桥梁）
4. **Task 3**: ZimukuVisionCard 组件
5. **Task 4**: ZimukuVisionCard 测试
6. **Task 5**: 集成到 SettingsTabsPage

## 审计点
每个 Task 完成后，启动子代理审计：
- 代码质量
- 错误处理
- 边界条件
- 测试覆盖
- UI/UX 一致性

## 技术债务
- 考虑将 TranslateCard 的三层结构抽成通用组件（DRY）
- 视觉检测可能需要更健壮的测试（多张图片）
- 测试图片的版权和存储位置

## 风险
1. **测试图片的选择**：需要足够简单让视觉模型能识别，又足够复杂排除非视觉模型瞎猜
2. **超时设置**：视觉模型可能较慢，10秒可能不够
3. **成本**：每次测试会消耗 vision API 配额
