# F2 设计:jimaku.cc 日文字幕源 + 日→中直译

日期:2026-07-21 · 状态:开干 · 前置:F1 源语言外挂腿已建成

## 目的与铁原则

日漫 `origin_lang=ja` 在现有源(assrt/OS/zimuku/subhd)搜 ja=0。接入 **jimaku.cc**(日字专门站,有 API),
把 `SUPPORTED_SOURCE_LANGS` 扩到 `{en, ja}`,走 F1 已建的 fetch 腿 + E 翻译管道,**源语言→中文单跳直译,
永不英语中继**。

## 真 API 形状(2026-07-21 持 key 验证)

- Base:`https://jimaku.cc/api`
- Auth:`Authorization: <JIMAKU_API_KEY>`(裸 key,非 Bearer)
- `GET /entries/search?query=Frieren` → 200 条目数组
  `{id,name,english_name,japanese_name,anilist_id,flags{anime,movie,…}}`
- `GET /entries/search?anilist_id=154587` → 精确命中
- `GET /entries/{id}/files?episode=1` → 该集文件列表
  `{url,name,size,last_modified}`(url 是直链,下载**无需** auth,实测 200)
- 日字样本:Frieren E01 SRT 含「（ヒンメル）フリーレン。」等,可 parse

## 架构(复用 F1 双腿,零新 taskType)

```
translateItem ③ fetchSourceSub(videoPath)
  → locate: origin_lang=ja ∈ SUPPORTED_SOURCE_LANGS
  → runSearch({queries:[title], season, episode, languages:['ja']})
  → jimaku adapter 命中 → download → parse 闸 → 进 E 管道(源语言参数化 prompt)
```

### 新模块

| 文件 | 职责 |
|---|---|
| `src/adapters/providers/jimaku.ts` | HTTP client(search/files)+ zod 校验 |
| `src/cli/adapters/jimakuAdapter.ts` | FetchAdapter:enabled 仅 ja;search→候选;resolve→url |
| `src/cli/buildAdapters.ts` | `JIMAKU_API_KEY` 门控入列 |
| `src/core/schemas.ts` | PROVIDERS 加 `'jimaku'` |
| `src/v2/translateWorkerTask.ts` | `SUPPORTED_SOURCE_LANGS = ['en','ja']` |
| `src/translate/translateLm.ts` / `translateCritic.ts` | prompt "英文"→源语言名参数化 |

### jimaku adapter 契约

- **enabled**:`languages` 含 `ja`(前缀/主码),且 key 已配(buildAdapters 不入列=自然关)
- **search**:
  1. `entries/search?query=<title>`(有 anilist 时优先 `anilist_id=`,v1 先 query)
  2. 取前 N=3 条目,各拉 `files?episode=<ep>`(电影/无 ep → 不带 episode,收全量后按名过滤)
  3. 候选:`provider='jimaku'`, `providerId=String(entryId)`, `fileList=该集文件`,
     `language='ja'`, `videoName=file.name`
  4. 无 ep 匹配 → 该 entry 不贡献候选(宁空不装错集)
- **resolve**:`fileIndex` 定位 fileList 项 → 返回 `{url, filename}`;越界拒(同 assrt 宁停不猜)
- **错误**:网络/401 抛给 runSearch fail-soft;全 provider 败才抛

### prompt 源语言参数化

`makeTranslationLM` / `makeTranslationCritic` 接受 `sourceLangName?: string`(默认 `'英文'`)。
CLI/daemon 从 locate 的 origin_lang 映射:`en→英文`,`ja→日文`,未知→`源语言`。
术语表 JSON 字段名仍用 `en`/`zh`(内部 schema 稳定;prompt 文案说"源语言术语")。

## 测试(TDD)

1. jimaku client:search/files schema + 401/空集
2. adapter:enabled 门 / episode 过滤 / resolve 越界拒 / 无 ja 不入
3. SUPPORTED_SOURCE_LANGS 含 ja;listTranslateCandidates origin=ja 入候选
4. prompt 含"日文"当 sourceLangName='日文';默认仍"英文"(F1 回归)
5. 全量 ≥ 基线 + tsc 净
6. 真机:Frieren 类 ja 项(或本地造)translate-item → 源 jimaku → 中文 sidecar

## 非目标

- anilist/mal 进 provider_ids 刮削(v1 query 够用;精确 id 检索留增益)
- ASS/SSA 日字(v1 只收 parse 得过的 srt,同 F1)
- 服务器自动开 TRANSLATE_*(用户开关)
- critic reflect-refine / 标签冻结(仍留评审)
