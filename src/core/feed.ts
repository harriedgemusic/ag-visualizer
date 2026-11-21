import { shortModel } from './classify'
import type { Strings } from './text'
import type { Board, Entry } from './types'

export type Row = {
  entry: Entry
  times: number
  tookMs: number
  tokens?: number
  isShared?: boolean
  isHeld?: boolean
}

const rowOf = (e: Entry, took: number): Row => ({
  entry: e,
  times: 1,
  tookMs: took,
  ...(e.tokens !== undefined ? { tokens: e.tokens, ...(e.shared ? { isShared: true } : {}) } : {}),
})

function fold(row: Row, e: Entry, took: number): void {
  row.times++
  row.tookMs += took
  if (e.tokens === undefined && row.tokens === undefined) return
  if (e.tokens === undefined || row.tokens === undefined || e.shared) row.isShared = true
  row.tokens = (row.tokens ?? 0) + (e.tokens ?? 0)
}

const isPlain = (e: Entry): boolean => e.status === 'ok' && e.mark === undefined

export const LIST_ROWS = 16
export const VERBOSE_LIST_ROWS = 80

/**
 * Produces the activity feed rows, newest first.
 * Consecutive finished entries at the same station/origin fold into a single row (`+N`)
 * unless `noFold` is true.
 * Still-running entries beyond `max` remain pinned at the bottom (up to half the list)
 * so the list always matches the running stations on the map.
 */
export function foldRows(entries: readonly Entry[], max = LIST_ROWS, apart = false, noFold = false): Row[] {
  const rows: Row[] = []
  const running: Row[] = []
  let isCut = false
  const held = Math.max(1, Math.floor(max / 2))
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e === undefined) continue
    const took = e.endedAt === undefined ? 0 : Math.max(0, e.endedAt - e.startedAt)
    const last = rows[rows.length - 1]
    if (
      !noFold &&
      !isCut &&
      last !== undefined &&
      isPlain(e) &&
      isPlain(last.entry) &&
      last.entry.station === e.station &&
      last.entry.from === e.from &&
      (!apart || last.entry.agentId === e.agentId)
    ) {
      fold(last, e, took)
      continue
    }
    if (rows.length >= max) {
      isCut = true
      if (e.status !== 'run') continue
      const oldest = running[running.length - 1]
      if (running.length < held || oldest === undefined) running.push({ ...rowOf(e, took), isHeld: true })
      else oldest.times++
      continue
    }
    rows.push(rowOf(e, took))
  }
  return running.length === 0 ? rows : [...rows.slice(0, max - running.length), ...running]
}

export function nowParts(board: Board, t: Strings): { what: string; meter: string } {
  const running = board.entries.filter(e => e.status === 'run')
  const top = running[running.length - 1]
  const what =
    top === undefined
      ? t.idle
      : `${t.stations[top.station]}: ${top.label}${running.length > 1 ? t.andMore(running.length - 1) : ''}`
  const hasCtx = board.context !== undefined && Number.isFinite(board.context)
  const figures = [
    hasCtx ? `${Math.max(0, Math.min(100, Math.round(board.context!)))}%` : '',
    board.model === undefined || top?.station === 'model' ? '' : shortModel(board.model),
  ]
  return { what, meter: figures.filter(Boolean).join(' · ') }
}

export function describeNow(board: Board, t: Strings): string {
  const running = board.entries.filter(e => e.status === 'run')
  const hasCtx = board.context !== undefined && Number.isFinite(board.context)
  const context = hasCtx ? ` · ${t.context} ${Math.max(0, Math.min(100, Math.round(board.context!)))}%` : ''
  const top = running[running.length - 1]
  const model = board.model !== undefined ? ` · ${shortModel(board.model)}` : ''
  if (top === undefined) return `${t.idle}${context}${model}`
  return `${t.stations[top.station]}: ${top.label}${running.length > 1 ? t.andMore(running.length - 1) : ''}${context}`
}

export function keepNewest(
  kept: { readonly size: number; keys(): IterableIterator<string>; delete(key: string): boolean },
  max: number,
): void {
  for (const key of kept.keys()) {
    if (kept.size <= max) break
    kept.delete(key)
  }
}
