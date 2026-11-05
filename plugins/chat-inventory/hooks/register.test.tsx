import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'chat-inventory',
  component: 'Pane',
  requestId: 'chat-inventory',
  props: { title: 'In this chat', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const USAGE = {
  context: {
    breakdown: {
      memoryFiles: [{ path: 'C:/Users/me/.claude/CLAUDE.md', type: 'User', tokens: 10 }],
      skills: { totalSkills: 1, includedSkills: 1, tokens: 5, skillFrontmatter: [{ name: 'deploy', source: 'user', tokens: 5 }] },
    },
  },
}

const setUp = (on: Parameters<TestBody>[1]) => {
  mock.clock(on, { now: Date.UTC(2026, 10, 5, 12, 30) })
  on('command.register', () => ({ value: { command: 'inventory' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [] }))
  on('session.usage', () => ({ value: USAGE }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.run', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok' }) as never)
}

test('counts connector calls, files, skills and the app plan, and shows calls on press', async ($, on) => {
  setUp(on)
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', tool_use_id: 'p1', items: [{ content: 'Scan the mod', status: 'in_progress' }, { content: 'Write ours', status: 'pending' }] } as never)
  await $.tool.call({ tool: 'mcp__d4f71c04-03e2-45e0-ab0a-27253e0f2ece__search_threads', tool_use_id: 't1', query: 'invoice' } as never)
  await $.tool.call({ tool: 'mcp__d4f71c04-03e2-45e0-ab0a-27253e0f2ece__get_thread', tool_use_id: 't2', threadId: 'abc' } as never)
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', tool_use_id: 't3', title: 'x' } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 't4', file_path: 'D:\\Projects\\app\\src\\main.ts' } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 't5', file_path: 'C:\\Users\\me\\AppData\\Local\\Temp\\claude\\x.txt' } as never)
  await $.tool.call({ tool: 'Skill', tool_use_id: 't6', skill: 'deploy' } as never)
  // The same call seen twice counts once.
  await $.tool.call({ tool: 'Skill', tool_use_id: 't6', skill: 'deploy' } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', tool_use_id: 'p2', advance: true } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
  expect(await ui.find({ type: 'Text', text: /^1 of 2$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 calls/ })).toBeDefined()
  const gmail = await ui.find({ key: 'c-d4f71c04-03e2-45e0-ab0a-27253e0f2ece' })
  expect((gmail as unknown as { props: { label: string } }).props.label).toBe('▸ Gmail')
  // The desktop app's own session tools are not a connector.
  expect(await ui.find({ key: 'c-ccd_session' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /main\.ts/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /x\.txt/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^1 use$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^auto$/ })).toBeDefined()

  await ui.press({ key: 'c-d4f71c04-03e2-45e0-ab0a-27253e0f2ece' })
  expect(await ui.find({ type: 'Text', text: /Gmail calls, newest first/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /invoice/ })).toBeDefined()

  await ui.press({ key: 'sec-files' })
  expect(await ui.find({ type: 'Text', text: /main\.ts/ })).toBeUndefined()
})

test('draws connector tiles on desktop and opens with /inventory', async ($, on) => {
  setUp(on)
  await $.session.start({ cwd: 'C:/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__claude-in-chrome__navigate', tool_use_id: 'n1', url: 'https://example.com' } as never)
  const ran = await $.command.run({ command: 'inventory', args: '' } as never)
  expect(ran.text).toBe('Opened the In this chat pane.')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never)
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect(await ui.find({ key: 'c-claude-in-chrome' })).toBeDefined()
})
