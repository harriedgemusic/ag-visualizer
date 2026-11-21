import type { Setup } from './setup'
import type { Strings } from './text'
import type { StationId } from './types'

export type Classified = { station: StationId; label: string }

const slashes = (path: string): string => path.replace(/\\/g, '/')

const lastTwo = (path: string): string =>
  slashes(path).split('/').filter(Boolean).slice(-2).join('/')

const HOST = /^(?:[\p{L}\p{N}.-]+|\[[0-9a-f:.]+\])(?::\d+)?$/iu

export function hostOf(url: string): string {
  const trimmed = url.trim()
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)
  if (!schemeMatch) return ''
  const scheme = schemeMatch[1]!.toLowerCase()
  try {
    const parsed = new URL(trimmed)
    // Reject ambiguous credential URLs where an unencoded `/` inside a password splits before another `@`.
    if ((parsed.username || parsed.password) && `${parsed.pathname}${parsed.search}${parsed.hash}`.includes('@')) {
      return scheme
    }
    if (parsed.host && HOST.test(parsed.host)) return parsed.host.slice(0, 40)
    return scheme
  } catch {
    return scheme
  }
}

export function cut(text: string, max: number): string {
  if (text.length <= max) return text
  const all = [...text]
  return all.length > max ? `${all.slice(0, max - 1).join('')}…` : text
}

export function clean(label: string, max = 120): string {
  const text = label
    .replace(/(?:(?![\u200c\u200d])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}])+/gu, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
  return cut(text, max)
}

export function unwrapValue(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const t = v.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return JSON.parse(t)
    } catch {
      if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
        return t.slice(1, -1)
      }
      return v
    }
  }
  return v
}

const str = (v: unknown): string => {
  const u = unwrapValue(v)
  return typeof u === 'string' ? u : ''
}

const isMemoryPath = (path: string, setup: Setup): boolean => {
  const p = slashes(path)
  if (/\/(?:GEMINI|AGENTS)\.md$/i.test(p)) return true
  if (/\/\.gemini\/antigravity\/(?:knowledge|memory)\//.test(p)) return true
  return setup.memoryPaths.some(part => p.includes(slashes(part)))
}

const skillNameFromPath = (path: string): string | undefined => {
  const p = slashes(path)
  const m = /\/skills\/([^/]+)\/SKILL\.md$/i.exec(p)
  if (m?.[1]) return m[1]
  if (/\/SKILL\.md$/i.test(p)) {
    const parts = p.split('/').filter(Boolean)
    return parts[parts.length - 2] || 'SKILL.md'
  }
  return undefined
}

const artifactNameFromPath = (path: string): string | undefined => {
  const p = slashes(path)
  const m = /\/\.gemini\/antigravity(?:-[^/]+)?\/brain\/[^/]+\/([^/]+)$/.exec(p)
  if (!m?.[1]) return undefined
  if (p.includes('/.system_generated/')) return undefined
  return m[1]
}

const FILE_WORDS = new Set([
  'cat', 'head', 'tail', 'sed', 'grep', 'rg', 'find', 'ls', 'wc', 'cp', 'mv',
  'mkdir', 'touch', 'diff', 'cmp', 'sort', 'uniq', 'cut', 'tr', 'awk', 'tee',
  'stat', 'file', 'du', 'tree', 'ln', 'basename', 'dirname', 'realpath', 'jq', 'rm', 'rmdir',
])

const NEUTRAL_WORDS = new Set([
  'echo', 'printf', 'cd', 'export', 'true', 'false', ':', 'set', 'pwd', 'sleep',
  'which', 'test', '[', '[[', 'read', 'local', 'declare', 'typeset', 'readonly',
  'unset', 'shopt', 'umask', 'pushd', 'popd', 'wait',
])

const NET_WORDS = new Set([
  'curl', 'wget', 'gh', 'ssh', 'scp', 'sftp', 'ftp', 'rsync', 'nc', 'ncat',
  'telnet', 'ping', 'dig', 'nslookup', 'nmap', 'http', 'https', 'kubectl', 'aws', 'gcloud', 'az',
])

const NET_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  git: new Set(['push', 'pull', 'fetch', 'clone', 'ls-remote', 'submodule update', 'remote update']),
  svn: new Set(['checkout', 'co', 'update', 'up', 'commit', 'ci', 'export']),
  hg: new Set(['clone', 'pull', 'push', 'incoming', 'outgoing']),
  npm: new Set(['install', 'i', 'ci', 'add', 'update', 'publish', 'view', 'audit']),
  pnpm: new Set(['install', 'i', 'add', 'update', 'publish', 'dlx']),
  yarn: new Set(['install', 'add', 'upgrade', 'publish', 'dlx']),
  bun: new Set(['install', 'i', 'add', 'update', 'publish']),
  pip: new Set(['install', 'download']),
  pipx: new Set(['install', 'upgrade', 'upgrade-all', 'run']),
  uv: new Set(['add', 'sync', 'lock', 'publish', 'tool install']),
  poetry: new Set(['install', 'add', 'update', 'lock', 'publish']),
  docker: new Set(['pull', 'push', 'login']),
  'docker compose': new Set(['pull', 'push']),
  brew: new Set(['install', 'update', 'upgrade', 'fetch']),
  cargo: new Set(['install', 'fetch', 'publish', 'update']),
  go: new Set(['get', 'install', 'mod download']),
  apt: new Set(['install', 'update', 'upgrade', 'full-upgrade', 'dist-upgrade']),
  'apt-get': new Set(['install', 'update', 'upgrade', 'dist-upgrade']),
  deno: new Set(['install', 'add', 'cache']),
  terraform: new Set(['init', 'plan', 'apply', 'destroy', 'import', 'refresh']),
  helm: new Set(['install', 'upgrade', 'pull', 'push', 'repo', 'search', 'dependency']),
  openssl: new Set(['s_client']),
}

