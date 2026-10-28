import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentDef, Run } from '../types'
import { critterSvg, modelColor } from './critters'

const PANE = 'my-agents'
const TITLE = 'Agents'
const ACCENT = '#e0794f'
const OK = '#5fbf8f'
const FAIL = '#e05f5f'
// What ▶ sends in the person's name. Auto mode lets an agent start only when a
// message of the person's asked for it, so the pane asks rather than spawning.
const askToRun = (name: string): string =>
  `Run the ${name} agent. I started it from the agents panel with no specific task, so brief it to do its usual job on the current project with its defaults, and tell me what it did.`
const MAX_RUNS = 30

const defs = atom({ plugin: 'my-agents', key: 'defs' } as const, [], { shape: 'defs-1' })
const runs = atom({ plugin: 'my-agents', key: 'runs' } as const, [], { shape: 'runs-1' })
// The finished run whose answer is shown; '' for none.
const expanded = atom({ plugin: 'my-agents', key: 'expanded' } as const, '')
const isFinishedCollapsed = atom({ plugin: 'my-agents', key: 'isFinishedCollapsed' } as const, false)
const now = atom({ plugin: 'my-agents', key: 'now' } as const, 0)

// Module variables start over on a reload.
let cancelTick: (() => void) | null = null
// Agent types ▶ asked for, so their spawn is marked as the pane's.
const askedFromPane = new Set<string>()

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

const clock = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// Short model names as the pane shows them.
const modelName = (m: string): string => {
  const known = /(opus|sonnet|haiku|fable)/i.exec(m)?.[1]
  return known ? known.toLowerCase() : m || 'inherit'
}

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

// A few words on what a tool call is doing, from its own arguments.
const toolWords = (e: Record<string, unknown>): string => {
  const str = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  const what = str('description') || str('command') || (str('file_path') && baseName(str('file_path'))) || str('pattern')
  return clip(`${String(e.tool)}${what ? `: ${what}` : ''}`, 60)
}

// The YAML frontmatter of an agent file, read flat: `key: value` lines and
// `- item` lists under a key. Enough for name, description, tools and model.
function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const out: Record<string, string> = {}
  if (!m?.[1]) return out
  let key = ''
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (kv?.[1]) {
      key = kv[1]
      out[key] = (kv[2] ?? '').replace(/^["']|["']$/g, '').trim()
    } else if (key && /^\s+-\s+/.test(line)) {
      const item = line.replace(/^\s+-\s+/, '').trim()
      out[key] = out[key] ? `${out[key]}, ${item}` : item
    } else if (key && /^\s+\S/.test(line)) {
      out[key] = `${out[key]} ${line.trim()}`.trim()
    }
  }
  return out
}

