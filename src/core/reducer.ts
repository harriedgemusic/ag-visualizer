import { classifyTool, clean, shortModel, unwrapValue } from './classify'
import { charged, stepCosts } from './cost'
import type { Setup } from './setup'
import type { Board, Entry, RawToolCall, StationId, SubagentInfo, TranscriptStep } from './types'

const KEEP = 80
const MAX_AGENTS = 12
const METADATA_SCAN_LIMIT = 600

type OriginPushOptions = {
  from?: 'core' | 'agents'
  subagentLabel?: string
  agentId?: string
  now?: number
}

type PendingCall = {
  entryId: string
  name: string
  station: StationId
  startedAt: number
  isSubagent: boolean
  subagentLabel?: string
}

export function contextWindowFor(model: string | undefined, overrideTokens = 0): number {
  if (overrideTokens > 0) return overrideTokens
  if (model && /claude/i.test(model)) {
    return /1m/i.test(model) ? 1_000_000 : 200_000
  }
  return 1_000_000
}

function parseIsoMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : fallback
}

function parseGenericMetadata(content: string | undefined): {
  createdAt?: number
  completedAt?: number
  startedBgTaskId?: string
  cancelledBgTaskId?: string
} {
  if (!content) return {}
  const head = content.slice(0, METADATA_SCAN_LIMIT)
  const lines = head.split('\n').slice(0, 6)
  let createdAt: number | undefined
  let completedAt: number | undefined
  for (const line of lines) {
    if (line.startsWith('Created At:')) {
      const ms = Date.parse(line.slice('Created At:'.length).trim())
      if (Number.isFinite(ms)) createdAt = ms
    } else if (line.startsWith('Completed At:')) {
      const ms = Date.parse(line.slice('Completed At:'.length).trim())
      if (Number.isFinite(ms)) completedAt = ms
    }
  }
  const startedBgTaskId = /Tool is running as a background task with task id:\s*([a-zA-Z0-9_/-]+)/.exec(head)?.[1]
  const cancelledBgTaskId = /Task\s+"([a-zA-Z0-9_/-]+)"\s+cancelled\./.exec(head)?.[1]
  return {
    createdAt,
    completedAt,
    startedBgTaskId,
    cancelledBgTaskId,
  }
}