const PY_MODULES = new Set(['pip', 'uv', 'pipx', 'poetry'])

const WRAPPERS: Record<string, { takes?: readonly string[]; skip?: number; asks?: readonly string[] }> = {
  sudo: { takes: ['-u', '-g', '-p', '-h', '-C', '-D', '-R', '-T', '-U', '-r', '-t'] },
  doas: { takes: ['-u', '-C'] },
  env: { takes: ['-u', '-C'] },
  time: {},
  timeout: { takes: ['-s', '-k'], skip: 1 },
  nohup: {},
  nice: { takes: ['-n'] },
  ionice: { takes: ['-c', '-n'] },
  stdbuf: { takes: ['-i', '-o', '-e'] },
  caffeinate: { takes: ['-t', '-w'] },
  command: { asks: ['-v', '-V'] },
  exec: { takes: ['-a'] },
  xargs: { takes: ['-n', '-I', '-P', '-L', '-d', '-E', '-s', '-a', '-J', '-R'] },
  watch: { takes: ['-n', '--interval'] },
}

const ASSIGNMENT = /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/
const REDIRECTION = /^(?:\d+|&)?(?:>>|>\||<<<|<<-|<<|<>|>&|<&|>|<)/

function start(words: string[]): number {
  let i = 0
  for (;;) {
    const word = words[i] ?? ''
    const sent = REDIRECTION.exec(word)
    if (ASSIGNMENT.test(word)) i++
    else if (sent !== null) i += word.length === sent[0].length ? 2 : 1
    else return Math.min(i, words.length)
  }
}

const GIT_TAKES = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])
const DOCKER_TAKES = new Set([
  '-c', '--context', '-H', '--host', '--config', '-l', '--log-level', '-f', '--file',
  '-p', '--project-name', '--profile', '--env-file', '--project-directory',
])

const pastFlags = (words: string[], takes: { has(flag: string): boolean }): string[] => {
  let i = 0
  while (i < words.length && (words[i] ?? '').startsWith('-')) i += takes.has(words[i] ?? '') ? 2 : 1
  return words.slice(i)
}

