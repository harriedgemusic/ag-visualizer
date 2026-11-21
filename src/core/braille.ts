import { formatMs, formatTokens, shortModel } from './classify'
import { foldRows } from './feed'
import { STATIONS } from './setup'
import type { Setup } from './setup'
import type { Board, StationId } from './types'

const DEFAULT_COLS = 52
const DEFAULT_ROWS = 19
const MIN_COLS = 24
const MAX_COLS = 100
const MIN_ROWS = 12
const MAX_ROWS = 40
const PULSE_MS = 1200
const FEED_ROWS = 12

const LEFT_BITS = [0x01, 0x02, 0x04, 0x40] as const
const RIGHT_BITS = [0x08, 0x10, 0x20, 0x80] as const

type Point = { x: number; y: number }

function clampDim(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || Number.isNaN(value)) return fallback
  if (value >= max) return max
  if (value <= min) return min
  return Math.round(value)
}

function edge(from: Point, to: Point, r: number): Point {
  const d = Math.hypot(to.x - from.x, to.y - from.y) || 1
  return { x: from.x + ((to.x - from.x) * r) / d, y: from.y + ((to.y - from.y) * r) / d }
}

function sanitizeCanvasText(text: string): string {
  return text
    .replace(/(?:(?![\u200c\u200d])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}])+/gu, ' ')
    .replace(/`/g, "'")
    .trim()
}

function escapeMd(text: string): string {
  return text
    .replace(/(?:(?![\u200c\u200d])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}])+/gu, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/[|`[\]()<>!*_~#-]/g, ch => `\\${ch}`)
    .trim()
}

