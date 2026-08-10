# Spec：验证码模板求解器（模板优先 + LLM 兜底）

**日期**：2026-08-01  
**状态**：待实现  
**目标**：让 zimuku 验证码破解**不再依赖多模态模型**，改用模板匹配（~0.1ms，0 token）+ 纯文本 LLM 兜底（字体变化时保险），从而项目只需配一个纯文本 LLM API 即可运行全流程。

---

## 1. 背景与收割数据

### 1.1 字体稳定性已证实

**收割探针**（`/tmp/harvest.mjs`）在容器内复刻 `ZIMUKU_HEADERS` + 钉死 undici Agent，抓取 14 次挑战页：
- **14 张图 → 70 个字形（14×5）**
- 外接框归一化后**恰好 10 个不同位图**，无一例外
- **10 簇 = 0..9 全齐**
- 跨次渲染稳定：同一数字的位图签名 100% 一致

**交叉验证**（`/tmp/verify.mjs`）用真 LLM（mimo-v2.5）视觉读数与模板读数比对：
- 14/14 **全部一致**
- 验证了肉眼标注的 0..9 标签正确

位置有 ±2px 抖动（起点 6,26,46,66,86 vs 6,26,47,68,89），宽度按数字变（1 宽 7px、4 宽 9px、其余 8px）→ **外接框归一化是硬需求**，固定网格切分会挂。

### 1.2 现状问题

`buildAdapters.ts:54-70` 组装 zimuku 时**硬编码要求 `LLM_MODEL` 必须多模态**：
```ts
if (process.env.ZIMUKU_ENABLED === 'true') {
  const model = makeModel({
    baseUrl: requireEnvForZimuku('LLM_BASE_URL'),  // ← 缺了就抛错
    apiKey: requireEnvForZimuku('LLM_API_KEY'),
    model: requireEnvForZimuku('LLM_MODEL'),        // ← 必须能看图
  })
  const client = new ZimukuClient({
    solve: async png => solveNumericCaptcha(model, png),  // ← 每次挑战都打 LLM
  })
}
```

`solveNumericCaptcha.ts` 是纯 LLM 视觉识别（2 次尝试，每次 generateText + BMP 图片）。

**用户诉求**：项目只需配一个纯文本 API（如 deepseek-v4-flash）就能跑全流程；多模态从硬需求降级为"字体真变了时的保险"。

---

## 2. 设计

### 2.1 架构

```
ZimukuClient.solve(bytes) 
  ↓
makeCaptchaSolver({ model, emit })  ← 新增：组合求解器
  ↓
  ├─ solveByTemplate(bytes)          ← 新增：模板匹配（~0.1ms，0 token）
  │    ↓ 命中 → 返回 { digits }
  │    ↓ 未命中 → emit('captcha_template_miss') → 继续
  │
  └─ solveNumericCaptcha(model, bytes)  ← 既有 LLM 兜底（不改）
       ↓
     返回 { digits } 或抛错
```

**关键决策**：
1. **模板优先**：命中直接返回，跳过 LLM
2. **未命中时发事件**：`emit({ event:'provider_notice', provider:'zimuku', code:'captcha_template_miss' })`，让运维知道字体可能变了
3. **LLM 兜底不变**：`solveNumericCaptcha` 一个字不动，保持现有重试逻辑

### 2.2 文件结构

| 文件 | 职责 | 行数估算 |
|---|---|---|
| `src/adapters/providers/captchaTemplates.ts` | 10 条模板数据（签名 → 数字） | ~30 |
| `src/adapters/providers/solveByTemplate.ts` | BMP 解析 + 切字 + 归一化 + 查表 | ~120 |
| `src/adapters/captchaSolver.ts` | 组合器：先模板后 LLM | ~40 |
| `src/adapters/buildAdapters.ts` | 接线（一行改动） | +1 |
| `src/adapters/captchaSolver.test.ts` | 离线测试（14 张真图 + 负例） | ~180 |

**不改动**：
- `solveNumericCaptcha.ts` — 保持既有 LLM 逻辑
- `yunsuo.ts` / `zimuku.ts` — 它们本来就零 LLM import，`solve` 是注入回调

