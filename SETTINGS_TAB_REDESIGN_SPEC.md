# Settings 页面 Tab 式重设计规格

**日期：** 2025-02-05  
**状态：** Draft  
**实现方式：** TDD - 先写测试，后实现组件

---

## 1. 背景与问题

### 当前问题
- **信息过载**：51 个可交互元素在单页平铺，缺少分组
- **视觉混乱**：Switch、Input、Button 混在一起，无明确层级
- **难以导航**：需要大量滚动才能找到配置项
- **目录浏览器暴露**：系统根目录按钮（Applications、Library 等）直接显示
- **配置来源不清晰**：环境变量 vs 数据库配置的编辑权限逻辑不够直观

### 设计目标
1. **降低信息密度**：通过 tab 分组，每个 tab 聚焦单一主题
2. **清晰视觉层级**：卡片式布局 + 状态 badge
3. **快速导航**：tab 标签 + badge 状态指示，1 次点击到达
4. **配置来源明确**：env 源显示只读提示，db 源可编辑

---

## 2. Tab 结构设计

### Tab 列表

| Tab ID | 标题 | Badge | 内容 |
|--------|------|-------|------|
| `general` | 通用 | - | 引擎配置 |
| `providers` | 字幕源 | `3/8` 或 `⚠️ N/M` | TMDB、LLM、AI 翻译、ASSRT、OpenSubtitles、Jimaku、subhd、zimuku |
| `media` | 媒体目录 | `⚠️ 未配置` 或空 | 目录管理 + 已添加列表 |
| `security` | 安全 | - | API Key 管理 + 修改密码 |
| `advanced` | 高级 | - | 环境变量（只读）+ 重跑向导 |

### Badge 逻辑

**字幕源 tab：**
- 分母固定为 **8** —— 该 tab 的 8 张卡片全部计入（TMDB、LLM、AI 翻译、ASSRT、OpenSubtitles、Jimaku、subhd、zimuku）
- 单张卡片"已配置"判据：
  - Secret 型卡片（TMDB / LLM / ASSRT / OpenSubtitles / Jimaku）：`secrets.length > 0 && secrets.every(s => s.value !== '')`
  - Toggle 型卡片（subhd / zimuku）：`enabled === true`
  - TranslateCard：`ai_translate_enabled === 'true'`（settings 值是字符串，不是布尔；跟随默认或专用皆算已配置；"专用但三凭证有空项"不算）
- Badge 文字：`已配置数/8`
- Badge 样式：
  - 全部配置：绿色 `✓ 8/8`
  - 部分配置：黄色 `⚠️ 3/8`
  - 全未配置：红色 `⚠️ 0/8`

**媒体目录 tab：**
- 根据 `roots.length` 判断
- Badge 文字：`roots.length === 0 ? '⚠️ 未配置' : null`

---

## 3. 卡片设计规范

### 3.1 Card 组件规格

```tsx
interface SettingsCardProps {
  title: string
  description?: string
  status?: 'configured' | 'unconfigured' | 'locked'
  children: ReactNode
  className?: string
}
```

