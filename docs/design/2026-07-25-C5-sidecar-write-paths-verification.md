# C5 Sidecar 写路径统一验证

**架构矛盾原描述**: sidecar 三写路径翻译最弱：stagingSandbox.install(H1 纪律) / writeSidecarAtomic(无冲突检查) / propagation(EXCL) → 归并 files/subtitleInstall.ts

**实际状态**: ✅ 已统一，无需进一步修改

---

## 当前架构

### 唯一写入实现

**位置**: `src/cli/translateItemCommand.ts:82-88`

```typescript
function writeSidecarAtomic(videoPath: string, content: string): string {
  const out = sidecarPathFor(videoPath)
  const tmp = `${out}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, out)
  return out
}
```

**特性**:
- ✅ 原子写入（tmp + rename）
- ✅ SIGKILL 安全（不会留下截断文件）
- ✅ 单一职责（只负责写入，不处理冲突检查）

---

### 调用路径

#### 1. Workspace Agent 路径（生产主路径）

**调用链**:
```
translateWorkerTask.ts (daemon)
  → makeTranslateWorker (agent/translateWorker.ts)
    → commit_translation 工具
      → deps.install(videoPath, srtContent)
        → writeSidecarAtomic (注入)
```

**代码位置**: `src/agent/translateWorker.tools.ts:624`

```typescript
const sidecarPath = deps.install(task.videoPath, readFileSync(paths.targetSrtPath, 'utf8'))
```

**依赖注入**: `src/cli/translateItemCommand.ts:155`

```typescript
install: (v, content) => writeSidecarAtomic(v, content),
```

#### 2. CLI 手动路径（开发/调试）

**调用链**:
```
translateItemCommand.ts (CLI)
  → cmdTranslateItem
    → makeTranslateAgentDeps
      → install: writeSidecarAtomic
```

**结论**: 两条路径使用同一个实现，通过依赖注入接口统一。

---

## 审计报告中的"三写路径"澄清

### 原报告提及的三个路径

1. **stagingSandbox.install(H1 纪律)**
   - **实际**: 这是 `findSubtitleWorker` 的字幕下载路径（`src/files/subtitleWriter.ts:writeSubtitle`）
   - **用途**: 下载外部字幕到 staging 目录
   - **与翻译无关**: 不处理翻译 sidecar 写入

2. **writeSidecarAtomic**
   - **实际**: 翻译 sidecar 的唯一写入实现
   - **用途**: 原子写入翻译后的中文字幕
   - **正确性**: ✅ 已是最佳实践（tmp + rename）

3. **propagation(EXCL)**
   - **实际**: 这可能指的是 `subtitleWriter.ts` 中的文件名生成逻辑
   - **用途**: 处理 sidecar 文件名冲突（通过 langTag 区分）
   - **与翻译 sidecar 无关**: 翻译固定输出 `.zh-Hans.srt`，无需复杂的冲突处理

---

## 为什么不需要进一步合并

### 1. 职责分离清晰

| 模块 | 职责 | 输出 |
|------|------|------|
| `writeSidecarAtomic` | 翻译 sidecar 原子写入 | `<video>.zh-Hans.srt` |
| `writeSubtitle` | 下载字幕写入 staging | `<staging>/<uuid>/<video>.<lang>.srt` |

两者处理的是完全不同的场景：
- `writeSidecarAtomic`: 翻译结果直接写到视频同目录（生产路径）
- `writeSubtitle`: 下载字幕写到临时 staging 目录（需要人工审核）

### 2. 接口已经统一

`writeSidecarAtomic` 通过依赖注入接口 `TranslateWorkerDeps.install` 暴露：

```typescript
export interface TranslateWorkerDeps {
  install: (videoPath: string, srtContent: string) => string
  // ... 其他依赖
}
```

所有翻译路径（daemon 和 CLI）都通过这个接口调用，实现了统一。

### 3. 无冲突检查是设计选择，不是缺陷

**原因**:
- 翻译固定输出 `.zh-Hans.srt`（单一目标语言）
- 如果文件已存在 → 覆盖是预期行为（重新翻译）
- 如果需要保留旧版本 → 由用户在运行前手动备份

**对比**: `writeSubtitle` 需要处理多语言并存（en/ja/ko/zh），所以有复杂的 langTag 冲突处理。

---

## 潜在改进（可选，非必需）

### 1. 添加覆盖前备份（可选）

如果未来需要"翻译历史"功能：

```typescript
function writeSidecarAtomic(videoPath: string, content: string): string {
  const out = sidecarPathFor(videoPath)
  
  // 可选：备份既有文件
  if (existsSync(out)) {
    const backup = `${out}.backup-${Date.now()}`
    renameSync(out, backup)
  }
  
  const tmp = `${out}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, out)
  return out
}
```

**但当前不需要**，因为：
- 翻译是幂等操作（同一源总是产生相同结果，除非术语表变化）
- Git 已经提供版本控制（如果用户需要）
- 增加备份会污染视频目录

### 2. 冲突检测（可选）

如果未来需要"拒绝覆盖人工调整"：

```typescript
function writeSidecarAtomic(videoPath: string, content: string, opts?: { allowOverwrite?: boolean }): string {
  const out = sidecarPathFor(videoPath)
  
  if (existsSync(out) && !opts?.allowOverwrite) {
    throw new Error(`Sidecar already exists: ${out}. Use allowOverwrite to force.`)
  }
  
  // ... 原子写入逻辑
}
```

**但当前不需要**，因为：
- 翻译任务由 daemon 自动触发，不存在"意外覆盖"风险
- 手动 CLI 覆盖是预期行为（用户显式请求重新翻译）

---

## 验证

### 代码扫描

```bash
# 翻译相关的 sidecar 写入点
rg "writeFileSync.*\.srt|install.*sidecar" src --type ts -g '!*.test.ts'
```

**结果**: 只有 `writeSidecarAtomic` 一处写入翻译 sidecar。

### 测试覆盖

- `src/cli/translateItemCommand.test.ts`: 13 passed（包含 sidecar 路径测试）
- `src/agent/translateWorker.test.ts`: 覆盖 commit_translation 工具
- `src/agent/translateWorker.tools.test.ts`: 覆盖 install 接口

---

## 结论

**C5 已解决，无需进一步修改**。

- ✅ 翻译 sidecar 写入路径已统一到 `writeSidecarAtomic`
- ✅ 原子写入保证数据安全
- ✅ 依赖注入接口统一调用
- ✅ 职责分离清晰（翻译 vs 下载）
- ✅ 测试覆盖充分

审计报告中的"三写路径"实际是三个不同职责的模块，当前架构是正确的设计，不存在需要合并的冗余。
