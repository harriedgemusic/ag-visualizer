import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { classifyTool, hostOf, shortModel } from '../src/core/classify'
import { setupFrom } from '../src/core/setup'

describe('classifyTool & privacy helpers', () => {
  const setup = setupFrom({ language: 'en' })

  it('maps file tools to files station with last two path segments (Unix & Windows)', () => {
    assert.deepEqual(
      classifyTool('read_file', { Path: '/Users/secret/repos/app/src/index.ts' }, setup),
      { station: 'files', label: 'src/index.ts' },
    )
    assert.deepEqual(
      classifyTool('edit_file', { Path: '"C:\\Users\\secret\\repo\\lib\\util.ts"' }, setup),
      { station: 'files', label: 'lib/util.ts' },
    )
    assert.deepEqual(
      classifyTool('write_file', { TargetFile: '/a/b/c/README.md' }, setup),
      { station: 'files', label: 'c/README.md' },
    )
    assert.deepEqual(
      classifyTool('grep_search', { Query: 'SECRET_API_KEY', SearchPath: '/a/b' }, setup),
      { station: 'files', label: 'grep_search' },
    )
    assert.deepEqual(
      classifyTool('find_by_name', { Pattern: '*.env', SearchDirectory: '/a/b' }, setup),
      { station: 'files', label: 'find_by_name' },
    )
  })

  it('routes memory, skills, hooks, and artifact files to their dedicated stations', () => {
    assert.deepEqual(
      classifyTool('read_file', { Path: '/Users/dev/project/GEMINI.md' }, setup),
      { station: 'memory', label: 'project/GEMINI.md' },
    )
    assert.deepEqual(
      classifyTool('read_file', { Path: '/Users/dev/.gemini/antigravity/knowledge/notes.md' }, setup),
      { station: 'memory', label: 'knowledge/notes.md' },
    )
    assert.deepEqual(
      classifyTool('read_file', { Path: '/Users/dev/.gemini/antigravity/builtin/skills/plugin/SKILL.md' }, setup),
      { station: 'skills', label: 'plugin' },
    )
    assert.deepEqual(
      classifyTool('edit_file', { Path: '/Users/dev/repo/.agents/hooks.json' }, setup),
      { station: 'hooks', label: '.agents/hooks.json' },
    )
    assert.deepEqual(
      classifyTool('write_file', { TargetFile: '/Users/dev/.gemini/antigravity/brain/conv-1/walkthrough.md' }, setup),
      { station: 'you', label: 'artifact: walkthrough.md' },
    )
  })

  it('classifies shell commands without exposing flags or arguments', () => {
    assert.deepEqual(
      classifyTool('run_command', { CommandLine: 'ls -la /Users/secret/folder' }, setup),
      { station: 'files', label: 'ls' },
    )
    assert.deepEqual(
      classifyTool('run_command', { CommandLine: 'git status --short' }, setup),
      { station: 'shell', label: 'git' },
    )
    assert.deepEqual(
      classifyTool('run_command', { CommandLine: 'git push origin main' }, setup),
      { station: 'web', label: 'git' },
    )
    assert.deepEqual(
      classifyTool('run_command', { CommandLine: 'curl -H "Authorization: Bearer tok" https://api.example.com/v1' }, setup),
      { station: 'web', label: 'curl' },
    )
    assert.deepEqual(
      classifyTool('run_command', { CommandLine: 'sudo env API_KEY=123 npm install lodash' }, setup),
      { station: 'web', label: 'npm' },
    )
    assert.deepEqual(
      classifyTool('run_command', { CommandLine: 'bash -c "curl https://evil.test"' }, setup),
      { station: 'web', label: 'bash' },
    )
    assert.deepEqual(
      classifyTool('run_command', { CommandLine: 'cat <<EOF\ncurl https://not-run.test\nEOF' }, setup),
      { station: 'files', label: 'cat' },
    )
    assert.deepEqual(
      classifyTool('run_command', { CommandLine: 'npm test', toolSummary: 'Unit test execution' }, setup),
      { station: 'shell', label: 'Unit test execution' },
    )
  })

  it('classifies web, browser, agents, skills, you, and MCP tools', () => {
    assert.deepEqual(classifyTool('search_web', { query: 'secret query' }, setup), {
      station: 'web',
      label: 'web search',
    })
    assert.deepEqual(
      classifyTool('read_url_content', { Url: 'https://user:pass@docs.example.com/a/b?token=x' }, setup),
      { station: 'web', label: 'docs.example.com' },
    )
    assert.deepEqual(
      classifyTool('browser_navigate', { Url: 'https://localhost:3000/secret?k=1' }, setup),
      { station: 'browser', label: 'localhost:3000' },
    )
    assert.deepEqual(
      classifyTool('invoke_subagent', { TypeName: 'browser', Role: 'UI Tester', Prompt: 'Login with pass' }, setup),
      { station: 'browser', label: 'UI Tester' },
    )
    assert.deepEqual(
      classifyTool('invoke_subagent', { TypeName: 'research', Role: 'Code Researcher', Prompt: 'Secret prompt' }, setup),
      { station: 'agents', label: 'Code Researcher' },
    )
    assert.deepEqual(
      classifyTool('swarm', { action: 'add', brief: 'Top secret brief' }, setup),
      { station: 'agents', label: 'swarm: add' },
    )
    assert.deepEqual(classifyTool('ask_question', { questions: [] }, setup), {
      station: 'you',
      label: 'question for you',
    })
    assert.deepEqual(classifyTool('exit_plan_mode', { plan: 'Secret plan' }, setup), {
      station: 'you',
      label: 'plan',
    })
    assert.deepEqual(classifyTool('schedule', { CronExpression: '* * * * *', Prompt: 'Secret cron' }, setup), {
      station: 'shell',
      label: 'schedule',
    })
    assert.deepEqual(classifyTool('manage_task', { Action: 'send_input', Input: 'secret stdin' }, setup), {
      station: 'shell',
      label: 'manage_task: send_input',
    })

    const customSetup = setupFrom({
      memoryServers: ['mem0'],
      serverStations: { github: 'web' },
    })
    assert.deepEqual(classifyTool('mcp__mem0__save_note', { id: '42', text: 'secret' }, customSetup), {
      station: 'memory',
      label: 'save note #42',
    })
    assert.deepEqual(classifyTool('mcp__github__list_prs', { repo: 'secret' }, customSetup), {
      station: 'web',
      label: 'github/list prs',
    })
    assert.deepEqual(classifyTool('mcp__figma__get_node', { token: 'secret' }, customSetup), {
      station: 'skills',
      label: 'figma/get node',
    })
  })

  it('extracts host safely without credentials, paths, query leaks, or schemeless tokens', () => {
    assert.equal(hostOf('https://user:pa/ss@docs.example.com:8443/p?q=1#h'), 'https')
    assert.equal(hostOf('https://user:p@ss/word@realhost.com/api'), 'https')
    assert.equal(hostOf('https://user:pass/path?k=1@secret-token'), 'https')
    assert.equal(hostOf('sk-ant-api03-abcdef123456'), '')
    assert.equal(hostOf('https://localhost:3000/@vite/client'), 'localhost:3000')
    assert.equal(hostOf('https://a.example\\@b.example/'), 'a.example')
    assert.equal(hostOf('http://[::1]:8080/api'), '[::1]:8080')
    assert.equal(hostOf('https://user:pass@onlyuser'), 'onlyuser')
  })

  it('handles view_code_item File, python3 -u -m pip, JSON-quoted mcp id, and strict action validation', () => {
    assert.deepEqual(
      classifyTool('view_code_item', { File: '/repo/src/core/draw.ts' }, setup),
      { station: 'files', label: 'core/draw.ts' },
    )
    assert.deepEqual(
      classifyTool('run_command', { CommandLine: 'python3 -u -m pip install requests' }, setup),
      { station: 'web', label: 'python3' },
    )
    const memSetup = setupFrom({ memoryServers: ['mem0'] })
    assert.deepEqual(
      classifyTool('mcp__mem0__get_item', { id: '"42"' }, memSetup),
      { station: 'memory', label: 'get item #42' },
    )
    assert.deepEqual(
      classifyTool('manage_task', { Action: 'kill; rm -rf /' }, setup),
      { station: 'shell', label: 'manage_task' },
    )
  })

  it('shortens Antigravity and Claude model names', () => {
    assert.equal(shortModel('gemini-4-neon-high'), 'neon-high')
    assert.equal(shortModel('gemini-4-hydrogen-medium'), 'hydrogen-med')
    assert.equal(shortModel('claude-sonnet-4-5'), 'sonnet 4.5')
  })
})