function unwrapped(words: string[], name: (word?: string) => string): string[] {
  let rest = words
  for (let depth = 0; depth < 6; depth++) {
    const wrapper = WRAPPERS[name(rest[0])]
    if (wrapper === undefined) break
    if (wrapper.asks?.some(flag => rest[1] === flag) === true) break
    rest = pastFlags(rest.slice(1), new Set(wrapper.takes ?? []))
    rest = rest.slice(start(rest) + (wrapper.skip ?? 0))
  }
  return rest
}

const DOCKER_ALONE = new Set([
  '-i', '-t', '-d', '-P', '-q', '-T', '--interactive', '--tty', '--detach', '--rm', '--init',
  '--privileged', '--publish-all', '--read-only', '--no-healthcheck', '--oom-kill-disable',
  '--quiet', '--no-deps', '--build', '--service-ports', '--use-aliases', '--no-TTY',
  '--remove-orphans', '--quiet-pull',
])

function insideContainer(words: string[]): string[] {
  let i = 0
  while (i < words.length && (words[i] ?? '').startsWith('-')) {
    const flag = words[i] ?? ''
    i += DOCKER_ALONE.has(flag) || flag.includes('=') || /^-[itdqPT]{2,}$/.test(flag) ? 1 : 2
  }
  return words.slice(i + 1)
}

