import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { computeContextBudget, formatResetCountdown, parseQuotaFromStateSync } from '../src/core/quota'
import { contextWindowFor } from '../src/core/reducer'
import type { Board } from '../src/core/types'
import { resolveStateDbCandidates } from '../src/watcher/quota'
import { readIdeTokenUsage } from '../src/watcher/usage'

function varint(n: number): Uint8Array {
  const bytes: number[] = []
  let v = n
  while (v >= 0x80) {
    bytes.push((v % 128) | 0x80)
    v = Math.floor(v / 128)
  }
  bytes.push(v)
  return Uint8Array.from(bytes)
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, p) => acc + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

function fieldBytes(fieldNum: number, payload: Uint8Array): Uint8Array {
  return concatBytes([varint((fieldNum << 3) | 2), varint(payload.length), payload])
}

function fieldStr(fieldNum: number, value: string): Uint8Array {
  return fieldBytes(fieldNum, Buffer.from(value, 'utf8'))
}

function fieldVarint(fieldNum: number, value: number): Uint8Array {
  return concatBytes([varint((fieldNum << 3) | 0), varint(value)])
}

function fieldFloat32(fieldNum: number, value: number): Uint8Array {
  const buf = new Uint8Array(4)
  new DataView(buf.buffer).setFloat32(0, value, true)
  return concatBytes([varint((fieldNum << 3) | 5), buf])
}

function encodeStateSyncMap(entries: ReadonlyArray<[string, Uint8Array]>): string {
  const outer = concatBytes(
    entries.map(([key, innerProto]) => {
      const innerB64 = Buffer.from(innerProto).toString('base64')
      const valWrap = fieldStr(1, innerB64)
      const kv = concatBytes([fieldStr(1, key), fieldBytes(2, valWrap)])
      return fieldBytes(1, kv)
    }),
  )
  return Buffer.from(outer).toString('base64')
}

function modelConfigProto(
  label: string,
  remainingFrac?: number,
  resetEpochSec?: number,
  badge?: string,
): Uint8Array {
  const quotaParts: Uint8Array[] = []
  if (remainingFrac !== undefined) {
    quotaParts.push(fieldFloat32(1, remainingFrac))
  }
  if (resetEpochSec !== undefined) {
    quotaParts.push(fieldBytes(2, fieldVarint(1, resetEpochSec)))
  }
  const parts: Uint8Array[] = [fieldStr(1, label), fieldBytes(15, concatBytes(quotaParts))]
  if (badge) parts.push(fieldStr(16, badge))
  return concatBytes(parts)
}

