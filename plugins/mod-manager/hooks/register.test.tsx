import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'mod-manager',
  component: 'Pane',
  requestId: 'mod-manager',
  props: { title: 'Mods', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const HOME = 'C:/Users/me'

const LIST = [
  { id: 'band@my-mods', version: '0.1.0', scope: 'user', enabled: true, installPath: 'C:\\Users\\me\\.claude\\plugins\\cache\\my-mods\\band\\0.1.0' },
  { id: 'pane@my-mods', version: '1.0.0', scope: 'user', enabled: false, installPath: 'C:\\Users\\me\\.claude\\plugins\\cache\\my-mods\\pane\\1.0.0' },
  { id: 'skills@other', version: '2.0.0', scope: 'user', enabled: true, installPath: 'C:\\Users\\me\\.claude\\plugins\\cache\\other\\skills\\2.0.0' },
]

const FILES: Record<string, string> = {
  [`${HOME}/.claude/plugins/known_marketplaces.json`]: JSON.stringify({ 'my-mods': { installLocation: 'D:\\mods' } }),
  'D:/mods/.claude-plugin/marketplace.json': JSON.stringify({ plugins: [{ name: 'band', source: './plugins/band' }, { name: 'pane', source: './plugins/pane' }] }),
  'D:/mods/plugins/band/.claude-plugin/plugin.json': JSON.stringify({ name: 'band', version: '0.2.0' }),
  'D:/mods/plugins/pane/.claude-plugin/plugin.json': JSON.stringify({ name: 'pane', version: '1.0.0' }),
  [`${HOME}/.claude/plugins/cache/my-mods/band/0.1.0/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'band', description: 'A band above the prompt' }),
  [`${HOME}/.claude/plugins/cache/my-mods/band/0.1.0/hooks/hooks.json`]: JSON.stringify({ modules: ['./register.tsx'] }),
  [`${HOME}/.claude/plugins/cache/my-mods/pane/1.0.0/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'pane', description: 'A pane' }),
  [`${HOME}/.claude/plugins/cache/my-mods/pane/1.0.0/hooks/hooks.json`]: JSON.stringify({ modules: ['./register.tsx'] }),
  [`${HOME}/.claude/plugins/cache/other/skills/2.0.0/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'skills', description: 'Only skills' }),
}

// The engine hands hooks Windows paths with backslashes.
const norm = (p: string) => p.replace(/\\/g, '/')

const setUp = (on: Parameters<TestBody>[1], runs: string[][]) => {
  mock.clock(on, { now: Date.UTC(2026, 10, 5, 12, 30) })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sid-1' }) as never)
  on('command.register', () => ({ value: { command: 'mods' } }))
  on('command.list', () => ({ value: [{ name: 'pane:show', description: 'Show it', source: 'plugin', plugin: 'pane' }, { name: 'band', description: 'Band', source: 'plugin', plugin: 'band' }] }) as never)
  on('command.run', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }) as never)
  on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined }) as never)
  on('fs.exists', (_, e) => ({ value: norm(e.path) in FILES }) as never)
  on('fs.read', (_, e) => ({ value: FILES[norm(e.path)] ?? '' }) as never)
  on('fs.list', () => ({ value: [] }) as never)
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    if (e.argv.includes('list')) return { value: { exitCode: 0, stdout: JSON.stringify(LIST), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
    return { value: { exitCode: 0, stdout: 'ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: lists mods first, shows updates, switches a mod with the claude CLI`, async ($, on) => {
    const runs: string[][] = []
    setUp(on, runs)
    await $.session.start({ cwd: 'C:/repo', surface, isInteractive: true })
    const ran = await $.command.run({ command: 'mods', args: '' } as never)
    expect(ran.text).toBe('Opened the Mods pane.')

    const ui = await $.ui.mount({ ...PANE, surface } as never)
    expect(await ui.find({ type: 'Text', text: /^2 mods · 1 on$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /A band above the prompt/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /v0\.2\.0 available/ })).toBeDefined()
    expect(await ui.find({ key: 'cmd-band@my-mods-band' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\/band to open$/ })).toBeDefined()
    // The switch is the one button; no second control beside it.
    expect(await ui.find({ key: 'sw-pane@my-mods' })).toBeDefined()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg', alt: 'Band icon' } as never)).toBeDefined()
    // A plugin that is off shows no commands; one with no hooks module waits under "Other plugins".
    expect(await ui.find({ key: 'cmd-pane@my-mods-pane:show' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Only skills/ })).toBeUndefined()
    await ui.press({ key: 'plugins' })
    expect(await ui.find({ type: 'Text', text: /Only skills/ })).toBeDefined()

    await ui.press({ key: 'sw-pane@my-mods' })
    expect(runs.some(r => r.join(' ').endsWith('plugin enable pane@my-mods --scope user'))).toBe(true)
    expect(await ui.find({ type: 'Text', text: /Pane is on from the next chat on/ })).toBeDefined()
  })
}
