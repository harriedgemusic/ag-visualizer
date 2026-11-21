import fs from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import type { IdeUsageSummary, IdeUsageWindow, SessionSummary } from '../core/types'

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
const MAX_SESSIONS = 60
const MAX_CACHE_ENTRIES = 150
const CHUNK_BYTES = 64 * 1024
const MAX_TAIL_BYTES = 4 * 1024 * 1024
const MAX_LINE_BYTES = 2 * 1024 * 1024

const MAX_CONCURRENT_READS = 8

type TokenEvent = {
  at: number
  inTok: number
  cacheTok: number
  outTok: number
}

const fileEventCache = new Map<
  string,
  { mtimeMs: number; sizeBytes: number; cutoffMs: number; events: TokenEvent[] }
>()

const nonNegInt = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(v))
    : 0

function maybePushTokenEvent(line: string, weekCutoffMs: number, events: TokenEvent[]): void {
  if (!line.includes('"PLANNER_RESPONSE"')) return
  const trimmed = line.trim()
  if (!trimmed) return
  try {
    const obj = JSON.parse(trimmed) as {
      type?: unknown
      created_at?: unknown
      input_tokens?: unknown
      cache_read_tokens?: unknown
      output_tokens?: unknown
    }
    if (obj.type !== 'PLANNER_RESPONSE') return
    const at = typeof obj.created_at === 'string' ? Date.parse(obj.created_at) : Number.NaN
    if (!Number.isFinite(at) || at < weekCutoffMs) return
    const inTok = nonNegInt(obj.input_tokens)
    const cacheTok = nonNegInt(obj.cache_read_tokens)
    const outTok = nonNegInt(obj.output_tokens)
    if (inTok > 0 || cacheTok > 0 || outTok > 0) {
      events.push({ at, inTok, cacheTok, outTok })
    }
  } catch {
    // Ignore malformed lines
  }
}

function emptyWindow(): IdeUsageWindow {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitPct: 0,
    sessions: 0,
    steps: 0,
  }
}

async function parseTranscriptTokenEvents(transcriptPath: string, weekCutoffMs: number): Promise<TokenEvent[]> {
  let st: fs.Stats
  try {
    st = await fs.promises.lstat(transcriptPath)
    if (!st.isFile() || st.size === 0) return []
  } catch {
    return []
  }

  const cached = fileEventCache.get(transcriptPath)
  if (
    cached &&
    cached.mtimeMs === st.mtimeMs &&
    cached.sizeBytes === st.size &&
    weekCutoffMs >= cached.cutoffMs
  ) {
    fileEventCache.delete(transcriptPath)
    fileEventCache.set(transcriptPath, cached)
    return cached.events
  }

  const events: TokenEvent[] = []
  let handle: fs.promises.FileHandle | undefined
  let fdSize = st.size
  let fdMtimeMs = st.mtimeMs
  try {
    handle = await fs.promises.open(transcriptPath, 'r')
    const fdStat = await handle.stat()
    if (!fdStat.isFile() || fdStat.size === 0) return cached?.events ?? []
    fdSize = fdStat.size
    fdMtimeMs = fdStat.mtimeMs

    let offset = fdSize > MAX_TAIL_BYTES ? fdSize - MAX_TAIL_BYTES : 0
    let skipPartialFirstLine = offset > 0
    let remainder = ''
    const decoder = new StringDecoder('utf8')
    const chunkBuf = Buffer.allocUnsafe(CHUNK_BYTES)

    while (offset < fdSize) {
      const length = Math.min(CHUNK_BYTES, fdSize - offset)
      const { bytesRead } = await handle.read(chunkBuf, 0, length, offset)
      if (bytesRead <= 0) break
      offset += bytesRead

      const text = decoder.write(chunkBuf.subarray(0, bytesRead))
      if (!text) continue

      if (remainder.length + text.length > MAX_LINE_BYTES && !text.includes('\n')) {
        remainder = ''
        skipPartialFirstLine = true
        continue
      }

      const combined = remainder + text
      const lines = combined.split('\n')
      const tail = lines.pop() ?? ''
      if (tail.length > MAX_LINE_BYTES) {
        remainder = ''
        skipPartialFirstLine = true
      } else {
        remainder = tail
      }

      for (const line of lines) {
        if (skipPartialFirstLine) {
          skipPartialFirstLine = false
          continue
        }
        maybePushTokenEvent(line, weekCutoffMs, events)
      }
    }

    if (!skipPartialFirstLine) {
      const lastLine = `${remainder}${decoder.end()}`
      if (lastLine.length > 0 && lastLine.length <= MAX_LINE_BYTES) {
        maybePushTokenEvent(lastLine, weekCutoffMs, events)
      }
    }
  } catch {
    return cached?.events ?? events
  } finally {
    if (handle) {
      await handle.close().catch(() => {})
    }
  }

  fileEventCache.delete(transcriptPath)
  if (fileEventCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = fileEventCache.keys().next().value
    if (oldestKey !== undefined) fileEventCache.delete(oldestKey)
  }
  fileEventCache.set(transcriptPath, { mtimeMs: fdMtimeMs, sizeBytes: fdSize, cutoffMs: weekCutoffMs, events })
  return events
}

