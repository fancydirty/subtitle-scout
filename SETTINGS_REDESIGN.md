# Settings 页面重设计方案

## 📊 调研总结

### 当前问题
- **信息过载**：51 个可交互元素平铺，缺少分组
- **视觉混乱**：Switch、textbox、button 混在一起，无层级
- **缺少呼吸空间**：间距不足，难以快速扫视
- **目录浏览器暴露**：系统根目录按钮（Applications、Library 等）直接显示

### 最佳实践来源
- **Toptal UX 指南**：Settings 应分组、用清晰标签、提供状态反馈
- **Material Design**：使用 list layout + 状态图标 + 分组
- **Vercel 设计系统**：卡片分组 + canvas-soft 背景 + 24px 间距
- **shadcn Pro Blocks**：section cards + 头部 + 侧边导航

---

## 🎨 设计方案

### 布局结构
```
┌─────────────────────────────────────────────────────┐
│ Topbar                                              │
├──────────┬──────────────────────────────────────────┤
│ Sidebar  │  Settings 内容区（p-6, max-w-4xl）      │
│          │                                          │
│          │  ┌────────────────────────────────────┐ │
│          │  │ 引擎配置卡片                        │ │
│          │  │ • 发动机开关 + 状态 badge          │ │
│          │  │ • 目标语言、硬字幕假定              │ │
│          │  │ • 排除特典、扫描间隔                │ │
│          │  │ [保存] 按钮                         │ │
│          │  └────────────────────────────────────┘ │
│          │                                          │
│          │  字幕源（Section 标题）                  │
│          │                                          │
│          │  ┌────────────────────────────────────┐ │
│          │  │ TMDB  [✓ 已配置]                   │ │
│          │  │ API Key: ey•••AY4  [测试]          │ │
│          │  └────────────────────────────────────┘ │
│          │                                          │
│          │  ┌────────────────────────────────────┐ │
│          │  │ LLM (AI 翻译)  [⚠️ 未启用]         │ │
│          │  │ Base URL: ht•••v1                  │ │
│          │  │ Model: mim•••2.5                   │ │
│          │  │ API Key: ip•••qdh  [测试]          │ │
│          │  └────────────────────────────────────┘ │
│          │                                          │
│          │  ... (ASSRT, OpenSubtitles, Jimaku)    │
│          │                                          │
│          │  ┌────────────────────────────────────┐ │
│          │  │ 媒体目录                            │ │
│          │  │ 无守备目录  [+ 添加目录] 按钮      │ │
│          │  └────────────────────────────────────┘ │
│          │                                          │
│          │  ┌────────────────────────────────────┐ │
│          │  │ 安全                                │ │
│          │  │ • API Key 管理                      │ │
│          │  │ • 修改密码                          │ │
│          │  └────────────────────────────────────┘ │
│          │                                          │
│          │  ┌────────────────────────────────────┐ │
│          │  │ ▸ 高级设置（Accordion，默认折叠）  │ │
│          │  └────────────────────────────────────┘ │
└──────────┴──────────────────────────────────────────┘
```

---

## 🧱 组件规格

### 1. Section 标题
```tsx
<h2 className="text-lg font-semibold text-foreground mb-4">
  字幕源
</h2>
```
- Typography: text-lg (18px) + font-semibold
- Spacing: mb-4 (16px)

### 2. 配置卡片（Card）
```tsx
<div className="rounded-lg border border-border bg-card p-6 space-y-4">
  {/* 卡片头部 */}
  <div className="flex items-center justify-between">
    <h3 className="text-base font-medium">TMDB</h3>
    <Badge variant="success">✓ 已配置</Badge>
  </div>
  
  {/* 卡片内容 */}
  <div className="space-y-3">
    <div>
      <label className="text-sm font-medium">API Key</label>
      <div className="flex gap-2 mt-1">
        <Input value="ey•••AY4" readOnly className="flex-1" />
        <Button variant="outline" size="sm">复制</Button>
      </div>
    </div>
    <Button variant="secondary">测试连接</Button>
  </div>
</div>
```

**样式规格：**
- 背景：`bg-card`（等同于 `--color-secondary` #16181f）
- 圆角：`rounded-lg`（8px）
- 边框：`border-border`（1px hairline）
- 内边距：`p-6`（24px）
- 卡片间距：`space-y-6`（24px）

### 3. 状态 Badge
```tsx
// 已配置
<Badge variant="success" className="text-xs">
  ✓ 已配置
</Badge>

// 未配置
<Badge variant="warning" className="text-xs">
  ⚠️ 未配置
</Badge>

// 可选
<Badge variant="secondary" className="text-xs">
  可选
</Badge>
```

### 4. 表单字段
```tsx
<div className="space-y-1.5">
  <label className="text-sm font-medium text-foreground">
    API Key
  </label>
  <Input 
    type="text" 
    placeholder="输入 API Key"
    className="h-10"  // 40px 高度
  />
  <p className="text-xs text-muted-foreground">
    在 TMDB 官网申请 API Key
  </p>
</div>
```

