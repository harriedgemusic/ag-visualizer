import type { Board, Entry, StationId, SubagentInfo } from './types'

export type ReplayCursor = {
  index: number
  total: number
  isLive: boolean
  renderNow: number
  currentEntry?: Entry
  turnNumber: number
  totalTurns: number
}

export type ReplayFrame = {
  board: Board
  cursor: ReplayCursor
}

const isUserTurn = (e: Entry): boolean => e.station === 'you' && e.from === 'inbound' && e.mark === undefined

/**
 * Returns 1-based cursor positions for every inbound user turn in `entries`.
 */
export function turnIndices(entries: readonly Entry[]): number[] {
  const indices: number[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e !== undefined && isUserTurn(e)) {
      indices.push(i + 1)
    }
  }
  return indices
}

/**
 * Produces a non-mutating historical or live board snapshot at 1-based entry cursor `index`.
 * `index === undefined` or `index >= board.entries.length` returns the live board frame.
 */
export function sliceBoardAt(board: Board, index: number | undefined, liveNow?: number): ReplayFrame {
  const entries = board.entries
  const total = entries.length
  const turns = turnIndices(entries)
  const totalTurns = turns.length

  if (index === undefined || Number.isNaN(index) || index >= total) {
    const currentEntry = total > 0 ? entries[total - 1] : undefined
    return {
      board,
      cursor: {
        index: total,
        total,
        isLive: true,
        renderNow: liveNow ?? Date.now(),
        ...(currentEntry !== undefined ? { currentEntry } : {}),
        turnNumber: totalTurns,
        totalTurns,
      },
    }
  }

  const clamped = Math.max(0, Math.min(total, Math.floor(index)))

  if (clamped === 0) {
    const firstStartedAt = entries[0]?.startedAt
    return {
      board: { entries: [], counts: {} },
      cursor: {
        index: 0,
        total,
        isLive: false,
        renderNow: (firstStartedAt ?? liveNow ?? Date.now()) - 100,
        turnNumber: 0,
        totalTurns,
      },
    }
  }

  const sliced = entries.slice(0, clamped)
  const target = sliced[sliced.length - 1]!
  const renderNow = target.startedAt + 250

  const historicalEntries: Entry[] = []
  const counts: Partial<Record<StationId, number>> = {}
  const spent: Partial<Record<StationId, number>> = {}
  let hasSpent = false
  let faults: Partial<Record<StationId, number>> = {}
  let hasFault = false
  let sawInboundTurn = false
  let lastSwitch: Entry | undefined

  for (let i = 0; i < sliced.length; i++) {
    const e = sliced[i]!
    const isInFlight =
      e.endedAt !== undefined && e.endedAt > renderNow && e.mark === undefined && e.from !== 'inbound'

    let cloned: Entry
    if (isInFlight) {
      const { endedAt: _endedAt, ...rest } = e
      cloned = { ...rest, status: 'run' }
    } else {
      cloned = { ...e }
    }
    historicalEntries.push(cloned)

    counts[cloned.station] = (counts[cloned.station] ?? 0) + 1

    if (cloned.tokens !== undefined) {
      spent[cloned.station] = (spent[cloned.station] ?? 0) + cloned.tokens
      hasSpent = true
    }

    if (isUserTurn(cloned)) {
      faults = {}
      hasFault = false
      sawInboundTurn = true
    } else if (cloned.status === 'err' || cloned.status === 'block') {
      faults[cloned.station] = (faults[cloned.station] ?? 0) + 1
      hasFault = true
    }

    if (cloned.mark === 'switch') {
      lastSwitch = cloned
    }
  }

  let hasLaterSwitch = false
  for (let i = clamped; i < total; i++) {
    if (entries[i]?.mark === 'switch') {
      hasLaterSwitch = true
      break
    }
  }

  const model = !hasLaterSwitch ? (board.model ?? lastSwitch?.label) : lastSwitch?.label
  const switchedAt = lastSwitch?.startedAt

  let agents: SubagentInfo[] | undefined
  if (board.agents !== undefined) {
    agents = []
    for (const a of board.agents) {
      if (a.startedAt > renderNow) continue
      if (a.endedAt !== undefined && a.endedAt > renderNow) {
        const { endedAt: _endedAt, ...rest } = a
        agents.push(rest)
      } else {
        agents.push({ ...a })
      }
    }
  }

  let turnNumber = 0
  for (const t of turns) {
    if (t <= clamped) turnNumber++
    else break
  }

  const includeFaults = hasFault || sawInboundTurn || board.faults !== undefined

  const historicalBoard: Board = {
    entries: historicalEntries,
    counts,
    ...(includeFaults ? { faults } : {}),
    ...(hasSpent ? { spent } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(switchedAt !== undefined ? { switchedAt } : {}),
    ...(agents !== undefined ? { agents } : {}),
  }

  return {
    board: historicalBoard,
    cursor: {
      index: clamped,
      total,
      isLive: false,
      renderNow,
      currentEntry: target,
      turnNumber,
      totalTurns,
    },
  }
}
