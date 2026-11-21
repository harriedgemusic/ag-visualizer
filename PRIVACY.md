# Privacy

`ag-visualizer` runs 100% locally inside your Antigravity IDE extension host (or locally in your browser for the standalone `demo/index.html`). There is no backend service, no telemetry, and no network communication.

## What `ag-visualizer` reads

1. **Transcript logs (read-only)**: `~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/transcript.jsonl` (and `~/.gemini/antigravity-ide/...`). Read incrementally in bounded 64 KB chunks using `fs.promises.open(..., 'r')`.
2. **Session list metadata (read-only)**: `~/.gemini/antigravity/conversation_summaries.db` opened with Node's `node:sqlite` `{ readOnly: true, timeout: 250 }` and `PRAGMA query_only = ON` solely to display sanitized conversation titles (capped at 80 chars), workspace URIs (for auto-selecting the workspace conversation), and parent-child subagent links.

## What `ag-visualizer` discards immediately (Default `compact` & `verbose` modes)

Raw lines are parsed transiently to extract only:
- Event type & status (`USER_INPUT`, `PLANNER_RESPONSE`, `GENERIC`, `CHECKPOINT`, `SYSTEM_MESSAGE`, `ERROR_MESSAGE`)
- Validated numeric `step_index` (non-negative integer), timestamps (`created_at`, `Created At:`, `Completed At:`), and background task lifecycle IDs (for settling running tasks)
- Sanitized tool name (`toolName`, capped at 64 chars) — exposed only in `verbose`/`debug` IPC payloads, omitted from `compact`
- Model name and numeric token counts (`input_tokens`, `cache_read_tokens`, `output_tokens` — stored purely numerically in `modelSteps` for cache-hit % and sparklines)
- Classified station + sanitized label:
  - **Files**: last 2 path segments (`dir/file.ts`)
  - **URLs**: hostname only (`hostOf` via WHATWG `URL`) — logins, passwords, paths, queries, fragments, and schemeless tokens are stripped
  - **Shell commands**: `toolSummary` (model-authored short description, up to 120 chars) or executable binary name (`npm`, `git`, `ls`) — raw `CommandLine` is never stored in `compact` or `verbose`. *Note: like `lot-map`, model-authored descriptions (`toolSummary`, subagent `Role`, and DB session `title`) are displayed as cleaned short labels up to 120/80 chars.*
  - **Web / Grep / Find**: static label (`web search`, `grep_search`, `find_by_name`) — queries/patterns are discarded
  - **Subagents**: short `Role` / `TypeName` (up to 120 chars) — `Prompt` is discarded
  - **Questions / Plans / Schedules / Tasks**: allowlisted action or category name only — body text is discarded

## Opt-in `debug` detail level (Trusted Workspaces only)

When you explicitly select **`Debug`** inside a Trusted Workspace (or configure application-scoped `agVisualizer.detailLevel = "debug"`):
- A red **`DEBUG`** warning banner appears in the panel and status bar.
- Bounded previews (`<= 240` chars, sliced before scanning to `<= 600` chars) of line ranges (`L12-L48`), key arguments, error messages, tool output heads, and `thinking` snippets are extracted transiently in memory and displayed only inside clicked Step Detail Cards.
- Selecting **`Debug`** in the panel/QuickPick is **session-ephemeral** (never persisted into global VS Code settings) and disabled in untrusted workspaces (`vscode.workspace.isTrusted === false`), whereas switching between **`Compact`** and **`Verbose`** works cleanly in any workspace.
- Switching back to **`verbose`** or **`compact`** immediately scrubs every `debug` preview from memory (`TranscriptReducer.updateSetup()`).
- **Exports stay clean**: `formatMarkdownReport` (`📋` Copy Markdown Snapshot), `drawBrailleMap`, `computeBreakdown`, `computeTurnSummaries`, and `computeTokenStats` **never** read or export `debug` previews, even while `debug` mode is active.

## What `ag-visualizer` stores

- **In memory (during the IDE session)**: up to 80 sanitized `Entry` records, up to 60 numeric `ModelStepTelemetry` points, station counts, active fault counts, context percentage, active subagent indicators, and derived session-local inspector/breakdown/replay/turn views (never persisted to disk).
- **In `vscode.ExtensionContext.globalState`**: only UI viewport/toggle state — `zoom` (validated finite number between `0.6` and `1.4`), `hidden` (`true`/`false`), and `viewMode` (`"svg"` or `"braille"`). No conversation IDs, file paths, or session contents are persisted across restarts.
- **In VS Code User Configuration** (only when toggled via the UI controls): `agVisualizer.layout` (`"you-top"` / `"you-bottom"`) and `agVisualizer.detailLevel` (`"compact"` / `"verbose"` only — toolbar `[D]` never persists `"debug"`).
- **Clipboard (`📋` Copy Markdown Snapshot)**: only invoked explicitly on user click, copying the redacted Braille map, station counts/tokens table, and sanitized recent rows.
