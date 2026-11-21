import { formatTokens, shortModel } from './classify'
import { DARK, LIGHT, lightRules } from './palette'
import type { Palette } from './palette'
import { STATIONS } from './setup'
import type { Setup } from './setup'
import type { Strings } from './text'
import type { Board, Entry, StationId } from './types'

const W = 460
const H = 430
export const MAP_ASPECT = H / W
const CX = 230
const CY = 212
const RX = 176
const RY = 164
const NODE = 22
const CORE = 40
const HUB = CORE + 8

const FONT = 'font-family="SF Mono, ui-monospace, Menlo, monospace"'

export const PULSE_MS = 800
const RIPPLE_MS = 450
export const GLOW_MS = 3200
export const ALARM_MS = 6000
export const SWITCH_MS = 8000
export const DONE_MS = 1100
const TRAIL_STOPS = 7
export const TRAIL_HOLD_MS = 40_000
export const TRAIL_FADE_MS = 20_000

type Point = { x: number; y: number }

const turn = (i: number, shift: number): number => ((i + shift) * 2 * Math.PI) / STATIONS.length
const at = (a: number, f = 1): Point => ({ x: CX + RX * f * Math.sin(a), y: CY - RY * f * Math.cos(a) })
const place = (i: number, shift: number): Point => at(turn(i, shift))
const indexOf = (id: StationId): number => STATIONS.findIndex(s => s.id === id)

const n1 = (v: number): string => (Math.round(v * 10) / 10).toString()
const clock = (ms: number): string => `${(ms / 1000).toFixed(3)}s`

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

function edge(from: Point, to: Point, r: number): Point {
  const d = Math.hypot(to.x - from.x, to.y - from.y) || 1
  return { x: from.x + ((to.x - from.x) * r) / d, y: from.y + ((to.y - from.y) * r) / d }
}

function aside(a: Point, b: Point, off: number): [Point, Point] {
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const dx = (-(b.y - a.y) * off) / d
  const dy = ((b.x - a.x) * off) / d
  return [
    { x: a.x + dx, y: a.y + dy },
    { x: b.x + dx, y: b.y + dy },
  ]
}

function pulse(a: Point, b: Point, color: string, age: number, radius: number, isHollow = false): string {
  const path = `M${n1(a.x)} ${n1(a.y)}L${n1(b.x)} ${n1(b.y)}`
  let out = ''
  for (let k = isHollow ? 0 : 2; k >= 0; k--) {
    const timing = `begin="${clock(k * 45 - age)}" dur="${clock(PULSE_MS)}" fill="freeze"`
    const peak = n1(1 - 0.36 * k)
    const paint = isHollow ? `fill="none" stroke="${color}" stroke-width="1.4"` : `fill="${color}"`
    out +=
      `<circle r="${n1(radius * (1 - 0.27 * k))}" ${paint} opacity="0">` +
      `<animateMotion path="${path}" ${timing}/>` +
      `<animate attributeName="opacity" values="${peak};${peak};0" keyTimes="0;.82;1" ${timing}/>` +
      `</circle>`
  }
  return out
}

function ripple(p: Point, r: number, color: string, age: number): string {
  const timing = `begin="${clock(PULSE_MS - age)}" dur="${clock(RIPPLE_MS)}" fill="freeze"`
  return (
    `<circle cx="${n1(p.x)}" cy="${n1(p.y)}" r="${r}" fill="none" stroke="${color}" stroke-width="1.2" opacity="0">` +
    `<animate attributeName="r" values="${r};${r + 11}" ${timing}/>` +
    `<animate attributeName="opacity" values=".7;0" ${timing}/></circle>`
  )
}

