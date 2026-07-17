import { z } from 'zod'

/** finalize 的入参 schema——形状与 v2/rescueWorkerTask.ts 的 RescueReport 完全同构
 *  （runner 收割的就是它，两边漂移=收割静默丢弃，用测试锁住）。 */
export const RescueOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({
    dir: z.string(),
    outcome: z.literal('claimed'),
    tmdbId: z.string().regex(/^\d+$/),
    isTv: z.boolean(),
    season: z.number().int().positive().nullable().optional(),
  }),
  z.object({
    dir: z.string(),
    outcome: z.literal('parked'),
    reason: z.string().min(1),
  }),
  z.object({
    dir: z.string(),
    outcome: z.literal('excluded'),
  }),
])

export const RescueReportSchema = z.object({
  outcomes: z.array(RescueOutcomeSchema),
})

export type RescueReportParsed = z.infer<typeof RescueReportSchema>
