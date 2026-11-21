import * as vscode from 'vscode'
import { drawBrailleMap, formatMarkdownReport } from '../core/braille'
import { computeBreakdown } from '../core/breakdown'
import { formatMs, formatTokens } from '../core/classify'
import { DEMO_TIMELINE } from '../core/demo'
import { drawMap } from '../core/draw'
import { foldRows, nowParts, VERBOSE_LIST_ROWS } from '../core/feed'
import { filterBoardByStation, inspectStation } from '../core/inspector'
import { resolvePalette } from '../core/palette'
import { TranscriptReducer } from '../core/reducer'
import { sliceBoardAt, turnIndices } from '../core/replay'
import { STATIONS } from '../core/setup'
import type { Setup } from '../core/setup'
import { computeTokenStats, computeTurnSummaries, drawContextSparkline } from '../core/telemetry'
import type { Board, DetailLevel, SessionSummary, StationId } from '../core/types'
import { listSessions, pickAutoSession, resolveAntigravityDirs } from '../watcher/discovery'
import { TranscriptTailer } from '../watcher/tailer'
import type { FeedRowPayload, WebviewCommandMessage, WebviewStateMessage } from '../webview/protocol'
import { buildSetup, isLightTheme, readUserOptions } from './config'
import { getWebviewHtml } from './webviewHtml'

const ZOOM_KEY = 'agVisualizer.zoom'
const HIDDEN_KEY = 'agVisualizer.hidden'
const VIEW_MODE_KEY = 'agVisualizer.viewMode'
const LONG_LABEL = 44
const VALID_STATION_IDS = new Set<string>(STATIONS.map(s => s.id))

function buildRows(board: Board, setup: Setup, stationFilter?: StationId): FeedRowPayload[] {
  const { t } = setup
  const turnMs = new Map<string, number>()
  let askedAt: number | undefined
  for (const x of board.entries) {
    if (x.station === 'you' && x.from === 'inbound' && x.mark === undefined) {
      askedAt = x.startedAt
    }
    if (x.mark === 'done' && askedAt !== undefined) {
      turnMs.set(x.id, x.startedAt - askedAt)
      askedAt = undefined
    }
  }

  const isDetailed = setup.detailLevel !== 'compact'
  const filtered = filterBoardByStation(board, stationFilter)
  return foldRows(filtered, isDetailed ? VERBOSE_LIST_ROWS : 16, setup.subagentNames, isDetailed).map(row => {
    const e = row.entry
    const whole = turnMs.get(e.id)
    const isRunning = e.endedAt === undefined || e.status === 'run'
    const formattedTime = isRunning
      ? t.running
      : whole !== undefined && whole > 0
        ? formatMs(whole, t)
        : row.tookMs > 0
          ? formatMs(row.tookMs, t)
          : '—'
    const formattedCost =
      setup.contextCost && row.tokens !== undefined
        ? `${row.isShared ? '~' : ''}+${formatTokens(row.tokens)}`
        : ''
    return {
      id: e.id,
      station: e.station,
      stationName: t.stations[e.station],
      label: e.label,
      status: e.status,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
      mark: e.mark,
      times: row.times,
      tookMs: row.tookMs,
      turnMs: whole,
      tokens: row.tokens,
      isShared: row.isShared,
      isHeld: row.isHeld,
      formattedTime,
      formattedCost,
      isLong: e.label.length > LONG_LABEL,
      isRunning,
      ...(isDetailed && e.stepIdx !== undefined ? { stepIdx: e.stepIdx } : {}),
      ...(isDetailed && e.toolName !== undefined ? { toolName: e.toolName } : {}),
      ...(isDetailed && e.from !== undefined ? { from: e.from } : {}),
      ...(isDetailed && e.agentName !== undefined ? { agentName: e.agentName } : {}),
      ...(setup.detailLevel === 'debug' && e.debug !== undefined ? { debug: e.debug } : {}),
    }
  })
}