function beam(a: Point, b: Point, color: string, age: number, isDashed: boolean): string {
  return (
    `<line x1="${n1(a.x)}" y1="${n1(a.y)}" x2="${n1(b.x)}" y2="${n1(b.y)}" stroke="${color}" stroke-width="1.4"${isDashed ? ' stroke-dasharray="3 4"' : ''} opacity="0">` +
    `<animate attributeName="opacity" values=".75;0" begin="${clock(-age)}" dur="${clock(GLOW_MS / 2)}" fill="freeze"/></line>`
  )
}

const BEND = [0.5, 0.5, 0.4, 0.45, 0.55, 0.75]

function leg(i: number, j: number, shift: number): { path: string; end: Point } {
  const n = STATIONS.length
  let steps = (((j - i) % n) + n) % n
  if (steps > n / 2) steps -= n
  const bend = at(turn(i + steps / 2, shift), BEND[Math.abs(steps)] ?? 0.5)
  const a = edge(place(i, shift), bend, NODE + 4)
  const b = edge(place(j, shift), bend, NODE + 4)
  return { path: `M${n1(a.x)} ${n1(a.y)}Q${n1(bend.x)} ${n1(bend.y)} ${n1(b.x)} ${n1(b.y)}`, end: b }
}

export function routeOf(entries: readonly Entry[], max = TRAIL_STOPS): { station: StationId; at: number }[] {
  const stops: { station: StationId; at: number }[] = []
  for (const e of entries) {
    if (e.from === 'agents' || e.station === 'model') continue
    const last = stops[stops.length - 1]
    if (last !== undefined && last.station === e.station) last.at = e.startedAt
    else stops.push({ station: e.station, at: e.startedAt })
  }
  return stops.slice(-max)
}

function trail(entries: readonly Entry[], now: number, c: Palette, isStill: boolean, shift: number): string {
  const stops = routeOf(entries)
  let out = ''
  for (let k = 1; k < stops.length; k++) {
    const from = stops[k - 1]
    const to = stops[k]
    if (from === undefined || to === undefined) continue
    const { path, end } = leg(indexOf(from.station), indexOf(to.station), shift)
    const isHead = k === stops.length - 1
    const age = now - to.at
    if (age >= TRAIL_HOLD_MS + TRAIL_FADE_MS) continue
    const opacity = n1(0.12 + (0.5 * k) / (stops.length - 1))
    const fade = `<animate attributeName="opacity" values="${opacity};0" begin="${clock(TRAIL_HOLD_MS - age)}" dur="${clock(TRAIL_FADE_MS)}" fill="freeze"/>`
    const drawing =
      isHead && !isStill
        ? ` pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1"><animate attributeName="stroke-dashoffset" values="1;0" begin="${clock(to.at - now)}" dur=".5s" fill="freeze"/>`
        : '>'
    out += `<path d="${path}" fill="none" stroke="${c.trail}" stroke-width="${isHead ? 1.5 : 1.1}" stroke-linecap="round" opacity="${opacity}"${drawing}${fade}</path>`
    if (isHead) {
      out +=
        `<circle cx="${n1(end.x)}" cy="${n1(end.y)}" r="2.4" fill="${c.trail}" opacity="${isStill ? '.85' : '0'}">` +
        (isStill ? '' : `<animate attributeName="opacity" values="0;.85" begin="${clock(to.at - now + 400)}" dur=".15s" fill="freeze"/>`) +
        `<animate attributeName="opacity" values=".85;0" begin="${clock(TRAIL_HOLD_MS - age)}" dur="${clock(TRAIL_FADE_MS)}" fill="freeze"/></circle>`
    }
  }
  return out
}

type Scene = {
  entries: Entry[]
  board: Board
  now: number
  c: Palette
  names: Strings['stations']
  isStill: boolean
  shift: number
  spent: Board['spent'] | undefined
  formatTokens: (n: number) => string
}