function finiteNonNeg(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function stationLabelText(board: Board, setup: Setup, id: StationId): string {
  const name = sanitizeCanvasText(setup.t.stations[id])
  const count = Math.round(finiteNonNeg(board.counts[id]))
  if (count === 0) return name
  const tokens = setup.contextCost ? Math.round(finiteNonNeg(board.spent?.[id])) : 0
  return `${name} ${count}${tokens > 0 ? ` +${formatTokens(tokens)}` : ''}`
}

/**
 * Renders the Work Map as a monochrome Unicode Braille canvas with crisp text
 * overlays for station counts/tokens, core identity, and active pulse dots.
 */
export function drawBrailleMap(
  board: Board,
  now: number,
  setup: Setup,
  charCols?: number,
  charRows?: number,
): string {
  const cols = clampDim(charCols, DEFAULT_COLS, MIN_COLS, MAX_COLS)
  const rows = clampDim(charRows, DEFAULT_ROWS, MIN_ROWS, MAX_ROWS)
  const dotW = cols * 2
  const dotH = rows * 4

  const cells = new Uint8Array(cols * rows)
  const overlay = new Map<number, string>()

  const setDot = (px: number, py: number): void => {
    const ix = Math.round(px)
    const iy = Math.round(py)
    if (ix < 0 || ix >= dotW || iy < 0 || iy >= dotH) return
    const cxCell = ix >> 1
    const cyCell = iy >> 2
    const dx = ix & 1
    const dy = iy & 3
    const bit = dx === 0 ? (LEFT_BITS[dy] ?? 0) : (RIGHT_BITS[dy] ?? 0)
    const idx = cyCell * cols + cxCell
    cells[idx] = (cells[idx] ?? 0) | bit
  }

  const drawLine = (a: Point, b: Point): void => {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))))
    for (let k = 0; k <= steps; k++) {
      const t = k / steps
      setDot(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
    }
  }

  const drawCircle = (center: Point, r: number, stepMod = 1): void => {
    const steps = Math.max(12, Math.ceil(2 * Math.PI * r * 1.5))
    for (let k = 0; k < steps; k++) {
      if (stepMod > 1 && k % stepMod !== 0) continue
      const a = (k * 2 * Math.PI) / steps
      setDot(center.x + r * Math.sin(a), center.y - r * Math.cos(a))
    }
  }

  const drawEllipse = (center: Point, rx: number, ry: number, stepMod = 1): void => {
    const steps = Math.max(24, Math.ceil(2 * Math.PI * Math.max(rx, ry)))
    for (let k = 0; k < steps; k++) {
      if (stepMod > 1 && k % stepMod !== 0) continue
      const a = (k * 2 * Math.PI) / steps
      setDot(center.x + rx * Math.sin(a), center.y - ry * Math.cos(a))
    }
  }

  const placeText = (startCol: number, row: number, text: string): void => {
    if (row < 0 || row >= rows) return
    const chars = [...sanitizeCanvasText(text)]
    for (let i = 0; i < chars.length; i++) {
      const col = startCol + i
      if (col < 0 || col >= cols) continue
      const ch = chars[i]
      if (ch !== undefined) overlay.set(row * cols + col, ch)
    }
  }

  const cx = dotW / 2
  const cy = dotH / 2
  const center: Point = { x: cx, y: cy }
  const padY = Math.max(7, Math.round(dotH * 0.1))
  const ry = Math.max(10, cy - padY)
  const rx = Math.max(10, Math.min(ry * 0.95, dotW * 0.24))
  const nodeR = Math.max(2, Math.min(4, Math.round(Math.min(dotW, dotH) * 0.04)))
  const coreR = Math.max(4, Math.min(13, Math.round(Math.min(rx, ry) * 0.36)))

  const runningStations = new Set<StationId>()
  const pulsingStations = new Set<StationId>()
  for (const e of board.entries) {
    if (e.status === 'run') runningStations.add(e.station)
    const age = now - e.startedAt
    if (age >= 0 && age < PULSE_MS) pulsingStations.add(e.station)
  }

  // Subtle outer orbital ring passing through all 10 stations
  drawEllipse(center, rx, ry, 3)

  // Central core circle + optional context fill arc around core
  drawCircle(center, coreR)
  if (board.context !== undefined && Number.isFinite(board.context)) {
    const pct = Math.max(0, Math.min(100, Math.round(board.context)))
    if (pct > 0) {
      const arcR = coreR + 2
      const totalSteps = Math.max(20, Math.ceil(2 * Math.PI * arcR * 1.5))
      const fillSteps = Math.round((totalSteps * pct) / 100)
      for (let k = 0; k <= fillSteps; k++) {
        const a = (k * 2 * Math.PI) / totalSteps
        setDot(cx + arcR * Math.sin(a), cy - arcR * Math.cos(a))
      }
    }
  }

  const shift = setup.layout === 'you-bottom' ? STATIONS.length / 2 : 0

  STATIONS.forEach((s, i) => {
    const angle = ((i + shift) * 2 * Math.PI) / STATIONS.length
    const sinA = Math.sin(angle)
    const cosA = Math.cos(angle)
    const p: Point = { x: cx + rx * sinA, y: cy - ry * cosA }

    const count = Math.round(finiteNonNeg(board.counts[s.id]))
    const isRunning = runningStations.has(s.id)
    const isPulsing = pulsingStations.has(s.id)

    if (count > 0 || isRunning || isPulsing) {
      const a = edge(center, p, coreR + 3)
      const b = edge(p, center, nodeR + 1)
      drawLine(a, b)

      if (isPulsing) {
        const midX = Math.round((a.x + b.x) / 2)
        const midY = Math.round((a.y + b.y) / 2)
        setDot(midX, midY)
        setDot(midX - 1, midY)
        setDot(midX + 1, midY)
        setDot(midX, midY - 1)
        setDot(midX, midY + 1)
      }
    }

    if (count > 0 || isRunning) {
      drawCircle(p, nodeR)
      if (isRunning) {
        setDot(p.x, p.y)
        setDot(p.x - 1, p.y)
        setDot(p.x + 1, p.y)
      }
    } else {
      drawCircle(p, nodeR, 2)
    }

    const label = stationLabelText(board, setup, s.id)
    const labelLen = [...label].length
    if (Math.abs(sinA) < 0.2) {
      const startCol = Math.max(0, Math.min(cols - labelLen, Math.floor((cols - labelLen) / 2)))
      const row =
        cosA > 0
          ? Math.max(0, (Math.round(p.y - nodeR) >> 2) - 1)
          : Math.min(rows - 1, (Math.round(p.y + nodeR) >> 2) + 1)
      placeText(startCol, row, label)
    } else {
      const row = Math.max(0, Math.min(rows - 1, Math.round(p.y) >> 2))
      if (sinA > 0) {
        const desiredStart = (Math.round(p.x + nodeR) >> 1) + 1
        const startCol = Math.max(0, Math.min(cols - labelLen, desiredStart))
        placeText(startCol, row, label)
      } else {
        const desiredEnd = (Math.round(p.x - nodeR) >> 1) - 1
        const startCol = Math.max(0, Math.min(cols - labelLen, desiredEnd - labelLen + 1))
        placeText(startCol, row, label)
      }
    }
  })

  // Core text rendered last so center labels stay sharp inside the core circle
  const ctxSuffix =
    board.context !== undefined && Number.isFinite(board.context)
      ? ` ${Math.max(0, Math.min(100, Math.round(board.context)))}%`
      : ''
  const coreHeader = sanitizeCanvasText(`${setup.core}${ctxSuffix}`)
  const modelText =
    board.model !== undefined && board.model.trim() !== '' ? sanitizeCanvasText(shortModel(board.model)) : ''
  const coreRow1 = modelText !== '' && rows <= 14 ? Math.floor(rows / 2) - 1 : Math.floor(rows / 2)

  const headerChars = [...coreHeader]
  placeText(Math.max(0, Math.floor((cols - headerChars.length) / 2)), coreRow1, coreHeader)

  if (modelText !== '') {
    const modelChars = [...modelText]
    placeText(Math.max(0, Math.floor((cols - modelChars.length) / 2)), coreRow1 + 1, modelText)
  }

  const lines: string[] = []
  for (let r = 0; r < rows; r++) {
    let line = ''
    const base = r * cols
    for (let c = 0; c < cols; c++) {
      const ch = overlay.get(base + c)
      line += ch !== undefined ? ch : String.fromCharCode(0x2800 + (cells[base + c] ?? 0))
    }
    lines.push(line)
  }
  return lines.join('\n')
}

