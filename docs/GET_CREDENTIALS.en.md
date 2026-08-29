# Obtaining API credentials

[中文](./GET_CREDENTIALS.md)

This guide covers **TMDB** and subtitle-provider credentials, and what each provider is for. The LLM triple (base URL, key, model) is collected in a separate wizard step and is not documented here.

Credentials go in the local dashboard (wizard or Settings on `:8099`). They do **not** go in `.env`. Values placed there have no effect.

The wizard marks ASSRT, OpenSubtitles, and Jimaku as skippable. Skippable is not the same as recommended. **Configure all three. Do not skip OpenSubtitles: it is useful for both Chinese-speaking and non-Chinese-speaking users.**

| Provider | Wizard | Role |
|----------|--------|------|
| TMDB | Required | Identifies files in the library. Scout cannot run without it. |
| ASSRT | Skippable | Professional Chinese subtitle catalog. Supplies finished Chinese sidecars. |
| OpenSubtitles | Skippable | International catalog used by **both Chinese-speaking and non-Chinese-speaking users**. Not a professional Chinese site, but broad coverage for find-subtitle and translation. |
| Jimaku | Skippable | **Not** a professional Chinese catalog. Supplies Japanese source subtitles to the translation agent (anime and similar). |

Built-in zimuku / subhd need no account and are out of scope here.

Use **Test** in the dashboard. Do not commit real secrets to git, issues, or screenshots. URLs below can be copied as a block. A login-wall screenshot means: sign in, then open the same URL. The secret string itself is never photographed.

---

## 1. TMDB API key

Without TMDB, Scout cannot identify movies or series. Either the v3 32-character key or the v4 Read Access Token works.

### URLs

```
https://www.themoviedb.org/
https://www.themoviedb.org/signup
https://www.themoviedb.org/settings/api
https://developer.themoviedb.org/docs/getting-started
```

### Register

