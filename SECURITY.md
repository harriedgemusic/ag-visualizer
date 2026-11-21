# Security Policy & Audit Summary

## Security Architecture

**Antigravity Work Map (`ag-visualizer`)** is designed around strict least-privilege and passive observation:

1. **Read-Only Out-of-Process Observation**:
   - Never registers `PreToolUse` / `PostToolUse` hooks and never alters agent permissions, prompts, or tool arguments.
   - Reads `~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl` strictly with `fs.promises.open(path, 'r')` in bounded 64 KB chunks (`MAX_INITIAL_TAIL_BYTES = 4 MB`, `MAX_LINE_BYTES = 2 MB`, `StringDecoder('utf8')`).
   - Reads `conversation_summaries.db` strictly with Node's `node:sqlite` `{ readOnly: true, timeout: 250 }` and `PRAGMA query_only = ON`.
2. **Zero Network & Zero Subprocess Surface**:
   - Enforced on every build via TypeScript AST static analysis in `scripts/check-surface.mjs`.
   - `src/core/**` has zero Node.js, VS Code, filesystem, network, or external imports, and relative imports cannot escape `src/core/`.
   - All of `src/**` bans `fetch`, `WebSocket`, `XMLHttpRequest`, `EventSource`, `eval`, `new Function`, `http`/`https`/`http2`/`net`/`dns`/`tls`/`dgram`, `child_process`/`worker_threads`/`module`/`vm`/`inspector`, `process.getBuiltinModule`/`binding`/`dlopen`, filesystem write/delete methods, and non-read-only `fs.open`/`openSync` or `DatabaseSync`.
3. **Webview, SVG & Markdown Isolation**:
   - Webview HTML enforces strict CSP: `default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; script-src 'nonce-<crypto-random>';` using `crypto.randomBytes(18)`.
   - All user/model/DB strings are escaped (`escapeXml` for SVG, `escapeHtml` / `textContent` for HTML, full metacharacter + backslash escaping in `escapeMd` with dynamic fence sizing for Markdown) and sanitized via `clean()`.
   - Station IDs and Webview commands are allowlist-validated (`VALID_STATION_IDS`, `Number.isFinite` bounds, `Object.hasOwn` lookup guards).
   - `agVisualizer.antigravityDataDir` is `"scope": "application"` and `"restricted": true`, and rejects Windows UNC (`\\...` / `//...`) and relative paths to prevent untrusted workspaces from triggering SMB/NTLM lookups or redirecting transcript reads.

## AppSec Audit Summary

### v0.1.0 / v0.1.1 Audit

| ID | Severity | Finding | Remediation |
| --- | --- | --- | --- |
| HIGH-1 | High | Unbounded `Buffer.allocUnsafe` read, TOCTOU unhandled rejection, missing `isFile()` check, and UTF-8 split corruption in `TranscriptTailer` | Replaced with 64 KB chunked reads, 4 MB initial tail cap, 2 MB line cap, `StringDecoder('utf8')`, `st.isFile()` check, and `try/catch` |
| HIGH-2 | High | Workspace-overridable `antigravityDataDir` could redirect reads or trigger Windows UNC SMB/NTLM leaks | Marked `"scope": "application"` and `"restricted": true` in `package.json`; rejected UNC and relative paths in `discovery.ts` |
| HIGH-3 | High | `escapeXml` had typo `'&amp;'` instead of `'&'` as map key | Fixed map to escape `&`, `<`, `>`, `"`, `'` and added regression test |
| HIGH-4 | High | Background tasks and orphaned turns remained stuck in `status: 'run'`; unbounded `_stepEntryByOrigin` map | Added background task lifecycle tracking (`RUNNING` → `manage_task` cancel / `SYSTEM_MESSAGE` completion), orphan settling on `USER_INPUT`/turn-end, idle session reconciliation, and map cleanup |
| MEDIUM-1 | Medium | Non-cryptographic `Math.random()` CSP nonce; missing `base-uri`/`form-action` | Switched to `crypto.randomBytes(18).toString('base64')` and tightened CSP |
| MEDIUM-2 | Medium | `hostOf()` could leak password/query fragments or schemeless API tokens, and dropped `localhost:3000/@vite/client` | Rewrote `hostOf()` using WHATWG `new URL()` with mandatory scheme and strict host validation |
| MEDIUM-3 | Medium | Unvalidated `Action`/`action` strings and unbounded DB titles | Enforced `/^[\w-]{1,24}$/` on actions and `clean(title, 80)` on session titles |
| MEDIUM-4 | Medium | SQLite `SQLITE_BUSY` wiped session metadata; 2s unconditional reopen | Added `busy_timeout = 250`, WAL/DB `mtimeMs` caching, and stale-cache fallback on transient busy errors |
| MEDIUM-5 | Medium | Regex-based `check-surface.mjs` could be bypassed via URL comments, dynamic imports, or `open('w')` | Rewrote `scripts/check-surface.mjs` using TypeScript's AST (`ts.createSourceFile`) |
| MEDIUM-6 | Medium | `NaN` zoom corrupted `globalState`; unhandled `postMessage` rejections | Added strict runtime validation on all webview messages and `postMessage` `.catch()` cleanup |
| LOW-1..4 | Low | Listener disposal, refresh re-entrancy, idle 2s SVG rebuilds, `<select>` quote reset, >40-entry running desync, minor tool parsing edge cases | All fixed and covered by unit tests |
| INFO-1 | Info | Source maps in `.vsix` (`*.map` vs `**/*.map`); missing CSP in `demo/index.html` | Updated `.vscodeignore` to `**/*.map` and added strict CSP meta tag to `demo/index.html` |

