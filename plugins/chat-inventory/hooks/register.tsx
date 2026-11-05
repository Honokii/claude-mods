import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Call, Connector, FileRow, Inventory, SkillRow, Step } from '../types'

const PANE = 'chat-inventory'
const TITLE = 'In this chat'
const ACCENT = '#e0794f'
const INFO = '#4f8fe0'
const OK = '#5fbf8f'
// Rows a section shows before its "Show all".
const FEW = 8
const MAX_CALLS = 50
const NO_PLAN = 'No to-do list yet.'

// The desktop app's own plan tool, and Claude's built-in list tools.
const APP_PLAN = 'mcp__ccd_turn__update_plan'
const APP_WRAP = 'mcp__ccd_turn__wrap_up'
const PLAN_TOOLS = new Set([APP_PLAN, APP_WRAP, 'TodoWrite', 'TaskCreate', 'TaskUpdate'])

const EMPTY: Inventory = { connectors: [], files: [], skills: [] }
const inv = atom({ plugin: 'chat-inventory', key: 'inv' } as const, EMPTY, { shape: 'inv-1' })
const plan = atom({ plugin: 'chat-inventory', key: 'plan' } as const, [] as Step[], { shape: 'plan-1' })
const open = atom({ plugin: 'chat-inventory', key: 'open' } as const, '')
const folded = atom({ plugin: 'chat-inventory', key: 'folded' } as const, [] as string[])
const expanded = atom({ plugin: 'chat-inventory', key: 'expanded' } as const, [] as string[])

// Module variables start over on a reload; the lists live in $.state.
let seq = 0
let isAutoOpened = false
const seen = new Set<string>()
let skillNames: Set<string> | null = null

// ---------- naming ----------

// Servers with a readable name, keyed in lower case.
const NAMED: Record<string, string> = {
  'claude-in-chrome': 'Chrome',
  claude_browser: 'Browser',
  github: 'GitHub',
  gmail: 'Gmail',
  'google-drive': 'Google Drive',
  'google-calendar': 'Google Calendar',
  hubspot: 'HubSpot',
  posthog: 'PostHog',
  'mcp-registry': 'MCP Registry',
  'scheduled-tasks': 'Scheduled tasks',
}

// A claude.ai connector's server is a random id per account, so it is named by its tools.
const BY_TOOL: [RegExp, string][] = [
  [/^(search_threads|get_thread|get_message|(create|get|update|delete|list)_drafts?|(create|update|delete|list)_labels?|(un)?label_(thread|message)|(un)?trash_(thread|message)|(un)?mark_(thread|message)_spam|apply_sensitive_\w+_label|update_message_labels|forward|reply|send_message)$/, 'Gmail'],
  [/^(list_calendars|list_events|get_event|create_event|update_event|delete_event|respond_to_event|suggest_time|search_events)$/, 'Google Calendar'],
  [/^(list_recent_files|search_files|read_file_content|download_file_content|get_file_metadata|get_file_permissions|share_file|trash_file|copy_file|create_file|update_file)$/, 'Google Drive'],
  [/^(get_my_tasks|create_tasks?|update_tasks|search_tasks|get_portfolios?|get_projects?|get_workspace_agents|create_project\w*|get_task\w*)$/, 'Asana'],
  [/^(batch|guide|update|create|delete|export|query|read)$/, 'Claude Docs'],
  [/^notion-/, 'Notion'],
  [/^slack_/, 'Slack'],
  [/^(execute_sql|apply_migration|list_tables|list_migrations)$/, 'Supabase'],
]

const isIdServer = (s: string) => /^[0-9a-f]{8}-[0-9a-f-]+$/i.test(s)

const titleCase = (s: string) =>
  s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(w => w[0]!.toUpperCase() + w.slice(1))
    .join(' ')

// An id server named once by one of its tools keeps that name for its other tools.
const learned = new Map<string, string>()

export function splitTool(tool: string): { server: string; name: string } {
  const [, server = '', ...rest] = tool.split('__')
  return { server, name: rest.join('__') }
}

