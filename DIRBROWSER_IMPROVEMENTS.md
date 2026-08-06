# DirBrowser UX 改进建议

## 问题诊断

### 问题1：startPath 被锁定
- 当前 `startPath` 由父组件计算 `commonRootStart(roots)`
- 一旦进入子目录，面包屑只能回到 startPath，无法继续向上

### 问题2：根目录列表不友好
- 无守备目录时，startPath = `/`，显示所有系统目录
- 对服务器环境不友好（/dev, /proc, /sys 等无意义目录）

## 改进方案

### 方案A：固定起点 + 面包屑全路径导航（推荐）

**改动**：
1. **固定 startPath**：
   - 有根时：`commonRootStart(roots)` 
   - 无根时：`/mnt`（NAS/挂载点通常在这里）或 `/home`
   - 提供"切换起点"按钮让用户选择：`/mnt`, `/home`, `/media`, `/`

2. **面包屑支持回到根**：
   ```tsx
   // 在面包屑最前面加一个"切换起点"下拉菜单
   const COMMON_STARTS = [
     { path: '/mnt', label: 'Mounted drives' },
     { path: '/home', label: 'Home' },
     { path: '/media', label: 'Media' },
     { path: '/', label: 'Root (all)' },
   ]
   ```

3. **记住上次选择**（localStorage）

### 方案B：两级模式

**第一级**：选择起点区域
- 按钮组：`/mnt`, `/home`, `/media`, `/ (show all)`

**第二级**：从选定区域开始浏览
- 面包屑可回到第一级

### 方案C：智能起点推断

**无根时的起点逻辑**：
```typescript
// 按优先级探测存在的目录
async function detectStartPath(): Promise<string> {
  const candidates = ['/mnt', '/media', '/home', '/']
  for (const path of candidates) {
    const { dirs } = await api.fsList(path)
    if (dirs && dirs.length > 0) return path
  }
  return '/'
}
```

**已有根时**：
- 如果只有一个根 `/mnt/nas1/media`，startPath = `/mnt/nas1`（父目录，方便添加兄弟目录）
- 如果多个根共享父目录，startPath = 公共父目录

## 代码改动建议

### 1. RootsManager.tsx

```tsx
const QUICK_STARTS = [
  { path: '/mnt', label: 'Mounts' },
  { path: '/home', label: 'Home' },
  { path: '/media', label: 'Media' },
]

const [manualStart, setManualStart] = useState<string | null>(null)
const startPath = useMemo(() => {
  if (manualStart) return manualStart
  if (list.length === 0) return '/mnt' // 默认挂载点
  return commonRootStart(list.map(r => r.path))
}, [list, manualStart])

// 在 DirBrowser 上方添加快速起点按钮
<div className="flex gap-2">
  {QUICK_STARTS.map(s => (
    <Button 
      key={s.path}
      size="sm" 
      variant={startPath === s.path ? 'default' : 'secondary'}
      onClick={() => setManualStart(s.path)}
    >
      {s.label}
    </Button>
  ))}
</div>
```

### 2. DirBrowser.tsx

允许用户通过面包屑导航到 startPath 之上：

```tsx
// 移除 startPath 限制，允许完全自由导航
// 面包屑点击 '/' 时，真的回到根目录
```

### 3. 添加"返回推荐起点"按钮

```tsx
<Button 
  size="sm" 
  variant="ghost"
  onClick={() => setCurrentPath(startPath)}
>
  ← Back to {startPath}
</Button>
```

## 实现优先级

**Phase 1（快速修复）**：
- [ ] 无根时 startPath 改为 `/mnt` 而非 `/`
- [ ] 添加"切换起点"按钮组

**Phase 2（体验优化）**：
- [ ] 面包屑支持回到根
- [ ] 记住上次选择的起点（localStorage）

**Phase 3（主动扫描）**：
- [ ] 添加目录后触发扫描
- [ ] 显示扫描进度
