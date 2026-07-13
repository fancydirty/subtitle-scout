export interface SkillDescriptor {
  name: string
  description: string
}

export interface Skill {
  descriptor: SkillDescriptor
  content: string
}
