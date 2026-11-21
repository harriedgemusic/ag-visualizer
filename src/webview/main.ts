import type { DetailLevel, StationId } from '../core/types'
import type { FeedRowPayload, WebviewCommandMessage, WebviewStateMessage } from './protocol'

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
let selectedStepId: string | undefined
let turnsExpanded = false
let quotaExpanded = true
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

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function pad3(n: number): string {
  if (n < 10) return `00${n}`
  if (n < 100) return `0${n}`
  return String(n)
}

function formatClockTime(ts: number, withMs = false): string {
  if (!Number.isFinite(ts) || ts <= 0) return ''
  const d = new Date(ts)
  const base = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  return withMs ? `${base}.${pad3(d.getMilliseconds())}` : base
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
  if (!Number.isFinite(tokens) || tokens < 0) return '0'
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`
  const m = tokens / 1_000_000
  return m < 10 ? `${m.toFixed(1)}M` : `${Math.round(m)}M`
}

function formatCountdown(resetAtMs: number | undefined, nowMs: number): string {
  if (resetAtMs === undefined || !Number.isFinite(resetAtMs)) return ''
  const diffMs = resetAtMs - nowMs
  if (diffMs <= 0) return ''
  const totalMin = Math.floor(diffMs / 60_000)
  if (totalMin < 1) return '<1m'
  const hours = Math.floor(totalMin / 60)
  const mins = totalMin % 60
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const remH = hours % 24
    return remH > 0 ? `${days}d ${remH}h` : `${days}d`
  }
  return hours > 0 ? (mins > 0 ? `${hours}h ${mins}m` : `${hours}h`) : `${mins}m`
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
  detailGroup: HTMLElement
  debugBanner: HTMLElement
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
  quotaWrap: HTMLElement
  breakdownWrap: HTMLElement
  telemetryWrap: HTMLElement
  turnsWrap: HTMLElement
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
      <div class="detail-bar" id="ag-detail-group" role="group" aria-label="Detail level">
        <button class="btn-detail" data-detail="compact" type="button">Compact</button>
        <button class="btn-detail" data-detail="verbose" type="button">Verbose</button>
        <button class="btn-detail" data-detail="debug" type="button">Debug</button>
      </div>
      <div class="debug-banner" id="ag-debug-banner" style="display:none"></div>
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
      <div id="ag-quota-wrap" style="display:none"></div>
      <div class="breakdown-wrap" id="ag-breakdown-wrap" style="display:none"></div>
      <div id="ag-telemetry-wrap" style="display:none"></div>
      <div id="ag-turns-wrap" style="display:none"></div>
      <div id="ag-inspector-wrap" style="display:none"></div>
      <div class="feed" id="ag-feed"></div>
    `
    const select = document.getElementById('ag-session') as HTMLSelectElement
    const detailGroup = document.getElementById('ag-detail-group') as HTMLElement
    const debugBanner = document.getElementById('ag-debug-banner') as HTMLElement
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
    const breakdownWrap = document.getElementById('ag-breakdown-wrap') as HTMLElement
    const quotaWrap = document.getElementById('ag-quota-wrap') as HTMLElement
    const turnsWrap = document.getElementById('ag-turns-wrap') as HTMLElement
    const inspectorWrap = document.getElementById('ag-inspector-wrap') as HTMLElement
    const feedEl = document.getElementById('ag-feed') as HTMLElement

    select.addEventListener('change', () => {
      vscode.postMessage({ type: 'selectSession', sessionId: select.value })
    })
    detailGroup.addEventListener('click', ev => {
      const btn = (ev.target as Element | null)?.closest('.btn-detail') as HTMLButtonElement | null
      if (!btn || btn.disabled) return
      const level = btn.dataset.detail as DetailLevel | undefined
      if (level !== 'compact' && level !== 'verbose' && level !== 'debug') return
      if (level === 'debug' && state && !state.canDebug) return
      vscode.postMessage({ type: 'setDetailLevel', detailLevel: level })
    })
    debugBanner.addEventListener('click', ev => {
      const closeBtn = (ev.target as Element | null)?.closest('#ag-debug-close')
      if (closeBtn) {
        vscode.postMessage({ type: 'setDetailLevel', detailLevel: 'verbose' })
      }
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
    breakdownWrap.addEventListener('click', ev => {
      if (!state) return
      const modeBtn = (ev.target as Element | null)?.closest('#ag-bd-mode')
      if (modeBtn) {
        breakdownMode = breakdownMode === 'time' ? 'tokens' : 'time'
        renderBreakdown(breakdownWrap, state)
        return
      }
      const stBtn = (ev.target as Element | null)?.closest('[data-station]') as HTMLElement | null
      const st = asStationId(stBtn?.dataset.station)
      if (!st) return
      vscode.postMessage({
        type: 'selectStation',
        station: state.selectedStation === st ? undefined : st,
      })
    })
    quotaWrap.addEventListener('click', ev => {
      if (!state) return
      if (!(ev.target as Element | null)?.closest('#ag-quota-toggle')) return
      quotaExpanded = !quotaExpanded
      renderQuota(quotaWrap, state)
    })
    turnsWrap.addEventListener('click', ev => {
      if (!state) return
      const toggleBtn = (ev.target as Element | null)?.closest('#ag-turns-toggle')
      if (!toggleBtn) return
      turnsExpanded = !turnsExpanded
      renderTurns(turnsWrap, state)
    })
    inspectorWrap.addEventListener('click', ev => {
      const closeBtn = (ev.target as Element | null)?.closest('#ag-ins-close')
      if (!closeBtn) return
      vscode.postMessage({ type: 'selectStation', station: undefined })
    })
    feedEl.addEventListener('click', ev => {
      if (!state) return
      const expandBtn = (ev.target as Element | null)?.closest('.row-expand') as HTMLButtonElement | null
      if (expandBtn) {
        const id = expandBtn.dataset.rowId
        openRowId = openRowId === id ? undefined : id
        renderFeed(feedEl, state)
        return
      }
      if (state.detailLevel !== 'compact') {
        const rowEl = (ev.target as Element | null)?.closest('.row.is-clickable') as HTMLElement | null
        const id = rowEl?.dataset.rowId
        if (!id) return
        selectedStepId = selectedStepId === id ? undefined : id
        renderFeed(feedEl, state)
      }
    })
  }
  return {
    select: document.getElementById('ag-session') as HTMLSelectElement,
    detailGroup: document.getElementById('ag-detail-group') as HTMLElement,
    debugBanner: document.getElementById('ag-debug-banner') as HTMLElement,
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
    quotaWrap: document.getElementById('ag-quota-wrap') as HTMLElement,
    breakdownWrap: document.getElementById('ag-breakdown-wrap') as HTMLElement,
    telemetryWrap: document.getElementById('ag-telemetry-wrap') as HTMLElement,
    turnsWrap: document.getElementById('ag-turns-wrap') as HTMLElement,
    inspectorWrap: document.getElementById('ag-inspector-wrap') as HTMLElement,
    feed: document.getElementById('ag-feed') as HTMLElement,
  }
}

function renderQuota(wrap: HTMLElement, s: WebviewStateMessage): void {
  const cb = s.contextBudget
  const q = s.quota
  const usage = s.ideUsage
  const hasPools = Boolean(q && q.pools.length > 0)
  const hasUsage = Boolean(usage && (usage.last24h.totalTokens > 0 || usage.last7d.totalTokens > 0))
  if (!s.showQuota || (!cb && !hasPools && !hasUsage)) {
    wrap.style.display = 'none'
    wrap.innerHTML = ''
    return
  }

  wrap.style.display = 'block'
  const nowMs = Date.now()
  const lowestRem = hasPools ? Math.min(...q!.pools.map(p => p.remainingPct)) : cb?.remainingPct
  const headlineColor =
    lowestRem === undefined
      ? s.palette.ash
      : lowestRem <= 15
        ? s.palette.red
        : lowestRem <= 45
          ? s.palette.accent
          : s.palette.mem
  const headlineText = lowestRem !== undefined ? `${lowestRem}% ${s.strings.remaining}` : ''

  const items: string[] = []
  if (cb) {
    const ctxRem = Math.max(0, Math.min(100, cb.remainingPct))
    const ctxColor = ctxRem < 20 ? s.palette.red : ctxRem < 50 ? s.palette.accent : s.palette.mem
    const estMark = cb.isEstimated ? '~' : ''
    items.push(`<div class="quota-item">
      <div class="quota-row">
        <span class="quota-name">${escapeHtml(s.strings.contextLabel)}: ${escapeHtml(estMark + formatCompactTokens(cb.usedTokens))} / ${escapeHtml(formatCompactTokens(cb.limitTokens))}</span>
        <span class="quota-val"><strong>${cb.remainingPct}%</strong> ${escapeHtml(s.strings.remaining)} (${escapeHtml(formatCompactTokens(cb.remainingTokens))})</span>
      </div>
      <div class="quota-bar"><div class="quota-fill" style="width:${Math.max(ctxRem > 0 ? 2 : 0, ctxRem)}%;background:${escapeHtml(ctxColor)}"></div></div>
    </div>`)
  }

  if (hasPools) {
    for (const pool of q!.pools) {
      const rem = Math.max(0, Math.min(100, pool.remainingPct))
      const color = rem < 20 ? s.palette.red : rem < 50 ? s.palette.accent : s.palette.mem
      const countdown = formatCountdown(pool.resetAtMs, nowMs)
      const resetPart = countdown ? ` · ${escapeHtml(s.strings.resetsIn)} ${escapeHtml(countdown)}` : ''
      const badgePart = pool.badge ? ` · ${escapeHtml(pool.badge)}` : ''
      items.push(`<div class="quota-item">
        <div class="quota-row">
          <span class="quota-name">${escapeHtml(pool.label)}${badgePart}</span>
          <span class="quota-val"><strong>${rem}%</strong> ${escapeHtml(s.strings.remaining)} · ${pool.usedPct}% ${escapeHtml(s.strings.used)}${resetPart}</span>
        </div>
        <div class="quota-bar"><div class="quota-fill" style="width:${Math.max(rem > 0 ? 2 : 0, rem)}%;background:${escapeHtml(color)}"></div></div>
      </div>`)
    }
  }

  if (s.dailyTokenBudget > 0 && usage) {
    const used = usage.last24h.totalTokens
    const usedPct = Math.min(100, Math.round((used / s.dailyTokenBudget) * 1000) / 10)
    const remPct = Math.max(0, Math.round((100 - usedPct) * 10) / 10)
    const remTok = Math.max(0, s.dailyTokenBudget - used)
    const bColor = remPct < 20 ? s.palette.red : remPct < 50 ? s.palette.accent : s.palette.mem
    items.push(`<div class="quota-item">
      <div class="quota-row">
        <span class="quota-name">${escapeHtml(s.strings.dailyBudget)}: ${escapeHtml(formatCompactTokens(used))} / ${escapeHtml(formatCompactTokens(s.dailyTokenBudget))}</span>
        <span class="quota-val"><strong>${remPct}%</strong> ${escapeHtml(s.strings.remaining)} (${escapeHtml(formatCompactTokens(remTok))})</span>
      </div>
      <div class="quota-bar"><div class="quota-fill" style="width:${Math.max(remPct > 0 ? 2 : 0, remPct)}%;background:${escapeHtml(bColor)}"></div></div>
    </div>`)
  }

  let footHtml = ''
  if (hasUsage || (q && q.availableCredits !== undefined && q.availableCredits > 0)) {
    const u24 = usage?.last24h
    const u7 = usage?.last7d
    const leftBit = u24
      ? `${escapeHtml(s.strings.ideUsage24h)}: ${escapeHtml(formatCompactTokens(u24.totalTokens))} (in ${escapeHtml(formatCompactTokens(u24.inputTokens))} · ${escapeHtml(s.strings.cacheHit)} ${u24.cacheHitPct}% · out ${escapeHtml(formatCompactTokens(u24.outputTokens))})`
      : ''
    const rightBits: string[] = []
    if (u7 && u7.totalTokens > 0) {
      rightBits.push(`${escapeHtml(s.strings.ideUsage7d)}: ${escapeHtml(formatCompactTokens(u7.totalTokens))} (${u7.sessions}s)`)
    }
    if (q?.availableCredits !== undefined && q.availableCredits > 0) {
      rightBits.push(`${q.availableCredits} cr`)
    }
    footHtml = `<div class="quota-foot"><span>${leftBit}</span><span>${rightBits.join(' · ')}</span></div>`
  }

  wrap.innerHTML = `<div class="quota-card">
    <div class="quota-head">
      <button type="button" class="quota-toggle" id="ag-quota-toggle">
        <span>${quotaExpanded ? '▾' : '▸'}</span>
        <span>${escapeHtml(s.strings.quotaTitle)}</span>
      </button>
      <span class="quota-badges">
        ${q?.planName ? `<span class="quota-plan">${escapeHtml(q.planName)}</span>` : ''}
        ${headlineText ? `<span class="quota-pill" style="color:${escapeHtml(headlineColor)}">${escapeHtml(headlineText)}</span>` : ''}
      </span>
    </div>
    ${quotaExpanded ? `<div class="quota-list">${items.join('')}</div>${footHtml}` : ''}
  </div>`
}

function renderBreakdown(wrap: HTMLElement, s: WebviewStateMessage): void {
  const b = s.breakdown
  if (!b || b.shares.length === 0) {
    wrap.style.display = 'none'
    wrap.innerHTML = ''
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

  const legendHtml =
    s.detailLevel !== 'compact'
      ? `<div class="breakdown-legend">${b.shares
          .map(sh => {
            const color = Object.hasOwn(STATION_COLORS, sh.station) ? STATION_COLORS[sh.station] : s.palette.accent
            const isSelected = s.selectedStation === sh.station
            const metric = useTokens
              ? `${sh.tokenPct}% · ${formatCompactTokens(sh.tokens)}`
              : `${sh.timePct}% · ${formatCompactMs(sh.timeMs, s.strings.msUnit, s.strings.secUnit)}`
            return `<button type="button" class="legend-pill${isSelected ? ' is-selected' : ''}" data-station="${escapeHtml(sh.station)}"><span class="legend-dot" style="background:${color}"></span><span>${escapeHtml(sh.stationName)} ${escapeHtml(metric)}</span></button>`
          })
          .join('')}</div>`
      : ''

  const modeButtonHtml = hasTokens
    ? `<button type="button" class="btn" id="ag-bd-mode">${useTokens ? 'Tokens' : 'Time'}</button>`
    : ''

  wrap.innerHTML = `
    <div class="breakdown-head">
      <span>${b.turns}t · ${b.totalCalls}× · ${escapeHtml(totalLabel)}</span>
      ${modeButtonHtml}
    </div>
    <div class="breakdown-bar">${segmentsHtml}</div>
    ${legendHtml}
  `
}

function renderTelemetry(wrap: HTMLElement, s: WebviewStateMessage): void {
  const ts = s.tokenStats
  if (s.detailLevel === 'compact' || !ts || ts.steps === 0) {
    wrap.style.display = 'none'
    wrap.innerHTML = ''
    return
  }
  wrap.style.display = 'block'
  const compNote = ts.compactions > 0 ? ` · ${ts.compactions}× ckpt` : ''
  const totalsLine = `Σ in ${formatCompactTokens(ts.totalInput)} · ${s.strings.cacheHit} ${ts.overallCacheHitPct}% · out ${formatCompactTokens(ts.totalOutput)}`

  wrap.innerHTML = `
    <div class="telemetry-card">
      <div class="telemetry-stats">
        <span><strong>${escapeHtml(formatCompactTokens(ts.latestTotalContext))}</strong> ctx · ${escapeHtml(s.strings.cacheHit)} <strong>${ts.latestCacheHitPct}%</strong> · in ${escapeHtml(formatCompactTokens(ts.latestInput))} · out ${escapeHtml(formatCompactTokens(ts.latestOutput))}</span>
        <span>peak ${escapeHtml(formatCompactTokens(ts.peakContextTokens))}${escapeHtml(compNote)}</span>
      </div>
      ${s.sparklineSvg ? `<div class="telemetry-spark">${s.sparklineSvg}</div>` : ''}
      <div class="telemetry-stats"><span>${escapeHtml(totalsLine)}</span><span>${ts.steps} steps</span></div>
    </div>
  `
}

function renderTurns(wrap: HTMLElement, s: WebviewStateMessage): void {
  const turns = s.turnSummaries
  if (s.detailLevel === 'compact' || !turns || turns.length === 0) {
    wrap.style.display = 'none'
    wrap.innerHTML = ''
    return
  }
  wrap.style.display = 'block'
  const newestFirst = [...turns].reverse()
  const listHtml = turnsExpanded
    ? `<div class="turns-list">${newestFirst
        .map(t => {
          const title = t.turnNumber === 0 ? 'Pre' : `T${t.turnNumber}`
          const stationsStr = t.topStations.map(st => `${st.stationName}×${st.count}`).join(', ')
          const durStr =
            t.isActive && s.replay.isLive
              ? s.strings.runningLabel
              : formatCompactMs(t.durationMs, s.strings.msUnit, s.strings.secUnit)
          const tokStr = t.tokensAdded > 0 ? ` · +${formatCompactTokens(t.tokensAdded)}` : ''
          const errStr = t.faultCount > 0 ? ` · ${t.faultCount} err` : ''
          return `<div class="turn-row${t.isActive ? ' is-active' : ''}">
            <span class="turn-left"><strong>${escapeHtml(title)}</strong>${stationsStr ? ` · ${escapeHtml(stationsStr)}` : ''}</span>
            <span class="turn-right">${t.callCount}× · ${escapeHtml(durStr)}${escapeHtml(tokStr)}${escapeHtml(errStr)}</span>
          </div>`
        })
        .join('')}</div>`
    : ''

  wrap.innerHTML = `
    <div class="turns-card">
      <button type="button" class="turns-toggle" id="ag-turns-toggle">
        <span>${turnsExpanded ? '▾' : '▸'} ${escapeHtml(s.strings.turnsTitle)} (${turns.length})</span>
        <span>${turnsExpanded ? '−' : '+'}</span>
      </button>
      ${listHtml}
    </div>
  `
}

function renderInspector(wrap: HTMLElement, s: WebviewStateMessage): void {
  const ins = s.inspection
  if (!ins) {
    wrap.style.display = 'none'
    wrap.innerHTML = ''
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
}

function renderStepCard(r: FeedRowPayload, s: WebviewStateMessage): string {
  const stepText = r.stepIdx !== undefined ? `#${r.stepIdx}` : '—'
  const startClock = formatClockTime(r.startedAt, true) || '—'
  const endClock = r.endedAt !== undefined ? formatClockTime(r.endedAt, true) : r.isRunning ? s.strings.runningLabel : '—'
  const durStr =
    r.isRunning && s.replay.isLive
      ? formatLiveDuration(r.startedAt, s.strings.msUnit, s.strings.secUnit)
      : r.formattedTime
  const originText = `${r.from ?? 'core'}${r.agentName ? ` (${r.agentName})` : ''}`
  const isErr = r.status === 'err' || r.status === 'block'

  let debugHtml = ''
  if (s.detailLevel === 'debug' && r.debug) {
    const blocks: string[] = []
    if (r.debug.lineRange) {
      blocks.push(`<div class="step-debug-block"><span class="step-debug-key">lines</span><span>${escapeHtml(r.debug.lineRange)}</span></div>`)
    }
    if (r.debug.args) {
      blocks.push(`<div class="step-debug-block"><span class="step-debug-key">args</span><span>${escapeHtml(r.debug.args)}</span></div>`)
    }
    if (r.debug.error) {
      blocks.push(`<div class="step-debug-block is-err"><span class="step-debug-key">error</span><span>${escapeHtml(r.debug.error)}</span></div>`)
    }
    if (r.debug.result) {
      blocks.push(`<div class="step-debug-block"><span class="step-debug-key">result</span><span>${escapeHtml(r.debug.result)}</span></div>`)
    }
    if (r.debug.thinking) {
      blocks.push(`<div class="step-debug-block"><span class="step-debug-key">thinking</span><span>${escapeHtml(r.debug.thinking)}</span></div>`)
    }
    debugHtml = blocks.join('')
  }

  return `<div class="step-card${isErr ? ' is-err' : ''}">
    <div class="step-card-grid">
      <span>step ${escapeHtml(stepText)}</span>
      <span>station ${escapeHtml(r.stationName)}</span>
      <span>status ${escapeHtml(r.status)}</span>
      <span>origin ${escapeHtml(originText)}</span>
      ${r.toolName ? `<span>tool ${escapeHtml(r.toolName)}</span>` : ''}
      <span>${escapeHtml(startClock)} → ${escapeHtml(endClock)}</span>
      <span>dur ${escapeHtml(durStr)}</span>
      ${r.formattedCost ? `<span>ctx ${escapeHtml(r.formattedCost)}</span>` : ''}
    </div>
    ${debugHtml}
  </div>`
}

function renderFeed(feedEl: HTMLElement, s: WebviewStateMessage, resetScroll = false): void {
  const isDetailed = s.detailLevel !== 'compact'
  const prevScrollTop = isDetailed && !resetScroll ? feedEl.scrollTop : 0
  feedEl.classList.toggle('is-detailed', isDetailed)

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
      const isCardOpen = isDetailed && selectedStepId === r.id
      const isOpen = (r.isLong && openRowId === r.id) || isCardOpen
      if (isOpen) cls.push('is-open')
      if (isDetailed) cls.push('is-clickable')
      if (isCardOpen) cls.push('is-card-open')

      const tsHtml = isDetailed
        ? `<span class="row-ts">${escapeHtml(formatClockTime(r.startedAt))}${r.stepIdx !== undefined ? ` #${escapeHtml(String(r.stepIdx))}` : ''}</span>`
        : ''
      const toolHtml = isDetailed && r.toolName && r.toolName !== r.label ? `<span class="row-tool">${escapeHtml(r.toolName)}</span>` : ''
      const timesHtml = r.times > 1 ? `<span class="row-times">+${r.times - 1}</span>` : ''
      const expandHtml =
        !isDetailed && r.isLong
          ? `<button class="row-expand" data-row-id="${escapeHtml(r.id)}" type="button">${isOpen ? '▾' : '▸'}</button>`
          : ''
      const timeText =
        r.isRunning && s.replay.isLive
          ? formatLiveDuration(r.startedAt, s.strings.msUnit, s.strings.secUnit)
          : r.formattedTime
      const metaText = `${timeText}${r.formattedCost ? ` ${r.formattedCost}` : ''}`
      const cardHtml = isCardOpen ? renderStepCard(r, s) : ''

      return `<div class="${cls.join(' ')}" data-row-id="${escapeHtml(r.id)}" data-started="${r.startedAt}" data-running="${r.isRunning && s.replay.isLive ? '1' : '0'}" data-cost="${escapeHtml(r.formattedCost)}">
        <div class="row-main">
          <span class="row-mark">${mark}</span>
          ${tsHtml}
          <span class="row-station">${escapeHtml(r.stationName)}</span>
          ${toolHtml}
          <span class="row-label">${escapeHtml(r.label)}</span>
          ${timesHtml}
        </div>
        ${expandHtml}
        <span class="row-meta">${escapeHtml(metaText)}</span>
      </div>${cardHtml}`
    })
    .join('')

  if (isDetailed) {
    feedEl.scrollTop = resetScroll ? 0 : prevScrollTop
  }
}

function render(s: WebviewStateMessage): void {
  const sessionKey = `${s.mode}:${s.activeSessionId ?? ''}`
  const sessionChanged = sessionKey !== lastSessionKey
  if (sessionChanged) {
    lastSessionKey = sessionKey
    openRowId = undefined
    selectedStepId = undefined
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

  const detailTitles: Record<DetailLevel, string> = {
    compact: s.strings.detailCompact,
    verbose: s.strings.detailVerbose,
    debug: s.strings.detailDebug,
  }
  ui.detailGroup.querySelectorAll<HTMLButtonElement>('.btn-detail').forEach(btn => {
    const level = btn.dataset.detail as DetailLevel | undefined
    if (!level) return
    const locked = level === 'debug' && !s.canDebug
    const label = detailTitles[level] ?? level
    btn.disabled = locked
    btn.textContent = locked ? `🔒 ${label}` : label
    btn.setAttribute('aria-pressed', String(s.detailLevel === level))
    btn.title = locked ? `${detailTitles.debug} (Trusted Workspace required)` : label
    btn.classList.toggle('is-active', s.detailLevel === level && level !== 'debug')
    btn.classList.toggle('is-debug-active', s.detailLevel === 'debug' && level === 'debug')
  })

  if (s.detailLevel === 'debug') {
    ui.debugBanner.style.display = 'flex'
    ui.debugBanner.innerHTML = `<span>${escapeHtml(s.strings.debugWarning)}</span><button type="button" class="debug-banner-close" id="ag-debug-close" title="${escapeHtml(s.strings.detailVerbose)}">×</button>`
  } else {
    ui.debugBanner.style.display = 'none'
    ui.debugBanner.innerHTML = ''
  }

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

  renderQuota(ui.quotaWrap, s)
  renderBreakdown(ui.breakdownWrap, s)
  renderTelemetry(ui.telemetryWrap, s)
  renderTurns(ui.turnsWrap, s)
  renderInspector(ui.inspectorWrap, s)
  renderFeed(ui.feed, s, sessionChanged)
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
