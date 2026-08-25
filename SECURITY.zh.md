# 安全策略

[English](./SECURITY.md)

## 报告漏洞

凭据泄露、认证绕过、任意写文件、路径穿越、数据丢失类问题，不要开公开 issue。通过仓库配置的安全联系方式私信维护者，或在 GitHub 提供私密 advisory 时使用 advisory。

请包含：

- 影响简述
- 使用合成路径与合成凭据的复现步骤
- 受影响的 commit 或发行版
- 必要的配置或字幕源前提

报告中不要包含真实 API key、密码、媒体路径、私有主机名或个人数据。

## 部署

- `.env` 与全部字幕源 / TMDB / LLM 凭据不得进入 Git
- dashboard 对他人可见时，只挂载需要的媒体路径
- 首次启动后立即完成管理员向导
- 未阅读并接受相关站点条款前，保持 `ZIMUKU_ENABLED` 与 `SUBHD_ENABLED` 关闭
