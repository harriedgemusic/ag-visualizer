import { clean } from './classify'
import { contextWindowFor } from './reducer'
import type { Board, ContextBudget, QuotaModelPool, QuotaSnapshot } from './types'

const MAX_BASE64_CHARS = 350_000
const MAX_PROTO_BYTES = 262_144
const MAX_FIELDS = 2000

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64_ALPHABET.length; i++) {
    table[B64_ALPHABET.charCodeAt(i)] = i
  }
  table['-'.charCodeAt(0)] = 62
  table['_'.charCodeAt(0)] = 63
  return table
})()

const utf8Fatal = new TextDecoder('utf-8', { fatal: true })

function decodeUtf8Strict(bytes: Uint8Array, maxRawBytes = MAX_PROTO_BYTES): string | undefined {
  if (bytes.length > maxRawBytes) return undefined
  try {
    return utf8Fatal.decode(bytes)
  } catch {
    return undefined
  }
}

function decodeBase64(raw: string): Uint8Array | undefined {
  if (raw.length === 0 || raw.length > MAX_BASE64_CHARS) return undefined
  const cleanChars: number[] = []
  let seenPad = false
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    if (code <= 32) continue
    if (code === 61 /* '=' */) {
      seenPad = true
      continue
    }
    if (seenPad || code >= 128) return undefined
    const v = B64_LOOKUP[code]!
    if (v < 0) return undefined
    cleanChars.push(v)
    if (cleanChars.length * 3 > MAX_PROTO_BYTES * 4 + 4) return undefined
  }
  const outLen = Math.floor((cleanChars.length * 3) / 4)
  if (outLen === 0 || outLen > MAX_PROTO_BYTES) return undefined
  const out = new Uint8Array(outLen)
  let o = 0
  for (let i = 0; i < cleanChars.length; i += 4) {
    const c0 = cleanChars[i]!
    const c1 = cleanChars[i + 1]
    if (c1 === undefined) return undefined
    const c2 = cleanChars[i + 2]
    const c3 = cleanChars[i + 3]
    out[o++] = (c0 << 2) | (c1 >> 4)
    if (c2 !== undefined && o < outLen) out[o++] = ((c1 & 15) << 4) | (c2 >> 2)
    if (c2 !== undefined && c3 !== undefined && o < outLen) out[o++] = ((c2 & 3) << 6) | c3
  }
  return out
}

type WireField = {
  f: number
  w: number
  n?: number
  f32?: number
  f64?: number
  b?: Uint8Array
}

function readVarint(buf: Uint8Array, pos: number): { val: number; next: number } | undefined {
  let val = 0
  let factor = 1
  let i = pos
  for (let count = 0; count < 10; count++) {
    if (i >= buf.length) return undefined
    const b = buf[i++]!
    val += (b & 0x7f) * factor
    if ((b & 0x80) === 0) {
      return Number.isFinite(val) ? { val, next: i } : undefined
    }
    factor *= 128
  }
  return undefined
}

function decodeProtoFields(buf: Uint8Array): WireField[] | undefined {
  const fields: WireField[] = []
  let i = 0
  while (i < buf.length) {
    if (fields.length >= MAX_FIELDS) return undefined
    const tagRes = readVarint(buf, i)
    if (!tagRes) return undefined
    const tag = tagRes.val
    i = tagRes.next
    const f = Math.floor(tag / 8)
    const w = tag & 7
    if (f <= 0 || tag > 0xffffffff) return undefined

    if (w === 0) {
      const vRes = readVarint(buf, i)
      if (!vRes) return undefined
      i = vRes.next
      fields.push({ f, w, n: vRes.val })
    } else if (w === 1) {
      if (i + 8 > buf.length) return undefined
      const f64 = new DataView(buf.buffer, buf.byteOffset + i, 8).getFloat64(0, true)
      i += 8
      fields.push({ f, w, f64 })
    } else if (w === 2) {
      const lRes = readVarint(buf, i)
      if (!lRes) return undefined
      i = lRes.next
      const len = lRes.val
      if (len < 0 || !Number.isSafeInteger(len) || i + len > buf.length) return undefined
      fields.push({ f, w, b: buf.subarray(i, i + len) })
      i += len
    } else if (w === 5) {
      if (i + 4 > buf.length) return undefined
      const f32 = new DataView(buf.buffer, buf.byteOffset + i, 4).getFloat32(0, true)
      i += 4
      fields.push({ f, w, f32 })
    } else {
      return undefined
    }
  }
  return fields
}

