import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'my-agents',
  component: 'Pane',
  requestId: 'my-agents',
  props: { title: 'Agents', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const FILE = `---
name: commit-helper
description: Writes the commit message and makes a git commit.
tools: Bash, Read
model: sonnet
---
Body`

test('lists my agents, runs one from its button and shows it running then finished', async ($, on) => {
  let status: 'running' | 'completed' = 'running'
  mock.env(on, { USERPROFILE: 'C:/Users/me' })
  mock.clock(on, { now: Date.now() })
  on('command.register', () => ({ value: { command: 'my-agents' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:/Users/me' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: [{ name: 'commit-helper.md', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }))
  on('fs.read', () => ({ value: FILE }))
  const asked: string[] = []
  on('prompt.submit', (_, e) => {
    asked.push(e.text)
    return { text: e.text }
  })
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'x', type: 'commit-helper', status }] }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: 'C:/Users/me', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'my-agents', args: '' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never)
  expect(await ui.find({ type: 'Text', text: /^commit-helper$/ })).toBeDefined()

  // ▶ asks in the person's name; Claude then spawns the agent, as here.
  await ui.press({ key: 'run-C:/Users/me/.claude/agents/commit-helper.md' })
  expect(asked).toHaveLength(1)
  expect(asked[0]).toMatch(/^Run the commit-helper agent\./)
  await $.agent.spawn({ subagentType: 'commit-helper', prompt: 'go', description: 'commit' } as never)
  expect(await ui.find({ type: 'Text', text: /Running · 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▶ panel/ })).toBeDefined()

  status = 'completed'
  await $.turn.complete({ turnId: 't', agentId: 'a1', answer: 'Committed 3 files.', durationMs: 1000, isAborted: false } as never)
  expect(await ui.find({ type: 'Text', text: /Finished · 1/ })).toBeDefined()
  await ui.press({ key: 'answer-a1' })
  expect((await ui.find({ type: 'Text', text: /Committed/ }))?.text).toBe('Committed 3 files.')
  await ui.unmount()

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
  expect(await term.find({ type: 'Text', text: /^commit-helper$/ })).toBeDefined()
  await term.unmount()
})
