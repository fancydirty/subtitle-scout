# zimuku 真实下载链路重写 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** 让 zimuku 的 search→detail→下载 链路匹配 2026-07-19 实地抓包的真实站点结构(此前整条链路全建在合成 fixture 上,每一层都与真站不符),使 agent 能真正从 zimuku 下到字幕文件。

**背景:** 云锁 WAF/验证码(唯一的难关)已攻克并真机验证(search 现返 HTTP 200 真内容)。剩下是纯机械的页面解析重写——但每一层都错:搜索结果 href 格式、详情页下载锚点、下载还多两跳。golden fixtures 已全部落库。

## 真实 4 跳下载链路(抓包铁证,golden fixtures 已存)

1. **search** `GET /search?q=X` → 结果页,每条候选是 `<a href="//zimuku.org/detail/<id>.html" target="_blank" title="<字幕名.srt/.ass>"><b>字幕名</b></a>`。
   - fixture: `fixtures/zimuku/live-search-pulp-20260719.html`(真实"Pulp"搜索页,9 条候选)。
   - **href 是协议相对绝对 URL `//zimuku.org/detail/<id>.html`,不是 `/detail/<id>.html`。**
2. **detail** `GET /detail/<id>.html`(直出 200,无挑战)→ 下载锚点 `<a id="down1" href="/dld/<id>.html" target="_blank" rel="nofollow">`。
   - fixture: `fixtures/zimuku/live-detail-179286-20260719.html`。
   - **id 是 `down1`(不是 `down`),href 是 `/dld/<id>.html`(不是直链 static URL)。**
3. **dld** `GET /dld/<id>.html`(直出 200,响应头 `Set-Cookie: PHPSESSID=...`)→ 页面含多个镜像下载链接 `<a href="/download/<base64token>/svr/<mirror>">`,mirror ∈ {d0,d1,l0,l1,y0,...}。
   - fixture: `fixtures/zimuku/live-dld-179286-20260719.html`。
   - **base64 token 内嵌时间戳,时限有效;下载须紧接 dld 之后。**
4. **download** `GET /download/<token>/svr/d0`(带 dld 那步的 PHPSESSID cookie)→ **301** `Location: //s.zimuku.org/download/<base64>`(base64 内嵌真实文件名 + 时间戳 token)→ 跟随重定向 → 文件字节(可能是**裸 .srt/.ass**,也可能是 .zip;实测 179286 是裸 srt,`Content-Disposition: filename="[zmk.pw]xxx.srt"`)。

**下载/安装层已就绪,不用改**:downloadDirect(src/adapters/download/direct.js)默认跟随重定向;findSubtitleWorker.tools.ts 按 contentType/内容判 zip-vs-raw(`contentType?.includes('zip') ? download.zip : download.srt`),writeSubtitle 处理压缩包与裸文件。本计划只改 provider 的 search 解析 + resolve 链路。

## 影响面

- 改:`src/adapters/providers/zimuku.ts`(parseSearchResults 正则、parseDetailPage→dld、新增 parseDldPage、新增 ZimukuClient.resolveDownload、fetchPath 透出 PHPSESSID)、`src/cli/adapters/zimukuAdapter.ts`(resolve 走新链路)。
- 测试:`src/adapters/providers/zimuku.test.ts`、`src/cli/adapters/zimukuAdapter.test.ts`、`zimukuAdapter.integration.test.ts` 改用 golden fixtures。
- **不改**:downloadDirect、writeSubtitle、findSubtitleWorker.tools.ts、yunsuoc/captcha 相关(WAF 已修好别碰)、ZimukuSessionStore、ZIMUKU_BASE。

---

### Task 1: parseSearchResults 支持协议相对 href

**File:** `src/adapters/providers/zimuku.ts` + test

- [ ] 改正则:`const detailHrefRe = /^\/detail\/(\d+)\.html$/` → `/\/detail\/(\d+)\.html$/`(去掉起始锚,允许前面有 `//zimuku.org` / `https://zimuku.org` / 纯 `/`;末尾锚 `$` 仍在,拒 `/detailed/`、拒带 query 的)。
- [ ] TDD:先加/改测试用真实 golden fixture `live-search-pulp-20260719.html`,断言 `parseSearchResults` 提取出 ≥8 条候选,首条 `{id:'179286', title:'rrh-pulp.a.film.about.life.death.supermarkets.srt'}`(title 来自 `<b>` 内文本,现有 markup-strip 已处理)。保留合成 fixture `search-spy-family.html` 的旧用例(向后兼容,那 fixture 用 `/detail/N.html` 路径式 href,新正则也匹配)。
- [ ] `npx vitest run src/adapters/providers/zimuku.test.ts; echo exit:$?` 绿。commit。

### Task 2: parseDetailPage 返回 /dld 路径 + 新增 parseDldPage

**File:** `src/adapters/providers/zimuku.ts` + test

- [ ] `parseDetailPage(html, baseUrl)` 改为定位"href 匹配 `/dld/\d+\.html` 的锚点"(别依赖 id 名——真站是 `id="down1"`,合成 fixture 是别的;按 href 形状最稳),返回 `{ dldUrl: string }`(相对 baseUrl 解析成绝对)。解析不到 → fail closed 抛错(保留现有 fail-closed 纪律)。类型 `ZimukuDetailResult` 改为 `{ dldUrl: string }`(去掉旧的 downloadUrl/filename——filename 改由下载层 Content-Disposition / 候选 title 提供)。
- [ ] 新增 `parseDldPage(html, baseUrl): { mirrorUrls: string[] }`——用 findNextTag 找所有 href 匹配 `/download/[^"]+/svr/\w+` 的锚点,相对 baseUrl 解析成绝对 URL 数组(保序)。空 → 抛错(页面结构漂移)。
- [ ] TDD:用 golden fixtures `live-detail-179286-20260719.html`(断言 dldUrl=`https://zimuku.org/dld/179286.html`)与 `live-dld-179286-20260719.html`(断言 mirrorUrls[0] 以 `https://zimuku.org/download/` 开头、含 `/svr/`,length≥3)。
- [ ] 绿。commit。