function findStateSyncValues(raw: string | undefined, targetKeys: readonly string[]): Map<string, Uint8Array> {
  const result = new Map<string, Uint8Array>()
  if (typeof raw !== 'string' || !raw || targetKeys.length === 0) return result
  const outerBuf = decodeBase64(raw)
  if (!outerBuf) return result
  const entries = decodeProtoFields(outerBuf)
  if (!entries) return result

  const wanted = new Set(targetKeys)
  for (const entry of entries) {
    if (entry.f !== 1 || entry.w !== 2 || !entry.b) continue
    const kv = decodeProtoFields(entry.b)
    if (!kv) continue
    const keyBytes = kv.find(x => x.f === 1 && x.w === 2)?.b
    const key = keyBytes ? decodeUtf8Strict(keyBytes, 128) : undefined
    if (!key || !wanted.has(key)) continue
    const valWrapBytes = kv.find(x => x.f === 2 && x.w === 2)?.b
    if (!valWrapBytes) continue
    const valWrap = decodeProtoFields(valWrapBytes)
    const innerB64Bytes = valWrap?.find(x => x.f === 1 && x.w === 2)?.b
    const innerB64 = innerB64Bytes ? decodeUtf8Strict(innerB64Bytes, MAX_BASE64_CHARS) : undefined
    if (!innerB64) continue
    const decoded = decodeBase64(innerB64)
    if (decoded) result.set(key, decoded)
  }
  return result
}

function basePoolLabel(rawLabel: string): string {
  const stripped = rawLabel.replace(/\s*\((?:High|Medium|Low|Minimal|Thinking)\)\s*$/i, '')
  return clean(stripped || rawLabel, 48)
}

function slugId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'model'
}

/**
 * Decodes Antigravity IDE local quota and plan tier metadata from `antigravityUnifiedStateSync`
 * protobuf blobs (`userStatus` and `modelCredits`). Strictly extracts only model quota pools,
 * reset timestamps, plan name, and AI credit counters — never reads user PII or OAuth fields.
 */
export function parseQuotaFromStateSync(
  userStatusRaw: string | undefined,
  modelCreditsRaw: string | undefined,
  syncedAtMs: number,
): QuotaSnapshot | undefined {
  const statusBuf = findStateSyncValues(userStatusRaw, ['userStatusSentinelKey']).get('userStatusSentinelKey')
  const statusFields = statusBuf ? decodeProtoFields(statusBuf) : undefined

  const poolMap = new Map<string, QuotaModelPool>()
  let planName: string | undefined

  if (statusFields) {
    // Field 36 holds plan metadata; field 2 holds plan display name (e.g., "Google AI Pro")
    const planBytes = statusFields.find(x => x.f === 36 && x.w === 2)?.b
    if (planBytes) {
      const planFields = decodeProtoFields(planBytes)
      const nameBytes = planFields?.find(x => x.f === 2 && x.w === 2)?.b ?? planFields?.find(x => x.f === 3 && x.w === 2)?.b
      const nameStr = nameBytes ? decodeUtf8Strict(nameBytes, 128) : undefined
      if (nameStr) {
        const cleaned = clean(nameStr, 32)
        if (cleaned) planName = cleaned
      }
    }

    // Field 33 holds cascadeModelConfigData; repeated field 1 contains per-model configs
    const modelContainerBytes = statusFields.find(x => x.f === 33 && x.w === 2)?.b
    const modelContainer = modelContainerBytes ? decodeProtoFields(modelContainerBytes) : undefined
    if (modelContainer) {
      for (const item of modelContainer) {
        if (item.f !== 1 || item.w !== 2 || !item.b) continue
        const mf = decodeProtoFields(item.b)
        if (!mf) continue

        const labelBytes = mf.find(x => x.f === 1 && x.w === 2)?.b
        const labelStr = labelBytes ? decodeUtf8Strict(labelBytes, 256) : undefined
        if (!labelStr) continue
        const rawLabel = clean(labelStr, 64)
        if (!rawLabel) continue

        const quotaEntry = mf.find(x => x.f === 15 && x.w === 2)
        if (!quotaEntry?.b) continue
        const qf = decodeProtoFields(quotaEntry.b)
        if (!qf) continue

        const remField = qf.find(x => x.f === 1 && (x.w === 5 || x.w === 1))
        const rawFrac = remField ? (remField.w === 5 ? remField.f32 : remField.f64) : 0
        const frac = typeof rawFrac === 'number' && Number.isFinite(rawFrac) ? Math.max(0, Math.min(1, rawFrac)) : 0
        const remainingPct = Math.round(frac * 1000) / 10
        const usedPct = Math.max(0, Math.min(100, Math.round((100 - remainingPct) * 10) / 10))

        let resetAtMs: number | undefined
        const resetWrapBytes = qf.find(x => x.f === 2 && x.w === 2)?.b
        if (resetWrapBytes) {
          const resetFields = decodeProtoFields(resetWrapBytes)
          const sec = resetFields?.find(x => x.f === 1 && x.w === 0)?.n
          if (typeof sec === 'number' && Number.isSafeInteger(sec) && sec > 0 && sec <= 10_000_000_000) {
            resetAtMs = sec * 1000
          }
        }

        const badgeBytes = mf.find(x => x.f === 16 && x.w === 2)?.b
        const badgeStr = badgeBytes ? decodeUtf8Strict(badgeBytes, 64) : undefined
        const badge = badgeStr ? clean(badgeStr, 16) || undefined : undefined

        const label = basePoolLabel(rawLabel)
        const existing = poolMap.get(label)
        if (existing) {
          if (remainingPct < existing.remainingPct) {
            existing.remainingPct = remainingPct
            existing.usedPct = usedPct
          }
          if (resetAtMs !== undefined && (existing.resetAtMs === undefined || resetAtMs < existing.resetAtMs)) {
            existing.resetAtMs = resetAtMs
          }
          if (!existing.badge && badge) existing.badge = badge
        } else {
          poolMap.set(label, {
            id: slugId(label),
            label,
            remainingPct,
            usedPct,
            ...(resetAtMs !== undefined ? { resetAtMs } : {}),
            ...(badge ? { badge } : {}),
          })
        }
      }
    }
  }

  const creditValues = findStateSyncValues(modelCreditsRaw, [
    'availableCreditsSentinelKey',
    'minimumCreditAmountForUsageKey',
  ])

  let availableCredits: number | undefined
  const availBytes = creditValues.get('availableCreditsSentinelKey')
  if (availBytes) {
    const af = decodeProtoFields(availBytes)
    const v = af?.find(x => x.f === 2 && x.w === 0)?.n
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) availableCredits = v
  }

  let minCredits: number | undefined
  const minBytes = creditValues.get('minimumCreditAmountForUsageKey')
  if (minBytes) {
    const mf = decodeProtoFields(minBytes)
    const v = mf?.find(x => x.f === 2 && x.w === 0)?.n
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) minCredits = v
  }

  const pools = [...poolMap.values()]
  if (pools.length === 0 && !planName && availableCredits === undefined) return undefined

  return {
    ...(planName ? { planName } : {}),
    ...(availableCredits !== undefined ? { availableCredits } : {}),
    ...(minCredits !== undefined ? { minCredits } : {}),
    pools,
    syncedAtMs: Number.isFinite(syncedAtMs) ? syncedAtMs : 0,
  }
}