describe('Quota & Context Budget Core Module', () => {
  it('parses model pools, collapses effort variants, handles 0% proto3 default and 100%, extracts plan & credits, and ignores PII fields', () => {
    const innerStatus = concatBytes([
      // Inject PII/OAuth canaries into fields 3, 7, 38 that must NEVER be decoded or returned
      fieldStr(3, 'CANARY_USER_EMAIL_secret@example.com'),
      fieldStr(7, 'CANARY_OAUTH_TOKEN_ya29.do_not_expose'),
      fieldBytes(38, fieldStr(1, 'CANARY_AVATAR_URL_https://example.invalid/avatar.png')),
      fieldBytes(36, fieldStr(2, 'Google AI Pro')),
      fieldBytes(
        33,
        concatBytes([
          fieldBytes(1, modelConfigProto('Gemini 3.8 Flash (High)', 0.8, 1_800_000_000, 'NEW')),
          fieldBytes(1, modelConfigProto('Gemini 3.8 Flash (Low)', 0.65, 1_799_999_000)),
          fieldBytes(1, modelConfigProto('Claude Sonnet 5.5', undefined, 1_800_005_000)),
          fieldBytes(1, modelConfigProto('GPT-OSS 120B (Medium)', 1.0)),
        ]),
      ),
    ])

    const userStatusRaw = encodeStateSyncMap([['userStatusSentinelKey', innerStatus]])
    const modelCreditsRaw = encodeStateSyncMap([
      ['availableCreditsSentinelKey', fieldVarint(2, 1234)],
      ['minimumCreditAmountForUsageKey', fieldVarint(2, 50)],
    ])

    const snap = parseQuotaFromStateSync(userStatusRaw, modelCreditsRaw, 1_799_990_000_000)
    assert.ok(snap)
    assert.equal(snap.planName, 'Google AI Pro')
    assert.equal(snap.availableCredits, 1234)
    assert.equal(snap.minCredits, 50)
    assert.equal(snap.syncedAtMs, 1_799_990_000_000)
    assert.equal(snap.pools.length, 3)

    const flash = snap.pools.find(p => p.label === 'Gemini 3.8 Flash')
    assert.ok(flash)
    assert.equal(flash.remainingPct, 65)
    assert.equal(flash.usedPct, 35)
    assert.equal(flash.resetAtMs, 1_799_999_000_000)
    assert.equal(flash.badge, 'NEW')

    const claude = snap.pools.find(p => p.label === 'Claude Sonnet 5.5')
    assert.ok(claude)
    assert.equal(claude.remainingPct, 0)
    assert.equal(claude.usedPct, 100)
    assert.equal(claude.resetAtMs, 1_800_005_000_000)

    const gpt = snap.pools.find(p => p.label === 'GPT-OSS 120B')
    assert.ok(gpt)
    assert.equal(gpt.remainingPct, 100)
    assert.equal(gpt.usedPct, 0)

    const serialized = JSON.stringify(snap)
    assert.equal(serialized.includes('CANARY_'), false)
    assert.equal(serialized.includes('example.com'), false)
    assert.equal(serialized.includes('ya29.'), false)
    assert.equal(serialized.includes('avatar.png'), false)
  })

  it('safely returns undefined for malformed, truncated, oversized, or runaway protobuf inputs', () => {
    assert.equal(parseQuotaFromStateSync(undefined, undefined, 0), undefined)
    assert.equal(parseQuotaFromStateSync('', '', 0), undefined)
    assert.equal(parseQuotaFromStateSync('!!!not-base64!!!', undefined, 0), undefined)
    assert.equal(parseQuotaFromStateSync('A'.repeat(350_001), undefined, 0), undefined)

    // Unknown wire type (wire 6)
    const badWire = Buffer.from(Uint8Array.from([(1 << 3) | 6, 0x01])).toString('base64')
    assert.equal(parseQuotaFromStateSync(badWire, undefined, 0), undefined)

    // Length-delimited field overrunning buffer
    const truncatedLen = Buffer.from(Uint8Array.from([(1 << 3) | 2, 0x7f, 0x01, 0x02])).toString('base64')
    assert.equal(parseQuotaFromStateSync(truncatedLen, undefined, 0), undefined)

    // Field number 0 is invalid protobuf
    const fieldZero = Buffer.from(Uint8Array.from([0x00, 0x01])).toString('base64')
    assert.equal(parseQuotaFromStateSync(fieldZero, undefined, 0), undefined)

    // Exceeds MAX_FIELDS (2000) inside inner message -> rejected cleanly
    const manyFields: Uint8Array[] = []
    for (let i = 0; i < 2005; i++) manyFields.push(fieldVarint(99, i))
    const overrunOuter = encodeStateSyncMap([['userStatusSentinelKey', concatBytes(manyFields)]])
    assert.equal(parseQuotaFromStateSync(overrunOuter, undefined, 0), undefined)
  })

  it('computes active session context budget across exact modelSteps, estimated fallback, clamping, and model overrides', () => {
    const emptyBoard: Board = { entries: [], counts: {} }
    assert.equal(computeContextBudget(emptyBoard), undefined)

    const exactGeminiBoard: Board = {
      entries: [],
      counts: {},
      model: 'gemini-4-neon-high',
      modelSteps: [
        { at: 1000, inputTokens: 100_000, cacheReadTokens: 150_000, outputTokens: 5_000, totalContextTokens: 250_000, cacheHitPct: 60 },
      ],
    }
    const gBudget = computeContextBudget(exactGeminiBoard)
    assert.ok(gBudget)
    assert.equal(gBudget.limitTokens, 1_000_000)
    assert.equal(gBudget.usedTokens, 250_000)
    assert.equal(gBudget.remainingTokens, 750_000)
    assert.equal(gBudget.usedPct, 25)
    assert.equal(gBudget.remainingPct, 75)
    assert.equal(gBudget.isEstimated, false)

    const claudeBoard: Board = {
      entries: [],
      counts: {},
      model: 'claude-sonnet-4-5',
      modelSteps: [
        { at: 1000, inputTokens: 40_000, cacheReadTokens: 60_000, outputTokens: 2_000, totalContextTokens: 100_000, cacheHitPct: 60 },
      ],
    }
    const cBudget = computeContextBudget(claudeBoard)
    assert.ok(cBudget)
    assert.equal(cBudget.limitTokens, contextWindowFor('claude-sonnet-4-5', 0))
    assert.ok(cBudget.limitTokens < gBudget.limitTokens)

    const customOverride = computeContextBudget(claudeBoard, 50_000)
    assert.ok(customOverride)
    assert.equal(customOverride.limitTokens, 50_000)
    assert.equal(customOverride.usedPct, 100)
    assert.equal(customOverride.remainingPct, 0)
    assert.equal(customOverride.remainingTokens, 0)

    const estimatedBoard: Board = {
      entries: [],
      counts: {},
      model: 'gemini-4-neon-high',
      context: 42.5,
    }
    const est = computeContextBudget(estimatedBoard)
    assert.ok(est)
    assert.equal(est.isEstimated, true)
    assert.equal(est.usedPct, 42.5)
    assert.equal(est.remainingPct, 57.5)
    assert.equal(est.usedTokens, 425_000)
    assert.equal(est.remainingTokens, 575_000)
  })

  it('formats reset countdown strings accurately and handles expired/unset times', () => {
    const now = 1_700_000_000_000
    assert.equal(formatResetCountdown(undefined, now), '')
    assert.equal(formatResetCountdown(Number.NaN, now), '')
    assert.equal(formatResetCountdown(now, now), '')
    assert.equal(formatResetCountdown(now - 60_000, now), '')
    assert.equal(formatResetCountdown(now + 20_000, now), '<1m')
    assert.equal(formatResetCountdown(now + 45 * 60_000, now), '45m')
    assert.equal(formatResetCountdown(now + 2 * 3_600_000 + 15 * 60_000, now), '2h 15m')
    assert.equal(formatResetCountdown(now + 3 * 3_600_000, now), '3h')
    assert.equal(formatResetCountdown(now + 28 * 3_600_000, now), '1d 4h')
    assert.equal(formatResetCountdown(now + 48 * 3_600_000, now), '2d')
  })

  it('enforces AppSec bounds: rejects 64-bit negative/oversized varints, invalid UTF-8 binary fields, mid-stream base64 pad, and mixed-slash UNC paths', async () => {
    // 10-byte two's-complement -1 varint in credits + invalid UTF-8 bytes in planName and badge
    const negOneVarint = Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01])
    const tagCreditsF2 = Uint8Array.from([(2 << 3) | 0, ...negOneVarint])
    const creditsRaw = encodeStateSyncMap([['availableCreditsSentinelKey', tagCreditsF2]])

    const invalidUtf8 = Uint8Array.from([0xff, 0xfe, 0xfd])
    const hugeResetSec = fieldBytes(2, fieldVarint(1, 20_000_000_000)) // > 10_000_000_000 ceiling
    const validLabelHugeReset = concatBytes([
      fieldStr(1, 'Gemini 3.8 Pro'),
      fieldBytes(15, concatBytes([fieldFloat32(1, 0.5), hugeResetSec])),
      fieldBytes(16, invalidUtf8),
    ])
    const innerStatus = concatBytes([
      fieldBytes(36, fieldBytes(2, invalidUtf8)),
      fieldBytes(33, fieldBytes(1, validLabelHugeReset)),
    ])
    const statusRaw = encodeStateSyncMap([['userStatusSentinelKey', innerStatus]])

    const snap = parseQuotaFromStateSync(statusRaw, creditsRaw, 1_700_000_000_000)
    assert.ok(snap)
    assert.equal(snap.planName, undefined)
    assert.equal(snap.availableCredits, undefined)
    assert.equal(snap.pools.length, 1)
    assert.equal(snap.pools[0]?.remainingPct, 50)
    assert.equal(snap.pools[0]?.resetAtMs, undefined)
    assert.equal(snap.pools[0]?.badge, undefined)

    // Mid-stream '=' padding rejected cleanly
    assert.equal(parseQuotaFromStateSync('AAAA=BBBB', undefined, 0), undefined)

    // Out-of-range >32-bit field tag rejected
    const tag64 = Uint8Array.from([0x82, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01, 0x00])
    assert.equal(parseQuotaFromStateSync(Buffer.from(tag64).toString('base64'), undefined, 0), undefined)

    // Mixed-slash UNC path must never enter candidates
    const cands = resolveStateDbCandidates('/\\evil-server\\share')
    assert.equal(cands.some(c => c.includes('evil-server')), false)

    // Usage watcher: parses EOF line without trailing '\n' and guards 1e308 tokens against NaN cacheHitPct
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ag-vis-quota-test-'))
    try {
      const now = 1_800_000_000_000
      const isoRecent = new Date(now - 60_000).toISOString()
      const tPath = path.join(tmpDir, 'transcript.jsonl')
      const line1 = JSON.stringify({
        type: 'PLANNER_RESPONSE',
        created_at: isoRecent,
        input_tokens: 1e308,
        cache_read_tokens: 1e308,
        output_tokens: 100,
      })
      const line2 = JSON.stringify({
        type: 'PLANNER_RESPONSE',
        created_at: isoRecent,
        input_tokens: 1000,
        cache_read_tokens: 9000,
        output_tokens: 500,
      })
      // Deliberately omit trailing '\n' on line2 to verify EOF buffer + StringDecoder flush
      const content = `${line1}\n${line2}`
      await fs.promises.writeFile(tPath, content, 'utf8')

      const usage = await readIdeTokenUsage(
        [
          {
            id: 'test-eof-session',
            title: 'EOF Test',
            transcriptPath: tPath,
            mtimeMs: now - 1000,
            sizeBytes: Buffer.byteLength(content, 'utf8'),
            workspaceUris: [],
            status: 'IDLE',
          },
        ],
        now,
      )
      assert.equal(usage.last24h.steps, 2)
      assert.equal(usage.last24h.sessions, 1)
      assert.equal(usage.last24h.outputTokens, 600)
      assert.equal(Number.isFinite(usage.last24h.cacheHitPct), true)
      assert.ok(usage.last24h.cacheHitPct >= 0 && usage.last24h.cacheHitPct <= 100)
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true })
    }
  })
})
