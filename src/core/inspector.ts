import type { Setup } from './setup'
import type { Board, Entry, StationId, Status } from './types'

const TOP_LABELS_LIMIT = 4

export type TopLabel = {
  label: string
  count: number
  timeMs: number
  errors: number
}

export type StationInspection = {
  station: StationId
  stationName: string
  status: Status
  count: number
  callSharePct: number
  runningCount: number
  faultCount: number
  tokens: number
  totalTimeMs: number
  avgTimeMs: number
  maxTimeMs: number
  topLabels: TopLabel[]
  entries: Entry[]
}

const finiteOrZero = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

/**
 * Returns entries belonging to `station` in board order, or `board.entries` when `station` is `undefined`.
 */
export function filterBoardByStation(board: Board, station: StationId | undefined): readonly Entry[] {
  if (station === undefined) return board.entries
  return board.entries.filter(e => e.station === station)
}

/**
 * Computes a read-only inspection summary for `station` without mutating `board`.
 * Returned `entries` are a shallow copy in chronological `board.entries` order.
 */
export function inspectStation(board: Board, station: StationId, setup: Setup): StationInspection {
  const entries = board.entries.filter(e => e.station === station)
  const count = Math.max(finiteOrZero(board.counts[station]), entries.length)

  let totalBoardCalls = 0
  for (const n of Object.values(board.counts)) {
    const val = finiteOrZero(n)
    if (val > 0) totalBoardCalls += val
  }
  if (totalBoardCalls === 0) totalBoardCalls = board.entries.length

  const callSharePct =
    totalBoardCalls > 0 ? Math.min(100, Math.round((count / totalBoardCalls) * 1000) / 10) : 0
  const faultCount = Math.max(0, finiteOrZero(board.faults?.[station]))
  const tokens = Math.max(0, Math.round(finiteOrZero(board.spent?.[station])))

  let runningCount = 0
  let totalTimeMs = 0
  let maxTimeMs = 0
  let finishedCount = 0
  const labelMap = new Map<string, TopLabel>()

  for (const e of entries) {
    if (e.status === 'run') runningCount += 1

    const rawDur = e.endedAt !== undefined ? Math.max(0, e.endedAt - e.startedAt) : 0
    const dur = Number.isFinite(rawDur) ? rawDur : 0
    if (e.endedAt !== undefined && Number.isFinite(rawDur)) {
      totalTimeMs += dur
      finishedCount += 1
      if (dur > maxTimeMs) maxTimeMs = dur
    }

    const isError = e.status === 'err' || e.status === 'block' ? 1 : 0
    const existing = labelMap.get(e.label)
    if (existing !== undefined) {
      existing.count += 1
      existing.timeMs += dur
      existing.errors += isError
    } else {
      labelMap.set(e.label, { label: e.label, count: 1, timeMs: dur, errors: isError })
    }
  }

  const avgTimeMs = finishedCount > 0 ? Math.round(totalTimeMs / finishedCount) : 0
  const lastEntry = entries[entries.length - 1]
  const endsInError = lastEntry?.status === 'err' || lastEntry?.status === 'block'
  const status: Status = runningCount > 0 ? 'run' : faultCount > 0 || endsInError ? 'err' : 'ok'

  const topLabels = [...labelMap.values()]
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count
      if (b.timeMs !== a.timeMs) return b.timeMs - a.timeMs
      if (a.label < b.label) return -1
      if (a.label > b.label) return 1
      return 0
    })
    .slice(0, TOP_LABELS_LIMIT)

  const stationName = Object.hasOwn(setup.t.stations, station) ? setup.t.stations[station] : String(station)

  return {
    station,
    stationName,
    status,
    count,
    callSharePct,
    runningCount,
    faultCount,
    tokens,
    totalTimeMs,
    avgTimeMs,
    maxTimeMs,
    topLabels,
    entries,
  }
}
