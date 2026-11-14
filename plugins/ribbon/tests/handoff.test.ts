import { expect, mock, test } from 'claude-code/testing'

import { HANDOFF_PROMPT } from '../hooks/register'

const NOW = Date.parse('2098-12-31T22:00:00Z')
const MIN = 60_000
const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
} as const

/** A session resumed `idleMin` minutes after its last reply, with `tokens` of context; records prompts the band submits. */
const seed = async ($: any, on: any, idleMin: number, tokens: number) => {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  const sent: { text: string; origin: unknown; asUser?: boolean }[] = []
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
  on('classic.SessionStart', () => ({}))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', ($: any, e: any) => {
    sent.push({ text: e.text, origin: e.origin, asUser: e.origin?.asUser })
    return { text: e.text }
  })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: idleMin * 60, context_tokens: tokens, model: 'claude-opus-5-5' })
  return { clock, sent }
}

test('a big session asks for one handoff a few minutes before the cache goes cold', async ($, on) => {
  const { clock, sent } = await seed($, on, 40, 200_000)

  await clock.advance(10 * MIN) // 50m idle: too early
  expect(sent).toEqual([])

  await clock.advance(6 * MIN) // 56m idle: inside the last 5 minutes
  expect(sent.length).toBe(1)
  expect(sent[0].text).toBe(HANDOFF_PROMPT)
  expect(sent[0].origin).toMatchObject({ kind: 'plugin', name: 'ribbon', asUser: true })

  await clock.advance(3 * MIN) // still warm, already asked
  expect(sent.length).toBe(1)

  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ text: ' · handoff written' })).toBeDefined()
  await band.unmount()
})

test('a small session gets no handoff', async ($, on) => {
  const { clock, sent } = await seed($, on, 40, 10_000)
  await clock.advance(20 * MIN)
  expect(sent).toEqual([])
})

test('a session already cold gets no handoff, since it would cost the cold price', async ($, on) => {
  const { clock, sent } = await seed($, on, 90, 200_000)
  await clock.advance(5 * MIN)
  expect(sent).toEqual([])
})

test('a cleared session forgets its handoff', async ($, on) => {
  const { clock, sent } = await seed($, on, 54, 200_000)
  await clock.advance(2 * MIN)
  expect(sent.length).toBe(1)
  await $.classic.SessionStart({ source: 'clear' })
  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ text: ' · handoff written' })).toBeUndefined()
  await band.unmount()
})
