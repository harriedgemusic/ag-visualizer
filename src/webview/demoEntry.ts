import { drawBrailleMap, formatMarkdownReport } from '../core/braille'
import { computeBreakdown } from '../core/breakdown'
import { formatMs, formatTokens } from '../core/classify'
import { DEMO_TIMELINE } from '../core/demo'
import { drawMap } from '../core/draw'
import { foldRows, nowParts, VERBOSE_LIST_ROWS } from '../core/feed'
import { filterBoardByStation, inspectStation } from '../core/inspector'
import { resolvePalette } from '../core/palette'
import { TranscriptReducer } from '../core/reducer'
import { computeContextBudget, formatResetCountdown } from '../core/quota'
import { sliceBoardAt } from '../core/replay'
import { setupFrom, STATIONS, type Setup } from '../core/setup'
import { computeTokenStats, computeTurnSummaries, drawContextSparkline } from '../core/telemetry'
import { LANGUAGES } from '../core/text'
import type { Board, DetailLevel, IdeUsageSummary, QuotaSnapshot, StationId, UserOptions } from '../core/types'

const VALID_STATIONS = new Set<string>(STATIONS.map(s => s.id))
const asStationId = (raw: string | null | undefined): StationId | undefined =>
  raw && VALID_STATIONS.has(raw) ? (raw as StationId) : undefined

const STATION_COLORS: Record<StationId, string> = {
  you: '#ebe6dc',
  model: '#e1ac6e',
  memory: '#62c7ba',
  files: '#7bc47f',
  shell: '#d99058',
  web: '#6ca6e8',
  browser: '#5ec2d6',
  agents: '#f0c595',
  skills: '#b28ce2',
  hooks: '#9ba1ab',
}

const debugBannerEl = document.getElementById('demo-debug-banner') as HTMLElement
const mapEl = document.getElementById('demo-map') as HTMLElement
const brailleEl = document.getElementById('demo-braille') as HTMLPreElement
const feedEl = document.getElementById('demo-feed') as HTMLElement
const nowWhatEl = document.getElementById('demo-now-what') as HTMLElement
const nowMeterEl = document.getElementById('demo-now-meter') as HTMLElement
const quotaEl = document.getElementById('demo-quota') as HTMLElement
const breakdownEl = document.getElementById('demo-breakdown') as HTMLElement
const telemetryEl = document.getElementById('demo-telemetry') as HTMLElement
const turnsEl = document.getElementById('demo-turns') as HTMLElement
const inspectorEl = document.getElementById('demo-inspector') as HTMLElement
const replaySlider = document.getElementById('demo-replay') as HTMLInputElement
const replayLabel = document.getElementById('demo-replay-label') as HTMLElement
const rawJsonEl = document.getElementById('demo-raw') as HTMLElement
const keptJsonEl = document.getElementById('demo-kept') as HTMLElement

const btnPlay = document.getElementById('btn-play') as HTMLButtonElement
const btnRestart = document.getElementById('btn-restart') as HTMLButtonElement
const btnStep = document.getElementById('btn-step') as HTMLButtonElement
const btnView = document.getElementById('btn-view') as HTMLButtonElement
const btnCopy = document.getElementById('btn-copy') as HTMLButtonElement
const selLang = document.getElementById('sel-lang') as HTMLSelectElement
const selTheme = document.getElementById('sel-theme') as HTMLSelectElement
const selLayout = document.getElementById('sel-layout') as HTMLSelectElement
const selMotion = document.getElementById('sel-motion') as HTMLSelectElement
const selDetail = document.getElementById('sel-detail') as HTMLSelectElement
const detailGroupEl = document.getElementById('demo-detail-group') as HTMLElement

let options: UserOptions = {
  language: 'en',
  theme: 'dark',
  layout: 'you-top',
  motion: 'full',
  coreName: 'AGY',
  contextCost: true,
  subagentNames: true,
  detailLevel: 'compact',
}

let setup = setupFrom(options, 'en')
let reducer = new TranscriptReducer(setup)
let idx = 0
let playing = true
let timer: number | null = null
let baseMs = Date.now()
let lastSvg = ''
let viewMode: 'svg' | 'braille' = 'svg'
let selectedStation: StationId | undefined
let selectedStepId: string | undefined
let turnsExpanded = false
let quotaExpanded = false
let replayIndex: number | undefined
let refreshDemoQuota = (): void => {}

