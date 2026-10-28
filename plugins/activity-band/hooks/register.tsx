import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ContextRow, Ctx, Live, PlanStep, RunningAgent, Stats } from '../types'

const IDLE: Live = {
  isBusy: false,
  turnStartedAt: 0,
  tool: null,
  detail: '',
  toolSince: 0,
  toolCount: 0,
  agents: [],
  last: null,
  plan: [],
}

const NO_STATS: Stats = { turn: 0, speed: null, costAtStart: 0, total: 0, cacheExpiresAt: null }

// Change a tag when its value's fields change: an older stored value is declined.
const live = atom({ plugin: 'activity-band', key: 'live' } as const, IDLE, { shape: 'live-2' })
const stats = atom({ plugin: 'activity-band', key: 'stats' } as const, NO_STATS, { shape: 'stats-1' })
const isHidden = atom({ plugin: 'activity-band', key: 'isHidden' } as const, false)
// Bumped once a second, so timers and the cache countdown redraw.
const now = atom({ plugin: 'activity-band', key: 'now' } as const, 0)
const ctx = atom({ plugin: 'activity-band', key: 'ctx' } as const, null, { shape: 'ctx-1' })

const ACCENT = '#8f8cf4'
const DONE = '#5fbf8f'
const SPEED = '#8b8cf8'
const MONEY = '#5fbf8f'
const CACHE = '#4fb3a9'
const WARN = '#e2a94e'
const ALERT = '#e0846b'
const MAX_DETAIL = 60
// Tool calls refresh the context figures at most this often.
const CTX_EVERY_MS = 5000
// The prompt cache lives an hour after the last answer.
const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_WARN_S = 20 * 60
const CACHE_ALERT_S = 10 * 60
// A speed is measured only over a response this long, and believed under this.
const MIN_TOKENS = 20
const MIN_SECONDS = 0.5
const MAX_SPEED = 1000
// The tools that carry Claude's task list: the desktop's pinned list, and the CLI's.
const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const TODO_TOOL = 'TodoWrite'
// The desktop's closing call: it ticks off the rest of the pinned list itself,
// with no plan call of its own, so the band does the same.
const WRAP_TOOL = 'mcp__ccd_turn__wrap_up'
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"

// Row colours by what the row is called; /context's own are theme keys, not colours.
const ROW_COLORS: [RegExp, string][] = [
  [/system prompt/i, '#7b9fd4'],
  [/mcp/i, '#9b7cf2'],
  [/tool/i, '#6cc3c9'],
  [/agent/i, '#8fcf7a'],
  [/memory/i, '#e4c560'],
  [/skill/i, '#e79ac0'],
  [/message/i, '#e0794f'],
  [/command/i, '#c9a27b'],
]
const SPARE_COLORS = ['#7fb3a8', '#c98fd6', '#d6b38f', '#8fa3d6']

const colorOf = (name: string, i: number): string =>
  ROW_COLORS.find(([re]) => re.test(name))?.[1] ?? SPARE_COLORS[i % SPARE_COLORS.length] ?? ACCENT

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// A few words on what a tool call is doing, from its own arguments.
const detailOf = (e: Record<string, unknown>): string => {
  const str = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  const text =
    str('description') ||
    str('command') ||
    (str('file_path') && baseName(str('file_path'))) ||
    str('pattern') ||
    str('url') ||
    str('query') ||
    str('skill')
  return clip(text.replace(/\s+/g, ' ').trim(), MAX_DETAIL)
}

const secs = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

const mmss = (s: number): string => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

const tok = (n: number): string => {
  if (n < 1000) return `${Math.round(n)}`
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
}

const usd = (n: number): string => `$${n.toFixed(2)}`

// Rough advance of UI text in px, enough to lay out a drawing.
const textWidth = (s: string, size: number): number =>
  [...s].reduce((w, ch) => w + (/[\s.,:;'|!il1()]/.test(ch) ? 0.3 : /[A-Zmw@%]/.test(ch) ? 0.72 : 0.56) * size, 0)

const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(`${out}${ch}…`, size) > maxW) break
    out += ch
  }
  return `${out}…`
}


