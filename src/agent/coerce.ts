import { z } from 'zod'

/** Real reasoning models (proven live with mimo-v2.5 — see the v3 find-subtitle worker's live
 *  step-trace) serialize tool arguments as JSON but frequently string-encode values a typed schema
 *  expects natively: numbers arrive as `"10"`, and a field the model means as null arrives as the
 *  literal string `"None"` / `"null"` / `""` instead of JSON `null`. A strict `z.number()` /
 *  `z.enum()` rejects those, so tool-arg validation fails BEFORE the tool's execute ever runs and the
 *  live run dies on a param-flow error that the offline mocks (which feed clean typed args) never
 *  surface. These helpers make the model-facing schemas tolerant of exactly that class of encoding. */

/** Sentinels the model emits for "no value" when it should have sent JSON null. Compared
 *  case-insensitively after trimming. Deliberately narrow (only ''/'none'/'null') so a legitimate
 *  string value is never silently nulled out. */
const NULLISH_SENTINELS = new Set(['', 'none', 'null'])

function isNullishSentinel(v: unknown): boolean {
  return typeof v === 'string' && NULLISH_SENTINELS.has(v.trim().toLowerCase())
}

/** True for any of the model's "no value" encodings: the string sentinels above, OR the field
 *  being flat-out MISSING from the tool-call arguments (v === undefined). Proven live (v3 live
 *  test matrix, 2026-07-13): on a no_safe_match finalize, real mimo-v2.5 doesn't send the four
 *  installed-only fields as null or "None" — it OMITS the keys entirely, which parses as
 *  `undefined`, not a string. `.nullable()` alone rejects `undefined` (only `.nullish()` /
 *  `.optional()` do), so an omitted key failed validation before this fix. */
function isNullishOrOmitted(v: unknown): boolean {
  return v === undefined || isNullishSentinel(v)
}

/** Required integer, tolerant of string-encoded numbers (`"10"` → 10). Rejects non-numeric strings
 *  (`"abc"`) and non-integers (`"10.5"`), same as `z.number().int()` would. */
export const coercibleInt = z.coerce.number().int()

/** Integer-or-null, tolerant of string-encoded numbers, the model's string null-sentinels
 *  (`"10"` → 10; `"None"`/`"null"`/`""` → null), AND an omitted key (`undefined` → null — the
 *  real model drops a nullable field entirely rather than sending null/"None" for it; see
 *  isNullishOrOmitted). Sentinels/omission are mapped to null BEFORE z.coerce runs, so `"None"`
 *  collapses to null instead of coercing to NaN (`Number("None")`), and the parsed OUTPUT is
 *  always `null` (never `undefined`) so downstream decision objects stay uniform. */
export const coercibleNullableInt = z.preprocess(
  (v) => (isNullishOrOmitted(v) ? null : v),
  z.coerce.number().int().nullable(),
)

/** Optional integer, tolerant of string-encoded numbers AND string sentinels (`""`/`"none"`/`"null"`
 *  → undefined, i.e. "not provided"). Mapping the empty string to undefined avoids the coercion trap
 *  `Number("") === 0`, which would otherwise turn an omitted-but-blank field into a spurious 0. */
export const coercibleOptionalInt = z.preprocess(
  (v) => (isNullishSentinel(v) ? undefined : v),
  z.coerce.number().int().optional(),
)

/** Wrap a schema for a nullable field so the model's string null-sentinels (`"None"`/`"null"`/`""`)
 *  AND an omitted key (`undefined`) collapse to JSON null before the inner schema validates —
 *  needed for nullable ENUMS (e.g. an installed-language enum), where `"None"` is neither a valid
 *  member nor null and would otherwise hard-fail validation. The omitted-key case is the real one:
 *  proven live (v3 live test matrix, 2026-07-13), on a no_safe_match finalize mimo-v2.5 doesn't
 *  send these installed-only fields as null/"None" at all — it omits the keys, which parses as
 *  `undefined` and would otherwise fail `.nullable()` (only `.nullish()`/`.optional()` accept
 *  undefined). The parsed OUTPUT is always `null` here too (never `undefined`), so the finalize
 *  tool never has to distinguish "sent null" from "omitted" downstream. */
export function nullableTolerant<T extends z.ZodTypeAny>(inner: T): z.ZodType<z.output<T> | null> {
  return z.preprocess((v) => (isNullishOrOmitted(v) ? null : v), inner.nullable()) as unknown as z.ZodType<
    z.output<T> | null
  >
}

/** 批量 finalize 的桶容错（同 nullableTolerant 的动机）：真模型对空桶会省略键或串编码
 *  "None"/"null"/""——一律折叠为 []，绝不让空桶哨兵炸掉整份报告的入账。 */
export const tolerantArray = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess(
    (v) => (v === undefined || v === null || v === 'None' || v === 'null' || v === '' ? [] : v),
    z.array(item),
  )