quotaEl.addEventListener('click', (event) => {
  const toggle = event.target instanceof Element ? event.target.closest('#demo-quota-toggle') : null
  if (!toggle) return
  quotaExpanded = !quotaExpanded
  refreshDemoQuota()
})

const DEMO_QUOTA: QuotaSnapshot = {
  planName: 'Google AI Pro',
  availableCredits: 950,
  minCredits: 50,
  syncedAtMs: Date.now(),
  pools: [
    { id: 'gemini-3-8-pro', label: 'Gemini 3.8 Pro', remainingPct: 78, usedPct: 22, resetAtMs: Date.now() + 2 * 3_600_000 + 40 * 60_000 },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', remainingPct: 44, usedPct: 56, resetAtMs: Date.now() + 3 * 3_600_000 + 15 * 60_000 },
    { id: 'gemini-3-8-flash', label: 'Gemini 3.8 Flash', remainingPct: 94, usedPct: 6, resetAtMs: Date.now() + 4 * 3_600_000, badge: 'NEW' },
    { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', remainingPct: 100, usedPct: 0 },
  ],
}

const DEMO_IDE_USAGE: IdeUsageSummary = {
  last24h: { inputTokens: 48_000, cacheReadTokens: 412_000, outputTokens: 29_500, totalTokens: 489_500, cacheHitPct: 90, sessions: 4, steps: 26 },
  last7d: { inputTokens: 310_000, cacheReadTokens: 2_650_000, outputTokens: 185_000, totalTokens: 3_145_000, cacheHitPct: 90, sessions: 19, steps: 142 },
  computedAtMs: Date.now(),
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

function pillTone(remainingPct: number): 'good' | 'warn' | 'bad' {
  return remainingPct >= 50 ? 'good' : remainingPct >= 20 ? 'warn' : 'bad'
}

function renderDemoQuota(board: Board, setup: Setup): void {
  if (!setup.showQuota) {
    quotaEl.style.display = 'none'
    quotaEl.textContent = ''
    return
  }

  const nowMs = Date.now()
  const t = setup.t
  const budget = computeContextBudget(board, setup.contextWindowTokens)
  quotaEl.style.display = ''
  quotaEl.textContent = ''

  const card = document.createElement('div')
  card.className = 'quota-card'

  const head = document.createElement('div')
  head.className = 'quota-head'

  const btn = document.createElement('button')
  btn.id = 'demo-quota-toggle'
  btn.className = 'quota-toggle'
  btn.type = 'button'
  btn.setAttribute('aria-expanded', String(quotaExpanded))
  btn.textContent = `${quotaExpanded ? '▾' : '▸'} ${t.quotaTitle}`
  head.appendChild(btn)

  const badges = document.createElement('div')
  badges.className = 'quota-badges'
  if (DEMO_QUOTA.planName) {
    const plan = document.createElement('span')
    plan.className = 'quota-plan'
    plan.textContent = DEMO_QUOTA.planName
    badges.appendChild(plan)
  }
  const primaryPool = DEMO_QUOTA.pools[0]
  if (primaryPool) {
    const pill = document.createElement('span')
    pill.className = `quota-pill ${pillTone(primaryPool.remainingPct)}`
    pill.textContent = `${primaryPool.label}: ${primaryPool.remainingPct}% ${t.remaining}`
    badges.appendChild(pill)
  }
  if (budget) {
    const ctxPill = document.createElement('span')
    ctxPill.className = `quota-pill ${pillTone(budget.remainingPct)}`
    ctxPill.textContent = `Ctx ${budget.remainingPct}% ${t.remaining}`
    badges.appendChild(ctxPill)
  }
  head.appendChild(badges)
  card.appendChild(head)

  if (quotaExpanded) {
    const list = document.createElement('div')
    list.className = 'quota-list'

    const addBarRow = (name: string, valText: string, pctFill: number, tone: 'good' | 'warn' | 'bad'): void => {
      const item = document.createElement('div')
      item.className = 'quota-item'
      const row = document.createElement('div')
      row.className = 'quota-row'
      const nameEl = document.createElement('span')
      nameEl.className = 'quota-name'
      nameEl.textContent = name
      const valEl = document.createElement('span')
      valEl.className = 'quota-val'
      valEl.textContent = valText
      row.append(nameEl, valEl)
      const bar = document.createElement('div')
      bar.className = 'quota-bar'
      const fill = document.createElement('div')
      fill.className = `quota-fill ${tone === 'good' ? '' : tone}`.trim()
      fill.style.width = `${Math.max(0, Math.min(100, pctFill))}%`
      bar.appendChild(fill)
      item.append(row, bar)
      list.appendChild(item)
    }

    if (budget) {
      addBarRow(
        'Context Window',
        `${fmtCompact(budget.usedTokens)} / ${fmtCompact(budget.limitTokens)} · ${budget.remainingPct}% ${t.remaining}`,
        budget.remainingPct,
        pillTone(budget.remainingPct),
      )
    }

    for (const pool of DEMO_QUOTA.pools) {
      const cd = formatResetCountdown(pool.resetAtMs, nowMs)
      const name = pool.badge ? `${pool.label} [${pool.badge}]` : pool.label
      const cdSuffix = cd ? ` · ${t.resetsIn} ${cd}` : ''
      addBarRow(name, `${pool.remainingPct}% ${t.remaining} · ${pool.usedPct}% ${t.used}${cdSuffix}`, pool.remainingPct, pillTone(pool.remainingPct))
    }

    if (setup.dailyTokenBudget > 0) {
      const used24 = DEMO_IDE_USAGE.last24h.totalTokens
      const remTok = Math.max(0, setup.dailyTokenBudget - used24)
      const remPct = Math.max(0, Math.min(100, Math.round((remTok / setup.dailyTokenBudget) * 1000) / 10))
      addBarRow(
        t.dailyBudget,
        `${fmtCompact(used24)} / ${fmtCompact(setup.dailyTokenBudget)} · ${remPct}% ${t.remaining}`,
        remPct,
        pillTone(remPct),
      )
    }

    card.appendChild(list)

    const foot = document.createElement('div')
    foot.className = 'quota-foot'
    const usage24 = document.createElement('span')
    usage24.textContent = `${t.ideUsage24h}: ${fmtCompact(DEMO_IDE_USAGE.last24h.totalTokens)}`
    const usage7d = document.createElement('span')
    usage7d.textContent = `${t.ideUsage7d}: ${fmtCompact(DEMO_IDE_USAGE.last7d.totalTokens)}`
    foot.append(usage24, usage7d)
    if (DEMO_QUOTA.availableCredits !== undefined && DEMO_QUOTA.availableCredits > 0) {
      const cred = document.createElement('span')
      cred.textContent = `Credits: ${DEMO_QUOTA.availableCredits}`
      foot.appendChild(cred)
    }
    card.appendChild(foot)
  }

  quotaEl.appendChild(card)
}
let copyTimer: number | undefined
let lastRawPreview: unknown = { info: 'Waiting for first Antigravity transcript step...' }
let lastKeptPreview: unknown = { entries: [] }

function esc(text: string): string {
  return text.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function clockTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return ''
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function updateKeptPreview(): void {
  const board = reducer.board()
  lastKeptPreview = {
    detailLevel: setup.detailLevel,
    latestEntries: board.entries.slice(-3).map(e => ({
      station: e.station,
      label: e.label,
      status: e.status,
      from: e.from,
      ...(e.stepIdx !== undefined ? { stepIdx: e.stepIdx } : {}),
      ...(e.toolName ? { toolName: e.toolName } : {}),
      ...(e.tokens !== undefined ? { tokens: e.tokens } : {}),
      ...(e.debug ? { debug: e.debug } : {}),
    })),
    counts: board.counts,
    contextPct: board.context,
    model: board.model,
    modelStepsCount: board.modelSteps?.length ?? 0,
  }
}

function rebuildToCurrentIdx(): void {
  const count = Math.max(0, Math.min(DEMO_TIMELINE.length, idx))
  reducer.reset()
  const firstIso = DEMO_TIMELINE[0]?.step.created_at
  const t0 = firstIso ? Date.parse(firstIso) : baseMs
  for (let i = 0; i < count; i++) {
    const item = DEMO_TIMELINE[i]
    if (!item) continue
    const stepTime = item.step.created_at ? Date.parse(item.step.created_at) : t0
    const shiftedMs = baseMs + (stepTime - t0)
    const shiftedCreatedAt = new Date(shiftedMs).toISOString()
    const shiftedContent =
      item.step.content && item.step.type === 'GENERIC'
        ? item.step.content
            .replace(/^Created At: .+$/m, `Created At: ${new Date(shiftedMs - 200).toISOString()}`)
            .replace(/^Completed At: .+$/m, `Completed At: ${new Date(shiftedMs).toISOString()}`)
        : item.step.content
    reducer.push(
      { ...item.step, created_at: shiftedCreatedAt, content: shiftedContent },
      {
        from: item.from,
        subagentLabel: item.subagentLabel,
        agentId: item.from === 'agents' ? 'demo-researcher' : undefined,
        now: shiftedMs,
      },
    )
  }
  updateKeptPreview()
}

function renderDemo(): void {
  setup = setupFrom(options, 'en')
  reducer.updateSetup(setup)
  updateKeptPreview()

  const rawBoard = reducer.board()
  const frame = sliceBoardAt(rawBoard, replayIndex, Date.now())
  const board = frame.board
  const renderNow = frame.cursor.renderNow
  const isLight = setup.theme === 'light'
  const palette = resolvePalette(setup, isLight)
  const renderSetup = { ...setup, theme: isLight ? ('light' as const) : ('dark' as const) }
  const isDetailed = setup.detailLevel !== 'compact'

  document.body.style.background = palette.ground
  document.body.style.color = palette.bone
  document.documentElement.style.setProperty('--ag-dim', palette.ash)
  document.documentElement.style.setProperty('--ag-border', palette.line)
  document.documentElement.style.setProperty('--ag-accent', palette.accent)
  document.documentElement.style.setProperty('--ag-error', palette.red)
  document.documentElement.style.setProperty('--ag-panel', palette.raised)

  if (setup.detailLevel === 'debug') {
    debugBannerEl.style.display = 'flex'
    debugBannerEl.innerHTML = `<span>${esc(setup.t.debugWarning)}</span><button type="button" id="demo-debug-close">×</button>`
  } else {
    debugBannerEl.style.display = 'none'
    debugBannerEl.innerHTML = ''
  }

  const detailLabels: Record<DetailLevel, string> = {
    compact: setup.t.detailCompact,
    verbose: setup.t.detailVerbose,
    debug: setup.t.detailDebug,
  }
  detailGroupEl.querySelectorAll<HTMLButtonElement>('.btn-detail').forEach(btn => {
    const lvl = btn.dataset.detail as DetailLevel | undefined
    if (!lvl) return
    btn.textContent = detailLabels[lvl]
    btn.setAttribute('aria-pressed', String(setup.detailLevel === lvl))
    btn.classList.toggle('is-active', setup.detailLevel === lvl && lvl !== 'debug')
    btn.classList.toggle('is-debug-active', setup.detailLevel === lvl && lvl === 'debug')
  })
  selDetail.value = setup.detailLevel

  if (viewMode === 'braille') {
    mapEl.style.display = 'none'
    brailleEl.style.display = 'block'
    brailleEl.textContent = drawBrailleMap(board, renderNow, renderSetup)
  } else {
    brailleEl.style.display = 'none'
    mapEl.style.display = 'block'
    const svg = drawMap(board, renderNow, renderSetup, { selectedStation })
    if (svg !== lastSvg) {
      mapEl.innerHTML = svg
      lastSvg = svg
    }
  }

  replaySlider.max = String(frame.cursor.total)
  replaySlider.value = String(frame.cursor.index)
  replayLabel.textContent = frame.cursor.isLive ? '● Live' : `${frame.cursor.index}/${frame.cursor.total}`

  const parts = nowParts(board, setup.t)
  nowWhatEl.textContent = parts.what
  nowMeterEl.textContent = parts.meter

  refreshDemoQuota = () => renderDemoQuota(board, setup)
  refreshDemoQuota()

  const bd = computeBreakdown(board, setup)
  if (bd.shares.length === 0) {
    breakdownEl.innerHTML = ''
  } else {
    const bdTimeLabel = bd.totalTimeMs > 0 ? formatMs(bd.totalTimeMs, setup.t) : '—'
    const legendHtml = isDetailed
      ? `<div class="bd-legend">${bd.shares
          .map(sh => {
            const color = Object.hasOwn(STATION_COLORS, sh.station) ? STATION_COLORS[sh.station] : palette.accent
            const isSel = selectedStation === sh.station
            const metric =
              bd.totalTimeMs > 0
                ? `${sh.timePct}% · ${sh.timeMs > 0 ? formatMs(sh.timeMs, setup.t) : '—'}`
                : `${sh.count}×`
            return `<button type="button" class="legend-pill${isSel ? ' is-selected' : ''}" data-station="${esc(sh.station)}"><span class="legend-dot" style="background:${color}"></span><span>${esc(sh.stationName)} ${esc(metric)}</span></button>`
          })
          .join('')}</div>`
      : ''

    breakdownEl.innerHTML = `
      <div class="bd-head">${bd.turns}t · ${bd.totalCalls}× · ${esc(bdTimeLabel)} · ${formatTokens(bd.totalTokens)} tok</div>
      <div class="bd-bar">${bd.shares
        .map(sh => {
          const color = Object.hasOwn(STATION_COLORS, sh.station) ? STATION_COLORS[sh.station] : palette.accent
          return `<button type="button" class="bd-seg" data-station="${esc(sh.station)}" style="flex:${Math.max(1, sh.timePct || sh.count)} 1 0;background:${color}" title="${esc(sh.stationName)}: ${sh.timePct}%"></button>`
        })
        .join('')}</div>
      ${legendHtml}
    `
  }

  const ts = isDetailed ? computeTokenStats(board) : undefined
  if (ts && ts.steps > 0) {
    const spark = drawContextSparkline(ts, palette)
    telemetryEl.style.display = 'block'
    telemetryEl.innerHTML = `
      <div class="telemetry-stats">
        <span><strong>${esc(formatTokens(ts.latestTotalContext))}</strong> ctx · ${esc(setup.t.cacheHit)} <strong>${ts.latestCacheHitPct}%</strong> · in ${esc(formatTokens(ts.latestInput))} · out ${esc(formatTokens(ts.latestOutput))}</span>
        <span>peak ${esc(formatTokens(ts.peakContextTokens))}${ts.compactions > 0 ? ` · ${ts.compactions}× ckpt` : ''}</span>
      </div>
      ${spark ? `<div class="telemetry-spark">${spark}</div>` : ''}
      <div class="telemetry-stats"><span>Σ in ${esc(formatTokens(ts.totalInput))} · ${esc(setup.t.cacheHit)} ${ts.overallCacheHitPct}% · out ${esc(formatTokens(ts.totalOutput))}</span><span>${ts.steps} steps</span></div>
    `
  } else {
    telemetryEl.style.display = 'none'
    telemetryEl.innerHTML = ''
  }

  const turns = isDetailed ? computeTurnSummaries(board, setup) : undefined
  if (turns && turns.length > 0) {
    turnsEl.style.display = 'block'
    const newestFirst = [...turns].reverse()
    const listHtml = turnsExpanded
      ? `<div class="turns-list">${newestFirst
          .map(t => {
            const title = t.turnNumber === 0 ? 'Pre' : `T${t.turnNumber}`
            const stStr = t.topStations.map(st => `${st.stationName}×${st.count}`).join(', ')
            const dur = t.isActive && frame.cursor.isLive ? setup.t.running : t.durationMs > 0 ? formatMs(t.durationMs, setup.t) : '—'
            const tok = t.tokensAdded > 0 ? ` · +${formatTokens(t.tokensAdded)}` : ''
            const err = t.faultCount > 0 ? ` · ${t.faultCount} err` : ''
            return `<div class="turn-row${t.isActive ? ' is-active' : ''}"><span><strong>${esc(title)}</strong>${stStr ? ` · ${esc(stStr)}` : ''}</span><span>${t.callCount}× · ${esc(dur)}${esc(tok)}${esc(err)}</span></div>`
          })
          .join('')}</div>`
      : ''
    turnsEl.innerHTML = `
      <button type="button" class="turns-toggle" id="demo-turns-toggle">
        <span>${turnsExpanded ? '▾' : '▸'} ${esc(setup.t.turnsTitle)} (${turns.length})</span>
        <span>${turnsExpanded ? '−' : '+'}</span>
      </button>
      ${listHtml}
    `
  } else {
    turnsEl.style.display = 'none'
    turnsEl.innerHTML = ''
  }

  if (selectedStation) {
    const ins = inspectStation(board, selectedStation, setup)
    const insTimeLabel = ins.totalTimeMs > 0 ? formatMs(ins.totalTimeMs, setup.t) : '—'
    inspectorEl.style.display = 'block'
    inspectorEl.innerHTML = `
      <div class="ins-head">
        <strong>${esc(ins.stationName)} (${ins.callSharePct}%)</strong>
        <button type="button" id="demo-ins-close">×</button>
      </div>
      <div class="ins-meta">${ins.count}× · ${esc(insTimeLabel)}${ins.tokens > 0 ? ` · +${formatTokens(ins.tokens)}` : ''}</div>
    `
  } else {
    inspectorEl.style.display = 'none'
    inspectorEl.innerHTML = ''
  }

  const prevScrollTop = isDetailed ? feedEl.scrollTop : 0
  feedEl.classList.toggle('is-detailed', isDetailed)
  const rows = foldRows(filterBoardByStation(board, selectedStation), isDetailed ? VERBOSE_LIST_ROWS : 16, setup.subagentNames, isDetailed)
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
        const timeText = isRunning ? setup.t.running : r.tookMs > 0 ? formatMs(r.tookMs, setup.t) : '—'
        const cost = setup.contextCost && r.tokens !== undefined ? ` ${r.isShared ? '~' : ''}+${formatTokens(r.tokens)}` : ''
        const times = r.times > 1 ? ` +${r.times - 1}` : ''
        const stepStr = e.stepIdx !== undefined ? esc(String(e.stepIdx)) : '—'
        const tsHtml = isDetailed ? `<span class="row-ts">${esc(clockTime(e.startedAt))}${e.stepIdx !== undefined ? ` #${stepStr}` : ''}</span>` : ''
        const toolHtml = isDetailed && e.toolName && e.toolName !== e.label ? `<span class="row-tool">${esc(e.toolName)}</span>` : ''
        const cardOpen = isDetailed && selectedStepId === e.id
        let cardHtml = ''
        if (cardOpen) {
          const dbg = setup.detailLevel === 'debug' ? e.debug : undefined
          cardHtml = `<div class="step-card${e.status === 'err' || e.status === 'block' ? ' is-err' : ''}">
            <div class="step-card-grid">
              <span>step ${e.stepIdx !== undefined ? `#${stepStr}` : '—'}</span>
              <span>station ${esc(setup.t.stations[e.station])}</span>
              <span>status ${esc(e.status)}</span>
              ${e.toolName ? `<span>tool ${esc(e.toolName)}</span>` : ''}
              <span>origin ${esc(e.from ?? 'core')}${e.agentName ? ` (${esc(e.agentName)})` : ''}</span>
            </div>
            ${dbg?.lineRange ? `<div class="step-debug-block"><span class="step-debug-key">lines</span><span>${esc(dbg.lineRange)}</span></div>` : ''}
            ${dbg?.args ? `<div class="step-debug-block"><span class="step-debug-key">args</span><span>${esc(dbg.args)}</span></div>` : ''}
            ${dbg?.error ? `<div class="step-debug-block is-err"><span class="step-debug-key">error</span><span>${esc(dbg.error)}</span></div>` : ''}
            ${dbg?.result ? `<div class="step-debug-block"><span class="step-debug-key">result</span><span>${esc(dbg.result)}</span></div>` : ''}
            ${dbg?.thinking ? `<div class="step-debug-block"><span class="step-debug-key">thinking</span><span>${esc(dbg.thinking)}</span></div>` : ''}
          </div>`
        }
        return `<div class="row ${cls}${isDetailed ? ' is-clickable' : ''}" data-row-id="${esc(e.id)}">
          <span class="row-mark">${mark}</span>
          ${tsHtml}
          <span class="row-station">${esc(setup.t.stations[e.station])}</span>
          ${toolHtml}
          <span class="row-label">${esc(e.label)}${times}</span>
          <span class="row-meta">${esc(timeText + cost)}</span>
        </div>${cardHtml}`
      })
      .join('')
    if (isDetailed) {
      feedEl.scrollTop = prevScrollTop
    }
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
    ...(item.step.thinking ? { thinking: item.step.thinking.slice(0, 140) } : {}),
    ...(item.step.content ? { content: item.step.content.slice(0, 140) } : {}),
    ...(item.step.error ? { error: item.step.error } : {}),
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
  replayIndex = undefined
  selectedStepId = undefined
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

debugBannerEl.addEventListener('click', ev => {
  if (!(ev.target as Element | null)?.closest('#demo-debug-close')) return
  options = { ...options, detailLevel: 'verbose' }
  selDetail.value = 'verbose'
  renderDemo()
})

breakdownEl.addEventListener('click', ev => {
  const btn = (ev.target as Element | null)?.closest('[data-station]') as HTMLElement | null
  const st = asStationId(btn?.dataset.station)
  if (!st) return
  selectedStation = selectedStation === st ? undefined : st
  lastSvg = ''
  renderDemo()
})

turnsEl.addEventListener('click', ev => {
  if (!(ev.target as Element | null)?.closest('#demo-turns-toggle')) return
  turnsExpanded = !turnsExpanded
  renderDemo()
})

inspectorEl.addEventListener('click', ev => {
  if (!(ev.target as Element | null)?.closest('#demo-ins-close')) return
  selectedStation = undefined
  lastSvg = ''
  renderDemo()
})

feedEl.addEventListener('click', ev => {
  if (setup.detailLevel === 'compact') return
  const row = (ev.target as Element | null)?.closest('.row.is-clickable') as HTMLElement | null
  const id = row?.dataset.rowId
  if (!id) return
  selectedStepId = selectedStepId === id ? undefined : id
  renderDemo()
})

mapEl.addEventListener('click', ev => {
  const target = (ev.target as Element | null)?.closest('.ag-station') as Element | null
  const station = asStationId(target?.getAttribute('data-station'))
  if (!station) return
  selectedStation = selectedStation === station ? undefined : station
  lastSvg = ''
  renderDemo()
})

replaySlider.addEventListener('input', () => {
  const val = Number(replaySlider.value)
  if (!Number.isFinite(val)) return
  const total = reducer.board().entries.length
  replayIndex = val >= total ? undefined : Math.max(0, Math.floor(val))
  lastSvg = ''
  renderDemo()
})

btnView.addEventListener('click', () => {
  viewMode = viewMode === 'svg' ? 'braille' : 'svg'
  btnView.textContent = viewMode === 'svg' ? 'Braille' : 'SVG'
  lastSvg = ''
  renderDemo()
})

btnCopy.addEventListener('click', () => {
  const frame = sliceBoardAt(reducer.board(), replayIndex, Date.now())
  const report = formatMarkdownReport(frame.board, frame.cursor.renderNow, setup)
  void Promise.resolve(navigator.clipboard?.writeText(report))
    .then(() => {
      btnCopy.textContent = 'Copied!'
      if (copyTimer !== undefined) window.clearTimeout(copyTimer)
      copyTimer = window.setTimeout(() => {
        btnCopy.textContent = 'Copy MD'
      }, 1200)
    })
    .catch(() => {})
})

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
function setDemoDetail(next: DetailLevel): void {
  const prevDetail = setup.detailLevel
  options = { ...options, detailLevel: next }
  setup = setupFrom(options, 'en')
  reducer.updateSetup(setup)
  if (prevDetail !== 'debug' && next === 'debug') {
    rebuildToCurrentIdx()
  }
  renderDemo()
}

detailGroupEl.addEventListener('click', ev => {
  const btn = (ev.target as Element | null)?.closest('.btn-detail') as HTMLButtonElement | null
  const lvl = btn?.dataset.detail as DetailLevel | undefined
  if (lvl === 'compact' || lvl === 'verbose' || lvl === 'debug') {
    setDemoDetail(lvl)
  }
})

selDetail.addEventListener('change', () => {
  const lvl = selDetail.value as DetailLevel
  if (lvl === 'compact' || lvl === 'verbose' || lvl === 'debug') {
    setDemoDetail(lvl)
  }
})

renderDemo()
schedule()
