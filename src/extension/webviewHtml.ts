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
  </style>
</head>
<body>
  <div id="app" class="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
}
