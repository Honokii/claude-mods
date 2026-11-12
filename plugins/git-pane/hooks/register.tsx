import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Commit, FileRow, RepoRow, RepoSummary, Snapshot } from '../types'
import {
  LOG_FORMAT,
  ago,
  clip,
  clipStart,
  counts,
  graphWidth,
  isInside,
  laneColor,
  layoutGraph,
  parseLog,
  parseShortstat,
  parseStatus,
  parseWorktrees,
  rowGlyphs,
  rowSvg,
  samePath,
  slash,
  withCounts,
} from './git'

// The Git pane: the repo's history as a branch graph, and its changes: this
// chat's edits, staged, unstaged and untracked files, and the branch against
// main. Stage, unstage, discard, delete untracked, switch branch, fetch, pull and
// push run git directly; the ones that lose work ask first, in the pane.

const PANE = 'git-pane'
const TITLE = 'Git'
const ACCENT = '#d85a30'
const OK = '#5fbf8f'
const WARN = '#d9a33f'
const DANGER = '#e24b4a'
const ADDED = '#639922'
const REMOVED = '#e24b4a'
const RESCAN_MS = 15_000
const PAGE = 20
const STORE_REPOS = 'repos'

const snap = atom({ plugin: 'git-pane', key: 'snap' } as const, null as Snapshot | null, { shape: 'snap-1' })
const repo = atom({ plugin: 'git-pane', key: 'repo' } as const, '')
const repos = atom({ plugin: 'git-pane', key: 'repos' } as const, [] as RepoRow[], { shape: 'repos-1' })
const isMulti = atom({ plugin: 'git-pane', key: 'isMulti' } as const, false)
const overview = atom({ plugin: 'git-pane', key: 'overview' } as const, [] as RepoSummary[], { shape: 'overview-1' })
const edits = atom({ plugin: 'git-pane', key: 'edits' } as const, [] as string[], { shape: 'edits-1' })
const busy = atom({ plugin: 'git-pane', key: 'busy' } as const, '')
const note = atom({ plugin: 'git-pane', key: 'note' } as const, '')
const confirm = atom({ plugin: 'git-pane', key: 'confirm' } as const, '')
const open = atom({ plugin: 'git-pane', key: 'open' } as const, '')
const limit = atom({ plugin: 'git-pane', key: 'limit' } as const, PAGE)
const showRepos = atom({ plugin: 'git-pane', key: 'showRepos' } as const, false)
const showBranches = atom({ plugin: 'git-pane', key: 'showBranches' } as const, false)

// Module variables start over on a reload; what the pane shows lives in $.state.
let isScanning = false
let isAgain = false

// ---------- git ----------

// No prompts for credentials (nobody could answer), no optional locks while
// only looking.
const ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }

export async function git($: EngineInterface, cwd: string, args: string[], timeoutMs = 30_000) {
  return $.process.run(['git', ...args], { cwd, env: ENV, timeoutMs })
}

const lastLine = (s: string) => s.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''

async function gitOut($: EngineInterface, cwd: string, args: string[]) {
  try {
    const out = await git($, cwd, args)
    return out.exitCode === 0 ? out.stdout : ''
  } catch {
    return ''
  }
}

async function topOf($: EngineInterface, dir: string) {
  return slash((await gitOut($, dir, ['rev-parse', '--show-toplevel'])).trim())
}

const EMPTY: Snapshot = {
  root: '',
  branch: '',
  upstream: '',
  ahead: 0,
  behind: 0,
  files: [],
  base: '',
  baseAhead: 0,
  baseBehind: 0,
  baseCommits: [],
  baseFiles: 0,
  baseAdded: 0,
  baseRemoved: 0,
  commits: [],
  total: 0,
  branches: [],
  error: '',
}

