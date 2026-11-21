import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { describe, it } from 'node:test'
import { drawMap } from '../src/core/draw'
import { foldRows } from '../src/core/feed'
import { TranscriptReducer } from '../src/core/reducer'
import { sliceBoardAt, turnIndices } from '../src/core/replay'
import { setupFrom } from '../src/core/setup'
import type { Board, Entry, SubagentInfo } from '../src/core/types'

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

describe('time-travel replay', () => {
  const t0 = 1_763_720_000_000

  function makeRichBoard(): Board {
    const entries: Entry[] = [
      // 1: Turn 1
      {
        id: 'you-1',
        station: 'you',
        label: 'new message',
        status: 'ok',
        from: 'inbound',
        startedAt: t0,
        endedAt: t0,
      },
      // 2: Fast read
      {
        id: 'call-2',
        station: 'files',
        label: 'src/a.ts',
        status: 'ok',
        from: 'core',
        startedAt: t0 + 400,
        endedAt: t0 + 500,
        tokens: 2000,
      },
      // 3: Long-running shell error (takes 1000ms -> running at t0+950, failed by t0+1700)
      {
        id: 'call-3',
        station: 'shell',
        label: 'npm test',
        status: 'err',
        from: 'core',
        startedAt: t0 + 700,
        endedAt: t0 + 1700,
        tokens: 1500,
      },
      // 4: Subagent spawn
      {
        id: 'call-4',
        station: 'agents',
        label: 'Auditor',
        status: 'ok',
        from: 'core',
        startedAt: t0 + 1800,
        endedAt: t0 + 3500,
        tokens: 1000,
      },
      // 5: Hook inbound message (NOT a user turn)
      {
        id: 'sys-5',
        station: 'hooks',
        label: 'added context to message',
        status: 'ok',
        from: 'inbound',
        startedAt: t0 + 2000,
        endedAt: t0 + 2500,
      },
      // 6: Model switch 1
      {
        id: 'sw-6',
        station: 'model',
        label: 'argon-high',
        status: 'ok',
        mark: 'switch',
        startedAt: t0 + 2600,
        endedAt: t0 + 2600,
      },
      // 7: Ask question (station 'you', from 'core', NOT a user turn)
      {
        id: 'call-7',
        station: 'you',
        label: 'question for you',
        status: 'ok',
        from: 'core',
        startedAt: t0 + 2700,
        endedAt: t0 + 2800,
      },
      // 8: Answer ready (station 'you', mark 'done', NOT a user turn)
      {
        id: 'done-8',
        station: 'you',
        label: 'answer ready',
        status: 'ok',
        mark: 'done',
        startedAt: t0 + 3000,
        endedAt: t0 + 3000,
      },
      // 9: Turn 2 (resets faults)
      {
        id: 'you-9',
        station: 'you',
        label: 'new message',
        status: 'ok',
        from: 'inbound',
        startedAt: t0 + 4000,
        endedAt: t0 + 4000,
      },
      // 10: Model switch 2
      {
        id: 'sw-10',
        station: 'model',
        label: 'sonnet 4.5',
        status: 'ok',
        mark: 'switch',
        startedAt: t0 + 4200,
        endedAt: t0 + 4200,
      },
      // 11: Web error in Turn 2
      {
        id: 'call-11',
        station: 'web',
        label: 'docs.example.dev',
        status: 'err',
        from: 'core',
        startedAt: t0 + 4500,
        endedAt: t0 + 4600,
        tokens: 800,
      },
    ]

    const agents: SubagentInfo[] = [
      { id: 'call-4', label: 'Auditor', startedAt: t0 + 1800, endedAt: t0 + 3500 },
      { id: 'call-future', label: 'Deployer', startedAt: t0 + 4100 },
    ]

    return {
      entries,
      counts: { you: 4, files: 1, shell: 1, agents: 1, hooks: 1, model: 2, web: 1 },
      faults: { web: 1 },
      spent: { files: 2000, shell: 1500, agents: 1000, web: 800 },
      context: 68,
      model: 'claude-sonnet-4-5',
      switchedAt: t0 + 4200,
      agents,
    }
  }

  it('turnIndices returns 1-based cursor positions only for inbound user turns without mark', () => {
    const board = makeRichBoard()
    assert.deepEqual(turnIndices(board.entries), [1, 9])
    assert.deepEqual(turnIndices([]), [])
  })

  it('returns live mode when index is undefined, >= total, or NaN', () => {
    const board = makeRichBoard()
    const total = board.entries.length

    const liveUndef = sliceBoardAt(board, undefined, t0 + 9000)
    assert.equal(liveUndef.board, board)
    assert.deepEqual(liveUndef.cursor, {
      index: total,
      total,
      isLive: true,
      renderNow: t0 + 9000,
      currentEntry: board.entries[total - 1],
      turnNumber: 2,
      totalTurns: 2,
    })

    const liveExact = sliceBoardAt(board, total, t0 + 9500)
    assert.equal(liveExact.board, board)
    assert.equal(liveExact.cursor.isLive, true)
    assert.equal(liveExact.cursor.index, total)
    assert.equal(liveExact.cursor.renderNow, t0 + 9500)

    const liveBeyond = sliceBoardAt(board, total + 42, t0 + 9600)
    assert.equal(liveBeyond.cursor.isLive, true)
    assert.equal(liveBeyond.cursor.index, total)

    const liveNaN = sliceBoardAt(board, Number.NaN, t0 + 9700)
    assert.equal(liveNaN.cursor.isLive, true)
    assert.equal(liveNaN.cursor.index, total)

    const emptyLive = sliceBoardAt({ entries: [], counts: {} }, undefined, t0)
    assert.equal(emptyLive.cursor.isLive, true)
    assert.equal(emptyLive.cursor.index, 0)
    assert.equal(emptyLive.cursor.total, 0)
    assert.equal(emptyLive.cursor.currentEntry, undefined)
    assert.equal(emptyLive.cursor.turnNumber, 0)
    assert.equal(emptyLive.cursor.totalTurns, 0)
  })

  it('returns empty historical board at step 0 (and negative indices clamped to 0)', () => {
    const board = makeRichBoard()

    for (const idx of [0, -5, -0.2]) {
      const frame = sliceBoardAt(board, idx, t0 + 9000)
      assert.deepEqual(frame.board, { entries: [], counts: {} })
      assert.equal(frame.cursor.index, 0)
      assert.equal(frame.cursor.total, board.entries.length)
      assert.equal(frame.cursor.isLive, false)
      assert.equal(frame.cursor.renderNow, t0 - 100)
      assert.equal(frame.cursor.currentEntry, undefined)
      assert.equal(frame.cursor.turnNumber, 0)
      assert.equal(frame.cursor.totalTurns, 2)
    }

    const emptyHistorical = sliceBoardAt({ entries: [], counts: {} }, -1, t0 + 500)
    assert.deepEqual(emptyHistorical.board, { entries: [], counts: {} })
    assert.equal(emptyHistorical.cursor.isLive, false)
    assert.equal(emptyHistorical.cursor.renderNow, t0 + 400)
  })

  it('computes intermediate historical frames with in-flight entries, counts, spent, faults, model, and agents', () => {
    const board = makeRichBoard()

    // Step 3: call-3 started at t0+700, endedAt t0+1700, status 'err'.
    // renderNow = t0 + 950 -> call-3 is still in-flight ('run'), no shell fault yet!
    const f3 = sliceBoardAt(board, 3.8) // also verifies floor clamping to 3
    assert.equal(f3.cursor.index, 3)
    assert.equal(f3.cursor.isLive, false)
    assert.equal(f3.cursor.renderNow, t0 + 700 + 250)
    assert.equal(f3.cursor.currentEntry, board.entries[2])
    assert.equal(f3.cursor.turnNumber, 1)
    assert.equal(f3.cursor.totalTurns, 2)
    assert.equal(f3.board.entries.length, 3)
    assert.equal(f3.board.entries[1]?.status, 'ok')
    assert.equal(f3.board.entries[2]?.status, 'run')
    assert.equal(f3.board.entries[2]?.endedAt, undefined)
    assert.deepEqual(f3.board.counts, { you: 1, files: 1, shell: 1 })
    assert.deepEqual(f3.board.spent, { files: 2000, shell: 1500 })
    assert.deepEqual(f3.board.faults, {})
    // Future switch exists -> do not show future model!
    assert.equal(f3.board.model, undefined)
    assert.equal(f3.board.switchedAt, undefined)
    assert.deepEqual(f3.board.agents, [])

    // Step 4: call-4 started at t0+1800 -> renderNow = t0+2050.
    // Now call-3 (endedAt t0+1700 <= t0+2050) has settled as 'err' and faults.shell === 1!
    // Agent 'Auditor' started at t0+1800 and ends at t0+3500 -> active (endedAt cleared)!
    // Future agent 'Deployer' (startedAt t0+4100) is excluded.
    const f4 = sliceBoardAt(board, 4)
    assert.equal(f4.cursor.renderNow, t0 + 2050)
    assert.equal(f4.board.entries[2]?.status, 'err')
    assert.equal(f4.board.entries[2]?.endedAt, t0 + 1700)
    assert.equal(f4.board.entries[3]?.status, 'run')
    assert.equal(f4.board.entries[3]?.endedAt, undefined)
    assert.deepEqual(f4.board.faults, { shell: 1 })
    assert.deepEqual(f4.board.agents, [{ id: 'call-4', label: 'Auditor', startedAt: t0 + 1800 }])

    // Step 5: sys-5 is inbound hook with endedAt t0+2500 > renderNow (t0+2250).
    // Inbound entries must NOT be reverted to 'run'.
    const f5 = sliceBoardAt(board, 5)
    assert.equal(f5.board.entries[4]?.status, 'ok')
    assert.equal(f5.board.entries[4]?.endedAt, t0 + 2500)

    // Step 6: sw-6 is switch 1 at t0+2600, with another switch later at step 10 -> uses sw-6 label.
    const f6 = sliceBoardAt(board, 6)
    assert.equal(f6.board.model, 'argon-high')
    assert.equal(f6.board.switchedAt, t0 + 2600)

    // Step 8: mark 'done' at t0+3000 -> renderNow = t0+3250, marks must NOT revert to 'run', Auditor still active.
    const f8 = sliceBoardAt(board, 8)
    assert.equal(f8.board.entries[7]?.status, 'ok')
    assert.equal(f8.board.entries[7]?.mark, 'done')
    assert.equal(f8.board.faults?.shell, 1)
    assert.equal(f8.board.agents?.[0]?.endedAt, undefined)

    // Step 9: Turn 2 starts at t0+4000 -> renderNow = t0+4250.
    // Faults reset on inbound 'you' turn; Auditor (endedAt t0+3500) is now ended; Deployer (startedAt t0+4100 <= 4250) is active!
    const f9 = sliceBoardAt(board, 9)
    assert.equal(f9.cursor.turnNumber, 2)
    assert.deepEqual(f9.board.faults, {})
    assert.deepEqual(f9.board.agents, [
      { id: 'call-4', label: 'Auditor', startedAt: t0 + 1800, endedAt: t0 + 3500 },
      { id: 'call-future', label: 'Deployer', startedAt: t0 + 4100 },
    ])

    // Step 10: sw-10 (no later switches) -> resolves to board.model ('claude-sonnet-4-5') and switchedAt t0+4200.
    const f10 = sliceBoardAt(board, 10)
    assert.equal(f10.board.model, 'claude-sonnet-4-5')
    assert.equal(f10.board.switchedAt, t0 + 4200)
  })

  it('keeps board.model when there are no model switches anywhere in the session', () => {
    const setup = setupFrom({ language: 'en', contextCost: true })
    const reducer = new TranscriptReducer(setup)
    reducer.push({
      step_index: 0,
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-21T12:00:00.000Z',
    })
    reducer.push({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-21T12:00:01.000Z',
      model: 'gemini-4-neon-high',
      input_tokens: 10_000,
      tool_calls: [{ name: 'read_file', args: { Path: '"/repo/a.ts"' } }],
    })
    reducer.push({
      step_index: 2,
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-21T12:00:02.000Z',
      content: 'Created At: 2026-11-21T12:00:01.000Z\nCompleted At: 2026-11-21T12:00:01.600Z\nok',
    })
    reducer.push({
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-21T12:00:03.000Z',
      model: 'gemini-4-neon-high',
      input_tokens: 12_000,
      tool_calls: [],
    })

    const board = reducer.board()
    const frame = sliceBoardAt(board, 1)
    assert.equal(frame.board.model, 'gemini-4-neon-high')
    assert.equal(frame.board.switchedAt, undefined)

    const frame2 = sliceBoardAt(board, 2)
    assert.equal(frame2.board.entries[1]?.status, 'run')
    const svg = drawMap(frame2.board, frame2.cursor.renderNow, setup)
    assert.ok(svg.includes('<animateMotion'))
    const rows = foldRows(frame2.board.entries, 16, true)
    assert.equal(rows[0]?.entry.status, 'run')
  })

  it('never mutates frozen input board across step 0, intermediate steps, and live mode', () => {
    const board = deepFreeze(makeRichBoard())
    const snapshot = JSON.stringify(board)

    assert.deepEqual(turnIndices(board.entries), [1, 9])

    for (let idx = 0; idx <= board.entries.length + 1; idx++) {
      const frame = sliceBoardAt(board, idx, t0 + 10_000)
      assert.equal(JSON.stringify(board), snapshot)
      // Mutating returned historical frame must not throw or touch input
      if (!frame.cursor.isLive) {
        frame.board.entries.push({
          id: 'mut',
          station: 'web',
          label: 'mut',
          status: 'ok',
          startedAt: t0,
        })
        frame.board.counts.web = 999
      }
      assert.equal(JSON.stringify(board), snapshot)
    }

    sliceBoardAt(board, undefined, t0 + 10_000)
    assert.equal(JSON.stringify(board), snapshot)
  })

  it('slices an 80-entry board in under 1 ms', () => {
    const entries: Entry[] = Array.from({ length: 80 }, (_, i) => ({
      id: `e-${i}`,
      station: i % 20 === 0 ? 'you' : (['files', 'shell', 'web', 'memory'] as const)[i % 4]!,
      label: `item-${i}`,
      status: i % 15 === 0 && i % 20 !== 0 ? 'err' : 'ok',
      from: i % 20 === 0 ? 'inbound' : 'core',
      startedAt: t0 + i * 100,
      endedAt: t0 + i * 100 + (i % 3 === 0 ? 400 : 80),
      tokens: 500,
    }))
    const heavyBoard: Board = {
      entries,
      counts: { you: 4, files: 19, shell: 19, web: 19, memory: 19 },
      faults: { files: 1 },
      spent: { files: 9500, shell: 9500, web: 9500, memory: 9500 },
      model: 'gemini-4-neon-high',
      agents: Array.from({ length: 6 }, (_, i) => ({
        id: `a-${i}`,
        label: `Agent ${i}`,
        startedAt: t0 + i * 1000,
        endedAt: t0 + i * 1000 + 2500,
      })),
    }

    // Warmup JIT
    for (let i = 0; i < 20; i++) sliceBoardAt(heavyBoard, 40)

    const start = performance.now()
    const frame = sliceBoardAt(heavyBoard, 40)
    const elapsedMs = performance.now() - start

    assert.equal(frame.board.entries.length, 40)
    assert.ok(elapsedMs < 1, `sliceBoardAt(80 entries) took ${elapsedMs.toFixed(3)} ms`)
  })

  it('Principle 2: never exposes raw canary secrets in sliced replay frames', () => {
    const CANARY = 'CANARY_REPLAY_SECRET'
    const board: Board = {
      entries: [
        { id: '1', station: 'files', label: 'src/a.ts', status: 'ok', from: 'core', startedAt: t0, endedAt: t0 + 10 },
        { id: '2', station: 'web', label: 'web search', status: 'ok', from: 'core', startedAt: t0 + 20, endedAt: t0 + 50 },
      ],
      counts: { files: 1, web: 1 },
      model: 'gemini-4-neon-high',
    }
    const frame = sliceBoardAt(board, 1)
    assert.ok(!JSON.stringify(frame).includes(CANARY))
    assert.equal(frame.board.entries.length, 1)
  })
})