### Task 3: fetchPath 透出 PHPSESSID + ZimukuClient.resolveDownload

**File:** `src/adapters/providers/zimuku.ts` + test

- [ ] `fetchPath` 的返回对象已含 `{ html, challengeCookie }`;再加 `setCookies: string[]`(原始 getSetCookie 数组),供 dld 步提取 PHPSESSID。**别破坏现有 challengeCookie 逻辑**(requestHtml/solve 循环还用它)。
- [ ] 新增方法:
  ```ts
  /** 把候选 id 解析成"可直接下载的镜像 URL + 下载所需 cookie"。真实链路 detail→dld→镜像,
   *  dld 页下发 PHPSESSID,镜像 /download/.../svr/X 带它请求 → 301 到 s.zimuku.org CDN 取文件
   *  (downloadDirect 自动跟随重定向)。镜像 token 时限有效,故此方法紧接下载调用。 */
  async resolveDownload(id: string): Promise<{ url: string; cookie: string | null }> {
    const detailHtml = await this.requestHtml(`/detail/${id}.html`)
    const { dldUrl } = parseDetailPage(detailHtml, ZIMUKU_BASE)
    // dld 页直出(通常无挑战),但仍走 fetchPath 以复用会话 cookie + 拿 PHPSESSID
    await this.limiter.wait()
    const dldPath = dldUrl.startsWith(ZIMUKU_BASE) ? dldUrl.slice(ZIMUKU_BASE.length) : new URL(dldUrl).pathname
    const dld = await this.fetchPath(dldPath, this.opts.sessionStore.get()?.cookie)
    const phpSess = extractSetCookieValue(dld.setCookies, 'PHPSESSID') // 形如 "PHPSESSID=xxx" 或 null
    const { mirrorUrls } = parseDldPage(dld.html, ZIMUKU_BASE)
    return { url: mirrorUrls[0], cookie: phpSess }
  }
  ```
  (`extractSetCookieValue` 小工具:从 set-cookie 行数组里提出 `PHPSESSID=<val>`,无则 null。若 yunsuo.ts 的 extractCookie 可复用/导出则复用,否则本文件内写一个。)
- [ ] 注意:`detail()` 老方法(返回 parseDetailPage 结果)若无其它调用点,可删或保留;`resolveDownload` 是新的下载入口。检查 zimukuAdapter.ts 与测试对 `detail()` 的依赖,一并迁移到 `resolveDownload`。
- [ ] TDD:mock fetchImpl 串起 detail→dld→(返回 mirror url + PHPSESSID);断言 resolveDownload 返回首个镜像绝对 URL + `PHPSESSID=...`。golden fixtures 驱动。
- [ ] 绿。commit。

### Task 4: zimukuAdapter.resolve 走新链路

**File:** `src/cli/adapters/zimukuAdapter.ts` + test + integration test

- [ ] `client` 的 Pick 从 `'search' | 'detail'` 改为 `'search' | 'resolveDownload'`。
- [ ] resolve:
  ```ts
  resolve: async (ref) => {
    const { url, cookie } = await client.resolveDownload(ref.providerId)
    const headers = { ...ZIMUKU_HEADERS, ...(cookie ? { Cookie: cookie } : {}) }
    return { url, headers } // filename 省略——CandidateRef 无 videoName;下载层按 contentType 兜底
                            // (download.zip/download.srt),最终盘上文件名由 writeSubtitle 用视频名派生
  }
  ```
  (**核实**:`CandidateRef = { provider, providerId, fileIndex }` 无 videoName/filename 字段,故 resolve 不返回 filename;`FetchAdapter.resolve` 的返回类型 filename 是可选的,省略合法。downloadDirect 返回 {bytes,contentType},tools.ts `filename ?? (contentType zip? download.zip : download.srt)` 兜底,安装名走 writeSubtitle 的 videoFilename。)
- [ ] 更新 zimukuAdapter.test.ts(假 client 现出 resolveDownload)与 zimukuAdapter.integration.test.ts(端到端 offline:challenge→solve→search→detail→dld→镜像→下载→解压/裸文件→写盘;用真实 golden fixtures 串全链,mock 镜像 URL 返回一个真实小 srt 或 zip)。
- [ ] 绿。commit。

### Task 5: 全量门禁

- [ ] `npx tsc --noEmit; echo tsc:$?` → 0
- [ ] `npx vitest run; echo vitest:$?` → 全绿零 red(基线 1636 + 改动;数字以实际为准)
- [ ] 检查全仓无其它调用 `client.detail`/`parseDetailPage` 旧签名的地方漏改。

### 交付回报
每 Task commit hash(message 末尾 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`)、失败→通过测试数、tsc/vitest 最终 exit + 通过总数、改了哪些文件、偏离计划逐条。**不做生产部署**(主控真机验证)。**不碰** WAF/captcha 相关代码(yunsuo.ts、requestHtml 的挑战破解循环、fetchContentWithVerifiedCookie、CONTENT_VERIFY_ATTEMPTS——那些已修好验证过)。
