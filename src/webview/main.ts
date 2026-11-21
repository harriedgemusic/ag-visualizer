import type { WebviewCommandMessage, WebviewStateMessage } from './protocol'

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewCommandMessage): void
}

const vscode = acquireVsCodeApi()
const app = document.getElementById('app') as HTMLElement

let state: WebviewStateMessage | null = null
let lastSvg = ''
let lastOptionsFingerprint = ''
let openRowId: string | undefined

function escapeHtml(text: string): string {
  return text.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

function formatLiveDuration(startedAt: number, msUnit: string, secUnit: string): string {
  const ms = Math.max(1, Date.now() - startedAt)
  if (ms < 1000) return `${Math.round(ms)} ${msUnit}`
  const s = Math.round(ms / 100) / 10
  return `${s.toFixed(1)} ${secUnit}`
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
  btnHide: HTMLButtonElement
  mapWrap: HTMLElement
  mapStage: HTMLElement
  nowWhat: HTMLElement
  nowMeter: HTMLElement
  feed: HTMLElement
} {
  let root = app.querySelector('.shell-ready')
  if (!root) {
    app.innerHTML = `
      <div class="toolbar shell-ready">
        <select class="session-select" id="ag-session"></select>
        <div class="controls">
          <button class="btn" id="ag-zoom-out" type="button">−</button>
          <button class="btn" id="ag-zoom-in" type="button">+</button>
          <button class="btn" id="ag-layout" type="button">⇅</button>
          <button class="btn" id="ag-hide" type="button">▾</button>
        </div>
      </div>
      <div class="map-wrap" id="ag-map-wrap">
        <div class="map-stage" id="ag-map-stage"></div>
      </div>
      <div class="now-bar">
        <div class="now-what" id="ag-now-what"></div>
        <div class="now-meter" id="ag-now-meter"></div>
      </div>
      <div class="feed" id="ag-feed"></div>
    `
    const select = document.getElementById('ag-session') as HTMLSelectElement
    const btnZoomOut = document.getElementById('ag-zoom-out') as HTMLButtonElement
    const btnZoomIn = document.getElementById('ag-zoom-in') as HTMLButtonElement
    const btnLayout = document.getElementById('ag-layout') as HTMLButtonElement
    const btnHide = document.getElementById('ag-hide') as HTMLButtonElement

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
    btnHide.addEventListener('click', () => {
      if (state) vscode.postMessage({ type: 'setHidden', hidden: !state.hidden })
    })
  }
  return {
    select: document.getElementById('ag-session') as HTMLSelectElement,
    btnZoomOut: document.getElementById('ag-zoom-out') as HTMLButtonElement,
    btnZoomIn: document.getElementById('ag-zoom-in') as HTMLButtonElement,
    btnLayout: document.getElementById('ag-layout') as HTMLButtonElement,
    btnHide: document.getElementById('ag-hide') as HTMLButtonElement,
    mapWrap: document.getElementById('ag-map-wrap') as HTMLElement,
    mapStage: document.getElementById('ag-map-stage') as HTMLElement,
    nowWhat: document.getElementById('ag-now-what') as HTMLElement,
    nowMeter: document.getElementById('ag-now-meter') as HTMLElement,
    feed: document.getElementById('ag-feed') as HTMLElement,
  }
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
      const timeText = r.isRunning
        ? formatLiveDuration(r.startedAt, s.strings.msUnit, s.strings.secUnit)
        : r.formattedTime
      const metaText = `${timeText}${r.formattedCost ? ` ${r.formattedCost}` : ''}`

      return `<div class="${cls.join(' ')}" data-started="${r.startedAt}" data-running="${r.isRunning ? '1' : '0'}" data-cost="${escapeHtml(r.formattedCost)}">
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
  ui.btnHide.title = s.hidden ? s.strings.showMap : s.strings.hideMap
  ui.btnHide.textContent = s.hidden ? '▸' : '▾'

  ui.mapWrap.classList.toggle('is-hidden', s.hidden)
  if (!s.hidden) {
    ui.mapStage.style.maxWidth = `${Math.round(460 * s.zoom)}px`
    if (s.svg !== lastSvg) {
      ui.mapStage.innerHTML = s.svg
      lastSvg = s.svg
    }
  }

  ui.nowWhat.textContent = s.nowWhat
  ui.nowMeter.textContent = s.nowMeter

  renderFeed(ui.feed, s)
}

window.addEventListener('message', event => {
  const msg = event.data as WebviewStateMessage
  if (msg?.type === 'state') {
    render(msg)
  }
})

setInterval(() => {
  if (!state) return
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