### 5. 测试按钮
```tsx
<Button 
  variant="secondary" 
  size="sm"
  className="w-full sm:w-auto"
>
  测试连接
</Button>
```

---

## 📐 Spacing 规范

基于 Vercel 和 Tailwind 标准：

| 用途 | Spacing | Tailwind Class |
|------|---------|----------------|
| 表单字段内部 | 8px | `space-y-2` |
| 表单字段间 | 12-16px | `space-y-3` / `space-y-4` |
| 卡片内部元素 | 16px | `space-y-4` |
| 卡片间距 | 24px | `space-y-6` |
| Section 间距 | 32px | `space-y-8` |
| 页面内边距 | 24px | `p-6` |

---

## 🔄 重构计划

### Phase 1: 结构重组（优先级 P0）
1. 创建 `SettingsCard` 组件
2. 创建 `SettingsSection` 组件
3. 重构现有 Settings 页面为卡片布局
4. 添加 Section 标题

### Phase 2: 视觉优化（优先级 P1）
1. 添加状态 Badge（已配置/未配置/可选）
2. 统一表单字段高度（40px）
3. 增加卡片间距到 24px
4. API Key 显示改为 `••••••••` + 复制按钮

### Phase 3: 交互增强（优先级 P2）
1. 测试按钮显示加载态 + 结果 toast
2. 媒体目录浏览器改为 Dialog modal
3. 环境变量折叠成 Accordion
4. 添加"重置到默认值"功能

---

## 🎯 预期效果

**改进前：**
- 51 个元素平铺
- 难以快速找到配置项
- 视觉混乱

**改进后：**
- 5 个清晰的 Section
- 每个服务独立卡片，一目了然
- 状态 badge 快速识别配置状态
- 24px 间距，舒适的阅读体验

---

## 📝 实现示例

### SettingsCard 组件
```tsx
// web/src/components/settings/SettingsCard.tsx
import { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface SettingsCardProps {
  title: string
  description?: string
  status?: 'configured' | 'unconfigured' | 'optional'
  children: ReactNode
  className?: string
}

export function SettingsCard({
  title,
  description,
  status,
  children,
  className,
}: SettingsCardProps) {
  const statusBadge = {
    configured: { label: '✓ 已配置', variant: 'success' },
    unconfigured: { label: '⚠️ 未配置', variant: 'warning' },
    optional: { label: '可选', variant: 'secondary' },
  }

  return (
    <div className={cn('rounded-lg border border-border bg-card p-6', className)}>
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-base font-medium text-foreground">{title}</h3>
          {description && (
            <p className="text-sm text-muted-foreground mt-1">{description}</p>
          )}
        </div>
        {status && (
          <Badge variant={statusBadge[status].variant} className="text-xs">
            {statusBadge[status].label}
          </Badge>
        )}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  )
}
```

### SettingsSection 组件
```tsx
// web/src/components/settings/SettingsSection.tsx
import { ReactNode } from 'react'

interface SettingsSectionProps {
  title: string
  description?: string
  children: ReactNode
}

export function SettingsSection({ title, description, children }: SettingsSectionProps) {
  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {description && (
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        )}
      </div>
      {children}
    </section>
  )
}
```

### 使用示例
```tsx
// web/src/pages/Settings.tsx
<div className="space-y-8 p-6 max-w-4xl mx-auto">
  {/* 引擎配置 */}
  <SettingsCard title="引擎配置" status="configured">
    <div className="flex items-center justify-between">
      <label className="text-sm font-medium">发动机</label>
      <Switch checked={engineEnabled} onCheckedChange={setEngineEnabled} />
    </div>
    {/* 其他配置项 */}
  </SettingsCard>

  {/* 字幕源 */}
  <SettingsSection title="字幕源" description="配置字幕元数据和下载来源">
    <SettingsCard title="TMDB" status="configured">
      <div className="space-y-3">
        <div>
          <label className="text-sm font-medium">API Key</label>
          <div className="flex gap-2 mt-1">
            <Input value="ey•••AY4" readOnly />
            <Button variant="outline" size="sm">复制</Button>
          </div>
        </div>
        <Button variant="secondary">测试连接</Button>
      </div>
    </SettingsCard>

    <SettingsCard title="LLM (AI 翻译)" status="unconfigured">
      {/* LLM 配置 */}
    </SettingsCard>
  </SettingsSection>
</div>
```

---

## ✅ 验收标准

1. **视觉层级清晰**：一眼看出 5 个 Section 和各服务状态
2. **信息密度合理**：每屏显示 2-3 张卡片，不拥挤
3. **快速扫视**：3 秒内找到任意配置项
4. **状态可见**：配置状态通过 badge 一目了然
5. **响应式**：窄屏下卡片堆叠，保持可读性

---

## 📚 参考资源

- [Toptal: Settings UX Best Practices](https://www.toptal.com/designers/ux/settings-ux)
- [Material Design: Settings Pattern](https://m3.material.io/)
- [shadcn Pro Blocks: Settings Examples](https://www.shadcndesign.com/pro-blocks/settings)
- [Vercel Design System Analysis](https://github.com/VoltAgent/awesome-design-md)
