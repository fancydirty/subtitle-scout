export type BilingualStatus = 'pending' | 'draft' | 'ok' | 'needs_review' | 'failed'

export interface CleanCue {
  id: string
  text: string
  scene?: string
}

export interface BilingualRow {
  id: string
  src: string
  tgt: string
  status: BilingualStatus
  notes?: string
}

export interface GlossaryTerm {
  src: string
  zh: string
  note?: string
}

export interface WorkspaceMeta {
  itemId?: string
  videoPath?: string
  originLang?: string | null
  sourceRef?: string | null
  phase?: string
}

export interface WorkspacePaths {
  jobRoot: string
  canonicalDir: string
  agentViewDir: string
  contextDir: string
  glossaryDir: string
  workDir: string
  outDir: string
  metaPath: string
  sourceCleanPath: string
  bilingualPath: string
  glossaryPath: string
  glossaryFrozenPath: string
  summaryPath: string
  criticPath: string
  targetSrtPath: string
  canonicalSourcePath: string
}
