import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { describe, it } from 'node:test'
import { computeBreakdown } from '../src/core/breakdown'
import { reduceTranscript } from '../src/core/reducer'
import { setupFrom } from '../src/core/setup'
import type { Board, Entry, TranscriptStep } from '../src/core/types'

const CANARY = 'CANARY_SECRET_999'

describe('computeBreakdown', () => {
  it('handles an empty board and zero totals safely without division errors', () => {
    const setup = setupFrom({ language: 'en' })
    const empty: Board = { entries: [], counts: {} }
    assert.deepEqual(computeBreakdown(empty, setup), {
      shares: [],
      turns: 0,
      totalCalls: 0,
      totalTimeMs: 0,
      totalTokens: 0,
      faultCount: 0,
    })

    // Zero timeMs & zero tokens even when counts exist (e.g. only running entries)
    const zeroTotals: Board = {
      entries: [
        { id: 'r1', station: 'shell', label: 'npm test', status: 'run', from: 'core', startedAt: 5000 },
        { id: 'r2', station: 'files', label: 'a.ts', status: 'ok', from: 'core', startedAt: 5100, endedAt: 5050 },
      ],
      counts: { shell: 1, files: 1 },
    }
    const res = computeBreakdown(zeroTotals, setup)
    assert.equal(res.totalTimeMs, 0)
    assert.equal(res.totalTokens, 0)
    assert.equal(res.totalCalls, 2)
    assert.equal(res.turns, 0)
    assert.equal(res.lastTurnMs, undefined)
    assert.deepEqual(res.shares, [
      { station: 'files', stationName: 'Files', count: 1, timeMs: 0, timePct: 0, tokens: 0, tokenPct: 0 },
      { station: 'shell', stationName: 'Shell', count: 1, timeMs: 0, timePct: 0, tokens: 0, tokenPct: 0 },
    ])
  })

  it('safely handles empty board.counts when board.entries has timed entries', () => {
    const setup = setupFrom({ language: 'en' })
    const board: Board = {
      entries: [
        { id: 'u1', station: 'you', label: 'new message', status: 'ok', from: 'inbound', startedAt: 1000, endedAt: 1000 },
        { id: 'f1', station: 'files', label: 'a.ts', status: 'ok', from: 'core', startedAt: 1100, endedAt: 1400 },
      ],
      counts: {},
    }
    const res = computeBreakdown(board, setup)
    assert.equal(res.turns, 1)
    assert.equal(res.totalCalls, 0)
    assert.equal(res.totalTimeMs, 300)
    assert.equal(res.lastTurnMs, 400)
    assert.deepEqual(res.shares, [
      { station: 'files', stationName: 'Files', count: 0, timeMs: 300, timePct: 100, tokens: 0, tokenPct: 0 },
    ])
  })

  it('counts turns accurately and computes lastTurnMs across completed and active turns', () => {
    const setup = setupFrom({ language: 'en' })

    // Completed second turn with done mark; excludes inbound hooks, switch mark, and core 'you' calls
    const completedBoard: Board = {
      entries: [
        { id: 'u1', station: 'you', label: 'new message', status: 'ok', from: 'inbound', startedAt: 1000, endedAt: 1000 },
        { id: 'f1', station: 'files', label: 'a.ts', status: 'ok', from: 'core', startedAt: 1100, endedAt: 1300 },
        { id: 'd1', station: 'you', label: 'answer ready', status: 'ok', mark: 'done', startedAt: 1500, endedAt: 1500 },
        { id: 'u2', station: 'you', label: 'new message', status: 'ok', from: 'inbound', startedAt: 2000, endedAt: 2000 },
        { id: 'h1', station: 'hooks', label: 'added context', status: 'ok', from: 'inbound', startedAt: 2050, endedAt: 2050 },
        { id: 'sw', station: 'model', label: 'argon', status: 'ok', mark: 'switch', startedAt: 2100, endedAt: 2100 },
        { id: 'q1', station: 'you', label: 'question for you', status: 'ok', from: 'core', startedAt: 2150, endedAt: 2450 },
        { id: 's1', station: 'shell', label: 'npm test', status: 'ok', from: 'agents', startedAt: 2500, endedAt: 3000 },
        { id: 'd2', station: 'you', label: 'answer ready', status: 'ok', mark: 'done', startedAt: 3250, endedAt: 3250 },
      ],
      counts: { you: 5, hooks: 1, model: 1, shell: 1, files: 1 },
    }
    const doneRes = computeBreakdown(completedBoard, setup)
    assert.equal(doneRes.turns, 2)
    assert.equal(doneRes.lastTurnMs, 1250)
    // Inbound (u1, u2, h1) and marks (d1, sw, d2) are excluded from timeMs
    assert.equal(doneRes.totalTimeMs, 200 + 300 + 500)

    // In-progress turn without mark === 'done': measures to latest endedAt ?? startedAt after last turn
    const activeBoard: Board = {
      entries: [
        { id: 'u1', station: 'you', label: 'new message', status: 'ok', from: 'inbound', startedAt: 1000, endedAt: 1000 },
        { id: 'd1', station: 'you', label: 'answer ready', status: 'ok', mark: 'done', startedAt: 1500, endedAt: 1500 },
        { id: 'u2', station: 'you', label: 'new message', status: 'ok', from: 'inbound', startedAt: 4000, endedAt: 4000 },
        { id: 'f2', station: 'files', label: 'b.ts', status: 'ok', from: 'core', startedAt: 4100, endedAt: 4650 },
        { id: 'r1', station: 'shell', label: 'vitest', status: 'run', from: 'core', startedAt: 4900 },
      ],
      counts: { you: 3, files: 1, shell: 1 },
    }
    const activeRes = computeBreakdown(activeBoard, setup)
    assert.equal(activeRes.turns, 2)
    assert.equal(activeRes.lastTurnMs, 900)
    assert.equal(activeRes.totalTimeMs, 550)

    // Zero or negative delta -> lastTurnMs remains undefined
    const zeroDeltaBoard: Board = {
      entries: [
        { id: 'u1', station: 'you', label: 'new message', status: 'ok', from: 'inbound', startedAt: 5000, endedAt: 5000 },
        { id: 'f1', station: 'files', label: 'c.ts', status: 'ok', from: 'core', startedAt: 5000, endedAt: 5000 },
      ],
      counts: { you: 1, files: 1 },
    }
    assert.equal(computeBreakdown(zeroDeltaBoard, setup).lastTurnMs, undefined)

    const tailTurnBoard: Board = {
      entries: [
        { id: 'u1', station: 'you', label: 'new message', status: 'ok', from: 'inbound', startedAt: 6000, endedAt: 6000 },
      ],
      counts: { you: 1 },
    }
    assert.equal(computeBreakdown(tailTurnBoard, setup).lastTurnMs, undefined)
  })

  it('computes percentages, rounding, faults, filtering, localization, and tie-break sorting', () => {
    const setup = setupFrom({ language: 'ru' })
    const board: Board = {
      entries: [
        { id: 'u1', station: 'you', label: 'new message', status: 'ok', from: 'inbound', startedAt: 1000, endedAt: 1000 },
        // shell: 200ms
        { id: 's1', station: 'shell', label: 'npm test', status: 'ok', from: 'core', startedAt: 1100, endedAt: 1300 },
        // files: 100ms
        { id: 'f1', station: 'files', label: 'a.ts', status: 'err', from: 'core', startedAt: 1350, endedAt: 1450 },
        // web: 0ms (running), but has tokens and count
        { id: 'w1', station: 'web', label: 'search', status: 'run', from: 'core', startedAt: 1500 },
        // memory: 0ms, 0 tokens, count 2 (for tie-break testing against agents)
      ],
      counts: { you: 1, shell: 1, files: 3, web: 1, memory: 2, agents: 5 },
      spent: { shell: 1000.4, files: 2000.6, web: 1000, memory: 500, agents: 500, hooks: -10 },
      faults: { files: 2, shell: 1 },
    }

    const res = computeBreakdown(board, setup)
    assert.equal(res.turns, 1)
    assert.equal(res.totalCalls, 13)
    assert.equal(res.totalTimeMs, 300)
    // rounded tokens: shell=1000, files=2001, web=1000, memory=500, agents=500, hooks=0 -> total=5001
    assert.equal(res.totalTokens, 5001)
    assert.equal(res.faultCount, 3)

    // Expected sort order:
    // 1. shell (timeMs: 200)
    // 2. files (timeMs: 100)
    // 3. web (timeMs: 0, tokens: 1000)
    // 4. agents (timeMs: 0, tokens: 500, count: 5)
    // 5. memory (timeMs: 0, tokens: 500, count: 2)
    // 6. you (timeMs: 0, tokens: 0, count: 1)
    // Filtered out: model, browser, skills, hooks (negative tokens clamped to 0, count 0, timeMs 0)
    assert.deepEqual(res.shares, [
      {
        station: 'shell',
        stationName: setup.t.stations.shell,
        count: 1,
        timeMs: 200,
        timePct: 66.7,
        tokens: 1000,
        tokenPct: 20,
      },
      {
        station: 'files',
        stationName: setup.t.stations.files,
        count: 3,
        timeMs: 100,
        timePct: 33.3,
        tokens: 2001,
        tokenPct: 40,
      },
      {
        station: 'web',
        stationName: setup.t.stations.web,
        count: 1,
        timeMs: 0,
        timePct: 0,
        tokens: 1000,
        tokenPct: 20,
      },
      {
        station: 'agents',
        stationName: setup.t.stations.agents,
        count: 5,
        timeMs: 0,
        timePct: 0,
        tokens: 500,
        tokenPct: 10,
      },
      {
        station: 'memory',
        stationName: setup.t.stations.memory,
        count: 2,
        timeMs: 0,
        timePct: 0,
        tokens: 500,
        tokenPct: 10,
      },
      {
        station: 'you',
        stationName: setup.t.stations.you,
        count: 1,
        timeMs: 0,
        timePct: 0,
        tokens: 0,
        tokenPct: 0,
      },
    ])
  })

  it('never mutates frozen input board or nested structures', () => {
    const setup = setupFrom({ language: 'en' })
    const entries: Entry[] = [
      Object.freeze({ id: 'u1', station: 'you', label: 'new message', status: 'ok', from: 'inbound', startedAt: 100, endedAt: 100 }),
      Object.freeze({ id: 'f1', station: 'files', label: 'a.ts', status: 'ok', from: 'core', startedAt: 150, endedAt: 350, tokens: 1200 }),
      Object.freeze({ id: 's1', station: 'shell', label: 'ls', status: 'run', from: 'core', startedAt: 400 }),
    ]
    const board: Board = Object.freeze({
      entries: Object.freeze(entries) as unknown as Entry[],
      counts: Object.freeze({ you: 1, files: 1, shell: 1 }),
      faults: Object.freeze({ files: 0 }),
      spent: Object.freeze({ files: 1200 }),
      agents: Object.freeze([Object.freeze({ id: 'a1', label: 'Worker', startedAt: 200 })]) as unknown as Board['agents'],
      model: 'gemini-4-neon-high',
      context: 12,
    })

    const snapshot = JSON.stringify(board)
    const breakdown = computeBreakdown(board, setup)
    assert.equal(JSON.stringify(board), snapshot)
    assert.equal(breakdown.totalTimeMs, 200)
    assert.equal(breakdown.lastTurnMs, 300)
  })

  it('completes within strict < 1 ms budget on 80 entries', () => {
    const setup = setupFrom({ language: 'en' })
    const now = 1_763_720_010_000
    const entries: Entry[] = [
      { id: 'u-0', station: 'you', label: 'new message', status: 'ok', from: 'inbound', startedAt: now - 10_000, endedAt: now - 10_000 },
      ...Array.from({ length: 78 }, (_, i) => ({
        id: `e-${i}`,
        station: (['files', 'shell', 'web', 'memory', 'agents', 'skills', 'browser', 'you'] as const)[i % 8]!,
        label: `item-${i}`,
        status: (i >= 74 ? 'run' : 'ok') as Entry['status'],
        startedAt: now - (80 - i) * 100,
        endedAt: i >= 74 ? undefined : now - (80 - i) * 100 + 45,
        from: (i % 5 === 0 ? 'agents' : 'core') as Entry['from'],
        tokens: 800,
      })),
      { id: 'd-0', station: 'you', label: 'answer ready', status: 'ok', mark: 'done', startedAt: now, endedAt: now },
    ]
    assert.equal(entries.length, 80)

    const heavyBoard: Board = {
      entries,
      counts: { you: 11, files: 10, shell: 10, web: 10, memory: 10, agents: 10, skills: 10, browser: 9 },
      spent: { files: 16000, shell: 12000, web: 8000, agents: 4000 },
      faults: { shell: 1 },
    }

    computeBreakdown(heavyBoard, setup)
    const t0 = performance.now()
    const out = computeBreakdown(heavyBoard, setup)
    const elapsedMs = performance.now() - t0

    assert.equal(out.turns, 1)
    assert.equal(out.lastTurnMs, 10_000)
    assert.ok(elapsedMs < 1, `computeBreakdown(80 entries) took ${elapsedMs.toFixed(3)} ms`)
  })

  it('Principle 2: CANARY_SECRET_999 never leaks into breakdown output', () => {
    const setup = setupFrom({ language: 'en', contextCost: true, subagentNames: true })
    const steps: TranscriptStep[] = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-21T12:00:00.000Z',
        content: CANARY,
      },
      {
        step_index: 1,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-21T12:00:00.500Z',
        content: CANARY,
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T12:00:01.000Z',
        model: `gemini-${CANARY}`,
        input_tokens: 40_000,
        cache_read_tokens: 10_000,
        thinking: CANARY,
        tool_calls: [
          { name: 'read_file', args: { Path: `/secret/${CANARY}/app.ts` } },
          { name: 'run_command', args: { CommandLine: `TOKEN=${CANARY} npm test` } },
        ],
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-21T12:00:01.400Z',
        content: `Created At: 2026-11-21T12:00:01.000Z\nCompleted At: 2026-11-21T12:00:01.250Z\n${CANARY}`,
      },
      {
        step_index: 4,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'ERROR',
        error: CANARY,
        created_at: '2026-11-21T12:00:01.800Z',
        content: `Created At: 2026-11-21T12:00:01.000Z\nCompleted At: 2026-11-21T12:00:01.700Z\n${CANARY}`,
      },
      {
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T12:00:02.500Z',
        model: `gemini-${CANARY}`,
        input_tokens: 55_000,
        cache_read_tokens: 15_000,
        tool_calls: [],
      },
    ]

    const board = reduceTranscript(steps, setup)
    const breakdown = computeBreakdown(board, setup)
    assert.ok(!JSON.stringify(breakdown).includes(CANARY), 'Breakdown leaked canary')
    assert.equal(breakdown.turns, 1)
    assert.equal(breakdown.lastTurnMs, 2500)
    assert.equal(breakdown.totalTimeMs, 250 + 700)
    assert.equal(breakdown.faultCount, 1)
    assert.equal(breakdown.totalTokens, 20_000)
  })
})