/**
 * Computes active session context window used vs remaining tokens and percentages.
 */
export function computeContextBudget(board: Board, contextWindowTokensOverride = 0): ContextBudget | undefined {
  const limitTokens = contextWindowFor(board.model, contextWindowTokensOverride)
  if (!Number.isFinite(limitTokens) || limitTokens <= 0) return undefined

  const latestStep = board.modelSteps?.[board.modelSteps.length - 1]
  if (latestStep && Number.isFinite(latestStep.totalContextTokens) && latestStep.totalContextTokens > 0) {
    const usedTokens = Math.max(0, Math.round(latestStep.totalContextTokens))
    const remainingTokens = Math.max(0, limitTokens - usedTokens)
    const usedPct = Math.min(100, Math.max(0, Math.round((usedTokens / limitTokens) * 1000) / 10))
    const remainingPct = Math.max(0, Math.round((100 - usedPct) * 10) / 10)
    return {
      usedTokens,
      limitTokens,
      remainingTokens,
      usedPct,
      remainingPct,
      isEstimated: false,
    }
  }

  if (board.context !== undefined && Number.isFinite(board.context)) {
    const usedPct = Math.min(100, Math.max(0, Math.round(board.context * 10) / 10))
    const remainingPct = Math.max(0, Math.round((100 - usedPct) * 10) / 10)
    const usedTokens = Math.round((usedPct / 100) * limitTokens)
    const remainingTokens = Math.max(0, limitTokens - usedTokens)
    return {
      usedTokens,
      limitTokens,
      remainingTokens,
      usedPct,
      remainingPct,
      isEstimated: true,
    }
  }

  return undefined
}

/**
 * Formats remaining time until `resetAtMs` (returns empty string if unset or already in the past).
 */
export function formatResetCountdown(resetAtMs: number | undefined, nowMs: number): string {
  if (resetAtMs === undefined || !Number.isFinite(resetAtMs) || !Number.isFinite(nowMs)) return ''
  const diffMs = resetAtMs - nowMs
  if (diffMs <= 0) return ''
  const totalMin = Math.floor(diffMs / 60_000)
  if (totalMin < 1) return '<1m'
  const hours = Math.floor(totalMin / 60)
  const mins = totalMin % 60
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const remH = hours % 24
    return remH > 0 ? `${days}d ${remH}h` : `${days}d`
  }
  return hours > 0 ? (mins > 0 ? `${hours}h ${mins}m` : `${hours}h`) : `${mins}m`
}