function station(
  s: (typeof STATIONS)[number],
  i: number,
  { entries, board, now, c, names, isStill, shift, spent, formatTokens }: Scene,
): { under: string; over: string } {
  const p = place(i, shift)
  const x = n1(p.x)
  const y = n1(p.y)
  const atStation = entries.filter(e => e.station === s.id)
  const running = atStation.filter(e => e.status === 'run')
  const latest = atStation[atStation.length - 1]
  const lastAt = latest === undefined ? -Infinity : Math.max(latest.startedAt, latest.endedAt ?? 0)
  const isBad = (e: Entry): boolean => e.status === 'block' || e.status === 'err'
  const lastBad = [...atStation].reverse().find(isBad)
  const badAt = lastBad === undefined ? -Infinity : (lastBad.endedAt ?? lastBad.startedAt)
  const fade = now - lastAt
  const isAlarm = lastBad !== undefined && now - badAt < ALARM_MS && badAt >= lastAt
  const span = isAlarm ? ALARM_MS : GLOW_MS
  const isLit = running.length > 0 || (latest !== undefined && fade < span)
  const count = board.counts[s.id] ?? 0
  const [main, hot] = s.id === 'memory' ? [c.mem, c.memHot] : [c.accent, c.hot]
  const color = isAlarm ? c.red : main

  let under = ''
  if (isLit) {
    const glow = running.length > 0 ? '.22' : '.16'
    const halo = `<circle cx="${x}" cy="${y}" r="${NODE + 6}" fill="${color}" opacity="${glow}"`
    under +=
      running.length > 0
        ? `${halo}/>`
        : `${halo}><animate attributeName="opacity" values="${glow};0" begin="${clock(-fade)}" dur="${clock(span)}" fill="freeze"/></circle>`
  }

  if (running.length > 0) {
    const earliest = running.reduce((m, e) => Math.min(m, e.startedAt), Infinity)
    const elapsed = Math.max(0, now - earliest)
    const beat = `begin="${clock(-(elapsed % 1800))}" dur="1.8s" repeatCount="indefinite"`
    if (!isStill) {
      under +=
        `<circle cx="${x}" cy="${y}" r="${NODE}" fill="none" stroke="${color}" stroke-width="1.3">` +
        `<animate attributeName="r" values="${NODE};${NODE + 15}" ${beat}/>` +
        `<animate attributeName="opacity" values=".9;0" ${beat}/></circle>`
    }
    const hand = (r: number, width: number, lapMs: number, isOnce: boolean): string =>
      `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${hot}" stroke-width="${width}" pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1" transform="rotate(-90 ${x} ${y})">` +
      `<animate attributeName="stroke-dashoffset" values="1;0" begin="${clock(-(isOnce ? Math.min(elapsed, lapMs) : elapsed % lapMs))}" dur="${clock(lapMs)}" ${isOnce ? 'fill="freeze"' : 'repeatCount="indefinite"'}/></circle>`
    under += hand(NODE + 4, 2.2, 60_000, false) + hand(NODE + 8, 1.2, 600_000, true)
  }

  const lit = `<circle cx="${x}" cy="${y}" r="${NODE}" fill="none" stroke="${color}" stroke-width="1.2"`
  const cooling =
    running.length > 0
      ? `${lit}/>`
      : isLit || isAlarm
        ? `${lit} opacity="0"><animate attributeName="opacity" values="1;0" begin="${clock(-fade)}" dur="${clock(span)}" fill="freeze"/></circle>`
        : ''
  const glyphColor = isAlarm ? c.red : isLit ? hot : s.id === 'memory' && count > 0 ? main : c.ash
  const rim = `paint-order="stroke" stroke="${c.ground}" stroke-width="3.5" stroke-linejoin="round"`
  let over =
    `<circle cx="${x}" cy="${y}" r="${NODE}" fill="${c.raised}" stroke="${c.line}" stroke-width="1.2"/>${cooling}` +
    `<path transform="translate(${x} ${y})" d="${s.icon}" fill="none" stroke="${glyphColor}" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<text x="${x}" y="${n1(p.y + NODE + 15)}" text-anchor="middle" ${FONT} font-size="11.5" ${rim} fill="${isLit || isAlarm ? c.bone : c.ash}">${escapeXml(names[s.id])}</text>`

  if (count > 0) {
    const pushed = s.id === 'memory' ? Math.min(count, board.pushed ?? 0) : 0
    const asked = count - pushed
    const figures =
      pushed === 0 ? String(count) : `${asked > 0 ? `${asked} ` : ''}<tspan fill="${main}">↓${pushed}</tspan>`
    const tokens = spent?.[s.id] ?? 0
    const cost = tokens > 0 ? ` · ${formatTokens(tokens)}` : ''
    over += `<text x="${x}" y="${n1(p.y + NODE + 28)}" text-anchor="middle" ${FONT} font-size="9.5" ${rim} fill="${c.dim}">${figures}${cost}</text>`
  }

  const corner = NODE * 0.74
  if (running.length > 1) {
    over +=
      `<circle cx="${n1(p.x + corner)}" cy="${n1(p.y - corner)}" r="8" fill="${c.raised}" stroke="${color}" stroke-width="1"/>` +
      `<text x="${n1(p.x + corner)}" y="${n1(p.y - corner + 3)}" text-anchor="middle" ${FONT} font-size="8.5" fill="${hot}">×${running.length}</text>`
  }
  const faults = board.faults?.[s.id] ?? 0
  if (faults > 0) {
    over +=
      `<circle cx="${n1(p.x - corner)}" cy="${n1(p.y - corner)}" r="7.5" fill="${c.red}"/>` +
      `<text x="${n1(p.x - corner)}" y="${n1(p.y - corner + 3.1)}" text-anchor="middle" ${FONT} font-size="9" font-weight="700" fill="${c.ground}">${faults > 99 ? '99+' : faults}</text>`
  }
  return { under, over }
}

