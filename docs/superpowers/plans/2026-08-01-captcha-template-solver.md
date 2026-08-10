# 验证码模板求解器实现计划

**目标**：让 zimuku 验证码无需多模态模型即可破解，项目只需配置纯文本 LLM 即可运行。

**设计**：模板匹配优先（0 token），未命中时降级到 LLM 视觉兜底（需用户配置多模态模型）。

## 已验证的数据

**10 个数字模板**（从 14 张生产真图归一化后提取，已通过肉眼交叉验证）：

```typescript
const TEMPLATES = {
  '8x14:3c7ee7e7c3cbdfcbc3c3e7e77e3c': '0',
  '7x14:79f3e1c3870e1c3870e1cfffc0': '1',
  '8x14:feff8703030307060c183060ffff': '2',
  '8x14:7eff8703031f3e1e07030387fffe': '3',
  '9x14:0e070783c1e1b198cce67ffff6f06030': '4',
  '8x14:7e7e60607c7e7f4703030387fe7c': '5',
  '8x14:3e7e72e0e0dcfeffe7c3c3e77f7e': '6',
  '8x14:ffff0606060c0c0c1c1c18383830': '7',
  '8x14:7e7fe7c3c37e7e7ec3c3c3e7ff7e': '8',
  '8x14:7efee7c3c3e7ff7f3b07074e7e7c': '9',
}
```

**14 张真图**：已拉到本机 `/tmp/zimuku-captcha-fixtures/cap-{00..13}.bmp`，每张已人工标注读数。

## 实现步骤

### 1. 数据文件：`src/adapters/providers/captchaTemplates.ts`

创建模板数据文件，导出：

```typescript
export const ZIMUKU_DIGIT_TEMPLATES: Record<string, string> = {
  // 10 条签名 → 数字映射（上面的数据）
}
```

每条带注释说明来源：`// 2026-08-01 从 14 张生产真图提取，肉眼交叉验证 100%`

### 2. 模板匹配逻辑：`src/adapters/providers/captchaTemplateSolver.ts`

```typescript
export function solveByTemplate(bmpBytes: Uint8Array): string | null {
  // 1. 解析 BMP（复用现有 parseBMP24）
  // 2. Otsu 二值化
  // 3. 连通分量提取外接框
  // 4. 过滤：宽 >= 5 && 高 >= 10
  // 5. 按 x 坐标排序
  // 6. 如果不是恰好 5 个 box → 返回 null
  // 7. 逐个 box 生成签名 `${w}x${h}:${hex}`
  // 8. 查表 ZIMUKU_DIGIT_TEMPLATES
  // 9. 任一字形未命中 → 返回 null（不猜）
  // 10. 全部命中 → 返回 5 位数字字符串
}
```

**关键约束**：
- 外接框归一化必须精确（实测有 ±2px 抖动 + 宽度按数字变）
- Otsu 阈值自适应（不能硬编码 128）
- 签名格式：`宽x高:hex`，hex 是按行扫描的位图，每 8 bit 打包成一个字节

### 3. 组合求解器：`src/adapters/captchaSolver.ts`

```typescript
export function makeCaptchaSolver({ model, emit }: {
  model: LanguageModelV1
  emit: (event: FetchEvent) => void
}): (bytes: Uint8Array) => Promise<{ digits: string } | { digits: null }> {
  return async (bytes) => {
    // 先尝试模板匹配
    const templateResult = solveByTemplate(bytes)
    if (templateResult !== null) {
      return { digits: templateResult }
    }
    
    // 未命中：发出 notice 事件
    emit({
      event: 'provider_notice',
      provider: 'zimuku',
      code: 'captcha_template_miss',
      message: 'CAPTCHA 字形未命中模板，降级到 LLM 视觉识别'
    })
    
    // 降级到 LLM
    return solveNumericCaptcha(model, bytes)
  }
}
```

使用现有 `FetchEvent` 联合类型（`fetchLib.ts:12-25`），不新造事件类型。

### 4. 接线：`src/adapters/buildAdapters.ts`

在 `buildAdapters` 函数中，找到构造 `yunsuo` 和 `zimuku` 的地方，修改一行：

```typescript
const solve = makeCaptchaSolver({ model, emit })

const zimuku = zimukuAdapter({ solve, emit, fetchWithPolicy })
const yunsuo = yunsuoAdapter({ solve, emit, fetchWithPolicy })
```

`yunsuo.ts` 和 `zimuku.ts` 零改动（它们已经通过参数接收 `solve` 回调）。

### 5. 测试：`src/adapters/captchaSolver.test.ts`

**fixtures 准备**：
```bash
mkdir -p src/adapters/providers/__fixtures__/zimuku/captcha
cp /tmp/zimuku-captcha-fixtures/*.bmp src/adapters/providers/__fixtures__/zimuku/captcha/
```

**正例**：14 张真图，逐张断言：
```typescript
test('solveByTemplate 14 张真图全部命中', () => {
  const cases = [
    { file: 'cap-00.bmp', expected: '02998' },
    { file: 'cap-01.bmp', expected: '43319' },
    { file: 'cap-02.bmp', expected: '95280' },
    { file: 'cap-03.bmp', expected: '23516' },
    { file: 'cap-04.bmp', expected: '91491' },
    // ... 14 条
  ]
  
  for (const { file, expected } of cases) {
    const bytes = readFileSync(`__fixtures__/zimuku/captcha/${file}`)
    const result = solveByTemplate(bytes)
    expect(result).toBe(expected)
  }
})
```

**负例**：
- 截断字节 → 返回 `null`
- 8bpp/32bpp BMP 头 → 返回 `null`
- 合成 4 段/6 段图（不是 5 个数字）→ 返回 `null`
- 翻转一个像素造未知字形 → 返回 `null`

**组合器测试**：
- 命中路径：模板匹配成功 → LLM 桩被调用 0 次
- 未命中路径：模板返回 `null` → LLM 桩被调用 1 次 + 发出 `provider_notice` 事件

### 6. 一个待验证的点

`solveNumericCaptcha.ts:44` 把 BMP 字节标成 `mediaType:'image/png'`。标签是错的，但 MiMo 嗅 magic bytes 容忍了。

**实现时的操作**：
1. 先发一次真调用验证 `image/bmp` 是否被接受
2. 通了 → 改成 `image/bmp`
3. 不通 → 保留错标签 + 写注释说明为什么不能改

**不猜，用证据决定。**

## 非目标（YAGNI）

❌ 不做验证码结果缓存（挑战页每次轮换 pending 会话，缓存无意义）  
❌ 不做"LLM 读数自动回填模板表"（误读会永久投毒，静默失效）  
❌ 字体真变了应该响铃让人看见，不该自动学

## 验收标准

1. ✅ 后端测试全绿（包括 14 张正例 + 4 类负例 + 组合器 2 条路径）
2. ✅ 前端测试不受影响
3. ✅ 实际部署后，zimuku 抓取成功率不变
4. ✅ 项目配置 `LLM_MODEL=deepseek-v4-flash`（纯文本）能正常运行全流程

## 预期效果

- 模板命中时：~0.1ms，0 token
- 模板未命中时：降级到 LLM，发出 notice 事件让用户看见
- 多模态模型从硬需求降级成抗字体变化的保险丝