1. Open [https://www.themoviedb.org/](https://www.themoviedb.org/). Use **Join TMDB** in the header.

   ![TMDB home](./screenshots/tmdb-01-homepage.png)

2. Sign-up: [https://www.themoviedb.org/signup](https://www.themoviedb.org/signup). Username / password / email, or Google. Confirm the email.

   ![TMDB sign-up](./screenshots/tmdb-02-signup-form.png)

### Request a key

Docs: [https://developer.themoviedb.org/docs/getting-started](https://developer.themoviedb.org/docs/getting-started) — after login, open **API** in account settings.

![TMDB Getting Started](./screenshots/tmdb-docs-getting-started.png)

Settings: [https://www.themoviedb.org/settings/api](https://www.themoviedb.org/settings/api)

Signed-out visits land on a permission page. Sign in and open the same URL again.

![Signed-out API settings](./screenshots/tmdb-03-settings-menu.png)

Choose **Developer**, name the application (for example `Subtitle Scout`), submit. Copy **API Key (v3 auth)** or the v4 Read Access Token.

### Into Scout

Wizard step **TMDB**: paste → **Test** → save. Editable later on the Settings TMDB card.

---

## 2. ASSRT token

ASSRT ([assrt.net](https://assrt.net), SHOOTER) is a professional Chinese subtitle catalog. The find-subtitle pipeline installs those Chinese files directly. The wizard allows a skip; a Chinese library should not skip it.

Observed rate limit: **5 requests per minute**. Scout spaces calls at about 15 seconds.

### URLs

```
https://assrt.net/
https://assrt.net/user/register.xml
https://assrt.net/usercp.php
https://assrt.net/api/doc
```

### Register

The homepage has no sign-up control. Open [https://assrt.net/user/register.xml](https://assrt.net/user/register.xml), or use **加入我们** on an inner page.

![ASSRT home](./screenshots/assrt-01-homepage.png)

![Signed out: 加入我们 / 登录](./screenshots/assrt-04-login-links.png)

![ASSRT registration](./screenshots/assrt-02-register.png)

The form advises against QQ mail.

### Token

After login, open **用户面板** (or the avatar):

```
https://assrt.net/usercp.php
```

The token is on that page: 32 alphanumeric characters, resettable.

![Signed in: 用户面板](./screenshots/assrt-05-usercp-nav.png)

See [https://assrt.net/api/doc](https://assrt.net/api/doc#usetoken).

![ASSRT API docs: token](./screenshots/assrt-03-api-docs.png)

### Into Scout

Wizard **subtitle sources** or the Settings ASSRT card: paste → **Test**. Only a passing test is stored.

---

## 3. OpenSubtitles API

OpenSubtitles is an international catalog useful to **Chinese-speaking and non-Chinese-speaking users**. It fills gaps the professional Chinese sites miss, and it is a primary source for everyone else. The wizard marks it skippable. **Do not skip it for that reason**—not because it is “only” a translation-agent feed. The translation agent can also use it as a foreign-language source. Creating an API key does **not** require VIP.

Use [opensubtitles.com](https://www.opensubtitles.com/), not the retired opensubtitles.org.

### URLs

```
https://www.opensubtitles.com/
https://www.opensubtitles.com/en/consumers
https://opensubtitles.stoplight.io/docs/opensubtitles-api/
```

### Register

Open [https://www.opensubtitles.com/](https://www.opensubtitles.com/). **Register** in the header.

![OpenSubtitles home](./screenshots/opensubtitles-01-homepage.png)

![Register dialog](./screenshots/opensubtitles-02-signup-form.png)

Username and password may later be stored in Scout for a higher download tier. The API key does not depend on them.

### Create a consumer

After login:

```
https://www.opensubtitles.com/en/consumers
```

Signed-out visits redirect to sign-in. Sign in and open the same URL again.

![Signed-out /en/consumers](./screenshots/opensubtitles-03-api-menu.png)

Sidebar: **API consumers**. Click **NEW CONSUMER**. The application name may contain only letters and digits (`subtitlescout`, no spaces or hyphens). The new row appears in the list; the gear control shows and copies the API key.

![API consumers: NEW CONSUMER, no VIP](./screenshots/opensubtitles-04-api-consumers.png)

### Into Scout

Settings / wizard subtitle sources · OpenSubtitles:

- **API key** — required to enable the provider
- **Username / password** — optional, logged-in download quota

Only a passing test is stored.

---

## 4. Jimaku API key

Jimaku is **not** a professional Chinese catalog. It feeds the translation agent with Japanese source subtitles. Skippable in the wizard; configure it when translating Japanese-origin titles. That is a different reason from OpenSubtitles, which is worth keeping for both Chinese-speaking and non-Chinese-speaking users.

### URLs

```
https://jimaku.cc/
https://jimaku.cc/login
https://jimaku.cc/account
https://jimaku.cc/api/docs
```

**Login** in the header. After registration, generate a key at [https://jimaku.cc/account](https://jimaku.cc/account). Docs: [https://jimaku.cc/api/docs](https://jimaku.cc/api/docs).

![Jimaku home](./screenshots/jimaku-01.png)

Store it on the wizard subtitle-sources step or the Settings Jimaku card.

---

## 5. r3sub account (email + password)

r3sub.com hosts official Traditional Chinese subtitle tracks from Taiwan releases (iTunes / Blu-ray rips). Chinese-target users only — the wizard and settings hide it for other target languages.

### URLs

```
https://r3sub.com/
https://forum.r3sub.com/entry/register
```

### Register

1. Register on the forum with your email
2. **Verify the email** — unverified accounts cannot log in
3. Come back to Scout and enter the **same email and password**

### Into Scout

Settings / wizard subtitle sources · r3sub: email + password (both required). The test button performs a real login; only a passing pair is stored.

Note: some releases there ship Blu-ray bitmap subtitles (`.sup`) only — Scout works with text subtitles and will honestly skip those.

---

## 6. SubDL API key

SubDL is the practical successor to Subscene (shut down 2024) — an international catalog, strongest in English and European languages. Useful for every target language; for Chinese it mostly serves as the translation agent's English source.

### URLs

```
https://subdl.com/
https://subdl.com/panel/api
```

### Register

1. Register a **free** account (email verification)
2. Copy the API key from the account panel ([https://subdl.com/panel/api](https://subdl.com/panel/api))

The free key is all you need: search quota 2000/day, downloads go through the anonymous pool of 300/day per IP. The paid "Pro" tier only matters for multi-IP server integrations (account-level download pool).

### Into Scout

Settings / wizard subtitle sources · SubDL: one API key field. Only a passing test is stored.

---

## Security

- Do not commit secrets to git, issues, screenshots, or chat
- `.env` is not where these keys live
- If leaked, rotate at ASSRT [usercp](https://assrt.net/usercp.php), TMDB [API](https://www.themoviedb.org/settings/api), OpenSubtitles [consumers](https://www.opensubtitles.com/en/consumers), Jimaku [account](https://jimaku.cc/account), SubDL [panel](https://subdl.com/panel/api); for r3sub change the account password on the forum