export type DrawHelpers = {
  shortModel: (model: string) => string
  formatTokens: (tokens: number) => string
}

export function drawMap(
  board: Board,
  now: number,
  setup: Setup,
  helpers: DrawHelpers = { shortModel, formatTokens },
): string {
  const c: Palette = { ...(setup.theme === 'light' ? LIGHT : DARK), ...setup.colors }
  const shift = setup.layout === 'you-bottom' ? STATIONS.length / 2 : 0
  const core: Point = { x: CX, y: CY }
  const tail40 = board.entries.slice(-40)
  const tailIds = new Set(tail40.map(e => e.id))
  const olderRunning = board.entries.filter(e => e.status === 'run' && !tailIds.has(e.id))
  const recent = olderRunning.length > 0 ? [...olderRunning, ...tail40] : tail40
  const isStill = setup.motion === 'reduced'
  const flights = isStill ? [] : recent.filter(e => now - e.startedAt < PULSE_MS + RIPPLE_MS).slice(-14)
  const returns = isStill
    ? []
    : recent.filter(e => e.endedAt !== undefined && e.from !== 'inbound' && now - e.endedAt < PULSE_MS + RIPPLE_MS).slice(-14)
  const beams = recent.filter(e => now - e.startedAt < GLOW_MS / 2).slice(-10)
  const anyRunning = recent.some(e => e.status === 'run')
  const agentsAt = place(indexOf('agents'), shift)
  const isBad = (e: Entry): boolean => e.status === 'block' || e.status === 'err'
  const tone = (e: Entry): [string, string] => (e.station === 'memory' ? [c.mem, c.memHot] : [c.accent, c.hot])

  let body = setup.background === 'transparent' ? '' : `<rect width="${W}" height="${H}" rx="12" fill="${c.ground}"/>`

  for (const [rx, ry] of [
    [66, 62],
    [104, 97],
    [142, 132],
  ] as const) {
    body += `<ellipse cx="${CX}" cy="${CY}" rx="${rx}" ry="${ry}" fill="none" stroke="${c.line}" stroke-width=".7" opacity=".45" stroke-dasharray="2 5"/>`
  }

  STATIONS.forEach((s, i) => {
    const p = place(i, shift)
    const a = edge(core, p, HUB)
    const b = edge(p, core, NODE)
    const worn = Math.min(1, Math.log2(1 + (board.counts[s.id] ?? 0)) / 7)
    const line = `<line x1="${n1(a.x)}" y1="${n1(a.y)}" x2="${n1(b.x)}" y2="${n1(b.y)}" stroke-width="${n1(1 + 2.6 * worn)}" stroke-linecap="round"`
    body += `${line} stroke="${c.spoke}"/>`
    if (worn > 0) body += `${line} stroke="${s.id === 'memory' ? c.mem : c.accent}" opacity="${n1(worn * 0.55)}"/>`
  })

  const scene: Scene = {
    entries: recent,
    board,
    now,
    c,
    names: setup.t.stations,
    isStill,
    shift,
    spent: setup.contextCost ? board.spent : undefined,
    formatTokens: helpers.formatTokens,
  }
  const drawn = STATIONS.map((s, i) => station(s, i, scene))
  body += drawn.map(d => d.under).join('')
  body += trail(recent, now, c, isStill, shift)

  const ends = (e: Entry): [Point, Point] => {
    const p = place(indexOf(e.station), shift)
    const start = e.from === 'agents' ? agentsAt : core
    return [edge(start, p, e.from === 'agents' ? NODE : HUB), edge(p, start, NODE)]
  }
  const lane = (list: Entry[], e: Entry): number => {
    const peers = list.filter(x => x.station === e.station && x.from === e.from)
    return (peers.indexOf(e) - (peers.length - 1) / 2) * 5
  }

  for (const e of beams) {
    const [a, b] = ends(e)
    body += beam(a, b, isBad(e) ? c.red : tone(e)[0], now - e.startedAt, e.from === 'inbound')
  }
  for (const e of flights) {
    const [a, b] = aside(...ends(e), lane(flights, e))
    const age = now - e.startedAt
    const color = e.status === 'block' ? c.red : tone(e)[1]
    if (e.from === 'inbound') {
      body += pulse(b, a, color, age, 3.8, true) + ripple(core, HUB - 2, color, age)
    } else {
      body += pulse(a, b, color, age, 3.8) + ripple(place(indexOf(e.station), shift), NODE, color, age)
    }
  }
  for (const e of returns) {
    const [a, b] = aside(...ends(e), lane(returns, e))
    body += pulse(b, a, e.status === 'ok' ? c.ash : c.red, now - (e.endedAt as number), 2.6)
  }

  body += drawn.map(d => d.over).join('')

  const activeCrew = (board.agents ?? []).filter(a => a.endedAt === undefined).slice(0, 6)
  activeCrew.forEach((_, k) => {
    const lap = 7000
    const spin = `${n1(agentsAt.x)} ${n1(agentsAt.y)}`
    if (isStill) {
      body += `<g transform="rotate(${n1((360 * k) / activeCrew.length)} ${spin})"><circle cx="${n1(agentsAt.x)}" cy="${n1(agentsAt.y - NODE - 6)}" r="3" fill="${c.hot}"/></g>`
      return
    }
    body +=
      `<g><animateTransform attributeName="transform" type="rotate" from="0 ${spin}" to="360 ${spin}" begin="${clock(-((now + (k * lap) / activeCrew.length) % lap))}" dur="${clock(lap)}" repeatCount="indefinite"/>` +
      `<circle cx="${n1(agentsAt.x)}" cy="${n1(agentsAt.y - NODE - 6)}" r="3" fill="${c.hot}"/></g>`
  })

  const coreSize = Math.min(17, 62 / (0.75 * setup.core.length))
  const period = anyRunning ? 1600 : 4800
  const breath = `begin="${clock(-(now % period))}" dur="${clock(period)}" repeatCount="indefinite"`
  body +=
    (isStill
      ? `<circle cx="${CX}" cy="${CY}" r="${CORE + 8}" fill="${c.accent}" opacity="${anyRunning ? '.16' : '.08'}"/>`
      : `<circle cx="${CX}" cy="${CY}" r="${CORE + 6}" fill="${c.accent}" opacity=".08">` +
        `<animate attributeName="r" values="${CORE + 3};${CORE + 13};${CORE + 3}" ${breath}/>` +
        `<animate attributeName="opacity" values=".05;${anyRunning ? '.24' : '.12'};.05" ${breath}/></circle>`) +
    `<circle cx="${CX}" cy="${CY}" r="${CORE}" fill="${c.raised}" stroke="${anyRunning ? c.accent : c.line}" stroke-width="1.3"/>`

  if (board.context !== undefined) {
    const full = Math.max(0, Math.min(100, Math.round(board.context)))
    const ring = `cx="${CX}" cy="${CY}" r="${CORE + 5}" fill="none" stroke-width="2.2"`
    body +=
      `<circle ${ring} stroke="${c.line}" opacity=".7"/>` +
      `<circle ${ring} stroke="${full >= 90 ? c.red : full >= 70 ? c.accent : c.ash}" pathLength="100" stroke-dasharray="${full} 100" transform="rotate(-90 ${CX} ${CY})"/>` +
      `<text x="${CX}" y="${CY - 19}" text-anchor="middle" ${FONT} font-size="8" fill="${c.dim}">${full}%</text>`
  }

  const switchAge = board.switchedAt === undefined ? Infinity : now - board.switchedAt
  const isSwitching = switchAge >= 0 && switchAge < SWITCH_MS
  body += `<text x="${CX}" y="${CY + (board.model === undefined ? 6 : 1)}" text-anchor="middle" ${FONT} font-size="${n1(coreSize)}" letter-spacing="${n1(coreSize * 0.147)}" fill="${c.bone}">${escapeXml(setup.core)}</text>`
  if (board.model !== undefined) {
    body += `<text x="${CX}" y="${CY + 17}" text-anchor="middle" ${FONT} font-size="9" fill="${isSwitching ? c.hot : c.ash}">${escapeXml(helpers.shortModel(board.model))}</text>`
  }

  if (isSwitching && !isStill) {
    const model = place(indexOf('model'), shift)
    const laps = Math.ceil((SWITCH_MS - switchAge) / 1600)
    for (const [p, r] of [
      [core, CORE],
      [model, NODE],
    ] as const) {
      const ringing = `begin="${clock(-(switchAge % 1600))}" dur="1.6s" repeatCount="${laps}" fill="freeze"`
      body +=
        `<circle cx="${n1(p.x)}" cy="${n1(p.y)}" r="${r}" fill="none" stroke="${c.bone}" stroke-width="1.4" opacity="0">` +
        `<animate attributeName="r" values="${r};${r + 26}" ${ringing}/>` +
        `<animate attributeName="opacity" values=".7;0" ${ringing}/></circle>`
    }
  }

  const done = recent.filter(e => e.mark === 'done').pop()
  if (done !== undefined && now - done.startedAt < DONE_MS && !isStill) {
    const leaving = `begin="${clock(done.startedAt - now)}" dur="${clock(DONE_MS)}" fill="freeze"`
    body +=
      `<circle cx="${CX}" cy="${CY}" r="${CORE}" fill="none" stroke="${c.bone}" stroke-width="1.6" opacity="0">` +
      `<animate attributeName="r" values="${CORE};${CORE + 38}" ${leaving}/>` +
      `<animate attributeName="opacity" values=".6;0" ${leaving}/></circle>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${setup.theme === 'auto' ? lightRules(setup.colors) : ''}${body}</svg>`
}
