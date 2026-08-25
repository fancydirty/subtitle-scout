# Contributing to Subtitle Scout

感谢考虑为 Subtitle Scout 做贡献！

## Code of Conduct

遵循常识：尊重、建设性、专业。我们希望为所有贡献者创造一个友好和包容的环境。

## How to Contribute

### Reporting Bugs

在提交 bug 前：
- 搜索现有 [issues](https://github.com/fancydirty/subtitle-scout/issues) 避免重复报告
- 确认是 bug 而非使用问题

提交 bug 时请提供：
- **操作系统**：macOS / Linux / Windows + 版本
- **Docker 版本**：`docker --version` 输出
- **复现步骤**：具体的操作流程
- **日志信息**：相关的错误日志或堆栈追踪
- **预期行为 vs 实际行为**

### Suggesting Features

新功能建议前：
- 先开 issue 讨论，避免做无用功
- 清楚说明 **use case**：为什么需要这个功能？解决什么问题？
- 考虑是否适合所有用户，而非特定场景

我们更倾向接受：
- 提升核心功能体验的改进
- 广泛适用的字幕源支持
- 性能和稳定性优化

### Pull Requests

**提交 PR 前的流程：**

1. **Fork 仓库** 并 clone 到本地
   ```bash
   git clone https://github.com/fancydirty/subtitle-scout.git
   cd subtitle-scout
   ```

2. **创建功能分支**
   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **遵循代码风格**
   - TypeScript strict mode
   - 跟随现有代码的组织方式
   - 使用有意义的变量和函数名

4. **为新功能编写测试**
   - 单元测试覆盖核心逻辑
   - 集成测试验证端到端流程

5. **运行测试**
   ```bash
   npm test
   ```

6. **清晰的 commit message**
   ```
   feat: add support for OpenSubtitles API v2
   fix: handle empty search results gracefully
   docs: update README with new provider setup
   ```

7. **提交 PR**
   - 在描述中说明：做了什么、为什么、如何测试
   - 关联相关 issue（如 `Closes #123`）

## Development Setup

```bash
# Clone your fork
git clone https://github.com/fancydirty/subtitle-scout.git
cd subtitle-scout

# Install dependencies
npm install

# Run tests
npm test

# Start development
npm run dev
```

### 项目结构

```
subtitle-scout/
├── src/
│   ├── providers/      # 字幕源实现
│   ├── core/           # 核心逻辑
│   ├── utils/          # 工具函数
│   └── types/          # TypeScript 类型定义
├── tests/              # 测试文件
└── docs/               # 文档
```

## Code Style

- **TypeScript strict mode**：确保类型安全
- **Prettier**：自动格式化（配置在 `.prettierrc`）
- **ESLint**：代码质量检查（如有配置）
- **测试覆盖**：新功能必须包含测试

运行格式化：
```bash
npm run format  # 如果配置了该脚本
```

## Testing Guidelines

- 单元测试放在 `tests/unit/`
- 集成测试放在 `tests/integration/`
- 使用描述性的测试名称：
  ```typescript
  describe('SubtitleProvider', () => {
    it('should return empty array when no subtitles found', () => {
      // test implementation
    });
  });
  ```

## Documentation

如果你的 PR 引入了：
- 新功能：更新 README.md
- 新配置选项：更新配置文档
- API 变更：更新相关文档

## Questions?

有疑问随时开 issue 或在现有讨论中提问。

## License

By contributing, you agree that your contributions will be licensed under the **GPL v3.0** license.

---

再次感谢你的贡献！🎉
