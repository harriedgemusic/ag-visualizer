import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { describe, it } from 'node:test'
import { drawBrailleMap, formatMarkdownReport } from '../src/core/braille'
import { reduceTranscript } from '../src/core/reducer'
import { setupFrom } from '../src/core/setup'
import { LANGUAGES } from '../src/core/text'
import type { Board, TranscriptStep } from '../src/core/types'

const CANARY = 'CANARY_SECRET_999'

describe('drawBrailleMap & formatMarkdownReport', () => {
  const now = 1_763_720_010_000
  const sampleBoard: Board = {
    entries: [
      {
        id: '1',
        station: 'you',
        label: 'new message',
        status: 'ok',
        from: 'inbound',
        startedAt: now - 5000,
        endedAt: now - 5000,
      },
      {
        id: '2',
        station: 'files',
        label: 'src/app.ts',
        status: 'ok',
        from: 'core',
        startedAt: now - 2200,
        endedAt: now - 1950,
        tokens: 3400,
      },
      {
        id: '3',
        station: 'shell',
        label: 'npm test',
        status: 'run',
        from: 'core',
        startedAt: now - 400,
      },
      {
        id: '4',
        station: 'web',
        label: 'web search',
        status: 'err',
        from: 'core',
        startedAt: now - 1800,
        endedAt: now - 1400,
      },
    ],
    counts: { you: 1, files: 2, shell: 1, web: 1 },
    faults: { web: 1 },
    spent: { files: 3400 },
    context: 42,
    model: 'gemini-4-neon-high',
  }

  it('renders valid Braille characters and station labels for all 7 languages', () => {
    for (const lang of LANGUAGES) {
      const setup = setupFrom({ language: lang })
      const map = drawBrailleMap(sampleBoard, now, setup)
      const lines = map.split('\n')

      assert.equal(lines.length, 19, `Expected 19 rows for ${lang}`)
      for (const line of lines) {
        assert.equal([...line].length, 52, `Expected 52 columns for ${lang}`)
      }

      const brailleMatches = map.match(/[\u2800-\u28FF]/g)
      assert.ok(brailleMatches && brailleMatches.length > 200, `Expected Braille cells for ${lang}`)

      for (const label of Object.values(setup.t.stations)) {
        assert.ok(map.includes(label), `Missing station label "${label}" in ${lang}`)
      }
      assert.ok(map.includes('AGY 42%'))
      assert.ok(map.includes('neon-high'))
      assert.ok(map.includes('+3k'))
    }
  })

  it('shifts station vertical positions between you-top and you-bottom layouts', () => {
    const topSetup = setupFrom({ layout: 'you-top' })
    const bottomSetup = setupFrom({ layout: 'you-bottom' })

    const topLines = drawBrailleMap(sampleBoard, now, topSetup).split('\n')
    const bottomLines = drawBrailleMap(sampleBoard, now, bottomSetup).split('\n')

    const topYouRow = topLines.findIndex(line => line.includes(topSetup.t.stations.you))
    const bottomYouRow = bottomLines.findIndex(line => line.includes(bottomSetup.t.stations.you))

    assert.ok(topYouRow >= 0 && topYouRow < 5, `Expected You near top, got row ${topYouRow}`)
    assert.ok(bottomYouRow > 13, `Expected You near bottom, got row ${bottomYouRow}`)

    const topWebRow = topLines.findIndex(line => line.includes(topSetup.t.stations.web))
    const bottomWebRow = bottomLines.findIndex(line => line.includes(bottomSetup.t.stations.web))
    assert.ok(topWebRow > 13, `Expected Network near bottom in you-top, got row ${topWebRow}`)
    assert.ok(bottomWebRow >= 0 && bottomWebRow < 5, `Expected Network near top in you-bottom, got row ${bottomWebRow}`)
  })

  it('clamps grid dimensions safely for tiny, huge, negative, and non-finite arguments', () => {
    const setup = setupFrom()

    const tiny = drawBrailleMap(sampleBoard, now, setup, 2, -5)
    const tinyLines = tiny.split('\n')
    assert.equal(tinyLines.length, 12)
    for (const line of tinyLines) assert.equal([...line].length, 24)

    const huge = drawBrailleMap(sampleBoard, now, setup, 1_000_000, 99_999)
    const hugeLines = huge.split('\n')
    assert.equal(hugeLines.length, 40)
    for (const line of hugeLines) assert.equal([...line].length, 100)

    const nanMap = drawBrailleMap(sampleBoard, now, setup, Number.NaN, Number.POSITIVE_INFINITY)
    const nanLines = nanMap.split('\n')
    assert.equal(nanLines.length, 40)
    for (const line of nanLines) assert.equal([...line].length, 52)
  })

  it('renders an active pulse dot along the spoke only within 1200ms of startedAt', () => {
    const setup = setupFrom()
    const pulseBoard: Board = {
      entries: [
        { id: 'p1', station: 'files', label: 'a.ts', status: 'ok', from: 'core', startedAt: now - 300, endedAt: now - 250 },
      ],
      counts: { files: 1 },
    }
    const fresh = drawBrailleMap(pulseBoard, now, setup)
    const stale = drawBrailleMap(pulseBoard, now + 1500, setup)
    assert.notEqual(fresh, stale)
  })

  it('formats a clean Markdown report with heading, metadata, fenced Braille map, table, and escaped recent feed', () => {
    const setup = setupFrom({ language: 'en', coreName: 'AGY' })
    const trickyBoard: Board = {
      ...sampleBoard,
      entries: [
        ...sampleBoard.entries,
        {
          id: '5',
          station: 'skills',
          label: 'bad|pipe`tick\nnewline',
          status: 'ok',
          from: 'core',
          startedAt: now - 100,
          endedAt: now - 50,
        },
      ],
    }

    const md = formatMarkdownReport(trickyBoard, now, setup)

    assert.ok(md.startsWith(`# ${setup.t.title} — AGY`))
    assert.ok(md.includes('neon-high'))
    assert.ok(md.includes('42%'))
    assert.ok(md.includes('````text\n'))
    assert.ok(md.includes('\n````'))
    assert.ok(md.includes('| Station | Calls | Context | Errors |'))
    assert.ok(md.includes('| Files | 2 | +3k | 0 |'))
    assert.ok(md.includes('| Network | 1 | — | 1 |'))
    assert.ok(!md.includes('| Memory |'))
    assert.ok(md.includes('bad\\|pipe\\`tick newline'))
    assert.ok(!md.includes('bad|pipe`tick\nnewline'))

    // Regression: Markdown link/image/HTML injection, \| table breakout, and fence breakout
    const attackBoard: Board = {
      entries: [
        {
          id: 'atk-1',
          station: 'web',
          label: '![track](https://evil.test/px) <script>a\\|b</script> ```',
          status: 'ok',
          from: 'core',
          startedAt: now - 100,
          endedAt: now - 50,
        },
      ],
      counts: { web: 1 },
      model: 'claude-```fence-1-2',
    }
    const safeMd = formatMarkdownReport(attackBoard, now, setup)
    assert.ok(!safeMd.includes('![track](https://evil.test/px)'))
    assert.ok(!safeMd.includes('<script>'))
    assert.ok(safeMd.includes('\\!\\[track\\]\\(https://evil.test/px\\)'))
    assert.ok(safeMd.includes('a\\\\\\|b'))
    assert.ok(!drawBrailleMap(attackBoard, now, setup, 24, 19).includes('```'))
  })

  it('Principle 2: CANARY_SECRET_999 never leaks into Braille map or Markdown report via reduceTranscript', () => {
    const setup = setupFrom({ language: 'en', contextCost: true, subagentNames: true })
    const steps: TranscriptStep[] = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-21T12:00:00Z',
        content: CANARY,
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T12:00:01Z',
        model: 'gemini-4-neon-high',
        input_tokens: 45_000,
        cache_read_tokens: 5_000,
        thinking: CANARY,
        tool_calls: [
          { name: 'read_file', args: { Path: `/secret/${CANARY}/deep/sub/file.ts` } },
          { name: 'run_command', args: { CommandLine: `TOKEN=${CANARY} curl https://api.example.com/${CANARY}` } },
          { name: 'search_web', args: { query: CANARY } },
          { name: 'fetch_url', args: { Url: `https://${CANARY}:${CANARY}@example.com/${CANARY}?q=${CANARY}` } },
          { name: 'ask_question', args: { questions: [{ question: CANARY, options: [CANARY] }] } },
          { name: 'unknown_tool', args: { secret: CANARY } },
        ],
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'ERROR',
        error: CANARY,
        created_at: '2026-11-21T12:00:02Z',
        content: `Created At: 2026-11-21T12:00:01Z\nCompleted At: 2026-11-21T12:00:02Z\n${CANARY}`,
      },
    ]

    const board = reduceTranscript(steps, setup)
    const ts = Date.parse('2026-11-21T12:00:02Z')
    const braille = drawBrailleMap(board, ts, setup)
    const report = formatMarkdownReport(board, ts, setup)

    assert.ok(!braille.includes(CANARY), 'Braille map leaked canary')
    assert.ok(!report.includes(CANARY), 'Markdown report leaked canary')
  })

  it('respects strict < 3 ms performance budget for drawBrailleMap', () => {
    const setup = setupFrom({ contextCost: true })
    const heavyBoard: Board = {
      entries: Array.from({ length: 80 }, (_, i) => ({
        id: `e-${i}`,
        station: (['files', 'shell', 'web', 'memory', 'agents', 'skills', 'browser', 'you'] as const)[i % 8]!,
        label: `item-${i}`,
        status: i >= 75 ? 'run' : 'ok',
        startedAt: now - (80 - i) * 100,
        endedAt: i >= 75 ? undefined : now - (80 - i) * 100 + 40,
        tokens: 1200,
      })),
      counts: { files: 20, shell: 15, web: 10, memory: 8, agents: 5, skills: 6, browser: 4, you: 2 },
      faults: { shell: 1 },
      spent: { files: 24_000, shell: 12_000, web: 6000 },
      context: 64,
      model: 'gemini-4-neon-high',
    }

    // Warm up JIT
    for (let i = 0; i < 5; i++) drawBrailleMap(heavyBoard, now, setup)

    const t0 = performance.now()
    drawBrailleMap(heavyBoard, now, setup)
    const elapsedMs = performance.now() - t0
    assert.ok(elapsedMs < 3, `drawBrailleMap took ${elapsedMs.toFixed(3)} ms (budget < 3 ms)`)
  })
})