const RUNNERS = new Set(['python', 'python3', 'bash', 'sh', 'zsh', 'node'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const BEFORE_A_COMMAND = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{'])
const NO_COMMAND = new Set(['for', 'select', 'case', 'function', 'done', 'fi', 'esac', '}'])
const READ = 8000
const FOLLOWED = 256

const unquoted = (word: string): string => {
  const q = word[0]
  if (q !== '"' && q !== "'") return word
  const inner = word.length > 1 && word.endsWith(q) ? word.slice(1, -1) : word.slice(1)
  return q === '"' ? inner.replace(/\\(["\\$`])/g, '$1') : inner
}

const HERE_MARK = /<<(-?)\s*\\?(["']?)([A-Za-z_][\w.]*)\2/y

function withoutHereDocuments(command: string): string {
  if (!command.includes('<<')) return command
  const kept: string[] = []
  const waiting: { word: string; tabs: boolean; isRun: boolean }[] = []
  let quote: '' | '"' | "'" | '$' = ''
  let size = 0
  for (const line of command.split('\n')) {
    const open = waiting[0]
    if (open !== undefined) {
      const text = (open.tabs ? line.replace(/^\t+/, '') : line).replace(/\r$/, '')
      if (text === open.word) waiting.shift()
      else if (open.isRun) {
        kept.push(line)
        size += line.length + 1
      }
      continue
    }
    if (size >= READ) break
    kept.push(line)
    let from = 0
    let isRun: boolean | undefined
    const room = Math.min(line.length, READ - size)
    for (let i = 0; i < room; i++) {
      const c = line[i]
      if (quote === "'") {
        if (c === "'") quote = ''
      } else if (c === '\\') i++
      else if (quote !== '') {
        if (c === (quote === '$' ? "'" : '"')) quote = ''
      } else if (c === '"' || c === "'") quote = c
      else if (c === '$' && line[i + 1] === "'") {
        quote = '$'
        i++
      } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1] ?? ''))) break
      else if (c === ';' || c === '|' || (c === '&' && line[i + 1] !== '>' && !/[<>]/.test(line[i - 1] ?? ''))) {
        from = i + 1
        isRun = undefined
      } else if (c === '<' && line[i + 1] === '<') {
        if (line[i + 2] === '<') {
          i += 2
          continue
        }
        HERE_MARK.lastIndex = i
        const m = HERE_MARK.exec(line)
        const before = line.slice(from, i)
        if (m === null || before.lastIndexOf('((') > before.lastIndexOf('))')) {
          i++
          continue
        }
        if (isRun === undefined) {
          const feeds = unwrapped(segments(before).pop() ?? [], base)
          const given = feeds.slice(1).filter((w, n, all) => {
            const sent = REDIRECTION.exec(w)
            const target = REDIRECTION.exec(all[n - 1] ?? '')
            return sent === null && !(target !== null && target[0].length === (all[n - 1] ?? '').length)
          })
          isRun = SHELLS.has(base(feeds[0])) && given.every(w => w.startsWith('-') && !/^-[a-z]*c$/.test(w))
        }
        waiting.push({ word: m[3] ?? '', tabs: m[1] === '-', isRun })
        i = HERE_MARK.lastIndex - 1
      }
    }
    size += line.length + 1
  }
  return kept.join('\n')
}

type Reading = { text: string; quote: '' | '"' | "'" | '$'; close: '' | ')' | '`'; array?: number }

const BEFORE_AN_ARRAY = /(?:^|[\s;&|({])[A-Za-z_]\w*\+?=$/
const ARRAY_NAME_ROOM = 120

function pieces(line: string, deep: boolean, ends?: string[]): string[] {
  const out: string[] = []
  const open: Reading[] = [{ text: '', quote: '', close: '' }]
  const cutHere = (reading: Reading, mark = ''): void => {
    out.push(reading.text)
    ends?.push(mark)
    reading.text = ''
  }
  for (let i = 0; i < line.length; i++) {
    const top = open[open.length - 1] as Reading
    const c = line[i] ?? ''
    const next = line[i + 1] ?? ''
    if (top.quote === "'") {
      top.text += c
      if (c === "'") top.quote = ''
      continue
    }
    if (c === '\\' && next === '\n') {
      top.text += ' '
      i++
      continue
    }
    if (c === '\\') {
      top.text += c + next
      i++
      continue
    }
    const inside = deep && c === '$' && next === '(' ? ')' : deep && c === '`' && top.close !== '`' ? '`' : ''
    if (top.quote !== '') {
      if ((top.quote === '$' && c === "'") || (top.quote === '"' && c === '"')) top.quote = ''
      if (top.quote === '"' && inside !== '') {
        open.push({ text: '', quote: '', close: inside })
        if (inside === ')') i++
        top.text += ' '
      } else top.text += c
      continue
    }
    if (c === '"' || c === "'") {
      top.quote = c
      top.text += c
    } else if (c === '$' && next === "'") {
      top.quote = '$'
      top.text += "$'"
      i++
    } else if (c === '#' && /^$|\s$/.test(top.text.slice(-1))) {
      while (i + 1 < line.length && line[i + 1] !== '\n') i++
    } else if (top.array !== undefined && c === '\n') top.text += ' '
    else if (top.array !== undefined && inside === '' && c === '(' && !deep) top.array++
    else if (top.array !== undefined && c === ')' && top.array > 0) top.array--
    else if (top.array !== undefined && c === ')') {
      if (deep) cutHere(top)
      open.pop()
      ;(open[open.length - 1] as Reading).text += ' '
    } else if (top.array !== undefined && (c === ';' || c === '|' || c === '&')) {
      open.pop()
      ;(open[open.length - 1] as Reading).text += `(${top.text}`
      i--
    } else if (c === '(' && inside === '' && top.text.endsWith('=') && BEFORE_AN_ARRAY.test(top.text.slice(-ARRAY_NAME_ROOM))) {
      open.push({ text: '', quote: '', close: ')', array: 0 })
    } else if (c === '\n' || c === ';' || c === '|') cutHere(top, c)
    else if (c === '&') {
      if (next !== '&' && (next === '>' || /[<>]/.test(line[i - 1] ?? ''))) top.text += c
      else cutHere(top, c)
    } else if (inside !== '' || (deep && c === '(')) {
      open.push({ text: '', quote: '', close: inside === '`' ? '`' : ')' })
      if (inside === ')') i++
      top.text += ' '
    } else if (deep && (c === ')' || c === '`')) {
      cutHere(top)
      if (top.close === c && open.length > 1) open.pop()
    } else top.text += c
  }
  for (let n = open.length - 1; n > 0; n--) {
    const reading = open[n] as Reading
    if (reading.array === undefined) continue
    ;(open[n - 1] as Reading).text += `(${reading.text}`
    open.splice(n, 1)
  }
  for (const reading of open) out.push(reading.text)
  return out
}

const WORDS = /(?:\\[\s\S]|[^\s"'\\]|"(?:[^"\\]|\\[\s\S])*"?|'[^']*'?)+/g

const closesMore = (word: string): boolean => {
  const bare = word.replace(/\\[\s\S]|"(?:[^"\\]|\\[\s\S])*"?|'[^']*'?/g, '_')
  return bare.endsWith(')') && bare.split(')').length > bare.split('(').length
}

function segments(command: string, deep = false, constructs = false): string[][] {
  let subshells = 0
  let cases = 0
  let pattern = false
  const ends: string[] = []
  const follow = constructs && !deep
  const parts = pieces(command, deep, follow ? ends : undefined)
  const commandOf = (words: string[], end: string): string[] => {
    let rest = words
    for (;;) {
      const head = rest[0] ?? ''
      if (BEFORE_A_COMMAND.has(head)) rest = rest.slice(1)
      else if (head.startsWith('(') && !head.startsWith('((')) {
        subshells++
        rest = head.length > 1 ? [head.slice(1), ...rest.slice(1)] : rest.slice(1)
      } else break
    }
    const head = rest[0] ?? ''
    if (follow && head === 'case') {
      cases++
      pattern = true
      const at = rest.indexOf('in')
      return at < 0 ? [] : patternThen(rest.slice(at + 1), end)
    }
    if (follow && cases > 0 && head === 'esac') cases--
    rest = rest.flatMap(word => {
      let w = word
      while (subshells > 0 && closesMore(w)) {
        w = w.slice(0, -1)
        subshells--
      }
      return w === '' ? [] : [w]
    })
    return NO_COMMAND.has(rest[0] ?? '') ? [] : rest
  }
  const patternThen = (words: string[], end: string): string[] => {
    const rest = words[0] === 'in' ? words.slice(1) : words
    if (rest.length === 0) return []
    if (rest[0] === 'esac') {
      pattern = false
      return commandOf(rest, end)
    }
    const first = rest[0] ?? ''
    const own = first.startsWith('(') ? [first.slice(1), ...rest.slice(1)] : rest
    const close = own.findIndex(closesMore)
    if (close < 0 && end === '|') return []
    pattern = false
    return commandOf(close < 0 ? rest : own.slice(close + 1), end)
  }
  return parts
    .map((part, n) => {
      const words = part.match(WORDS) ?? []
      const i = start(words)
      if (!constructs) return words.slice(i)
      if (follow && cases > 0) {
        if (words.length === 0 && n > 0 && ends[n - 1] === ';' && (ends[n] === ';' || ends[n] === '&')) pattern = true
        if (pattern) return patternThen(words.slice(i), ends[n] ?? '')
      }
      return commandOf(words.slice(i), ends[n] ?? '')
    })
    .filter(words => words.length > 0)
}

const base = (word = ''): string => {
  const name = slashes(word.replace(/["']/g, '')).split('/').pop() ?? word
  return /\.(?:exe|cmd|bat)$/i.test(name) ? name.replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase() : name
}

const stem = (name: string): string => name.replace(/\.[a-z0-9]+$/i, '')

const named = (name: string, command: string): boolean => {
  const s = stem(name)
  return s === command || (s.startsWith(command) && /^[-_.]/.test(s.slice(command.length)))
}

function memoryLabel(words: string[], setup: Setup): string {
  const head = base(words[0])
  if (!setup.memoryCommands.includes(head)) return clean(stem(base(RUNNERS.has(head) && words[1] ? words[1] : words[0])), 64)
  const sub = words[1] ?? ''
  return clean(setup.memorySubcommands.has(sub) ? sub : head, 64)
}

export function classifyShell(command: string, description: string, setup: Setup): Classified {
  const name = (word?: string): string => base(word)
  const nameOnly = (word: string | undefined): string => {
    const found = base(word ?? '')
    return /^[\p{L}\p{N}_][\p{L}\p{N}_.+-]*$/u.test(found) ? found : 'shell'
  }
  let followed = 0
  let spent = false
  const commands = (words: string[], deep = false, depth = 0): string[][] => {
    const outer = unwrapped(words, name)
    const head = name(outer[0])
    if (depth > 0 && ++followed > FOLLOWED) {
      spent = true
      return [outer]
    }
    if (depth < 3) {
      let line: string | undefined
      if (head === 'eval') line = outer.slice(1).map(unquoted).join(' ')
      else if (SHELLS.has(head)) {
        const at = outer.findIndex((w, i) => i > 0 && !w.startsWith('-'))
        const flag = outer.findIndex((w, i) => i > 0 && /^-[a-z]*c$/.test(w))
        if (flag > 0 && (at < 0 || at > flag) && outer[flag + 1] !== undefined) line = unquoted(outer[flag + 1] ?? '')
      }
      if (line !== undefined) {
        return segments(withoutHereDocuments(line).slice(0, READ), deep, true).flatMap(inner => commands(inner, deep, depth + 1))
      }
    }
    const all = [outer]
    if (head === 'find') {
      for (let i = 1; i < outer.length; i++) {
        if (!/^-(?:exec|execdir|ok|okdir)$/.test(outer[i] ?? '')) continue
        const tail = outer.slice(i + 1)
        const end = tail.findIndex(w => w === '\\;' || unquoted(w) === ';' || w === '+')
        all.push(...commands(end < 0 ? tail : tail.slice(0, end), deep, depth + 1))
        if (end < 0) break
        i += end + 1
      }
    }
    if (head === 'docker' && depth < 3) {
      let rest = pastFlags(outer.slice(1), DOCKER_TAKES)
      if (rest[0] === 'compose') rest = pastFlags(rest.slice(1), DOCKER_TAKES)
      if (rest[0] === 'container') rest = rest.slice(1)
      if (rest[0] === 'exec' || rest[0] === 'run') all.push(...commands(insideContainer(rest.slice(1)), deep, depth + 1))
    }
    return all.filter(c => c.length > 0)
  }

  const isNet = (words: string[]): boolean => {
    let head = name(words[0])
    let rest = words.slice(1)
    if (NET_WORDS.has(head)) return true
    if (/^(?:python[\d.]*|py)$/.test(head)) {
      let idx = 0
      while (idx < rest.length && /^-[A-Za-z]+$/.test(rest[idx] ?? '') && rest[idx] !== '-m' && rest[idx] !== '-c') {
        idx++
      }
      if (rest[idx] === '-m' && PY_MODULES.has(rest[idx + 1] ?? '')) {
        ;[head, rest] = [rest[idx + 1] ?? '', rest.slice(idx + 2)]
      }
    }
    if (head === 'uv' && rest[0] === 'pip') [head, rest] = ['pip', rest.slice(1)]
    if (/^pip[\d.]+$/.test(head)) head = 'pip'
    if (head === 'yarn' && rest.every(w => w.startsWith('-'))) return true
    if (head === 'git') rest = pastFlags(rest, GIT_TAKES)
    if (head === 'docker') {
      rest = pastFlags(rest, DOCKER_TAKES)
      if (rest[0] === 'compose') [head, rest] = ['docker compose', pastFlags(rest.slice(1), DOCKER_TAKES)]
    }
    if (head === 'npx') return rest.some(w => w === '-y' || w === '--yes')
    const subs = NET_SUBCOMMANDS[head]
    return subs !== undefined && (subs.has(rest[0] ?? '') || subs.has(`${rest[0] ?? ''} ${rest[1] ?? ''}`))
  }

  const read = withoutHereDocuments(command).slice(0, READ)
  const lines = segments(read, false, true).filter(words => words.length > 0)
  const label = clean(description) || nameOnly(unwrapped(lines[0] ?? [], name)[0] ?? lines[0]?.[0])
  const run = lines.flatMap(words => commands(words))

  for (const words of run) {
    const head = name(words[0])
    const script = RUNNERS.has(head) && words[1] ? base(words[1]) : ''
    if (setup.memoryCommands.some(c => named(head, c) || named(script, c))) {
      return { station: 'memory', label: memoryLabel(words, setup) }
    }
  }

  const reaches = (left: (words: string[]) => boolean = () => false): boolean => {
    followed = 0
    return segments(read, true, true)
      .flatMap(words => commands(words, true))
      .some(words => !left(words) && isNet(words))
  }

  const placed = (words: string[]): StationId | undefined => {
    const head = name(words[0])
    const script = RUNNERS.has(head) && words[1] ? base(words[1]) : ''
    for (const [cmd, station] of setup.commandStations) {
      if (named(head, cmd) || named(script, cmd)) return station
    }
    return undefined
  }

  const chosen = run.map(placed).find(station => station !== undefined)
  if (chosen !== undefined) {
    const isPlaced = (words: string[]): boolean => placed(words) !== undefined
    const elsewhere = run.some(words => !isPlaced(words) && isNet(words)) || reaches(isPlaced)
    return { station: elsewhere ? 'web' : chosen, label }
  }

  if (run.some(isNet) || reaches()) return { station: 'web', label }

  const real = run.filter(words => !NEUTRAL_WORDS.has(name(words[0])))
  if (!spent && real.length > 0 && real.every(words => FILE_WORDS.has(name(words[0])))) {
    return { station: isMemoryPath(read, setup) ? 'memory' : 'files', label }
  }
  return { station: 'shell', label }
}

function classifyPath(rawPath: string, fallbackTool: string, setup: Setup): Classified {
  const skill = skillNameFromPath(rawPath)
  if (skill) return { station: 'skills', label: clean(skill, 64) }
  const p = slashes(rawPath)
  if (/(?:^|\/)hooks\.json$/i.test(p)) {
    return { station: 'hooks', label: clean(lastTwo(p) || 'hooks.json') }
  }
  if (isMemoryPath(rawPath, setup)) {
    return { station: 'memory', label: clean(lastTwo(rawPath) || fallbackTool) }
  }
  const artifact = artifactNameFromPath(rawPath)
  if (artifact) {
    return { station: 'you', label: clean(`${setup.t.artifact}: ${artifact}`) }
  }
  return { station: 'files', label: clean(lastTwo(rawPath) || fallbackTool) }
}

export function classifyTool(tool: string, rawInput: Record<string, unknown>, setup: Setup): Classified {
  const { t } = setup
  const input = rawInput ?? {}

  if (tool.startsWith('browser_')) {
    const url = str(input.Url) || str(input.url)
    return { station: 'browser', label: clean(url ? hostOf(url) || tool : tool) }
  }

  switch (tool) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'multi_replace_file_content':
    case 'replace_file_content':
    case 'view_file':
    case 'view_file_outline':
    case 'view_code_item':
    case 'write_to_file':
    case 'list_dir': {
      const path =
        str(input.Path) ||
        str(input.TargetFile) ||
        str(input.AbsolutePath) ||
        str(input.DirectoryPath) ||
        str(input.File) ||
        str(input.file_path)
      return path ? classifyPath(path, tool, setup) : { station: 'files', label: clean(tool) }
    }

    case 'grep_search':
    case 'find_by_name':
      return { station: 'files', label: clean(tool) }

    case 'run_command':
      return classifyShell(
        str(input.CommandLine) || str(input.command),
        str(input.toolSummary) || str(input.Description) || str(input.description),
        setup,
      )

    case 'manage_task': {
      const rawAction = str(input.Action)
      const action = /^[\w-]{1,24}$/.test(rawAction) ? rawAction : ''
      return { station: 'shell', label: clean(action ? `manage_task: ${action}` : 'manage_task') }
    }

    case 'command_status':
    case 'send_command_input':
      return { station: 'shell', label: clean(tool) }

    case 'schedule':
      return { station: 'shell', label: 'schedule' }

    case 'search_web':
      return { station: 'web', label: clean(t.webSearch) }

    case 'read_url_content':
    case 'fetch_url': {
      const url = str(input.Url) || str(input.url)
      return { station: 'web', label: clean(url ? hostOf(url) || tool : tool) }
    }

    case 'invoke_subagent': {
      const typeName = str(input.TypeName)
      const role = str(input.Role)
      if (typeName === 'browser') {
        return { station: 'browser', label: clean(role || 'browser') }
      }
      return { station: 'agents', label: clean(role || typeName || t.subagent) }
    }

    case 'define_subagent': {
      const name = str(input.Name)
      return { station: 'agents', label: clean(name || 'define_subagent') }
    }

    case 'send_message':
    case 'manage_subagents': {
      const rawAction = str(input.Action)
      const action = /^[\w-]{1,24}$/.test(rawAction) ? rawAction : ''
      return { station: 'agents', label: clean(action ? `${tool}: ${action}` : tool) }
    }

    case 'swarm': {
      const rawAction = str(input.action)
      const action = /^[\w-]{1,24}$/.test(rawAction) ? rawAction : ''
      return { station: 'agents', label: clean(action ? `swarm: ${action}` : 'swarm') }
    }

    case 'swarm_wait':
    case 'post_message':
    case 'read_board':
      return { station: 'agents', label: clean(tool) }

    case 'run_workflow':
      return { station: 'agents', label: clean(str(input.Description) || t.workflow) }

    case 'search_marketplace':
    case 'list_plugin_accounts':
    case 'activate_skill':
    case 'load_skill': {
      const skill = str(input.name) || str(input.skill)
      return { station: 'skills', label: clean(skill || tool) }
    }

    case 'ask_question':
      return { station: 'you', label: clean(t.questionForYou) }

    case 'exit_plan_mode':
      return { station: 'you', label: clean(t.plan) }

    case 'enter_plan_mode':
      return { station: 'you', label: 'enter_plan_mode' }

    case 'notify_user':
      return { station: 'you', label: clean(t.fileForYou) }
  }

  const mcpDouble = /^mcp__([^_].*?)__(.+)$/.exec(tool)
  const mcpSingle = mcpDouble ?? /^mcp_([^_]+)_(.+)$/.exec(tool)
  if (mcpSingle !== null) {
    const [, server = '', name = ''] = mcpSingle
    if (setup.memoryServers.has(server)) {
      const rawId = unwrapValue(input.id)
      const id =
        typeof rawId === 'number' || (typeof rawId === 'string' && /^[\w-]{1,24}$/.test(rawId))
          ? ` #${rawId}`
          : ''
      return { station: 'memory', label: clean((setup.memoryLabels.get(name) ?? name.replace(/_+/g, ' ')) + id) }
    }
    const chosen = setup.serverStations.get(server)
    if (chosen !== undefined) return { station: chosen, label: clean(`${server}/${name.replace(/_+/g, ' ')}`) }
    if (/browser|playwright|puppeteer|chrome/i.test(server)) {
      return { station: 'browser', label: clean(`${server}/${name.replace(/_+/g, ' ')}`) }
    }
    return { station: 'skills', label: clean(`${server}/${name.replace(/_+/g, ' ')}`) }
  }

  return { station: 'skills', label: clean(tool, 64) || 'tool' }
}

export function shortModel(model: string): string {
  const claude = /claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(model)
  if (claude) {
    return clean(`${claude[1]} ${claude[2]}${claude[3] !== undefined ? `.${claude[3]}` : ''}`, 24)
  }
  const cleaned = model
    .replace(/^models\//i, '')
    .replace(/^gemini-\d+-/i, '')
    .replace(/^gemini-/i, '')
    .replace(/-medium$/i, '-med')
  return clean(cleaned, 24)
}

export function formatMs(ms: number, t: Strings): string {
  if (!Number.isFinite(ms)) return t.ms(0)
  const tenths = Math.round(ms / 100)
  const seconds = Math.round(ms / 1000)
  if (Math.round(ms) < 1000) return t.ms(Math.max(1, Math.round(ms)))
  if (tenths < 600) return t.seconds((tenths / 10).toFixed(1))
  if (seconds < 3600) return t.minutes(Math.floor(seconds / 60), seconds % 60)
  const minutes = Math.round(seconds / 60)
  return t.hours(Math.floor(minutes / 60), minutes % 60)
}

export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return '0'
  const n = Math.max(0, Math.round(tokens))
  if (n < 1000) return String(n)
  const k = Math.round(n / 1000)
  return k < 1000 ? `${k}k` : `${Math.round(n / 1_000_000)}M`
}