/** nullableTolerant 的布尔版：真模型对 boolean 字段常发字符串——"True"/"true"/"False"/
 *  "false"（Python 风格首字母大写是 mimo-v2.5 的实测形态，2026-07-26 identityEval 第七轮），
 *  偶尔也发 "1"/"0"。z.boolean() 一律拒收，一个字段的编码差异就能炸掉整份 finalize 报告
 *  （readFinalized 抛错 → 整个 run 白跑）。与 coercibleInt 容错 "10"→10 同一类问题、同一个
 *  解法：在 preprocess 里把这些编码折叠成真布尔，认不出的原样交给 inner 拒绝（不吞错）。 */
export function nullableBooleanTolerant(): z.ZodType<boolean | null> {
  return z.preprocess((v) => {
    if (isNullishOrOmitted(v)) return null
    if (typeof v === 'string') {
      const t = v.trim().toLowerCase()
      if (t === 'true' || t === '1' || t === 'yes') return true
      if (t === 'false' || t === '0' || t === 'no') return false
    }
    return v
  }, z.boolean().nullable()) as unknown as z.ZodType<boolean | null>
}

/** nullableTolerant 的嵌套对象版：真模型对 object 字段还有另一类编码——把整个对象序列化成
 *  JSON 字符串发上来（identity_correction:"{\"tmdbId\":\"276161\",...}"——2026-07-26
 *  identityEval 实测，mimo-v2.5 在四个 case 里全部这么发）。preprocess 先把 JSON 字符串
 *  parse 回对象，再走哨兵/缺席折叠；parse 失败的字符串原样留给 inner 拒绝（不吞错——
 *  非法形状该炸还得炸，容错只针对"编码层"问题，不针对"内容层"问题）。 */
export function nullableJsonTolerant<T extends z.ZodTypeAny>(inner: T): z.ZodType<z.output<T> | null> {
  return z.preprocess(
    (v) => {
      if (isNullishOrOmitted(v)) return null
      if (typeof v === 'string') {
        const trimmed = v.trim()
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            return JSON.parse(trimmed)
          } catch {
            return v
          }
        }
      }
      return v
    },
    inner.nullable(),
  ) as unknown as z.ZodType<z.output<T> | null>
}

/** nullableJsonTolerant 的"内层失败折叠 null"版——advisory 字段专用（2026-07-28，job 34
 *  第二次实测失败）。
 *
 *  事故链：混合批（12 个不同作品）里 agent 43 次 write_identified_media 全对、字幕照装，
 *  finalize 却整份报告校验失败，20+ 分钟收割成果无账可入，job 落 failed——第一次是
 *  itemId:null（03a6372 已修），这次结构排除法定位到 identity：四个桶全是 tolerantArray
 *  （垃圾项被丢弃、绝不炸整体），itemId/installedLanguage 等全 nullable-tolerant，唯一还能
 *  硬炸整份报告的面就是 identity 的内层 discriminatedUnion——nullableJsonTolerant 只折叠
 *  编码层问题（JSON 字符串/哨兵），内层校验失败（如 identified+isTv:true+season:null 撞上
 *  'TV identification requires season and episode' 的 refine，或未知 outcome 字面量）照样
 *  向上传播，一个 advisory 字段杀掉全部收割账目。
 *
 *  设计错配是它必然发生的原因：identity 建模"一个 task 一个身份"，而混合未识别批合法地
 *  横跨多个作品（本次 12 个）——模型对 12 作品批报出的任何单一 identity 语义上都是胡话
 *  （比如报成一部 TV 但 season:null，因为集数横跨多部剧 → refine 全灭）。
 *
 *  关键架构事实：finalize 时真正的工作已经落库——write_identified_media 逐文件事务执行
 *  （行已建、parked 已清）。identity 只剩 advisory 元数据，仅有的消费方
 *  （cli/unidentifiedFindSubtitle.ts、v2/findSubtitleWorkerTask.ts）都把 identity:null 当
 *  合法状态（"本 run 未做识别"）处理。advisory 元数据的丢失绝不许摧毁收割入账——内层校验
 *  失败折叠为 null，报告存活。折叠是无声的，所以 runner 层在 identity 为 null 且明显做过
 *  识别时要大声告警（见 cli/unidentifiedFindSubtitle.ts）。
 *
 *  组合顺序（与 nullableJsonTolerant 完全一致，只多最后一步）：JSON 字符串折叠 → 哨兵/缺席
 *  折叠 → 内层校验 → 校验失败 catch 到 null。故意开新 helper 而非给 nullableJsonTolerant
 *  加参数：吞错误对"必须炸"的字段是灾难，这个行为必须在调用点显式选择，绝不默认。 */
export function nullableJsonTolerantCaught<T extends z.ZodTypeAny>(inner: T): z.ZodType<z.output<T> | null> {
  return z.preprocess(
    (v) => {
      if (isNullishOrOmitted(v)) return null
      if (typeof v === 'string') {
        const trimmed = v.trim()
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            return JSON.parse(trimmed)
          } catch {
            return v
          }
        }
      }
      return v
    },
    inner.nullable().catch(null),
  ) as unknown as z.ZodType<z.output<T> | null>
}
