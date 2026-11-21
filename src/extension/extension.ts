import * as vscode from 'vscode'
import { formatMs, formatTokens } from '../core/classify'
import { drawMap } from '../core/draw'
import { foldRows, nowParts } from '../core/feed'
import { resolvePalette } from '../core/palette'
import { TranscriptReducer } from '../core/reducer'
import type { Setup } from '../core/setup'
import { DEMO_TIMELINE } from '../core/demo'
import type { Board, SessionSummary } from '../core/types'
import { listSessions, pickAutoSession, resolveAntigravityDirs } from '../watcher/discovery'
import { TranscriptTailer } from '../watcher/tailer'
import type { FeedRowPayload, WebviewCommandMessage, WebviewStateMessage } from '../webview/protocol'
import { buildSetup, isLightTheme, readUserOptions } from './config'
import { getWebviewHtml } from './webviewHtml'

const ZOOM_KEY = 'agVisualizer.zoom'
const HIDDEN_KEY = 'agVisualizer.hidden'
const LONG_LABEL = 44

function buildRows(board: Board, setup: Setup): FeedRowPayload[] {
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

  return foldRows(board.entries, 16, setup.subagentNames).map(row => {
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
  private _lastSessionFingerprint = ''
  private _statusBar: vscode.StatusBarItem
  private _targets = new Set<vscode.Webview>()
  private _targetDisposables = new Map<vscode.Webview, vscode.Disposable[]>()
  private _panel: vscode.WebviewPanel | undefined
  private _disposables: vscode.Disposable[] = []

  constructor(context: vscode.ExtensionContext) {
    this._context = context
    this._setup = buildSetup()
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
        if (e.affectsConfiguration('agVisualizer')) {
          this.reloadConfig()
        }
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

  private reloadConfig(): void {
    this._setup = buildSetup()
    this._tailer.updateSetup(this._setup)
    this._demoReducer.updateSetup(this._setup)
    void this.refreshSessions(true)
    this.broadcast()
  }

  async refreshSessions(forceBroadcast = false): Promise<void> {
    if (this._refreshing) return
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
    if (this._mode === 'demo') {
      this.stopDemo()
      this._mode = 'auto'
      void this.refreshSessions()
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

  async selectSession(id: string): Promise<void> {
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
    await this.refreshSessions()
  }

  private startDemo(): void {
    this.stopDemo()
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
    }
  }

  private currentBoard(): Board {
    return this._mode === 'demo' ? this._demoReducer.board() : this._tailer.board()
  }

  private buildStateMessage(): WebviewStateMessage {
    const board = this.currentBoard()
    const lightSurface = isLightTheme(vscode.window.activeColorTheme)
    const effectiveTheme =
      this._setup.theme === 'auto' ? (lightSurface ? 'light' : 'dark') : this._setup.theme
    const renderSetup: Setup = { ...this._setup, theme: effectiveTheme }
    const now = Date.now()
    const svg = drawMap(board, now, renderSetup)
    const parts = nowParts(board, this._setup.t)
    const palette = resolvePalette(this._setup, lightSurface)

    return {
      type: 'state',
      svg,
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
      rows: buildRows(board, this._setup),
      zoom: this.zoom,
      hidden: this.hidden,
      layout: this._setup.layout,
      background: this._setup.background,
      theme: this._setup.theme,
      isLightSurface: lightSurface,
      textSize: this._setup.textSize,
      palette,
      hasContext: board.context !== undefined,
      model: board.model,
      contextPct: board.context,
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
      },
    }
  }

  private updateStatusBar(board: Board): void {
    const running = board.entries.filter(e => e.status === 'run').length
    const bits = [this._setup.core]
    if (board.context !== undefined) bits.push(`${Math.round(board.context)}%`)
    if (running > 0) bits.push(`${running} ${this._setup.t.running}`)
    if (this._mode === 'demo') bits.push(this._setup.t.demoLabel)
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
  )
}

export function deactivate(): void {
  // Disposables are cleaned up automatically by VS Code extension host.
}
