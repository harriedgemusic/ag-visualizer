import type { Setup } from './setup'

export type Palette = {
  ground: string
  raised: string
  line: string
  spoke: string
  bone: string
  ash: string
  dim: string
  accent: string
  hot: string
  red: string
  mem: string
  memHot: string
  /** The route between stations: soft warm grey on light, bright bone-tint on dark. */
  trail: string
}

export const DARK: Palette = {
  ground: '#0a0c11',
  raised: '#12151c',
  line: '#272c36',
  spoke: '#1a1e27',
  bone: '#ebe6dc',
  ash: '#9ba1ab',
  dim: '#6b7280',
  accent: '#e1ac6e',
  hot: '#f0c595',
  red: '#e8654f',
  mem: '#62c7ba',
  memHot: '#a5e6dc',
  // One step away from `bone`, so that light rules can style the route independently.
  trail: '#ebe6dd',
}

export const LIGHT: Palette = {
  ground: '#f5f2ea',
  raised: '#ffffff',
  line: '#cfc9bc',
  spoke: '#e3ded2',
  bone: '#1f2228',
  ash: '#5f6570',
  dim: '#8b909a',
  accent: '#b8762a',
  hot: '#8f560f',
  red: '#c5402b',
  mem: '#1c8c81',
  memHot: '#136a62',
  trail: '#9c978b',
}

const escCss = (text: string): string => text.replace(/[<>&"';{}()\\]/g, '')

export const lightRules = (own: Partial<Palette> = {}): string =>
  `<style>@media (prefers-color-scheme: light){${(Object.keys(DARK) as (keyof Palette)[])
    .filter(k => own[k] === undefined && !Object.values(own).includes(DARK[k]))
    .map(k => `[fill="${escCss(DARK[k])}"]{fill:${escCss(LIGHT[k])}}[stroke="${escCss(DARK[k])}"]{stroke:${escCss(LIGHT[k])}}`)
    .join('')}}</style>`

export const COLOR_NAMES: Record<string, keyof Palette> = {
  background: 'ground',
  node: 'raised',
  line: 'line',
  spoke: 'spoke',
  text: 'bone',
  label: 'ash',
  faint: 'dim',
  accent: 'accent',
  active: 'hot',
  error: 'red',
  memory: 'mem',
  memoryActive: 'memHot',
  route: 'trail',
}

export function resolvePalette(setup: Pick<Setup, 'theme' | 'colors'>, isLightSurface = false): Palette {
  const useLight = setup.theme === 'light' || (setup.theme === 'auto' && isLightSurface)
  return { ...(useLight ? LIGHT : DARK), ...setup.colors }
}
