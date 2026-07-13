import { tool } from 'ai'
import { z } from 'zod'
import type { Skill } from './types.js'

/** Compact "name: description" list — this is ALL that goes in a subagent's system prompt
 *  for progressive disclosure. Full skill text is only loaded on demand via read_doc. */
export function systemPromptSkillIndex(skills: Skill[]): string {
  return skills.map(s => `- ${s.descriptor.name}: ${s.descriptor.description}`).join('\n')
}

/** read_doc(name) tool: the hand-written progressive-disclosure loader called for in the
 *  design (NOT ai@7's uploadSkill/skills API — that is for provider-hosted sandboxes; this
 *  repo runs its own local tool loop). Unknown name is fail-soft (returns an {error} object
 *  the model can read and retry from), not a thrown exception — a thrown error inside a tool
 *  execute becomes a tool-result error the model sees anyway, but returning a structured
 *  {error} keeps the available-names list visible to the model without relying on how the
 *  SDK serializes thrown errors into tool results. */
export function makeReadDocTool(skills: Skill[]) {
  const byName = new Map(skills.map(s => [s.descriptor.name, s]))
  return tool({
    description:
      'Load the full text of a named skill document. Your system prompt only lists skill ' +
      'names and one-line descriptions — call this before you need the full instructions.',
    inputSchema: z.object({ name: z.string() }),
    execute: async ({ name }) => {
      const skill = byName.get(name)
      if (!skill) {
        return { error: `unknown skill: ${name}. Available: ${[...byName.keys()].join(', ')}` }
      }
      return { name: skill.descriptor.name, content: skill.content }
    },
  })
}