// The task list after one call of a plan tool, from what that call carried.
function applyPlan(plan: PlanStep[], tool: string, input: Record<string, unknown>): PlanStep[] {
  const statusOf = (v: unknown): PlanStep['status'] =>
    v === 'completed' ? 'completed' : v === 'in_progress' ? 'in_progress' : 'pending'
  const listOf = (v: unknown, key: string): PlanStep[] | null =>
    Array.isArray(v)
      ? v
          .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
          .map(x => ({ title: clip(String(x[key] ?? x.content ?? ''), 80), status: statusOf(x.status) }))
      : null
  if (tool === TODO_TOOL) return listOf(input.todos, 'content') ?? plan

  const items = listOf(input.items, 'content')
  if (items) return items
  let next = plan.map(s => ({ ...s }))
  if (input.advance === true) {
    const at = next.findIndex(s => s.status === 'in_progress')
    if (at >= 0) next[at] = { ...next[at]!, status: 'completed' }
    const pending = next.findIndex(s => s.status === 'pending')
    if (pending >= 0) next[pending] = { ...next[pending]!, status: 'in_progress' }
  }
  if (Array.isArray(input.done)) {
    for (const n of input.done) if (typeof n === 'number' && next[n - 1]) next[n - 1] = { ...next[n - 1]!, status: 'completed' }
  }
  if (typeof input.start === 'number' && next[input.start - 1]) {
    next = next.map((s, i) => (i === (input.start as number) - 1 ? { ...s, status: 'in_progress' } : s))
  }
  return next
}

// Module variables start over on a reload; session.start sets them again.
let lastCtxAt = 0

// Reads the context window's breakdown (`summary` is estimated locally and
// sends no request) into the `ctx` value the band draws.
async function refreshCtx($: EngineInterface): Promise<void> {
  lastCtxAt = Date.now()
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const total = usage.cost?.usd
    if (total !== undefined) await update($, stats, s => ({ ...s, total }))
    const b = usage.context.breakdown
    if (!b) return
    const rows: ContextRow[] = b.categories
      .filter(c => c.kind === 'used' && c.tokens > 0)
      .map(c => ({ name: c.name.toLowerCase(), tokens: c.tokens, kind: c.kind }))
    const next: Ctx = {
      total: b.totalTokens,
      max: b.rawMaxTokens,
      percent: b.percentage,
      compactAt: b.isAutoCompactEnabled ? (b.autoCompactThreshold ?? null) : null,
      rows,
    }
    await update($, ctx, () => next)
  } catch {
    // No breakdown yet (no session bound): the band draws without it.
  }
}

type Progress = { title: string; label: string; ratio: number | null; isDone: boolean; isActive: boolean }

// What the bar shows: the task list when Claude keeps one, else what runs now.
function progressOf(l: Live, t: number): Progress {
  const isActive = l.isBusy || l.agents.length > 0
  if (l.plan.length > 0) {
    const done = l.plan.filter(s => s.status === 'completed').length
    const current = l.plan.find(s => s.status === 'in_progress') ?? l.plan.find(s => s.status === 'pending')
    const isDone = done === l.plan.length
    return {
      title: isDone ? 'All tasks done' : (current?.title ?? 'Tasks'),
      label: isDone ? `Done ${done}/${l.plan.length}` : `Tasks ${done}/${l.plan.length}`,
      ratio: done / l.plan.length,
      isDone,
      isActive,
    }
  }
  // With no task list there is nothing to measure: the bar stays empty and the
  // pill says what is being done, never a timer that looks like progress.
  if (l.isBusy) {
    return {
      title: l.tool ? `${l.tool}${l.detail ? `: ${l.detail}` : ''}` : 'Thinking',
      label: `No task list · ${l.toolCount} tool${l.toolCount === 1 ? '' : 's'}`,
      ratio: null,
      isDone: false,
      isActive,
    }
  }
  if (l.agents.length > 0) {
    return { title: `${l.agents.length} subagent${l.agents.length === 1 ? '' : 's'} working`, label: 'No task list', ratio: null, isDone: false, isActive }
  }
  return {
    title: l.last ? `Idle · last turn ${secs(l.last.seconds * 1000)}, ${l.last.tools} tool calls` : 'Idle',
    label: 'Idle',
    ratio: 0,
    isDone: false,
    isActive,
  }
}

// One figure of the stats beside the bar: a coloured glyph, then its value;
// `dim` text is drawn muted, between the glyph and the value.
type StatPart = { glyph: string; glyphColor: string; dim?: string; value: string; valueColor?: string; after?: string }