function parseToolCalls(raw: TranscriptStep['tool_calls']): RawToolCall[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

function appendEntry(board: Board, entry: Entry): Board {
  const entries = [...board.entries, entry].slice(-KEEP)
  const counts = { ...board.counts, [entry.station]: (board.counts[entry.station] ?? 0) + 1 }
  return { ...board, entries, counts }
}

function updateEntry(board: Board, id: string, patch: Partial<Entry>): Board {
  let found = false
  const entries = board.entries.map(e => {
    if (e.id !== id) return e
    found = true
    return { ...e, ...patch }
  })
  return found ? { ...board, entries } : board
}

export class TranscriptReducer {
  private _board: Board = { entries: [], counts: {} }
  private _setup: Setup
  private _costs: ReturnType<typeof stepCosts>
  private _pendingByOrigin = new Map<string, PendingCall[]>()
  private _stepEntryByOrigin = new Map<string, PendingCall>()
  private _bgTasks = new Map<string, string>()
  private _seq = 0
  private _sawFirstContext = false

  constructor(setup: Setup) {
    this._setup = setup
    this._costs = stepCosts(setup.contextCost)
  }

  get setup(): Setup {
    return this._setup
  }

  updateSetup(setup: Setup): void {
    const costToggled = setup.contextCost !== this._setup.contextCost
    this._setup = setup
    if (costToggled) {
      this._costs = stepCosts(setup.contextCost)
    }
  }

  reset(): void {
    this._board = { entries: [], counts: {} }
    this._costs = stepCosts(this._setup.contextCost)
    this._pendingByOrigin.clear()
    this._stepEntryByOrigin.clear()
    this._bgTasks.clear()
    this._seq = 0
    this._sawFirstContext = false
  }

  board(): Board {
    return this._board
  }

  private nextId(tag: string): string {
    this._seq += 1
    return `${tag}-${this._seq}`
  }

  private originKey(opts: OriginPushOptions): string {
    return opts.from === 'agents' ? `agent:${opts.agentId ?? 'sub'}` : 'core'
  }

  private clearStepKeysForOrigin(origin: string): void {
    const prefix = `${origin}:step:`
    for (const k of this._stepEntryByOrigin.keys()) {
      if (k.startsWith(prefix)) this._stepEntryByOrigin.delete(k)
    }
  }

  private settleOrphanedCore(endedAt: number): void {
    const activeBgEntryIds = new Set(this._bgTasks.values())
    let changed = false
    const entries = this._board.entries.map(e => {
      if (e.status === 'run' && e.from !== 'agents' && !activeBgEntryIds.has(e.id)) {
        changed = true
        return { ...e, status: 'ok' as const, endedAt: Math.max(e.startedAt, endedAt) }
      }
      return e
    })
    let agents = this._board.agents
    if (agents) {
      let agentsChanged = false
      const nextAgents = agents.map(a => {
        if (a.endedAt === undefined && !activeBgEntryIds.has(a.id)) {
          agentsChanged = true
          return { ...a, endedAt: Math.max(a.startedAt, endedAt) }
        }
        return a
      })
      if (agentsChanged) {
        agents = nextAgents
        changed = true
      }
    }
    if (changed) {
      this._board = { ...this._board, entries, ...(agents !== undefined ? { agents } : {}) }
    }
  }

  /**
   * Settles all remaining running entries and active subagents (used when Antigravity reports
   * the session is CASCADE_RUN_STATUS_IDLE and fully idle).
   */
  settleAllRunning(endedAt?: number): boolean {
    const ts = endedAt ?? Date.now()
    let changed = false
    const entries = this._board.entries.map(e => {
      if (e.status === 'run') {
        changed = true
        return { ...e, status: 'ok' as const, endedAt: Math.max(e.startedAt, ts) }
      }
      return e
    })
    let agents = this._board.agents
    if (agents) {
      let agentsChanged = false
      const nextAgents = agents.map(a => {
        if (a.endedAt === undefined) {
          agentsChanged = true
          return { ...a, endedAt: Math.max(a.startedAt, ts) }
        }
        return a
      })
      if (agentsChanged) {
        agents = nextAgents
        changed = true
      }
    }
    this._bgTasks.clear()
    this._pendingByOrigin.clear()
    this._stepEntryByOrigin.clear()
    if (changed) {
      this._board = { ...this._board, entries, ...(agents !== undefined ? { agents } : {}) }
    }
    return changed
  }

  push(step: TranscriptStep, opts: OriginPushOptions = {}): void {
    if (!step || typeof step !== 'object') return
    const origin = this.originKey(opts)
    const isSubagentStep = opts.from === 'agents'
    const fallbackNow = opts.now ?? Date.now()
    const stepTime = parseIsoMs(step.created_at, fallbackNow)
    const { t } = this._setup
    const stepType = step.type ?? ''
    const stepStatus = step.status ?? ''

    if (stepType === 'USER_INPUT') {
      this._pendingByOrigin.set('core', [])
      this.clearStepKeysForOrigin('core')
      this.settleOrphanedCore(stepTime)
      this._board = {
        ...appendEntry(this._board, {
          id: this.nextId('you'),
          station: 'you',
          label: t.newMessage,
          status: 'ok',
          from: 'inbound',
          startedAt: stepTime,
          endedAt: stepTime,
          stepIdx: step.step_index,
        }),
        faults: {},
      }
      return
    }

    if (stepType === 'CHECKPOINT') {
      if (!isSubagentStep) this._costs.compacted()
      const total = (step.input_tokens ?? 0) + (step.cache_read_tokens ?? 0)
      const pct =
        !isSubagentStep && total > 0
          ? Math.min(100, Math.round((total / contextWindowFor(this._board.model, this._setup.contextWindowTokens)) * 100))
          : this._board.context
      this._board = {
        ...appendEntry(this._board, {
          id: this.nextId('ckpt'),
          station: 'model',
          label: t.compacting,
          status: 'ok',
          from: isSubagentStep ? 'agents' : 'core',
          startedAt: stepTime,
          endedAt: stepTime,
          stepIdx: step.step_index,
        }),
        ...(pct !== undefined ? { context: pct } : {}),
      }
      return
    }

    if (stepType === 'SYSTEM_MESSAGE') {
      const head = typeof step.content === 'string' ? step.content.slice(0, METADATA_SCAN_LIMIT) : ''
      const senderTaskId = /sender=([a-zA-Z0-9_/-]+)/.exec(head)?.[1]
      if (senderTaskId && this._bgTasks.has(senderTaskId)) {
        const entryId = this._bgTasks.get(senderTaskId)!
        this._bgTasks.delete(senderTaskId)
        const failed = /\b(?:failed|exit(?:ed)? with code [1-9])\b/i.test(head)
        const existing = this._board.entries.find(e => e.id === entryId)
        const endedAt = Math.max(existing?.startedAt ?? stepTime, stepTime)
        const status = failed ? 'err' : 'ok'
        let faults = this._board.faults
        if (failed && existing) {
          faults = { ...faults, [existing.station]: (faults?.[existing.station] ?? 0) + 1 }
        }
        this._board = {
          ...updateEntry(this._board, entryId, { status, endedAt }),
          ...(faults !== undefined ? { faults } : {}),
        }
        return
      }

      this._board = appendEntry(this._board, {
        id: this.nextId('sys'),
        station: 'hooks',
        label: t.addedContext(t.toMessage),
        status: 'ok',
        from: 'inbound',
        startedAt: stepTime,
        endedAt: stepTime,
        stepIdx: step.step_index,
      })
      return
    }

    if (stepType === 'ERROR_MESSAGE') {
      const faults = { ...this._board.faults, model: (this._board.faults?.model ?? 0) + 1 }
      this._board = {
        ...appendEntry(this._board, {
          id: this.nextId('err'),
          station: 'model',
          label: 'error',
          status: 'err',
          from: isSubagentStep ? 'agents' : 'core',
          startedAt: stepTime,
          endedAt: stepTime,
          stepIdx: step.step_index,
        }),
        faults,
      }
      return
    }

    if (stepType === 'PLANNER_RESPONSE') {
      const model = typeof step.model === 'string' && step.model.trim() !== '' ? step.model.trim() : undefined
      const totalTokens = (step.input_tokens ?? 0) + (step.cache_read_tokens ?? 0)

      if (!isSubagentStep) {
        const answered = this._costs.stepStarted()
        const cost = this._costs.stepEnded(answered, totalTokens > 0 ? totalTokens : undefined)
        if (cost !== undefined) {
          this._board = charged(this._board, cost.calls, cost.before, cost.after)
        }

        if (model !== undefined) {
          if (this._board.model !== undefined && this._board.model !== model) {
            this._board = {
              ...appendEntry(this._board, {
                id: this.nextId('switch'),
                station: 'model',
                label: shortModel(model),
                status: 'ok',
                mark: 'switch',
                startedAt: stepTime,
                endedAt: stepTime,
                stepIdx: step.step_index,
              }),
              model,
              switchedAt: stepTime,
            }
          } else {
            this._board = { ...this._board, model }
          }
        }

        if (totalTokens > 0) {
          const cw = contextWindowFor(model ?? this._board.model, this._setup.contextWindowTokens)
          const pct = Math.min(100, Math.round((totalTokens / cw) * 100))
          this._board = { ...this._board, context: pct }
          this._sawFirstContext = true
        }
      }

      const calls = parseToolCalls(step.tool_calls)
      if (calls.length === 0) {
        if (!isSubagentStep && stepStatus === 'DONE') {
          this._costs.turnEnded()
          this._pendingByOrigin.set('core', [])
          this.settleOrphanedCore(stepTime)
          this._board = appendEntry(this._board, {
            id: this.nextId('done'),
            station: 'you',
            label: t.answerReady,
            status: 'ok',
            mark: 'done',
            startedAt: stepTime,
            endedAt: stepTime,
            stepIdx: step.step_index,
          })
        }
        return
      }

      const queue = this._pendingByOrigin.get(origin) ?? []
      for (const tc of calls) {
        const name = typeof tc.name === 'string' ? tc.name : 'tool'
        const args = tc.args && typeof tc.args === 'object' ? tc.args : {}
        const classified = classifyTool(name, args, this._setup)
        const id = this.nextId('call')
        const subName =
          isSubagentStep && this._setup.subagentNames && opts.subagentLabel
            ? clean(opts.subagentLabel, 40)
            : undefined
        const label = subName ? `${subName}: ${classified.label}` : classified.label

        this._board = appendEntry(this._board, {
          id,
          station: classified.station,
          label: clean(label),
          status: 'run',
          from: isSubagentStep ? 'agents' : 'core',
          startedAt: stepTime,
          agentId: opts.agentId,
          agentName: subName,
          toolName: name,
        })

        if (!isSubagentStep) {
          this._costs.called(id)
        }

        const isSubagentSpawn = name === 'invoke_subagent'
        const roleArg =
          typeof args.Role === 'string' || typeof args.TypeName === 'string'
            ? String(unwrapValue(args.Role) ?? unwrapValue(args.TypeName) ?? t.subagent)
            : t.subagent
        if (!isSubagentStep && isSubagentSpawn) {
          const agent: SubagentInfo = {
            id,
            label: clean(roleArg, 40),
            startedAt: stepTime,
          }
          const agents = [...(this._board.agents ?? []), agent].slice(-MAX_AGENTS)
          this._board = { ...this._board, agents }
        }

        queue.push({
          entryId: id,
          name,
          station: classified.station,
          startedAt: stepTime,
          isSubagent: isSubagentSpawn,
          subagentLabel: isSubagentSpawn ? clean(roleArg, 40) : undefined,
        })
      }
      this._pendingByOrigin.set(origin, queue)
      return
    }

    if (stepType === 'GENERIC') {
      const meta = parseGenericMetadata(step.content)
      if (meta.cancelledBgTaskId && this._bgTasks.has(meta.cancelledBgTaskId)) {
        const bgEntryId = this._bgTasks.get(meta.cancelledBgTaskId)!
        this._bgTasks.delete(meta.cancelledBgTaskId)
        const bgExisting = this._board.entries.find(e => e.id === bgEntryId)
        const bgEndedAt = meta.completedAt ?? Math.max(bgExisting?.startedAt ?? stepTime, stepTime)
        this._board = updateEntry(this._board, bgEntryId, { status: 'ok', endedAt: bgEndedAt })
      }

      const stepKey = step.step_index !== undefined ? `${origin}:step:${step.step_index}` : undefined
      let target = stepKey ? this._stepEntryByOrigin.get(stepKey) : undefined
      if (target === undefined) {
        const queue = this._pendingByOrigin.get(origin)
        target = queue?.shift()
        if (target !== undefined && stepKey !== undefined) {
          this._stepEntryByOrigin.set(stepKey, target)
        }
      }
      if (target === undefined) return

      const startedAt = meta.createdAt ?? target.startedAt
      const isErr = stepStatus === 'ERROR' || (typeof step.error === 'string' && step.error.trim() !== '')
      const isRunning = stepStatus === 'RUNNING' && !isErr

      if (isRunning) {
        if (meta.startedBgTaskId) {
          this._bgTasks.set(meta.startedBgTaskId, target.entryId)
        }
        this._board = updateEntry(this._board, target.entryId, {
          status: 'run',
          startedAt,
          endedAt: undefined,
          stepIdx: step.step_index,
        })
        return
      }

      if (stepKey !== undefined) {
        this._stepEntryByOrigin.delete(stepKey)
      }

      const endedAt = meta.completedAt ?? Math.max(startedAt, stepTime)
      const status = isErr ? 'err' : 'ok'
      let faults = this._board.faults
      if (isErr) {
        faults = { ...faults, [target.station]: (faults?.[target.station] ?? 0) + 1 }
      }
      let agents = this._board.agents
      if (target.isSubagent && agents) {
        agents = agents.map(a => (a.id === target!.entryId ? { ...a, endedAt } : a))
      }

      this._board = {
        ...updateEntry(this._board, target.entryId, {
          status,
          startedAt,
          endedAt,
          stepIdx: step.step_index,
        }),
        ...(faults !== undefined ? { faults } : {}),
        ...(agents !== undefined ? { agents } : {}),
      }
    }
  }

  hasContextReading(): boolean {
    return this._sawFirstContext
  }
}

export function reduceTranscript(
  steps: readonly TranscriptStep[],
  setup: Setup,
  opts: OriginPushOptions = {},
): Board {
  const reducer = new TranscriptReducer(setup)
  for (const step of steps) {
    reducer.push(step, opts)
  }
  return reducer.board()
}
