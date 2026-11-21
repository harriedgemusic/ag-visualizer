import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { describe, it } from 'node:test'
import { DARK } from '../src/core/palette'
import { setupFrom } from '../src/core/setup'
import { computeTokenStats, computeTurnSummaries, drawContextSparkline } from '../src/core/telemetry'
import type { Board, Entry, ModelStepTelemetry } from '../src/core/types'

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

describe('Telemetry: Turn Summaries, Token Stats & Sparkline', () => {
  const t0 = 1_763_720_000_000

  it('handles empty boards safely for turns, tokens, and sparkline', () => {
    const setup = setupFrom({ language: 'en' })
    const empty: Board = { entries: [], counts: {} }

    assert.deepEqual(computeTurnSummaries(empty, setup), [])
    const stats = computeTokenStats(empty)
    assert.deepEqual(stats, {
      steps: 0,
      latestInput: 0,
      latestCacheRead: 0,
      latestOutput: 0,
      latestTotalContext: 0,
      latestCacheHitPct: 0,
      totalInput: 0,
      totalCacheRead: 0,
      totalOutput: 0,
      overallCacheHitPct: 0,
      peakContextTokens: 0,
      compactions: 0,
      series: [],
    })
    assert.equal(drawContextSparkline(stats, DARK), '')
  })

  it('groups pre-turn and numbered turns with duration, faults, tokens, active flag, and top stations', () => {
    const setup = setupFrom({ language: 'ru' })
    const entries: Entry[] = [
      // Pre-turn window entry (turnNumber: 0)
      { id: 'pre-1', station: 'files', label: 'a.ts', status: 'ok', from: 'core', startedAt: t0, endedAt: t0 + 100, tokens: 500 },
      // Turn 1 (finished)
      { id: 'u1', station: 'you', label: 'new message', status: 'ok', from: 'inbound', startedAt: t0 + 500, endedAt: t0 + 500 },
      { id: 'h1', station: 'hooks', label: 'hook', status: 'ok', from: 'inbound', startedAt: t0 + 550, endedAt: t0 + 550 },
      { id: 'f1', station: 'files', label: 'b.ts', status: 'ok', from: 'core', startedAt: t0 + 600, endedAt: t0 + 800, tokens: 1200 },
      { id: 'f2', station: 'files', label: 'c.ts', status: 'ok', from: 'core', startedAt: t0 + 820, endedAt: t0 + 900, tokens: 800 },
      { id: 's1', station: 'shell', label: 'npm test', status: 'err', from: 'core', startedAt: t0 + 950, endedAt: t0 + 1450, tokens: 400 },
      { id: 'd1', station: 'you', label: 'answer ready', status: 'ok', mark: 'done', startedAt: t0 + 1600, endedAt: t0 + 1600 },
      // Turn 2 (currently active)
      { id: 'u2', station: 'you', label: 'new message', status: 'ok', from: 'inbound', startedAt: t0 + 2000, endedAt: t0 + 2000 },
      { id: 'w1', station: 'web', label: 'search', status: 'run', from: 'core', startedAt: t0 + 2200 },
    ]
    const board = deepFreeze<Board>({ entries, counts: {} })
    const snapshot = JSON.stringify(board)

    const turns = computeTurnSummaries(board, setup)
    assert.equal(JSON.stringify(board), snapshot)
    assert.equal(turns.length, 3)

    assert.equal(turns[0]?.turnNumber, 0)
    assert.equal(turns[0]?.callCount, 1)
    assert.equal(turns[0]?.tokensAdded, 500)
    assert.equal(turns[0]?.isActive, false)

    assert.equal(turns[1]?.turnNumber, 1)
    assert.equal(turns[1]?.durationMs, 1100)
    assert.equal(turns[1]?.callCount, 3)
    assert.equal(turns[1]?.faultCount, 1)
    assert.equal(turns[1]?.tokensAdded, 2400)
    assert.equal(turns[1]?.isActive, false)
    assert.deepEqual(turns[1]?.topStations, [
      { station: 'files', stationName: setup.t.stations.files, count: 2 },
      { station: 'shell', stationName: setup.t.stations.shell, count: 1 },
    ])

    assert.equal(turns[2]?.turnNumber, 2)
    assert.equal(turns[2]?.callCount, 1)
    assert.equal(turns[2]?.isActive, true)
  })

  it('computes token stats and renders valid XML sparklines including single-point and compaction markers', () => {
    const oneStepBoard: Board = {
      entries: [],
      counts: {},
      modelSteps: [
        {
          at: t0,
          inputTokens: 10_000,
          cacheReadTokens: 30_000,
          outputTokens: 250,
          totalContextTokens: 40_000,
          cacheHitPct: 75,
        },
      ],
    }
    const oneStats = computeTokenStats(oneStepBoard)
    assert.equal(oneStats.steps, 1)
    assert.equal(oneStats.latestCacheHitPct, 75)
    const oneSvg = drawContextSparkline(oneStats, DARK)
    assert.ok(oneSvg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'))
    assert.ok(oneSvg.includes('<circle '))
    assert.ok(oneSvg.endsWith('</svg>'))

    const multiBoard = deepFreeze<Board>({
      entries: [],
      counts: {},
      modelSteps: [
        { at: t0, inputTokens: 20_000, cacheReadTokens: 0, outputTokens: 200, totalContextTokens: 20_000, cacheHitPct: 0 },
        { at: t0 + 500, inputTokens: 20_000, cacheReadTokens: 60_000, outputTokens: 300, totalContextTokens: 80_000, cacheHitPct: 75 },
        { at: t0 + 900, inputTokens: 10_000, cacheReadTokens: 20_000, outputTokens: 150, totalContextTokens: 30_000, cacheHitPct: 67, isCompaction: true },
        { at: t0 + 1200, inputTokens: 10_000, cacheReadTokens: 40_000, outputTokens: 400, totalContextTokens: 50_000, cacheHitPct: 80 },
      ],
    })
    const multiStats = computeTokenStats(multiBoard)
    assert.equal(multiStats.steps, 4)
    assert.equal(multiStats.compactions, 1)
    assert.equal(multiStats.peakContextTokens, 80_000)
    assert.equal(multiStats.latestTotalContext, 50_000)
    assert.equal(multiStats.latestCacheHitPct, 80)
    assert.equal(multiStats.totalInput, 50_000)
    assert.equal(multiStats.totalCacheRead, 100_000)
    assert.equal(multiStats.totalOutput, 900)
    assert.equal(multiStats.overallCacheHitPct, 67)

    const escapedPalette = { ...DARK, accent: '#123456" onclick="alert(1)' }
    const multiSvg = drawContextSparkline(multiStats, escapedPalette, Number.NaN, 12)
    assert.ok(multiSvg.includes('<polyline '))
    assert.ok(multiSvg.includes('stroke-dasharray="2 2"'))
    assert.ok(multiSvg.includes('&quot;'))
    assert.ok(!multiSvg.includes('onclick="alert(1)"'))
  })

  it('meets < 1 ms CPU budget on 80 entries and 60 model steps', () => {
    const setup = setupFrom({ language: 'en' })
    const entries: Entry[] = Array.from({ length: 80 }, (_, i) => ({
      id: `e-${i}`,
      station: i % 10 === 0 ? 'you' : (['files', 'shell', 'web', 'memory'] as const)[i % 4]!,
      label: `step-${i}`,
      status: i === 79 ? 'run' : 'ok',
      from: i % 10 === 0 ? 'inbound' : 'core',
      startedAt: t0 + i * 50,
      endedAt: i === 79 ? undefined : t0 + i * 50 + 25,
      tokens: 1000,
    }))
    const modelSteps: ModelStepTelemetry[] = Array.from({ length: 60 }, (_, i) => ({
      at: t0 + i * 100,
      inputTokens: 10_000 + i * 500,
      cacheReadTokens: 30_000 + i * 1000,
      outputTokens: 300,
      totalContextTokens: 40_000 + i * 1500,
      cacheHitPct: 75,
    }))
    const board: Board = { entries, counts: {}, modelSteps }

    computeTurnSummaries(board, setup)
    drawContextSparkline(computeTokenStats(board), DARK)

    const tStart = performance.now()
    const turns = computeTurnSummaries(board, setup)
    const stats = computeTokenStats(board)
    const svg = drawContextSparkline(stats, DARK)
    const elapsedMs = performance.now() - tStart

    assert.equal(turns.length, 8)
    assert.ok(svg.length > 0)
    assert.ok(elapsedMs < 1.5, `Telemetry pipeline took ${elapsedMs.toFixed(3)} ms`)
  })
})
