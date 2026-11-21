import crypto from 'node:crypto'
import * as vscode from 'vscode'

function makeNonce(): string {
  return crypto.randomBytes(18).toString('base64')
}

export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  isPanel: boolean,
): string {
  const nonce = makeNonce()
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'))
  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join('; ')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Antigravity Work Map</title>
  <style>
    :root {
      --ag-font-mono: SF Mono, ui-monospace, Menlo, Consolas, monospace;
      --ag-text-size: 12px;
      --ag-bg: transparent;
      --ag-fg: var(--vscode-foreground, #ebe6dc);
      --ag-dim: var(--vscode-descriptionForeground, #9ba1ab);
      --ag-border: var(--vscode-panel-border, rgba(128,128,128,0.22));
      --ag-accent: #e1ac6e;
      --ag-error: #e8654f;
      --ag-hover: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06));
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: var(--ag-bg);
      color: var(--ag-fg);
      font-family: var(--ag-font-mono);
      font-size: var(--ag-text-size);
      overflow-x: hidden;
    }
    .root {
      display: flex;
      flex-direction: column;
      min-height: 100%;
      padding: ${isPanel ? '12px 16px' : '8px 10px'};
      gap: 8px;
    }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      flex-wrap: wrap;
    }
    .session-select {
      flex: 1 1 130px;
      min-width: 0;
      max-width: 240px;
      height: 24px;
      padding: 0 6px;
      border-radius: 5px;
      border: 1px solid var(--ag-border);
      background: var(--vscode-dropdown-background, rgba(18,21,28,0.85));
      color: var(--vscode-dropdown-foreground, var(--ag-fg));
      font-family: inherit;
      font-size: 11px;
      outline: none;
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    .btn {
      height: 24px;
      min-width: 24px;
      padding: 0 7px;
      border-radius: 5px;
      border: 1px solid var(--ag-border);
      background: transparent;
      color: var(--ag-dim);
      font-family: inherit;
      font-size: 11px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background 120ms ease, color 120ms ease;
    }
    .btn:hover {
      background: var(--ag-hover);
      color: var(--ag-fg);
    }
    .map-wrap {
      display: flex;
      justify-content: center;
      align-items: center;
      width: 100%;
      overflow: hidden;
    }
    .map-wrap.is-hidden {
      display: none;
    }
    .map-stage {
      width: 100%;
      max-width: 460px;
      transform-origin: top center;
    }
    .map-stage svg {
      display: block;
      width: 100%;
      height: auto;
    }
    .now-bar {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      padding: 5px 2px;
      border-top: 1px solid var(--ag-border);
      border-bottom: 1px solid var(--ag-border);
      font-size: var(--ag-text-size);
    }
    .now-what {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--ag-fg);
    }
    .now-meter {
      flex-shrink: 0;
      color: var(--ag-dim);
      font-variant-numeric: tabular-nums;
    }
    .feed {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .feed-empty {
      padding: 8px 2px;
      color: var(--ag-dim);
    }
    .row {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      padding: 2px 3px;
      border-radius: 4px;
      line-height: 1.45;
      font-size: var(--ag-text-size);
    }
    .row:hover {
      background: var(--ag-hover);
    }
    .row-main {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      align-items: baseline;
      gap: 6px;
    }
    .row-mark {
      flex-shrink: 0;
      width: 10px;
      text-align: center;
    }
    .row-station {
      flex-shrink: 0;
      width: 72px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row-label {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row.is-open .row-label {
      white-space: normal;
      word-break: break-word;
    }
    .row-times {
      flex-shrink: 0;
      margin-left: 4px;
      opacity: 0.78;
    }
    .row-expand {
      flex-shrink: 0;
      background: transparent;
      border: none;
      color: var(--ag-dim);
      cursor: pointer;
      font-family: inherit;
      font-size: 11px;
      padding: 0 3px;
      line-height: 1.4;
    }
    .row-expand:hover {
      color: var(--ag-fg);
    }
    .row-meta {
      flex-shrink: 0;
      text-align: right;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .row.is-running .row-mark,
    .row.is-running .row-station,
    .row.is-running .row-label,
    .row.is-running .row-meta {
      color: var(--ag-accent);
    }
    .row.is-switch .row-mark,
    .row.is-switch .row-station,
    .row.is-switch .row-label,
    .row.is-switch .row-meta {
      color: var(--ag-accent);
    }
    .row.is-error .row-mark,
    .row.is-error .row-station,
    .row.is-error .row-label,
    .row.is-error .row-meta {
      color: var(--ag-error);
    }
    .row.is-ok .row-mark,
    .row.is-ok .row-station,
    .row.is-ok .row-label,
    .row.is-ok .row-meta {
      color: var(--ag-dim);
    }
    .row.is-moment .row-meta {
      opacity: 0.65;
    }
    .btn.is-active {
      border-color: var(--ag-accent);
      color: var(--ag-accent);
    }
    .detail-bar {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      width: 100%;
      border: 1px solid var(--ag-border);
      border-radius: 6px;
      overflow: hidden;
      background: rgba(128, 128, 128, 0.06);
    }
    .btn-detail {
      height: 26px;
      min-width: 0;
      padding: 0 6px;
      border: none;
      border-right: 1px solid var(--ag-border);
      border-radius: 0;
      background: transparent;
      color: var(--ag-dim);
      font-family: inherit;
      font-size: 11px;
      cursor: pointer;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      transition: background 120ms ease, color 120ms ease;
    }
    .btn-detail:last-child {
      border-right: none;
    }
    .btn-detail:hover:not(:disabled) {
      background: var(--ag-hover);
      color: var(--ag-fg);
    }
    .btn-detail:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }
    .btn-detail.is-active {
      background: rgba(225, 172, 110, 0.2);
      color: var(--ag-accent);
      font-weight: 600;
    }
    .btn-detail.is-debug-active {
      background: rgba(232, 101, 79, 0.22);
      color: var(--ag-error);
      font-weight: 700;
    }
    .debug-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 5px 8px;
      border-radius: 6px;
      border: 1px solid var(--ag-error);
      background: rgba(232, 101, 79, 0.14);
      color: var(--ag-error);
      font-size: 11px;
      line-height: 1.35;
    }
    .debug-banner-close {
      flex-shrink: 0;
      height: 20px;
      min-width: 20px;
      padding: 0 5px;
      border-radius: 4px;
      border: 1px solid var(--ag-error);
      background: transparent;
      color: var(--ag-error);
      font-family: inherit;
      font-size: 11px;
      cursor: pointer;
    }
    .breakdown-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 2px;
    }
    .legend-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 6px;
      border-radius: 4px;
      border: 1px solid var(--ag-border);
      background: rgba(128, 128, 128, 0.06);
      color: var(--ag-dim);
      font-family: inherit;
      font-size: 10.5px;
      cursor: pointer;
      font-variant-numeric: tabular-nums;
    }
    .legend-pill:hover,
    .legend-pill.is-selected {
      border-color: var(--ag-fg);
      color: var(--ag-fg);
    }
    .legend-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .quota-card {
      border: 1px solid var(--ag-border);
      border-radius: 8px;
      padding: 7px 9px;
      background: rgba(128, 128, 128, 0.05);
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 11px;
    }
    .quota-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    .quota-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--ag-fg);
      font-family: inherit;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      text-align: left;
    }
    .quota-badges {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
    }
    .quota-plan {
      padding: 1px 5px;
      border-radius: 4px;
      border: 1px solid var(--ag-border);
      color: var(--ag-dim);
      font-size: 10px;
    }
    .quota-pill {
      font-weight: 600;
      font-size: 11px;
    }
    .quota-list {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .quota-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .quota-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      font-variant-numeric: tabular-nums;
    }
    .quota-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--ag-fg);
    }
    .quota-val {
      flex-shrink: 0;
      white-space: nowrap;
      color: var(--ag-dim);
    }
    .quota-bar {
      width: 100%;
      height: 5px;
      border-radius: 3px;
      background: rgba(128, 128, 128, 0.2);
      overflow: hidden;
    }
    .quota-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 180ms ease;
    }
    .quota-foot {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 4px 10px;
      padding-top: 3px;
      border-top: 1px solid var(--ag-border);
      color: var(--ag-dim);
      font-size: 10.5px;
      font-variant-numeric: tabular-nums;
    }
    .telemetry-card {
      border: 1px solid var(--ag-border);
      border-radius: 8px;
      padding: 7px 9px;
      background: rgba(128, 128, 128, 0.05);
      display: flex;
      flex-direction: column;
      gap: 5px;
      font-size: 11px;
    }
    .telemetry-stats {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 4px 10px;
      color: var(--ag-dim);
      font-variant-numeric: tabular-nums;
    }
    .telemetry-stats strong {
      color: var(--ag-fg);
      font-weight: 600;
    }
    .telemetry-spark svg {
      display: block;
      width: 100%;
      height: auto;
      max-height: 44px;
    }
    .turns-card {
      border: 1px solid var(--ag-border);
      border-radius: 8px;
      padding: 6px 9px;
      background: rgba(128, 128, 128, 0.04);
      font-size: 11px;
    }
    .turns-toggle {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--ag-dim);
      font-family: inherit;
      font-size: 11px;
      cursor: pointer;
      text-align: left;
    }
    .turns-toggle:hover {
      color: var(--ag-fg);
    }
    .turns-list {
      display: flex;
      flex-direction: column;
      gap: 3px;
      margin-top: 6px;
      max-height: 180px;
      overflow-y: auto;
    }
    .turn-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      padding: 2px 3px;
      border-radius: 4px;
      color: var(--ag-dim);
      font-variant-numeric: tabular-nums;
    }
    .turn-row.is-active {
      color: var(--ag-accent);
    }
    .turn-left {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .turn-right {
      flex-shrink: 0;
      white-space: nowrap;
    }
    .feed.is-detailed {
      max-height: 360px;
      overflow-y: auto;
      padding-right: 2px;
    }
    .row.is-clickable {
      cursor: pointer;
    }
    .row.is-card-open {
      background: var(--ag-hover);
    }
    .row-ts {
      flex-shrink: 0;
      color: var(--ag-dim);
      opacity: 0.72;
      font-size: 10.5px;
      font-variant-numeric: tabular-nums;
    }
    .row-tool {
      flex-shrink: 0;
      padding: 0 4px;
      border-radius: 3px;
      border: 1px solid var(--ag-border);
      color: var(--ag-dim);
      font-size: 10px;
      max-width: 110px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .step-card {
      margin: 1px 0 4px 16px;
      padding: 7px 9px;
      border-left: 2px solid var(--ag-accent);
      border-radius: 0 6px 6px 0;
      background: rgba(128, 128, 128, 0.08);
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 11px;
      color: var(--ag-dim);
    }
    .step-card.is-err {
      border-left-color: var(--ag-error);
    }
    .step-card-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 12px;
      font-variant-numeric: tabular-nums;
    }
    .step-debug-block {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding-top: 3px;
      border-top: 1px solid var(--ag-border);
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--ag-fg);
    }
    .step-debug-key {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--ag-accent);
    }
    .step-debug-block.is-err .step-debug-key {
      color: var(--ag-error);
    }
    .braille-stage {
      margin: 0;
      padding: 8px;
      border-radius: 8px;
      border: 1px solid var(--ag-border);
      font-family: inherit;
      font-size: 10.5px;
      line-height: 1.2;
      overflow-x: auto;
      white-space: pre;
      color: var(--ag-fg);
      background: rgba(0, 0, 0, 0.16);
    }
    .replay-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 2px;
      font-size: 11px;
    }
    .replay-slider {
      flex: 1 1 auto;
      min-width: 60px;
      accent-color: var(--ag-accent);
      cursor: pointer;
    }
    .replay-live {
      min-width: 54px;
      font-variant-numeric: tabular-nums;
    }
    .breakdown-wrap {
      display: flex;
      flex-direction: column;
      gap: 5px;
      padding: 4px 2px;
    }
    .breakdown-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      color: var(--ag-dim);
      font-size: 11px;
    }
    .breakdown-bar {
      display: flex;
      height: 7px;
      border-radius: 4px;
      overflow: hidden;
      background: rgba(128, 128, 128, 0.16);
      gap: 1px;
    }
    .breakdown-seg {
      height: 100%;
      min-width: 4px;
      border: none;
      padding: 0;
      cursor: pointer;
      opacity: 0.85;
      transition: opacity 120ms ease;
    }
    .breakdown-seg:hover,
    .breakdown-seg.is-selected {
      opacity: 1;
      outline: 1px solid var(--ag-fg);
    }
    .inspector-card {
      border: 1px solid var(--ag-border);
      border-radius: 8px;
      padding: 8px 10px;
      background: rgba(128, 128, 128, 0.06);
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 11px;
    }
    .inspector-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .inspector-title {
      font-weight: 600;
      color: var(--ag-fg);
    }
    .inspector-metrics {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--ag-dim);
      font-variant-numeric: tabular-nums;
    }
    .inspector-top {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .inspector-top-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      color: var(--ag-dim);
    }
    .inspector-top-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  </style>
</head>
<body>
  <div id="app" class="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
}
