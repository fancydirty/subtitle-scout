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
