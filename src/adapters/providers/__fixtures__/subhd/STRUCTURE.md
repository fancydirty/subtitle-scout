# subhd 真机夹具结构（解析器事实源）

> 2026-07-20 从 subhd.me 真机抓取（搜索 `The Rig`，下载样本 id `2BNs4Y` = "Surviving Earth S01E03"）。
> **Task 3/5 的解析器对着本文件记录的真实结构写，不许臆想 CSS/正则。** 抓取脚本：`scripts/capture-subhd-fixtures.ts`。

## 🔴 真实下载链路（curl 实测，比设计文档假设多一步）

设计文档以为 `GET /down/<id>` 直出字幕文件。**当前站点实际是 5 步**：

1. `GET /search/<urlencoded>` → 搜索页 HTML（每条结果一张卡片，卡片里 `/a/<base62>` 链接出现两次）
2. `POST /api/sub/prepare-download`，JSON `{"sid":"<id>"}`，头 `Referer: <base>/a/<id>` + `Origin` + `X-Requested-With: XMLHttpRequest` + `Content-Type: application/json`
   → `{"success":true,"url":"/down/<id>"}` + `Set-Cookie: tk_<id数字>_<hex>=<hex>; Max-Age=300; HttpOnly; Secure; SameSite=Lax`
3. `GET /down/<id>`，头 `Cookie: tk_…` + `Referer: <base>/a/<id>` → 下载落地页 HTML（**激活临时页**；不带 tk 或超时→"下载页面已失效"403）
4. `POST /api/sub/down`，JSON `{"sid":"<id>"}`，头 `Cookie: tk_…` + `Referer: <base>/down/<id>` + `Origin` + `X-Requested-With`
   → `{"success":true,"msg":"验证通过","pass":true,"url":"https://dlus.subhd.me/YYYY/MM/<ts>.<ext>"}`（**这一步才给真文件 url**）
   失败 → `{"success":false,"msg":"时间过长本临时页面已经失效","pass":false,"url":null}`
5. `GET <cdn url>`（credentials omit，**无需任何 cookie**）→ 真字幕文件 / 压缩包

**临时页时间窗很短**：prepare→api 之间超时就 `已失效`；resolve 里三步须紧连（无人为延迟），失败重试整个 prepare→down→api 单元。

## 🔴🔴 Node（undici fetch / node:https）跑不通第 2-4 步——必须用 curl

curl 实测铁证：**Node 的 TLS(JA3) 指纹被 Cloudflare/源站在临时页校验上拒**。
- Node（undici fetch、`allowH2`、node:https、去掉/改写 Accept-Encoding/Accept-Language/Sec-Fetch-Mode 全试过）：api/sub/down **每次** `时间过长本临时页面已经失效`。
- curl（OpenSSL 指纹）：`验证通过`，3/3 稳定。
- 交叉验证：curl-mint+undici-api 失败、undici-mint+curl-api 失败 → mint 与 api 客户端须同为 curl。
- 但 **step 1 搜索页 GET 和 step 5 CDN 下载 undici 都 OK**（CDN `dlus.subhd.me` .rar 实测 undici 200/44377B）。

结论：`SubhdClient` 的默认 `fetchImpl` 对 mint 流程 **shell 到 curl**；CDN 文件下载走既有 undici `downloadDirect`。测试注入假 fetch，不碰 curl/真网络。

## 搜索页 `search-the-rig.html`（94312 B，HTTP 200，共 20 张卡片）

