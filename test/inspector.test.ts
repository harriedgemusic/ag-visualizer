import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { describe, it } from 'node:test'
import { filterBoardByStation, inspectStation } from '../src/core/inspector'
import { setupFrom } from '../src/core/setup'
import type { Board, Entry, StationId } from '../src/core/types'

function makeEntry(overrides: Partial<Entry> & Pick<Entry, 'id' | 'station' | 'label'>): Entry {
  return {
    status: 'ok',
    startedAt: 1_000,
    endedAt: 1_100,
    from: 'core',
    ...overrides,
  }
}

describe('Station Inspector', () => {
  it('aggregates counts, share %, durations, tokens, faultCount, and localized stationName', () => {
    const board: Board = {
      entries: [
        makeEntry({ id: '1', station: 'files', label: 'src/a.ts', startedAt: 1_000, endedAt: 1_100 }),
        makeEntry({ id: '2', station: 'files', label: 'src/b.ts', startedAt: 2_000, endedAt: 2_255 }),
        makeEntry({ id: '3', station: 'files', label: 'src/c.ts', startedAt: 3_000, endedAt: 2_900 }), // negative clamped to 0
        makeEntry({ id: '4', station: 'files', label: 'src/d.ts', status: 'run', startedAt: 4_000, endedAt: undefined }),
        makeEntry({ id: '5', station: 'shell', label: 'npm test', startedAt: 5_000, endedAt: 5_400 }),
      ],
      counts: { files: 10, shell: 5, web: 15 }, // total = 30, files count exceeds visible 4
      faults: { files: 2 },
      spent: { files: 1234.6 },
    }

    const enSetup = setupFrom({ language: 'en' })
    const res = inspectStation(board, 'files', enSetup)

    assert.equal(res.station, 'files')
    assert.equal(res.stationName, 'Files')
    assert.equal(res.count, 10)
    assert.equal(res.callSharePct, 33.3) // 10 / 30 * 100 rounded to 1 decimal
    assert.equal(res.runningCount, 1)
    assert.equal(res.faultCount, 2)
    assert.equal(res.status, 'run')
    assert.equal(res.tokens, 1235)
    assert.equal(res.totalTimeMs, 355) // 100 + 255 + 0
    assert.equal(res.maxTimeMs, 255)
    assert.equal(res.avgTimeMs, 118) // Math.round(355 / 3)
    assert.deepEqual(
      res.entries.map(e => e.id),
      ['1', '2', '3', '4'],
    )

    const ruSetup = setupFrom({ language: 'ru' })
    assert.equal(inspectStation(board, 'files', ruSetup).stationName, 'Файлы')
  })

  it('falls back to board.entries.length for share % when board.counts sums to zero', () => {
    const board: Board = {
      entries: [
        makeEntry({ id: '1', station: 'web', label: 'search_web' }),
        makeEntry({ id: '2', station: 'files', label: 'src/a.ts' }),
        makeEntry({ id: '3', station: 'files', label: 'src/b.ts' }),
      ],
      counts: {},
    }

    const res = inspectStation(board, 'files', setupFrom())
    assert.equal(res.count, 2)
    assert.equal(res.callSharePct, 66.7)
  })

  it('computes status transitions across run, err, block, and ok', () => {
    const setup = setupFrom()

    // 1. Running takes precedence over faults and errors
    const runningBoard: Board = {
      entries: [
        makeEntry({ id: '1', station: 'shell', label: 'build', status: 'err' }),
        makeEntry({ id: '2', station: 'shell', label: 'test', status: 'run', endedAt: undefined }),
      ],
      counts: { shell: 2 },
      faults: { shell: 3 },
    }
    assert.equal(inspectStation(runningBoard, 'shell', setup).status, 'run')

    // 2. Faults > 0 causes err even if entries end in ok
    const faultBoard: Board = {
      entries: [makeEntry({ id: '1', station: 'shell', label: 'build', status: 'ok' })],
      counts: { shell: 1 },
      faults: { shell: 1 },
    }
    assert.equal(inspectStation(faultBoard, 'shell', setup).status, 'err')

    // 3. Ending in err causes err even when faultCount is 0
    const endsErrBoard: Board = {
      entries: [
        makeEntry({ id: '1', station: 'shell', label: 'lint', status: 'ok' }),
        makeEntry({ id: '2', station: 'shell', label: 'test', status: 'err' }),
      ],
      counts: { shell: 2 },
    }
    assert.equal(inspectStation(endsErrBoard, 'shell', setup).status, 'err')

    // 4. Ending in block causes err even when faultCount is 0
    const endsBlockBoard: Board = {
      entries: [makeEntry({ id: '1', station: 'shell', label: 'rm -rf', status: 'block' })],
      counts: { shell: 1 },
    }
    assert.equal(inspectStation(endsBlockBoard, 'shell', setup).status, 'err')

    // 5. Earlier err/block recovered by later ok and 0 faults resolves to ok
    const recoveredBoard: Board = {
      entries: [
        makeEntry({ id: '1', station: 'shell', label: 'test', status: 'err' }),
        makeEntry({ id: '2', station: 'shell', label: 'test', status: 'ok' }),
      ],
      counts: { shell: 2 },
      faults: { shell: 0 },
    }
    assert.equal(inspectStation(recoveredBoard, 'shell', setup).status, 'ok')
  })

  it('groups top 4 labels and sorts by count desc, timeMs desc, then label asc', () => {
    const board: Board = {
      entries: [
        // 'most-frequent': count 3, timeMs 150, errors 1
        makeEntry({ id: '1', station: 'files', label: 'most-frequent', startedAt: 0, endedAt: 50 }),
        makeEntry({ id: '2', station: 'files', label: 'most-frequent', status: 'err', startedAt: 100, endedAt: 140 }),
        makeEntry({ id: '3', station: 'files', label: 'most-frequent', startedAt: 200, endedAt: 260 }),

        // 'tie-slower': count 2, timeMs 300, errors 1 (block)
        makeEntry({ id: '4', station: 'files', label: 'tie-slower', status: 'block', startedAt: 0, endedAt: 120 }),
        makeEntry({ id: '5', station: 'files', label: 'tie-slower', startedAt: 200, endedAt: 380 }),

        // 'zeta': count 2, timeMs 100
        makeEntry({ id: '6', station: 'files', label: 'zeta', startedAt: 0, endedAt: 40 }),
        makeEntry({ id: '7', station: 'files', label: 'zeta', startedAt: 100, endedAt: 160 }),

        // 'alpha': count 2, timeMs 100 -> beats 'zeta' by label ascending
        makeEntry({ id: '8', station: 'files', label: 'alpha', startedAt: 0, endedAt: 50 }),
        makeEntry({ id: '9', station: 'files', label: 'alpha', startedAt: 100, endedAt: 150 }),

        // 'dropped': count 1, timeMs 900 -> 5th place, excluded by top 4 limit
        makeEntry({ id: '10', station: 'files', label: 'dropped', startedAt: 0, endedAt: 900 }),
      ],
      counts: { files: 10 },
    }

    const res = inspectStation(board, 'files', setupFrom())
    assert.deepEqual(res.topLabels, [
      { label: 'most-frequent', count: 3, timeMs: 150, errors: 1 },
      { label: 'tie-slower', count: 2, timeMs: 300, errors: 1 },
      { label: 'alpha', count: 2, timeMs: 100, errors: 0 },
      { label: 'zeta', count: 2, timeMs: 100, errors: 0 },
    ])
  })

  it('filters board entries by station or returns all entries when station is undefined', () => {
    const board: Board = {
      entries: [
        makeEntry({ id: '1', station: 'you', label: 'new message' }),
        makeEntry({ id: '2', station: 'files', label: 'a.ts' }),
        makeEntry({ id: '3', station: 'shell', label: 'npm test' }),
        makeEntry({ id: '4', station: 'files', label: 'b.ts' }),
      ],
      counts: { you: 1, files: 2, shell: 1 },
    }

    assert.equal(filterBoardByStation(board, undefined), board.entries)
    assert.deepEqual(
      filterBoardByStation(board, 'files').map(e => e.id),
      ['2', '4'],
    )
    assert.deepEqual(filterBoardByStation(board, 'browser'), [])
  })

  it('never mutates frozen board inputs and handles empty station inspection cleanly', () => {
    const frozenEntries = Object.freeze([
      Object.freeze(makeEntry({ id: '1', station: 'memory', label: 'MEMORY.md', startedAt: 10, endedAt: 30 })),
    ])
    const frozenBoard: Board = Object.freeze({
      entries: frozenEntries as Entry[],
      counts: Object.freeze({ memory: 1 }),
      faults: Object.freeze({ memory: 0 }),
      spent: Object.freeze({ memory: -25 }),
    })
    const snapshot = JSON.stringify(frozenBoard)
    const setup = setupFrom()

    const memRes = inspectStation(frozenBoard, 'memory', setup)
    assert.equal(memRes.tokens, 0)
    assert.equal(memRes.avgTimeMs, 20)

    const emptyRes = inspectStation(frozenBoard, 'hooks', setup)
    assert.deepEqual(emptyRes, {
      station: 'hooks',
      stationName: 'Hooks',
      status: 'ok',
      count: 0,
      callSharePct: 0,
      runningCount: 0,
      faultCount: 0,
      tokens: 0,
      totalTimeMs: 0,
      avgTimeMs: 0,
      maxTimeMs: 0,
      topLabels: [],
      entries: [],
    })

    const filtered = filterBoardByStation(frozenBoard, 'memory')
    assert.equal(filtered.length, 1)
    assert.equal(JSON.stringify(frozenBoard), snapshot)

    // Mutating returned arrays must not affect the source board
    memRes.entries.push(makeEntry({ id: 'extra', station: 'memory', label: 'x' }))
    assert.equal(frozenBoard.entries.length, 1)
  })

  it('completes inspection of 80 entries well under 1 ms', () => {
    const stations: readonly StationId[] = ['files', 'shell', 'web', 'memory', 'agents', 'skills', 'browser', 'you']
    const entries: Entry[] = Array.from({ length: 80 }, (_, i) => ({
      id: `e-${i}`,
      station: stations[i % stations.length]!,
      label: `tool-${i % 12}`,
      status: i >= 78 ? 'run' : i % 17 === 0 ? 'err' : 'ok',
      startedAt: 1_000_000 + i * 50,
      endedAt: i >= 78 ? undefined : 1_000_000 + i * 50 + 25,
      from: 'core',
      tokens: 500,
    }))
    const board: Board = {
      entries,
      counts: { files: 10, shell: 10, web: 10, memory: 10, agents: 10, skills: 10, browser: 10, you: 10 },
      faults: { files: 1 },
      spent: { files: 5000 },
    }
    const setup = setupFrom()

    // Warm up JIT before measuring
    inspectStation(board, 'files', setup)
    filterBoardByStation(board, 'files')

    const t0 = performance.now()
    const res = inspectStation(board, 'files', setup)
    const elapsedMs = performance.now() - t0

    assert.equal(res.count, 10)
    assert.ok(elapsedMs < 1, `inspectStation(80 entries) took ${elapsedMs.toFixed(3)} ms`)
  })

  it('guards against NaN timestamps and caps callSharePct at 100%', () => {
    const board: Board = {
      entries: [
        makeEntry({ id: '1', station: 'files', label: 'a.ts', startedAt: 100, endedAt: Number.NaN }),
        makeEntry({ id: '2', station: 'files', label: 'b.ts', startedAt: 100, endedAt: 140 }),
      ],
      counts: { files: 1 },
    }
    const res = inspectStation(board, 'files', setupFrom())
    assert.equal(res.totalTimeMs, 40)
    assert.equal(res.avgTimeMs, 40)
    assert.equal(res.callSharePct, 100)
  })
})