### 2.3 模板数据格式

```ts
// src/adapters/providers/captchaTemplates.ts
export const CAPTCHA_TEMPLATES = new Map<string, string>(Object.entries({
  '8x14:18007e006600c300c300c300cb00c300c300c300c30066007e001800': '0',
  '7x14:3000f000d000100010001000100010001000100010001000fe00fe00': '1',
  // ... 共 10 条
}))
```

**签名格式**：`<width>x<height>:<hex>`  
- `width`, `height` = 外接框尺寸
- `hex` = 逐行扫描的 packed 位图（1bit/像素，黑=1）

**出处注释**：每条模板头部写明来源 — `2026-08-01 从生产真渲染收割，14 张图 70 个字形归一化后恰好落 10 簇、零离群，且模板读数与 mimo-v2.5 视觉读数 14/14 全对`

### 2.4 solveByTemplate 逻辑

```ts
// src/adapters/providers/solveByTemplate.ts
export function solveByTemplate(bmpBytes: Buffer): { digits: string } | null {
  // 1. 解 BMP 头（验证 magic 'BM'、24bpp、无压缩）
  const { width, height, pixels } = parseBMP(bmpBytes)
  if (!pixels) return null
  
  // 2. 转灰度（RGB → Y = 0.299R + 0.587G + 0.114B）
  const gray = toGrayscale(pixels, width, height)
  
  // 3. 切 5 个数字：findBoundingBoxes() → 按 x 排序 → 必须恰好 5 个
  const boxes = findBoundingBoxes(gray, width, height)
  if (boxes.length !== 5) return null
  boxes.sort((a,b) => a.x - b.x)
  
  // 4. 每个 box 归一化 → 生成签名 → 查表
  const digits: string[] = []
  for (const box of boxes) {
    const cropped = crop(gray, box)
    const normalized = normalize(cropped)  // 外接框 + 二值化
    const sig = makeSignature(normalized)
    const digit = CAPTCHA_TEMPLATES.get(sig)
    if (!digit) return null  // 任一未命中 → 整体失败
    digits.push(digit)
  }
  
  return { digits: digits.join('') }
}
```

**关键约束**：
- 任一字形未命中 → 返回 `null`（不猜）
- 外接框必须精确（实测 ±2px 抖动 + 宽度按数字变）
- 二值化阈值：Otsu 或固定阈值（PoC 时确定）

---

## 3. 组合器（captchaSolver.ts）

```ts
import { solveByTemplate } from './providers/solveByTemplate.js'
import { solveNumericCaptcha } from '../agent/solveNumericCaptcha.js'
import type { LanguageModel } from 'ai'
import type { FetchEvent } from './fetchLib.js'

export function makeCaptchaSolver(opts: {
  model: LanguageModel
  emit: (e: FetchEvent) => void
}): (bytes: Buffer) => Promise<{ digits: string }> {
  return async (bytes: Buffer) => {
    // 先试模板
    const templateResult = solveByTemplate(bytes)
    if (templateResult) return templateResult
    
    // 未命中 → 发事件
    opts.emit({
      event: 'provider_notice',
      provider: 'zimuku',
      code: 'captcha_template_miss',
    })
    
    // 落到 LLM 兜底
    return solveNumericCaptcha(opts.model, bytes)
  }
}
```

**为什么单独成文件**：否则这段逻辑埋在 `buildAdapters` 的 lambda 里，测它就得把整套 adapter 都装配起来。独立文件 → 可测。

---

## 4. 接线（buildAdapters.ts）

```ts
// 第 66 行，原本：
solve: async png => solveNumericCaptcha(model, png),

// 改为：
solve: makeCaptchaSolver({ model, emit }),
```

一行改动。`yunsuo.ts` / `zimuku.ts` 零改动（它们本来就零 LLM import）。

---

## 5. 测试

### 5.1 离线单测（captchaSolver.test.ts）

