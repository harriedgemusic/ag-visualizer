import fs from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { TranscriptReducer } from '../core/reducer'
import type { Setup } from '../core/setup'
import type { Board, SessionSummary, TranscriptStep } from '../core/types'
import { childSessionsOf } from './discovery'

const CHUNK_BYTES = 64 * 1024
const MAX_INITIAL_TAIL_BYTES = 4 * 1024 * 1024
const MAX_LINE_BYTES = 2 * 1024 * 1024

type TailState = {
  path: string
  offset: number
  remainder: string
  decoder: StringDecoder
  skipPartialFirstLine: boolean
  watcher?: fs.FSWatcher
  from: 'core' | 'agents'
  agentId?: string
  subagentLabel?: string
}

export class TranscriptTailer {
  private _reducer: TranscriptReducer
  private _primary: TailState | null = null
  private _children = new Map<string, TailState>()
  private _pollTimer: NodeJS.Timeout | null = null
  private _reading = false
  private _onUpdate: (board: Board) => void
  private _activeSessionId: string | undefined
  private _sessionIdle = false
  private _sessionMtimeMs = 0

  constructor(setup: Setup, onUpdate: (board: Board) => void) {
    this._reducer = new TranscriptReducer(setup)
    this._onUpdate = onUpdate
  }

  get activeSessionId(): string | undefined {
    return this._activeSessionId
  }

  board(): Board {
    return this._reducer.board()
  }

  updateSetup(setup: Setup): void {
    this._reducer.updateSetup(setup)
    this._onUpdate(this._reducer.board())
  }

  async attach(session: SessionSummary | undefined, allSessions: readonly SessionSummary[]): Promise<void> {
    if (!session && !this._primary && this._activeSessionId === undefined) return
    const nextIdle = Boolean(session && session.status === 'CASCADE_RUN_STATUS_IDLE' && !session.notFullyIdle)
    this._sessionIdle = nextIdle
    this._sessionMtimeMs = session?.mtimeMs ?? 0

    if (session && session.id === this._activeSessionId && this._primary?.path === session.transcriptPath) {
      await this.syncChildren(session, allSessions)
      if (this._sessionIdle && this._reducer.settleAllRunning(this._sessionMtimeMs)) {
        this._onUpdate(this._reducer.board())
      }
      return
    }
    this.stopWatchers()
    this._reducer.reset()
    this._activeSessionId = session?.id

    if (!session) {
      this._onUpdate(this._reducer.board())
      return
    }

    this._primary = {
      path: session.transcriptPath,
      offset: 0,
      remainder: '',
      decoder: new StringDecoder('utf8'),
      skipPartialFirstLine: false,
      from: 'core',
    }
    this.watchFile(this._primary)
    await this.syncChildren(session, allSessions)
    await this.pollOnce()

    if (this._sessionIdle && this._reducer.settleAllRunning(this._sessionMtimeMs)) {
      this._onUpdate(this._reducer.board())
    }

    this._pollTimer = setInterval(() => {
      void this.pollOnce().catch(() => {
        // Never allow poll errors to surface as unhandled rejections
      })
    }, 400)
  }

  async syncChildren(session: SessionSummary, allSessions: readonly SessionSummary[]): Promise<void> {
    const children = childSessionsOf(allSessions, session.id)
    for (const child of children) {
      if (this._children.has(child.id)) continue
      const state: TailState = {
        path: child.transcriptPath,
        offset: 0,
        remainder: '',
        decoder: new StringDecoder('utf8'),
        skipPartialFirstLine: false,
        from: 'agents',
        agentId: child.id,
        subagentLabel: child.title !== child.id.slice(0, 8) ? child.title : undefined,
      }
      this._children.set(child.id, state)
      this.watchFile(state)
    }
  }

  private watchFile(state: TailState): void {
    try {
      state.watcher = fs.watch(state.path, () => {
        void this.pollOnce().catch(() => {
          // Ignore transient watch/read races
        })
      })
      state.watcher.on('error', () => {
        // Fallback polling continues safely
      })
    } catch {
      // Fallback polling handles environments where fs.watch cannot attach
    }
  }

  async pollOnce(): Promise<void> {
    if (this._reading) return
    this._reading = true
    let changed = false
    try {
      if (this._primary) {
        if (await this.readDelta(this._primary)) changed = true
      }
      for (const child of this._children.values()) {
        if (await this.readDelta(child)) changed = true
      }
      if (changed && this._sessionIdle) {
        this._reducer.settleAllRunning(this._sessionMtimeMs)
      }
    } finally {
      this._reading = false
    }
    if (changed) {
      this._onUpdate(this._reducer.board())
    }
  }

  private async readDelta(state: TailState): Promise<boolean> {
    let st: fs.Stats
    try {
      st = await fs.promises.stat(state.path)
      if (!st.isFile()) return false
    } catch {
      return false
    }

    if (st.size < state.offset) {
      state.offset = 0
      state.remainder = ''
      state.decoder = new StringDecoder('utf8')
      state.skipPartialFirstLine = false
      if (state.from === 'core') {
        this._reducer.reset()
        for (const child of this._children.values()) {
          child.offset = 0
          child.remainder = ''
          child.decoder = new StringDecoder('utf8')
          child.skipPartialFirstLine = false
        }
      }
    }

    // Cap initial backfill on huge transcripts to avoid OOM in the Extension Host.
    if (state.offset === 0 && st.size > MAX_INITIAL_TAIL_BYTES) {
      state.offset = st.size - MAX_INITIAL_TAIL_BYTES
      state.skipPartialFirstLine = true
    }

    if (st.size === state.offset) return false

    let handle: fs.promises.FileHandle | undefined
    let parsedAny = false
    try {
      handle = await fs.promises.open(state.path, 'r')
      const chunkBuf = Buffer.allocUnsafe(CHUNK_BYTES)
      while (state.offset < st.size) {
        const remaining = st.size - state.offset
        const length = Math.min(CHUNK_BYTES, remaining)
        const { bytesRead } = await handle.read(chunkBuf, 0, length, state.offset)
        if (bytesRead <= 0) break
        state.offset += bytesRead

        const text = state.decoder.write(chunkBuf.subarray(0, bytesRead))
        if (!text) continue

        if (state.remainder.length + text.length > MAX_LINE_BYTES && !text.includes('\n')) {
          // Drop oversized unterminated line to bound memory
          state.remainder = ''
          state.skipPartialFirstLine = true
          continue
        }

        const combined = state.remainder + text
        const lines = combined.split('\n')
        const tail = lines.pop() ?? ''
        if (tail.length > MAX_LINE_BYTES) {
          state.remainder = ''
          state.skipPartialFirstLine = true
        } else {
          state.remainder = tail
        }

        for (const line of lines) {
          if (state.skipPartialFirstLine) {
            state.skipPartialFirstLine = false
            continue
          }
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const step = JSON.parse(trimmed) as TranscriptStep
            this._reducer.push(step, {
              from: state.from,
              agentId: state.agentId,
              subagentLabel: state.subagentLabel,
            })
            parsedAny = true
          } catch {
            // Ignore partial or malformed lines safely
          }
        }
      }
    } catch {
      // Handle TOCTOU unlink/rotation gracefully
      return parsedAny
    } finally {
      if (handle) {
        await handle.close().catch(() => {})
      }
    }

    return parsedAny
  }

  private stopWatchers(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = null
    }
    if (this._primary?.watcher) {
      this._primary.watcher.close()
    }
    this._primary = null
    for (const child of this._children.values()) {
      child.watcher?.close()
    }
    this._children.clear()
  }

  dispose(): void {
    this.stopWatchers()
  }
}
