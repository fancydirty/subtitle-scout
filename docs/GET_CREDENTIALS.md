# 获取 API 凭证指南

本指南将帮助你获取 Subtitle Scout 所需的各种 API 凭证。

---

## TMDB (The Movie Database) API Key

TMDB API 用于获取电影和电视剧的元数据信息（标题、年份、类型等），帮助准确匹配字幕。

### 获取步骤

#### Step 1: 注册 TMDB 账号

1. 访问 [https://www.themoviedb.org/](https://www.themoviedb.org/)
2. 点击右上角的 **"加入 TMDB"** (Join TMDB) 按钮

   ![TMDB 首页](./screenshots/tmdb-01-homepage.png)
   
   > 💡 **提示**: 页面会显示中文界面（如果浏览器语言设置为中文）

#### Step 2: 填写注册信息

在注册页面 (https://www.themoviedb.org/signup) 填写以下信息：

- **用户名** (Username): 选择一个唯一的用户名
- **密码** (Password): 设置一个安全的密码
- **确认密码** (Confirm Password): 再次输入密码
- **电子邮件** (Email): **填写你的真实邮箱地址**（用于接收验证邮件）

![注册表单](./screenshots/tmdb-02-signup-form.png)

注册选项说明：
- 可以选择 **"Continue with Google"** 使用 Google 账号快速注册
- 可以选择 **"Email me a sign-in link"** 通过邮件链接登录（无需密码）

勾选同意条款后，点击 **"注册"** (Sign up) 按钮。

> ⚠️ **重要**: 注册后需要到邮箱查收验证邮件并点击验证链接激活账号。

#### Step 3: 登录账号

注册并验证邮箱后：

1. 返回 TMDB 首页
2. 点击右上角 **"登录"** (Login)
3. 输入用户名/邮箱和密码登录

#### Step 4: 进入 API 设置页面

登录后，访问 API 设置页面：

**方法一：直接访问**
- 直接打开: [https://www.themoviedb.org/settings/api](https://www.themoviedb.org/settings/api)

**方法二：通过菜单导航**
1. 点击右上角的头像或用户名
2. 选择 **"设置"** (Settings)
3. 在左侧菜单中选择 **"API"**

![API 设置入口](./screenshots/tmdb-03-settings-menu.png)

#### Step 5: 申请 API Key

在 API 设置页面，你会看到两个选项：

1. **API Key (v3 auth)** - 传统的 API Key 认证方式
2. **API Read Access Token (v4 auth)** - 新的 Bearer Token 认证方式

对于 Subtitle Scout，我们需要 **API Key (v3)**。

如果是首次申请：

1. 点击 **"Request an API Key"** 或 **"申请 API 密钥"**
2. 选择 API 使用类型：
   - **Developer** (开发者) - 用于个人开发项目 ✅ **选择这个**
   - **Commercial** (商业) - 用于商业产品
3. 填写简单的申请表单：
   - **Application Name**: 填写应用名称（例如: "Subtitle Scout"）
   - **Application URL**: 可以填写 GitHub 仓库地址或留空
   - **Application Summary**: 简单描述用途（例如: "Personal subtitle downloader tool"）
4. 同意使用条款
5. 点击 **"Submit"** 提交申请

申请会立即通过，无需等待审核。

![申请 API Key](./screenshots/tmdb-04-request-api.png)

#### Step 6: 复制 API Key

申请成功后，API 设置页面会显示你的凭证信息：

```
API Key (v3 auth)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
your_api_key_here_32_characters_long

API Read Access Token (v4 auth)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJ...
```

找到 **"API Key (v3 auth)"** 部分，复制那串 32 位字符的密钥。

![API Key 展示](./screenshots/tmdb-05-api-key.png)

> ⚠️ **敏感信息**: 这是你的个人 API Key，请妥善保管，不要分享或提交到公开的代码仓库。

#### Step 7: 配置到 Subtitle Scout

将获取到的 API Key 配置到你的环境变量或配置文件中：

**环境变量方式：**
```bash
export TMDB_API_KEY="your_api_key_here"
```

**或在 `.env` 文件中：**
```
TMDB_API_KEY=your_api_key_here
```

**或在配置文件中：**
```json
{
  "tmdb": {
    "api_key": "your_api_key_here"
  }
}
```

### 验证 API Key

你可以通过以下方式验证 API Key 是否有效：

```bash
curl "https://api.themoviedb.org/3/configuration?api_key=YOUR_API_KEY"
```

如果返回 JSON 配置信息，说明 API Key 有效。

### 常见问题

**Q: API Key 有使用限制吗？**
A: 免费账号有请求速率限制（每秒约 40 次请求），对于个人使用完全足够。

**Q: API Key 会过期吗？**
A: 不会，除非你主动重新生成或删除。

**Q: 忘记 API Key 怎么办？**
A: 重新登录 TMDB，访问 API 设置页面即可查看。

**Q: 可以使用 API Read Access Token 吗？**
A: 可以，但需要修改代码以支持 Bearer Token 认证方式。推荐使用 API Key (v3) 更简单。

### 相关链接

- [TMDB API 官方文档](https://developer.themoviedb.org/docs)
- [TMDB API 认证说明](https://developer.themoviedb.org/docs/authentication-application)
- [TMDB 账号注册](https://www.themoviedb.org/signup)

---

## 2. ASSRT Token (必需)

ASSRT (assrt.net) 是国内最大的字幕分享平台，提供海量中文字幕资源。对于中文用户来说，这是**必需配置**的字幕源。

### 获取步骤

#### Step 1: 注册 ASSRT 账号

1. 访问 [https://assrt.net/](https://assrt.net/)
2. 点击页面右上角或导航栏中的 **"注册"** 按钮

   > 💡 **提示**: ASSRT 网站可能需要一定的加载时间，请耐心等待页面完全加载。

#### Step 2: 完成账号注册

在注册页面填写以下信息：

- **用户名**: 选择一个唯一的用户名（用于登录）
- **密码**: 设置一个安全的密码
- **电子邮件**: 填写你的真实邮箱地址

根据网站要求完成注册流程。

> ⚠️ **重要**: 某些情况下可能需要邮箱验证，请检查你的邮箱并点击验证链接。

#### Step 3: 登录账号

注册完成后：

1. 返回 ASSRT 首页 [https://assrt.net/](https://assrt.net/)
2. 使用注册的用户名和密码登录

#### Step 4: 进入用户面板

登录后，访问用户面板获取 API Token：

**方法一：直接访问**
- 直接打开: [https://assrt.net/usercp.php](https://assrt.net/usercp.php)

**方法二：通过导航菜单**
1. 登录后，点击页面右上角的用户名或头像
2. 在下拉菜单中选择 **"用户设置"** 或 **"个人面板"**

#### Step 5: 查看 API Token

在用户面板页面中：

1. 找到 **"API"** 或 **"API 密钥"** 或 **"Token"** 相关的设置项
2. 你会看到一个 32 位字符组成的 Token（包含数字和大小写字母）

Token 格式示例：
```
a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6
```

3. 复制这个 Token

> ⚠️ **敏感信息**: 这是你的个人 API Token，请妥善保管。不要分享给他人或提交到公开的代码仓库。

#### Step 6: 配置到 Subtitle Scout

将获取到的 Token 配置到你的环境变量或配置文件中：

**环境变量方式：**
```bash
export ASSRT_TOKEN="your_token_here"
```

**或在 `.env` 文件中：**
```
ASSRT_TOKEN=your_token_here
```

**或在配置文件中：**
```json
{
  "assrt": {
    "token": "your_token_here"
  }
}
```

### 验证 Token

你可以通过以下命令验证 Token 是否有效：

```bash
curl "https://api.assrt.net/v1/user/quota?token=YOUR_TOKEN"
```

如果返回类似以下的 JSON 响应，说明 Token 有效：

```json
{
  "status": 0,
  "user": {
    "result": "succeed",
    "action": "quota",
    "quota": 20
  }
}
```

其中 `quota` 表示你当前可用的 API 配额（每分钟剩余请求次数）。

### Token 说明

**有效期：**
- Token 永久有效，除非你主动重置

**权限：**
- 可以搜索字幕
- 可以获取字幕详情
- 可以下载字幕文件
- 受到 API 配额限制（见下文）

**重置 Token：**
- 如果 Token 泄露，可以在用户面板中找到 **"重置 Token"** 或 **"重新生成"** 按钮
- 重置后旧 Token 将立即失效

### API 配额说明

ASSRT API 默认配额为：

| 配额类型 | 限制 |
|---------|------|
| **默认配额** | 20 次/分钟 |
| **计费方式** | 按 Token 和 IP 地址共享配额 |

> 💡 **提示**: 
> - 如果同一 IP 下有多个 Token，它们共享同一个配额池
> - 如果同一 Token 从不同 IP 访问，也共享配额
> - 对于个人使用，默认配额完全足够

**申请更高配额：**

如果你的使用场景需要更高的请求速率，可以：

1. 发送邮件到 ASSRT 官方邮箱（在网站底部的"联系"链接中可以找到）
2. 说明你的应用场景和所需配额
3. 等待审核

> 📝 **注意**: ASSRT 优先为发布高质量字幕的个人用户提供更高配额。

### 常见问题

**Q: Token 会过期吗？**
A: 不会，除非你主动重置或删除账号。

**Q: 忘记 Token 怎么办？**
A: 重新登录 ASSRT，访问用户面板即可查看。

**Q: API 请求失败显示 "invalid token" 错误？**
A: 检查以下几点：
   - Token 是否完整复制（32 位字符）
   - Token 中是否有多余的空格或换行符
   - 账号是否正常（尝试重新登录网站）

**Q: 超过配额限制怎么办？**
A: 等待一分钟后配额会自动恢复。如果经常遇到限制，考虑：
   - 在代码中添加请求间隔（例如每次请求间隔 3-5 秒）
   - 实现本地缓存机制，避免重复请求
   - 申请更高配额

**Q: ASSRT 和 OpenSubtitles 有什么区别？**
A: 
   - **ASSRT**: 国内最大中文字幕站，中文资源丰富，必需配置
   - **OpenSubtitles**: 国际字幕站，英文和其他语言资源丰富，可选配置

### 相关链接

- [ASSRT API 官方文档](https://assrt.net/api/doc)
- [ASSRT 用户面板](https://assrt.net/usercp.php)
- [ASSRT 账号注册](https://assrt.net/user/register.xml)

---

## OpenSubtitles API (可选)

OpenSubtitles 是**可选的**国际字幕源，提供海量英文和其他语言字幕。如果你主要使用中文字幕，可以跳过此配置。

### 费用说明

OpenSubtitles 提供两种账号类型：

| 类型 | 费用 | API 配额 | 下载限制 |
|------|------|---------|---------|
| **Free** | 免费 | 每天 200 次请求 | 每天 20 个字幕 |
| **VIP** | $1.99/月 或 $14.99/年 | 每天 1000 次请求 | 无限制下载 |

> 💡 **建议**: 个人使用免费账号已经足够。VIP 主要适合高频使用或批量下载场景。

### 获取步骤

#### Step 1: 注册 OpenSubtitles 账号

1. 访问 [https://www.opensubtitles.com/](https://www.opensubtitles.com/)
2. 点击右上角的 **"Sign Up"** 按钮

   ![OpenSubtitles 首页](./screenshots/opensubtitles-01-homepage.png)

#### Step 2: 填写注册信息

在注册页面填写以下信息：

- **Username**: 选择一个唯一的用户名（**记住此用户名，API 需要用到**）
- **Email**: 填写你的真实邮箱地址
- **Password**: 设置一个安全的密码（**记住此密码，API 需要用到**）
- **Confirm Password**: 再次输入密码

![注册表单](./screenshots/opensubtitles-02-signup-form.png)

勾选同意条款后，点击 **"Sign Up"** 按钮。

> ⚠️ **重要**: 注册后需要到邮箱查收验证邮件并点击验证链接激活账号。

#### Step 3: 登录账号

验证邮箱后：

1. 返回 OpenSubtitles 首页
2. 点击右上角 **"Login"**
3. 输入用户名或邮箱和密码登录

#### Step 4: 申请 API Key

登录后，访问 API 管理页面：

**直接访问：**
- 打开: [https://www.opensubtitles.com/en/consumers](https://www.opensubtitles.com/en/consumers)

**或通过菜单导航：**
1. 点击右上角的用户名
2. 选择 **"Consumer"** 或 **"API"**

![API 入口](./screenshots/opensubtitles-03-api-menu.png)

#### Step 5: 创建 Consumer

在 API Consumer 页面：

1. 点击 **"Create new consumer"** 或 **"New Consumer"**
2. 填写申请表单：
   - **Application Name**: 应用名称（例如: "Subtitle Scout"）
   - **Application Type**: 选择 **"Other"** 或 **"Personal"**
   - **Description**: 简单描述（例如: "Personal subtitle downloader for movies and TV shows"）
   - **URL**: 可以填写 GitHub 仓库地址或留空

3. 点击 **"Create"** 或 **"Submit"** 提交

申请通常会立即通过。

![创建 Consumer](./screenshots/opensubtitles-04-create-consumer.png)

#### Step 6: 复制 API Key

创建成功后，页面会显示你的 API Key：

```
API Key
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AbCdEfGh1234567890XyZaBcDeFgHiJk
```

复制这个 API Key 并妥善保存。

![API Key 展示](./screenshots/opensubtitles-05-api-key.png)

> ⚠️ **敏感信息**: 这是你的个人 API Key，请妥善保管。
> 
> ⚠️ **注意**: 某些旧教程可能提到需要"申请审核"，但目前 OpenSubtitles.com 已支持即时创建 API Key。

#### Step 7: 配置到 Subtitle Scout

OpenSubtitles API 需要三个凭证：API Key、Username 和 Password。

**环境变量方式：**
```bash
export OPENSUBTITLES_API_KEY="your_api_key_here"
export OPENSUBTITLES_USERNAME="your_username"
export OPENSUBTITLES_PASSWORD="your_password"
```

**或在 `.env` 文件中：**
```
OPENSUBTITLES_API_KEY=your_api_key_here
OPENSUBTITLES_USERNAME=your_username
OPENSUBTITLES_PASSWORD=your_password
```

**或在配置文件中：**
```json
{
  "opensubtitles": {
    "api_key": "your_api_key_here",
    "username": "your_username",
    "password": "your_password"
  }
}
```

> 💡 **为什么需要 Username 和 Password？**
> 
> OpenSubtitles API 使用双重认证机制：
> - **API Key**: 标识你的应用
> - **Username + Password**: 认证你的用户账号并获取下载权限
> 
> 这样设计是为了追踪每个用户的配额使用情况。

### 验证 API 凭证

你可以通过以下方式验证凭证是否有效：

```bash
# 1. 先登录获取 token
curl -X POST "https://api.opensubtitles.com/api/v1/login" \
  -H "Content-Type: application/json" \
  -H "Api-Key: YOUR_API_KEY" \
  -d '{"username":"YOUR_USERNAME","password":"YOUR_PASSWORD"}'

# 如果返回包含 "token" 字段的 JSON，说明凭证有效
```

或者运行 Subtitle Scout 的测试命令（如果提供）。

### 常见问题

**Q: 不配置 OpenSubtitles 能用吗？**
A: 可以！Subtitle Scout 会使用其他字幕源（如中文字幕网站）。OpenSubtitles 主要用于英文和国际字幕。

**Q: 免费账号配额够用吗？**
A: 对于个人使用完全够用。每天 20 个字幕下载量可以满足日常追剧需求。

**Q: API Key 会过期吗？**
A: 不会，除非你主动删除或重新生成。

**Q: 忘记 API Key 怎么办？**
A: 重新登录 OpenSubtitles，访问 Consumer 页面即可查看。

**Q: 可以创建多个 API Key 吗？**
A: 可以，你可以为不同的应用创建多个 Consumer 和对应的 API Key。

**Q: 下载提示 "quota exceeded" 怎么办？**
A: 说明当天配额用完了。可以等到第二天（UTC 时区重置），或者升级到 VIP 账号。

**Q: OpenSubtitles.org 和 OpenSubtitles.com 有什么区别？**
A: 
- **OpenSubtitles.org**: 旧版网站（已不再维护）
- **OpenSubtitles.com**: 新版官方网站，使用新的 REST API
- Subtitle Scout 使用的是 **OpenSubtitles.com** 的 API

### 相关链接

- [OpenSubtitles.com 官网](https://www.opensubtitles.com/)
- [OpenSubtitles API 文档](https://opensubtitles.stoplight.io/docs/opensubtitles-api/)
- [API Consumer 管理](https://www.opensubtitles.com/en/consumers)
- [VIP 订阅页面](https://www.opensubtitles.com/en/subscribe)

---

## 其他字幕源配置

*(待补充)*

---

## 4. LLM API Key (可选 - 用于 AI 翻译)

LLM API 是**可选功能**，仅在需要使用 AI 翻译字幕时才需要配置。Subtitle Scout 支持多个 LLM 提供商，你可以根据需求和预算选择合适的服务。

> 💡 **提示**: 如果你不需要 AI 翻译功能，可以跳过本章节。

### 4.1 OpenAI API

OpenAI 提供的 GPT 系列模型支持高质量的多语言翻译。

#### 获取步骤

##### Step 1: 注册 OpenAI 账号

1. 访问 [https://platform.openai.com/signup](https://platform.openai.com/signup)
2. 使用邮箱或 Google/Microsoft 账号注册
3. 验证邮箱地址（如果使用邮箱注册）

> ⚠️ **注意**: OpenAI API 需要绑定信用卡才能使用，且按使用量付费。

##### Step 2: 进入 API Keys 页面

1. 登录后访问 [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. 或点击左侧菜单的 **"API keys"**

##### Step 3: 创建 API Key

1. 点击 **"Create new secret key"** 按钮
2. 给密钥命名（例如: "Subtitle Scout Translation"）
3. 设置权限（推荐选择最小权限，仅勾选 **"Model capabilities"**）
4. 点击 **"Create secret key"**

##### Step 4: 复制并保存 API Key

API Key 的格式类似：
```
sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKLMNOPQRST
```

> ⚠️ **重要**: API Key 只会显示一次，请立即复制保存到安全的地方。如果丢失，需要重新创建新的密钥。

#### 配置方式

**在配置文件中：**
```json
{
  "llm": {
    "provider": "openai",
    "api_key": "sk-proj-your_openai_api_key_here",
    "base_url": "https://api.openai.com/v1",
    "model": "gpt-4o-mini"
  }
}
```

**或环境变量方式：**
```bash
export LLM_PROVIDER="openai"
export LLM_API_KEY="sk-proj-your_openai_api_key_here"
export LLM_BASE_URL="https://api.openai.com/v1"
export LLM_MODEL="gpt-4o-mini"
```

#### 推荐模型

| 模型名称 | 适用场景 | 成本（每 1M tokens） |
|---------|---------|---------------------|
| `gpt-4o-mini` | **推荐** - 性价比最高，适合字幕翻译 | 输入: $0.15 / 输出: $0.60 |
| `gpt-4o` | 高质量翻译，处理复杂语境 | 输入: $2.50 / 输出: $10.00 |
| `gpt-4-turbo` | 平衡性能与成本 | 输入: $10.00 / 输出: $30.00 |

> 💡 **成本估算**: 翻译一部 2 小时电影的字幕（约 1500 条字幕，约 20000 tokens），使用 `gpt-4o-mini` 大约花费 $0.03-0.05。

#### 验证 API Key

```bash
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"
```

如果返回模型列表 JSON，说明 API Key 有效。

#### 相关链接

- [OpenAI API 文档](https://platform.openai.com/docs/api-reference)
- [OpenAI 定价页面](https://openai.com/pricing)
- [OpenAI 使用限制](https://platform.openai.com/docs/guides/rate-limits)

---

### 4.2 Anthropic Claude API

Anthropic 的 Claude 系列模型以高质量的文本理解和生成能力著称，同样支持多语言翻译。

#### 获取步骤

##### Step 1: 注册 Anthropic 账号

1. 访问 [https://console.anthropic.com/](https://console.anthropic.com/)
2. 点击 **"Sign Up"** 注册账号
3. 使用邮箱或 Google 账号注册
4. 验证邮箱地址

##### Step 2: 进入 API Keys 页面

1. 登录后访问 [https://console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. 或点击左侧菜单的 **"API Keys"**

##### Step 3: 创建 API Key

1. 点击 **"Create Key"** 按钮
2. 给密钥命名（例如: "Subtitle Scout"）
3. 点击 **"Create Key"**

##### Step 4: 复制并保存 API Key

API Key 的格式类似：
```
sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ
```

> ⚠️ **重要**: API Key 只会显示一次，请立即复制保存。

#### 配置方式

**在配置文件中：**
```json
{
  "llm": {
    "provider": "anthropic",
    "api_key": "sk-ant-api03-your_anthropic_api_key_here",
    "base_url": "https://api.anthropic.com",
    "model": "claude-3-5-haiku-20241022"
  }
}
```

**或环境变量方式：**
```bash
export LLM_PROVIDER="anthropic"
export LLM_API_KEY="sk-ant-api03-your_anthropic_api_key_here"
export LLM_BASE_URL="https://api.anthropic.com"
export LLM_MODEL="claude-3-5-haiku-20241022"
```

#### 推荐模型

| 模型名称 | 适用场景 | 成本（每 1M tokens） |
|---------|---------|---------------------|
| `claude-3-5-haiku-20241022` | **推荐** - 速度快，性价比高 | 输入: $0.80 / 输出: $4.00 |
| `claude-3-5-sonnet-20241022` | 高质量翻译，理解复杂语境 | 输入: $3.00 / 输出: $15.00 |
| `claude-3-opus-20240229` | 最高质量，处理专业内容 | 输入: $15.00 / 输出: $75.00 |

> 💡 **成本估算**: 翻译一部 2 小时电影的字幕，使用 `claude-3-5-haiku` 大约花费 $0.08-0.12。

#### 验证 API Key

```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: YOUR_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-3-5-haiku-20241022","max_tokens":10,"messages":[{"role":"user","content":"Hi"}]}'
```

如果返回正常响应而不是错误，说明 API Key 有效。

#### 相关链接

- [Anthropic API 文档](https://docs.anthropic.com/claude/reference/getting-started-with-the-api)
- [Anthropic 定价页面](https://www.anthropic.com/pricing)
- [Claude 模型对比](https://docs.anthropic.com/claude/docs/models-overview)

---

### 4.3 其他兼容提供商

Subtitle Scout 支持任何兼容 **OpenAI API 格式**的 LLM 服务。这包括：

#### 本地部署方案

如果你有足够的硬件资源（GPU），可以本地部署开源模型：

**vLLM + OpenAI 兼容服务器：**
```bash
# 部署示例（需要 GPU）
vllm serve Qwen/Qwen2.5-7B-Instruct --api-key your-local-key
```

配置：
```json
{
  "llm": {
    "provider": "openai",
    "api_key": "your-local-key",
    "base_url": "http://localhost:8000/v1",
    "model": "Qwen/Qwen2.5-7B-Instruct"
  }
}
```

**推荐本地模型：**
- `Qwen/Qwen2.5-7B-Instruct` - 多语言能力强
- `meta-llama/Llama-3.1-8B-Instruct` - 英文翻译质量高
- `google/gemma-2-9b-it` - 轻量高效

#### OpenRouter

[OpenRouter](https://openrouter.ai/) 是一个 LLM API 聚合服务，支持多家模型提供商。

1. 访问 [https://openrouter.ai/keys](https://openrouter.ai/keys)
2. 创建账号并生成 API Key
3. 选择你想使用的模型

配置：
```json
{
  "llm": {
    "provider": "openai",
    "api_key": "sk-or-v1-your_openrouter_key",
    "base_url": "https://openrouter.ai/api/v1",
    "model": "anthropic/claude-3.5-haiku"
  }
}
```

优点：
- 一个 API Key 访问多家模型
- 按需付费，无需多个账号
- 自动路由到可用的提供商

#### 国内反代服务

如果你在中国大陆，访问 OpenAI/Anthropic 官方 API 可能受限，可以使用反代服务：

> ⚠️ **安全警告**: 使用第三方反代服务存在数据泄露风险，请谨慎选择可信赖的服务商。

配置示例：
```json
{
  "llm": {
    "provider": "openai",
    "api_key": "your_api_key",
    "base_url": "https://your-proxy-domain.com/v1",
    "model": "gpt-4o-mini"
  }
}
```

#### Azure OpenAI

如果你有 Azure 订阅，可以使用 Azure OpenAI Service：

1. 在 Azure Portal 创建 OpenAI 资源
2. 部署模型（如 `gpt-4o-mini`）
3. 获取 Endpoint 和 API Key

配置：
```json
{
  "llm": {
    "provider": "azure",
    "api_key": "your_azure_api_key",
    "base_url": "https://your-resource.openai.azure.com",
    "model": "gpt-4o-mini",
    "api_version": "2024-02-15-preview"
  }
}
```

---

### 常见问题

**Q: 哪个 LLM 提供商最适合字幕翻译？**
A: 对于大多数用户，推荐 **OpenAI gpt-4o-mini**，性价比最高且翻译质量稳定。如果对质量要求更高，可以使用 **Claude 3.5 Haiku** 或 **GPT-4o**。

**Q: 如何降低翻译成本？**
A: 
- 使用更便宜的模型（如 `gpt-4o-mini`、`claude-3-5-haiku`）
- 只翻译部分字幕而不是全部
- 考虑本地部署开源模型（需要 GPU）

**Q: API Key 会过期吗？**
A: OpenAI 和 Anthropic 的 API Key 不会自动过期，但你可以随时在控制台中撤销和重新生成。

**Q: 如何监控 API 使用量和费用？**
A: 
- **OpenAI**: 访问 [https://platform.openai.com/usage](https://platform.openai.com/usage)
- **Anthropic**: 访问 [https://console.anthropic.com/settings/billing](https://console.anthropic.com/settings/billing)

**Q: 可以设置使用限额吗？**
A: 
- **OpenAI**: 在 [Billing settings](https://platform.openai.com/account/billing/limits) 中设置每月使用上限
- **Anthropic**: 在账号设置中配置预算警报

**Q: 翻译质量不满意怎么办？**
A: 
- 尝试更高级的模型（如 `gpt-4o`、`claude-3-5-sonnet`）
- 调整翻译 prompt（如果工具支持自定义 prompt）
- 对比不同模型的翻译结果

**Q: 本地部署需要什么硬件？**
A: 
- 最低: 16GB VRAM 的 GPU（如 RTX 4080）可运行 7B 模型
- 推荐: 24GB VRAM 以上（如 RTX 4090、A100）可运行更大模型
- CPU 运行速度极慢，不推荐

---

## 安全提醒

⚠️ **请务必注意 API 凭证的安全：**

1. **不要提交到 Git 仓库**: 将包含凭证的文件（如 `.env`）添加到 `.gitignore`
2. **不要分享给他人**: API Key 是个人账号专用的
3. **定期检查使用情况**: 在 TMDB 账号设置中可以查看 API 使用统计
4. **如有泄露及时重置**: 在 API 设置页面可以重新生成新的 API Key