/**
 * Aggregates read-only 24-hour and 7-day model token usage across recent local
 * Antigravity IDE sessions using file `mtime` + `size` caching.
 */
export async function readIdeTokenUsage(
  sessions: readonly SessionSummary[],
  nowMs = Date.now(),
): Promise<IdeUsageSummary> {
  const dayCutoffMs = nowMs - DAY_MS
  const weekCutoffMs = nowMs - WEEK_MS

  const seenPaths = new Set<string>()
  const recent: SessionSummary[] = []
  const sorted = [...sessions].sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const s of sorted) {
    if (s.mtimeMs < weekCutoffMs) break
    if (!s.transcriptPath || seenPaths.has(s.transcriptPath)) continue
    seenPaths.add(s.transcriptPath)
    recent.push(s)
    if (recent.length >= MAX_SESSIONS) break
  }

  const last24h = emptyWindow()
  const last7d = emptyWindow()

  const perSessionEvents: TokenEvent[][] = []
  for (let i = 0; i < recent.length; i += MAX_CONCURRENT_READS) {
    const batch = recent.slice(i, i + MAX_CONCURRENT_READS)
    const resolved = await Promise.all(
      batch.map(s => parseTranscriptTokenEvents(s.transcriptPath, weekCutoffMs)),
    )
    perSessionEvents.push(...resolved)
  }

  for (const events of perSessionEvents) {
    let saw24h = false
    let saw7d = false
    for (const ev of events) {
      if (ev.at < weekCutoffMs) continue
      saw7d = true
      last7d.inputTokens += ev.inTok
      last7d.cacheReadTokens += ev.cacheTok
      last7d.outputTokens += ev.outTok
      last7d.steps += 1

      if (ev.at >= dayCutoffMs) {
        saw24h = true
        last24h.inputTokens += ev.inTok
        last24h.cacheReadTokens += ev.cacheTok
        last24h.outputTokens += ev.outTok
        last24h.steps += 1
      }
    }
    if (saw24h) last24h.sessions += 1
    if (saw7d) last7d.sessions += 1
  }

  for (const win of [last24h, last7d]) {
    const rawTotal = win.inputTokens + win.cacheReadTokens + win.outputTokens
    win.totalTokens = Number.isFinite(rawTotal) ? rawTotal : Number.MAX_SAFE_INTEGER
    const promptTotal = win.inputTokens + win.cacheReadTokens
    const ratio = promptTotal > 0 ? win.cacheReadTokens / promptTotal : 0
    win.cacheHitPct = promptTotal > 0 && Number.isFinite(ratio)
      ? Math.min(100, Math.max(0, Math.round(ratio * 100)))
      : 0
  }

  return { last24h, last7d, computedAtMs: nowMs }
}
