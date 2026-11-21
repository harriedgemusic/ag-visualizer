import { escapeXml } from './draw'
import type { Palette } from './palette'
import type { Setup } from './setup'
import type { Board, Entry, ModelStepTelemetry, StationId } from './types'

export type TurnTopStation = {
  station: StationId
  stationName: string
  count: number
}

export type TurnSummary = {
  turnNumber: number
  startedAt: number
  endedAt: number
  durationMs: number
  callCount: number
  faultCount: number
  tokensAdded: number
  isActive: boolean
  topStations: TurnTopStation[]
}

export type TokenSparklinePoint = {
  at: number
  totalContextTokens: number
  cacheHitPct: number
  isCompaction?: boolean
}

export type TokenStats = {
  steps: number
  latestInput: number
  latestCacheRead: number
  latestOutput: number
  latestTotalContext: number
  latestCacheHitPct: number
  totalInput: number
  totalCacheRead: number
  totalOutput: number
  overallCacheHitPct: number
  peakContextTokens: number
  compactions: number
  series: TokenSparklinePoint[]
}

const isUserTurnEntry = (e: Entry): boolean => e.station === 'you' && e.from === 'inbound' && e.mark === undefined

const finiteNonNeg = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

const finiteTs = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

/**
 * Groups `board.entries` into per-turn summaries without mutating inputs or reading wall-clock time.
 */
export function computeTurnSummaries(board: Board, setup: Setup): TurnSummary[] {
  type Bucket = {
    turnNumber: number
    startedAt: number
    endedAt: number
    callCount: number
    faultCount: number
    tokensAdded: number
    hasRunning: boolean
    stationCounts: Map<StationId, number>
  }

  const buckets: Bucket[] = []
  let current: Bucket | undefined
  let nextTurnNumber = 1

  for (const e of board.entries) {
    if (isUserTurnEntry(e)) {
      const start = finiteTs(e.startedAt, 0)
      current = {
        turnNumber: nextTurnNumber++,
        startedAt: start,
        endedAt: start,
        callCount: 0,
        faultCount: 0,
        tokensAdded: 0,
        hasRunning: false,
        stationCounts: new Map<StationId, number>(),
      }
      buckets.push(current)
      continue
    }

    if (!current) {
      const start = finiteTs(e.startedAt, 0)
      current = {
        turnNumber: 0,
        startedAt: start,
        endedAt: start,
        callCount: 0,
        faultCount: 0,
        tokensAdded: 0,
        hasRunning: false,
        stationCounts: new Map<StationId, number>(),
      }
      buckets.push(current)
    }

    const endCandidate = finiteTs(e.endedAt, finiteTs(e.startedAt, current.endedAt))
    if (endCandidate > current.endedAt) current.endedAt = endCandidate

    if (e.mark === undefined && e.from !== 'inbound') {
      current.callCount += 1
      if (e.status === 'err' || e.status === 'block') current.faultCount += 1
      if (e.status === 'run') current.hasRunning = true
      const tok = finiteNonNeg(e.tokens)
      if (tok > 0) current.tokensAdded += Math.round(tok)
      current.stationCounts.set(e.station, (current.stationCounts.get(e.station) ?? 0) + 1)
    }
  }

  return buckets.map(b => {
    const topStations: TurnTopStation[] = [...b.stationCounts.entries()]
      .sort((a, z) => z[1] - a[1] || (a[0] < z[0] ? -1 : a[0] > z[0] ? 1 : 0))
      .slice(0, 3)
      .map(([station, count]) => ({
        station,
        stationName: Object.hasOwn(setup.t.stations, station) ? setup.t.stations[station] : String(station),
        count,
      }))

    return {
      turnNumber: b.turnNumber,
      startedAt: b.startedAt,
      endedAt: b.endedAt,
      durationMs: Math.max(0, b.endedAt - b.startedAt),
      callCount: b.callCount,
      faultCount: b.faultCount,
      tokensAdded: b.tokensAdded,
      isActive: b.hasRunning,
      topStations,
    }
  })
}

/**
 * Computes numeric token/cache statistics and context-growth sparkline points from `board.modelSteps`.
 */
