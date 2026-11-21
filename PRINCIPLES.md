# Principles

Inspired by [`lot-map`](https://github.com/alexeyw/lot-map) ([Habr article](https://habr.com/ru/articles/1110470/)), **Antigravity Work Map (`ag-visualizer`)** holds to six core principles. Each principle is backed by automated checks (`npm run check:surface` and `npm test`).

## 1. It watches and changes nothing

Antigravity's `PreToolUse` hooks require returning a permission `decision` (`allow`, `deny`, `ask`, or `force_ask`). Using them would put the visualizer inside the agent's control plane. Instead, `ag-visualizer` operates strictly **out-of-process and read-only**, tailing `~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl` and reading metadata from `conversation_summaries.db` with `{ readOnly: true }`.

- No workspace files or Antigravity state files are ever modified.
- No hooks are registered.
- Input step objects are never mutated (`test/principles.test.ts`).

## 2. A label holds a name, never content

Every raw tool call contains sensitive payloads: file contents, search patterns, shell arguments, URL tokens, subagent prompts, and system instructions. `classifyTool` and `TranscriptReducer` extract only sanitized metadata and discard the rest immediately:

- Files: last two path segments only (`src/app.ts`)
- Network URLs: hostname only (`example.com`), stripping credentials, paths, query parameters, and schemeless tokens
- Shell commands: `toolSummary` or executable binary name only, never flags or arguments
- Search tools & web searches: tool/category name only, never queries or patterns
- Subagents: short `Role` / `TypeName` only, never `Prompt`

Verified by the privacy canary test (`CANARY_SECRET_999` across 40+ tool payloads, in both `compact` and `verbose` modes — including `drawMap`, `foldRows`, `computeBreakdown`, `inspectStation`, `sliceBoardAt`, `drawBrailleMap`, `formatMarkdownReport`, `computeTurnSummaries`, `computeTokenStats`, and `drawContextSparkline`) in `test/principles.test.ts` and enforced statically by the TypeScript AST scanner in `scripts/check-surface.mjs` (zero network APIs, zero child processes, zero filesystem writes). The strictly opt-in, session-ephemeral `debug` mode (Trusted Workspaces only) bounds previews to 240 chars with a red `DEBUG` banner, never feeds Markdown exports, and purges all previews immediately upon exit.

## 3. It costs next to nothing

- **Zero tokens**: calls no model and injects nothing into prompts or context.
- **Bounded memory & CPU**: tailing reads only appended byte ranges in 64 KB chunks (with a 4 MB initial tail cap and 2 MB line cap), SQLite metadata is cached by `mtime`, idle polling does not rebuild the SVG DOM, and core classification/rendering stay within strict millisecond budgets (`test/principles.test.ts`).

## 4. A failure on the map never reaches your work

Because the extension runs passively in its own extension host process and observes transcripts read-only with defensive error handling around file I/O, SQLite, and webview messaging, any error degrades gracefully without interrupting the Antigravity agent loop.

## 5. The map stays calm

No decorative particle storms, no intrusive popups, no sound, no blocking controls. Pulses travel cleanly along spokes when tools run and cool down into worn routes. Supports `motion: "reduced"` and a `Hide map` toggle.

## 6. Works without configuration, respects yours

Installs and immediately auto-detects the active conversation for your open workspace (falling back to the latest active conversation). Supports 7 languages, dark/light/auto themes, transparent background, custom color roles, `you-top` / `you-bottom` layout, and custom station mappings for MCP servers and shell commands.
