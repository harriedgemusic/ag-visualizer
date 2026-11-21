import type { TranscriptStep } from './types'

export type DemoItem = {
  delayMs: number
  from?: 'core' | 'agents'
  subagentLabel?: string
  step: TranscriptStep
}

const t0 = 1_763_720_000_000
const iso = (offsetMs: number): string => new Date(t0 + offsetMs).toISOString()
const genContent = (startOffset: number, endOffset: number | undefined, body = 'OK'): string =>
  endOffset === undefined
    ? `Created At: ${iso(startOffset)}\nTool is running in background.`
    : `Created At: ${iso(startOffset)}\nCompleted At: ${iso(endOffset)}\n${body}`

export const DEMO_TIMELINE: readonly DemoItem[] = [
  {
    delayMs: 300,
    step: {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: iso(0),
      content: 'Analyze the workspace and add resilient caching with tests.',
    },
  },
  {
    delayMs: 550,
    step: {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: iso(400),
      model: 'gemini-4-neon-high',
      input_tokens: 48_000,
      cache_read_tokens: 0,
      output_tokens: 320,
      tool_calls: [
        { name: 'read_file', args: { Path: '"/Users/dev/project/GEMINI.md"' } },
        { name: 'read_file', args: { Path: '"/Users/dev/project/.agents/skills/cache-design/SKILL.md"' } },
      ],
    },
  },
  {
    delayMs: 350,
    step: {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: iso(650),
      content: genContent(450, 520, '# Workspace instructions...'),
    },
  },
  {
    delayMs: 350,
    step: {
      step_index: 3,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: iso(700),
      content: genContent(460, 560, '# Skill instructions...'),
    },
  },
  {
    delayMs: 600,
    step: {
      step_index: 4,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: iso(1100),
      model: 'gemini-4-neon-high',
      input_tokens: 72_000,
      cache_read_tokens: 46_000,
      output_tokens: 410,
      thinking: 'Need to inspect store.ts around cache invalidation and search for existing TTL constants before spawning the audit subagent.',
      tool_calls: [
        { name: 'read_file', args: { Path: '"/Users/dev/project/src/cache/store.ts"', StartLine: 12, EndLine: 48 } },
        { name: 'grep_search', args: { Query: '"SECRET_CACHE_TOKEN"', SearchPath: '"/Users/dev/project/src"' } },
        { name: 'search_web', args: { query: '"stale-while-revalidate typescript patterns"' } },
      ],
    },
  },
  {
    delayMs: 350,
    step: {
      step_index: 5,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: iso(1200),
      content: genContent(1120, 1185, 'export class Store {}'),
    },
  },
  {
    delayMs: 350,
    step: {
      step_index: 6,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: iso(1260),
      content: genContent(1125, 1210, '3 matches'),
    },
  },
  {
    delayMs: 450,
    step: {
      step_index: 7,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: iso(1650),
      content: genContent(1130, 1620, 'Search results...'),
    },
  },
  {
    delayMs: 650,
    step: {
      step_index: 8,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: iso(2200),
      model: 'gemini-4-neon-high',
      input_tokens: 18_000,
      cache_read_tokens: 158_000,
      output_tokens: 510,
      tool_calls: [
        {
          name: 'invoke_subagent',
          args: {
            TypeName: '"research"',
            Role: '"Cache Audit Researcher"',
            Prompt: '"Inspect existing cache invalidation paths with confidential token XYZ."',
          },
        },
        {
          name: 'invoke_subagent',
          args: {
            TypeName: '"browser"',
            Role: '"Docs Preview Browser"',
            Prompt: '"Verify local preview at http://localhost:4173/dashboard?token=secret"',
          },
        },
      ],
    },
  },
  {
    delayMs: 300,
    step: {
      step_index: 9,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'RUNNING',
      created_at: iso(2300),
      content: genContent(2250, undefined),
    },
  },
  {
    delayMs: 300,
    step: {
      step_index: 10,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'RUNNING',
      created_at: iso(2320),
      content: genContent(2260, undefined),
    },
  },
  {
    delayMs: 550,
    from: 'agents',
    subagentLabel: 'Cache Audit Researcher',
    step: {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: iso(2700),
      model: 'gemini-4-hydrogen-medium',
      tool_calls: [
        { name: 'read_file', args: { Path: '"/Users/dev/project/src/cache/eviction.ts"' } },
        { name: 'read_url_content', args: { Url: '"https://user:pass@docs.example.dev/rfc9111?secret=1"' } },
      ],
    },
  },
  {
    delayMs: 450,
    from: 'agents',
    subagentLabel: 'Cache Audit Researcher',
    step: {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: iso(2900),
      content: genContent(2720, 2860, 'LRU eviction'),
    },
  },
  {
    delayMs: 450,
    from: 'agents',
    subagentLabel: 'Cache Audit Researcher',
    step: {
      step_index: 3,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: iso(3100),
      content: genContent(2730, 3080, 'RFC 9111'),
    },
  },
  {
    delayMs: 500,
    step: {
      step_index: 9,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: iso(3500),
      content: genContent(2250, 3480, 'Subagent finished'),
    },
  },
  {
    delayMs: 450,
    step: {
      step_index: 10,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: iso(3800),
      content: genContent(2260, 3760, 'Browser verified'),
    },
  },
  {
    delayMs: 450,
    step: {
      step_index: 11,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: iso(4100),
      content: 'Hook reminder: ensure strict cache TTL bounds.',
    },
  },
  {
    delayMs: 650,
    step: {
      step_index: 12,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: iso(4400),
      model: 'gemini-4-argon-high',
      input_tokens: 112_000,
      cache_read_tokens: 390_000,
      output_tokens: 680,
      tool_calls: [
        { name: 'write_file', args: { TargetFile: '"/Users/dev/project/src/cache/resilient.ts"', CodeContent: '"// secret"' } },
        { name: 'edit_file', args: { Path: '"/Users/dev/project/src/cache/store.ts"', Target: '"old"', Replacement: '"new"' } },
      ],
    },
  },
  {
    delayMs: 400,
    step: {
      step_index: 13,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: iso(4600),
      content: genContent(4430, 4560, 'Created file.'),
    },
  },
  {
    delayMs: 450,
    step: {
      step_index: 14,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'ERROR',
      error: 'target content not found in the file',
      created_at: iso(4750),
      content: genContent(4440, 4710, 'Edit failed'),
    },
  },
  {
    delayMs: 650,
    step: {
      step_index: 15,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: iso(5100),
      model: 'gemini-4-argon-high',
      input_tokens: 185_000,
      cache_read_tokens: 560_000,
      output_tokens: 420,
      tool_calls: [
        { name: 'edit_file', args: { Path: '"/Users/dev/project/src/cache/store.ts"', Target: '"export class"', Replacement: '"export class"' } },
        {
          name: 'run_command',
          args: {
            CommandLine: '"API_KEY=supersecret npm test -- --runInBand"',
            toolSummary: '"Unit test execution"',
          },
        },
      ],
    },
  },
  {
    delayMs: 400,
    step: {
      step_index: 16,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: iso(5280),
      content: genContent(5120, 5240, 'Updated.'),
    },
  },
  {
    delayMs: 550,
    step: {
      step_index: 17,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'RUNNING',
      created_at: iso(5350),
      content: genContent(5130, undefined),
    },
  },
  {
    delayMs: 850,
    step: {
      step_index: 17,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: iso(6150),
      content: genContent(5130, 6120, '24 tests passed'),
    },
  },
  {
    delayMs: 600,
    step: {
      step_index: 18,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: iso(6400),
      model: 'gemini-4-argon-high',
      input_tokens: 210_000,
      cache_read_tokens: 590_000,
      output_tokens: 280,
      tool_calls: [
        { name: 'write_file', args: { TargetFile: '"/Users/dev/.gemini/antigravity/brain/demo/walkthrough.md"', CodeContent: '"summary"' } },
      ],
    },
  },
  {
    delayMs: 400,
    step: {
      step_index: 19,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: iso(6550),
      content: genContent(6420, 6510, 'Artifact saved'),
    },
  },
  {
    delayMs: 550,
    step: {
      step_index: 20,
      source: 'SYSTEM',
      type: 'CHECKPOINT',
      status: 'DONE',
      created_at: iso(6900),
      input_tokens: 34_000,
      cache_read_tokens: 120_000,
      output_tokens: 1800,
      content: '# Resuming from a compaction',
    },
  },
  {
    delayMs: 650,
    step: {
      step_index: 21,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: iso(7400),
      model: 'gemini-4-argon-high',
      input_tokens: 38_000,
      cache_read_tokens: 120_000,
      output_tokens: 360,
      tool_calls: [],
    },
  },
]
