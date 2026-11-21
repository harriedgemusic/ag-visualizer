import type { Board, StationId } from './types'

const SHARED_AT_MOST = 3

/**
 * Attributes token growth between model steps back to the tool calls answered in that step.
 * 1 call gets all; 2-3 share evenly (marked `shared: true`); 4+ skip row figures,
 * though if all calls went to a single station, that station's sum gets the full growth.
 */
export function charged(
  b: Board,
  calls: readonly string[],
  before: number | undefined,
  after: number | undefined,
): Board {
  if (before === undefined || after === undefined || calls.length === 0 || after <= before) return b
  const grown = after - before
  const own = b.entries.filter(e => calls.includes(e.id))
  if (own.length === 0) return b
  const share = own.length <= SHARED_AT_MOST ? grown / own.length : undefined
  const spent = { ...b.spent }
  const add = (station: StationId, tokens: number): void => {
    spent[station] = Math.round((spent[station] ?? 0) + tokens)
  }
  if (share !== undefined) {
    for (const e of own) add(e.station, share)
  } else if (new Set(own.map(e => e.station)).size === 1 && own[0] !== undefined) {
    add(own[0].station, grown)
  }
  return {
    ...b,
    spent,
    entries:
      share === undefined
        ? b.entries
        : b.entries.map(e =>
            calls.includes(e.id)
              ? { ...e, tokens: Math.round(share), ...(own.length > 1 ? { shared: true } : {}) }
              : e,
          ),
  }
}

export type StepCost = {
  calls: readonly string[]
  before: number | undefined
  after: number | undefined
}

export function stepCosts(isOn: boolean): {
  called(id: string): void
  stepStarted(): readonly string[]
  stepEnded(answered: readonly string[], tokens: number | undefined): StepCost | undefined
  turnEnded(): void
  compacted(): void
} {
  let waiting: string[] = []
  let lastTokens: number | undefined
  return {
    called(id) {
      if (isOn) waiting.push(id)
    },
    stepStarted() {
      const answered = waiting
      waiting = []
      return answered
    },
    stepEnded(answered, tokens) {
      if (!isOn) return undefined
      const cost = { calls: answered, before: lastTokens, after: tokens }
      lastTokens = tokens
      return cost
    },
    turnEnded() {
      waiting = []
    },
    compacted() {
      waiting = []
      lastTokens = undefined
    },
  }
}