class MapController implements vscode.Disposable {
  private _context: vscode.ExtensionContext
  private _setup: Setup
  private _tailer: TranscriptTailer
  private _sessions: SessionSummary[] = []
  private _mode: 'auto' | 'pinned' | 'demo' = 'auto'
  private _pinnedSessionId: string | undefined
  private _demoReducer: TranscriptReducer
  private _demoTimer: NodeJS.Timeout | null = null
  private _demoIdx = 0
  private _demoBaseMs = 0
  private _demoPaused = false
  private _discoveryTimer: NodeJS.Timeout | null = null
  private _refreshing = false
  private _pendingRefresh = false
  private _pendingForceBroadcast = false
  private _lastSessionFingerprint = ''
  private _selectedStation: StationId | undefined
  private _replayIndex: number | undefined
  private _detailOverride: DetailLevel | undefined
  private _statusBar: vscode.StatusBarItem
  private _targets = new Set<vscode.Webview>()
  private _targetDisposables = new Map<vscode.Webview, vscode.Disposable[]>()
  private _panel: vscode.WebviewPanel | undefined
  private _disposables: vscode.Disposable[] = []

  constructor(context: vscode.ExtensionContext) {
    this._context = context
    this._setup = this.effectiveSetup()
    this._demoReducer = new TranscriptReducer(this._setup)
    this._tailer = new TranscriptTailer(this._setup, () => {
      if (this._mode !== 'demo') this.broadcast()
    })

    this._statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    this._statusBar.command = 'agVisualizer.openPanel'
    this._statusBar.tooltip = 'Antigravity Work Map'
    this._statusBar.show()

    this._disposables.push(
      this._statusBar,
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('agVisualizer.detailLevel')) {
          this._detailOverride = undefined
        }
        if (e.affectsConfiguration('agVisualizer')) {
          this.reloadConfig()
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.reloadConfig()
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.broadcast()
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.refreshSessions()
      }),
    )

    void this.refreshSessions()
    this._discoveryTimer = setInterval(() => {
      void this.refreshSessions()
    }, 2000)
  }

  private get zoom(): number {
    const raw = this._context.globalState.get<unknown>(ZOOM_KEY, 1)
    return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0.6, Math.min(1.4, raw)) : 1
  }

  private get hidden(): boolean {
    return this._context.globalState.get<unknown>(HIDDEN_KEY, false) === true
  }

  private get viewMode(): 'svg' | 'braille' {
    return this._context.globalState.get<unknown>(VIEW_MODE_KEY, 'svg') === 'braille' ? 'braille' : 'svg'
  }

  private rebuildDemoToCurrentIdx(): void {
    const count = Math.max(0, Math.min(DEMO_TIMELINE.length, this._demoIdx))
    this._demoReducer.reset()
    const firstIso = DEMO_TIMELINE[0]?.step.created_at
    const t0 = firstIso ? Date.parse(firstIso) : this._demoBaseMs
    for (let i = 0; i < count; i++) {
      const item = DEMO_TIMELINE[i]
      if (!item) continue
      const rawStep = item.step
      const stepTime = rawStep.created_at ? Date.parse(rawStep.created_at) : t0
      const shiftedMs = this._demoBaseMs + (stepTime - t0)
      const shiftedCreatedAt = new Date(shiftedMs).toISOString()
      const shiftedContent =
        rawStep.content && rawStep.type === 'GENERIC'
          ? rawStep.content
              .replace(/^Created At: .+$/m, `Created At: ${new Date(shiftedMs - 200).toISOString()}`)
              .replace(/^Completed At: .+$/m, `Completed At: ${new Date(shiftedMs).toISOString()}`)
          : rawStep.content
      this._demoReducer.push(
        { ...rawStep, created_at: shiftedCreatedAt, content: shiftedContent },
        {
          from: item.from,
          subagentLabel: item.subagentLabel,
          agentId: item.from === 'agents' ? 'demo-researcher' : undefined,
          now: shiftedMs,
        },
      )
    }
  }

  private effectiveSetup(): Setup {
    const base = buildSetup()
    if (this._detailOverride !== undefined) {
      const next = this._detailOverride === 'debug' && !vscode.workspace.isTrusted ? 'compact' : this._detailOverride
      return { ...base, detailLevel: next }
    }
    return base
  }

  private applyDetailLevelChange(prevDetail: DetailLevel): void {
    this._setup = this.effectiveSetup()
    this._tailer.updateSetup(this._setup, true)
    this._demoReducer.updateSetup(this._setup)
    if (prevDetail !== 'debug' && this._setup.detailLevel === 'debug') {
      if (this._mode === 'demo') {
        this.rebuildDemoToCurrentIdx()
      } else {
        void this._tailer.reload().catch(() => {
          // Ignore transient tailer reload errors
        })
      }
    }
    this.broadcast()
  }

  private reloadConfig(): void {
    const prevDetail = this._setup.detailLevel
    this.applyDetailLevelChange(prevDetail)
    void this.refreshSessions(true).catch(() => {
      // Ignore transient discovery errors
    })
  }

  async refreshSessions(forceBroadcast = false): Promise<void> {
    if (this._refreshing) {
      this._pendingRefresh = true
      if (forceBroadcast) this._pendingForceBroadcast = true
      return
    }
    this._refreshing = true
    try {
      const opts = readUserOptions()
      const dirs = resolveAntigravityDirs(opts.antigravityDataDir)
      this._sessions = await listSessions(dirs)

      const prevActiveId = this._tailer.activeSessionId
      if (this._mode !== 'demo') {
        let chosen: SessionSummary | undefined
        if (this._mode === 'pinned' && this._pinnedSessionId) {
          chosen = this._sessions.find(s => s.id === this._pinnedSessionId)
          if (!chosen) {
            this._mode = 'auto'
            this._pinnedSessionId = undefined
          }
        }
        if (!chosen) {
          const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)
          chosen = pickAutoSession(this._sessions, workspacePaths)
        }
        await this._tailer.attach(chosen, this._sessions)
      }

      if (prevActiveId !== this._tailer.activeSessionId) {
        this._selectedStation = undefined
        this._replayIndex = undefined
      }

      const fingerprint = [
        this._mode,
        this._tailer.activeSessionId ?? '',
        ...this._sessions
          .filter(s => !s.parentConversationId)
          .slice(0, 20)
          .map(s => `${s.id}:${s.title}:${s.status}:${s.notFullyIdle ? 1 : 0}`),
      ].join('|')

      if (forceBroadcast || fingerprint !== this._lastSessionFingerprint || prevActiveId !== this._tailer.activeSessionId) {
        this._lastSessionFingerprint = fingerprint
        this.broadcast()
      }
    } finally {
      this._refreshing = false
      if (this._pendingRefresh) {
        const nextForce = this._pendingForceBroadcast
        this._pendingRefresh = false
        this._pendingForceBroadcast = false
        void this.refreshSessions(nextForce)
      }
    }
  }

  attachWebview(webview: vscode.Webview): void {
    this._targets.add(webview)
    const msgDisposable = webview.onDidReceiveMessage((msg: WebviewCommandMessage) => {
      void this.handleMessage(msg)
    })
    this._targetDisposables.set(webview, [msgDisposable])
    this.postStateTo(webview)
  }

  detachWebview(webview: vscode.Webview): void {
    this._targets.delete(webview)
    const list = this._targetDisposables.get(webview)
    if (list) {
      for (const d of list) d.dispose()
      this._targetDisposables.delete(webview)
    }
  }

  openPanel(): void {
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.Beside, true)
      return
    }
    const panel = vscode.window.createWebviewPanel(
      'agVisualizer.panel',
      this._setup.t.title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'dist')],
      },
    )
    panel.webview.html = getWebviewHtml(panel.webview, this._context.extensionUri, true)
    this._panel = panel
    this.attachWebview(panel.webview)
    panel.onDidDispose(() => {
      this.detachWebview(panel.webview)
      if (this._panel === panel) this._panel = undefined
    })
  }

  toggleDemo(): void {
    this._selectedStation = undefined
    this._replayIndex = undefined
    if (this._mode === 'demo') {
      this.stopDemo()
      this._mode = 'auto'
      void this.refreshSessions(true)
    } else {
      this.startDemo()
    }
  }

  async pickSessionQuickPick(): Promise<void> {
    await this.refreshSessions()
    const items: (vscode.QuickPickItem & { id: string })[] = [
      { id: 'auto', label: `$(sparkle) ${this._setup.t.autoLabel}`, description: 'Follow active workspace conversation' },
      { id: 'demo', label: `$(play-circle) ${this._setup.t.demoLabel}`, description: 'Replay scripted Antigravity session' },
      ...this._sessions.slice(0, 20).map(s => ({
        id: s.id,
        label: s.title,
        description: s.status === 'CASCADE_RUN_STATUS_RUNNING' || s.notFullyIdle ? this._setup.t.running : s.id.slice(0, 8),
      })),
    ]
    const picked = await vscode.window.showQuickPick(items, { placeHolder: this._setup.t.title })
    if (!picked) return
    await this.selectSession(picked.id)
  }

  async pickDetailLevelQuickPick(): Promise<void> {
    const cur = this._setup.detailLevel
    const t = this._setup.t
    const trusted = vscode.workspace.isTrusted
    const items: (vscode.QuickPickItem & { id: DetailLevel })[] = [
      {
        id: 'compact',
        label: `${cur === 'compact' ? '$(check) ' : ''}${t.detailCompact}`,
        description: 'Folded feed (16 rows), minimal chrome',
      },
      {
        id: 'verbose',
        label: `${cur === 'verbose' ? '$(check) ' : ''}${t.detailVerbose}`,
        description: 'Unfolded steps, step cards, token sparkline, turn breakdown',
      },
      {
        id: 'debug',
        label: `${cur === 'debug' ? '$(check) ' : trusted ? '$(bug) ' : '$(lock) '}${t.detailDebug}`,
        description: trusted
          ? 'Verbose + truncated args, errors & thinking (session-ephemeral)'
          : 'Requires a Trusted Workspace',
      },
    ]
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select Work Map detail level' })
    if (!picked) return
    await this.setDetailLevel(picked.id)
  }

  async setDetailLevel(level: DetailLevel): Promise<void> {
    const prevDetail = this._setup.detailLevel
    if (level === 'debug') {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showInformationMessage('Debug detail level requires a Trusted Workspace.')
        return
      }
      this._detailOverride = 'debug'
      this.applyDetailLevelChange(prevDetail)
      return
    }
    this._detailOverride = level
    this.applyDetailLevelChange(prevDetail)
    const cfg = vscode.workspace.getConfiguration('agVisualizer')
    const currentSetting = cfg.get<string>('detailLevel', 'compact')
    if (currentSetting !== level) {
      try {
        await cfg.update('detailLevel', level, vscode.ConfigurationTarget.Global)
      } catch {
        // Ephemeral override stays active even if global config write is declined
      }
    }
  }

  async selectSession(id: string): Promise<void> {
    this._replayIndex = undefined
    this._selectedStation = undefined
    if (id === 'demo') {
      this.startDemo()
      return
    }
    this.stopDemo()
    if (id === 'auto') {
      this._mode = 'auto'
      this._pinnedSessionId = undefined
    } else {
      this._mode = 'pinned'
      this._pinnedSessionId = id
    }
    await this.refreshSessions(true)
  }

  private startDemo(): void {
    this.stopDemo()
    this._replayIndex = undefined
    this._selectedStation = undefined
    this._mode = 'demo'
    this._demoReducer.reset()
    this._demoIdx = 0
    this._demoBaseMs = Date.now()
    this._demoPaused = false
    this.broadcast()
    this.scheduleNextDemoStep()
  }

  private scheduleNextDemoStep(): void {
    if (this._mode !== 'demo' || this._demoPaused) return
    const item = DEMO_TIMELINE[this._demoIdx]
    if (!item) {
      this._demoTimer = setTimeout(() => {
        if (this._mode === 'demo') this.startDemo()
      }, 4500)
      return
    }
    this._demoTimer = setTimeout(() => {
      if (this._mode !== 'demo') return
      const now = Date.now()
      const rawStep = item.step
      const firstIso = DEMO_TIMELINE[0]?.step.created_at
      const t0 = firstIso ? Date.parse(firstIso) : now
      const stepTime = rawStep.created_at ? Date.parse(rawStep.created_at) : t0
      const shiftedCreatedAt = new Date(this._demoBaseMs + (stepTime - t0)).toISOString()

      const shiftedContent =
        rawStep.content && rawStep.type === 'GENERIC'
          ? rawStep.content
              .replace(/^Created At: .+$/m, `Created At: ${new Date(now - 300).toISOString()}`)
              .replace(/^Completed At: .+$/m, `Completed At: ${new Date(now).toISOString()}`)
          : rawStep.content

      this._demoReducer.push(
        {
          ...rawStep,
          created_at: shiftedCreatedAt,
          content: shiftedContent,
        },
        {
          from: item.from,
          subagentLabel: item.subagentLabel,
          agentId: item.from === 'agents' ? 'demo-researcher' : undefined,
          now,
        },
      )
      this._demoIdx += 1
      this.broadcast()
      this.scheduleNextDemoStep()
    }, item.delayMs)
  }

  private stopDemo(): void {
    if (this._demoTimer) {
      clearTimeout(this._demoTimer)
      this._demoTimer = null
    }
  }

  private async handleMessage(msg: WebviewCommandMessage): Promise<void> {
    if (!msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'ready':
        this.broadcast()
        break
      case 'setZoom': {
        if (typeof msg.zoom !== 'number' || !Number.isFinite(msg.zoom)) return
        const clamped = Math.max(0.6, Math.min(1.4, Math.round(msg.zoom * 10) / 10))
        await this._context.globalState.update(ZOOM_KEY, clamped)
        this.broadcast()
        break
      }
      case 'setHidden':
        if (typeof msg.hidden !== 'boolean') return
        await this._context.globalState.update(HIDDEN_KEY, msg.hidden)
        this.broadcast()
        break
      case 'toggleLayout': {
        const cfg = vscode.workspace.getConfiguration('agVisualizer')
        const inspected = cfg.inspect<string>('layout')
        const target =
          inspected?.workspaceValue !== undefined
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global
        const next = this._setup.layout === 'you-top' ? 'you-bottom' : 'you-top'
        await cfg.update('layout', next, target)
        break
      }
      case 'selectSession':
        if (typeof msg.sessionId !== 'string' || !msg.sessionId.trim()) return
        await this.selectSession(msg.sessionId)
        break
      case 'openPanel':
        this.openPanel()
        break
      case 'selectStation': {
        if (msg.station === undefined) {
          this._selectedStation = undefined
        } else if (typeof msg.station === 'string' && VALID_STATION_IDS.has(msg.station)) {
          this._selectedStation = msg.station as StationId
        } else {
          return
        }
        this.broadcast()
        break
      }
      case 'setViewMode':
        if (msg.viewMode !== 'svg' && msg.viewMode !== 'braille') return
        await this._context.globalState.update(VIEW_MODE_KEY, msg.viewMode)
        this.broadcast()
        break
      case 'setReplayIndex':
        if (msg.index === undefined) {
          this._replayIndex = undefined
        } else if (typeof msg.index === 'number' && Number.isFinite(msg.index)) {
          const floored = Math.max(0, Math.floor(msg.index))
          const total = this.currentBoard().entries.length
          this._replayIndex = floored >= total ? undefined : floored
        } else {
          return
        }
        this.broadcast()
        break
      case 'setDetailLevel': {
        if (msg.detailLevel !== 'compact' && msg.detailLevel !== 'verbose' && msg.detailLevel !== 'debug') return
        await this.setDetailLevel(msg.detailLevel)
        break
      }
      case 'copyMarkdown': {
        const msgState = this.buildStateMessage()
        await vscode.env.clipboard.writeText(msgState.markdownReport)
        break
      }
    }
  }

  private currentBoard(): Board {
    return this._mode === 'demo' ? this._demoReducer.board() : this._tailer.board()
  }

  private buildStateMessage(): WebviewStateMessage {
    const rawBoard = this.currentBoard()
    if (this._replayIndex !== undefined && this._replayIndex >= rawBoard.entries.length) {
      this._replayIndex = undefined
    }
    const now = Date.now()
    const turns = turnIndices(rawBoard.entries)
    const frame = sliceBoardAt(rawBoard, this._replayIndex, now)
    const board = frame.board
    const renderNow = frame.cursor.renderNow

    const lightSurface = isLightTheme(vscode.window.activeColorTheme)
    const effectiveTheme =
      this._setup.theme === 'auto' ? (lightSurface ? 'light' : 'dark') : this._setup.theme
    const renderSetup: Setup = { ...this._setup, theme: effectiveTheme }
    const svg = drawMap(board, renderNow, renderSetup, {
      selectedStation: this._selectedStation,
    })
    const brailleMap = drawBrailleMap(board, renderNow, renderSetup)
    const markdownReport = formatMarkdownReport(board, renderNow, renderSetup)
    const breakdown = computeBreakdown(board, this._setup)
    const fullInspection = this._selectedStation
      ? inspectStation(board, this._selectedStation, this._setup)
      : undefined
    const inspection = fullInspection
      ? {
          station: fullInspection.station,
          stationName: fullInspection.stationName,
          status: fullInspection.status,
          count: fullInspection.count,
          callSharePct: fullInspection.callSharePct,
          runningCount: fullInspection.runningCount,
          faultCount: fullInspection.faultCount,
          tokens: fullInspection.tokens,
          totalTimeMs: fullInspection.totalTimeMs,
          avgTimeMs: fullInspection.avgTimeMs,
          maxTimeMs: fullInspection.maxTimeMs,
          topLabels: fullInspection.topLabels,
        }
      : undefined
    const parts = nowParts(board, this._setup.t)
    const palette = resolvePalette(this._setup, lightSurface)
    const includeTelemetry = this._setup.detailLevel !== 'compact'
    const tokenStats = includeTelemetry ? computeTokenStats(board) : undefined
    const sparklineSvg =
      tokenStats && tokenStats.steps > 0 ? drawContextSparkline(tokenStats, palette) : undefined
    const turnSummaries = includeTelemetry ? computeTurnSummaries(board, this._setup) : undefined

    return {
      type: 'state',
      svg,
      brailleMap,
      markdownReport,
      viewMode: this.viewMode,
      nowWhat: parts.what,
      nowMeter: parts.meter,
      mode: this._mode,
      activeSessionId: this._mode === 'demo' ? 'demo' : this._tailer.activeSessionId,
      sessions: this._sessions
        .filter(s => !s.parentConversationId)
        .slice(0, 20)
        .map(s => ({
          id: s.id,
          title: s.title,
          running: s.status === 'CASCADE_RUN_STATUS_RUNNING' || Boolean(s.notFullyIdle),
          mtimeMs: s.mtimeMs,
        })),
      rows: buildRows(board, this._setup, this._selectedStation),
      breakdown,
      selectedStation: this._selectedStation,
      inspection,
      replay: {
        index: frame.cursor.index,
        total: frame.cursor.total,
        isLive: frame.cursor.isLive,
        turnIndices: turns,
        turnNumber: frame.cursor.turnNumber,
        totalTurns: frame.cursor.totalTurns,
      },
      zoom: this.zoom,
      hidden: this.hidden,
      layout: this._setup.layout,
      background: this._setup.background,
      theme: this._setup.theme,
      isLightSurface: lightSurface,
      textSize: this._setup.textSize,
      detailLevel: this._setup.detailLevel,
      canDebug: vscode.workspace.isTrusted,
      palette,
      hasContext: board.context !== undefined && Number.isFinite(board.context),
      contextPct: board.context !== undefined && Number.isFinite(board.context) ? board.context : undefined,
      ...(tokenStats ? { tokenStats } : {}),
      ...(sparklineSvg ? { sparklineSvg } : {}),
      ...(turnSummaries ? { turnSummaries } : {}),
      strings: {
        title: this._setup.t.title,
        zoomOut: this._setup.t.zoomOut,
        zoomIn: this._setup.t.zoomIn,
        hideMap: this._setup.t.hideMap,
        showMap: this._setup.t.showMap,
        nothingYet: this._setup.t.nothingYet,
        demoLabel: this._setup.t.demoLabel,
        autoLabel: this._setup.t.autoLabel,
        runningLabel: this._setup.t.running,
        contextLabel: this._setup.t.context,
        msUnit: this._setup.t.ms(0).replace(/^0\s*/, ''),
        secUnit: this._setup.t.seconds('0.0').replace(/^0[.,]0\s*/, ''),
        detailCompact: this._setup.t.detailCompact,
        detailVerbose: this._setup.t.detailVerbose,
        detailDebug: this._setup.t.detailDebug,
        debugWarning: this._setup.t.debugWarning,
        turnsTitle: this._setup.t.turnsTitle,
        cacheHit: this._setup.t.cacheHit,
      },
    }
  }

  private updateStatusBar(board: Board): void {
    const running = board.entries.filter(e => e.status === 'run').length
    const bits = [this._setup.core]
    if (board.context !== undefined && Number.isFinite(board.context)) {
      bits.push(`${Math.max(0, Math.min(100, Math.round(board.context)))}%`)
    }
    if (running > 0) bits.push(`${running} ${this._setup.t.running}`)
    if (this._mode === 'demo') bits.push(this._setup.t.demoLabel)
    if (this._setup.detailLevel === 'debug') bits.push('DEBUG')
    this._statusBar.text = `$(pulse) ${bits.join(' · ')}`
  }

  private postStateTo(webview: vscode.Webview): void {
    const msg = this.buildStateMessage()
    void Promise.resolve(webview.postMessage(msg)).catch(() => {
      this.detachWebview(webview)
    })
  }

  private broadcast(): void {
    const board = this.currentBoard()
    this.updateStatusBar(board)
    if (this._targets.size === 0) return
    const msg = this.buildStateMessage()
    for (const target of [...this._targets]) {
      void Promise.resolve(target.postMessage(msg)).catch(() => {
        this.detachWebview(target)
      })
    }
  }

  dispose(): void {
    this.stopDemo()
    if (this._discoveryTimer) {
      clearInterval(this._discoveryTimer)
      this._discoveryTimer = null
    }
    this._tailer.dispose()
    this._panel?.dispose()
    for (const d of this._disposables) d.dispose()
  }
}

class MapViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _controller: MapController,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist')],
    }
    webviewView.webview.html = getWebviewHtml(webviewView.webview, this._extensionUri, false)
    this._controller.attachWebview(webviewView.webview)
    webviewView.onDidDispose(() => {
      this._controller.detachWebview(webviewView.webview)
    })
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new MapController(context)
  const provider = new MapViewProvider(context.extensionUri, controller)

  context.subscriptions.push(
    controller,
    vscode.window.registerWebviewViewProvider('agVisualizer.mapView', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('agVisualizer.openPanel', () => controller.openPanel()),
    vscode.commands.registerCommand('agVisualizer.toggleDemo', () => controller.toggleDemo()),
    vscode.commands.registerCommand('agVisualizer.selectSession', () => controller.pickSessionQuickPick()),
    vscode.commands.registerCommand('agVisualizer.selectDetailLevel', () => controller.pickDetailLevelQuickPick()),
  )
}

export function deactivate(): void {
  // Disposables are cleaned up automatically by VS Code extension host.
}
