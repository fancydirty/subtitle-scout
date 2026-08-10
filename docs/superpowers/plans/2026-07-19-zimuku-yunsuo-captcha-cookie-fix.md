# zimuku 云锁验证码 cookie 协议修复 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** 让 zimuku 云锁(Yunsuo)验证码破解真正跑通——按 2026-07-19 实地抓包证实的真实协议纠正 cookie 处理,使验证成功后能拿到有效会话拉取真实内容(此前从未在生产成功过一次)。

**Architecture:** 挑战页下发 pending 会话 cookie `security_session_verify`;提交验证码时必须回带它 + `srcurl`(=hex(被挑战的完整 URL));答对后服务器返回 923B 中间页并下发 **`security_session_high_verify`**(这才是"已验证"令牌);后续请求需同时带 `security_session_verify` + `security_session_high_verify` 这一对。

**Tech Stack:** TypeScript ESM, vitest, undici fetch。

## 实证协议(golden 铁证:captcha5=88640 一次成功;fixtures 已落库)

真实抓包三步(软路由直连 zimuku.org apex,2026-07-19 03:1x):
1. `GET https://zimuku.org/search?q=Pulp`(无 cookie)→ HTTP 404 挑战页(`YunsuoAutoJump` + `id="intext"` + `class="verifyimg"` data:image/bmp base64 内嵌图 + `self.location = "/search?q=Pulp&security_verify_img=" + stringToHex(text)`),响应头 `Set-Cookie: security_session_verify=<PENDING>`。
2. `GET https://zimuku.org/search?q=Pulp&security_verify_img=<hex(digits)>`,请求头 `Cookie: security_session_verify=<PENDING>; srcurl=<hex("https://zimuku.org/search?q=Pulp")>`:
   - **答对** → HTTP 404 + 923B 中间页(内容:`cookie_custom.removeItem('srcurl'); function YunSuoAutoJump(){ self.location = "https://zimuku.org/search?q=Pulp"; }` + setTimeout 跳转),响应头 `Set-Cookie: security_session_high_verify=<HIGH>`。**注意中间页里是 `YunSuoAutoJump`(大写 S),detectChallenge 的正则 `/YunsuoAutoJump|security_verify_img/` 大小写敏感,故中间页不被判为挑战——这是对的。**
   - **答错** → 重新挑战(响应头再下发一个 `security_session_verify=<新PENDING>`,body 仍是挑战页)。
3. `GET https://zimuku.org/search?q=Pulp`,`Cookie: security_session_verify=<PENDING>; security_session_high_verify=<HIGH>` → HTTP 200 真实搜索结果(含 `/detail/N.html` 链接)。

已落库 fixtures:
- `fixtures/zimuku/live-redirect-challenge-20260719.html`(真实挑战页,14202B)
- `fixtures/zimuku/verify-success-interstitial-20260719.html`(真实成功中间页,923B)

## 六个 bug(bug1 已单独修复,本计划修 2-6)

1. ✅ 传输层 base URL www→apex(commit f37d08b,已上生产)。
2. `fetchPath` 丢弃响应 cookie → 挑战页的 pending `security_session_verify` 拿不到。
3. `submitChallenge`(redirect 分支)只带 `srcurl`、不带 pending cookie → WAF 无法把答案绑到会话。
4. redirect 的 `srcurlCookieValue = stringToHex(baseUrl)` → 应为 `stringToHex(href)`(href=被挑战的完整 URL);golden 成功用的是 href。
5. 成功判定 `extractCookie(res,'security_session_verify')` **错**——真实成功令牌是 `security_session_high_verify`;答错时响应恰好又下发 `security_session_verify`,旧代码把答错误判为成功、缓存了无效 cookie → 下一跳仍被挑战("cookie rejected immediately")。
6. 会话缓存只存单个 cookie 字符串 → 须存**对**(`security_session_verify=X; security_session_high_verify=Y`),后续请求整串带上。
7. redirect 形状的验证码是内嵌 data:URI,`solveYunsuoChallenge` 循环内重复解码**同一张图** → 重试无意义(且答错后 pending 已轮换)。修:每次尝试**重新抓取挑战页**(拿新图 + 新 pending)。

## 设计原则

- `ZimukuSession.cookie` 字段沿用(单字符串);验证成功后存组合串 `security_session_verify=X; security_session_high_verify=Y`,`fetchPath` 原样作 Cookie 头发出(已支持)。**不改 zimukuSession.ts。**
- form 形状(合成 fixture,向后兼容)保持既有成功语义(`security_session_verify`);redirect 形状(真实)用新语义(`security_session_high_verify` + 组合串)。两形状语义差异集中在 `submitChallenge` 返回值里,循环层不感知。
- 重试改为每次尝试重新抓挑战页——通过给 `solveYunsuoChallenge` 注入 `fetchChallenge` 闭包实现。

---

### Task 1: yunsuo.ts — 提交带 pending cookie + srcurl=hex(href),成功判定改 high_verify

**Files:** Modify `src/adapters/providers/yunsuo.ts`; Modify `src/adapters/providers/yunsuo.test.ts`

新契约:

```ts
export interface SolveYunsuoChallengeDeps {
  fetchImpl: typeof fetch
  solve: (imageBytes: Buffer) => Promise<{ digits: string }>
  /** 每次尝试重新抓一张新鲜挑战页 + 它下发的 pending security_session_verify cookie 值
   *  (仅值,不含 "security_session_verify=" 前缀;无则 null)。redirect 形状的验证码内嵌在
   *  挑战页里,答错后服务端会轮换 pending 会话,故重试必须重抓、不能复用同一张图。 */
  fetchChallenge: () => Promise<{ html: string; pendingCookie: string | null }>
}

export async function solveYunsuoChallenge(
  deps: SolveYunsuoChallengeDeps, baseUrl: string, requestHref: string,
  maxAttempts = 5, retryDelayMs = 2000, retryJitterRangeMs = 0, rng: RandomFn = Math.random,
): Promise<{ cookie: string }>
```

循环(每次尝试):
1. `const { html, pendingCookie } = await deps.fetchChallenge()`
2. `const challenge = parseChallenge(html, baseUrl, requestHref)` — redirect 的 srcurl 改用 requestHref(见 Task 2)。
3. `const imgBytes = await fetchCaptchaImage(deps.fetchImpl, challenge.imageUrl)`
4. `solve()` — 抛错则计为本次失败、jitter 延迟后 continue(保留既有语义)。
5. `const verified = await submitChallenge(deps.fetchImpl, challenge, digits, pendingCookie)` — 见新 submitChallenge。
6. `if (verified) return { cookie: verified }` else 记录 lastError、jitter 延迟、continue。
7. 耗尽 → `throw new ZimukuChallengeError(...)`。

新 `submitChallenge` 返回**已验证 cookie 串或 null**(把成功判定内聚到形状分派处):

```ts
/** 提交验证码,返回"已验证会话 cookie 串"(成功)或 null(答错/被拒)。
 *  - redirect(真实):GET submitUrlPrefix+hex(digits),带 Cookie
 *    `security_session_verify=<pending>; srcurl=<challenge.srcurlCookieValue>`;成功=响应下发
 *    security_session_high_verify → 返回组合串 `security_session_verify=<pending>;
 *    security_session_high_verify=<high>`(后续请求两者都要带)。
 *  - form(合成,向后兼容):POST 表单,成功=响应下发 security_session_verify → 返回它。 */
async function submitChallenge(
  fetchImpl: typeof fetch, challenge: YunsuoChallenge, digits: string, pendingCookie: string | null,
): Promise<string | null> {
  if (challenge.kind === 'form') {
    const body = new URLSearchParams({ ...challenge.fields, [challenge.captchaFieldName]: digits })
    const res = await fetchImpl(challenge.action, { method: 'POST', body })
    return extractCookie(res, 'security_session_verify')
  }
  const submitUrl = challenge.submitUrlPrefix + stringToHex(digits)
  const cookieParts = [
    ...(pendingCookie ? [`security_session_verify=${pendingCookie}`] : []),
    `srcurl=${challenge.srcurlCookieValue}`,
  ]
  const res = await fetchImpl(submitUrl, { headers: { Cookie: cookieParts.join('; ') } })
  const high = extractCookie(res, 'security_session_high_verify')
  if (!high) return null
  const verify = pendingCookie ? `security_session_verify=${pendingCookie}; ` : ''
  return `${verify}${high}`
}
```

(`extractCookie` 已返回 `name=value` 串;上面 `high` 已是 `security_session_high_verify=<HIGH>`。)

**测试改写(yunsuo.test.ts):** 现有 redirect describe(~272-322)断言旧行为,须重写为真实协议——
- 用 `fetchChallenge` 闭包返回真实 fixture `live-redirect-challenge-20260719.html` + pendingCookie（如 `'PENDINGVAL'`）。
- 断言提交 GET 的 Cookie 头 = `security_session_verify=PENDINGVAL; srcurl=<hex(requestHref)>`。
- mock 提交响应下发 `security_session_high_verify=HIGHVAL` → 断言返回 `{ cookie: 'security_session_verify=PENDINGVAL; security_session_high_verify=HIGHVAL' }`。
- 答错(响应无 high_verify)→ 重试,断言 `fetchChallenge` 被多次调用(每次重抓新图);耗尽抛 ZimukuChallengeError。
- form describe(~136-270)：submitChallenge 签名多了 pendingCookie 参数,但 form 成功语义不变(security_session_verify);调用处传 pendingCookie（form fixture 无 pending 时传 null）。form 测试的 `solveYunsuoChallenge` 调用需适配新签名(加 fetchChallenge 闭包返回 form fixture + null pending、加 requestHref 参数)。逐个改到绿,**不许删测试点、不许改断言去掉真实协议校验**。
- parseChallenge 签名加第三参 requestHref(见 Task 2),form 相关 parseChallenge 调用传 baseUrl 即可(redirect 才用 href)。

每步 `npx vitest run src/adapters/providers/yunsuo.test.ts; echo "exit: $?"` 直读 exit code。

---

### Task 2: yunsuo.ts — redirect 的 srcurl 用 href