export function connectorName(server: string, toolName: string): string {
  if (!isIdServer(server)) {
    const bare = server.replace(/^plugin_[^_]+_/, '').replace(/^claude_ai_/i, '') || server
    return NAMED[bare.toLowerCase()] ?? titleCase(bare)
  }
  const hit = BY_TOOL.find(([re]) => re.test(toolName))?.[1]
  if (hit) learned.set(server, hit)
  return hit ?? learned.get(server) ?? 'Connector'
}

// ---------- reading a call ----------

const clip = (s: string, n = 60) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const norm = (p: string) => p.replace(/\\/g, '/')

const ARG_KEYS = ['query', 'q', 'search', 'url', 'file_path', 'path', 'name', 'title', 'subject', 'id', 'threadId', 'messageId', 'fileId', 'prompt', 'command']
const NOT_ARGS = new Set(['tool', 'tool_use_id', 'agentId', 'hook_event_name', 'session_id', 'cwd', 'permission_mode', 'surface'])

export function argOf(input: Record<string, unknown>): string {
  const show = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) return clip(/[\\/]/.test(v) && !/^https?:/.test(v) ? baseName(v) : v)
    if (typeof v === 'number') return String(v)
    return ''
  }
  for (const k of ARG_KEYS) if (show(input[k])) return show(input[k])
  for (const [k, v] of Object.entries(input)) if (!NOT_ARGS.has(k) && show(v)) return show(v)
  return ''
}

// "mcp__x__search_threads" becomes "search threads", minus a leading server word.
const toolWords = (name: string, connector: string) => {
  const words = name.split(/[-_\s]+/).filter(Boolean).map(w => w.toLowerCase())
  const own = new Set(connector.toLowerCase().split(/\s+/))
  while (words.length > 1 && own.has(words[0]!)) words.shift()
  return words.join(' ')
}

type Hit =
  | { kind: 'connector'; server: string; name: string; call: Omit<Call, 'at'> }
  | { kind: 'file'; path: string }
  | { kind: 'skill'; name: string }

const SKILL_FILE = /[\\/]([^\\/]+)[\\/]SKILL\.md$/i
// Claude's own spill and scratch files are not context the person gave it.
const SCRATCH = /[\\/]tool-results[\\/]|[\\/]AppData[\\/]Local[\\/]Temp[\\/]|^\/tmp\/|^\/private\/tmp\//i

