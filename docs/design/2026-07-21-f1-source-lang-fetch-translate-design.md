# F1 设计:源语言外挂字幕 → 直译中文(兜底链最后一环)

日期:2026-07-21 · 状态:用户已批方案 A("行,走a,开干") · 前置:E 已建成(2026-07-21-e-implementation-and-findings.md)

## 目的与铁原则

源文件**零字幕数据**(无中文外挂、无可用内嵌轨)时仍产出中文字幕:按**源语言**搜外挂字幕(英剧搜英字),下载后走 E 的翻译管道直译中文。

**铁原则:只做"源语言→中文"单跳直译,永不中继。** 用户拍板依据:JP→EN→CN 的多跳翻译丢义严重("奇葩的要死")。日漫在 F2(jimaku 日文源)落地前宁可保持 unavailable,不喂英语中继。

- **F1 支持源语言集 = `{en}`**(常量 `SUPPORTED_SOURCE_LANGS`)。
- **F2(下一战役)**:jimaku.cc 日文 adapter → 集合加 `ja`,同时把 translate prompt 的"英文"字样参数化为源语言名。F1 不做(YAGNI:F1 只有 en,现 prompt 就是英译中)。

## 可行性(2026-07-21 真 API 验证,免配额)

- The Rig S2E06 搜 en:**OS 2 条命中** ✅(零内嵌场景有救)
- 库内冷门动漫 Adam's Sweet Agony 搜 en:1 条 ✅;搜 ja:0 ❌
- 顶流动漫 Frieren 搜 ja:0 ❌ —— 现有源无日文字幕生态,证实 F2 需专门源(jimaku)
- 文本 query 有假阴性(Frieren en 搜 0)→ **兜底搜索必须带 imdb id**(库里 provider_ids 现成)

## 架构(方案 A:translateItem 获取多态)

获取源文本从单腿变双腿,其余管道(质量闸/术语表/分批翻译/critic/写盘)零改动:

```
translateItem(videoPath):
  ① readExistingChineseSidecar → 有 → already-covered(不变)
  ② probe 内嵌轨 → 有合格非中文文本轨 → extract(今天的 E,不变)
  ③ [F1 新] 无合格轨 且 deps.fetchSourceSub 已接线 → fetchSourceSub(videoPath)
        → 拿到 SRT 文本 → 进同一管道(parse 闸起即 fail-closed,坏文件被拦)
        → null(搜不到/都解不出) → status 'no-source'
  ④ 两腿都空 → 'no-embedded'(无 fetchSourceSub 时语义不变)
```

### 新依赖契约(translateItem deps,可选=向后兼容)

```ts
fetchSourceSub?: (videoPath: string) => Promise<{ srtText: string; sourceRef: string } | null>
```

`sourceRef` 形如 `opensubtitles:12345`,进 runs 记录供追溯。返回 null=诚实失败,不抛错。

### makeFetchSourceSub(CLI 接线层,新文件 src/cli/fetchSourceSub.ts)

`{ lib, adapters }` → 闭包:
1. videoPath → 库定位(episodes.path/movies.path 精确匹配;episodes JOIN series 取 origin_lang/provider_ids,movies 直取)。定位失败 → null。
2. `origin_lang ∉ SUPPORTED_SOURCE_LANGS` → null(**中继防线在此**:日漫 origin ja 不在集合,绝不会搜到英字拿去译)。
3. runSearch({ imdb, queries:[名], season, episode, languages:[origin_lang] })(复用 fetchLib)。
4. 按序试最多 **3 个**候选(OS 下载配额有限):runResolve → downloadDirect → 解出字幕文本 → 能 parse(srt 闸)→ 返回;失败试下一个。
5. 全失败 → null。

### 候选判定扩展(translateWorkerTask.listTranslateCandidates)

```
unavailable + (内嵌非中文文本轨 OR origin_lang ∈ SUPPORTED_SOURCE_LANGS)
```

episodes 需 JOIN series 拿 origin_lang(episodes 表无此列;series/movies 有)。派活/env 门控/worker 管线沿用今天 E 的(TRANSLATE_* 显式三件套,休眠零成本)。

### Worker 结局映射增补(runTranslateWorkerTask)

`'no-source'` → completeDone + runs 记录(同 no-embedded:无事可做非错误;unavailable 的衰减复查会周期性再给机会)。

## 错误处理

- fetchSourceSub 内任何网络/解包错 → 吞成"试下一候选",全败 null,**不抛**(抛错留给真正的意外,走 completeError 退避)。
- 下载物走既有 parse/结构闸,translate 闸 fail-closed 不变:垃圾字幕(广告轰炸/错轴)最坏被 held,绝不脏库。
- OS 每日下载配额撞顶 → resolve/download 抛错 → 候选循环耗尽 → null → no-source,明天复查自然重试。

## 测试(全 TDD)

1. `translateItem` 编排:mock fetchSourceSub——无轨+fetch 命中→installed 走完管道;无轨+fetch null→no-source;无轨+未接线→no-embedded(回归);有轨时**不**调 fetchSourceSub(省配额)。
2. `listTranslateCandidates`:unavailable+零内嵌+series.origin_lang='en' → 候选;origin ja → 非候选(F1);movies 同构;既有 embedded 用例回归。
3. `makeFetchSourceSub`:mock adapters——定位/语言门/3 候选截断/坏包跳过/全败 null。
4. 全量绿(1817+)+ tsc 净;真机验收:软路由挑一个零内嵌 unavailable 英语项跑通(或 The Rig S2E06 临时忽略其内嵌轨手动验 fetch 腿)。

## 非目标(YAGNI)

日文源(F2)/prompt 源语言参数化(F2)/新 taskType(方案 B 已否)/字幕候选 LLM 甄选(机械按序试;质量闸兜底)/ass→srt 转换(v1 只收 parse 得过的)。