export async function scanRepo($: EngineInterface, dir: string, count: number): Promise<Snapshot> {
  const root = await topOf($, dir)
  if (!root) return { ...EMPTY, error: `${dir || 'This folder'} is not a git repository.` }
  const [status, staged, unstaged, log, total, refs] = await Promise.all([
    gitOut($, root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
    gitOut($, root, ['diff', '--cached', '--numstat', '-z']),
    gitOut($, root, ['diff', '--numstat', '-z']),
    gitOut($, root, ['log', '--topo-order', `-n${count}`, LOG_FORMAT, 'HEAD']),
    gitOut($, root, ['rev-list', '--count', 'HEAD']),
    gitOut($, root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
  ])
  const st = parseStatus(status)
  const branches = refs.split(/\r?\n/).map(x => x.trim()).filter(Boolean)
  const snapshot: Snapshot = {
    ...EMPTY,
    root,
    branch: st.branch,
    upstream: st.upstream,
    ahead: st.ahead,
    behind: st.behind,
    files: withCounts(st.files, staged, unstaged),
    commits: parseLog(log),
    total: Number(total.trim()) || 0,
    branches,
  }
  // The branch against main (or master), when another branch is checked out.
  const base = ['main', 'master'].find(b => branches.includes(b)) ?? ''
  if (base && st.branch && st.branch !== base) {
    const [lr, ahead, stat] = await Promise.all([
      gitOut($, root, ['rev-list', '--left-right', '--count', `${base}...HEAD`]),
      gitOut($, root, ['log', '-n10', LOG_FORMAT, `${base}..HEAD`]),
      gitOut($, root, ['diff', '--shortstat', `${base}...HEAD`]),
    ])
    const [behind = 0, aheadN = 0] = lr.trim().split(/\s+/).map(Number)
    const s = parseShortstat(stat)
    Object.assign(snapshot, {
      base,
      baseAhead: aheadN,
      baseBehind: behind,
      baseCommits: parseLog(ahead),
      baseFiles: s.files,
      baseAdded: s.added,
      baseRemoved: s.removed,
    })
  }
  return snapshot
}

// ---------- the repos the switcher lists ----------

async function addedRepos($: EngineInterface): Promise<string[]> {
  const v = await $.store.get(STORE_REPOS)
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

// Repos one level down in a folder that is no repo itself: each subfolder with a
// .git (a folder, or a file in a worktree or submodule).
async function reposInside($: EngineInterface, dir: string): Promise<string[]> {
  try {
    const found: string[] = []
    for (const x of await $.fs.list(dir)) {
      if (x.name.startsWith('.') || x.name === 'node_modules' || !(x.kind === 'dir' || x.isLink)) continue
      const sub = `${dir}/${x.name}`
      if (await $.fs.exists(`${sub}/.git`)) found.push(sub)
    }
    return found.sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

async function listRepos($: EngineInterface): Promise<RepoRow[]> {
  const rows: RepoRow[] = []
  const has = (p: string) => rows.some(r => samePath(r.path, p))
  const cwd = slash(await $.session.cwd())
  const session = await topOf($, cwd)
  if (session) {
    rows.push({ path: session, kind: 'session', isMissing: false })
    for (const w of parseWorktrees(await gitOut($, session, ['worktree', 'list', '--porcelain']))) {
      if (!has(w)) rows.push({ path: w, kind: 'worktree', isMissing: false })
    }
  } else {
    for (const sub of await reposInside($, cwd)) {
      const top = await topOf($, sub)
      if (top && !has(top)) rows.push({ path: top, kind: 'inside', isMissing: false })
    }
  }
  for (const a of await addedRepos($)) {
    if (has(a)) continue
    const top = await topOf($, a)
    rows.push({ path: a, kind: 'added', isMissing: !top })
  }
  return rows
}

// ---------- scanning ----------

async function currentRepo($: EngineInterface) {
  const chosen = await read($, repo)
  if (chosen) return chosen
  return slash(await $.session.cwd())
}

const sig = (v: unknown) => JSON.stringify(v)

// One repo's card: its branch, changes and newest commit, from two quick reads.
export async function summarize($: EngineInterface, path: string): Promise<RepoSummary> {
  const [status, last] = await Promise.all([
    gitOut($, path, ['status', '--porcelain=v2', '--branch', '-z']),
    gitOut($, path, ['log', '-1', '--format=%aI']),
  ])
  if (!status) return { path, branch: '', upstream: '', ahead: 0, behind: 0, changed: 0, staged: 0, last: '', error: 'Could not read this repo.' }
  const st = parseStatus(status)
  return {
    path,
    branch: st.branch,
    upstream: st.upstream,
    ahead: st.ahead,
    behind: st.behind,
    changed: new Set(st.files.map(f => f.path)).size,
    staged: new Set(st.files.filter(f => f.where === 'staged').map(f => f.path)).size,
    last: last.trim(),
    error: '',
  }
}

export async function rescan($: EngineInterface) {
  if (isScanning) {
    isAgain = true
    return
  }
  isScanning = true
  try {
    do {
      isAgain = false
      const list = await listRepos($)
      if (sig(list) !== sig(await read($, repos))) await update($, repos, () => list)
      const multi = !list.some(r => r.kind === 'session') && list.length > 0
      if (multi !== (await read($, isMulti))) await update($, isMulti, () => multi)
      if (multi && !(await read($, repo))) {
        // The overview: every listed repo, read side by side.
        const cards = await Promise.all(list.filter(r => !r.isMissing).map(r => summarize($, r.path)))
        if (sig(cards) !== sig(await read($, overview))) await update($, overview, () => cards)
        continue
      }
      const next = await scanRepo($, await currentRepo($), await read($, limit))
      if (sig(next) !== sig(await read($, snap))) await update($, snap, () => next)
    } while (isAgain)
  } catch (err) {
    await update($, note, () => `!Could not read the repo: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    isScanning = false
  }
}

async function isPaneOpen($: EngineInterface) {
  try {
    return (await $.ui.panes()).some(p => p.id === PANE)
  } catch {
    return false
  }
}

// ---------- actions ----------

// Runs git in the open repo, or in `root` when given (the overview's Pull and Push).
async function run($: EngineInterface, id: string, args: string[], done: string, timeoutMs = 30_000, root = '') {
  const where = root || (await read($, snap))?.root || ''
  if (!where || (await read($, busy))) return
  await update($, busy, () => id)
  await update($, note, () => '')
  try {
    const out = await git($, where, args, timeoutMs)
    if (out.exitCode !== 0) throw new Error(lastLine(out.stderr) || lastLine(out.stdout) || `exit ${out.exitCode}`)
    if (done) await update($, note, () => done)
  } catch (err) {
    await update($, note, () => `!git ${args[0]}: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await update($, busy, () => '')
    await rescan($)
  }
}

const stage = ($: EngineInterface, f: FileRow) => run($, `stage:${f.path}`, ['add', '--', f.path], '')
const unstage = ($: EngineInterface, f: FileRow) => run($, `unstage:${f.path}`, ['restore', '--staged', '--', f.path], '')
const stageAll = ($: EngineInterface) => run($, 'stage-all', ['add', '-A'], '')
const unstageAll = ($: EngineInterface) => run($, 'unstage-all', ['reset', '-q'], '')
const fetch = ($: EngineInterface) => run($, 'fetch', ['fetch', '--prune'], 'Fetched.', 120_000)
const pull = ($: EngineInterface) => run($, 'pull', ['pull', '--ff-only'], 'Pulled.', 120_000)
const push = ($: EngineInterface) => run($, 'push', ['push'], 'Pushed.', 120_000)

// What a confirmed action runs.
async function confirmed($: EngineInterface) {
  const what = await read($, confirm)
  await update($, confirm, () => '')
  const s = await read($, snap)
  if (!s) return
  const i = what.indexOf(':')
  const kind = what.slice(0, i)
  const arg = what.slice(i + 1)
  if (kind === 'discard' && s.files.some(f => f.where === 'unstaged' && f.path === arg)) {
    await run($, what, ['restore', '--', arg], `Discarded changes to ${arg}.`)
  } else if (kind === 'delete' && s.files.some(f => f.where === 'untracked' && f.path === arg)) {
    await run($, what, ['clean', '-f', '--', arg], `Deleted ${arg}.`)
  } else if (kind === 'switch' && s.branches.includes(arg)) {
    await update($, showBranches, () => false)
    await run($, what, ['switch', arg], `Switched to ${arg}.`)
  }
}

async function switchTo($: EngineInterface, branch: string) {
  const s = await read($, snap)
  if (!s?.branches.includes(branch)) return
  // Uncommitted changes go along with the switch, or stop it: ask first.
  if (s.files.some(f => f.where !== 'untracked')) await update($, confirm, () => `switch:${branch}`)
  else {
    await update($, confirm, () => `switch:${branch}`)
    await confirmed($)
  }
}

async function chooseRepo($: EngineInterface, path: string) {
  const list = await read($, repos)
  const session = list.find(r => r.kind === 'session')
  // '' is the session folder's repo, or the overview when that folder holds several.
  await update($, repo, () => (path && session && samePath(session.path, path) ? '' : path))
  await update($, snap, () => null)
  await update($, showRepos, () => false)
  await update($, confirm, () => '')
  await update($, open, () => '')
  await update($, limit, () => PAGE)
  await rescan($)
}

async function removeRepo($: EngineInterface, path: string) {
  const added = await addedRepos($)
  const kept = added.filter(a => !samePath(a, path))
  if (kept.length === added.length) return false
  await $.store.set(STORE_REPOS, kept)
  if (samePath(await read($, repo), path)) await update($, repo, () => '')
  await rescan($)
  return true
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: TITLE })
  await rescan($)
}

// /git, /git add <path>, /git remove <path>
async function command($: EngineInterface, args: string): Promise<string> {
  const m = /^\s*(add|remove)\s+(.+?)\s*$/i.exec(args)
  if (!m) {
    if (args.trim()) return 'Use /git, /git add <path> or /git remove <path>.'
    await openPane($)
    return 'Opened the Git pane.'
  }
  const path = slash(m[2]!.replace(/^["']|["']$/g, ''))
  if (m[1]!.toLowerCase() === 'remove') {
    return (await removeRepo($, path)) ? `Removed ${path} from the Git pane.` : `${path} was not added.`
  }
  const top = await topOf($, path)
  if (!top) return `${path} is not a git repository.`
  const added = await addedRepos($)
  if (!added.some(a => samePath(a, top))) await $.store.set(STORE_REPOS, [...added, top])
  await rescan($)
  return `Added ${top} to the Git pane.`
}

// ---------- this chat's edits ----------

async function noteEdit($: EngineInterface, path: unknown) {
  if (typeof path !== 'string' || !path) return
  try {
    const file = slash(path)
    const list = await read($, edits)
    if (!list.some(x => samePath(x, file))) await update($, edits, cur => [...cur, file])
    if (await isPaneOpen($)) void rescan($)
  } catch {
    // The pane misses one edit; the tool call is not affected.
  }
}

// ---------- drawing ----------

const STATUS_COLORS: Record<string, string> = { M: WARN, A: ADDED, D: REMOVED, R: '#378add', C: '#378add', T: WARN, U: DANGER }
const ON_BANNER = '#ffffff'
const ATTENTION_BANNER = '#ba7517'
const SECTION_BANNER = '#5f5e5a'
const ROW_PX = 40
const LINE_PX = 18
const BODY_LINES = 12

const short = (h: string) => h.slice(0, 7)
const base = (p: string) => p.split('/').pop() ?? p
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'git', description: 'Open the Git pane: history graph and changes. /git add <path> adds a repo.', immediate: true })
    $.clock.every(RESCAN_MS, () => {
      void (async () => {
        if (await isPaneOpen($)) await rescan($)
      })()
    })
    return next(e)
  })

  on('command.run', { command: 'git' }, async ($, e) => ({ text: await command($, e.args) }))

  // Files Claude changes in this chat. Only watched: the call goes on as it would,
  // and a failure here never stops it.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) await noteEdit($, e.file_path)
    return ran
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) await noteEdit($, e.file_path)
    return ran
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) await noteEdit($, e.notebook_path)
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const cols = Math.max(30, e.props.bodyColumns)
    const s = await read($, snap)
    const repoList = await read($, repos)
    const chatEdits = await read($, edits)
    const running = await read($, busy)
    const msg = await read($, note)
    const asking = await read($, confirm)
    const opened = await read($, open)
    const shown = await read($, limit)
    const withRepos = await read($, showRepos)
    const withBranches = await read($, showBranches)
    const now = await $.clock.now()
    const multi = await read($, isMulti)
    const chosen = await read($, repo)
    const cards = await read($, overview)
    const isOverview = multi && !chosen
    if (isOverview ? !cards.length : !s) void rescan($)

    const btn = (key: string, label: string, onPress: () => unknown, dim?: boolean) =>
      Svg ? (
        <Button key={key} label={label} dimColor={dim || undefined} onPress={() => void onPress()} />
      ) : (
        <Button key={key} plain label={label} dimColor={dim || undefined} onPress={() => void onPress()} />
      )

    const tile = (key: string, label: string, value: string, color?: string) => (
      <Box key={key} flexDirection="column" flexGrow={1} borderStyle="round" borderColor={color} paddingX={1}>
        <Text dimColor>{label}</Text>
        {color ? (
          <Text bold color={color}>
            {value}
          </Text>
        ) : (
          <Text bold>{value}</Text>
        )}
      </Box>
    )

    const banner = (key: string, color: string, label: string, extra?: RenderChildren) => (
      <Box key={key} flexDirection="row" marginTop={1} backgroundColor={color} paddingX={1} alignItems="center" justifyContent="space-between">
        <Text bold color={ON_BANNER}>
          {label}
        </Text>
        {extra}
      </Box>
    )

    const header = (
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        {multi && chosen ? (
          btn('all-repos', '← All repos', () => chooseRepo($, ''))
        ) : (
          <Text bold color={ACCENT}>
            {TITLE}
          </Text>
        )}
        {running ? <Text color={WARN}>{clip(`${running.split(':')[0]}…`, 14)}</Text> : btn('refresh', '↻ Refresh', () => rescan($), true)}
      </Box>
    )

    // ----- the overview: a folder holding several repos -----

    if (isOverview) {
      const editsIn = (path: string) => chatEdits.filter(x => isInside(x, path)).length
      const needsLook = (c: RepoSummary) => Boolean(c.upstream && (c.ahead || c.behind))
      const sorted = [...cards].sort(
        (a, b) =>
          Number(needsLook(b)) - Number(needsLook(a)) ||
          Number(editsIn(b.path) > 0) - Number(editsIn(a.path) > 0) ||
          base(a.path).localeCompare(base(b.path)),
      )
      const looks = sorted.filter(needsLook)
      const totalChanged = cards.reduce((n, c) => n + c.changed, 0)
      const missing = repoList.filter(r => r.isMissing)
      const folder = slash(await $.session.cwd())
      const inside = repoList.filter(r => r.kind === 'inside').length

      const lookRow = (c: RepoSummary) => {
        const what = [c.behind ? `↓${c.behind} on ${c.upstream}` : '', c.ahead ? `↑${c.ahead} not pushed` : ''].filter(Boolean).join(' · ')
        return (
          <Box key={`look-${c.path}`} flexDirection="row" gap={1} marginTop={1} paddingX={1} alignItems="center">
            <Box flexGrow={1}>
              <Text color={WARN} wrap="truncate-end">
                {clip(`${base(c.path)} · ${what}`, cols - 12)}
              </Text>
            </Box>
            {running === `pull:${c.path}` || running === `push:${c.path}` ? (
              <Text color={WARN}>…</Text>
            ) : c.behind ? (
              btn(`look-pull-${c.path}`, 'Pull', () => run($, `pull:${c.path}`, ['pull', '--ff-only'], `Pulled ${base(c.path)}.`, 120_000, c.path))
            ) : (
              btn(`look-push-${c.path}`, 'Push', () => run($, `push:${c.path}`, ['push'], `Pushed ${base(c.path)}.`, 120_000, c.path))
            )}
          </Box>
        )
      }

      const card = (c: RepoSummary) => {
        const n = editsIn(c.path)
        const ab = [c.ahead ? `↑${c.ahead}` : '', c.behind ? `↓${c.behind}` : ''].filter(Boolean).join(' ')
        const room = Math.max(10, cols - 4 - 9 - (n ? 8 : 0) - (ab ? ab.length + 1 : 0))
        const where = c.branch ? `⎇ ${c.branch}${c.upstream ? ` → ${c.upstream}` : ' · no upstream'}` : '⎇ detached HEAD'
        const state = c.error
          ? c.error
          : [c.changed ? `${c.changed} changed` : 'clean', c.staged ? `${c.staged} staged` : '', c.last ? `last commit ${ago(c.last, now)}` : 'no commits'].filter(Boolean).join(' · ')
        return (
          <Box key={`card-${c.path}`} flexDirection="column" marginTop={1} borderStyle="round" borderColor={needsLook(c) ? WARN : undefined} borderDimColor={needsLook(c) ? undefined : true} paddingX={1}>
            <Box flexDirection="row" gap={1} alignItems="center">
              <Box flexGrow={1}>
                <Text bold wrap="truncate-end">
                  {clip(base(c.path), room)}
                </Text>
              </Box>
              {n ? <Text color="#7f77dd">{`chat ${n}`}</Text> : null}
              {ab ? <Text color={WARN}>{ab}</Text> : null}
              {btn(`open-${c.path}`, 'Open', () => chooseRepo($, c.path))}
            </Box>
            <Text dimColor wrap="truncate-end">
              {clip(where, cols - 4)}
            </Text>
            {c.changed && !c.error ? (
              <Text color={WARN} wrap="truncate-end">
                {clip(state, cols - 4)}
              </Text>
            ) : (
              <Text dimColor={!c.error || undefined} color={c.error ? DANGER : undefined} wrap="truncate-end">
                {clip(state, cols - 4)}
              </Text>
            )}
          </Box>
        )
      }

      return (
        <Box flexDirection="column" width={cols}>
          {header}
          <Box flexDirection="column" marginTop={1} borderStyle="round" borderDimColor paddingX={1}>
            <Text bold wrap="truncate-end">
              {clip(base(folder) || folder, cols - 4)}
            </Text>
            <Text dimColor wrap="truncate-end">
              {clip(`session folder · ${inside ? plural(inside, 'repo') : 'no repos'} inside`, cols - 4)}
            </Text>
          </Box>
          <Box flexDirection="row" gap={1} marginTop={1}>
            {tile('t-repos', 'Repos', String(cards.length))}
            {tile('t-changed', 'Changed', String(totalChanged), totalChanged ? WARN : undefined)}
            {tile('t-look', 'Need a look', String(looks.length), looks.length ? WARN : undefined)}
          </Box>
          {looks.length ? (
            <Box flexDirection="column">
              {banner('h-attention', ATTENTION_BANNER, 'Needs a look')}
              {looks.map(lookRow)}
            </Box>
          ) : null}
          {banner('h-repos', SECTION_BANNER, 'Repos', <Text color={ON_BANNER}>{String(cards.length)}</Text>)}
          {cards.length ? sorted.map(card) : <Text dimColor>Reading the repos…</Text>}
          {missing.map(r => (
            <Box key={`gone-${r.path}`} flexDirection="row" gap={1} marginTop={1} paddingX={1} alignItems="center">
              <Box flexGrow={1}>
                <Text dimColor wrap="truncate-end">
                  {clipStart(`${r.path} · not found`, cols - 12)}
                </Text>
              </Box>
              {btn(`rm-${r.path}`, 'Remove', () => removeRepo($, r.path))}
            </Box>
          ))}
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              Open a repo for its full view: fetch, stage, history and the rest live there.
            </Text>
          </Box>
          {msg ? (
            <Box marginTop={1}>
              <Text color={msg.startsWith('!') ? DANGER : OK} wrap="wrap">
                {msg.replace(/^!/, '')}
              </Text>
            </Box>
          ) : null}
        </Box>
      )
    }

    if (!s) {
      return (
        <Box flexDirection="column" width={cols}>
          {header}
          <Text dimColor>Reading the repo…</Text>
        </Box>
      )
    }

    // ----- the repo and the branch -----

    const kindLabel = (r: RepoRow) =>
      r.kind === 'session' ? 'session folder' : r.kind === 'worktree' ? 'worktree' : r.kind === 'inside' ? 'in the session folder' : 'added'
    const current = repoList.find(r => samePath(r.path, s.root)) ?? repoList[0]
    const repoCard = (
      <Box key="repo" flexDirection="column" marginTop={1} borderStyle="round" borderDimColor paddingX={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Box flexDirection="column" flexGrow={1}>
            <Text bold wrap="truncate-end">
              {clip(base(s.root || current?.path || 'No repo'), cols - 16)}
            </Text>
            <Text dimColor wrap="truncate-end">
              {clip(current ? kindLabel(current) : 'not in the list', cols - 16)}
            </Text>
          </Box>
          {repoList.length > 1 || withRepos ? btn('repos', withRepos ? '▾ Repos' : '▸ Repos', () => update($, showRepos, v => !v)) : null}
        </Box>
        {withRepos
          ? repoList.map(r => {
              const isHere = samePath(r.path, s.root)
              const room = Math.max(10, cols - 14)
              return (
                <Box key={`repo-${r.path}`} flexDirection="row" gap={1} marginTop={1} alignItems="center">
                  <Box flexDirection="column" flexGrow={1}>
                    <Text bold={isHere || undefined} dimColor={r.isMissing || undefined} wrap="truncate-end">
                      {clipStart(r.path, room)}
                    </Text>
                    <Text dimColor wrap="truncate-end">
                      {clip(r.isMissing ? `${kindLabel(r)} · not found` : kindLabel(r), room)}
                    </Text>
                  </Box>
                  {r.isMissing
                    ? btn(`rm-${r.path}`, 'Remove', () => removeRepo($, r.path))
                    : isHere
                      ? <Text color={OK}>●</Text>
                      : btn(`pick-${r.path}`, 'Open', () => chooseRepo($, r.path))}
                </Box>
              )
            })
          : null}
        {withRepos ? (
          <Text dimColor wrap="wrap">
            /git add &lt;path&gt; adds a repo; /git remove &lt;path&gt; takes it off.
          </Text>
        ) : null}
      </Box>
    )

    if (s.error) {
      return (
        <Box flexDirection="column" width={cols}>
          {header}
          {repoCard}
          <Text color={DANGER} wrap="wrap">
            {s.error}
          </Text>
        </Box>
      )
    }

    const others = s.branches.filter(b => b !== s.branch)
    const branchCard = (
      <Box key="branch" flexDirection="column" marginTop={1} borderStyle="round" borderDimColor paddingX={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Box flexDirection="column" flexGrow={1}>
            <Text bold wrap="truncate-end">
              {clip(s.branch ? `⎇ ${s.branch}` : '⎇ detached HEAD', cols - 16)}
            </Text>
            <Text dimColor wrap="truncate-end">
              {clip(s.upstream ? `→ ${s.upstream}` : 'no upstream', cols - 16)}
            </Text>
          </Box>
          {others.length ? btn('branches', withBranches ? '▾ Switch' : '▸ Switch', () => update($, showBranches, v => !v)) : null}
        </Box>
        {withBranches
          ? others.map(b => (
              <Box key={`br-${b}`} flexDirection="row" gap={1} marginTop={1} alignItems="center">
                <Box flexGrow={1}>
                  <Text wrap="truncate-end">{clip(b, cols - 14)}</Text>
                </Box>
                {btn(`sw-${b}`, 'Switch', () => switchTo($, b))}
              </Box>
            ))
          : null}
      </Box>
    )

    // ----- tiles, band, sync -----

    const changed = new Set(s.files.map(f => f.path)).size
    const stagedN = s.files.filter(f => f.where === 'staged').length
    const tiles = (
      <Box flexDirection="row" gap={1} marginTop={1}>
        {tile('t-changed', 'Changed', String(changed), changed ? WARN : undefined)}
        {tile('t-staged', 'Staged', String(stagedN))}
        {tile('t-ahead', 'Ahead', `↑${s.ahead}`)}
        {tile('t-behind', 'Behind', `↓${s.behind}`, s.behind ? ACCENT : undefined)}
      </Box>
    )

    const attention: RenderChildren[] = []
    if (s.upstream && s.behind)
      attention.push(
        <Box key="att-behind" flexDirection="row" gap={1} marginTop={1} paddingX={1} alignItems="center">
          <Box flexGrow={1}>
            <Text color={WARN} wrap="truncate-end">
              {clip(`${plural(s.behind, 'commit')} on ${s.upstream} you don't have`, cols - 12)}
            </Text>
          </Box>
          {btn('att-pull', 'Pull', () => pull($))}
        </Box>,
      )
    if (s.upstream && s.ahead)
      attention.push(
        <Box key="att-ahead" flexDirection="row" gap={1} marginTop={1} paddingX={1} alignItems="center">
          <Box flexGrow={1}>
            <Text color={WARN} wrap="truncate-end">
              {clip(`${plural(s.ahead, 'commit')} not pushed`, cols - 12)}
            </Text>
          </Box>
          {btn('att-push', 'Push', () => push($))}
        </Box>,
      )

    const sync = (
      <Box flexDirection="row" gap={1} marginTop={1}>
        {btn('fetch', '⇣ Fetch', () => fetch($))}
        {btn('pull', '↓ Pull', () => pull($))}
        {btn('push', '↑ Push', () => push($))}
      </Box>
    )

    // ----- the confirm box -----

    const ask = (() => {
      if (!asking) return null
      const i = asking.indexOf(':')
      const kind = asking.slice(0, i)
      const arg = asking.slice(i + 1)
      const f = s.files.find(x => x.path === arg && (kind === 'discard' ? x.where === 'unstaged' : x.where === 'untracked'))
      const [title, why, yes] =
        kind === 'discard'
          ? [`Discard changes to ${base(arg)}?`, `${f && f.added >= 0 ? `${plural(f.added, 'added line')} and ${plural(f.removed, 'removed line')}` : 'Its unstaged changes'} go back to what is staged or committed. This can't be undone.`, 'Discard']
          : kind === 'delete'
            ? [`Delete ${base(arg)}?`, 'It is untracked, so git has no copy. This can\'t be undone.', 'Delete']
            : [`Switch to ${arg}?`, 'You have uncommitted changes. Git carries them over, or stops if they clash with that branch.', 'Switch']
      return (
        <Box key="confirm" flexDirection="column" marginTop={1} borderStyle="round" borderColor={DANGER} paddingX={1}>
          <Text bold color={DANGER} wrap="wrap">
            {title}
          </Text>
          <Text wrap="wrap">{why}</Text>
          <Box flexDirection="row" gap={1} marginTop={1}>
            {btn('confirm-yes', yes, () => confirmed($))}
            {btn('confirm-no', 'Keep', () => update($, confirm, () => ''))}
          </Box>
        </Box>
      )
    })()

    // ----- files -----

    const edited = new Set(chatEdits.filter(x => isInside(x, s.root)).map(x => slash(x).slice(s.root.length + 1).toLowerCase()))
    const isEdited = (p: string) => edited.has(p.toLowerCase())

    const fileRow = (f: FileRow, buttons: RenderChildren[], prefix = '') => {
      const n = counts(f)
      const tag = isEdited(f.path) && prefix !== 'chat' ? ' chat' : ''
      const room = Math.max(8, cols - 4 - 2 - n.length - 1 - tag.length - buttons.length * (Svg ? 5 : 3))
      const name = f.from ? `${f.from} → ${f.path}` : f.path
      return (
        <Box key={`${prefix}-${f.where}-${f.path}`} flexDirection="row" gap={1} alignItems="center">
          <Text bold color={STATUS_COLORS[f.status]} dimColor={f.status === '?' || undefined}>
            {f.status}
          </Text>
          <Box flexGrow={1}>
            <Text wrap="truncate-end">{clipStart(name, room)}</Text>
          </Box>
          {tag ? <Text color="#7f77dd">chat</Text> : null}
          {n ? <Text dimColor>{n}</Text> : null}
          {buttons}
        </Box>
      )
    }

    const isBusy = (id: string) => running === id
    const section = (key: string, label: string, rows: RenderChildren[], extra?: RenderChildren) => (
      <Box key={key} flexDirection="column">
        {banner(`h-${key}`, SECTION_BANNER, label, extra)}
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          {rows}
        </Box>
      </Box>
    )

    const conflicts = s.files.filter(f => f.where === 'conflict')
    const staged = s.files.filter(f => f.where === 'staged')
    const unstaged = s.files.filter(f => f.where === 'unstaged')
    const untracked = s.files.filter(f => f.where === 'untracked')

    // This chat's edits: each file Claude changed here, with what git sees of it now.
    const chatRows = [...edited].map(rel => {
      const mine = s.files.filter(f => f.path.toLowerCase() === rel)
      const shown = mine.find(f => f.where === 'unstaged') ?? mine[0]
      const original = chatEdits.find(x => slash(x).slice(s.root.length + 1).toLowerCase() === rel) ?? rel
      const path = slash(original).slice(s.root.length + 1)
      if (shown) return fileRow({ ...shown, path }, [], 'chat')
      return (
        <Box key={`chat-clean-${rel}`} flexDirection="row" gap={1}>
          <Text dimColor>·</Text>
          <Box flexGrow={1}>
            <Text dimColor wrap="truncate-end">
              {clipStart(path, cols - 22)}
            </Text>
          </Box>
          <Text dimColor>no changes now</Text>
        </Box>
      )
    })

    const changes: RenderChildren[] = []
    if (chatRows.length) changes.push(section('chat', `This chat's edits (${chatRows.length})`, chatRows))
    if (conflicts.length)
      changes.push(section('conflicts', `Conflicts (${conflicts.length})`, conflicts.map(f => fileRow(f, [isBusy(`stage:${f.path}`) ? <Text key="b" color={WARN}>…</Text> : btn(`stage-${f.path}`, '+', () => stage($, f))]))))
    if (staged.length)
      changes.push(
        section(
          'staged',
          `Staged (${staged.length})`,
          staged.map(f => fileRow(f, [isBusy(`unstage:${f.path}`) ? <Text key="b" color={WARN}>…</Text> : btn(`unstage-${f.path}`, '−', () => unstage($, f))])),
          btn('unstage-all', 'Unstage all', () => unstageAll($)),
        ),
      )
    if (unstaged.length)
      changes.push(
        section(
          'unstaged',
          `Unstaged (${unstaged.length})`,
          unstaged.map(f =>
            fileRow(f, [
              isBusy(`stage:${f.path}`) ? <Text key="b" color={WARN}>…</Text> : btn(`stage-${f.path}`, '+', () => stage($, f)),
              btn(`discard-${f.path}`, '↶', () => update($, confirm, () => `discard:${f.path}`)),
            ]),
          ),
          btn('stage-all', 'Stage all', () => stageAll($)),
        ),
      )
    if (untracked.length)
      changes.push(
        section(
          'untracked',
          `Untracked (${untracked.length})`,
          untracked.map(f =>
            fileRow(f, [
              isBusy(`stage:${f.path}`) ? <Text key="b" color={WARN}>…</Text> : btn(`stage-${f.path}`, '+', () => stage($, f)),
              btn(`delete-${f.path}`, '✕', () => update($, confirm, () => `delete:${f.path}`)),
            ]),
          ),
        ),
      )
    if (!s.files.length)
      changes.push(
        <Box key="clean" marginTop={1}>
          <Text dimColor>Nothing to commit. The working tree is clean.</Text>
        </Box>,
      )

    // ----- the branch against main -----

    const commitLine = (c: Commit, key: string) => (
      <Box key={key} flexDirection="row" gap={1}>
        <Box flexGrow={1}>
          <Text wrap="truncate-end">{clip(c.subject, cols - 14)}</Text>
        </Box>
        <Text dimColor>{short(c.hash)}</Text>
      </Box>
    )
    const vsBase = s.base
      ? section(
          'base',
          `${clip(s.branch, Math.max(6, cols - 24))} vs ${s.base}`,
          [
            ...s.baseCommits.map(c => commitLine(c, `base-${c.hash}`)),
            ...(s.baseAhead > s.baseCommits.length ? [<Text key="base-more" dimColor>{`and ${s.baseAhead - s.baseCommits.length} more`}</Text>] : []),
            ...(s.baseAhead ? [] : [<Text key="base-none" dimColor>No commits that {s.base} doesn't have.</Text>]),
            <Text key="base-stat" dimColor wrap="wrap">
              {`↑${s.baseAhead} ↓${s.baseBehind}${s.baseFiles ? ` · ${plural(s.baseFiles, 'file')} · +${s.baseAdded} −${s.baseRemoved}` : ''}`}
            </Text>,
          ],
        )
      : null

    // ----- history -----

    const graph = layoutGraph(s.commits)
    const gw = graphWidth(graph)
    const lanes = Math.max(1, ...graph.map(r => r.width))
    const textRoom = Math.max(12, cols - 4 - (Svg ? Math.ceil(gw / 8) + 1 : lanes * 2) - 3)

    const history = s.commits.map((c, i) => {
      const row = graph[i]!
      const isOpen = opened === c.hash && Boolean(c.body)
      const bodyLines = isOpen
        ? c.body
            .split(/\r?\n/)
            .flatMap(l => (l.length <= textRoom ? [l] : (l.match(new RegExp(`.{1,${textRoom}}`, 'g')) ?? [l])))
            .slice(0, BODY_LINES)
        : []
      const height = ROW_PX + bodyLines.length * LINE_PX + (bodyLines.length ? 6 : 0)
      const refs = c.refs.slice(0, 2).join(', ')
      const meta = `${short(c.hash)} · ${c.author} · ${ago(c.date, now)}`
      const lane = laneColor(row.lane)
      const text = (
        <Box flexDirection="column" flexGrow={1}>
          <Box flexDirection="row" gap={1}>
            <Box flexGrow={1}>
              <Text wrap="truncate-end">{clip(c.subject || '(no message)', textRoom - (c.body ? 3 : 0))}</Text>
            </Box>
            {c.body ? btn(`c-${c.hash}`, isOpen ? '▾' : '▸', () => update($, open, v => (v === c.hash ? '' : c.hash)), true) : null}
          </Box>
          <Box flexDirection="row" gap={1}>
            {refs ? (
              <Text color={lane} wrap="truncate-end">
                {clip(refs, Math.max(6, Math.floor(textRoom / 2)))}
              </Text>
            ) : null}
            <Text dimColor wrap="truncate-end">
              {clip(meta, Math.max(6, textRoom - (refs ? Math.min(refs.length, Math.floor(textRoom / 2)) + 1 : 0)))}
            </Text>
          </Box>
          {bodyLines.length ? (
            <Text dimColor wrap="wrap">
              {bodyLines.join('\n')}
            </Text>
          ) : null}
        </Box>
      )
      return Svg ? (
        <Box key={`h-${c.hash}`} flexDirection="row" gap={1} alignItems="flex-start">
          <Svg source={rowSvg(row, gw, height)} alt={i === 0 ? 'Branch graph' : `Graph row for ${short(c.hash)}`} width={gw} height={height} />
          {text}
        </Box>
      ) : (
        <Box key={`h-${c.hash}`} flexDirection="row" gap={1} alignItems="flex-start">
          <Box flexDirection="column">
            <Text color={lane}>{rowGlyphs(row, lanes, true)}</Text>
            <Text dimColor>{rowGlyphs(row, lanes, false)}</Text>
          </Box>
          {text}
        </Box>
      )
    })

    const historyPart = (
      <Box key="history" flexDirection="column">
        {banner('h-history', SECTION_BANNER, 'History', <Text color={ON_BANNER}>{`${s.commits.length} of ${s.total}`}</Text>)}
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          {s.commits.length ? history : <Text dimColor>No commits yet.</Text>}
        </Box>
        {s.total > s.commits.length
          ? (
              <Box flexDirection="row" marginTop={1}>
                {btn('more', `Show ${Math.min(PAGE, s.total - s.commits.length)} more`, async () => {
                  await update($, limit, n => n + PAGE)
                  await rescan($)
                })}
              </Box>
            )
          : null}
      </Box>
    )

    return (
      <Box flexDirection="column" width={cols}>
        {header}
        {repoCard}
        {branchCard}
        {tiles}
        {attention.length ? (
          <Box flexDirection="column">
            {banner('h-attention', ATTENTION_BANNER, 'Needs a look')}
            {attention}
          </Box>
        ) : null}
        {sync}
        {ask}
        {changes}
        {vsBase}
        {historyPart}
        {msg ? (
          <Box marginTop={1}>
            <Text color={msg.startsWith('!') ? DANGER : OK} wrap="wrap">
              {msg.replace(/^!/, '')}
            </Text>
          </Box>
        ) : null}
      </Box>
    )
  })
}
