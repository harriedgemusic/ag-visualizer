import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { drawMap } from '../src/core/draw'
import { foldRows, LIST_ROWS } from '../src/core/feed'
import { DARK, LIGHT } from '../src/core/palette'
import { setupFrom } from '../src/core/setup'
import { LANGUAGES } from '../src/core/text'
import type { Board, Entry } from '../src/core/types'

describe('drawMap & foldRows', () => {
  const now = 1_763_720_010_000
  const baseBoard: Board = {
    entries: [
      { id: '1', station: 'you', label: 'new message', status: 'ok', from: 'inbound', startedAt: now - 2000, endedAt: now - 2000 },
      { id: '2', station: 'files', label: 'src/a.ts', status: 'ok', from: 'core', startedAt: now - 1500, endedAt: now - 1200, tokens: 3000 },
      { id: '3', station: 'shell', label: 'npm test', status: 'run', from: 'core', startedAt: now - 400 },
    ],
    counts: { you: 1, files: 1, shell: 1 },
    spent: { files: 3000 },
    context: 42,
    model: 'gemini-4-neon-high',
    agents: [{ id: 'a1', label: 'Researcher', startedAt: now - 500 }],
  }

  it('renders all 7 languages, dark/light/auto themes, transparent background, and reduced motion', () => {
    for (const lang of LANGUAGES) {
      const setup = setupFrom({ language: lang, theme: 'dark' })
      const svg = drawMap(baseBoard, now, setup)
      for (const label of Object.values(setup.t.stations)) {
        assert.ok(svg.includes(`>${label}<`), `Missing station label "${label}" for ${lang}`)
      }
      assert.ok(svg.includes('42%'))
    }

    const lightSvg = drawMap(baseBoard, now, setupFrom({ theme: 'light' }))
    assert.ok(lightSvg.includes(`fill="${LIGHT.ground}"`))

    const autoSvg = drawMap(baseBoard, now, setupFrom({ theme: 'auto' }))
    assert.ok(autoSvg.includes(`fill="${DARK.ground}"`))
    assert.ok(autoSvg.includes('@media (prefers-color-scheme: light)'))

    const transparentSvg = drawMap(baseBoard, now, setupFrom({ background: 'transparent' }))
    assert.ok(!transparentSvg.includes(`<rect width="460" height="430"`))

    const reducedSvg = drawMap(baseBoard, now, setupFrom({ motion: 'reduced' }))
    assert.ok(!reducedSvg.includes('<animateMotion'))
    assert.ok(!reducedSvg.includes('<animateTransform'))
  })

  it('escapes XML special characters (&, <, >, ", \') in coreName and model', () => {
    const trickyBoard: Board = {
      ...baseBoard,
      model: 'gemini-4-a&b<c>"d\'',
    }
    const svg = drawMap(trickyBoard, now, setupFrom({ coreName: 'R&D<1>' }))
    assert.ok(svg.includes('R&amp;D&lt;1&gt;'))
    assert.ok(svg.includes('a&amp;b&lt;c&gt;&quot;d&#39;'))
    assert.ok(!svg.includes('>R&D<'))
  })

  it('keeps stations lit for running entries older than the last 40 entries', () => {
    const entries: Entry[] = [
      { id: 'bg-old', station: 'browser', label: 'long browser task', status: 'run', from: 'core', startedAt: now - 5000 },
      ...Array.from({ length: 45 }, (_, i) => ({
        id: `f-${i}`,
        station: 'files' as const,
        label: `src/f${i}.ts`,
        status: 'ok' as const,
        from: 'core' as const,
        startedAt: now - 4000 + i * 20,
        endedAt: now - 3990 + i * 20,
      })),
    ]
    const svg = drawMap({ entries, counts: { browser: 1, files: 45 } }, now, setupFrom())
    assert.ok(svg.includes('dur="1.8s" repeatCount="indefinite"'))
  })

  it('folds consecutive finished calls and pins running entries past LIST_ROWS', () => {
    const entries: Entry[] = [
      { id: 'run-old', station: 'shell', label: 'dev server', status: 'run', from: 'core', startedAt: 100 },
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `f-${i}`,
        station: 'files' as const,
        label: `f${i}.ts`,
        status: 'ok' as const,
        from: 'core' as const,
        startedAt: 200 + i * 10,
        endedAt: 205 + i * 10,
        tokens: 100,
      })),
    ]

    const rows = foldRows(entries, LIST_ROWS, true)
    // Consecutive 20 files calls fold into 1 row, plus run-old
    assert.equal(rows.length, 2)
    assert.equal(rows[0]?.times, 20)
    assert.equal(rows[0]?.tokens, 2000)
    assert.equal(rows[1]?.entry.id, 'run-old')

    // When > LIST_ROWS alternating entries push run-old past cutoff, it stays held
    const alternating: Entry[] = [
      { id: 'run-pinned', station: 'agents', label: 'worker', status: 'run', from: 'core', startedAt: 10 },
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `alt-${i}`,
        station: (i % 2 === 0 ? 'files' : 'web') as Entry['station'],
        label: `item-${i}`,
        status: 'ok' as const,
        from: 'core' as const,
        startedAt: 100 + i * 10,
        endedAt: 105 + i * 10,
      })),
    ]
    const pinnedRows = foldRows(alternating, LIST_ROWS, true)
    assert.equal(pinnedRows.length, LIST_ROWS)
    assert.equal(pinnedRows[pinnedRows.length - 1]?.entry.id, 'run-pinned')
    assert.equal(pinnedRows[pinnedRows.length - 1]?.isHeld, true)
  })
})
