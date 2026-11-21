import type { Palette } from '../core/palette'
import type { StationId, Status } from '../core/types'

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
}

export type SessionOption = {
  id: string
  title: string
  running: boolean
  mtimeMs: number
}

export type WebviewStateMessage = {
  type: 'state'
  svg: string
  nowWhat: string
  nowMeter: string
  mode: 'auto' | 'pinned' | 'demo'
  activeSessionId?: string
  sessions: SessionOption[]
  rows: FeedRowPayload[]
  zoom: number
  hidden: boolean
  layout: 'you-top' | 'you-bottom'
  background: 'solid' | 'transparent'
  theme: 'auto' | 'dark' | 'light'
  isLightSurface: boolean
  textSize: 'caption' | 'footnote' | 'body'
  palette: Palette
  hasContext: boolean
  model?: string
  contextPct?: number
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
  }
}

export type WebviewCommandMessage =
  | { type: 'ready' }
  | { type: 'setZoom'; zoom: number }
  | { type: 'setHidden'; hidden: boolean }
  | { type: 'toggleLayout' }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'openPanel' }
