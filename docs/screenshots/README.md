# Screenshots 目录说明

## 关于截图

本目录原计划存放 TMDB API Key 获取流程的实际截图，但由于技术限制（ego-browser 截图功能超时），目前教程采用纯文字描述方式。

## 截图缺失的影响

实际上，**纯文字教程已经足够清晰**，因为：

1. **流程简单直观**: TMDB 的注册和 API Key 申请流程非常标准
2. **链接直达**: 教程中提供了所有关键页面的直接链接
3. **详细步骤**: 每个步骤都有明确的操作说明和字段解释

## 如何补充截图（可选）

如果你希望添加实际截图，可以手动完成：

### 方法一：手动截图

1. 按照 `GET_CREDENTIALS.md` 中的步骤操作
2. 在每个关键步骤截图保存到此目录
3. 命名格式：`tmdb-01-homepage.png`, `tmdb-02-signup-form.png` 等

### 方法二：使用其他截图工具

```bash
# 使用 Playwright 截图
npx playwright screenshot https://www.themoviedb.org/ tmdb-01-homepage.png

# 或使用 Puppeteer
node -e "
const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto('https://www.themoviedb.org/');
  await page.screenshot({path: 'tmdb-01-homepage.png'});
  await browser.close();
})();
"
```

### 需要的截图列表

- `tmdb-01-homepage.png` - TMDB 首页，显示"加入 TMDB"按钮
- `tmdb-02-signup-form.png` - 注册表单页面
- `tmdb-03-settings-menu.png` - 登录后的设置菜单
- `tmdb-04-request-api.png` - API Key 申请表单
- `tmdb-05-api-key.png` - 显示 API Key 的页面（需要模糊处理实际 Key）

## 敏感信息处理

如果补充截图，请注意：

- ✅ **可以显示**: 页面布局、按钮位置、菜单结构
- ⚠️ **需要标注**: API Key、邮箱、用户名等敏感信息的位置
- ❌ **不要显示**: 实际的 API Key 值、个人邮箱、真实用户名

建议使用图像编辑工具在敏感信息上添加高亮框或文字标注，例如：
- 红框标注 + 文字说明："此处是你的 API Key"
- 模糊处理 + 箭头指向