export function hitsOf(tool: string, input: Record<string, unknown>): Hit[] {
  if (PLAN_TOOLS.has(tool)) return []
  if (tool.startsWith('mcp__')) {
    const { server, name } = splitTool(tool)
    // The desktop app's own tools (sessions, panes, plan) are not connectors.
    if (!server || server.startsWith('ccd_')) return []
    const connector = connectorName(server, name)
    return [{ kind: 'connector', server, name: connector, call: { tool: toolWords(name, connector), arg: argOf(input) } }]
  }
  if (tool === 'Read' && typeof input.file_path === 'string') {
    const fp = input.file_path
    const skill = SKILL_FILE.exec(fp)?.[1]
    if (skill) return [{ kind: 'skill', name: skill }]
    if (SCRATCH.test(fp)) return []
    return [{ kind: 'file', path: fp }]
  }
  if (tool === 'Skill' && typeof input.skill === 'string' && input.skill) return [{ kind: 'skill', name: input.skill.replace(/^\//, '') }]
  return []
}

// ---------- the lists ----------

type Stamped = { hit: Hit; seq: number; at: number }

export function apply(list: Inventory, hits: Stamped[]): Inventory {
  let { connectors, files, skills } = list
  for (const { hit, seq: n, at } of hits) {
    if (hit.kind === 'connector') {
      const old = connectors.find(c => c.server === hit.server)
      const row: Connector = {
        server: hit.server,
        // An id server may learn its real name after its first call.
        name: hit.name !== 'Connector' ? hit.name : (old?.name ?? hit.name),
        count: (old?.count ?? 0) + 1,
        seq: n,
        calls: [...(old?.calls ?? []), { ...hit.call, at }].slice(-MAX_CALLS),
      }
      connectors = [...connectors.filter(c => c.server !== hit.server), row]
    } else if (hit.kind === 'file') {
      const key = norm(hit.path).toLowerCase()
      const old = files.find(f => norm(f.path).toLowerCase() === key)
      files = [...files.filter(f => f !== old), { path: hit.path, isAuto: old?.isAuto ?? false, seq: n }]
    } else {
      const old = skills.find(s => s.name === hit.name)
      const row: SkillRow = { name: hit.name, count: (old?.count ?? 0) + 1, seq: n }
      skills = [...skills.filter(s => s !== old), row]
    }
  }
  return { connectors, files, skills }
}

// ---------- the to-do list ----------

const STATUSES = new Set(['pending', 'in_progress', 'completed'])
const statusOf = (v: unknown): Step['status'] => (typeof v === 'string' && STATUSES.has(v) ? (v as Step['status']) : 'pending')
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')

function stepsOf(raw: unknown, textKey: string): Step[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(item => {
    const o = (item ?? {}) as Record<string, unknown>
    const text = str(o[textKey])
    return text ? [{ text, status: statusOf(o.status) }] : []
  })
}

// The list after one plan tool call, or null when the call changes nothing.
export function planAfter(cur: Step[], tool: string, input: Record<string, unknown>, result?: unknown): Step[] | null {
  if (tool === 'TodoWrite') return stepsOf(input.todos, 'content')
  if (tool === APP_WRAP) return cur.length ? cur.map(s => ({ ...s, status: 'completed' as const })) : null
  if (tool === APP_PLAN) {
    let steps = Array.isArray(input.items) ? stepsOf(input.items, 'content') : [...cur]
    const set = (i: number, status: Step['status']) => {
      if (steps[i]) steps = steps.map((s, j) => (j === i ? { ...s, status } : s))
    }
    if (input.advance === true) {
      const now = steps.findIndex(s => s.status === 'in_progress')
      if (now >= 0) set(now, 'completed')
      const nextUp = steps.findIndex(s => s.status === 'pending')
      if (nextUp >= 0) set(nextUp, 'in_progress')
    }
    if (Array.isArray(input.done)) for (const n of input.done) if (typeof n === 'number') set(n - 1, 'completed')
    if (typeof input.start === 'number') set(input.start - 1, 'in_progress')
    return steps
  }
  if (tool === 'TaskCreate') {
    const text = str(input.subject)
    if (!text) return null
    const made = str((result as { task?: { id?: unknown } } | undefined)?.task?.id)
    return [...cur, { text, status: 'pending', id: made || String(cur.length + 1) }]
  }
  if (tool === 'TaskUpdate') {
    const id = str(input.taskId)
    let at = cur.findIndex(s => s.id === id)
    if (at < 0 && /^\d+$/.test(id)) at = Number(id) - 1
    const old = cur[at]
    if (!old) return null
    if (input.status === 'deleted') return cur.filter((_, i) => i !== at)
    const next: Step = { ...old, text: str(input.subject) || old.text, status: input.status === undefined ? old.status : statusOf(input.status) }
    return cur.map((s, i) => (i === at ? next : s))
  }
  return null
}

// ---------- engine work ----------

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: TITLE })
}

// Opens the pane the first time this chat uses something.
function autoOpen($: EngineInterface) {
  if (isAutoOpened) return
  isAutoOpened = true
  void openPane($).catch(() => undefined)
}

async function record($: EngineInterface, id: string, hits: Hit[]) {
  if (!hits.length || (id && seen.has(id))) return
  if (id) seen.add(id)
  const at = await $.clock.now()
  const stamped = hits.map(hit => ({ hit, seq: ++seq, at }))
  await update($, inv, list => apply(list, stamped))
  autoOpen($)
}