**Files:** `src/adapters/providers/yunsuo.ts`(parseChallenge / parseRedirectChallenge)

`parseChallenge(html, baseUrl, requestHref?)`;`parseRedirectChallenge(html, baseUrl, requestHref)`:
`srcurlCookieValue = stringToHex(requestHref ?? baseUrl)`(requestHref 缺省回退 baseUrl,兼容只传两参的老测试)。
form 分支不受影响。更新 parseChallenge (redirect) 相关断言:srcurl 现按传入 href 计算。

---

### Task 3: zimuku.ts — fetchPath 透出 pending cookie,requestHtml 编排重抓循环

**Files:** `src/adapters/providers/zimuku.ts`; `src/adapters/providers/zimuku.test.ts`

`fetchPath` 返回 `{ html, challengeCookie }`(challengeCookie = 从响应提取的 `security_session_verify` **值**,无则 null):

```ts
private async fetchPath(path: string, cookie?: string): Promise<{ html: string; challengeCookie: string | null }> {
  const t0 = Date.now()
  const headers: Record<string, string> = { ...ZIMUKU_HEADERS, ...(cookie ? { Cookie: cookie } : {}) }
  try {
    const res = await this.fetchImpl(`${ZIMUKU_BASE}${path}`, { headers, signal: AbortSignal.timeout(ZIMUKU_TIMEOUT_MS) })
    const html = await res.text()
    this.opts.onApiCall?.({ endpoint: path, status: res.status, durationMs: Date.now() - t0 })
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? '']
    let challengeCookie: string | null = null
    for (const line of raw) { const m = line.match(/security_session_verify=([^;]+)/); if (m) { challengeCookie = m[1]; break } }
    return { html, challengeCookie }
  } catch (e) {
    this.opts.onApiCall?.({ endpoint: path, status: null, durationMs: Date.now() - t0, error: String(e) })
    throw e
  }
}
```

`requestHtml` 重写:

```ts
private async requestHtml(path: string): Promise<string> {
  await this.limiter.wait()
  const cached = this.opts.sessionStore.get()
  const first = await this.fetchPath(path, cached?.cookie)
  if (!detectChallenge(first.html)) return first.html

  // 命中挑战:缓存 cookie(若有)已失效
  this.opts.sessionStore.invalidate()
  const href = `${ZIMUKU_BASE}${path}`
  const { cookie } = await solveYunsuoChallenge(
    {
      fetchImpl: this.fetchImpl,
      solve: this.opts.solve,
      fetchChallenge: async () => {
        await this.limiter.wait()
        const c = await this.fetchPath(path)          // 无 cookie 抓新鲜挑战
        return { html: c.html, pendingCookie: c.challengeCookie }
      },
    },
    ZIMUKU_BASE, href, this.opts.maxCaptchaAttempts ?? 5,
    DEFAULT_MIN_INTERVAL_MS, DEFAULT_JITTER_RANGE_MS, this.opts.rng,
  )
  this.opts.sessionStore.put({ cookie, capturedAt: Date.now() })

  await this.limiter.wait()
  const retry = await this.fetchPath(path, cookie)
  if (detectChallenge(retry.html)) {
    this.opts.sessionStore.invalidate()
    throw new ZimukuChallengeError(`still challenged after solving captcha for ${path} — verified cookie rejected`)
  }
  return retry.html
}
```

删除旧 `solveAndRetry`(逻辑并入上面 + yunsuo 循环)。`import { ZimukuChallengeError } from './yunsuo.js'` 若未导入需补;`fetchPath` 的两个既有调用点(requestHtml 里)已改为解构 `.html`。**注意:第一次 fetchChallenge 会再打一次挑战页(第一发已消耗一次),这是可接受的——保证每次尝试都有配套的新鲜 pending cookie;礼貌限速 limiter.wait() 已在每次抓取前。**

**zimuku.test.ts 适配:** 现有 `search: fetches /search?q=...`(~98-135 区)mock fetchImpl 若返回非挑战页,`requestHtml` 首发即返回,不受影响(fetchPath 返回对象,解构 .html)——但断言可能读 fetchImpl 调用/返回结构,逐个改到绿。命中挑战的集成测试(若有)按新协议:首发挑战→fetchChallenge 重抓→submit high_verify→retry 返回内容。用真实 golden fixtures。

---

### Task 4: 全量门禁 + 影响面

- [ ] `npx tsc --noEmit; echo "tsc: $?"` → 0
- [ ] `npx vitest run; echo "vitest: $?"` → 全绿(基线 1634 + 本次改动;数字以实际为准,不得有 red)
- [ ] 检查 `src/cli/adapters/zimukuAdapter.ts` / `.test.ts` / `.integration.test.ts` 是否依赖旧 solveYunsuoChallenge 签名或 fetchPath 返回类型——如受影响一并适配到绿。
- [ ] 若 form-shape 语义或 zimukuAdapter 有任何行为疑点,停下如实报告,不臆改。

### 交付回报
每 Task commit hash(commit message 含 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`)、失败→通过测试数、tsc/vitest 最终 exit + 通过总数;任何偏离计划逐条说明。**不做生产部署(留主控做真机验证)。**
