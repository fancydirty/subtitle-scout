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
| `general` | 通用 | - | 引擎配置 + AI 翻译开关 |
| `providers` | 字幕源 | `3/5` 或 `⚠️ N/M` | TMDB、LLM、ASSRT、OpenSubtitles、Jimaku、subhd、zimuku |
| `media` | 媒体目录 | `⚠️ 未配置` 或空 | 目录管理 + 已添加列表 |
| `security` | 安全 | - | API Key 管理 + 修改密码 |
| `advanced` | 高级 | - | 环境变量（只读）+ 重跑向导 |

### Badge 逻辑

**字幕源 tab：**
- 统计所有 provider（包括 subhd/zimuku）的配置状态
- 已配置数 = `secrets.length > 0 && secrets.every(s => s.value)` 或 `enabled === true`（subhd/zimuku）
- Badge 文字：`已配置数/总数`（如 `3/7`）
- Badge 样式：
  - 全部配置：绿色 `✓ 7/7`
  - 部分配置：黄色 `⚠️ 3/7`
  - 全未配置：红色 `⚠️ 0/7`

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

**卡片 2：AI 翻译**
- AI 字幕翻译开关 (Switch)
- 提示文字：需要在"字幕源" tab 配置 LLM

### Tab 2: 字幕源 (providers)

**顺序：**
1. TMDB 卡片
2. LLM 卡片
3. ASSRT 卡片
4. OpenSubtitles 卡片
5. Jimaku 卡片
6. subhd 卡片
7. zimuku 卡片

**每个卡片结构：**
- 标题 + 描述
- 状态 badge（configured/unconfigured/locked）
- Secret 字段（API Key、Username、Password 等）
  - env 源：只读 + 小字提示
  - db 源：可编辑
- [测试连接] 按钮
- 上次测试时间 + 状态（可选）

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
│   │   ├── TabsTrigger: 字幕源 <Badge>3/7</Badge>
│   │   ├── TabsTrigger: 媒体目录 <Badge>⚠️ 未配置</Badge>
│   │   ├── TabsTrigger: 安全
│   │   └── TabsTrigger: 高级
│   │
│   ├── TabsContent: general
│   │   ├── SettingsCard: 引擎配置
│   │   └── SettingsCard: AI 翻译
│   │
│   ├── TabsContent: providers
│   │   ├── ProviderCard: TMDB
│   │   ├── ProviderCard: LLM
│   │   ├── ProviderCard: ASSRT
│   │   ├── ProviderCard: OpenSubtitles
│   │   ├── ProviderCard: Jimaku
│   │   ├── ProviderCard: subhd
│   │   └── ProviderCard: zimuku
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

---

## 8. API 契约（不变）

当前 API 已满足需求，无需修改：

- `GET /api/v2/settings` → SettingsDTO
- `PUT /api/v2/settings` → 更新 settings（subhd/zimuku 开关）
- `GET /api/v2/setup/providers` → ProvidersDTO
- `PUT /api/v2/secrets/:name` → 更新 secret (db 源)
- `POST /api/v2/setup/validate/:providerId` → 测试连接
- `GET /api/v2/roots` → RootsDTO
- `POST /api/v2/roots` → 添加目录

---

## 9. 迁移策略

### 阶段 1：新组件开发（TDD）
1. 创建 `SettingsCard.test.tsx` + `SettingsCard.tsx`
2. 创建 `ProviderCard.test.tsx` + `ProviderCard.tsx`
3. 创建 `ProviderToggleCard.test.tsx` + `ProviderToggleCard.tsx`

### 阶段 2：Tab 容器
1. 创建 `SettingsTabsPage.test.tsx` + `SettingsTabsPage.tsx`
2. 集成 shadcn Tabs 组件
3. 实现 badge 逻辑

### 阶段 3：内容迁移
1. 将现有 `BehaviorSection` 逻辑迁移到 general tab
2. 将 `ProvidersSection` 逻辑迁移到 providers tab（拆分为独立卡片）
3. 将 `RootsManager` 迁移到 media tab
4. 将 `SecuritySection` 迁移到 security tab
5. 将 `DeploySection` 迁移到 advanced tab

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

### 集成测试

**SettingsTabsPage.test.tsx：**
- Tab 切换正确显示内容
- Badge 数字计算正确
- 空态 / 有数据态正确渲染
- 所有 API 调用正确触发

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

---

## 11. 性能考量

- **Tab 内容懒加载**：当前 tab 不活跃时，不渲染其内容（避免首次加载 7 张 Provider 卡片）
- **数据轮询优化**：只轮询当前活跃 tab 的数据（如 providers tab 才轮询 `useSetupProviders`）
- **卡片虚拟化**：providers tab 有 7 张卡片，但在可视区域内，无需虚拟化

---

## 12. 无障碍（a11y）

- Tab 使用 `role="tablist"` + `role="tab"` + `aria-selected`
- 键盘导航：左右箭头切换 tab
- Badge 使用 `aria-label` 描述状态（如 "3 个已配置，共 7 个"）
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

- 新组件开发（TDD）：4 小时
- Tab 容器 + badge 逻辑：2 小时
- 内容迁移（5 个 tab）：6 小时
- 测试编写 + 调试：3 小时
- E2E 验收（agent-browser）：1 小时

**总计：16 小时**

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
| `TranslateSection` | general tab → AI 翻译卡片 |
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
      <Badge variant="warning">3/7</Badge>
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
