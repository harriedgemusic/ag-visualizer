import { formatMs, formatTokens } from '../core/classify'
import { DEMO_TIMELINE } from '../core/demo'
import { drawMap } from '../core/draw'
import { foldRows, nowParts } from '../core/feed'
import { resolvePalette } from '../core/palette'
import { TranscriptReducer } from '../core/reducer'
import { setupFrom } from '../core/setup'
import { LANGUAGES } from '../core/text'
import type { UserOptions } from '../core/types'

const mapEl = document.getElementById('demo-map') as HTMLElement
const feedEl = document.getElementById('demo-feed') as HTMLElement
const nowWhatEl = document.getElementById('demo-now-what') as HTMLElement
const nowMeterEl = document.getElementById('demo-now-meter') as HTMLElement
const rawJsonEl = document.getElementById('demo-raw') as HTMLElement
const keptJsonEl = document.getElementById('demo-kept') as HTMLElement

const btnPlay = document.getElementById('btn-play') as HTMLButtonElement
const btnRestart = document.getElementById('btn-restart') as HTMLButtonElement
const btnStep = document.getElementById('btn-step') as HTMLButtonElement
const selLang = document.getElementById('sel-lang') as HTMLSelectElement
const selTheme = document.getElementById('sel-theme') as HTMLSelectElement
const selLayout = document.getElementById('sel-layout') as HTMLSelectElement
const selMotion = document.getElementById('sel-motion') as HTMLSelectElement

let options: UserOptions = {
  language: 'en',
  theme: 'dark',
  layout: 'you-top',
  motion: 'full',
  coreName: 'AGY',
  contextCost: true,
  subagentNames: true,
}

let setup = setupFrom(options, 'en')
let reducer = new TranscriptReducer(setup)
let idx = 0
let playing = true
let timer: number | null = null
let baseMs = Date.now()
let lastSvg = ''
let lastRawPreview: unknown = { info: 'Waiting for first Antigravity transcript step...' }
let lastKeptPreview: unknown = { entries: [] }

function esc(text: string): string {
  return text.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c)
}

function renderDemo(): void {
  setup = setupFrom(options, 'en')
  reducer.updateSetup(setup)
  const board = reducer.board()
  const isLight = setup.theme === 'light'
  const palette = resolvePalette(setup, isLight)

  document.body.style.background = palette.ground
  document.body.style.color = palette.bone
  document.documentElement.style.setProperty('--ag-dim', palette.ash)
  document.documentElement.style.setProperty('--ag-border', palette.line)
  document.documentElement.style.setProperty('--ag-accent', palette.accent)
  document.documentElement.style.setProperty('--ag-error', palette.red)
  document.documentElement.style.setProperty('--ag-panel', palette.raised)

  const svg = drawMap(board, Date.now(), { ...setup, theme: isLight ? 'light' : 'dark' })
  if (svg !== lastSvg) {
    mapEl.innerHTML = svg
    lastSvg = svg
  }

  const parts = nowParts(board, setup.t)
  nowWhatEl.textContent = parts.what
  nowMeterEl.textContent = parts.meter

  const rows = foldRows(board.entries, 16, setup.subagentNames)
  if (rows.length === 0) {
    feedEl.innerHTML = `<div class="feed-empty">${esc(setup.t.nothingYet)}</div>`
  } else {
    feedEl.innerHTML = rows
      .map(r => {
        const e = r.entry
        const isSwitch = e.mark === 'switch'
        const isRunning = e.endedAt === undefined || e.status === 'run'
        const mark = isSwitch ? '◆' : isRunning ? '●' : e.status === 'ok' ? '·' : '✕'
        const cls = isRunning ? 'is-running' : isSwitch ? 'is-switch' : e.status === 'err' ? 'is-error' : 'is-ok'
        const timeText = isRunning
          ? setup.t.running
          : r.tookMs > 0
            ? formatMs(r.tookMs, setup.t)
            : '—'
        const cost = setup.contextCost && r.tokens !== undefined ? ` ${r.isShared ? '~' : ''}+${formatTokens(r.tokens)}` : ''
        const times = r.times > 1 ? ` +${r.times - 1}` : ''
        return `<div class="row ${cls}">
          <span class="row-mark">${mark}</span>
          <span class="row-station">${esc(setup.t.stations[e.station])}</span>
          <span class="row-label">${esc(e.label)}${times}</span>
          <span class="row-meta">${esc(timeText + cost)}</span>
        </div>`
      })
      .join('')
  }

  rawJsonEl.textContent = JSON.stringify(lastRawPreview, null, 2)
  keptJsonEl.textContent = JSON.stringify(lastKeptPreview, null, 2)
}