**样式规格：**
- 背景：`bg-card` (#16181f)
- 边框：`border border-border` (1px #2a2d35)
- 圆角：`rounded-lg` (8px)
- 内边距：`p-6` (24px)
- 卡片间距：`space-y-6` (24px)

**卡片头部：**
- 标题：`text-base font-medium text-foreground`
- 描述：`text-sm text-muted-foreground mt-1`
- 状态 Badge：右对齐

**状态 Badge 变体：**
```tsx
const statusConfig = {
  configured: { label: '✓ 已配置', variant: 'success', bg: 'rgba(34, 197, 94, 0.15)', color: '#22c55e' },
  unconfigured: { label: '⚠️ 未配置', variant: 'warning', bg: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b' },
  locked: { label: '🔒 环境变量', variant: 'secondary', bg: 'rgba(107, 114, 128, 0.15)', color: '#9ca3af' },
}
```

### 3.2 Provider Card 特殊规格

**配置来源逻辑：**
```tsx
// 每个 secret 有 source 字段
interface Secret {
  name: string
  value: string  // 已打码
  source: 'env' | 'db'
}

// 卡片状态判断
const hasEnvSource = secrets.some(s => s.source === 'env')
const allConfigured = secrets.every(s => s.value !== '')

// 状态 badge 逻辑
// 优先级：已配置 > 部分 env 锁定 > 未配置
const getProviderStatus = () => {
  if (allConfigured) return 'configured'
  if (hasEnvSource && !allConfigured) return 'locked'  // 部分 env，部分空
  return 'unconfigured'
}

// 注：mixed 场景（env + db）的 badge 显示 'configured' 或 'locked'
// 取决于是否所有字段都有值
```

**UI 行为：**
- `source === 'env'`：
  - Input 设为 `readOnly`
  - 显示小字提示：`"环境变量已配置 · 由 .env 文件提供"`
  - 隐藏"编辑"按钮，只保留"测试连接"
- `source === 'db'`：
  - Input 可编辑
  - 显示"编辑" + "测试连接"按钮

### 3.3 subhd/zimuku 特殊处理

**当前问题：**
mockup 中放在 Jimaku 卡片内部（错误）

**正确设计：**
- subhd 和 zimuku 应该是独立的 Provider Card
- 每个卡片结构：
  - 标题：`subhd` / `zimuku`
  - 描述：`"中文字幕源"` / `"中文字幕源"`
  - 内容：一个 Switch 开关 + 说明文字
  - 状态：`enabled ? 'configured' : 'unconfigured'`

**Card 内容：**
```tsx
<SettingsCard
  title="subhd"
  description="中文字幕源"
  status={enabled ? 'configured' : 'unconfigured'}
>
  <div className="flex items-center gap-3">
    <Switch 
      checked={enabled} 
      onCheckedChange={handleToggle}
      disabled={source === 'env'}
    />
    <div className="flex-1">
      <div className="text-sm font-medium">启用 subhd</div>
      <div className="text-xs text-muted-foreground">
        无需 API Key，开箱即用
      </div>
    </div>
  </div>
  {source === 'env' && (
    <div className="text-xs text-muted-foreground">
      🔒 通过环境变量 SUBHD_ENABLED 配置
    </div>
  )}
</SettingsCard>
```

---

## 4. Tab 内容详细设计

### Tab 1: 通用 (general)

**卡片 1：引擎配置**
- 发动机开关 (Switch)
- 目标语言 (Input)
- 硬字幕假定 (Select)
- 排除特典 (Checkbox)
- 痕迹保留天数 (NumberInput)
- 扫描间隔 (NumberInput)
- [保存更改] 按钮

**注：** AI 翻译不在本 tab —— 它整体归入字幕源 tab（见 §4.2.6 的裁决）。通用 tab 不留任何翻译相关残影（没有开关、没有指路文字）。

### Tab 2: 字幕源 (providers)

**顺序：**
1. TMDB 卡片
2. LLM 卡片
3. **AI 字幕翻译卡片**（紧跟 LLM —— 它消费 LLM 凭证，相邻摆放让"跟随默认"有指向物）
4. ASSRT 卡片
5. OpenSubtitles 卡片
6. Jimaku 卡片
7. subhd 卡片
8. zimuku 卡片

**每个卡片结构：**
- 标题 + 描述
- 状态 badge（configured/unconfigured/locked）
- Secret 字段（API Key、Username、Password 等）
  - env 源：只读 + 小字提示
  - db 源：可编辑
- [测试连接] 按钮
- 上次测试时间 + 状态（可选）

---

## 4.2.6 AI 字幕翻译卡片（双层配置）

**裁决（2025-02-05 用户拍板）：** 方案 A 单卡片渐进展开；Model ID **必填**，专用模型是原子选择。

### 两层语义

| 层 | 控件 | 语义 |
|---|---|---|
| 第一层 | Switch `启用 AI 字幕翻译` | 功能总开关。写 `ai_translate_enabled`（字符串 `'true'` / `'false'`）。关 = 不翻译，第二层完全不渲染 |
| 第二层 | Segmented `跟随默认 LLM` / `专用模型` | 用哪套凭证跑翻译 |

第二层只在第一层开启时渲染 —— 这是父子关系，用布局本身编码，不用解释文字。

### 原子性约束（本次裁决的核心）

**专用模型必须三凭证齐全**：`TRANSLATE_BASE_URL` + `TRANSLATE_API_KEY` + `TRANSLATE_MODEL` 三项全部非空才允许保存。

理由：既然选了"专用"，前提就是三项都与默认不同。允许部分留空会产生"逐键回落"这种用户无法预测的混合态 —— Base URL 指向 A 家、Model 却是 B 家的模型名，请求必然失败，而失败原因埋在两个 tab 之外。

**实现方式：**
- 三个字段全部 `required`
- 任一为空时 `[保存]` 按钮 `disabled`
- 空字段失焦即显示行内错误：`"专用模型需要三项凭证全部填写"`
- 校验函数单一事实源，前后端共用同一条判据

**不做**：placeholder 写"留空 = 跟随默认"（那是被否决的语义）。三个字段的 placeholder 一律写正常的输入提示（`https://api.example.com/v1` / `gpt-4o-mini` / `sk-...`）。

### 三态渲染

**状态 1 · 功能关闭**
```
┌────────────────────────────────────┐
│ AI 字幕翻译            [已关闭]    │
│ 搜不到字幕时自动翻译一份            │
├────────────────────────────────────┤
│ ○── 启用 AI 字幕翻译               │
│     消耗 LLM 配额                   │
└────────────────────────────────────┘
```
第二层不渲染（不是灰态，是不存在）。

**状态 2 · 开启 + 跟随默认**
```
┌────────────────────────────────────┐
│ AI 字幕翻译          [✓ 已启用]    │
├────────────────────────────────────┤
│ ──● 启用 AI 字幕翻译               │
│  ┃ 翻译使用的模型                   │
│  ┃ [跟随默认 LLM] [专用模型]        │
│  ┃ 当前：mimo-v2.5 · 与 agent 共用  │
└────────────────────────────────────┘
```
"当前：<model>" 从默认 LLM 配置实时读取 —— 用户改了 LLM 卡片的 model，这行跟着变。

**状态 3 · 开启 + 专用模型**
```
┌────────────────────────────────────┐
│ AI 字幕翻译          [✓ 专用模型]  │
├────────────────────────────────────┤
│ ──● 启用 AI 字幕翻译               │
│  ┃ 翻译使用的模型                   │
│  ┃ [跟随默认 LLM] [专用模型]        │
│  ┃ Base URL *                       │
│  ┃ [https://api.bothyouandme.com/v1]│
│  ┃ Model *                          │
│  ┃ [gpt-4o-mini              ]      │
│  ┃ API Key *                        │
│  ┃ [tp•••••••••qdh           ]      │
│  ┃ [测试连接]                       │
└────────────────────────────────────┘
```
三个 `*` 都是必填标记。

### 状态徽标

| 条件 | 徽标 |
|---|---|
| 功能关 | `已关闭`（灰） |
| 开 + 跟随默认 | `✓ 已启用`（绿） |
| 开 + 专用模型（三项齐） | `✓ 专用模型`（绿） |
| 开 + 专用模型（有空项） | `⚠️ 配置不完整`（黄） |
| `TRANSLATE_*` 由 env 提供 | `🔒 环境变量`（灰）+ 字段只读 |

### 回落矩阵（最终版）

| 翻译开关 | 模型来源 | 三凭证 | 实际使用 | UI 显示 |
|---|---|---|---|---|
| 关 | — | — | 不翻译 | `已关闭`，二层不渲染 |
| 开 | 跟随默认 | — | `LLM_*` 三凭证 | `跟随默认 LLM · <model>` |
| 开 | 专用 | 全填 | `TRANSLATE_*` 三凭证 | `✓ 专用模型` + 模型名 |
| 开 | 专用 | 有空项 | **保存被拒** | `⚠️ 配置不完整` + 行内错误 |
| 开 | 专用 | env 已配 | `TRANSLATE_*` env 值 | `🔒 环境变量` + 只读 |

第四行是本次裁决新增的拒绝态 —— 原设计里的"逐键回落"已删除。

### 模型来源的持久化

`跟随默认` / `专用` 这个选择**不新增 settings 键**，由三凭证的存在性推导：

```ts
// 单一事实源
const isDedicated = Boolean(
  secrets.TRANSLATE_BASE_URL && secrets.TRANSLATE_API_KEY && secrets.TRANSLATE_MODEL
)
```

切到"跟随默认"时的语义 = **清空三个 TRANSLATE_ 键**。这需要一个 UI 确认（"这会清除专用模型配置，确定？"），因为它是破坏性操作 —— 用户可能只是想临时切回默认看看。

✅ 实现通道（已核实，2026-08-05）：清空走 `PUT /api/v2/settings/secrets`，body `{ name, value: '' }` —— **后端把空串当 DELETE**（`setupApi.ts` 的 `putSecret`：`if (b.value === '') { deleteSecret(...) ; return { action: 'deleted' } }`）。

`ProvidersSection.tsx:56` 那句"空输入 = 不动该键"是**前端的跳过策略**（防占位空串误删），不是后端契约。TranslateCard 显式提交空串即可删键。

结论：不需要新端点，也不需要新 settings 键；§4.2.6 的"由三凭证存在性推导 `isDedicated`"成立。

### Tab 3: 媒体目录 (media)

**卡片：媒体目录管理**
- 空态：显示"当前无守备目录" + [📁 添加目录] 按钮
- 有目录：显示目录列表 + [+ 添加目录] 按钮
- 每个目录项：路径 + [删除] 按钮

### Tab 4: 安全 (security)

**卡片 1：API Key 管理**
- 当前 API Key（打码）+ [复制] 按钮
- [重新生成 API Key] 按钮

**卡片 2：修改密码**
- 当前密码 (PasswordInput)
- 新密码 (PasswordInput)
- [修改密码] 按钮

### Tab 5: 高级 (advanced)

**卡片 1：环境变量**
- 表格形式展示所有环境变量（只读）
- 字体：monospace
- 样式：灰色文字

**卡片 2：系统**
- [重跑设置向导] 按钮

---

## 5. Spacing 规范

| 用途 | Spacing | Tailwind Class |
|------|---------|----------------|
| Tab 内容区 padding | 24px | `p-6` |
| 卡片内部元素间距 | 16px | `space-y-4` |
| 卡片间距 | 24px | `space-y-6` |
| 字段内部间距 | 6px | `space-y-1.5` |
| 按钮组间距 | 8px | `gap-2` |
| Input 高度 | 40px | `h-10` |
| Button 高度 | 40px (md) / 32px (sm) | `h-10` / `h-8` |

---

## 6. 组件层级结构

```
SettingsPage.tsx
├── Tabs 容器
│   ├── TabsList（导航栏）
│   │   ├── TabsTrigger: 通用
│   │   ├── TabsTrigger: 字幕源 <Badge>3/8</Badge>
│   │   ├── TabsTrigger: 媒体目录 <Badge>⚠️ 未配置</Badge>
│   │   ├── TabsTrigger: 安全
│   │   └── TabsTrigger: 高级
│   │
│   ├── TabsContent: general
│   │   └── SettingsCard: 引擎配置
│   │
│   ├── TabsContent: providers
│   │   ├── ProviderCard: TMDB
│   │   ├── ProviderCard: LLM
│   │   ├── TranslateCard: AI 字幕翻译   ← 双层，紧跟 LLM
│   │   ├── ProviderCard: ASSRT
│   │   ├── ProviderCard: OpenSubtitles
│   │   ├── ProviderCard: Jimaku
│   │   ├── ProviderToggleCard: subhd
│   │   └── ProviderToggleCard: zimuku
│   │
│   ├── TabsContent: media
│   │   └── SettingsCard: 媒体目录管理
│   │
│   ├── TabsContent: security
│   │   ├── SettingsCard: API Key 管理
│   │   └── SettingsCard: 修改密码
│   │
│   └── TabsContent: advanced
│       ├── SettingsCard: 环境变量
│       └── SettingsCard: 系统
```

---

## 7. 新增组件清单

### 7.1 SettingsCard.tsx
通用卡片容器，支持标题、描述、状态 badge。

### 7.2 ProviderCard.tsx
字幕源专用卡片，处理 env/db 源逻辑、编辑/测试按钮。

### 7.3 ProviderSecretField.tsx
Secret 字段组件，根据 source 决定只读或可编辑。

### 7.4 ProviderToggleCard.tsx
subhd/zimuku 专用卡片，只有 Switch 开关。

### 7.5 TranslateCard.tsx
AI 翻译双层卡片（§4.2.6）。渐进展开：Switch → Segmented → 三必填字段。
内含原子性校验（三凭证全填才可保存）与"切回默认"的破坏性确认。

---

## 8. API 契约

### 8.1 已满足需求的端点（无需修改）

- `GET /api/v2/settings` → SettingsDTO
- `PUT /api/v2/settings` → 更新 settings（subhd/zimuku 开关、`ai_translate_enabled`）
- `GET /api/v2/setup/providers` → ProvidersDTO
- `PUT /api/v2/settings/secrets` → 写 secret (db 源)。**注意路径是集合，不是 `/:name`**；body 为 JSON `{ name, value }`；`value: ''` = 删除该键；`name` 受 `isSecretName` 白名单校验；审计日志只记 name/action，永不记 value
- `POST /api/v2/setup/validate/:providerId` → 测试连接
- `GET /api/v2/roots` → RootsDTO
- `POST /api/v2/roots` → 添加目录

### 8.2 TranslateCard 需要的后端改动（必须做，不能只改前端）

现状：`TRANSLATE_*` 三凭证是**刻意的 env-only 高级项**，完全不在 db secret 白名单里。所以"UI 里可编辑专用模型"这件事无法只靠前端实现 —— 下面四处不改，保存必然 400。

| 文件 | 改动 | 不改的后果 |
|---|---|---|
| `src/v2/secrets.ts` | `SECRET_NAMES` 加 `TRANSLATE_BASE_URL` / `TRANSLATE_API_KEY` / `TRANSLATE_MODEL`（9 → 12） | `putSecret` 返回 400 `unknown secret name`；`settingsRepo.setSecret/deleteSecret` 直接 throw |
| `src/dashboard/setupApi.ts` | `ProviderRowDTO['id']` 联合类型加 `'translate'`；`PROVIDER_SECRETS.translate = [三键]`；`VALIDATE_TARGETS` 加 `'translate'`；`NEXT_STEP_HINT.translate` 补一句英文下一步 | 四处是耦合的 —— 类型系统会逼你全改（`Record<ProviderRowDTO['id'], …>` 与 `Record<ValidateTarget, string>` 都要求穷尽）。少一处编译失败 |
| `src/cli/translateItemCommand.ts` | `translateLlmCfg` 与 `tryAutoTranslateCfg` 改为**来源无关**：经 `resolveSecret`（env 非空 > db > none）取值，而非直读 `process.env` | UI 存进库的专用凭证对 daemon 不可见；用户在设置页配好、翻译仍然不跑，且无任何报错线索 |

⚠️ **需要用户拍板的一点**：`translateItemCommand.ts` 里 `TRANSLATE_MODEL` 分支带一行注释「env-only 高级项（spec §12，wizard 不收）——逐字不动」。本设计要求 UI 可编辑该凭证，等于推翻这条注释。这是设计意图的变更，不是实现细节，明确列出而非静默改写。

同时保留的既有安全语义（不得放宽）：
- `resolveSecret` 的优先级 env（非空）> db > none 不变 —— 部署层用 env 锁死时，UI 字段只读、显示 🔒 徽标
- daemon 派活的双门不变：三凭证齐全（不论来源）**且** `settings.ai_translate_enabled === 'true'`
- 绝不回落 `LLM_*`：`tryAutoTranslateCfg` 缺任一凭证返回 `null`（原注释理由：自动路径拿 `LLM_MODEL` 烧配额是事故）

---

## 9. 迁移策略

### 阶段 0：后端打通（必须在 TranslateCard 之前）
1. `src/v2/secrets.ts`：`SECRET_NAMES` 扩到 12 键（§8.2）
2. `src/dashboard/setupApi.ts`：`translate` provider 四处耦合改动（§8.2）
3. `src/cli/translateItemCommand.ts`：`translateLlmCfg` / `tryAutoTranslateCfg` 改走 `resolveSecret`（§8.2，含推翻"逐字不动"注释的拍板）
4. 后端测试：白名单新键的 put/delete 往返、`resolveSecret` 优先级不变、双门逻辑不变

前三个阶段的前端件不依赖阶段 0，可并行；但 **TranslateCard（阶段 1 第 4 项）必须在阶段 0 之后**，否则测试只能 mock、上线必 400。

### 阶段 1：新组件开发（TDD）
1. 创建 `SettingsCard.test.tsx` + `SettingsCard.tsx`
2. 创建 `ProviderCard.test.tsx` + `ProviderCard.tsx`（内含 `ProviderSecretField`，其行为由 ProviderCard 测试覆盖，不单独建测试文件）
3. 创建 `ProviderToggleCard.test.tsx` + `ProviderToggleCard.tsx`
4. 创建 `TranslateCard.test.tsx` + `TranslateCard.tsx`（§4.2.6，最后做 —— 它依赖前三者的卡片语义已定型 + 阶段 0 已落地）

### 阶段 2：Tab 容器
1. 创建 `SettingsTabsPage.test.tsx` + `SettingsTabsPage.tsx`
2. 集成 shadcn Tabs 组件
3. 实现 badge 逻辑

### 阶段 3：内容迁移
1. 将现有 `BehaviorSection` 逻辑迁移到 general tab
2. 将 `ProvidersSection` 逻辑迁移到 providers tab（拆分为独立卡片）
3. 将 `TranslateSection` 逻辑重构为 `TranslateCard`，落在 providers tab 第 3 位（§4.2.6）
4. 将 `RootsManager` 迁移到 media tab
5. 将 `SecuritySection` 迁移到 security tab
6. 将 `DeploySection` 迁移到 advanced tab

### 阶段 4：替换 & 清理
1. 修改 `AppShell.tsx` 路由，指向新的 `SettingsTabsPage`
2. 删除旧组件：`SettingsPage.tsx`、`BehaviorSection.tsx` 等
3. 更新测试

---

## 10. 测试策略

### 单元测试

**SettingsCard.test.tsx：**
- 渲染标题和描述
- 显示正确的状态 badge
- children 正确渲染

**ProviderCard.test.tsx：**
- env 源显示只读提示 + 无编辑按钮
- db 源显示编辑按钮
- 测试连接按钮触发 API
- 编辑模式切换

**ProviderToggleCard.test.tsx：**
- Switch 开关状态同步
- env 源锁定 Switch
- 切换触发 API 调用

**TranslateCard.test.tsx：**（§4.2.6 的原子性约束是重点）
- 功能关闭时第二层**不在 DOM 中**（不是隐藏，是不渲染 —— 用 `queryByRole` 断言 null）
- 开启后渲染 Segmented，默认选中态由三凭证存在性推导
- 选"跟随默认"时显示当前默认 model 名，且该名跟随 LLM 卡片配置变化
- 选"专用模型"渲染三个字段，全部带 `required`
- **三凭证任一为空 → 保存按钮 disabled**（三种单空 + 三种双空，共 6 条用例）
- 三凭证全填 → 保存按钮 enabled，PUT 三次
- 空字段失焦 → 行内错误 `role="alert"`
- env 源三凭证 → 字段 `readOnly` + 🔒 徽标 + 无保存按钮
- 从"专用"切回"跟随默认" → 弹破坏性确认；取消则 Segmented 回弹到"专用"
- 徽标五态映射（关闭/已启用/专用模型/配置不完整/环境变量）

### 集成测试

**SettingsTabsPage.test.tsx：**
- Tab 切换正确显示内容
- Badge 数字计算正确（**包含 TranslateCard 计入字幕源分母**）
- 空态 / 有数据态正确渲染
- 所有 API 调用正确触发
- 通用 tab **不含**任何翻译相关控件（反向断言，§4.2.6 裁决的回归锁）

### E2E 测试（agent-browser）

**settings-e2e.spec.ts：**
1. 访问 Settings 页面
2. 切换每个 tab，截图验证
3. 测试编辑流程：
   - 点击编辑按钮
   - 修改 Input
   - 保存
   - 验证成功提示
4. 测试连接流程：
   - 点击测试按钮
   - 验证加载态
   - 验证成功/失败提示
5. **翻译卡片三态走查**：
   - 关闭态截图（确认二层无痕）
   - 开启 → 跟随默认，截图（确认显示默认 model 名）
   - 切专用 → 只填两项，确认保存钮灰、行内错误在场
   - 补齐第三项 → 保存钮亮，保存成功
   - 切回跟随默认 → 确认破坏性弹窗出现

---

## 11. 性能考量

- **Tab 内容懒加载**：当前 tab 不活跃时，不渲染其内容（避免首次加载 8 张字幕源卡片）
- **数据轮询优化**：只轮询当前活跃 tab 的数据（如 providers tab 才轮询 `useSetupProviders`）
- **卡片虚拟化**：providers tab 有 8 张卡片，纵向排列即可，无需虚拟化

---

## 12. 无障碍（a11y）

- Tab 使用 `role="tablist"` + `role="tab"` + `aria-selected`
- 键盘导航：左右箭头切换 tab
- Badge 使用 `aria-label` 描述状态（如 "3 个已配置，共 8 个"）
- 只读字段添加 `aria-readonly="true"`
- 测试按钮添加 `aria-busy="true"` 加载态

---

## 13. 验收标准

### 功能验收
- [ ] 所有 5 个 tab 正确渲染
- [ ] Badge 数字/状态正确计算
- [ ] env 源字段只读 + 提示文字
- [ ] db 源字段可编辑 + 保存成功
- [ ] 测试连接按钮触发 API + 显示结果
- [ ] subhd/zimuku 独立卡片 + Switch 工作
- [ ] 媒体目录添加/删除功能正常
- [ ] TranslateCard 三态可走通：关闭 → 跟随默认 → 专用（三凭证全填保存成功、有空项保存被拒）
- [ ] TranslateCard 徽标五态全部可复现：`已关闭` / `✓ 已启用` / `✓ 专用模型` / `⚠️ 配置不完整` / `🔒 环境变量`
- [ ] 原子性拦截生效：三凭证任一为空时保存按钮 disabled + 行内错误 `role="alert"`
- [ ] 从"专用"切回"跟随默认"弹破坏性确认；取消则 Segmented 回弹到"专用"，三键不被删
- [ ] `TRANSLATE_*` 由 env 提供时：三字段 `readOnly` + 🔒 徽标 + 无保存按钮
- [ ] 专用凭证存库后 daemon 可见（`resolveSecret` 取到 db 值，翻译真跑）
- [ ] 通用 tab 无任何翻译相关控件

### 后端验收（§8.2 改动的回归锁）
- [ ] `SECRET_NAMES` 扩到 12 键后，三个 `TRANSLATE_*` 键 put/delete 往返成功（空串 = 删除）
- [ ] `resolveSecret` 优先级不变：env 非空 > db > none；空串 env 不遮蔽 db 值
- [ ] daemon 派活双门不变：三凭证齐全（不论来源）**且** `ai_translate_enabled === 'true'`
- [ ] `tryAutoTranslateCfg` 缺任一凭证仍返回 `null`，**绝不**回落 `LLM_*`
- [ ] `translate` provider 四处耦合改动齐全，`npm run check` 通过（类型穷尽性自证）
- [ ] 审计日志只记 name/action，永不记 value

### UI 验收（agent-browser）
- [ ] 卡片间距 24px
- [ ] 字段间距 16px
- [ ] Input 高度 40px
- [ ] 状态 badge 颜色正确
- [ ] Tab 切换动画流畅
- [ ] 响应式：移动端 tab 滚动正常

### 性能验收
- [ ] 首次渲染 < 100ms
- [ ] Tab 切换 < 50ms
- [ ] API 调用无重复请求

---

## 14. 实施时间估算

- 阶段 0 后端打通（白名单 + provider 四处 + resolveSecret 化）：2 小时
- 新组件开发（TDD）：4 小时
- Tab 容器 + badge 逻辑：2 小时
- 内容迁移（5 个 tab）：6 小时
- 测试编写 + 调试：3 小时
- E2E 验收（agent-browser）：1 小时

**总计：18 小时**

---

## 15. 风险与缓解

### 风险 1：数据轮询冲突
**问题：** 多个 tab 同时轮询可能导致性能问题  
**缓解：** 只轮询当前活跃 tab 的数据

### 风险 2：env 源编辑误导
**问题：** 用户可能不理解为什么某些字段不能编辑  
**缓解：** 显示清晰的小字提示 + 锁定图标

### 风险 3：subhd/zimuku 位置混淆
**问题：** 用户可能期望在其他地方找到这两个开关  
**缓解：** 放在 providers tab，与其他字幕源平级，保持一致性

---

## 附录 A：现有组件对照表

| 旧组件 | 新位置 |
|--------|--------|
| `BehaviorSection` | general tab → 引擎配置卡片 |
| `TranslateSection` | **providers tab → TranslateCard**（双层重构，§4.2.6） |
| `ProvidersSection` → SecretRow | providers tab → ProviderCard (TMDB/LLM/ASSRT/OpenSubtitles/Jimaku) |
| `ProvidersSection` → ToggleRow | providers tab → ProviderToggleCard (subhd/zimuku) |
| `RootsManager` | media tab → 媒体目录管理卡片 |
| `SecuritySection` | security tab → 2 张卡片 |
| `DeploySection` | advanced tab → 环境变量卡片 |
| `SystemSection` | advanced tab → 系统卡片 |

---

## 附录 B：shadcn Tabs 组件 API

使用 `@radix-ui/react-tabs` + shadcn 样式。

```tsx
<Tabs defaultValue="general" className="w-full">
  <TabsList className="...">
    <TabsTrigger value="general">通用</TabsTrigger>
    <TabsTrigger value="providers">
      字幕源
      <Badge variant="warning">3/8</Badge>
    </TabsTrigger>
    {/* ... */}
  </TabsList>

  <TabsContent value="general" className="...">
    {/* 内容 */}
  </TabsContent>
  
  {/* ... */}
</Tabs>
```

---

**文档版本：** 1.0  
**作者：** Claude Opus 5  
**审核状态：** 待用户审核
