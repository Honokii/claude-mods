import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { layoutGraph, parseLog, parseNumstat, parseStatus, rowGlyphs } from './git'

const PANE = {
  plugin: 'git-pane',
  component: 'Pane',
  requestId: 'git-pane',
  props: { title: 'Git', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

const NOW = Date.UTC(2026, 10, 12, 12, 0)
const h = (c: string) => c.repeat(40)
const rec = (hash: string, parents: string[], refs: string, subject: string, body = '') =>
  `${hash}\x1f${parents.join(' ')}\x1fHonoki\x1f2026-11-10T12:00:00Z\x1f${refs}\x1f${subject}\x1f${body}\x1e\n`

// feature: c1 <- c2 (merges main's c4) <- c3 <- c5; main: c4 <- c5.
const LOG =
  rec(h('1'), [h('2')], 'HEAD -> feature, origin/feature', 'Add the pane', 'Tiles, a band\nand the history graph.') +
  rec(h('2'), [h('3'), h('4')], '', "Merge branch 'main' into feature") +
  rec(h('3'), [h('5')], '', 'Start the feature') +
  rec(h('4'), [h('5')], 'origin/main, main', 'Fix the readme') +
  rec(h('5'), [], '', 'First commit')

const STATUS = [
  '# branch.oid 1111111',
  '# branch.head feature',
  '# branch.upstream origin/feature',
  '# branch.ab +2 -1',
  '1 M. N... 100644 100644 100644 aaa bbb README.md',
  '1 .M N... 100644 100644 100644 aaa bbb src/app.ts',
  '2 R. N... 100644 100644 100644 aaa bbb R100 src/new name.ts',
  'src/old.ts',
  '? notes.txt',
  '',
].join('\0')

const CACHED = '3\t1\tREADME.md\0' + '0\t0\t\0src/old.ts\0src/new name.ts\0'
const UNSTAGED = '10\t2\tsrc/app.ts\0'

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never
const fail = (stderr: string) => ({ value: { exitCode: 128, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } }) as never

function fakeGit(args: string[], cwd: string) {
  const a = args.join(' ')
  if (a === 'rev-parse --show-toplevel') {
    if (cwd.startsWith('C:/repo')) return ok('C:/repo\n')
    if (cwd === 'D:/other') return ok('D:/other\n')
    return fail('fatal: not a git repository')
  }
  if (a.startsWith('status')) return ok(STATUS)
  if (a.startsWith('diff --cached --numstat')) return ok(CACHED)
  if (a.startsWith('diff --numstat')) return ok(UNSTAGED)
  if (a.startsWith('diff --shortstat')) return ok(' 3 files changed, 40 insertions(+), 5 deletions(-)\n')
  if (a.startsWith('log') && a.endsWith('main..HEAD')) return ok(LOG.split('\x1e\n').slice(0, 3).join('\x1e\n') + '\x1e\n')
  if (a.startsWith('log')) return ok(LOG)
  if (a === 'rev-list --count HEAD') return ok('64\n')
  if (a.startsWith('rev-list --left-right')) return ok('1\t3\n')
  if (a.startsWith('for-each-ref')) return ok('feature\nmain\n')
  if (a.startsWith('worktree list')) return ok('worktree C:/repo\nHEAD 1111\nbranch refs/heads/feature\n\nworktree C:/repo-wt\nHEAD 2222\nbranch refs/heads/main\n')
  return ok('')
}

const setUp = (on: Parameters<TestBody>[1], runs: string[]) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:\\repo' }) as never)
  on('command.register', () => ({ value: { command: 'git' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'git-pane' }] }) as never)
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('process.run', (_, e) => {
    const args = e.argv.slice(1)
    runs.push(args.join(' '))
    return fakeGit(args, norm(e.init?.cwd ?? 'C:/repo'))
  })
}

test('reads porcelain v2 status, numstat and the log', async () => {
  const st = parseStatus(STATUS)
  expect(st.branch).toBe('feature')
  expect(st.ahead).toBe(2)
  expect(st.behind).toBe(1)
  expect(st.files.map(f => `${f.where}:${f.status}:${f.path}`)).toEqual([
    'staged:M:README.md',
    'unstaged:M:src/app.ts',
    'staged:R:src/new name.ts',
    'untracked:?:notes.txt',
  ])
  expect(st.files[2]!.from).toBe('src/old.ts')
  const n = parseNumstat(CACHED)
  expect(n.get('README.md')).toEqual({ added: 3, removed: 1 })
  expect(n.get('src/new name.ts')).toEqual({ added: 0, removed: 0 })
  const log = parseLog(LOG)
  expect(log.length).toBe(5)
  expect(log[0]!.refs).toEqual(['HEAD -> feature', 'origin/feature'])
  expect(log[0]!.body).toBe('Tiles, a band\nand the history graph.')
})