const statWidth = (s: StatPart): number =>
  textWidth(`${s.glyph} ${s.dim ? `${s.dim} ` : ''}${s.value}${s.after ?? ''}`, 12) + 18

// The widest each figure gets, so the stats keep one slot whatever they read.
const STAT_SLOTS: StatPart[] = [
  { glyph: '#', glyphColor: '', dim: 'Turn', value: '99' },
  { glyph: '⚡', glyphColor: '', value: '999 tok/s' },
  { glyph: '$', glyphColor: '', value: '9.99', after: ' | $99.99' },
  { glyph: '⧗', glyphColor: '', value: '00:00' },
]
const STATS_W = STAT_SLOTS.reduce((w, part) => w + statWidth(part), 0)

// Drawn left to right from a fixed start, each figure in its own fixed slot.
const statsSvg = (parts: StatPart[], left: number, y: number): string => {
  let x = left
  const out: string[] = []
  for (const part of parts) {
    out.push(
      `<text x="${x.toFixed(1)}" y="${y}" font-size="12"><tspan fill="${part.glyphColor}">${xml(part.glyph)}</tspan> ` +
        (part.dim ? `<tspan class="m">${xml(part.dim)}</tspan> ` : '') +
        `<tspan font-weight="600" ${part.valueColor ? `fill="${part.valueColor}"` : 'class="t"'}>${xml(part.value)}</tspan>` +
        (part.after ? `<tspan class="m">${xml(part.after)}</tspan>` : '') +
        `</text>`,
    )
    const slot = STAT_SLOTS.find(s => s.glyph === part.glyph)
    x += Math.max(statWidth(part), slot ? statWidth(slot) : 0)
  }
  return out.join('')
}

