# 依赖许可证审计报告

**审计日期**: 2026-08-25  
**项目**: subtitle-scout  
**项目许可证**: GPL v3.0  

---

## 兼容性总结

### ✅ 整体结论：与 GPL v3.0 兼容

所有依赖均与 GPL v3.0 兼容，无阻塞性问题。

### ⚠️ 需要注意的依赖

1. **7z-wasm (GNU LGPL v2.1 + unRAR restriction)**
   - 使用 LGPL v2.1 许可证，与 GPL v3.0 兼容
   - 包含 unRAR 限制：禁止用于重新创建 RAR 压缩算法
   - **建议**: 确保项目不涉及 RAR 压缩功能的开发

2. **package.json 声明不一致**
   - `package.json` 中声明为 `"license": "MIT"`
   - 实际项目根目录 `LICENSE` 文件为 GPL v3.0
   - **建议**: 修正 `package.json` 中的许可证字段为 `"GPL-3.0"`

---

## 许可证分布统计

基于 `npx license-checker --summary` 的结果：

| 许可证类型 | 数量 | GPL v3.0 兼容性 |
|-----------|------|----------------|
| MIT | 83 | ✅ 兼容 |
| Apache-2.0 | 11 | ✅ 兼容 |
| ISC | 8 | ✅ 兼容 |
| BSD-3-Clause | 2 | ✅ 兼容 |
| MPL-2.0 | 2 | ✅ 兼容 |
| BSD-2-Clause | 1 | ✅ 兼容 |
| GNU LGPL v2.1 + unRAR | 1 | ✅ 兼容（有限制） |
| (MIT OR WTFPL) | 1 | ✅ 兼容 |
| (AFL-2.1 OR BSD-3-Clause) | 1 | ✅ 兼容 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 | ✅ 兼容 |
| UNLICENSED | 1 | ⚠️ 项目本身 |

**总计**: 112 个依赖

---

## 核心依赖详细审计

### 运行时依赖 (dependencies)

| 包名 | 版本 | 许可证 | 兼容性 | 备注 |
|------|------|--------|--------|------|
| @ai-sdk/openai-compatible | ^3.0.5 | Apache-2.0 | ✅ | Vercel AI SDK |
| @ctrl/video-filename-parser | ^5.11.4 | MIT | ✅ | 视频文件名解析 |
| 7z-wasm | ^1.2.0 | LGPL v2.1 + unRAR | ✅ | 7-Zip WASM，注意 unRAR 限制 |
| adm-zip | ^0.5.18 | MIT | ✅ | ZIP 文件处理 |
| ai | ^7.0.15 | Apache-2.0 | ✅ | Vercel AI SDK |
| better-sqlite3 | ^12.11.1 | MIT | ✅ | SQLite 数据库 |
| chardet | ^2.2.0 | MIT | ✅ | 字符编码检测 |
| dotenv | ^17.4.2 | BSD-2-Clause | ✅ | 环境变量加载 |
| iconv-lite | ^0.7.3 | MIT | ✅ | 字符编码转换 |
| undici | ^7.28.0 | MIT | ✅ | HTTP 客户端 |
| zod | ^4.4.3 | MIT | ✅ | Schema 验证 |

### 可选依赖 (optionalDependencies)

| 包名 | 版本 | 许可证 | 兼容性 | 备注 |
|------|------|--------|--------|------|
| @types/ffprobe-static | ^2.0.3 | MIT | ✅ | TypeScript 类型定义 |
| ffprobe-static | ^3.1.0 | MIT | ✅ | FFprobe 静态二进制 |

### 开发依赖 (devDependencies)

| 包名 | 版本 | 许可证 | 兼容性 | 备注 |
|------|------|--------|--------|------|
| @types/adm-zip | ^0.5.8 | MIT | ✅ | TypeScript 类型定义 |
| @types/better-sqlite3 | ^7.6.13 | MIT | ✅ | TypeScript 类型定义 |
| @types/node | ^26.1.0 | MIT | ✅ | TypeScript 类型定义 |
| tsx | ^4.23.0 | MIT | ✅ | TypeScript 执行器 |
| typescript | ^6.0.3 | Apache-2.0 | ✅ | TypeScript 编译器 |
| vitest | ^4.1.10 | MIT | ✅ | 测试框架 |

---

## 重点依赖分析

### 1. better-sqlite3 (MIT)
- **许可证**: MIT
- **兼容性**: ✅ 完全兼容
- **说明**: MIT 是宽松许可证，可以在 GPL v3.0 项目中使用

### 2. AI SDK 相关包 (Apache-2.0)
- **包含**: ai, @ai-sdk/openai-compatible, @ai-sdk/provider, @ai-sdk/gateway
- **许可证**: Apache-2.0
- **兼容性**: ✅ 完全兼容
- **说明**: Apache-2.0 与 GPL v3.0 兼容（Apache-2.0 可以升级为 GPL）