async function loadSkillNames($: EngineInterface): Promise<Set<string>> {
  if (skillNames) return skillNames
  const names = new Set<string>()
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    for (const s of usage.context.breakdown?.skills?.skillFrontmatter ?? []) names.add(s.name)
  } catch {
    // No breakdown: no typed command counts as a skill.
  }
  skillNames = names
  return names
}

// Memory files the chat loaded at start, marked auto.
async function loadMemoryFiles($: EngineInterface) {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const paths = (usage.context.breakdown?.memoryFiles ?? []).map(m => m.path).filter(p => p && !SKILL_FILE.test(p))
  if (!paths.length) return
  await update($, inv, list => {
    const have = new Set(list.files.map(f => norm(f.path).toLowerCase()))
    const added: FileRow[] = paths.filter(p => !have.has(norm(p).toLowerCase())).map((p, i) => ({ path: p, isAuto: true, seq: -1000 + i }))
    return { ...list, files: [...list.files, ...added] }
  })
}

const SLASH = /<command-name>\/?([\w:.-]+)<\/command-name>|^\/([\w:.-]+)/

// Everything the chat used before the mod loaded: the main chat and its subagents.
async function seed($: EngineInterface) {
  const main = await $.session.messages()
  let steps = await read($, plan)
  let isPlanChanged = false
  const hits: Stamped[] = []
  const take = (uses: readonly { tool: string; tool_use_id: string; input: Record<string, unknown> }[]) => {
    for (const u of uses) {
      if (seen.has(u.tool_use_id)) continue
      const found = hitsOf(u.tool, u.input)
      if (!found.length) continue
      seen.add(u.tool_use_id)
      for (const hit of found) hits.push({ hit, seq: ++seq, at: 0 })
    }
  }
  const names = await loadSkillNames($)
  for (const m of main) {
    if (m.role === 'user') {
      const typed = SLASH.exec(m.text.trim())
      const name = typed?.[1] ?? typed?.[2]
      if (name && names.has(name)) hits.push({ hit: { kind: 'skill', name }, seq: ++seq, at: 0 })
    }
    take(m.toolUses)
    for (const u of m.toolUses) {
      if (PLAN_TOOLS.has(u.tool)) {
        const after = planAfter(steps, u.tool, u.input, u.result)
        if (after) {
          steps = after
          isPlanChanged = true
        }
      }
      if (u.agentId) {
        const child = await $.session.messages({ agentId: u.agentId }).catch(() => [])
        if (Array.isArray(child)) for (const c of child) take(c.toolUses)
      }
    }
  }
  if (isPlanChanged) await update($, plan, () => steps)
  // A reload of a chat that already used things does not pop the pane open again.
  if (hits.length) {
    isAutoOpened = true
    await update($, inv, list => apply(list, hits))
  }
}

const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter(x => x !== id) : [...list, id])

// ---------- drawing ----------

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (ms: number) => {
  if (!ms) return ''
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const newest = <T extends { seq: number }>(rows: T[]) => [...rows].sort((a, b) => b.seq - a.seq)

// A steady colour per connector name.
const hue = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7)

