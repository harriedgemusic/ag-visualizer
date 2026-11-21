import { STATIONS } from './setup'
import type { Setup } from './setup'
import type { Board, StationId } from './types'

export type StationShare = {
  station: StationId
  stationName: string
  count: number
  timeMs: number
  timePct: number
  tokens: number
  tokenPct: number
}

export type SessionBreakdown = {
  shares: StationShare[]
  turns: number
  totalCalls: number
  totalTimeMs: number
  lastTurnMs?: number
  totalTokens: number
  faultCount: number
}

function finiteNonNeg(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function roundTenth(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0
}

/**
 * Computes per-station call, duration, and token shares plus turn/fault totals
 * from a snapshot board without mutating inputs or reading wall-clock time.
 */
export function computeBreakdown(board: Board, setup: Setup): SessionBreakdown {
  const timeByStation = new Map<StationId, number>()
  for (const s of STATIONS) {
    timeByStation.set(s.id, 0)
  }

  let turns = 0
  let lastTurnStart: number | undefined
  let doneEnd: number | undefined
  let latestAfterEnd: number | undefined

  for (const e of board.entries) {
    if (e.station === 'you' && e.from === 'inbound' && e.mark === undefined) {
      turns += 1
      lastTurnStart = e.startedAt
      doneEnd = undefined
      latestAfterEnd = undefined
    } else if (lastTurnStart !== undefined) {
      const ts = e.endedAt ?? e.startedAt
      if (Number.isFinite(ts)) {
        if (e.mark === 'done' && (doneEnd === undefined || ts > doneEnd)) {
          doneEnd = ts
        }
        if (latestAfterEnd === undefined || ts > latestAfterEnd) {
          latestAfterEnd = ts
        }
      }
    }

    if (e.mark === undefined && e.from !== 'inbound') {
      const dur = e.endedAt === undefined ? 0 : Math.max(0, e.endedAt - e.startedAt)
      if (Number.isFinite(dur) && dur > 0) {
        const prev = timeByStation.get(e.station)
        if (prev !== undefined) {
          timeByStation.set(e.station, prev + dur)
        }
      }
    }
  }

  let lastTurnMs: number | undefined
  if (lastTurnStart !== undefined) {
    const endTs = doneEnd ?? latestAfterEnd
    if (endTs !== undefined) {
      const delta = endTs - lastTurnStart
      if (Number.isFinite(delta) && delta > 0) {
        lastTurnMs = delta
      }
    }
  }

  let totalTimeMs = 0
  let totalCalls = 0
  let totalTokens = 0
  let faultCount = 0

  const rows: {
    station: StationId
    stationName: string
    count: number
    timeMs: number
    tokens: number
  }[] = []

  for (const s of STATIONS) {
    const timeMs = timeByStation.get(s.id) ?? 0
    const count = Math.round(finiteNonNeg(board.counts?.[s.id]))
    const tokens = Math.round(finiteNonNeg(board.spent?.[s.id]))
    const faults = Math.round(finiteNonNeg(board.faults?.[s.id]))

    totalTimeMs += timeMs
    totalCalls += count
    totalTokens += tokens
    faultCount += faults

    if (count > 0 || tokens > 0 || timeMs > 0) {
      rows.push({
        station: s.id,
        stationName: setup.t.stations[s.id],
        count,
        timeMs,
        tokens,
      })
    }
  }

  const shares: StationShare[] = rows
    .map(r => ({
      station: r.station,
      stationName: r.stationName,
      count: r.count,
      timeMs: r.timeMs,
      timePct: roundTenth(r.timeMs, totalTimeMs),
      tokens: r.tokens,
      tokenPct: roundTenth(r.tokens, totalTokens),
    }))
    .sort((a, b) => b.timeMs - a.timeMs || b.tokens - a.tokens || b.count - a.count)

  return {
    shares,
    turns,
    totalCalls,
    totalTimeMs,
    ...(lastTurnMs !== undefined ? { lastTurnMs } : {}),
    totalTokens,
    faultCount,
  }
}
