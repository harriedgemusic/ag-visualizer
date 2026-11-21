# Security Policy & Audit Summary

## Security Architecture

**Antigravity Work Map (`ag-visualizer`)** is designed around strict least-privilege and passive observation:

1. **Read-Only Out-of-Process Observation**:
   - Never registers `PreToolUse` / `PostToolUse` hooks and never alters agent permissions, prompts, or tool arguments.
   - Reads `~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl` strictly with `fs.promises.open(path, 'r')` in bounded 64 KB chunks (`MAX_INITIAL_TAIL_BYTES = 4 MB`, `MAX_LINE_BYTES = 2 MB`, `StringDecoder('utf8')`).
   - Reads `conversation_summaries.db` strictly with Node's `node:sqlite` `{ readOnly: true, timeout: 250 }` and `PRAGMA query_only = ON`.
2. **Zero Network & Zero Subprocess Surface**:
   - Enforced on every build via TypeScript AST static analysis in [`scripts/check-surface.mjs`](scripts/check-surface.mjs).
   - `src/core/**` has zero Node.js, VS Code, filesystem, or network imports.
   - All of `src/**` bans `fetch`, `WebSocket`, `XMLHttpRequest`, `http`/`https`/`net`/`dns`/`tls`/`dgram`, `child_process`/`worker_threads`, `process.getBuiltinModule`, filesystem write/delete methods, and non-read-only `fs.open` / `DatabaseSync`.
3. **Webview & SVG Isolation**:
   - Webview HTML enforces strict CSP: `default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; script-src 'nonce-<crypto-random>';` using `crypto.randomBytes(18)`.
   - All user/model/DB strings are escaped (`escapeXml` for SVG, `escapeHtml` / `textContent` for HTML) and sanitized via `clean()` (stripping control, bidi, and zero-width characters).
   - `agVisualizer.antigravityDataDir` is `"scope": "application"` and `"restricted": true`, and rejects Windows UNC (`\\...` / `//...`) and relative paths to prevent untrusted workspaces from triggering SMB/NTLM lookups or redirecting transcript reads.

## AppSec Audit Summary

An internal Information Security audit was performed across the entire codebase (`src/`, `scripts/`, `demo/`, `test/`, `package.json`, `.vscodeignore`). All findings were remediated and covered by automated regression tests:

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

## Reporting a Vulnerability

If you discover a security or privacy issue, please open a private security advisory or issue on GitHub: https://github.com/harriedgemusic/ag-visualizer/issues
