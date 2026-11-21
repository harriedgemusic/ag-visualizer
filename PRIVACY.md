# Privacy

`ag-visualizer` runs 100% locally inside your Antigravity IDE extension host (or locally in your browser for the standalone `demo/index.html`). There is no backend service, no telemetry, and no network communication.

## What `ag-visualizer` reads

1. **Transcript logs (read-only)**: `~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/transcript.jsonl` (and `~/.gemini/antigravity-ide/...`). Read incrementally in bounded 64 KB chunks using `fs.promises.open(..., 'r')`.
2. **Session list metadata (read-only)**: `~/.gemini/antigravity/conversation_summaries.db` opened with Node's `node:sqlite` `{ readOnly: true, timeout: 250 }` and `PRAGMA query_only = ON` solely to display sanitized conversation titles (capped at 80 chars), workspace URIs (for auto-selecting the workspace conversation), and parent-child subagent links.

## What `ag-visualizer` discards immediately

Raw lines are parsed transiently to extract only:
- Event type & status (`USER_INPUT`, `PLANNER_RESPONSE`, `GENERIC`, `CHECKPOINT`, `SYSTEM_MESSAGE`, `ERROR_MESSAGE`)
- Timestamps (`created_at`, `Created At:`, `Completed At:`) and background task lifecycle IDs (for settling running tasks)
- Model name and token counts (`input_tokens`, `cache_read_tokens`)
- Classified station + sanitized label:
  - **Files**: last 2 path segments (`dir/file.ts`)
  - **URLs**: hostname only (`hostOf` via WHATWG `URL`) — logins, passwords, paths, queries, fragments, and schemeless tokens are stripped
  - **Shell commands**: `toolSummary` (model-authored short description, up to 120 chars) or executable binary name (`npm`, `git`, `ls`) — raw `CommandLine` is never stored. *Note: like `lot-map`, model-authored descriptions (`toolSummary`, subagent `Role`, and DB session `title`) are displayed as cleaned short labels up to 120/80 chars.*
  - **Web / Grep / Find**: static label (`web search`, `grep_search`, `find_by_name`) — queries/patterns are discarded
  - **Subagents**: short `Role` / `TypeName` (up to 120 chars) — `Prompt` is discarded
  - **Questions / Plans / Schedules / Tasks**: allowlisted action or category name only — body text is discarded

## What `ag-visualizer` stores

- **In memory (during the IDE session)**: up to 80 sanitized `Entry` records, station counts, active fault counts, context percentage, active subagent indicators, and derived session-local inspector/breakdown/replay views (never persisted).
- **In `vscode.ExtensionContext.globalState`**: only three UI preferences — `zoom` (validated finite number between `0.6` and `1.4`), `hidden` (`true`/`false`), and `viewMode` (`"svg"` or `"braille"`). No conversation IDs, file paths, or session contents are persisted across restarts.
- **Clipboard (`📋` Copy Markdown Snapshot)**: only invoked explicitly on user click, copying the redacted Braille map, station counts/tokens table, and sanitized recent rows.
