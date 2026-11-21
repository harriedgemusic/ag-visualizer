import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { describe, it } from 'node:test'
import { drawBrailleMap, formatMarkdownReport } from '../src/core/braille'
import { computeBreakdown } from '../src/core/breakdown'
import { classifyTool } from '../src/core/classify'
import { drawMap } from '../src/core/draw'
import { foldRows, VERBOSE_LIST_ROWS } from '../src/core/feed'
import { inspectStation } from '../src/core/inspector'
import { DARK } from '../src/core/palette'
import { reduceTranscript, TranscriptReducer } from '../src/core/reducer'
import { sliceBoardAt } from '../src/core/replay'
import { setupFrom } from '../src/core/setup'
import { computeTokenStats, computeTurnSummaries, drawContextSparkline } from '../src/core/telemetry'
import type { Board, TranscriptStep } from '../src/core/types'

const CANARY = 'CANARY_SECRET_999'

describe('Core Principles', () => {
  it('Principle 1: never mutates input transcript steps or args', () => {
    const step: TranscriptStep = Object.freeze({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-21T12:00:00Z',
      model: 'gemini-4-neon-high',
      input_tokens: 12000,
      cache_read_tokens: 4000,
      tool_calls: Object.freeze([
        Object.freeze({
          name: 'read_file',
          args: Object.freeze({ Path: '"/repo/src/a.ts"' }),
        }),
      ]) as unknown as TranscriptStep['tool_calls'],
    })
    const snapshot = JSON.stringify(step)
    const reducer = new TranscriptReducer(setupFrom())
    reducer.push(step)
    assert.equal(JSON.stringify(step), snapshot)
  })

  it('Principle 2: CANARY_SECRET_999 never leaks into labels, board state, SVG, or feed', () => {
    const setup = setupFrom({ language: 'en', contextCost: true, subagentNames: true })
    const canaryPayloads: Array<[string, Record<string, unknown>]> = [
      ['read_file', { Path: `/secret/${CANARY}/deep/folder/app.ts` }],
      ['write_file', { TargetFile: `/secret/${CANARY}/a/b/out.ts`, CodeContent: CANARY }],
      ['edit_file', { Path: `/secret/${CANARY}/x/y/z.ts`, Target: CANARY, Replacement: CANARY }],
      ['multi_replace_file_content', { TargetFile: `/secret/${CANARY}/p/q.ts`, Description: CANARY }],
      ['replace_file_content', { TargetFile: `/secret/${CANARY}/p/q.ts`, ReplacementContent: CANARY }],
      ['view_file', { AbsolutePath: `/secret/${CANARY}/dir/mod.ts` }],
      ['view_file_outline', { AbsolutePath: `/secret/${CANARY}/dir/mod.ts` }],
      ['view_code_item', { File: `/secret/${CANARY}/dir/mod.ts`, NodePaths: [CANARY] }],
      ['list_dir', { DirectoryPath: `/secret/${CANARY}/dir/sub` }],
      ['grep_search', { Query: CANARY, SearchPath: `/secret/${CANARY}` }],
      ['find_by_name', { Pattern: CANARY, SearchDirectory: `/secret/${CANARY}` }],
      ['run_command', { CommandLine: `TOKEN=${CANARY} curl -H "X: ${CANARY}" https://api.example.com/${CANARY}` }],
      ['run_command', { CommandLine: `grep ${CANARY} /tmp/${CANARY}` }],
      ['run_command', { CommandLine: `bash -c "echo ${CANARY}"` }],
      ['manage_task', { Action: 'send_input', Input: CANARY, TaskId: CANARY }],
      ['command_status', { CommandId: CANARY, OutputCharacterCount: 100 }],
      ['send_command_input', { CommandId: CANARY, Input: CANARY }],
      ['schedule', { CronExpression: '* * * * *', Prompt: CANARY }],
      ['search_web', { query: CANARY }],
      ['read_url_content', { Url: `https://${CANARY}:${CANARY}@example.com/${CANARY}?q=${CANARY}#${CANARY}` }],
      ['fetch_url', { Url: `https://example.com/${CANARY}?secret=${CANARY}` }],
      ['browser_navigate', { Url: `https://app.example.com/${CANARY}?tok=${CANARY}` }],
      ['browser_click', { Selector: `#${CANARY}` }],
      ['browser_type', { Text: CANARY }],
      ['invoke_subagent', { TypeName: 'research', Role: 'Auditor', Prompt: CANARY }],
      ['invoke_subagent', { TypeName: 'browser', Role: 'Browser Bot', Prompt: CANARY }],
      ['define_subagent', { Name: 'helper', Description: CANARY, SystemPrompt: CANARY }],
      ['send_message', { Recipient: CANARY, Message: CANARY }],
      ['manage_subagents', { Action: 'list', ConversationIds: [CANARY] }],
      ['swarm', { action: 'add', brief: CANARY, title: CANARY, tasks: [CANARY] }],
      ['swarm_wait', { timeout: 10, reason: CANARY }],
      ['post_message', { message: CANARY }],
      ['read_board', { filter: CANARY }],
      ['run_workflow', { Description: 'Fan-out', Script: `print("${CANARY}")`, Args: { secret: CANARY } }],
      ['search_marketplace', { queries: [CANARY] }],
      ['list_plugin_accounts', { filter: CANARY }],
      ['ask_question', { questions: [{ question: CANARY, options: [CANARY] }] }],
      ['exit_plan_mode', { plan: CANARY, reason: CANARY }],
      ['enter_plan_mode', { reason: CANARY }],
      ['notify_user', { Message: CANARY, PathsToReview: [`/tmp/${CANARY}`] }],
      ['mcp__docs__search', { query: CANARY, body: CANARY }],
      ['unknown_custom_tool', { secret: CANARY, payload: CANARY }],
    ]

    for (const [tool, args] of canaryPayloads) {
      const classified = classifyTool(tool, args, setup)
      assert.ok(
        !classified.label.includes(CANARY),
        `classifyTool(${tool}) leaked canary in label: ${classified.label}`,
      )
    }

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
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-21T12:00:01Z',
        content: CANARY,
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T12:00:02Z',
        model: 'gemini-4-neon-high',
        input_tokens: 50000,
        cache_read_tokens: 10000,
        thinking: CANARY,
        tool_calls: canaryPayloads.map(([name, args]) => ({ name, args })),
      },
      ...canaryPayloads.map((_, i) => ({
        step_index: 3 + i,
        source: 'MODEL',
        type: 'GENERIC',
        status: i === 5 ? 'ERROR' : 'DONE',
        error: i === 5 ? CANARY : undefined,
        created_at: '2026-11-21T12:00:03Z',
        content: `Created At: 2026-11-21T12:00:02Z\nCompleted At: 2026-11-21T12:00:03Z\n${CANARY}`,
      })),
      {
        step_index: 99,
        source: 'SYSTEM',
        type: 'ERROR_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-21T12:00:04Z',
        error: CANARY,
      },
    ]

    const ts = Date.parse('2026-11-21T12:00:04Z')
    for (const detailLevel of ['compact', 'verbose'] as const) {
      const modeSetup = setupFrom({ language: 'en', contextCost: true, subagentNames: true, detailLevel })
      const board = reduceTranscript(steps, modeSetup)
      const svg = drawMap(board, ts, modeSetup, { selectedStation: 'files' })
      const rows = foldRows(board.entries, VERBOSE_LIST_ROWS, true, detailLevel === 'verbose')
      const breakdown = computeBreakdown(board, modeSetup)
      const inspection = inspectStation(board, 'files', modeSetup)
      const replayed = sliceBoardAt(board, Math.max(1, board.entries.length - 1), ts)
      const braille = drawBrailleMap(board, ts, modeSetup)
      const markdown = formatMarkdownReport(board, ts, modeSetup)
      const turns = computeTurnSummaries(board, modeSetup)
      const tokenStats = computeTokenStats(board)
      const sparkline = drawContextSparkline(tokenStats, DARK)

      assert.ok(!JSON.stringify(board).includes(CANARY), `Board (${detailLevel}) leaked canary`)
      assert.ok(!svg.includes(CANARY), `SVG (${detailLevel}) leaked canary`)
      assert.ok(!JSON.stringify(rows).includes(CANARY), `Feed rows (${detailLevel}) leaked canary`)
      assert.ok(!JSON.stringify(breakdown).includes(CANARY), `Breakdown (${detailLevel}) leaked canary`)
      assert.ok(!JSON.stringify(inspection).includes(CANARY), `Inspector (${detailLevel}) leaked canary`)
      assert.ok(!JSON.stringify(replayed).includes(CANARY), `Replay (${detailLevel}) leaked canary`)
      assert.ok(!braille.includes(CANARY), `Braille (${detailLevel}) leaked canary`)
      assert.ok(!markdown.includes(CANARY), `Markdown (${detailLevel}) leaked canary`)
      assert.ok(!JSON.stringify(turns).includes(CANARY), `Turns (${detailLevel}) leaked canary`)
      assert.ok(!JSON.stringify(tokenStats).includes(CANARY), `TokenStats (${detailLevel}) leaked canary`)
      assert.ok(!sparkline.includes(CANARY), `Sparkline (${detailLevel}) leaked canary`)
    }
  })

  it('Debug mode is opt-in, bounds huge previews, never leaks into exports, and purges on exit', () => {
    const debugSetup = setupFrom({ language: 'en', contextCost: true, detailLevel: 'debug' })
    const reducer = new TranscriptReducer(debugSetup)
    const hugeSecret = `${CANARY}${'x'.repeat(25_000)}`

    const t0 = performance.now()
    reducer.push({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-21T12:00:01Z',
      model: 'gemini-4-neon-high',
      input_tokens: 12_000,
      cache_read_tokens: 30_000,
      output_tokens: 180,
      thinking: hugeSecret,
      tool_calls: [
        { name: 'read_file', args: { Path: '"/repo/src/app.ts"', StartLine: 12, EndLine: 48, CodeContent: hugeSecret } },
      ],
    })
    reducer.push({
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'ERROR',
      error: hugeSecret,
      created_at: '2026-11-21T12:00:02Z',
      content: `Created At: 2026-11-21T12:00:01Z\nCompleted At: 2026-11-21T12:00:02Z\n${hugeSecret}`,
    })
    const debugMs = performance.now() - t0
    assert.ok(debugMs < 10, `Debug reduction of 25k payload took ${debugMs.toFixed(3)} ms`)

    const board = reducer.board()
    const callEntry = board.entries[0]
    assert.equal(callEntry?.debug?.lineRange, 'L12-L48')
    assert.ok((callEntry?.debug?.thinking?.length ?? 0) <= 240)
    assert.ok((callEntry?.debug?.error?.length ?? 0) <= 240)
    assert.ok((callEntry?.debug?.result?.length ?? 0) <= 240)
    assert.ok(callEntry?.debug?.thinking?.includes(CANARY))

    const ts = Date.parse('2026-11-21T12:00:02Z')
    assert.ok(!formatMarkdownReport(board, ts, debugSetup).includes(CANARY))
    assert.ok(!drawBrailleMap(board, ts, debugSetup).includes(CANARY))
    assert.ok(!drawMap(board, ts, debugSetup).includes(CANARY))
    assert.ok(!JSON.stringify(computeBreakdown(board, debugSetup)).includes(CANARY))
    assert.ok(!JSON.stringify(computeTurnSummaries(board, debugSetup)).includes(CANARY))
    assert.ok(!JSON.stringify(computeTokenStats(board)).includes(CANARY))

    // Leaving debug must immediately scrub all stored debug fields from memory
    reducer.updateSetup(setupFrom({ language: 'en', contextCost: true, detailLevel: 'verbose' }))
    assert.ok(!JSON.stringify(reducer.board()).includes(CANARY))
    assert.equal(reducer.board().entries[0]?.debug, undefined)
  })

  it('validates step_index, non-string GENERIC.content, malformed tool_calls, and huge line ranges safely', () => {
    const setup = setupFrom({ language: 'en', detailLevel: 'verbose' })
    const malformedSteps: TranscriptStep[] = [
      {
        step_index: `<img src=x onerror=alert(1)>${CANARY}` as unknown as number,
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-21T12:00:00Z',
        content: 'hello',
      },
      {
        step_index: { evil: true } as unknown as number,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T12:00:01Z',
        model: 'gemini-4-neon-high',
        input_tokens: 1000,
        tool_calls: [
          null as unknown as { name: string },
          'bad-string' as unknown as { name: string },
          { name: 'read_file', args: ['not-an-object'] as unknown as Record<string, unknown> },
        ],
      },
      {
        step_index: -5,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-21T12:00:02Z',
        content: { unexpected: 123 } as unknown as string,
      },
    ]

    const board = reduceTranscript(malformedSteps, setup)
    assert.ok(!JSON.stringify(board).includes(CANARY))
    assert.ok(!JSON.stringify(board).includes('<img'))
    for (const e of board.entries) {
      assert.ok(e.stepIdx === undefined || typeof e.stepIdx === 'number')
    }

    const debugReducer = new TranscriptReducer(setupFrom({ detailLevel: 'debug' }))
    const hugeLineStr = `"${'9'.repeat(200_000)}"`
    const t0 = performance.now()
    debugReducer.push({
      step_index: 1.7,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-21T12:00:03Z',
      tool_calls: [{ name: 'read_file', args: { Path: '"/a/b.ts"', StartLine: hugeLineStr, EndLine: 25 } }],
    })
    assert.ok(performance.now() - t0 < 5)
    assert.equal(debugReducer.board().entries[0]?.stepIdx, 2)
    assert.equal(debugReducer.board().entries[0]?.debug?.lineRange, 'L25')
  })

  it('Principle 3: respects strict CPU time budgets', () => {
    const setup = setupFrom({ contextCost: true })
    const mix: Array<[string, Record<string, unknown>]> = [
      ['read_file', { Path: '/repo/src/a.ts' }],
      ['edit_file', { Path: '/repo/src/b.ts' }],
      ['run_command', { CommandLine: 'git push origin main' }],
      ['run_command', { CommandLine: 'npm test' }],
      ['search_web', { query: 'typescript performance' }],
      ['read_url_content', { Url: 'https://antigravity.google/docs/sidecars.md' }],
      ['invoke_subagent', { TypeName: 'research', Role: 'Scanner', Prompt: 'scan' }],
    ]
    for (const [n, a] of mix) classifyTool(n, a, setup)

    const t0 = performance.now()
    for (const [n, a] of mix) classifyTool(n, a, setup)
    const classifyMs = performance.now() - t0
    assert.ok(classifyMs < 2, `classify batch took ${classifyMs.toFixed(3)} ms`)

    const now = Date.now()
    const entries: Board['entries'] = Array.from({ length: 80 }, (_, i) => ({
      id: `e-${i}`,
      station: (['files', 'shell', 'web', 'memory', 'agents', 'skills', 'browser', 'you'] as const)[i % 8]!,
      label: `item-${i}`,
      status: i >= 75 ? 'run' : 'ok',
      startedAt: now - (80 - i) * 100,
      endedAt: i >= 75 ? undefined : now - (80 - i) * 100 + 40,
      from: i % 5 === 0 ? 'agents' : 'core',
      tokens: 1200,
    }))
    const heavyBoard: Board = {
      entries,
      counts: { files: 20, shell: 15, web: 10, agents: 5 },
      spent: { files: 24000, shell: 12000 },
      context: 42,
      model: 'gemini-4-neon-high',
      agents: [
        { id: 'a1', label: 'A1', startedAt: now - 1000 },
        { id: 'a2', label: 'A2', startedAt: now - 800 },
        { id: 'a3', label: 'A3', startedAt: now - 500 },
      ],
    }

    drawMap(heavyBoard, now, setup)
    const t1 = performance.now()
    drawMap(heavyBoard, now, setup)
    const drawMs = performance.now() - t1
    assert.ok(drawMs < 5, `drawMap(80 entries) took ${drawMs.toFixed(3)} ms`)

    foldRows(entries, 16, true)
    const t2 = performance.now()
    foldRows(entries, 16, true)
    const foldMs = performance.now() - t2
    assert.ok(foldMs < 2, `foldRows(80 entries) took ${foldMs.toFixed(3)} ms`)

    const hugeCmd = `${'VAR=1 '.repeat(3500)}ls`
    assert.ok(hugeCmd.length > 20_000)
    const t3 = performance.now()
    const res = classifyTool('run_command', { CommandLine: hugeCmd }, setup)
    const hugeMs = performance.now() - t3
    assert.equal(res.station, 'shell')
    assert.ok(hugeMs < 20, `20k command line took ${hugeMs.toFixed(3)} ms`)
  })
})
