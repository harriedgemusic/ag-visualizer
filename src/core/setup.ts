import { COLOR_NAMES } from './palette'
import type { Palette } from './palette'
import { stringsFor } from './text'
import type { Strings } from './text'
import type { StationId, UserOptions } from './types'

function ring(x: number, y: number, r: number): string {
  return `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`
}

export const STATIONS: { id: StationId; icon: string }[] = [
  { id: 'you', icon: `${ring(0, -3.6, 3.4)}M-6.5 8c0-4 3-6.2 6.5-6.2s6.5 2.2 6.5 6.2` },
  { id: 'model', icon: 'M-5 -5h10v10h-10zM-2 -8.5v3.5M2 -8.5v3.5M-2 5v3.5M2 5v3.5M-8.5 -2h3.5M-8.5 2h3.5M5 -2h3.5M5 2h3.5' },
  { id: 'memory', icon: `M-5 4.5L0 -5L6 3.5M-5 4.5L6 3.5${ring(-5, 4.5, 2.1)}${ring(0, -5, 2.1)}${ring(6, 3.5, 2.1)}` },
  { id: 'files', icon: 'M-5.5 -8h7.5l3.5 3.5v12.5h-11zM2 -8v3.5h3.5' },
  { id: 'shell', icon: 'M-7.5 -5l5 5l-5 5M0 6h7.5' },
  { id: 'web', icon: `${ring(0, 0, 7.8)}M-7.8 0h15.6M0 -7.8c-4.2 4.2 -4.2 11.4 0 15.6M0 -7.8c4.2 4.2 4.2 11.4 0 15.6` },
  { id: 'browser', icon: 'M-8.5 -6.5h17v13h-17zM-8.5 -2.8h17M-6.3 -4.7h.1M-3.8 -4.7h.1' },
  { id: 'agents', icon: `M0 -4v3.5M0 -.5L-6 4M0 -.5L6 4${ring(0, -6, 2.1)}${ring(-6.5, 5.5, 2.1)}${ring(6.5, 5.5, 2.1)}` },
  { id: 'skills', icon: 'M1.5 -8.5L-5.5 1h4.5l-1.5 7.5l7.5 -9.8h-4.5z' },
  { id: 'hooks', icon: `M2.5 -5.5v8a4.2 4.2 0 1 1 -8.4 0v-1.5${ring(2.5, -7.3, 1.8)}` },
]

export type Setup = {
  t: Strings
  core: string
  memoryServers: ReadonlySet<string>
  memoryCommands: readonly string[]
  memorySubcommands: ReadonlySet<string>
  memoryPaths: readonly string[]
  memoryLabels: ReadonlyMap<string, string>
  serverStations: ReadonlyMap<string, StationId>
  commandStations: ReadonlyMap<string, StationId>
  subagentNames: boolean
  contextCost: boolean
  contextWindowTokens: number
  theme: 'auto' | 'dark' | 'light'
  background: 'solid' | 'transparent'
  colors: Partial<Palette>
  layout: 'you-top' | 'you-bottom'
  motion: 'full' | 'reduced'
  textSize: 'caption' | 'footnote' | 'body'
}

const SERVER_STATIONS: readonly StationId[] = ['files', 'shell', 'web', 'browser', 'agents', 'skills', 'you']

const flag = (v: unknown, byDefault: boolean): boolean =>
  v === true || v === 'true' ? true : v === false || v === 'false' ? false : byDefault

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [])
    .map(x => String(x).trim())
    .filter(x => x !== '')

function cleanCoreName(v: unknown): string {
  if (typeof v !== 'string') return 'AGY'
  const stripped = v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim()
  const chars = [...stripped].slice(0, 12).join('').trim()
  return chars === '' ? 'AGY' : chars
}

function stationsFrom(value: unknown): Map<string, StationId> {
  const chosen = new Map<string, StationId>()
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const station = SERVER_STATIONS.find(id => id === String(v).trim())
      if (k.trim() && station !== undefined) chosen.set(k.trim(), station)
    }
    return chosen
  }
  for (const pair of list(value)) {
    const at = pair.indexOf('=')
    const station = SERVER_STATIONS.find(id => id === pair.slice(at + 1).trim())
    if (at > 0 && station !== undefined) chosen.set(pair.slice(0, at).trim(), station)
  }
  return chosen
}

function normalizeHex(raw: string): string | undefined {
  const hex = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim())?.[0].toLowerCase()
  if (hex === undefined) return undefined
  return hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex
}

function colorsFrom(v: unknown): Partial<Palette> {
  const out: Partial<Palette> = {}
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [rawKey, rawVal] of Object.entries(v as Record<string, unknown>)) {
      const name = rawKey.trim()
      const key = Object.hasOwn(COLOR_NAMES, name) ? COLOR_NAMES[name] : undefined
      const hex = typeof rawVal === 'string' ? normalizeHex(rawVal) : undefined
      if (key !== undefined && hex !== undefined) out[key] = hex
    }
    return out
  }
  for (const pair of list(v)) {
    const at = pair.indexOf('=')
    const name = pair.slice(0, at).trim()
    const key = Object.hasOwn(COLOR_NAMES, name) ? COLOR_NAMES[name] : undefined
    const hex = normalizeHex(pair.slice(at + 1))
    if (at < 1 || key === undefined || hex === undefined) continue
    out[key] = hex
  }
  return out
}

export function setupFrom(options: UserOptions & Readonly<Record<string, unknown>> = {}, fallbackLocale = 'en'): Setup {
  const memoryLabels = new Map<string, string>()
  for (const pair of list(options.memoryLabels)) {
    const at = pair.indexOf('=')
    if (at > 0 && at < pair.length - 1) memoryLabels.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
  }
  const cw = typeof options.contextWindowTokens === 'number' && Number.isFinite(options.contextWindowTokens) && options.contextWindowTokens > 0
    ? Math.round(options.contextWindowTokens)
    : 0

  return {
    t: stringsFor(options.language, fallbackLocale),
    core: cleanCoreName(options.coreName),
    memoryServers: new Set(list(options.memoryServers)),
    memoryCommands: list(options.memoryCommands),
    memorySubcommands: new Set(list(options.memorySubcommands)),
    memoryPaths: list(options.memoryPaths),
    memoryLabels,
    serverStations: stationsFrom(options.serverStations),
    commandStations: stationsFrom(options.commandStations),
    subagentNames: flag(options.subagentNames, true),
    contextCost: flag(options.contextCost, true),
    contextWindowTokens: cw,
    theme: options.theme === 'dark' || options.theme === 'light' ? options.theme : 'auto',
    background: options.background === 'transparent' ? 'transparent' : 'solid',
    colors: colorsFrom(options.colors),
    layout: options.layout === 'you-bottom' ? 'you-bottom' : 'you-top',
    motion: options.motion === 'reduced' ? 'reduced' : 'full',
    textSize: options.textSize === 'caption' || options.textSize === 'body' ? options.textSize : 'footnote',
  }
}