// A letter tile with the call count in a corner badge.
export function badgeSvg(name: string, count: number): string {
  const letter = (name.match(/[A-Za-z0-9]/)?.[0] ?? '?').toUpperCase()
  const label = count > 99 ? '99+' : String(count)
  const w = label.length > 1 ? 9 + label.length * 4 : 15
  const font = 'font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-weight="700" fill="#ffffff"'
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 40" width="44" height="40">' +
    `<rect x="1" y="7" width="32" height="32" rx="8" fill="hsl(${hue(name)} 55% 45%)"/>` +
    `<text x="17" y="29" text-anchor="middle" font-size="16" ${font}>${letter}</text>` +
    `<rect x="${42 - w}" y="1" width="${w}" height="15" rx="7.5" fill="${ACCENT}" stroke="#ffffff" stroke-width="1.5"/>` +
    `<text x="${42 - w / 2}" y="12" text-anchor="middle" font-size="10" ${font}>${label}</text>` +
    '</svg>'
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'inventory', description: 'Show the to-do list, connectors, files and skills this chat used', immediate: true })
    void seed($).catch(() => undefined)
    void loadMemoryFiles($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'inventory' }, async $ => {
    await openPane($)
    return { text: 'Opened the In this chat pane.' }
  })

  // A skill the person typed as a slash command.
  on('command.run', async ($, e, next) => {
    const ran = await next(e)
    if (e.command !== 'inventory' && (await loadSkillNames($)).has(e.command)) {
      await record($, '', [{ kind: 'skill', name: e.command }])
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Every tool call, in the main chat and in subagents: it runs first, then it is counted.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if ((ran as { deny?: unknown }).deny !== undefined) return ran
    const call = e as unknown as Record<string, unknown> & { tool: string; tool_use_id: string; agentId?: string }
    await record($, call.tool_use_id, hitsOf(call.tool, call))
    // Only the main chat's list is the to-do list.
    if (PLAN_TOOLS.has(call.tool) && !call.agentId) {
      let isChanged = false
      await update($, plan, cur => {
        const after = planAfter(cur, call.tool, call, (ran as { result?: unknown }).result)
        if (!after) return cur
        isChanged = true
        return after
      })
      if (isChanged) autoOpen($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const width = Math.max(24, e.props.bodyColumns)
    const inner = width - 4
    const list = await read($, inv)
    const steps = await read($, plan)
    const openServer = await read($, open)
    const closed = await read($, folded)
    const all = await read($, expanded)

    const section = (id: string, title: string, right: string, body: unknown) => {
      const isOpen = !closed.includes(id)
      return (
        <Box key={id} flexDirection="column" borderStyle="round" paddingX={1} width={width} flexShrink={0}>
          <Box flexDirection="row" justifyContent="space-between" width={inner}>
            <Button key={`sec-${id}`} plain label={`${isOpen ? '▾' : '▸'} ${title}`} onPress={() => update($, folded, cur => toggle(cur, id))} />
            {right ? <Text dimColor>{right}</Text> : null}
          </Box>
          {isOpen ? (body as never) : null}
        </Box>
      )
    }
    const row = (key: string, left: unknown, right?: unknown) => (
      <Box key={key} flexDirection="row" justifyContent="space-between" width={inner} height={1} gap={1}>
        <Box flexShrink={1} flexGrow={1} height={1} overflow="hidden">
          {left as never}
        </Box>
        {right ? <Box flexShrink={0}>{right as never}</Box> : null}
      </Box>
    )
    // The first few rows, then a Show all / Show fewer toggle.
    const few = <T,>(id: string, rows: T[], draw: (r: T, i: number) => unknown) => {
      const isAll = all.includes(id)
      const shown = isAll ? rows : rows.slice(0, FEW)
      const more = rows.length - FEW
      return [
        ...shown.map(draw),
        more > 0 ? (
          <Button key={`more-${id}`} plain dimColor label={isAll ? 'Show fewer' : `Show all (+${more})`} onPress={() => update($, expanded, cur => toggle(cur, id))} />
        ) : null,
      ] as never
    }
    const none = <Text dimColor>None used yet</Text>

    // To-do
    const doneCount = steps.filter(s => s.status === 'completed').length
    const todoBody = steps.length
      ? steps.map((s, i) => {
          const isDone = s.status === 'completed'
          const isNow = s.status === 'in_progress'
          return (
            <Box key={`todo-${i}`} flexDirection="row" width={inner}>
              <Box width={2} flexShrink={0}>
                {isDone ? <Text color={OK}>✓</Text> : isNow ? <Text color={ACCENT}>●</Text> : <Text dimColor>○</Text>}
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="wrap" dimColor={isDone} strikethrough={isDone} bold={isNow}>
                  {s.text}
                </Text>
              </Box>
            </Box>
          )
        })
      : <Text dimColor>{NO_PLAN}</Text>

    // Connectors: tiles on desktop, rows in the terminal; a press shows its calls.
    const conns = newest(list.connectors)
    const pick = (c: Connector) => update($, open, cur => (cur === c.server ? '' : c.server))
    const callList = (c: Connector) => {
      const calls = [...c.calls].reverse()
      return (
        <Box key={`calls-${c.server}`} flexDirection="column" width={inner} marginTop={1}>
          <Text dimColor wrap="truncate-end">{`${c.name} calls, newest first`}</Text>
          {few(`calls-${c.server}`, calls, (call, i) =>
            row(
              `call-${c.server}-${i}`,
              <Text wrap="truncate-end">
                {call.tool}
                {call.arg ? <Text dimColor>{`  ${call.arg}`}</Text> : null}
              </Text>,
              <Text dimColor>{clock(call.at) || ' '}</Text>,
            ),
          )}
        </Box>
      )
    }
    let connBody: unknown = none
    if (conns.length && Svg) {
      const tileCols = 12
      const perRow = Math.max(1, Math.floor(inner / tileCols))
      const rows: Connector[][] = []
      for (let i = 0; i < conns.length; i += perRow) rows.push(conns.slice(i, i + perRow))
      connBody = rows.map((r, ri) => {
        const shown = r.find(c => c.server === openServer)
        return (
          <Box key={`trow-${ri}`} flexDirection="column" width={inner}>
            <Box flexDirection="row" width={inner}>
              {r.map(c => (
                <Box key={`tile-${c.server}`} flexDirection="column" alignItems="center" width={tileCols} flexShrink={0}>
                  <Svg source={badgeSvg(c.name, c.count)} alt={`${c.name}, ${plural(c.count, 'call')}`} width={44} height={40} />
                  <Button key={`c-${c.server}`} plain dimColor={openServer !== c.server} label={clip(c.name, tileCols - 1)} onPress={() => pick(c)} />
                </Box>
              ))}
            </Box>
            {shown ? callList(shown) : null}
          </Box>
        )
      })
    } else if (conns.length) {
      connBody = conns.map(c => (
        <Box key={`crow-${c.server}`} flexDirection="column" width={inner}>
          {row(
            `cl-${c.server}`,
            <Button key={`c-${c.server}`} plain label={clip(`${openServer === c.server ? '▾' : '▸'} ${c.name}`, inner - 12)} onPress={() => pick(c)} />,
            <Text color={ACCENT}>{plural(c.count, 'call')}</Text>,
          )}
          {openServer === c.server ? callList(c) : null}
        </Box>
      ))
    }

    // Context files: name, then its folder dimmed.
    const files = newest(list.files)
    const fileBody = files.length
      ? few('files', files, f => {
          const p = norm(f.path)
          const cut = p.lastIndexOf('/')
          const parts = p.slice(0, Math.max(0, cut)).split('/').filter(Boolean)
          const folder = parts.length > 1 ? `…/${parts[parts.length - 1]}` : parts.join('/')
          return row(
            `f-${f.path}`,
            <Text wrap="truncate-end">
              {p.slice(cut + 1)}
              <Text dimColor>{`  ${folder}`}</Text>
            </Text>,
            f.isAuto ? <Text color={INFO}>auto</Text> : null,
          )
        })
      : none

    const skills = newest(list.skills)
    const skillBody = skills.length
      ? few('skills', skills, s =>
          row(
            `s-${s.name}`,
            <Text wrap="truncate-end">
              <Text color={ACCENT}>/</Text>
              {s.name}
            </Text>,
            <Text dimColor>{plural(s.count, 'use')}</Text>,
          ),
        )
      : none

    return (
      <Box flexDirection="column" width={width}>
        {section('todo', 'To-do', steps.length ? `${doneCount} of ${steps.length}` : '', todoBody)}
        {section('connectors', 'Connectors', String(conns.length), connBody)}
        {section('files', 'Context files', String(files.length), fileBody)}
        {section('skills', 'Skills', String(skills.length), skillBody)}
      </Box>
    )
  })
}
