export type StationId =
  | 'you'
  | 'model'
  | 'memory'
  | 'files'
  | 'shell'
  | 'web'
  | 'browser'
  | 'agents'
  | 'skills'
  | 'hooks'

export type Status = 'run' | 'ok' | 'err' | 'block'

export type DetailLevel = 'compact' | 'verbose' | 'debug'

export type EntryDebugPreview = {
  args?: string
  lineRange?: string
  error?: string
  result?: string
  thinking?: string
}

export type ModelStepTelemetry = {
  at: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  totalContextTokens: number
  cacheHitPct: number
  isCompaction?: boolean
}

export type Entry = {
  id: string
  station: StationId
  label: string
  status: Status
  startedAt: number
  endedAt?: number
  from?: 'core' | 'agents' | 'inbound'
  mark?: 'done' | 'switch'
  agentId?: string
  agentName?: string
  tokens?: number
  shared?: boolean
  stepIdx?: number
  toolName?: string
  debug?: EntryDebugPreview
}

export type SubagentInfo = {
  id: string
  label: string
  startedAt: number
  endedAt?: number
}

export type Board = {
  entries: Entry[]
  counts: Partial<Record<StationId, number>>
  faults?: Partial<Record<StationId, number>>
  spent?: Partial<Record<StationId, number>>
  pushed?: number
  context?: number
  model?: string
  switchedAt?: number
  agents?: SubagentInfo[]
  open?: string
  modelSteps?: ModelStepTelemetry[]
}

export type RawToolCall = {
  id?: string
  name?: string
  args?: Record<string, unknown>
}

export type TranscriptStep = {
  step_index?: number
  source?: string
  type?: string
  status?: string
  created_at?: string
  model?: string
  input_tokens?: number
  cache_read_tokens?: number
  output_tokens?: number
  error?: string
  content?: string
  tool_calls?: RawToolCall[] | string
  thinking?: string
}

export type SessionSummary = {
  id: string
  title: string
  transcriptPath: string
  mtimeMs: number
  sizeBytes: number
  workspaceUris: string[]
  status: string
  parentConversationId?: string
  notFullyIdle?: boolean
}

export type UserOptions = {
  language?: string
  theme?: 'auto' | 'dark' | 'light' | string
  background?: 'solid' | 'transparent' | string
  layout?: 'you-top' | 'you-bottom' | string
  motion?: 'full' | 'reduced' | string
  coreName?: string
  contextCost?: boolean
  contextWindowTokens?: number
  textSize?: 'caption' | 'footnote' | 'body' | string
  detailLevel?: DetailLevel | string
  subagentNames?: boolean
  colors?: Record<string, string> | string
  memoryPaths?: string[] | string
  memoryServers?: string[] | string
  memoryCommands?: string[] | string
  serverStations?: Record<string, string> | string
  commandStations?: Record<string, string> | string
  antigravityDataDir?: string
}