### v0.2.0 Audit (Post-Feature Addition)

Zero **CRITICAL** or **HIGH** findings. All **MEDIUM** and **LOW** findings from the v0.2.0 AppSec review were remediated:

| ID | Severity | Finding | Remediation |
| --- | --- | --- | --- |
| MEDIUM-1 | Medium | Markdown link/image/HTML injection, `\|` table breakout, and triple-backtick fence breakout in `formatMarkdownReport` / `drawBrailleMap` | Full backslash + metacharacter escaping in `escapeMd()`, control/bidi stripping and backtick sanitization on canvas text, dynamic fence length (`>= 4` backticks) |
| MEDIUM-2 | Medium | AST surface guard missed relative escapes from `src/core`, `import=`, aliasing `DatabaseSync`/`globalThis`, `openSync`, `copy`, `node:module`/`vm`/`inspector` | Hardened `scripts/check-surface.mjs` to check relative import boundaries, `import=`, unwrapped expressions, global holders, `openSync`, `DatabaseSync` aliasing/spreads, and expanded fs/module denylists |
| MEDIUM-3 | Medium | `_selectedStation`/`_replayIndex` desync across session switches, `setReplayIndex` at `total`, and dropped user `refreshSessions` calls | Reset filter/replay on session & demo switches, normalize `index >= total` to Live, and queue pending refreshes with `_pendingRefresh` |
| MEDIUM-4 | Medium | Unbounded `shortModel()` on `claude-*` strings and unused `entries`/`model` exposed in Webview IPC | Added `clean(..., 24)` on Claude models, sanitized `step.model`/`tc.name` in `reducer.ts`, stripped `entries` and `model` from Webview IPC state |
| LOW-1..4 | Low | Prototype-property lookups (`COLOR_NAMES`/`stations`/`STATION_COLORS`), `NaN` propagation in formatters/metrics, negative-age SMIL animations, unhandled clipboard rejections, unreset `openRowId` | Added `Object.hasOwn` + `VALID_STATIONS` guards, `Number.isFinite` checks, `>= 0` animation age guards, `vscode.env.clipboard` + `.catch()`, and `openRowId` reset on session switch |

### v0.3.0 Audit (Selectable Detail Levels & Telemetry)

Zero **CRITICAL** findings. Every **HIGH**, **MEDIUM**, and **LOW** finding from the v0.3.0 AppSec review was remediated prior to release:

| ID | Severity | Finding | Remediation |
| --- | --- | --- | --- |
| HIGH-1 | High | Unvalidated `step.step_index` allowed non-numeric/HTML strings in `Entry.stepIdx`/`stepKey` and unescaped `stepIdx` interpolation under `style-src 'unsafe-inline'` | Enforced finite non-negative integer rounding for `stepIdx` at `TranscriptReducer.push()` entry, HTML-escaped `stepIdx` in `main.ts` & `demoEntry.ts`, gated detailed metadata behind `isDetailed` in IPC |
| MEDIUM-1 | Medium | Concurrency race between `TranscriptTailer.attach()`, `reload()`, and `pollOnce()`, missed update on empty `reload()`, and missing post-`dispose()` guard | Serialized all `attach`/`reload`/`pollOnce` operations through a single async queue with monotonic `_generation` and `_disposed` checks, and guaranteed post-reset UI updates |
| MEDIUM-2 | Medium | Truthy non-string `GENERIC.content` or malformed `tool_calls` elements (`null`/non-object/array `args`) could throw `TypeError` in `TranscriptReducer.push()` | Added strict `typeof content === 'string'` check in `parseGenericMetadata` and element/plain-object checks on `tool_calls` and `tc.args` |
| MEDIUM-3 | Medium | Selecting `debug` in an untrusted workspace Webview could persist `detailLevel: "debug"` into global User settings | Enforced `scope: "application"` on `agVisualizer.detailLevel`, added `vscode.workspace.isTrusted` guards in `config.ts` and `setDetailLevel` so `'debug'` is disabled in untrusted workspaces and session-ephemeral in memory, while allowing `compact`/`verbose` switching everywhere |
| LOW-1..4 | Low | Unbounded `StartLine`/`EndLine` passed to `unwrapValue()`, unused `model`/`stepIdx` in `ModelStepTelemetry`, unescaped direct-caller palette values in `drawMap`/`lightRules`, per-render listener/DOM churn | Bounded line-range strings (`<= 32` chars) before `unwrapValue()`, removed unused fields from `ModelStepTelemetry`, escaped palette values in `draw.ts`/`palette.ts`, moved Webview/demo clicks to one-time delegated listeners with `innerHTML` clearing on hide |

## Reporting a Vulnerability

If you discover a security or privacy issue, please open a private security advisory or issue on GitHub: https://github.com/harriedgemusic/ag-visualizer/issues