export function computeTokenStats(board: Board): TokenStats {
  const rawSteps: readonly ModelStepTelemetry[] = board.modelSteps ?? []
  if (rawSteps.length === 0) {
    return {
      steps: 0,
      latestInput: 0,
      latestCacheRead: 0,
      latestOutput: 0,
      latestTotalContext: 0,
      latestCacheHitPct: 0,
      totalInput: 0,
      totalCacheRead: 0,
      totalOutput: 0,
      overallCacheHitPct: 0,
      peakContextTokens: 0,
      compactions: 0,
      series: [],
    }
  }

  let totalInput = 0
  let totalCacheRead = 0
  let totalOutput = 0
  let allInput = 0
  let allCacheRead = 0
  let allOutput = 0
  let peakContextTokens = 0
  let compactions = 0
  const series: TokenSparklinePoint[] = []

  for (const ms of rawSteps) {
    const inTok = Math.round(finiteNonNeg(ms.inputTokens))
    const cacheTok = Math.round(finiteNonNeg(ms.cacheReadTokens))
    const outTok = Math.round(finiteNonNeg(ms.outputTokens))
    const ctxTok = Math.round(finiteNonNeg(ms.totalContextTokens)) || inTok + cacheTok
    const cacheHitPct =
      ctxTok > 0
        ? Math.min(100, Math.max(0, Math.round((cacheTok / ctxTok) * 100)))
        : Math.min(100, Math.max(0, Math.round(finiteNonNeg(ms.cacheHitPct))))

    if (ms.isCompaction) {
      compactions += 1
    } else {
      totalInput += inTok
      totalCacheRead += cacheTok
      totalOutput += outTok
    }
    allInput += inTok
    allCacheRead += cacheTok
    allOutput += outTok

    if (ctxTok > peakContextTokens) peakContextTokens = ctxTok

    series.push({
      at: finiteTs(ms.at, 0),
      totalContextTokens: ctxTok,
      cacheHitPct,
      ...(ms.isCompaction ? { isCompaction: true } : {}),
    })
  }

  const effIn = totalInput + totalCacheRead > 0 ? totalInput : allInput
  const effCache = totalInput + totalCacheRead > 0 ? totalCacheRead : allCacheRead
  const effOut = totalInput + totalCacheRead > 0 || totalOutput > 0 ? totalOutput : allOutput
  const latest = rawSteps[rawSteps.length - 1]!
  const latestIn = Math.round(finiteNonNeg(latest.inputTokens))
  const latestCache = Math.round(finiteNonNeg(latest.cacheReadTokens))
  const latestOut = Math.round(finiteNonNeg(latest.outputTokens))
  const latestCtx = Math.round(finiteNonNeg(latest.totalContextTokens)) || latestIn + latestCache
  const latestHit = latestCtx > 0 ? Math.min(100, Math.round((latestCache / latestCtx) * 100)) : 0
  const overallDenom = effIn + effCache
  const overallHit = overallDenom > 0 ? Math.min(100, Math.round((effCache / overallDenom) * 100)) : 0

  return {
    steps: rawSteps.length,
    latestInput: latestIn,
    latestCacheRead: latestCache,
    latestOutput: latestOut,
    latestTotalContext: latestCtx,
    latestCacheHitPct: latestHit,
    totalInput: effIn,
    totalCacheRead: effCache,
    totalOutput: effOut,
    overallCacheHitPct: overallHit,
    peakContextTokens,
    compactions,
    series,
  }
}

const n1 = (v: number): string => (Math.round(v * 10) / 10).toString()

/**
 * Renders a compact inline XML SVG sparkline of context token growth and compaction drops.
 */
export function drawContextSparkline(stats: TokenStats, palette: Palette, width = 260, height = 42): string {
  if (stats.series.length === 0) return ''

  const w = Number.isFinite(width) ? Math.max(80, Math.min(600, Math.round(width))) : 260
  const h = Number.isFinite(height) ? Math.max(24, Math.min(200, Math.round(height))) : 42
  const padX = 4
  const padY = 5
  const innerW = w - padX * 2
  const innerH = h - padY * 2
  const maxVal = Math.max(1, finiteNonNeg(stats.peakContextTokens))

  const lineColor = escapeXml(palette.line)
  const accentColor = escapeXml(palette.accent)
  const hotColor = escapeXml(palette.hot)
  const memColor = escapeXml(palette.mem)

  const coords = stats.series.map((pt, idx) => {
    const x =
      stats.series.length === 1
        ? padX + innerW / 2
        : padX + (idx / (stats.series.length - 1)) * innerW
    const ratio = Math.max(0, Math.min(1, finiteNonNeg(pt.totalContextTokens) / maxVal))
    const y = padY + (1 - ratio) * innerH
    return { x, y, isCompaction: Boolean(pt.isCompaction) }
  })

  const baselineY = n1(h - padY)
  const topY = n1(padY)
  const guides =
    `<line x1="${padX}" y1="${baselineY}" x2="${w - padX}" y2="${baselineY}" stroke="${lineColor}" stroke-width="1"/>` +
    `<line x1="${padX}" y1="${topY}" x2="${w - padX}" y2="${topY}" stroke="${lineColor}" stroke-width="0.7" stroke-dasharray="2 3"/>`

  const compMarks = coords
    .filter(c => c.isCompaction)
    .map(
      c =>
        `<line x1="${n1(c.x)}" y1="${topY}" x2="${n1(c.x)}" y2="${baselineY}" stroke="${memColor}" stroke-width="1" stroke-dasharray="2 2"/>`,
    )
    .join('')

  let pathContent = ''
  if (coords.length === 1) {
    const only = coords[0]!
    pathContent = `<line x1="${padX}" y1="${n1(only.y)}" x2="${w - padX}" y2="${n1(only.y)}" stroke="${accentColor}" stroke-width="1.2" stroke-opacity="0.45"/>`
  } else {
    const polyPts = coords.map(c => `${n1(c.x)},${n1(c.y)}`).join(' ')
    const first = coords[0]!
    const last = coords[coords.length - 1]!
    const areaPts = `${n1(first.x)},${baselineY} ${polyPts} ${n1(last.x)},${baselineY}`
    pathContent =
      `<polygon points="${areaPts}" fill="${accentColor}" fill-opacity="0.16"/>` +
      `<polyline points="${polyPts}" fill="none" stroke="${accentColor}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`
  }

  const last = coords[coords.length - 1]!
  const lastDot = `<circle cx="${n1(last.x)}" cy="${n1(last.y)}" r="2.6" fill="${hotColor}"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Context growth sparkline">${guides}${compMarks}${pathContent}${lastDot}</svg>`
}