// The progress row as one drawing: dot, title, a solid bar with its
// label riding the fill's end, and the percent. The desktop wraps sibling
// elements, so it is all one SVG.
function progressSvg(p: Progress, W: number, stats: StatPart[]): string {
  const H = 24
  const BAR_H = 16
  const y0 = (H - BAR_H) / 2
  const color = p.isDone ? DONE : ACCENT
  // Laid out from the right, in fixed slots: stats, percent, then the bar at a
  // set width. The title takes what is left and is cut to fit, so neither the
  // title nor the figures move or resize the bar.
  const statsLeft = W - 4 - STATS_W
  const PCT_W = 40
  const barEnd = statsLeft - 12 - PCT_W
  const barW = Math.max(60, Math.min(Math.round(W * 0.22), 260, barEnd - 18 - 120 - 14))
  const barX = barEnd - barW
  const title = fitText(p.title, 13, barX - 14 - 18)
  const pct = p.ratio === null ? '' : `${Math.round(p.ratio * 100)}%`

  const label = xml(p.label)
  const pillW = Math.round(textWidth(p.label, 11) + 20)
  const fillW = p.ratio === null ? pillW : barW * p.ratio
  const pillX = Math.round(Math.max(0, Math.min(barW - pillW, fillW - pillW)))
  // A solid fill, lighter than the pill riding its end, reaching at least to the
  // pill's end; with no ratio the pill sits at the bar's start over an empty track.
  const solidW = p.ratio ? Math.max(pillW, fillW) : 0
  const fillGroup = solidW ? `<rect x="0" y="${y0}" width="${solidW.toFixed(1)}" height="${BAR_H}" fill="${color}" opacity=".35"/>` : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>
text{font-family:${FONT}}
.t{fill:#1f1f1f}.m{fill:#6e6e6e}.k{fill:#e4e4e2}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2a2b31}}
</style>
<circle cx="7" cy="${H / 2}" r="4" fill="${color}"${p.isActive || p.isDone ? '' : ' opacity=".45"'}/>
<text x="18" y="${H / 2 + 4.5}" font-size="13" font-weight="600" class="t">${xml(title)}</text>
<g transform="translate(${barX} 0)">
<rect class="k" x="0" y="${y0}" width="${barW}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<clipPath id="bar"><rect x="0" y="${y0}" width="${barW}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath>
<g clip-path="url(#bar)">${fillGroup}</g>
${p.ratio === null && !p.isActive ? '' : `<rect x="${pillX}" y="${y0}" width="${pillW}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>
<text x="${pillX + pillW / 2}" y="${H / 2 + 4}" text-anchor="middle" font-size="11" font-weight="600" fill="#14161a">${label}</text>`}
</g>
${pct ? `<text x="${barX + barW + 8}" y="${H / 2 + 4.5}" font-size="12" class="m">${pct}</text>` : ''}
${statsSvg(stats, statsLeft, H / 2 + 4.5)}
</svg>`
}

// The context card as one drawing: header, bar and legend share one SVG.
function ctxSvg(c: Ctx, W: number): { source: string; height: number } {
  const PAD = 12
  const BAR_Y = 30
  const BAR_H = 10
  const LEG_Y = BAR_Y + BAR_H + 14
  const LINE = 18
  const inner = W - PAD * 2

  // Legend items flow left to right and wrap.
  const items = [...c.rows.map((r, i) => ({ name: r.name, tokens: r.tokens, color: colorOf(r.name, i) }))]
  const free = Math.max(0, c.max - c.total)
  items.push({ name: 'free', tokens: free, color: '' })
  let x = PAD
  let row = 0
  const legend: string[] = []
  for (const it of items) {
    const pct = `${Math.round((it.tokens / Math.max(1, c.max)) * 100)}%`
    const w = 14 + textWidth(it.name, 11) + 5 + textWidth(tok(it.tokens), 11) + 4 + textWidth(pct, 11) + 16
    if (x + w > W - PAD && x > PAD) {
      x = PAD
      row += 1
    }
    const y = LEG_Y + row * LINE
    legend.push(
      `<rect x="${x}" y="${y - 9}" width="10" height="10" rx="2" ${it.color ? `fill="${it.color}"` : 'class="k"'}/>` +
        `<text x="${x + 14}" y="${y}" class="m">${xml(it.name)} <tspan class="t" font-weight="600">${tok(it.tokens)}</tspan> <tspan class="m">${pct}</tspan></text>`,
    )
    x += w
  }
  const height = LEG_Y + row * LINE + 10

  // The bar: each used row in turn, the free space as the track behind.
  let bx = PAD
  const segs: string[] = []
  c.rows.forEach((r, i) => {
    const w = (inner * r.tokens) / Math.max(1, c.max)
    if (w >= 0.5) segs.push(`<rect x="${bx.toFixed(1)}" y="${BAR_Y}" width="${Math.max(1, w).toFixed(1)}" height="${BAR_H}" fill="${colorOf(r.name, i)}"/>`)
    bx += w
  })
  const marker =
    c.compactAt && c.compactAt < c.max
      ? `<rect x="${(PAD + (inner * c.compactAt) / c.max - 1).toFixed(1)}" y="${BAR_Y - 2}" width="2" height="${BAR_H + 4}" fill="#e4c560"/>`
      : ''

  const pctText = `${Math.round(c.percent)}%`
  const pillW = Math.round(textWidth(pctText, 11) + 12)
  const head = `${tok(c.total)}`
  const tail = ` of ${tok(c.max)}${c.compactAt ? ` · compacts at ${tok(c.compactAt)}` : ''}`
  const pillColor = c.percent >= 80 ? '#e0794f' : c.percent >= 60 ? '#e4c560' : '#8fcf7a'

  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}">
<style>
text{font-family:${FONT};font-size:11px}
.t{fill:#1f1f1f}.m{fill:#6e6e6e}.k{fill:#e4e4e2}.bg{fill:#f6f6f4;stroke:#dddddb}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2f3a}.bg{fill:#17181c;stroke:#2c2d33}}
</style>
<rect class="bg" x="0.5" y="0.5" width="${W - 1}" height="${height - 1}" rx="8"/>
<text x="${PAD}" y="19" class="t" font-weight="600"><tspan fill="#e0794f">◆</tspan> context</text>
<text x="${W - PAD - pillW - 6}" y="19" text-anchor="end" class="m"><tspan class="t" font-weight="600">${head}</tspan>${xml(tail)}</text>
<rect x="${W - PAD - pillW}" y="8" width="${pillW}" height="15" rx="3" fill="${pillColor}"/>
<text x="${W - PAD - pillW / 2}" y="19" text-anchor="middle" fill="#14161a" font-weight="600">${pctText}</text>
<rect class="k" x="${PAD}" y="${BAR_Y}" width="${inner}" height="${BAR_H}" rx="2"/>
${segs.join('')}${marker}
${legend.join('\n')}
</svg>`
  return { source, height }
}

const ctxLine = (c: Ctx): string =>
  `context ${tok(c.total)}/${tok(c.max)} ${Math.round(c.percent)}% · ` +
  c.rows.map(r => `${r.name} ${tok(r.tokens)}`).join(' · ')

const barText = (p: Progress, width: number): string => {
  if (p.ratio === null) return '░'.repeat(width)
  const filled = Math.round(width * p.ratio)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // Agents from before a reload may have ended unseen: keep only live ones.
    const known = new Set((await $.agent.list()).filter(a => a.status === 'running').map(a => a.id))
    await update($, live, l => ({ ...l, agents: l.agents.filter(a => known.has(a.id)) }))
    await refreshCtx($)
    // Started fresh (a new session, or new state fields): the session's cost so
    // far is not this turn's.
    await update($, stats, st => (st.turn === 0 ? { ...st, costAtStart: st.total } : st))
    // One tick for every timer the band shows, the cache countdown included.
    $.clock.every(1000, () => {
      void update($, now, () => Date.now())
    })
    // A (re)load is not followed by a draw, and a state write redraws only what
    // was drawn already: ask for one, now and once more when the app has settled.
    $.ui.invalidate('ui.render')
    $.clock.after(1500, () => $.ui.invalidate('ui.render'))
    return result
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      // A finished list belongs to the last task: the next turn starts clean.
      await update($, live, l => ({
        ...l,
        isBusy: true,
        turnStartedAt: Date.now(),
        toolCount: 0,
        tool: null,
        plan: l.plan.length > 0 && l.plan.every(s => s.status === 'completed') ? [] : l.plan,
      }))
      const total = (await $.session.usage()).cost?.usd
      await update($, stats, s => ({ ...s, turn: s.turn + 1, total: total ?? s.total, costAtStart: total ?? s.total }))
      // Hide only quiets the band until the next turn.
      await update($, isHidden, () => false)
    }
    return next(e)
  })

  // The speed of each response: output tokens over the time from its first chunk.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    let startedAt: number | null = null
    for await (const chunk of next(e)) {
      if (startedAt === null) startedAt = Date.now()
      if (chunk.kind === 'stop' && chunk.usage) {
        const tokens = chunk.usage.output_tokens
        const seconds = (Date.now() - startedAt) / 1000
        const speed = tokens / seconds
        if (tokens >= MIN_TOKENS && seconds >= MIN_SECONDS && speed <= MAX_SPEED) {
          await update($, stats, s => ({ ...s, speed: Math.round(speed) }))
        }
      }
      yield chunk
    }
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const input = e as unknown as Record<string, unknown>
    await update($, live, l => ({
      ...l,
      tool: e.tool,
      detail: detailOf(input),
      toolSince: Date.now(),
      toolCount: l.toolCount + 1,
      plan:
        e.tool === PLAN_TOOL || e.tool === TODO_TOOL
          ? applyPlan(l.plan, e.tool, input)
          : e.tool === WRAP_TOOL
            ? l.plan.map(step => ({ ...step, status: 'completed' as const }))
            : l.plan,
    }))
    try {
      return await next(e)
    } finally {
      await update($, live, l => (l.tool === e.tool ? { ...l, tool: null, detail: '' } : l))
      if (Date.now() - lastCtxAt > CTX_EVERY_MS) await refreshCtx($)
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if ('agentId' in result && result.agentId) {
      const agent: RunningAgent = {
        id: result.agentId,
        type: e.subagentType,
        description: clip(e.description, 40),
        startedAt: Date.now(),
      }
      await update($, live, l => ({ ...l, agents: [...l.agents.filter(a => a.id !== agent.id), agent] }))
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // A subagent's turn ended: drop it unless the engine still runs it.
      const info = (await $.agent.list()).find(a => a.id === e.agentId)
      if (!info || info.status !== 'running') {
        await update($, live, l => ({ ...l, agents: l.agents.filter(a => a.id !== e.agentId) }))
      }
    } else {
      await update($, live, l => ({
        ...l,
        isBusy: false,
        tool: null,
        detail: '',
        last: { seconds: Math.round(e.durationMs / 1000), tools: l.toolCount },
      }))
      await update($, stats, s => ({ ...s, cacheExpiresAt: Date.now() + CACHE_TTL_MS }))
      await refreshCtx($)
    }
    const result = await next(e)
    // The idle row must show after the turn too, whatever the app redraws.
    if (e.agentId === undefined) $.clock.after(500, () => $.ui.invalidate('ui.render'))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const l = await read($, live)
    const s = await read($, stats)
    const c = await read($, ctx)
    const t = (await read($, now)) || Date.now()
    const isEmpty = !l.isBusy && l.agents.length === 0 && !l.last && !c && s.turn === 0
    if (e.props.hasSurvey || (await read($, isHidden)) || isEmpty) return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const isDesktop = e.surface !== 'terminal' && 'Svg' in ui
    // About 8 CSS px per reported column, less the band's own margin.
    const width = Math.max(260, Math.min(1400, (e.props.bodyColumns || 100) * 8 - 16))
    const p = progressOf(l, t)

    // The stats: turn, speed, cost, cache countdown, subagents.
    const left = s.cacheExpiresAt === null ? null : Math.max(0, Math.floor((s.cacheExpiresAt - t) / 1000))
    const cacheColor = l.isBusy || left === null ? CACHE : left <= CACHE_ALERT_S ? ALERT : left <= CACHE_WARN_S ? WARN : CACHE
    const cacheText = l.isBusy ? '…' : left === null ? '—' : mmss(left)
    const turnCost = Math.max(0, s.total - s.costAtStart)
    const parts: StatPart[] = [
      { glyph: '#', glyphColor: '#8a8f8c', dim: 'Turn', value: String(s.turn) },
      { glyph: '⚡', glyphColor: SPEED, value: s.speed === null ? '—' : `${s.speed} tok/s` },
      { glyph: '$', glyphColor: MONEY, value: usd(turnCost).slice(1), after: ` | ${usd(s.total)}` },
      { glyph: '⧗', glyphColor: cacheColor, value: cacheText, valueColor: cacheColor },
    ]
    const dismiss = <Button key="hide" label="×" role="dismiss" plain dimColor onPress={() => update($, isHidden, () => true)} />

    // The bar and the stats are one drawing on the desktop, which puts side by
    // side elements on lines of their own; only the dismiss sits beside it.
    // No Text here takes both `color` and `dimColor`: the desktop drops a band
    // that holds one.
    let row
    if (isDesktop) {
      const { Svg } = ui
      const alt =
        `${p.title}: ${p.label}${p.ratio === null ? '' : `, ${Math.round(p.ratio * 100)}%`} · ` +
        parts.map(part => `${part.dim ?? ''}${part.dim ? ' ' : ''}${part.value}${part.after ?? ''}`).join(' · ')
      row = (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Svg source={progressSvg(p, width - 28, parts)} alt={alt} width={width - 28} height={24} />
          {dismiss}
        </Box>
      )
    } else {
      const cols = e.props.bodyColumns || 80
      row = (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text color={p.isDone ? DONE : ACCENT}>●</Text>
            <Text wrap="truncate-end">{clip(p.title, Math.max(10, Math.floor(cols / 3)))}</Text>
            <Text color={p.isDone ? DONE : ACCENT}>{barText(p, Math.max(6, Math.min(30, cols - 40)))}</Text>
            <Text bold>{p.label}</Text>
          </Box>
          <Box flexDirection="row" gap={2}>
            {parts.map(part => (
              <Text key={part.glyph}>
                <Text color={part.glyphColor}>{part.glyph}</Text> {part.dim ? `${part.dim} ` : ''}
                {part.value}
                {part.after ?? ''}
              </Text>
            ))}
            {dismiss}
          </Box>
        </Box>
      )
    }

    let card = null
    if (c && isDesktop) {
      const { Svg } = ui
      const { source, height } = ctxSvg(c, width)
      card = <Svg source={source} alt={ctxLine(c)} width={width} height={height} />
    } else if (c) {
      card = <Text dimColor wrap="truncate-end">{ctxLine(c)}</Text>
    }

    return (
      <Box flexDirection="column" gap={1}>
        {row}
        {card}
      </Box>
    )
  })
}
