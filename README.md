# Antigravity Work Map (`ag-visualizer`)

A calm, passive, privacy-first live visual map of **Antigravity IDE** agent activity — built as a native Antigravity IDE extension + standalone browser demo.

> **Origin & Inspiration / Источник идеи**
>
> This project is directly inspired by [**`lot-map`**](https://github.com/alexeyw/lot-map) for Claude Code by **Alexey Volodin (`@alexeyw`)** and his Habr article:
> [«Как мод для Claude Code собрал 1000 звёзд за десять дней»](https://habr.com/ru/articles/1110470/) ([live demo](https://alexeyw.github.io/lot-map/)).
>
> `ag-visualizer` adapts the same calm visual language, 10-station orbital layout, context ring, route trail, token cost attribution, Unicode Braille canvas, and 6 core principles specifically to **Antigravity IDE** (`transcript.jsonl` + `conversation_summaries.db`, read-only out-of-process architecture).

---

## Features (v0.2.0)

- **10 Stations around the Core (`AGY`)**: `You`, `Model`, `Memory`, `Files`, `Shell`, `Network`, `Browser`, `Agents`, `Skills`, `Hooks` — with `you-top` or `you-bottom` orientation.
- **Context Window Ring & Model Status**: Displays live context fill (`input_tokens + cache_read_tokens`) around the central core (`<70%` ash, `70–89%` accent, `>=90%` red), active shortened model name (e.g., `neon-high`, `argon-high`, `hydrogen-xhigh`), model-switch concentric ripples, and answer-ready expanding ring.
- **Live Pulses, Worn Spokes & Route Trail**:
  - Spokes thicken and warm up logarithmically with station usage.
  - 3-dot comet pulses, landing ripples, spoke beams, return pulses, and parallel lanes.
  - Curved Bézier route trail connecting the last 7 visited stations (40s hold + 20s fade).
  - Active calls show radar pulses, dual clock hands (1 min / 10 min), `×N` concurrency badges, and red error fault counters.
  - Orbiting satellites around `Agents` for active subagents, plus pulses from `Agents` for subagent steps.
- **Turn Time & Context Token Breakdown Bar**: Segmented horizontal bar below the status line showing per-station share of tool execution time and context token growth (switchable `Time` / `Tokens`), plus turn/call totals.
- **Interactive Station Inspector & Feed Filter**: Click any station on the map or segment in the breakdown bar to inspect its call share, average/max latency, tokens, faults, top 4 frequent labels, and filter the activity feed to that station.
- **Session Time-Travel Replay & Turn Scrubber**: Scrub backward/forward through historical steps (`0..N`) or jump between user turns (`⏮` / `⏭` / `● Live`) to watch any past moment animate on the map.
- **Braille Orbital Mini-Map & Privacy-Safe Markdown Snapshot**: Toggle between SVG and Unicode Braille (`⠿` / `◇`) views right in the IDE, or copy a redacted Markdown summary (`📋`) with Braille map, station table, and recent activity.
- **Per-Step Context Cost (`contextCost`)**: Estimates how many tokens each step added to the context (`+42k`, `~+14k` when shared across 2–3 calls) and totals per station.
- **Strictly Passive, Read-Only & Privacy-First**:
  - Zero `PreToolUse` hooks (so permission decisions are never intercepted or altered).
  - Zero network calls, zero child processes, zero file writes — verified by a TypeScript AST capability guard (`scripts/check-surface.mjs`).
  - Only names are kept (last 2 path segments, URL hostnames, binary names / short labels); file contents, commands, queries, URL credentials, and prompts are discarded immediately.
- **7 Languages + `auto`**: English (`en`), Russian (`ru`), Spanish (`es`), French (`fr`), German (`de`), Italian (`it`), Portuguese (`pt`).
- **Sidebar + Editor Panel + Status Bar + Browser Demo**:
  - Dockable **Work Map** view in the Activity Bar (can be dragged next to chat).
  - Command `Antigravity Work Map: Open Beside Chat` (`agVisualizer.openPanel`).
  - Commands `Antigravity Work Map: Select Conversation` and `Antigravity Work Map: Toggle Demo Mode`.
  - Status Bar indicator (`AGY · 24%`).

---

## Installation in Antigravity IDE

```bash
git clone https://github.com/harriedgemusic/ag-visualizer.git
cd ag-visualizer
npm install
npm run check
npm run package
"/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide" --install-extension ag-visualizer-0.2.0.vsix --force
```

Reload Antigravity IDE (`Developer: Reload Window`), then click the **Work Map** icon in the Activity Bar or run **Antigravity Work Map: Open Beside Chat** from the Command Palette.

## Standalone Browser Demo

Run the exact same core engine offline in your browser with interactive station inspection, time-travel scrubber, Braille toggle, Markdown export, and a side-by-side **"What Antigravity wrote → What the map kept"** privacy inspector:

```bash
npm run build
open demo/index.html
```

---

## Configuration (`agVisualizer.*`)

| Setting | Default | Description |
| --- | --- | --- |
| `agVisualizer.language` | `"auto"` | `auto`, `en`, `ru`, `es`, `fr`, `de`, `it`, `pt` |
| `agVisualizer.theme` | `"auto"` | `auto` (follows IDE theme), `dark`, `light` |
| `agVisualizer.background` | `"solid"` | `solid` or `transparent` |
| `agVisualizer.layout` | `"you-top"` | `you-top` or `you-bottom` |
| `agVisualizer.motion` | `"full"` | `full` or `reduced` |
| `agVisualizer.coreName` | `"AGY"` | Short label inside the central core (up to 12 chars) |
| `agVisualizer.contextCost` | `true` | Show estimated context token delta per call and per station |
| `agVisualizer.contextWindowTokens` | `0` | Context denominator override (`0` = auto by model, e.g. `1,000,000` for Gemini) |
| `agVisualizer.textSize` | `"footnote"` | Feed font size: `caption`, `footnote`, `body` |
| `agVisualizer.subagentNames` | `true` | Prefix subagent steps with their short role name |
| `agVisualizer.colors` | `{}` | Override palette colors by role (`background`, `node`, `line`, `spoke`, `text`, `label`, `faint`, `accent`, `active`, `error`, `memory`, `memoryActive`, `route`) |
| `agVisualizer.memoryPaths` | `[]` | Extra path fragments routed to `Memory` |
| `agVisualizer.memoryServers` | `[]` | MCP server names routed to `Memory` |
| `agVisualizer.memoryCommands` | `[]` | Shell commands routed to `Memory` |
| `agVisualizer.serverStations` | `{}` | Map MCP server names to custom station IDs |
| `agVisualizer.commandStations` | `{}` | Map shell command names to custom station IDs |
| `agVisualizer.antigravityDataDir` | `""` | Application-scoped override for Antigravity data directory (defaults to `~/.gemini/antigravity`) |

---

## Architecture

```text
src/
├── core/        # Pure, zero-I/O engine (types, palette, 7-lang text, setup, classify, cost, feed, draw, reducer, breakdown, inspector, replay, braille, demo)
├── watcher/     # Strictly read-only transcript tailer (64 KB chunked) & SQLite/FS session discovery
├── extension/   # Antigravity IDE (VS Code) extension host, settings, strict-CSP webview shell
└── webview/     # Webview client & standalone browser demo entrypoint
scripts/
└── check-surface.mjs  # TypeScript AST capability guard (zero net, zero exec, zero fs writes)
test/                  # Unit, privacy canary, performance budget, and reducer regression tests
```

## Verification

```bash
npm run check
```

Runs:
1. `tsc --noEmit` — strict TypeScript typecheck
2. `node scripts/check-surface.mjs` — AST capability guard verifying read-only & network-free surface
3. `node --import tsx --test test/*.test.ts` — classification, privacy canary (`CANARY_SECRET_999`), CPU budgets, SVG/XML/Markdown escaping, breakdown/inspector/replay/braille, and background task lifecycle tests
4. `node esbuild.mjs` — bundles `dist/extension.js`, `dist/webview.js`, and `demo/bundle.js`

## Documentation & Policies

- [PRINCIPLES.md](https://github.com/harriedgemusic/ag-visualizer/blob/main/PRINCIPLES.md) — The 6 core principles and how automated tests enforce them
- [PRIVACY.md](https://github.com/harriedgemusic/ag-visualizer/blob/main/PRIVACY.md) — Exact data handling, redaction rules, and storage scope
- [SECURITY.md](https://github.com/harriedgemusic/ag-visualizer/blob/main/SECURITY.md) — Threat model, security controls, and AppSec audit summaries

## License

MIT
