import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { reduceTranscript, TranscriptReducer } from '../src/core/reducer'
import { setupFrom } from '../src/core/setup'
import type { TranscriptStep } from '../src/core/types'

describe('TranscriptReducer', () => {
  it('replays Antigravity transcript lifecycle, context %, cost sharing, errors, model switch, and compaction', () => {
    const setup = setupFrom({ language: 'en', contextCost: true, subagentNames: true })
    const reducer = new TranscriptReducer(setup)

    const steps: TranscriptStep[] = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-21T12:00:00.000Z',
        content: 'Fix caching bug',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T12:00:01.000Z',
        model: 'gemini-4-neon-high',
        input_tokens: 100_000,
        cache_read_tokens: 100_000,
        tool_calls: [
          { name: 'read_file', args: { Path: '"/repo/src/a.ts"' } },
          { name: 'read_file', args: { Path: '"/repo/src/b.ts"' } },
        ],
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-21T12:00:01.500Z',
        content: 'Created At: 2026-11-21T15:00:01+03:00\nCompleted At: 2026-11-21T15:00:01.400+03:00\nok',
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'ERROR',
        error: 'ENOENT',
        created_at: '2026-11-21T12:00:01.600Z',
        content: 'Created At: 2026-11-21T15:00:01+03:00\nCompleted At: 2026-11-21T15:00:01.550+03:00\nerr',
      },
      {
        step_index: 4,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T12:00:02.000Z',
        model: 'gemini-4-argon-high',
        input_tokens: 120_000,
        cache_read_tokens: 120_000,
        tool_calls: [
          { name: 'run_command', args: { CommandLine: '"npm test"', toolSummary: '"Run unit tests"' } },
        ],
      },
      {
        step_index: 5,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-21T12:00:02.200Z',
        content: 'Created At: 2026-11-21T15:00:02+03:00\nTool running',
      },
    ]

    for (const s of steps) reducer.push(s)
    let board = reducer.board()

    assert.equal(board.model, 'gemini-4-argon-high')
    assert.equal(board.context, 24)
    assert.equal(board.counts.files, 2)
    assert.equal(board.faults?.files, 1)
    assert.ok(board.switchedAt !== undefined)
    assert.equal(board.spent?.files, 40_000)

    const runningCmd = board.entries.find(e => e.station === 'shell')
    assert.equal(runningCmd?.status, 'run')
    assert.equal(runningCmd?.label, 'Run unit tests')

    const fileEntries = board.entries.filter(e => e.station === 'files')
    assert.equal(fileEntries[0]?.tokens, 20_000)
    assert.equal(fileEntries[0]?.shared, true)
    assert.equal(fileEntries[1]?.status, 'err')

    // Update running step 5 to DONE and finish turn
    reducer.push({
      step_index: 5,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-21T12:00:04.000Z',
      content: 'Created At: 2026-11-21T15:00:02+03:00\nCompleted At: 2026-11-21T15:00:04+03:00\npassed',
    })
    reducer.push({
      step_index: 6,
      source: 'SYSTEM',
      type: 'CHECKPOINT',
      status: 'DONE',
      created_at: '2026-11-21T12:00:05.000Z',
      input_tokens: 20_000,
      cache_read_tokens: 80_000,
    })
    reducer.push({
      step_index: 7,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-21T12:00:06.000Z',
      model: 'gemini-4-argon-high',
      input_tokens: 25_000,
      cache_read_tokens: 80_000,
      tool_calls: [],
    })

    board = reducer.board()
    assert.equal(board.context, 11)
    assert.equal(board.entries.find(e => e.station === 'shell')?.status, 'ok')
    assert.ok(board.entries.some(e => e.mark === 'done' && e.label === 'answer ready'))
    assert.ok(board.entries.some(e => e.station === 'model' && e.label === 'compacting context'))
  })

  it('tracks subagent steps with from=agents and active orbiting agent dots', () => {
    const setup = setupFrom({ subagentNames: true })
    const reducer = new TranscriptReducer(setup)

    reducer.push({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-21T12:00:00Z',
      model: 'gemini-4-neon-high',
      tool_calls: [{ name: 'invoke_subagent', args: { TypeName: '"research"', Role: '"Auditor"', Prompt: '"check"' } }],
    })
    reducer.push({
      step_index: 2,
      type: 'GENERIC',
      status: 'RUNNING',
      created_at: '2026-11-21T12:00:01Z',
      content: 'Created At: 2026-11-21T12:00:01Z\nRunning',
    })
    reducer.push(
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T12:00:02Z',
        tool_calls: [{ name: 'read_file', args: { Path: '"/repo/src/x.ts"' } }],
      },
      { from: 'agents', subagentLabel: 'Auditor', agentId: 'sub-1' },
    )

    const board = reducer.board()
    assert.equal(board.agents?.length, 1)
    assert.equal(board.agents?.[0]?.endedAt, undefined)
    const subFile = board.entries.find(e => e.from === 'agents')
    assert.equal(subFile?.label, 'Auditor: src/x.ts')
    assert.equal(subFile?.station, 'files')

    reducer.push({
      step_index: 2,
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-21T12:00:05Z',
      content: 'Created At: 2026-11-21T12:00:01Z\nCompleted At: 2026-11-21T12:00:05Z\nDone',
    })
    assert.ok(reducer.board().agents?.[0]?.endedAt !== undefined)
  })

  it('caps kept entries at 80', () => {
    const setup = setupFrom()
    const steps: TranscriptStep[] = []
    for (let i = 0; i < 100; i++) {
      steps.push({
        step_index: i * 2 + 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T12:00:00Z',
        tool_calls: [{ name: 'read_file', args: { Path: `"/a/f${i}.ts"` } }],
      })
      steps.push({
        step_index: i * 2 + 2,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-21T12:00:01Z',
        content: 'Created At: 2026-11-21T12:00:00Z\nCompleted At: 2026-11-21T12:00:01Z\nok',
      })
    }
    const board = reduceTranscript(steps, setup)
    assert.equal(board.entries.length, 80)
    assert.equal(board.counts.files, 100)
  })

  it('settles background tasks on manage_task cancellation, SYSTEM_MESSAGE completion, and idle reconciliation', () => {
    const setup = setupFrom({ language: 'en' })
    const reducer = new TranscriptReducer(setup)

    // Launch two background tasks
    reducer.push({
      step_index: 10,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-21T12:00:00Z',
      model: 'gemini-4-neon-high',
      tool_calls: [
        { name: 'run_command', args: { CommandLine: '"make build"', toolSummary: '"Build task 1"' } },
        { name: 'run_command', args: { CommandLine: '"make install"', toolSummary: '"Install task 2"' } },
      ],
    })
    reducer.push({
      step_index: 11,
      type: 'GENERIC',
      status: 'RUNNING',
      created_at: '2026-11-21T12:00:01Z',
      content: 'Created At: 2026-11-21T12:00:01Z\nTool is running as a background task with task id: conv-1/task-11',
    })
    reducer.push({
      step_index: 12,
      type: 'GENERIC',
      status: 'RUNNING',
      created_at: '2026-11-21T12:00:02Z',
      content: 'Created At: 2026-11-21T12:00:02Z\nTool is running as a background task with task id: conv-1/task-12',
    })
    assert.equal(reducer.board().entries.filter(e => e.status === 'run').length, 2)

    // Cancel task-11 via manage_task
    reducer.push({
      step_index: 13,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-21T12:00:03Z',
      tool_calls: [{ name: 'manage_task', args: { Action: '"kill"', TaskId: '"conv-1/task-11"' } }],
    })
    reducer.push({
      step_index: 14,
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-21T12:00:04Z',
      content: 'Created At: 2026-11-21T12:00:03Z\nCompleted At: 2026-11-21T12:00:04Z\nTask "conv-1/task-11" cancelled.',
    })
    assert.equal(reducer.board().entries.filter(e => e.status === 'run').length, 1)

    // Complete task-12 via SYSTEM_MESSAGE notification
    reducer.push({
      step_index: 15,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: '2026-11-21T12:00:08Z',
      content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-21T12:00:08Z sender=conv-1/task-12 priority=HIGH content=Task id "conv-1/task-12" finished with exit code 0',
    })
    assert.equal(reducer.board().entries.filter(e => e.status === 'run').length, 0)

    // Orphaned non-background running call settled on next USER_INPUT
    reducer.push({
      step_index: 16,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-21T12:00:09Z',
      tool_calls: [{ name: 'read_file', args: { Path: '"/repo/a.ts"' } }],
    })
    assert.equal(reducer.board().entries.filter(e => e.status === 'run').length, 1)
    reducer.push({
      step_index: 17,
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-21T12:00:10Z',
      content: 'Next prompt',
    })
    assert.equal(reducer.board().entries.filter(e => e.status === 'run').length, 0)

    // settleAllRunning clears any remaining running state for idle sessions
    reducer.push({
      step_index: 18,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-21T12:00:11Z',
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 10"' } }],
    })
    assert.equal(reducer.settleAllRunning(Date.parse('2026-11-21T12:00:12Z')), true)
    assert.equal(reducer.board().entries.filter(e => e.status === 'run').length, 0)
  })

  it('records bounded modelSteps telemetry including cache hit % and checkpoints', () => {
    const setup = setupFrom({ language: 'en', detailLevel: 'verbose' })
    const steps: TranscriptStep[] = []
    for (let i = 0; i < 65; i++) {
      steps.push({
        step_index: i + 1,
        type: i === 64 ? 'CHECKPOINT' : 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(1_763_720_000_000 + i * 1000).toISOString(),
        model: 'gemini-4-neon-high',
        input_tokens: 10_000,
        cache_read_tokens: 40_000,
        output_tokens: 250,
        tool_calls: i === 64 ? undefined : [],
      })
    }
    const board = reduceTranscript(steps, setup)
    assert.equal(board.modelSteps?.length, 60)
    const last = board.modelSteps?.[59]
    assert.equal(last?.isCompaction, true)
    assert.equal(last?.totalContextTokens, 50_000)
    assert.equal(last?.cacheHitPct, 80)
  })
})