每张结果卡片：
```html
<div class="bg-white shadow-sm rounded-3 mb-4">      <!-- 卡片容器 -->
  <div class="row">
    <div class="col-2 ...">
      <a href='/d/1295799'> <img ... alt="伽马射线效应 The Effect ..."> </a>   <!-- 海报=豆瓣 /d/<num>，非 /a/ -->
    </div>
    <div class="col-lg-10">
      <div class="clearfix">
        <div class="float-start f16 fw-bold">
          <a class="link-dark align-middle" href='/a/miSC8x' ...>伽马射线效应</a>   <!-- 标题链接：/a/<id>，短中文名 -->
        </div>
        <div class="view-text text-secondary">
          <a href='/a/miSC8x' class='link-dark' ...>
            伽马射线效应.The.Effect.of.Gamma.Rays.on.Man-in-the-Moon.Marigolds.1972-SONYHD   <!-- 发布名（长）：videoName 取此 -->
          </a>
        </div>
        <div class="text-truncate py-2 f11">                                     <!-- 徽章行 -->
          <span class="rounded p-1 me-1 text-white" style="background-color:...">转载精修</span>  <!-- 来源徽章(releaseSite)，可缺 -->
          <span class="p-1 fw-bold">简体</span><span class="p-1 fw-bold">繁体</span><span class="p-1 fw-bold">英语</span>  <!-- 语言徽章 -->
          <span class="p-1 text-secondary">SUP</span>                            <!-- 格式(subtype)：SUP/ASS/SRT -->
        </div>
        ... <span ...>14741k</span> ...  <!-- 文件大小、下载数等（不解析） -->
```

**关键事实：**
- `id`：href 恰为 `/a/<base62>`（无 query）。同 id 每卡出现两次（标题链接 + view-text 链接），去重。海报用 `/d/<num>`（豆瓣），不匹配。
- `videoName`：view-text 里的发布名（最长的那条 `/a/` 锚文本）。含 HTML 实体如 `I&#39;ll`（做轻量数字实体解码）。
- `language`：`<span class="p-1 fw-bold">` 全部文本（简体/繁体/繁中/双语/英语…），多语用 `/` 连接。
- `subtype`：徽章行里 `<span class="p-1 text-secondary">`（SUP/ASS/SRT）。**限定在徽章行内取**——`text-secondary` 页面别处也用（"共 200 条"、下载计数）。
- `releaseSite`：徽章行首个 `text-white` 来源徽章（转载精修/官方字幕/…），可缺 → null。
- 实测 5 条样本：`miSC8x`(简/繁/英,SUP,转载精修)、`gbRKgH`(双语/简/英,ASS,转载精修)、`AeKBjs`(繁体,SRT,官方字幕,无来源徽章)、`UKfNhL`(双语/简/英,ASS,**无来源徽章**)、`RHQBMe`(简体,ASS,转载精修)。

## `prepare-download-2BNs4Y.json` / `.headers.txt`
- body：`{"success":true,"url":"/down/2BNs4Y"}`
- headers：`set-cookie: tk_663413_519a312e0c1377d16ab1e610=<hex>; Max-Age=300; Path=/; HttpOnly; Secure; SameSite=Lax`
  （tk 名形如 `tk_<字幕数字id>_<hex>`；提取整段 `tk_…=…`（`;` 前）直接回填 `Cookie` 头。）

## `down-page-2BNs4Y.html`（18398 B）
落地页，含 `<button class="... down download-submit" sid="2BNs4Y">下载字幕文件</button>`；JS `POST /api/sub/down {sid}` 取真 url，
`downloadAs(url, filename)` 用 `fetch(url,{credentials:"omit"})` 下载（证明 CDN 无需 cookie）。**客户端不解析这页，只 GET 它激活临时页。**

## `api-sub-down-2BNs4Y.json`
`{"success":true,"msg":"验证通过","pass":true,"url":"https://dlus.subhd.me/2026/06/1782478768658.ass"}`
> 注：此成功响应为 curl 实测多次观测到的真实响应，逐字记录。抓取当时本机 IP 被 subhd 限流（curl 也短暂 `已失效`），
> 脚本重跑受阻；其余夹具均脚本/curl 落盘。live 冒烟（Task 9）会对真站重新走完整 api/sub/down。

## `down-2BNs4Y.ass`（81626 B）——下载产物形态
- **单文件 `.ass`**（真 ASS：`[Script Info]` / `[V4+ Styles]` / `Dialogue:` 中英双语），非压缩包。
- **但下载产物可为压缩包**：实测同库 `gbRKgH`→`.rar`(RAR v5)、`miSC8x`→`.7z`(15MB 7z)。CDN url 扩展名即真类型。
  → Task 8：下载层须能处理 `.ass/.srt` 直存 **与** `.rar/.7z/.zip` 解包（见 direct.ts / writeSubtitle 现状）。