/**
 * Formats a privacy-safe Markdown summary of the current Work Map board,
 * including metadata, the Braille map, active station counts, and recent activity.
 */
export function formatMarkdownReport(board: Board, now: number, setup: Setup): string {
  const { t } = setup
  const sections: string[] = [`# ${escapeMd(t.title)} — ${escapeMd(setup.core)}`]

  const meta: string[] = []
  if (board.model !== undefined && board.model.trim() !== '') {
    meta.push(`${escapeMd(t.stations.model)}: ${escapeMd(shortModel(board.model))}`)
  }
  if (board.context !== undefined && Number.isFinite(board.context)) {
    const pct = Math.max(0, Math.min(100, Math.round(board.context)))
    meta.push(`${escapeMd(t.context)}: ${pct}%`)
  }
  if (meta.length > 0) {
    sections.push(meta.join(' · '))
  }

  const braille = drawBrailleMap(board, now, setup)
  let maxBackticks = 3
  for (const m of braille.matchAll(/`+/g)) {
    if (m[0].length > maxBackticks) maxBackticks = m[0].length
  }
  const fence = '`'.repeat(maxBackticks + 1)
  sections.push([`${fence}text`, braille, fence].join('\n'))

  const tableRows: string[] = []
  for (const s of STATIONS) {
    const count = Math.round(finiteNonNeg(board.counts[s.id]))
    const tokens = setup.contextCost ? Math.round(finiteNonNeg(board.spent?.[s.id])) : 0
    if (count > 0 || tokens > 0) {
      const errors = Math.round(finiteNonNeg(board.faults?.[s.id]))
      const ctxCell = tokens > 0 ? `+${formatTokens(tokens)}` : '—'
      tableRows.push(`| ${escapeMd(t.stations[s.id])} | ${count} | ${ctxCell} | ${errors} |`)
    }
  }

  if (tableRows.length > 0) {
    sections.push(
      ['| Station | Calls | Context | Errors |', '| --- | ---: | ---: | ---: |', ...tableRows].join('\n'),
    )
  } else {
    sections.push(escapeMd(t.noCounts))
  }

  const rows = foldRows(board.entries, FEED_ROWS, setup.subagentNames)
  if (rows.length > 0) {
    const items = rows.map(row => {
      const statusTag =
        row.entry.status === 'run'
          ? ` [${escapeMd(t.running)}]`
          : row.entry.status === 'err' || row.entry.status === 'block'
            ? ` [${row.entry.status}]`
            : ''
      const repeatTag = row.times > 1 ? ` ×${row.times}` : ''
      const elapsed =
        row.entry.status === 'run' ? Math.max(0, now - row.entry.startedAt) : row.tookMs
      const timeTag = elapsed > 0 ? ` · ${escapeMd(formatMs(elapsed, t))}` : ''
      const tokenTag =
        setup.contextCost && row.tokens !== undefined && row.tokens > 0
          ? ` · ${row.isShared ? '~' : '+'}${formatTokens(row.tokens)}`
          : ''
      return `- **${escapeMd(t.stations[row.entry.station])}**: ${escapeMd(row.entry.label)}${repeatTag}${statusTag}${timeTag}${tokenTag}`
    })
    sections.push(items.join('\n'))
  } else {
    sections.push(escapeMd(t.nothingYet))
  }

  return sections.join('\n\n')
}
