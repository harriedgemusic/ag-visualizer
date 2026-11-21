import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseQuotaFromStateSync } from '../core/quota'
import type { QuotaSnapshot } from '../core/types'

const quotaCache = new Map<string, { mtimeMs: number; sizeKey: string; snapshot: QuotaSnapshot | undefined }>()

/**
 * Returns candidate paths to Antigravity IDE's read-only `state.vscdb`,
 * prioritizing `globalStorageParentDir` (from `vscode.ExtensionContext.globalStorageUri`).
 */
export function resolveStateDbCandidates(globalStorageParentDir?: string): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()
  const push = (p: string): void => {
    if (/^[\\/]{2}/.test(p)) return
    const norm = path.normalize(p)
    if (/^[\\/]{2}/.test(norm)) return
    if (!seen.has(norm)) {
      seen.add(norm)
      candidates.push(norm)
    }
  }

  if (globalStorageParentDir && path.isAbsolute(globalStorageParentDir) && !/^[\\/]{2}/.test(globalStorageParentDir)) {
    push(path.join(globalStorageParentDir, 'state.vscdb'))
  }

  const home = os.homedir()
  if (process.platform === 'darwin') {
    push(path.join(home, 'Library', 'Application Support', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'))
    push(path.join(home, 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb'))
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    push(path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'))
    push(path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'))
  } else {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
    push(path.join(configHome, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'))
    push(path.join(configHome, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'))
  }

  return candidates
}

/**
 * Passively reads Antigravity IDE's local quota snapshot from `state.vscdb`
 * using `node:sqlite` in strictly read-only mode with mtime+WAL caching.
 */
export async function readAntigravityQuota(globalStorageParentDir?: string): Promise<QuotaSnapshot | undefined> {
  const candidates = resolveStateDbCandidates(globalStorageParentDir)
  for (const dbPath of candidates) {
    let st: fs.Stats
    try {
      st = await fs.promises.lstat(dbPath)
      if (!st.isFile()) continue
    } catch {
      continue
    }

    let effectiveMtime = st.mtimeMs
    let walSize = 0
    try {
      const walSt = await fs.promises.lstat(`${dbPath}-wal`)
      if (walSt.isFile()) {
        effectiveMtime = Math.max(effectiveMtime, walSt.mtimeMs)
        walSize = walSt.size
      }
    } catch {
      // No WAL file
    }

    const sizeKey = `${st.size}:${walSize}`
    const cached = quotaCache.get(dbPath)
    if (cached && cached.mtimeMs === effectiveMtime && cached.sizeKey === sizeKey) {
      if (cached.snapshot !== undefined) return cached.snapshot
      continue
    }

    try {
      const sqlite = await import('node:sqlite')
      const db = new sqlite.DatabaseSync(dbPath, { readOnly: true, timeout: 250 })
      try {
        db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 250;')
        const rows = db
          .prepare(
            "SELECT key, value FROM ItemTable WHERE key IN ('antigravityUnifiedStateSync.userStatus', 'antigravityUnifiedStateSync.modelCredits')",
          )
          .all() as { key: string; value: unknown }[]

        let userStatusRaw: string | undefined
        let modelCreditsRaw: string | undefined
        for (const r of rows) {
          if (r.key === 'antigravityUnifiedStateSync.userStatus' && typeof r.value === 'string') {
            userStatusRaw = r.value
          } else if (r.key === 'antigravityUnifiedStateSync.modelCredits' && typeof r.value === 'string') {
            modelCreditsRaw = r.value
          }
        }
        const snapshot = parseQuotaFromStateSync(userStatusRaw, modelCreditsRaw, effectiveMtime)
        quotaCache.set(dbPath, { mtimeMs: effectiveMtime, sizeKey, snapshot })
        if (snapshot) return snapshot
      } finally {
        db.close()
      }
    } catch {
      if (cached?.snapshot) return cached.snapshot
    }
  }

  return undefined
}