async function readDir($: EngineInterface, dir: string, scope: AgentDef['scope']): Promise<AgentDef[]> {
  if (!(await $.fs.exists(dir))) return []
  const found: AgentDef[] = []
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue
    const file = `${dir}/${entry.name}`
    try {
      const fm = frontmatter(await $.fs.read(file))
      found.push({
        name: fm.name || entry.name.replace(/\.md$/, ''),
        description: fm.description || '',
        tools: fm.tools || 'all tools',
        model: fm.model || 'inherit',
        scope,
        file,
      })
    } catch {
      // An unreadable file is skipped; the others still show.
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

async function reload($: EngineInterface): Promise<void> {
  const home = ((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '').replace(/\\/g, '/')
  const cwd = (await $.session.cwd()).replace(/\\/g, '/')
  const user = home ? await readDir($, `${home}/.claude/agents`, 'user') : []
  // In the home folder itself the two are the same place.
  const project = cwd !== home ? await readDir($, `${cwd}/.claude/agents`, 'project') : []
  await update($, defs, () => [...project, ...user])
}

// Ticks once a second while any run is going, so the timers move.
async function ensureTick($: EngineInterface): Promise<void> {
  const isActive = (await read($, runs)).some(r => r.status === 'running')
  if (isActive && !cancelTick) {
    await update($, now, () => Date.now())
    const timer = $.clock.every(1000, () => {
      void update($, now, () => Date.now())
    })
    cancelTick = () => timer.cancel()
  } else if (!isActive && cancelTick) {
    cancelTick()
    cancelTick = null
  }
}

// Marks runs the engine no longer runs as finished.
async function settle($: EngineInterface, answers: Record<string, string>): Promise<void> {
  const list = await $.agent.list()
  const statusOf = new Map(list.map(a => [a.id, a.status]))
  const t = Date.now()
  await update($, runs, rs =>
    rs.map(r => {
      if (r.status !== 'running') return r
      const s = statusOf.get(r.id)
      const answer = answers[r.id]
      if (s === 'running' || s === 'pending' || s === 'waiting') {
        return answer !== undefined ? { ...r, answer: clip(answer, 400) } : r
      }
      const isFailed = s === 'failed' || s === 'killed'
      const status: Run['status'] = isFailed ? 'failed' : 'done'
      return { ...r, status, endedAt: t, answer: clip(answer ?? r.answer, 400) }
    }),
  )
  await ensureTick($)
}

async function addRun($: EngineInterface, run: Run): Promise<void> {
  await update($, runs, rs => [run, ...rs.filter(r => r.id !== run.id)].slice(0, MAX_RUNS))
  await ensureTick($)
}

const newRun = (id: string, type: string, description: string, model: string, isFromPane: boolean): Run => ({
  id,
  type,
  description: clip(description, 80),
  model,
  startedAt: Date.now(),
  endedAt: null,
  status: 'running',
  tools: 0,
  lastTool: 'starting',
  answer: '',
  isFromPane,
})

async function startAgent($: EngineInterface, def: AgentDef): Promise<void> {
  askedFromPane.add(def.name)
  try {
    await $.prompt.submit({ text: askToRun(def.name), asUser: true })
  } catch (err) {
    askedFromPane.delete(def.name)
    $.ui.toast(`Could not ask for ${def.name}: ${String(err)}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'my-agents',
      description: 'Open or close the agents pane: your agents and the ones running now',
    })
    await settle($, {})
    return result
  })

  on('command.run', { command: 'my-agents' }, async $ => {
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (isOpen) {
      await $.ui.close({ id: PANE })
      return { text: 'Agents pane closed.' }
    }
    await reload($)
    const { isPlaced } = await $.ui.open({ id: PANE, title: TITLE })
    return { text: isPlaced ? 'Agents pane opened.' : 'The agents pane is open but this window is too narrow to show it.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (!result.deny && result.agentId) {
      const isFromPane = askedFromPane.delete(e.subagentType)
      await addRun($, newRun(result.agentId, e.subagentType, e.description, result.model || e.model || e.parentModel, isFromPane))
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const words = toolWords(e as unknown as Record<string, unknown>)
    await update($, runs, rs => rs.map(r => (r.id === e.agentId ? { ...r, tools: r.tools + 1, lastTool: words } : r)))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await settle($, e.agentId !== undefined ? { [e.agentId]: e.answer } : {})
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const list = await read($, defs)
    const all = await read($, runs)
    const open = await read($, expanded)
    const isCollapsed = await read($, isFinishedCollapsed)
    const t = (await read($, now)) || Date.now()

    const running = all.filter(r => r.status === 'running')
    const finished = all.filter(r => r.status !== 'running')
    const totalMs = all.reduce((sum, r) => sum + ((r.endedAt ?? t) - r.startedAt), 0)
    // Long lines are cut to the pane's width here: the desktop lets a row grow
    // past the pane and hides what is beyond its edge, buttons included.
    const room = Math.max(20, (e.props.bodyColumns || 50) - 10)

    const critter = (name: string, model: string, size: number, isRunning: boolean) =>
      Svg ? (
        // The desktop draws an Svg as a still image unless it is interactive:
        // only then do the running critter's CSS animations play.
        <Svg
          source={critterSvg(name, model, size, isRunning)}
          alt={`${name} critter`}
          width={size}
          height={size}
          isInteractive={isRunning || undefined}
        />
      ) : (
        <Text color={modelColor(model)}>{isRunning ? '◉' : '●'}</Text>
      )

    const tile = (key: string, label: string, value: string) => (
      <Box key={key} flexDirection="column" flexGrow={1} borderStyle="round" paddingX={1}>
        <Text dimColor>{label}</Text>
        <Text bold>{value}</Text>
      </Box>
    )

    const section = (key: string, label: string) => (
      <Box key={key} marginTop={1}>
        <Text bold color={ACCENT}>
          {label}
        </Text>
      </Box>
    )

    const runCard = (r: Run) => {
      const isRunning = r.status === 'running'
      const isOpen = open === r.id
      const elapsed = clock((r.endedAt ?? t) - r.startedAt)
      const mark = r.status === 'failed' ? <Text color={FAIL}>✕</Text> : isRunning ? null : <Text color={OK}>✓</Text>
      return (
        <Box key={r.id} flexDirection="row" gap={1} marginTop={1}>
          {critter(r.type, r.model, isRunning ? 40 : 32, isRunning)}
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Box flexDirection="row" gap={1} alignItems="center">
              <Text bold>{r.type}</Text>
              <Text color={modelColor(r.model)}>{modelName(r.model)}</Text>
              {mark}
              <Text dimColor>{elapsed}</Text>
              {r.isFromPane && <Text dimColor>▶ panel</Text>}
            </Box>
            <Text dimColor>
              {clip(`${isRunning ? r.lastTool : `${r.tools} tool call${r.tools === 1 ? '' : 's'}`} · ${r.description}`, room)}
            </Text>
            {!isRunning && r.answer && isOpen && <Text wrap="wrap">{r.answer}</Text>}
            {!isRunning && r.answer && (
              <Button
                key={`answer-${r.id}`}
                label={isOpen ? 'Hide answer' : 'Show answer'}
                plain
                onPress={() => update($, expanded, cur => (cur === r.id ? '' : r.id))}
              />
            )}
          </Box>
        </Box>
      )
    }

    const defRow = (d: AgentDef) => {
      const count = running.filter(r => r.type === d.name).length
      return (
        <Box key={d.file} flexDirection="row" gap={1} marginTop={1} alignItems="center">
          {/* First in the row, so every agent's button lines up. */}
          <Button key={`run-${d.file}`} label="▶" onPress={() => startAgent($, d)} />
          {critter(d.name, d.model, 28, count > 0)}
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Box flexDirection="row" gap={1} alignItems="center">
              <Text bold>{d.name}</Text>
              <Text color={modelColor(d.model)}>{modelName(d.model)}</Text>
              {count > 0 && <Text color={OK}>running{count > 1 ? ` ×${count}` : ''}</Text>}
            </Box>
            <Text dimColor>{clip(d.description || '(no description)', room)}</Text>
          </Box>
        </Box>
      )
    }

    const project = list.filter(d => d.scope === 'project')
    const user = list.filter(d => d.scope === 'user')

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          {tile('t-run', 'Running', String(running.length))}
          {tile('t-done', 'Finished', String(finished.length))}
          {tile('t-time', 'Time', clock(totalMs))}
        </Box>

        {section('h-run', `Running · ${running.length}`)}
        {running.length === 0 && <Text dimColor>Nothing running. Press ▶ beside an agent below.</Text>}
        {running.map(runCard)}

        {finished.length > 0 && (
          <Box flexDirection="row" gap={1} marginTop={1} alignItems="center">
            <Text bold color={ACCENT}>
              Finished · {finished.length}
            </Text>
            <Button
              key="collapse"
              label={isCollapsed ? 'Show' : 'Hide'}
              plain
              onPress={() => update($, isFinishedCollapsed, v => !v)}
            />
            <Button key="clear" label="Clear" plain onPress={() => update($, runs, rs => rs.filter(r => r.status === 'running'))} />
          </Box>
        )}
        {!isCollapsed && finished.map(runCard)}

        <Box flexDirection="row" gap={1} marginTop={1} alignItems="center">
          <Text bold color={ACCENT}>
            My agents · {list.length}
          </Text>
          <Button key="refresh" label="Refresh" plain onPress={() => reload($)} />
        </Box>
        {list.length === 0 && <Text dimColor>No agent files in ~/.claude/agents or this project's .claude/agents.</Text>}
        {project.length > 0 && <Text dimColor>PROJECT · .claude/agents · {project.length}</Text>}
        {project.map(defRow)}
        {user.length > 0 && <Text dimColor>USER · ~/.claude/agents · {user.length}</Text>}
        {user.map(defRow)}
      </Box>
    )
  })
}