**正例**：14 张真图收进 `src/adapters/providers/__fixtures__/zimuku/captcha/`（~114KB），逐张断言：
```ts
const fixtures = [
  { file: '02998.bmp', expected: '02998' },
  { file: '43319.bmp', expected: '43319' },
  // ... 共 14 张
]
for (const { file, expected } of fixtures) {
  const bytes = readFileSync(join(__dirname, 'providers/__fixtures__/zimuku/captcha', file))
  const result = solveByTemplate(bytes)
  expect(result).toEqual({ digits: expected })
}
```

**负例**（必须返回 `null`）：
1. **截断字节** — BMP 头部完整但像素数据截断一半
2. **错误 bpp** — 8bpp 或 32bpp 头（当前只支持 24bpp）
3. **4 段 / 6 段图** — 切出的 box 数量 ≠ 5
4. **未知字形** — 合成一张图，翻一个像素，造出不在模板表里的签名

### 5.2 组合器测试

```ts
describe('makeCaptchaSolver', () => {
  it('命中模板时不调 LLM', async () => {
    const mockModel = {} as LanguageModel  // 空桩
    const mockEmit = vi.fn()
    const solve = makeCaptchaSolver({ model: mockModel, emit: mockEmit })
    
    const bytes = readFileSync(/* 任一真图 */)
    const result = await solve(bytes)
    
    expect(result.digits).toMatch(/^\d{5}$/)
    expect(mockEmit).not.toHaveBeenCalled()
    // ← 如果调了 solveNumericCaptcha，会因 mockModel 是空桩而抛错
  })
  
  it('未命中时发 notice 且调 LLM', async () => {
    const mockModel = /* 构造一个返回 '12345' 的桩 */
    const mockEmit = vi.fn()
    const solve = makeCaptchaSolver({ model: mockModel, emit: mockEmit })
    
    const bytes = /* 合成一个未知字形的图 */
    const result = await solve(bytes)
    
    expect(mockEmit).toHaveBeenCalledWith({
      event: 'provider_notice',
      provider: 'zimuku',
      code: 'captcha_template_miss',
    })
    expect(result.digits).toBe('12345')  // ← LLM 兜底返回的
  })
})
```

---

## 6. 一个待验证的点（实现时再决定）

`solveNumericCaptcha.ts:44` 把 BMP 字节标成 `mediaType:'image/png'`。标签是错的，但 MiMo 嗅 magic bytes 容忍了。

**更诚实的做法**：改成 `'image/bmp'`。  
**风险**：万一小米那头直接拒收 bmp，就把兜底路径悄悄弄死了 — 而兜底正是这次设计的保险丝。

**实现策略**：
1. 先发一次真调用验（用 deepseek-v4-flash + 一张真 BMP，标成 `image/bmp`）
2. 通了 → 改标签 + 写注释说明验证过
3. 不通 → 保留错标签 `image/png` + 写注释说明为什么不能改

---

## 7. 非目标（明确 YAGNI）

1. **不做验证码结果缓存** — 挑战页每次轮换 pending 会话，缓存无意义
2. **不做"LLM 读数自动回填模板表"** — 一次误读会永久投毒查表，而且投毒后静默。字体真变了就该**响铃让人看见**（通过 `captcha_template_miss` 事件），不该自动学

---

## 8. 成功标准

- [ ] 前端 14 张真图全部命中模板，`solveByTemplate` 返回正确读数
- [ ] 4 种负例全部返回 `null`
- [ ] 组合器测试：命中时 LLM 桩被调 0 次；未命中时恰好调 1 次且发出 `captcha_template_miss`
- [ ] `npm test` 与 `tsc --noEmit` 全绿
- [ ] 改完后：配 `ZIMUKU_ENABLED=true` + `LLM_MODEL=deepseek-v4-flash`（纯文本），**能跑通一次完整的 zimuku search → 遇挑战 → 模板破解 → 返回结果**

---

## 9. 后续（本 spec 范围外）

翻译模型的设计（用户提到的想法）：
- 逻辑上分两种：用户是否开 agent 翻译功能 + agent 翻译功能用的模型是否跟全局模型一致
- 如果留空不写（不用专门的翻译模型但是开了开关），则翻译模型沿用全局模型

**本 spec 不处理翻译模型**，专注验证码求解器。翻译模型留待后续单独设计。
