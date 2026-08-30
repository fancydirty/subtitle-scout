# Contributing to Subtitle Scout

[English](./CONTRIBUTING.en.md) · [中文](#contributing-to-subtitle-scout)

感谢考虑为 Subtitle Scout 做贡献。

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

# 类型检查
npm run check

# 后端测试
npm test

# 前端测试（web/ 是独立包）
npm test --prefix web
```

本地跑完整链路（不需要 NAS 或真实媒体库）见 README 的 Local development 一节：
`scripts/gen-mock-library.sh` + `docker compose -f docker-compose.local.yml up -d --build`。

### 项目结构

```
subtitle-scout/
├── src/          # daemon、adapters、CLI、dashboard API
├── web/          # dashboard 前端（独立 npm 包）
├── docs/         # 对外文档（凭据指引、架构说明）
└── CONTRIBUTING.md
```

## Code Style

- **TypeScript strict mode**：确保类型安全，提交前跑 `npm run check`
- **跟随周边代码风格**：仓库没有 Prettier / ESLint 配置，也没有 format 脚本——照你改动附近的既有写法来
- **测试覆盖**：新功能必须包含测试

## Testing Guidelines

- 测试文件与被测源码同目录，命名 `*.test.ts`（例：`src/adapters/fetchLib.ts` 旁边是 `src/adapters/fetchLib.test.ts`）；仓库没有独立的 `tests/` 目录
- 后端 `npm test`，前端 `npm test --prefix web`——改哪个包就跑哪个，两边都碰就都跑
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
- 新的用户可见行为：更新 `README.md`（中英两段都要改）
- 凭据流程变更：同时更新 `docs/GET_CREDENTIALS.md` 与 `docs/GET_CREDENTIALS.en.md`
- 新配置项 / API 变更：更新相关文档与 README 的环境变量表

双语文档不要只改一边——中英不一致本身就是 bug。

## Questions?

有疑问随时开 issue 或在现有讨论中提问。

## License

By contributing, you agree that your contributions will be licensed under the **AGPL-3.0-only** license.

本项目由维护者个人主导：贡献欢迎，但功能取舍与项目方向由维护者最终裁定（暂不设 CLA）。

