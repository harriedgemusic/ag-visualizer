import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clean } from '../core/classify'
import type { SessionSummary } from '../core/types'

function sanitizeOverrideDir(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  // Reject Windows UNC / network share paths (including mixed-slash forms) to prevent outbound SMB/NTLM requests.
  if (/^[\\/]{2}/.test(trimmed)) return undefined
  let expanded = trimmed
  if (/^~(?:[/\\]|$)/.test(trimmed)) {
    expanded = path.join(os.homedir(), trimmed.slice(1))
  }
  if (!path.isAbsolute(expanded)) return undefined
  const norm = path.normalize(expanded)
  if (/^[\\/]{2}/.test(norm)) return undefined
  return norm
}

export function resolveAntigravityDirs(overrideDir?: string): string[] {
  const safe = overrideDir ? sanitizeOverrideDir(overrideDir) : undefined
  if (safe) return [safe]
  return [
    path.join(os.homedir(), '.gemini', 'antigravity'),
    path.join(os.homedir(), '.gemini', 'antigravity-ide'),
  ]
}

export function resolveAntigravityDir(overrideDir?: string): string {
  return resolveAntigravityDirs(overrideDir)[0] ?? path.join(os.homedir(), '.gemini', 'antigravity')
}

type DbRow = {
  conversation_id: string
  title: string
  workspace_uris: string
  status: string
  parent_conversation_id: string
  not_fully_idle: number
  last_modified_time: string
}

const dbMetaCache = new Map<string, { mtimeMs: number; map: Map<string, DbRow> }>()

async function readDbMetadata(dataDir: string): Promise<Map<string, DbRow> | null> {
  const dbPath = path.join(dataDir, 'conversation_summaries.db')
  let st: fs.Stats
  try {
    st = await fs.promises.stat(dbPath)
    if (!st.isFile()) return null
  } catch {
    return null
  }

  const walPath = `${dbPath}-wal`
  let effectiveMtime = st.mtimeMs
  try {
    const walSt = await fs.promises.stat(walPath)
    if (walSt.isFile()) effectiveMtime = Math.max(effectiveMtime, walSt.mtimeMs)
  } catch {
    // No WAL file
  }

  const cached = dbMetaCache.get(dbPath)
  if (cached && cached.mtimeMs === effectiveMtime) {
    return cached.map
  }

  try {
    const sqlite = await import('node:sqlite')
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true, timeout: 250 })
    try {
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 250;')
      const rows = db
        .prepare(
          `SELECT conversation_id, title, workspace_uris, status, parent_conversation_id, not_fully_idle, last_modified_time
           FROM conversation_summaries
           ORDER BY last_modified_time DESC
           LIMIT 200`,
        )
        .all() as DbRow[]
      const map = new Map<string, DbRow>()
      for (const r of rows) {
        if (r.conversation_id) map.set(r.conversation_id, r)
      }
      dbMetaCache.set(dbPath, { mtimeMs: effectiveMtime, map })
      return map
    } finally {
      db.close()
    }
  } catch {
    return cached?.map ?? null
  }
}

function parseWorkspaceUris(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    // ignore malformed JSON
  }
  return []
}

function normalizeUriPath(uriOrPath: string): string {
  let s = uriOrPath.trim()
  if (s.startsWith('file://')) {
    try {
      s = decodeURIComponent(s.slice('file://'.length))
    } catch {
      s = s.slice('file://'.length)
    }
  }
  return s
    .replace(/\\/g, '/')
    .replace(/^\/([a-zA-Z]:\/)/, '$1')
    .replace(/\/+$/, '')
    .toLowerCase()
}

export async function listSessions(dataDirOrDirs: string | readonly string[]): Promise<SessionSummary[]> {
  const dirs = Array.isArray(dataDirOrDirs) ? dataDirOrDirs : [dataDirOrDirs]
  const byId = new Map<string, SessionSummary>()

  for (const dataDir of dirs) {
    const brainDir = path.join(dataDir, 'brain')
    if (!fs.existsSync(brainDir)) continue

    const dbMeta = await readDbMetadata(dataDir)
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(brainDir, { withFileTypes: true })
    } catch {
      continue
    }

    await Promise.all(
      entries.map(async entry => {
        if (!entry.isDirectory()) return
        const id = entry.name
        const transcriptPath = path.join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl')
        try {
          const st = await fs.promises.stat(transcriptPath)
          if (!st.isFile() || st.size === 0) return
          const row = dbMeta?.get(id)
          const existing = byId.get(id)
          if (existing && existing.mtimeMs >= st.mtimeMs) return
          const rawTitle = row?.title?.trim() ?? ''
          byId.set(id, {
            id,
            title: clean(rawTitle, 80) || id.slice(0, 8),
            transcriptPath,
            mtimeMs: st.mtimeMs,
            sizeBytes: st.size,
            workspaceUris: parseWorkspaceUris(row?.workspace_uris),
            status: row?.status || '',
            parentConversationId: row?.parent_conversation_id?.trim() || undefined,
            notFullyIdle: Boolean(row?.not_fully_idle),
          })
        } catch {
          // transcript does not exist yet
        }
      }),
    )
  }

  const sessions = [...byId.values()]
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return sessions
}

export function pickAutoSession(
  sessions: readonly SessionSummary[],
  workspaceFolderPaths: readonly string[],
): SessionSummary | undefined {
  const topLevel = sessions.filter(s => !s.parentConversationId)
  const pool = topLevel.length > 0 ? topLevel : sessions
  if (pool.length === 0) return undefined

  const normalizedFolders = workspaceFolderPaths.map(normalizeUriPath).filter(Boolean)
  if (normalizedFolders.length > 0) {
    const matched = pool.filter(s =>
      s.workspaceUris.some(uri => {
        const p = normalizeUriPath(uri)
        return normalizedFolders.some(f => p === f || p.startsWith(`${f}/`) || f.startsWith(`${p}/`))
      }),
    )
    if (matched.length > 0) {
      const running = matched.find(s => s.status === 'CASCADE_RUN_STATUS_RUNNING' || s.notFullyIdle)
      return running ?? matched[0]
    }
  }

  const running = pool.find(s => s.status === 'CASCADE_RUN_STATUS_RUNNING' || s.notFullyIdle)
  return running ?? pool[0]
}

export function childSessionsOf(
  sessions: readonly SessionSummary[],
  parentId: string,
): SessionSummary[] {
  return sessions.filter(s => s.parentConversationId === parentId)
}
