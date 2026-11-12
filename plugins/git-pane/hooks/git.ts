// Reading git's output and laying out the history graph. No engine calls here,
// so the test can feed it text directly.

import type { Commit, FileRow } from '../types'

export const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

// Windows paths compare without case.
export const samePath = (a: string, b: string) => slash(a).toLowerCase() === slash(b).toLowerCase()

export const isInside = (file: string, root: string) => {
  const f = slash(file).toLowerCase()
  const r = slash(root).toLowerCase()
  return f.startsWith(`${r}/`)
}

// ---------- git status --porcelain=v2 --branch -z ----------

export type Status = { branch: string; upstream: string; ahead: number; behind: number; files: FileRow[] }

const ENTRY_1 = /^1 (..) (?:\S+ ){6}(.*)$/s
const ENTRY_2 = /^2 (..) (?:\S+ ){7}(.*)$/s
const ENTRY_U = /^u (..) (?:\S+ ){8}(.*)$/s

export function parseStatus(raw: string): Status {
  const out: Status = { branch: '', upstream: '', ahead: 0, behind: 0, files: [] }
  const parts = raw.split('\0')
  const add = (path: string, from: string, xy: string) => {
    const [x = '.', y = '.'] = xy
    if (x !== '.') out.files.push({ path, from, status: x, where: 'staged', added: -1, removed: -1 })
    if (y !== '.') out.files.push({ path, from: '', status: y, where: 'unstaged', added: -1, removed: -1 })
  }
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]!
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      const head = line.slice(14)
      out.branch = head === '(detached)' ? '' : head
    } else if (line.startsWith('# branch.upstream ')) {
      out.upstream = line.slice(18)
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      if (m) {
        out.ahead = Number(m[1])
        out.behind = Number(m[2])
      }
    } else if (line.startsWith('1 ')) {
      const m = ENTRY_1.exec(line)
      if (m) add(m[2]!, '', m[1]!)
    } else if (line.startsWith('2 ')) {
      const m = ENTRY_2.exec(line)
      // A rename's old path is the next field.
      const from = parts[++i] ?? ''
      if (m) add(m[2]!, from, m[1]!)
    } else if (line.startsWith('u ')) {
      const m = ENTRY_U.exec(line)
      if (m) out.files.push({ path: m[2]!, from: '', status: 'U', where: 'conflict', added: -1, removed: -1 })
    } else if (line.startsWith('? ')) {
      out.files.push({ path: line.slice(2), from: '', status: '?', where: 'untracked', added: -1, removed: -1 })
    }
  }
  return out
}

// ---------- git diff --numstat -z ----------

export function parseNumstat(raw: string): Map<string, { added: number; removed: number }> {
  const map = new Map<string, { added: number; removed: number }>()
  const parts = raw.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]!
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec.replace(/^\n/, ''))
    if (!m) continue
    let path = m[3]!
    // A rename: an empty path, then the old and the new path.
    if (!path) {
      i += 2
      path = parts[i] ?? ''
    }
    const added = m[1] === '-' ? -1 : Number(m[1])
    const removed = m[2] === '-' ? -1 : Number(m[2])
    map.set(path, { added, removed })
  }
  return map
}

export function withCounts(files: FileRow[], staged: string, unstaged: string): FileRow[] {
  const s = parseNumstat(staged)
  const u = parseNumstat(unstaged)
  return files.map(f => {
    const n = f.where === 'staged' ? s.get(f.path) : f.where === 'unstaged' ? u.get(f.path) : undefined
    return n ? { ...f, ...n } : f
  })
}

// ---------- git log ----------

// Fields: hash, parents, author, date, refs, subject, body.
export const LOG_FORMAT = '--format=%H%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%s%x1f%b%x1e'

export function parseLog(raw: string): Commit[] {
  return raw
    .split('\x1e')
    .map(r => r.replace(/^\s+/, ''))
    .filter(Boolean)
    .map(r => {
      const [hash = '', parents = '', author = '', date = '', refs = '', subject = '', body = ''] = r.split('\x1f')
      return {
        hash,
        parents: parents.split(' ').filter(Boolean),
        author,
        date,
        refs: refs
          .split(',')
          .map(x => x.trim())
          .filter(x => x && x !== 'HEAD' && !x.endsWith('/HEAD')),
        subject,
        body: body.trim(),
      }
    })
    .filter(c => /^[0-9a-f]{7,64}$/.test(c.hash))
}

// "7 files changed, 1204 insertions(+), 388 deletions(-)"
export function parseShortstat(raw: string) {
  const num = (re: RegExp) => Number(re.exec(raw)?.[1] ?? 0)
  return { files: num(/(\d+) files? changed/), added: num(/(\d+) insertions?/), removed: num(/(\d+) deletions?/) }
}

// `git worktree list --porcelain`: the folder of each worktree.
export function parseWorktrees(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .filter(l => l.startsWith('worktree '))
    .map(l => slash(l.slice(9)))
}

// ---------- the graph ----------

// One commit's row of the graph. Lanes are columns; a segment joins a lane at the
// row's top (or its dot) to a lane at its dot (or its bottom).
export type GraphRow = {
  // The lane the commit's dot sits in.
  lane: number
  isMerge: boolean
  // Lines from the top of the row: [lane at the top, lane at the dot's height].
  top: [number, number][]
  // Lines to the bottom of the row: [lane at the dot's height, lane at the bottom].
  bottom: [number, number][]
  // Lanes used in this row.
  width: number
}

