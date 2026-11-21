import type { StationId } from '../core/types'
import type { WebviewCommandMessage, WebviewStateMessage } from './protocol'

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewCommandMessage): void
}

const vscode = acquireVsCodeApi()
const app = document.getElementById('app') as HTMLElement

let state: WebviewStateMessage | null = null
let lastSvg = ''
let lastOptionsFingerprint = ''
let lastSessionKey = ''
let openRowId: string | undefined
let breakdownMode: 'time' | 'tokens' = 'time'
let copyFlashTimer: number | undefined

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

const VALID_STATIONS = new Set<string>(Object.keys(STATION_COLORS))

function asStationId(raw: string | null | undefined): StationId | undefined {
  return raw && VALID_STATIONS.has(raw) ? (raw as StationId) : undefined
}

function escapeHtml(text: string): string {
  return text.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

function formatLiveDuration(startedAt: number, msUnit: string, secUnit: string): string {
  const ms = Math.max(1, Date.now() - startedAt)
  if (ms < 1000) return `${Math.round(ms)} ${msUnit}`
  const s = Math.round(ms / 100) / 10
  return `${s.toFixed(1)} ${secUnit}`
}

function formatCompactMs(ms: number, msUnit: string, secUnit: string): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ${msUnit}`
  return `${(ms / 1000).toFixed(1)} ${secUnit}`
}

function formatCompactTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens))
  const k = Math.round(tokens / 1000)
  return k < 1000 ? `${k}k` : `${Math.round(tokens / 1_000_000)}M`
}

function applyThemeVars(s: WebviewStateMessage): void {
  const root = document.documentElement.style
  const sizePx = s.textSize === 'caption' ? '11px' : s.textSize === 'body' ? '13px' : '12px'
  root.setProperty('--ag-text-size', sizePx)
  root.setProperty('--ag-accent', s.palette.accent)
  root.setProperty('--ag-error', s.palette.red)
  if (s.background === 'solid') {
    root.setProperty('--ag-bg', s.palette.ground)
    root.setProperty('--ag-fg', s.palette.bone)
    root.setProperty('--ag-dim', s.palette.ash)
    root.setProperty('--ag-border', s.palette.line)
  } else {
    root.removeProperty('--ag-bg')
    root.removeProperty('--ag-fg')
    root.removeProperty('--ag-dim')
    root.removeProperty('--ag-border')
  }
}

function ensureShell(): {
  select: HTMLSelectElement
  btnZoomOut: HTMLButtonElement
  btnZoomIn: HTMLButtonElement
  btnLayout: HTMLButtonElement
  btnViewMode: HTMLButtonElement
  btnCopy: HTMLButtonElement
  btnHide: HTMLButtonElement
  mapWrap: HTMLElement
  mapStage: HTMLElement
  brailleStage: HTMLPreElement
  replayBar: HTMLElement
  btnPrevTurn: HTMLButtonElement
  replaySlider: HTMLInputElement
  btnNextTurn: HTMLButtonElement
  btnReplayLive: HTMLButtonElement
  nowWhat: HTMLElement
  nowMeter: HTMLElement
  breakdownWrap: HTMLElement
  inspectorWrap: HTMLElement
  feed: HTMLElement
} {
  const root = app.querySelector('.shell-ready')
  if (!root) {
    app.innerHTML = `
      <div class="toolbar shell-ready">
        <select class="session-select" id="ag-session"></select>
        <div class="controls">
          <button class="btn" id="ag-zoom-out" type="button">−</button>
          <button class="btn" id="ag-zoom-in" type="button">+</button>
          <button class="btn" id="ag-layout" type="button">⇅</button>
          <button class="btn" id="ag-view-mode" type="button" title="Toggle SVG / Braille">⠿</button>
          <button class="btn" id="ag-copy" type="button" title="Copy Markdown Snapshot">📋</button>
          <button class="btn" id="ag-hide" type="button">▾</button>
        </div>
      </div>
      <div class="map-wrap" id="ag-map-wrap">
        <div class="map-stage" id="ag-map-stage"></div>
        <pre class="braille-stage" id="ag-braille-stage" style="display:none"></pre>
      </div>
      <div class="replay-bar" id="ag-replay-bar" style="display:none">
        <button class="btn" id="ag-prev-turn" type="button" title="Previous turn">⏮</button>
        <input class="replay-slider" id="ag-replay-slider" type="range" min="0" max="0" value="0" />
        <button class="btn" id="ag-next-turn" type="button" title="Next turn">⏭</button>
        <button class="btn replay-live" id="ag-replay-live" type="button">Live</button>
      </div>
      <div class="now-bar">
        <div class="now-what" id="ag-now-what"></div>
        <div class="now-meter" id="ag-now-meter"></div>
      </div>
      <div class="breakdown-wrap" id="ag-breakdown-wrap" style="display:none"></div>
      <div id="ag-inspector-wrap" style="display:none"></div>
      <div class="feed" id="ag-feed"></div>
    `
    const select = document.getElementById('ag-session') as HTMLSelectElement
    const btnZoomOut = document.getElementById('ag-zoom-out') as HTMLButtonElement
    const btnZoomIn = document.getElementById('ag-zoom-in') as HTMLButtonElement
    const btnLayout = document.getElementById('ag-layout') as HTMLButtonElement
    const btnViewMode = document.getElementById('ag-view-mode') as HTMLButtonElement
    const btnCopy = document.getElementById('ag-copy') as HTMLButtonElement
    const btnHide = document.getElementById('ag-hide') as HTMLButtonElement
    const mapStage = document.getElementById('ag-map-stage') as HTMLElement
    const btnPrevTurn = document.getElementById('ag-prev-turn') as HTMLButtonElement
    const replaySlider = document.getElementById('ag-replay-slider') as HTMLInputElement
    const btnNextTurn = document.getElementById('ag-next-turn') as HTMLButtonElement
    const btnReplayLive = document.getElementById('ag-replay-live') as HTMLButtonElement

    select.addEventListener('change', () => {
      vscode.postMessage({ type: 'selectSession', sessionId: select.value })
    })
    btnZoomOut.addEventListener('click', () => {
      if (state) vscode.postMessage({ type: 'setZoom', zoom: Math.max(0.6, state.zoom - 0.1) })
    })
    btnZoomIn.addEventListener('click', () => {
      if (state) vscode.postMessage({ type: 'setZoom', zoom: Math.min(1.4, state.zoom + 0.1) })
    })
    btnLayout.addEventListener('click', () => {
      vscode.postMessage({ type: 'toggleLayout' })
    })
    btnViewMode.addEventListener('click', () => {
      if (!state) return
      vscode.postMessage({ type: 'setViewMode', viewMode: state.viewMode === 'svg' ? 'braille' : 'svg' })
    })
    btnCopy.addEventListener('click', () => {
      if (!state?.markdownReport) return
      vscode.postMessage({ type: 'copyMarkdown' })
      void Promise.resolve(navigator.clipboard?.writeText(state.markdownReport)).catch(() => {})
      btnCopy.textContent = '✓'
      if (copyFlashTimer !== undefined) window.clearTimeout(copyFlashTimer)
      copyFlashTimer = window.setTimeout(() => {
        btnCopy.textContent = '📋'
      }, 1200)
    })
    btnHide.addEventListener('click', () => {
      if (state) vscode.postMessage({ type: 'setHidden', hidden: !state.hidden })
    })
    mapStage.addEventListener('click', ev => {
      const target = (ev.target as Element | null)?.closest('.ag-station') as Element | null
      const station = asStationId(target?.getAttribute('data-station'))
      if (!station || !state) return
      vscode.postMessage({
        type: 'selectStation',
        station: state.selectedStation === station ? undefined : station,
      })
    })
    replaySlider.addEventListener('input', () => {
      if (!state) return
      const val = Number(replaySlider.value)
      if (!Number.isFinite(val)) return
      vscode.postMessage({
        type: 'setReplayIndex',
        index: val >= state.replay.total ? undefined : val,
      })
    })
    btnPrevTurn.addEventListener('click', () => {
      if (!state) return
      const turns = state.replay.turnIndices
      const cur = state.replay.index
      const prev = [...turns].reverse().find(t => t < cur)
      vscode.postMessage({ type: 'setReplayIndex', index: prev ?? 0 })
    })
    btnNextTurn.addEventListener('click', () => {
      if (!state) return
      const turns = state.replay.turnIndices
      const cur = state.replay.index
      const next = turns.find(t => t > cur)
      vscode.postMessage({
        type: 'setReplayIndex',
        index: next !== undefined && next < state.replay.total ? next : undefined,
      })
    })
    btnReplayLive.addEventListener('click', () => {
      vscode.postMessage({ type: 'setReplayIndex', index: undefined })
    })
  }
  return {
    select: document.getElementById('ag-session') as HTMLSelectElement,
    btnZoomOut: document.getElementById('ag-zoom-out') as HTMLButtonElement,
    btnZoomIn: document.getElementById('ag-zoom-in') as HTMLButtonElement,
    btnLayout: document.getElementById('ag-layout') as HTMLButtonElement,
    btnViewMode: document.getElementById('ag-view-mode') as HTMLButtonElement,
    btnCopy: document.getElementById('ag-copy') as HTMLButtonElement,
    btnHide: document.getElementById('ag-hide') as HTMLButtonElement,
    mapWrap: document.getElementById('ag-map-wrap') as HTMLElement,
    mapStage: document.getElementById('ag-map-stage') as HTMLElement,
    brailleStage: document.getElementById('ag-braille-stage') as HTMLPreElement,
    replayBar: document.getElementById('ag-replay-bar') as HTMLElement,
    btnPrevTurn: document.getElementById('ag-prev-turn') as HTMLButtonElement,
    replaySlider: document.getElementById('ag-replay-slider') as HTMLInputElement,
    btnNextTurn: document.getElementById('ag-next-turn') as HTMLButtonElement,
    btnReplayLive: document.getElementById('ag-replay-live') as HTMLButtonElement,
    nowWhat: document.getElementById('ag-now-what') as HTMLElement,
    nowMeter: document.getElementById('ag-now-meter') as HTMLElement,
    breakdownWrap: document.getElementById('ag-breakdown-wrap') as HTMLElement,
    inspectorWrap: document.getElementById('ag-inspector-wrap') as HTMLElement,
    feed: document.getElementById('ag-feed') as HTMLElement,
  }
}

function renderBreakdown(wrap: HTMLElement, s: WebviewStateMessage): void {
  const b = s.breakdown
  if (!b || b.shares.length === 0) {
    wrap.style.display = 'none'
    return
  }
  wrap.style.display = 'flex'
  const hasTokens = b.totalTokens > 0
  if (breakdownMode === 'tokens' && !hasTokens) breakdownMode = 'time'
  const useTokens = breakdownMode === 'tokens' && hasTokens
  const items = b.shares.filter(sh => (useTokens ? sh.tokens > 0 : sh.timeMs > 0 || sh.count > 0))
  const totalLabel = useTokens
    ? `${formatCompactTokens(b.totalTokens)} tok`
    : formatCompactMs(b.totalTimeMs, s.strings.msUnit, s.strings.secUnit)

  const segmentsHtml = items
    .map(sh => {
      const pct = useTokens ? sh.tokenPct : b.totalTimeMs > 0 ? sh.timePct : Math.max(5, Math.round((sh.count / Math.max(1, b.totalCalls)) * 100))
      const color = Object.hasOwn(STATION_COLORS, sh.station) ? STATION_COLORS[sh.station] : s.palette.accent
      const isSelected = s.selectedStation === sh.station
      const tip = useTokens
        ? `${sh.stationName}: ${sh.tokenPct}% (${formatCompactTokens(sh.tokens)})`
        : `${sh.stationName}: ${sh.timePct}% (${formatCompactMs(sh.timeMs, s.strings.msUnit, s.strings.secUnit)})`
      return `<button type="button" class="breakdown-seg${isSelected ? ' is-selected' : ''}" data-station="${escapeHtml(sh.station)}" style="flex:${Math.max(1, pct)} 1 0;background:${color}" title="${escapeHtml(tip)}"></button>`
    })
    .join('')

  const modeButtonHtml = hasTokens
    ? `<button type="button" class="btn" id="ag-bd-mode">${useTokens ? 'Tokens' : 'Time'}</button>`
    : ''

  wrap.innerHTML = `
    <div class="breakdown-head">
      <span>${b.turns}t · ${b.totalCalls}× · ${escapeHtml(totalLabel)}</span>
      ${modeButtonHtml}
    </div>
    <div class="breakdown-bar">${segmentsHtml}</div>
  `
  const modeBtn = document.getElementById('ag-bd-mode')
  modeBtn?.addEventListener('click', () => {
    breakdownMode = breakdownMode === 'time' ? 'tokens' : 'time'
    if (state) renderBreakdown(wrap, state)
  })
  wrap.querySelectorAll<HTMLButtonElement>('.breakdown-seg').forEach(seg => {
    seg.addEventListener('click', () => {
      const st = asStationId(seg.dataset.station)
      if (!st || !state) return
      vscode.postMessage({
        type: 'selectStation',
        station: state.selectedStation === st ? undefined : st,
      })
    })
  })
}

function renderInspector(wrap: HTMLElement, s: WebviewStateMessage): void {
  const ins = s.inspection
  if (!ins) {
    wrap.style.display = 'none'
    return
  }
  wrap.style.display = 'block'
  const topHtml = ins.topLabels
    .map(
      item => `<div class="inspector-top-row">
        <span class="inspector-top-label">${escapeHtml(item.label)}</span>
        <span>×${item.count} · ${escapeHtml(formatCompactMs(item.timeMs, s.strings.msUnit, s.strings.secUnit))}</span>
      </div>`,
    )
    .join('')

  wrap.innerHTML = `
    <div class="inspector-card">
      <div class="inspector-head">
        <span class="inspector-title">${escapeHtml(ins.stationName)} (${ins.callSharePct}%)</span>
        <button type="button" class="btn" id="ag-ins-close" title="Clear filter">×</button>
      </div>
      <div class="inspector-metrics">
        <span>${ins.count}×</span>
        <span>${escapeHtml(formatCompactMs(ins.totalTimeMs, s.strings.msUnit, s.strings.secUnit))}</span>
        <span>avg ${escapeHtml(formatCompactMs(ins.avgTimeMs, s.strings.msUnit, s.strings.secUnit))}</span>
        ${ins.tokens > 0 ? `<span>+${escapeHtml(formatCompactTokens(ins.tokens))}</span>` : ''}
        ${ins.faultCount > 0 ? `<span style="color:var(--ag-error)">${ins.faultCount} err</span>` : ''}
      </div>
      ${topHtml ? `<div class="inspector-top">${topHtml}</div>` : ''}
    </div>
  `
  document.getElementById('ag-ins-close')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'selectStation', station: undefined })
  })
}

function renderFeed(feedEl: HTMLElement, s: WebviewStateMessage): void {
  if (s.rows.length === 0) {
    feedEl.innerHTML = `<div class="feed-empty">${escapeHtml(s.strings.nothingYet)}</div>`
    return
  }

  feedEl.innerHTML = s.rows
    .map(r => {
      const isSwitch = r.mark === 'switch'
      const mark = isSwitch ? '◆' : r.isRunning ? '●' : r.status === 'ok' ? '·' : '✕'
      const cls = ['row']
      if (r.isRunning) cls.push('is-running')
      else if (isSwitch) cls.push('is-switch')
      else if (r.status === 'err' || r.status === 'block') cls.push('is-error')
      else cls.push('is-ok')
      if (r.formattedTime === '—') cls.push('is-moment')
      const isOpen = r.isLong && openRowId === r.id
      if (isOpen) cls.push('is-open')

      const timesHtml = r.times > 1 ? `<span class="row-times">+${r.times - 1}</span>` : ''
      const expandHtml = r.isLong
        ? `<button class="row-expand" data-row-id="${escapeHtml(r.id)}" type="button">${isOpen ? '▾' : '▸'}</button>`
        : ''
      const timeText =
        r.isRunning && s.replay.isLive
          ? formatLiveDuration(r.startedAt, s.strings.msUnit, s.strings.secUnit)
          : r.formattedTime
      const metaText = `${timeText}${r.formattedCost ? ` ${r.formattedCost}` : ''}`

      return `<div class="${cls.join(' ')}" data-started="${r.startedAt}" data-running="${r.isRunning && s.replay.isLive ? '1' : '0'}" data-cost="${escapeHtml(r.formattedCost)}">
        <div class="row-main">
          <span class="row-mark">${mark}</span>
          <span class="row-station">${escapeHtml(r.stationName)}</span>
          <span class="row-label">${escapeHtml(r.label)}</span>
          ${timesHtml}
        </div>
        ${expandHtml}
        <span class="row-meta">${escapeHtml(metaText)}</span>
      </div>`
    })
    .join('')

  feedEl.querySelectorAll<HTMLButtonElement>('.row-expand').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.rowId
      openRowId = openRowId === id ? undefined : id
      if (state) renderFeed(feedEl, state)
    })
  })
}

function render(s: WebviewStateMessage): void {
  const sessionKey = `${s.mode}:${s.activeSessionId ?? ''}`
  if (sessionKey !== lastSessionKey) {
    lastSessionKey = sessionKey
    openRowId = undefined
  }
  state = s
  applyThemeVars(s)
  const ui = ensureShell()

  const selectedVal = s.mode === 'demo' ? 'demo' : s.mode === 'auto' ? 'auto' : (s.activeSessionId ?? 'auto')
  const optionsList: Array<{ value: string; label: string }> = [
    { value: 'auto', label: s.strings.autoLabel },
    { value: 'demo', label: s.strings.demoLabel },
    ...s.sessions.map(sess => ({
      value: sess.id,
      label: `${sess.running ? '● ' : ''}${sess.title}`,
    })),
  ]
  const fingerprint = JSON.stringify(optionsList)
  if (fingerprint !== lastOptionsFingerprint) {
    lastOptionsFingerprint = fingerprint
    ui.select.textContent = ''
    for (const opt of optionsList) {
      const el = document.createElement('option')
      el.value = opt.value
      el.textContent = opt.label
      ui.select.appendChild(el)
    }
  }
  ui.select.value = selectedVal

  ui.btnZoomOut.title = s.strings.zoomOut
  ui.btnZoomIn.title = s.strings.zoomIn
  ui.btnLayout.textContent = s.layout === 'you-top' ? '↓' : '↑'
  ui.btnViewMode.classList.toggle('is-active', s.viewMode === 'braille')
  ui.btnViewMode.textContent = s.viewMode === 'braille' ? '◇' : '⠿'
  ui.btnHide.title = s.hidden ? s.strings.showMap : s.strings.hideMap
  ui.btnHide.textContent = s.hidden ? '▸' : '▾'

  ui.mapWrap.classList.toggle('is-hidden', s.hidden)
  if (!s.hidden) {
    if (s.viewMode === 'braille') {
      ui.mapStage.style.display = 'none'
      ui.brailleStage.style.display = 'block'
      ui.brailleStage.textContent = s.brailleMap
    } else {
      ui.brailleStage.style.display = 'none'
      ui.mapStage.style.display = 'block'
      ui.mapStage.style.maxWidth = `${Math.round(460 * s.zoom)}px`
      if (s.svg !== lastSvg) {
        ui.mapStage.innerHTML = s.svg
        lastSvg = s.svg
      }
    }
  }

  ui.replayBar.style.display = s.replay.total > 0 ? 'flex' : 'none'
  ui.replaySlider.max = String(s.replay.total)
  ui.replaySlider.value = String(s.replay.index)
  ui.btnReplayLive.classList.toggle('is-active', !s.replay.isLive)
  ui.btnReplayLive.textContent = s.replay.isLive ? '● Live' : `${s.replay.index}/${s.replay.total}`

  ui.nowWhat.textContent = s.nowWhat
  ui.nowMeter.textContent = s.nowMeter

  renderBreakdown(ui.breakdownWrap, s)
  renderInspector(ui.inspectorWrap, s)
  renderFeed(ui.feed, s)
}

window.addEventListener('message', event => {
  const msg = event.data as WebviewStateMessage
  if (msg?.type === 'state') {
    render(msg)
  }
})

setInterval(() => {
  if (!state || !state.replay.isLive) return
  const runningEls = document.querySelectorAll<HTMLElement>('.row[data-running="1"]')
  runningEls.forEach(el => {
    const startedAt = Number(el.dataset.started)
    const cost = el.dataset.cost ?? ''
    const metaEl = el.querySelector('.row-meta')
    if (metaEl && Number.isFinite(startedAt) && state) {
      const tStr = formatLiveDuration(startedAt, state.strings.msUnit, state.strings.secUnit)
      metaEl.textContent = `${tStr}${cost ? ` ${cost}` : ''}`
    }
  })
}, 250)

vscode.postMessage({ type: 'ready' })