### 3. 7z-wasm (LGPL v2.1 + unRAR restriction)
- **许可证**: GNU LGPL v2.1 with unRAR restriction
- **兼容性**: ✅ 兼容但有限制
- **详细说明**:
  - LGPL v2.1 是弱版权保护许可证，允许在 GPL v3.0 项目中使用
  - 包含的 7zz.*.js 和 7zz.wasm 文件使用 LGPL + unRAR 限制
  - **unRAR 限制**：不能用于重新创建 RAR 压缩算法
  - **建议**：subtitle-scout 仅使用解压功能，不涉及 RAR 压缩算法开发，因此符合限制

### 4. 测试框架 (vitest, MIT)
- **许可证**: MIT
- **兼容性**: ✅ 完全兼容
- **说明**: 开发依赖，不影响最终产物的许可证

### 5. TypeScript (Apache-2.0)
- **许可证**: Apache-2.0
- **兼容性**: ✅ 完全兼容
- **说明**: 编译器工具，编译后的代码不受 TypeScript 许可证影响

### 6. lightningcss (MPL-2.0)
- **许可证**: Mozilla Public License 2.0
- **兼容性**: ✅ 兼容
- **说明**: MPL-2.0 是弱版权保护许可证，与 GPL v3.0 兼容

---

## GPL v3.0 兼容性说明

### 宽松许可证（Permissive Licenses）
以下许可证均与 GPL v3.0 兼容，可以在 GPL v3.0 项目中自由使用：

- **MIT**: 最宽松，无限制
- **Apache-2.0**: 兼容 GPL v3.0，提供专利授权保护
- **BSD-2-Clause / BSD-3-Clause**: 简单的版权声明要求
- **ISC**: 与 MIT 类似的宽松许可证

### 弱版权保护许可证（Weak Copyleft）
- **LGPL v2.1**: 与 GPL v3.0 兼容，允许动态链接
- **MPL-2.0**: 文件级别的版权保护，与 GPL v3.0 兼容

### 不兼容的许可证（本项目未使用）
以下许可证与 GPL v3.0 **不兼容**，本项目中**未发现**：

- ❌ GPL v2 only (without "or later" clause)
- ❌ 专有/商业许可证
- ❌ Commons Clause
- ❌ SSPL (Server Side Public License)

---

## 建议和行动项

### 🔴 必须修复

1. **修正 package.json 中的许可证声明**
   ```diff
   - "license": "MIT",
   + "license": "GPL-3.0",
   ```

### 🟡 建议改进

2. **添加许可证声明文件**
   - 在项目中添加 `NOTICE` 文件，列出所有第三方依赖的许可证
   - 特别说明 7z-wasm 的 LGPL + unRAR 限制

3. **源码文件头部添加版权声明**
   - 在主要源码文件顶部添加 GPL v3.0 标准声明
   - 示例：
     ```typescript
     /**
      * subtitle-scout
      * Copyright (C) 2024  [Your Name]
      * 
      * This program is free software: you can redistribute it and/or modify
      * it under the terms of the GNU General Public License as published by
      * the Free Software Foundation, either version 3 of the License, or
      * (at your option) any later version.
      */
     ```

### 🟢 可选优化

4. **考虑使用 license-checker 作为 CI 检查**
   ```json
   "scripts": {
     "license-check": "npx license-checker --failOn 'GPL-2.0;AGPL;SSPL'"
   }
   ```

5. **定期审计依赖许可证**
   - 每次添加新依赖时检查许可证
   - 每季度运行完整的许可证审计

---

## 技术细节

### 审计工具使用

```bash
# 许可证统计
npx license-checker --summary

# 详细列表（JSON 格式）
npx license-checker --json

# 查看特定依赖
cat node_modules/7z-wasm/License.txt
```

### 验证方法

1. 检查 `package.json` 的 dependencies 和 devDependencies
2. 使用 `license-checker` 工具扫描所有依赖（包括间接依赖）
3. 手动验证关键依赖的许可证文件
4. 交叉验证许可证兼容性矩阵

---

## 参考资源

- [GNU GPL v3.0 完整文本](https://www.gnu.org/licenses/gpl-3.0.html)
- [GPL 兼容性矩阵](https://www.gnu.org/licenses/license-list.html)
- [LGPL 与 GPL 的关系](https://www.gnu.org/licenses/lgpl-3.0.html)
- [Apache-2.0 与 GPL v3.0 兼容性](https://www.apache.org/licenses/GPL-compatibility.html)

---

## 审计人员签名

**审计者**: Kiro (AI Assistant)  
**审计日期**: 2026-08-25  
**下次审计建议**: 2027-02-25（6 个月后）或添加新依赖时