test('lays out the graph: a merge opens a lane, the shared parent closes it', async () => {
  const rows = layoutGraph(parseLog(LOG))
  expect(rows.map(r => r.lane)).toEqual([0, 0, 0, 1, 0])
  expect(rows[1]!.isMerge).toBe(true)
  expect(rows[1]!.bottom).toEqual([
    [0, 0],
    [0, 1],
  ])
  // Lane 1 runs past the third commit, then curves into the first commit.
  expect(rows[2]!.top).toContainEqual([1, 1])
  expect(rows[4]!.top).toContainEqual([1, 0])
  expect(rowGlyphs(rows[3]!, 2, true)).toBe('│ ●')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: shows changes and history, stages, discards after asking, tracks this chat's edits`, async ($, on) => {
    const runs: string[] = []
    setUp(on, runs)
    await $.session.start({ cwd: 'C:/repo', surface, isInteractive: true })
    const ran = await $.command.run({ command: 'git', args: '' } as never)
    expect(ran.text).toBe('Opened the Git pane.')

    const ui = await $.ui.mount({ ...PANE, surface } as never)
    expect(await ui.find({ key: 't-changed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^⎇ feature$/ })).toBeDefined()
    // Ahead and behind the upstream: the band, with Pull and Push.
    expect(await ui.find({ type: 'Text', text: /^Needs a look$/ })).toBeDefined()
    expect(await ui.find({ key: 'att-pull' })).toBeDefined()
    expect(await ui.find({ key: 'att-push' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Staged \(2\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /src\/old\.ts → src\/new name\.ts/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\+10 −2$/ })).toBeDefined()
    // The branch against main.
    expect(await ui.find({ type: 'Text', text: /^feature vs main$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↑3 ↓1 · 3 files · \+40 −5/ })).toBeDefined()
    // History: the graph and 20 more.
    expect(await ui.find({ type: 'Text', text: /^5 of 64$/ })).toBeDefined()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg', alt: 'Branch graph' } as never)).toBeDefined()
    expect(await ui.find({ key: 'more' })).toBeDefined()

    // A commit's description opens on press.
    expect(await ui.find({ type: 'Text', text: /and the history graph/ })).toBeUndefined()
    await ui.press({ key: `c-${h('1')}` })
    expect(await ui.find({ type: 'Text', text: /and the history graph/ })).toBeDefined()

    await ui.press({ key: 'stage-src/app.ts' })
    expect(runs).toContain('add -- src/app.ts')

    // Discard asks first; nothing runs until Yes.
    await ui.press({ key: 'discard-src/app.ts' })
    expect(await ui.find({ type: 'Text', text: /^Discard changes to app\.ts\?$/ })).toBeDefined()
    expect(runs.some(r => r.startsWith('restore -- '))).toBe(false)
    await ui.press({ key: 'confirm-no' })
    expect(await ui.find({ key: 'confirm-yes' })).toBeUndefined()
    await ui.press({ key: 'discard-src/app.ts' })
    await ui.press({ key: 'confirm-yes' })
    expect(runs).toContain('restore -- src/app.ts')

    // Deleting an untracked file asks too.
    await ui.press({ key: 'delete-notes.txt' })
    await ui.press({ key: 'confirm-yes' })
    expect(runs).toContain('clean -f -- notes.txt')

    // Switching with uncommitted changes asks.
    await ui.press({ key: 'branches' })
    await ui.press({ key: 'sw-main' })
    expect(await ui.find({ type: 'Text', text: /^Switch to main\?$/ })).toBeDefined()
    await ui.press({ key: 'confirm-yes' })
    expect(runs).toContain('switch main')

    await ui.press({ key: 'pull' })
    expect(runs).toContain('pull --ff-only')

    // Claude edits a file: it gets its own card and a chat tag.
    expect(await ui.find({ type: 'Text', text: /^This chat's edits/ })).toBeUndefined()
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: 'C:\\repo\\src\\app.ts', old_string: 'a', new_string: 'b' } as never)
    await $.tool.call({ tool: 'Write', tool_use_id: 'e2', file_path: 'C:\\repo\\docs\\done.md', content: 'x' } as never)
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /^This chat's edits \(2\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^chat$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^no changes now$/ })).toBeDefined()
  })
}

test('the switcher lists the session folder, its worktrees and added repos', async ($, on) => {
  const runs: string[] = []
  setUp(on, runs)
  await $.session.start({ cwd: 'C:/repo', surface: 'desktop', isInteractive: true })
  expect((await $.command.run({ command: 'git', args: 'add D:/nope' } as never)).text).toBe('D:/nope is not a git repository.')
  expect((await $.command.run({ command: 'git', args: 'add D:\\other' } as never)).text).toBe('Added D:/other to the Git pane.')
  await $.command.run({ command: 'git', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never)
  await ui.press({ key: 'repos' })
  expect(await ui.find({ type: 'Text', text: /^session folder$/ })).toBeDefined()
  expect(await ui.find({ key: 'pick-C:/repo-wt' })).toBeDefined()
  expect(await ui.find({ key: 'pick-D:/other' })).toBeDefined()
  await ui.press({ key: 'pick-D:/other' })
  expect(runs.some(r => r.startsWith('status'))).toBe(true)
  expect((await $.command.run({ command: 'git', args: 'remove D:/other' } as never)).text).toBe('Removed D:/other from the Git pane.')
})

// A session folder that is no repo, with three repos one level down (and a plain folder).
const MULTI_STATUS: Record<string, string> = {
  'D:/Betmate/core': ['# branch.head develop', '# branch.upstream origin/develop', '# branch.ab +0 -4', ''].join('\0'),
  'D:/Betmate/games': ['# branch.head wrath', '# branch.upstream origin/wrath', '# branch.ab +2 -0', '1 .M N... 100644 100644 100644 a b src/ui.ts', '1 M. N... 100644 100644 100644 a b README.md', '? new.txt', ''].join('\0'),
  'D:/Betmate/stack': ['# branch.head main', '# branch.upstream origin/main', '# branch.ab +0 -0', ''].join('\0'),
}

const setUpMulti = (on: Parameters<TestBody>[1], runs: string[]) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'D:\\Betmate' }) as never)
  on('command.register', () => ({ value: { command: 'git' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'git-pane' }] }) as never)
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('fs.list', () =>
    ({
      value: [
        { name: 'core', kind: 'dir', isLink: false },
        { name: 'games', kind: 'dir', isLink: false },
        { name: 'stack', kind: 'dir', isLink: false },
        { name: 'docs', kind: 'dir', isLink: false },
        { name: '.claude', kind: 'dir', isLink: false },
        { name: 'notes.md', kind: 'file', isLink: false },
      ],
    }) as never,
  )
  on('fs.exists', (_, e) => ({ value: /\/(core|games|stack)\/\.git$/.test(norm(e.path)) }) as never)
  on('process.run', (_, e) => {
    const args = e.argv.slice(1)
    const cwd = norm(e.init?.cwd ?? '')
    runs.push(`${cwd}: ${args.join(' ')}`)
    const a = args.join(' ')
    if (a === 'rev-parse --show-toplevel') return cwd in MULTI_STATUS ? ok(`${cwd}\n`) : fail('fatal: not a git repository')
    if (a.startsWith('status')) return ok(MULTI_STATUS[cwd] ?? '')
    if (a === 'log -1 --format=%aI') return ok('2026-11-12T09:00:00Z\n')
    return fakeGit(args, 'C:/repo')
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a folder of repos opens on the overview; Open and All repos move between views`, async ($, on) => {
    const runs: string[] = []
    setUpMulti(on, runs)
    await $.session.start({ cwd: 'D:/Betmate', surface, isInteractive: true })
    await $.command.run({ command: 'git', args: '' } as never)
    const ui = await $.ui.mount({ ...PANE, surface } as never)

    expect(await ui.find({ type: 'Text', text: /is not a git repository/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^session folder · 3 repos inside$/ })).toBeDefined()
    expect(await ui.find({ key: 'open-D:/Betmate/core' })).toBeDefined()
    expect(await ui.find({ key: 'open-D:/Betmate/stack' })).toBeDefined()
    expect(await ui.find({ key: 'open-D:/Betmate/docs' })).toBeUndefined()
    // Behind and ahead: the band, with Pull and Push run in that repo.
    expect(await ui.find({ type: 'Text', text: /^core · ↓4 on origin\/develop$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^games · ↑2 not pushed$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^3 changed · 1 staged · last commit 3h ago$/ })).toBeDefined()
    await ui.press({ key: 'look-pull-D:/Betmate/core' })
    expect(runs).toContain('D:/Betmate/core: pull --ff-only')

    // Claude edits in games: its card says so.
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: 'D:\\Betmate\\games\\src\\ui.ts', old_string: 'a', new_string: 'b' } as never)
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /^chat 1$/ })).toBeDefined()

    await ui.press({ key: 'open-D:/Betmate/core' })
    expect(await ui.find({ key: 'all-repos' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^⎇ develop$/ })).toBeDefined()
    expect(runs.some(r => r.startsWith('D:/Betmate/core: log --topo-order'))).toBe(true)
    await ui.press({ key: 'repos' })
    expect(await ui.find({ key: 'pick-D:/Betmate/games' })).toBeDefined()

    await ui.press({ key: 'all-repos' })
    expect(await ui.find({ key: 'open-D:/Betmate/games' })).toBeDefined()
    expect(await ui.find({ key: 'all-repos' })).toBeUndefined()
  })
}
