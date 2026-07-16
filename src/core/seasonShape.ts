/** The season "shape" the v3 orchestrator's layout check (orchestratorAgent.tools.ts) reasons
 *  over: how many episodes the local mirror holds for a season vs what TMDB's season table lists.
 *  Originally extracted out of diagnoseSeason.ts (a legacy-pipeline module) so the v3 path didn't
 *  have to import from legacy — see the old-pipeline retirement scope
 *  (docs/design/2026-07-14-old-pipeline-retirement-scope.md, step 1). diagnoseSeason.ts itself has
 *  since been deleted entirely (old-pipeline retirement); orchestratorAgent.tools.ts is this
 *  module's sole consumer today. Pure, no LLM. */
export interface SeasonShape {
  seriesId: string
  season: number
  mirrorEpisodeCount: number
  tmdbEpisodeCount: number | null
}

/** 主信号（确定性）：镜像里该季集数是否超过 TMDB 该季 episode_count。tmdbEpisodeCount 未知
 *  （没查到季表）时没有确定性信号可用，一律 false，不猜。 */
export function mirrorExceedsSeasonTable(shape: SeasonShape): boolean {
  return shape.tmdbEpisodeCount != null && shape.mirrorEpisodeCount > shape.tmdbEpisodeCount
}
