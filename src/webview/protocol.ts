import type { SessionBreakdown } from '../core/breakdown'
import type { StationInspection } from '../core/inspector'
import type { Palette } from '../core/palette'
import type { TokenStats, TurnSummary } from '../core/telemetry'
import type {
  ContextBudget,
  DetailLevel,
  EntryDebugPreview,
  IdeUsageSummary,
  QuotaSnapshot,
  StationId,
  Status,
} from '../core/types'

export type FeedRowPayload = {
  id: string
  station: StationId
  stationName: string
  label: string
  status: Status
  startedAt: number
  endedAt?: number
  mark?: 'done' | 'switch'
  times: number
  tookMs: number
  turnMs?: number
  tokens?: number
  isShared?: boolean
  isHeld?: boolean
  formattedTime: string
  formattedCost: string
  isLong: boolean
  isRunning: boolean
  stepIdx?: number
  toolName?: string
  from?: 'core' | 'agents' | 'inbound'
  agentName?: string
  debug?: EntryDebugPreview
}

export type SessionOption = {
  id: string
  title: string
  running: boolean
  mtimeMs: number
}

export type ReplayStatePayload = {
  index: number
  total: number
  isLive: boolean
  turnIndices: number[]
  turnNumber: number
  totalTurns: number
}

export type WebviewStateMessage = {
  type: 'state'
  svg: string
  brailleMap: string
  markdownReport: string
  viewMode: 'svg' | 'braille'
  nowWhat: string
  nowMeter: string
  mode: 'auto' | 'pinned' | 'demo'
  activeSessionId?: string
  sessions: SessionOption[]
  rows: FeedRowPayload[]
  breakdown: SessionBreakdown
  selectedStation?: StationId
  inspection?: Omit<StationInspection, 'entries'>
  replay: ReplayStatePayload
  zoom: number
  hidden: boolean
  layout: 'you-top' | 'you-bottom'
  background: 'solid' | 'transparent'
  theme: 'auto' | 'dark' | 'light'
  isLightSurface: boolean
  textSize: 'caption' | 'footnote' | 'body'
  detailLevel: DetailLevel
  canDebug: boolean
  palette: Palette
  hasContext: boolean
  contextPct?: number
  showQuota: boolean
  dailyTokenBudget: number
  contextBudget?: ContextBudget
  quota?: QuotaSnapshot
  ideUsage?: IdeUsageSummary
  tokenStats?: TokenStats
  sparklineSvg?: string
  turnSummaries?: TurnSummary[]
  strings: {
    title: string
    zoomOut: string
    zoomIn: string
    hideMap: string
    showMap: string
    nothingYet: string
    demoLabel: string
    autoLabel: string
    runningLabel: string
    contextLabel: string
    msUnit: string
    secUnit: string
    detailCompact: string
    detailVerbose: string
    detailDebug: string
    debugWarning: string
    turnsTitle: string
    cacheHit: string
    quotaTitle: string
    remaining: string
    used: string
    resetsIn: string
    ideUsage24h: string
    ideUsage7d: string
    dailyBudget: string
    quotaSynced: string
  }
}

export type WebviewCommandMessage =
  | { type: 'ready' }
  | { type: 'setZoom'; zoom: number }
  | { type: 'setHidden'; hidden: boolean }
  | { type: 'toggleLayout' }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'openPanel' }
  | { type: 'selectStation'; station?: StationId }
  | { type: 'setViewMode'; viewMode: 'svg' | 'braille' }
  | { type: 'setReplayIndex'; index?: number }
  | { type: 'setDetailLevel'; detailLevel: DetailLevel }
  | { type: 'copyMarkdown' }