export function layoutGraph(commits: readonly Commit[]): GraphRow[] {
  // Each lane holds the hash it waits for, or null when free.
  let lanes: (string | null)[] = []
  const rows: GraphRow[] = []
  for (const c of commits) {
    let lane = lanes.indexOf(c.hash)
    if (lane < 0) {
      lane = lanes.indexOf(null)
      if (lane < 0) lane = lanes.length
      lanes[lane] = null
    }
    const before = lanes.slice()
    const top: [number, number][] = []
    const bottom: [number, number][] = []
    before.forEach((h, i) => {
      if (h === null) return
      if (h === c.hash) {
        // A line arriving at this commit: straight down its own lane, or curving in.
        top.push([i, lane])
        if (i !== lane) lanes[i] = null
      }
    })
    lanes[lane] = c.parents[0] ?? null
    if (c.parents[0]) bottom.push([lane, lane])
    for (const p of c.parents.slice(1)) {
      let j = lanes.indexOf(p)
      if (j < 0) {
        j = lanes.indexOf(null)
        if (j < 0 || j === lane) j = lanes.findIndex((x, k) => x === null && k !== lane)
        if (j < 0) j = lanes.length
        lanes[j] = p
      }
      bottom.push([lane, j])
    }
    // Lanes passing by: through the whole row.
    before.forEach((h, i) => {
      if (h !== null && h !== c.hash && lanes[i] === h) {
        top.push([i, i])
        bottom.push([i, i])
      }
    })
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    const used = [lane, ...top.flat(), ...bottom.flat()]
    rows.push({ lane, isMerge: c.parents.length > 1, top, bottom, width: Math.max(...used) + 1 })
    lanes = lanes.slice()
  }
  return rows
}

export const LANE_COLORS = ['#d85a30', '#378add', '#1d9e75', '#7f77dd', '#d4537e', '#ba7517', '#639922']
export const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length]!

// At most this many lanes are drawn; the rest are clipped to the last one.
export const MAX_LANES = 6
const STEP = 12
const PAD = 7
const DOT_Y = 10

const lx = (i: number) => PAD + Math.min(i, MAX_LANES - 1) * STEP

export const graphWidth = (rows: readonly GraphRow[]) => PAD * 2 + (Math.min(MAX_LANES, Math.max(1, ...rows.map(r => r.width))) - 1) * STEP

// One row of the graph as an SVG, `height` tall, with the dot near the top so it
// sits beside the commit's first line.
export function rowSvg(row: GraphRow, width: number, height: number): string {
  const seg = (a: number, y0: number, b: number, y1: number, color: string) => {
    const x0 = lx(a)
    const x1 = lx(b)
    if (x0 === x1) return `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${color}" stroke-width="2"/>`
    const ym = (y0 + y1) / 2
    return `<path d="M${x0} ${y0} C${x0} ${ym} ${x1} ${ym} ${x1} ${y1}" fill="none" stroke="${color}" stroke-width="2"/>`
  }
  const parts: string[] = []
  for (const [a, b] of row.top) parts.push(seg(a, 0, b, DOT_Y, laneColor(a)))
  for (const [a, b] of row.bottom) {
    // A branch leaving the dot curves over in the first part of the row, then runs straight.
    if (a === b) parts.push(seg(a, DOT_Y, b, height, laneColor(b)))
    else parts.push(seg(a, DOT_Y, b, Math.min(height, DOT_Y + 22), laneColor(b)), seg(b, Math.min(height, DOT_Y + 22), b, height, laneColor(b)))
  }
  const color = laneColor(row.lane)
  const x = lx(row.lane)
  parts.push(
    row.isMerge
      ? `<circle cx="${x}" cy="${DOT_Y}" r="3.5" fill="${color}" fill-opacity="0.25" stroke="${color}" stroke-width="2"/>`
      : `<circle cx="${x}" cy="${DOT_Y}" r="4.5" fill="${color}"/>`,
  )
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`
}

// The terminal's graph: one cell per lane, ● the commit, │ a lane passing.
export function rowGlyphs(row: GraphRow, lanes: number, isDotLine: boolean): string {
  const n = Math.min(MAX_LANES, lanes)
  const cells: string[] = []
  for (let i = 0; i < n; i++) {
    const hasLine = isDotLine ? row.top.some(([a, b]) => a === i || b === i) || row.bottom.some(([a]) => a === i) : row.bottom.some(([, b]) => b === i)
    cells.push(isDotLine && i === Math.min(row.lane, n - 1) ? (row.isMerge ? '◆' : '●') : hasLine ? '│' : ' ')
  }
  return cells.join(' ')
}

// ---------- small text helpers ----------

export const clip = (s: string, n: number) => (n <= 1 ? '' : s.length <= n ? s : `${s.slice(0, n - 1)}…`)

// Long paths keep their end: …/hooks/register.tsx
export const clipStart = (s: string, n: number) => (n <= 1 ? '' : s.length <= n ? s : `…${s.slice(s.length - n + 1)}`)

export function ago(iso: string, now: number): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d ago`
  if (s < 30 * 86_400) return `${Math.floor(s / (7 * 86_400))}w ago`
  return iso.slice(0, 10)
}

export const counts = (f: FileRow) => (f.added < 0 && f.removed < 0 ? '' : `+${Math.max(0, f.added)} −${Math.max(0, f.removed)}`)