function advanceOne(): boolean {
  const item = DEMO_TIMELINE[idx]
  if (!item) return false
  const now = Date.now()
  const firstIso = DEMO_TIMELINE[0]?.step.created_at
  const t0 = firstIso ? Date.parse(firstIso) : now
  const stepTime = item.step.created_at ? Date.parse(item.step.created_at) : t0
  const shiftedCreatedAt = new Date(baseMs + (stepTime - t0)).toISOString()
  const shiftedContent =
    item.step.content && item.step.type === 'GENERIC'
      ? item.step.content
          .replace(/^Created At: .+$/m, `Created At: ${new Date(now - 300).toISOString()}`)
          .replace(/^Completed At: .+$/m, `Completed At: ${new Date(now).toISOString()}`)
      : item.step.content

  reducer.push(
    { ...item.step, created_at: shiftedCreatedAt, content: shiftedContent },
    {
      from: item.from,
      subagentLabel: item.subagentLabel,
      agentId: item.from === 'agents' ? 'demo-researcher' : undefined,
      now,
    },
  )

  lastRawPreview = {
    from: item.from ?? 'core',
    type: item.step.type,
    status: item.step.status,
    ...(item.step.model ? { model: item.step.model } : {}),
    ...(item.step.tool_calls ? { tool_calls: item.step.tool_calls } : {}),
    ...(item.step.content ? { content: item.step.content.slice(0, 140) } : {}),
    ...(item.step.error ? { error: item.step.error } : {}),
  }

  const board = reducer.board()
  lastKeptPreview = {
    latestEntries: board.entries.slice(-3).map(e => ({
      station: e.station,
      label: e.label,
      status: e.status,
      from: e.from,
      ...(e.tokens !== undefined ? { tokens: e.tokens } : {}),
    })),
    counts: board.counts,
    contextPct: board.context,
    model: board.model,
  }

  idx += 1
  renderDemo()
  return true
}

function schedule(): void {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
  if (!playing) return
  const item = DEMO_TIMELINE[idx]
  if (!item) {
    timer = window.setTimeout(() => {
      restart()
    }, 3500)
    return
  }
  timer = window.setTimeout(() => {
    if (advanceOne()) schedule()
  }, item.delayMs)
}

function restart(): void {
  if (timer !== null) window.clearTimeout(timer)
  idx = 0
  baseMs = Date.now()
  reducer.reset()
  lastSvg = ''
  renderDemo()
  if (playing) schedule()
}

for (const lang of LANGUAGES) {
  const opt = document.createElement('option')
  opt.value = lang
  opt.textContent = lang.toUpperCase()
  selLang.appendChild(opt)
}
selLang.value = 'en'

btnPlay.addEventListener('click', () => {
  playing = !playing
  btnPlay.textContent = playing ? 'Pause' : 'Play'
  if (playing) schedule()
  else if (timer !== null) window.clearTimeout(timer)
})
btnRestart.addEventListener('click', () => restart())
btnStep.addEventListener('click', () => {
  playing = false
  btnPlay.textContent = 'Play'
  if (timer !== null) window.clearTimeout(timer)
  if (!advanceOne()) restart()
})
selLang.addEventListener('change', () => {
  options = { ...options, language: selLang.value }
  lastSvg = ''
  renderDemo()
})
selTheme.addEventListener('change', () => {
  options = { ...options, theme: selTheme.value }
  lastSvg = ''
  renderDemo()
})
selLayout.addEventListener('change', () => {
  options = { ...options, layout: selLayout.value }
  lastSvg = ''
  renderDemo()
})
selMotion.addEventListener('change', () => {
  options = { ...options, motion: selMotion.value }
  lastSvg = ''
  renderDemo()
})

renderDemo()
schedule()
