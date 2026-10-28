import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'activity-band',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

const answer = ($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1]) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 1000000 }, cost: { usd: 1.5 } } }))
  mock.clock(on, { now: Date.now() })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
}

test('the bar names the running tool, then idles with turn, cost and cache', async ($, on) => {
  answer($, on)
  let release = () => {}
  let reached = () => {}
  const isReached = new Promise<void>(r => (reached = r))
  on('tool.call', () => {
    reached()
    return new Promise(r => (release = () => r({ result: {} })))
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1' } as never)
  const call = $.tool.call({ tool: 'Bash', command: 'npm test' })
  await isReached

  const busy = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
  expect((await busy.find({ type: 'Svg' }))?.props.alt).toMatch(/^Bash: npm test: No task list · 1 tool ·/)
  await busy.unmount()
  const term = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect(await term.find({ type: 'Text', text: /Bash: npm test/ })).toBeDefined()
  await term.unmount()

  release()
  await call
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 4000, isAborted: false } as never)

  const idle = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
  const alt = (await idle.find({ type: 'Svg' }))?.props.alt as string
  expect(alt).toMatch(/Idle · last turn 4s, 1 tool calls/)
  expect(alt).toMatch(/Turn 1 · — · 0\.00 \| \$1\.50 · (59|60):\d\d$/)
  await idle.unmount()
})

test('the bar counts the task list Claude keeps', async ($, on) => {
  answer($, on)
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1' } as never)
  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: 'Read the code', status: 'in_progress' },
      { content: 'Write the fix', status: 'pending' },
      { content: 'Run the tests', status: 'pending' },
      { content: 'Write the note', status: 'pending' },
    ],
    scope: 'first_task',
  } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as never)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toMatch(/^Run the tests: Tasks 2\/4, 50% · Turn 1/)
  await ui.unmount()
})

test('the closing wrap-up finishes the list', async ($, on) => {
  answer($, on)
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1' } as never)
  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: 'Fix it', status: 'in_progress' },
      { content: 'Test it', status: 'pending' },
    ],
    scope: 'continuation',
  } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Done.' } as never)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toMatch(/^All tasks done: Done 2\/2, 100%/)
  await ui.unmount()
})

test('the bar keeps its place and size whatever the title says', async ($, on) => {
  answer($, on)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1' } as never)

  const barOf = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
    const source = (await ui.find({ type: 'Svg' }))?.props.source as string
    await ui.unmount()
    return /<g transform="translate\(([\d.]+) 0\)">\s*<rect class="k" x="0" y="[\d.]+" width="([\d.]+)"/.exec(source)?.slice(1)
  }
  const plan = (title: string) => ({
    tool: 'mcp__ccd_turn__update_plan',
    items: [{ content: title, status: 'in_progress' }, { content: 'Next', status: 'pending' }],
    scope: 'continuation',
  })

  await $.tool.call(plan('Fix') as never)
  const short = await barOf()
  await $.tool.call(plan('Rewrite the whole settings screen so every option has a label and help text') as never)
  const long = await barOf()
  expect(short).toBeDefined()
  expect(long).toEqual(short)
})
