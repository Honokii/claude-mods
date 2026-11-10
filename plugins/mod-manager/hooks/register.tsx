import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { ModRow } from '../types'

// The Mods pane: every plugin Claude Code has installed, mods first. Each installed
// one has an On/Off switch that runs `claude plugin enable|disable`, so it works for
// any plugin, with no code of its own. The list comes from `claude plugin list
// --json`, this chat's dev-mods folder and CLAUDE_CODE_PLUGIN_DIRS.

const PANE = 'mod-manager'
const TITLE = 'Mods'
const ACCENT = '#e0794f'
const OK = '#5fbf8f'
const WARN = '#d9a33f'
const RESCAN_MS = 15_000

const mods = atom({ plugin: 'mod-manager', key: 'mods' } as const, [] as ModRow[], { shape: 'mods-1' })
const atStart = atom({ plugin: 'mod-manager', key: 'atStart' } as const, {} as Record<string, boolean>, { shape: 'start-1' })
const busy = atom({ plugin: 'mod-manager', key: 'busy' } as const, '')
const note = atom({ plugin: 'mod-manager', key: 'note' } as const, '')
const scanned = atom({ plugin: 'mod-manager', key: 'scanned' } as const, false)
const showPlugins = atom({ plugin: 'mod-manager', key: 'showPlugins' } as const, false)

// Module variables start over on a reload; the list lives in $.state.
let sid = ''
let isScanning = false
// How `claude` starts here: directly, or through cmd on Windows (an npm .cmd shim).
let launcher: string[] | null = null

// ---------- small helpers ----------

const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

export const titleCase = (s: string) =>
  s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(w => w[0]!.toUpperCase() + w.slice(1))
    .join(' ')

const clip = (s: string, n: number) => (n <= 1 ? '' : s.length <= n ? s : `${s.slice(0, n - 1)}…`)

function parse(raw: string): Record<string, unknown> {
  try {
    const json = JSON.parse(raw) as unknown
    return json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

// 1.10.0 is newer than 1.9.2; anything not numeric compares as text.
export function isNewer(a: string, b: string): boolean {
  if (!a || !b || a === b) return false
  const pa = a.split(/[.+-]/).map(Number)
  const pb = b.split(/[.+-]/).map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (Number.isNaN(x) || Number.isNaN(y)) return a > b
    if (x !== y) return x > y
  }
  return false
}

// Only plugin ids and scopes reach the command line.
const SAFE = /^[\w.-]+(@[\w.-]+)?$/

async function readText($: EngineInterface, path: string) {
  try {
    if (!(await $.fs.exists(path))) return ''
    return String(await $.fs.read(path))
  } catch {
    return ''
  }
}

async function listDirs($: EngineInterface, dir: string) {
  try {
    const entries = await $.fs.list(dir)
    return entries.filter(x => !x.name.startsWith('.') && (x.kind === 'dir' || x.isLink)).map(x => `${dir}/${x.name}`)
  } catch {
    return []
  }
}

async function homeOf($: EngineInterface) {
  return slash((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '')
}

// ---------- the claude CLI ----------

export async function claude($: EngineInterface, args: string[], timeoutMs = 60_000) {
  const tries = launcher ? [launcher] : [['claude'], ['cmd', '/c', 'claude']]
  let last: unknown = null
  for (const pre of tries) {
    try {
      const out = await $.process.run([...pre, ...args], { timeoutMs })
      launcher = pre
      return out
    } catch (err) {
      last = err
    }
  }
  throw last instanceof Error ? last : new Error('could not start claude')
}

type Listed = { id: string; version: string; scope: string; enabled: boolean; installPath: string }

async function listInstalled($: EngineInterface): Promise<Listed[]> {
  const { stdout } = await claude($, ['plugin', 'list', '--json'])
  const start = stdout.indexOf('[')
  if (start < 0) return []
  try {
    const raw = JSON.parse(stdout.slice(start)) as unknown
    if (!Array.isArray(raw)) return []
    return raw
      .map(x => x as Record<string, unknown>)
      .map(x => ({ id: str(x.id), version: str(x.version), scope: str(x.scope), enabled: x.enabled === true, installPath: slash(str(x.installPath)) }))
      .filter(x => x.id)
  } catch {
    return []
  }
}

// ---------- looking at a plugin folder ----------

type Folder = { name: string; version: string; description: string; kind: 'mod' | 'plugin' }

async function inspect($: EngineInterface, dir: string): Promise<Folder | null> {
  const manifest = await readText($, `${dir}/.claude-plugin/plugin.json`)
  if (!manifest) return null
  const plugin = parse(manifest)
  const hooks = parse(await readText($, `${dir}/hooks/hooks.json`))
  return {
    name: str(plugin.name) || (dir.split('/').pop() ?? ''),
    version: str(plugin.version),
    description: str(plugin.description),
    kind: Array.isArray(hooks.modules) && hooks.modules.length ? 'mod' : 'plugin',
  }
}

// The newest version a marketplace's own copy lists for a plugin, or ''.
async function latestIn($: EngineInterface, markets: Record<string, unknown>, market: string, name: string) {
  const loc = slash(str(parse(JSON.stringify(markets[market] ?? {})).installLocation))
  if (!loc) return ''
  const catalog = parse(await readText($, `${loc}/.claude-plugin/marketplace.json`))
  const entry = (Array.isArray(catalog.plugins) ? catalog.plugins : [])
    .map(x => x as Record<string, unknown>)
    .find(x => x.name === name)
  if (!entry) return ''
  if (str(entry.version)) return str(entry.version)
  const source = str(entry.source)
  if (!source) return ''
  const folder = `${loc}/${source.replace(/^\.\//, '')}`
  return str(parse(await readText($, `${folder}/.claude-plugin/plugin.json`)).version)
}

async function commandsByPlugin($: EngineInterface) {
  const map = new Map<string, string[]>()
  try {
    for (const c of await $.command.list()) {
      if (!c.plugin) continue
      const list = map.get(c.plugin) ?? []
      if (!list.includes(c.name)) list.push(c.name)
      map.set(c.plugin, list)
    }
  } catch {
    // No commands known; the rows show none.
  }
  return map
}

// Plugin commands are listed as `plugin:name`; the button runs that full name.
const short = (cmd: string) => cmd.split(':').pop() ?? cmd

async function envDirs($: EngineInterface, home: string) {
  const raw = (await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')) ?? ''
  // Windows separates with ';', others with ':' (a drive letter's colon is not one).
  return raw
    .split(/;|:(?![\\/])/)
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => (x === '~' ? home : x.startsWith('~/') ? `${home}${x.slice(1)}` : x))
    .map(slash)
}

// ---------- the scan ----------

export async function scan($: EngineInterface): Promise<ModRow[]> {
  const home = await homeOf($)
  const markets = parse(await readText($, `${home}/.claude/plugins/known_marketplaces.json`))
  const cmds = await commandsByPlugin($)
  const rows: ModRow[] = []
  const seen = new Set<string>()

  for (const p of await listInstalled($)) {
    const [name = p.id, market = ''] = p.id.split('@')
    const folder = p.installPath ? await inspect($, p.installPath) : null
    const latest = market ? await latestIn($, markets, market, name) : ''
    seen.add(name)
    rows.push({
      id: p.id,
      name,
      title: titleCase(name),
      version: p.version || folder?.version || '',
      description: folder?.description ?? '',
      where: 'installed',
      kind: folder?.kind ?? 'plugin',
      scope: p.scope,
      isEnabled: p.enabled,
      latest: isNewer(latest, p.version) ? latest : '',
      commands: cmds.get(name) ?? [],
    })
  }

  const extra: [string, ModRow['where']][] = []
  if (sid) for (const d of await listDirs($, `${home}/.claude/dev-mods/${sid}`)) extra.push([d, 'chat'])
  for (const d of await envDirs($, home)) extra.push([d, 'folder'])
  for (const [dir, where] of extra) {
    const folder = await inspect($, dir)
    // An installed copy wins over a folder of the same name.
    if (!folder || seen.has(folder.name)) continue
    seen.add(folder.name)
    rows.push({
      id: dir,
      name: folder.name,
      title: titleCase(folder.name),
      version: folder.version,
      description: folder.description,
      where,
      kind: folder.kind,
      scope: where === 'chat' ? 'this chat' : 'folder',
      isEnabled: true,
      latest: '',
      commands: cmds.get(folder.name) ?? [],
    })
  }

  return rows.sort((a, b) => (a.kind === b.kind ? a.title.localeCompare(b.title) : a.kind === 'mod' ? -1 : 1))
}

const sig = (rows: readonly ModRow[]) => JSON.stringify(rows)

async function rescan($: EngineInterface) {
  if (isScanning) return
  isScanning = true
  try {
    const rows = await scan($)
    // What was enabled at the first scan of this session is what is loaded now.
    await update($, atStart, cur => {
      const next = { ...cur }
      for (const r of rows) if (!(r.id in next)) next[r.id] = r.isEnabled
      return next
    })
    if (sig(rows) !== sig(await read($, mods))) await update($, mods, () => rows)
  } catch (err) {
    await update($, note, () => `Could not list plugins: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    isScanning = false
    await update($, scanned, () => true)
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

const lastLine = (s: string) => s.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''

async function act($: EngineInterface, row: ModRow, what: 'enable' | 'disable' | 'update') {
  if (!SAFE.test(row.id) || (await read($, busy))) return
  await update($, busy, () => row.id)
  await update($, note, () => '')
  try {
    const scope = ['user', 'project', 'local'].includes(row.scope) ? ['--scope', row.scope] : []
    if (what === 'update') {
      const market = row.id.split('@')[1] ?? ''
      if (market) await claude($, ['plugin', 'marketplace', 'update', market], 120_000)
      const out = await claude($, ['plugin', 'update', row.id, ...scope], 120_000)
      if (out.exitCode !== 0) throw new Error(lastLine(out.stderr) || lastLine(out.stdout) || `exit ${out.exitCode}`)
      await update($, note, () => `${row.title} updated to ${row.latest}. Start a new chat to use it.`)
    } else {
      const out = await claude($, ['plugin', what, row.id, ...scope])
      if (out.exitCode !== 0) throw new Error(lastLine(out.stderr) || lastLine(out.stdout) || `exit ${out.exitCode}`)
      await update($, note, () => `${row.title} is ${what === 'enable' ? 'on' : 'off'} from the next chat on.`)
    }
  } catch (err) {
    await update($, note, () => `${row.title}: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await update($, busy, () => '')
    await rescan($)
  }
}

async function runCommand($: EngineInterface, cmd: string) {
  try {
    await $.command.run({ command: cmd })
  } catch (err) {
    await update($, note, () => `/${short(cmd)}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: TITLE })
  await rescan($)
}

// ---------- drawing ----------

// Line icons (24-unit paths, stroked) picked by words in the mod's name.
const ICONS: [RegExp, string, string][] = [
  [/gauge|context|meter/, 'M5 18a8 8 0 1 1 14 0 M12 13l3-4 M12 13h.01', '◔'],
  [/clock|cache|timer|time/, 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16 M12 8v4l3 2', '◷'],
  [/handoff|refresh|move/, 'M4 12h14 M13 7l5 5l-5 5', '→'],
  [/screen|privacy|share|hide/, 'M12 3l8 3v6c0 5-4 8-8 9c-4-1-8-4-8-9V6z', '◈'],
  [/brain|dump|prompt|write/, 'M4 20h4l10-10l-4-4L4 16z M13 7l4 4', '✎'],
  [/reflect|rule|learn/, 'M20 11a8 8 0 1 0-2 5.5 M20 5v6h-6', '↻'],
  [/agent|helper|critter/, 'M7 8h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z M12 4v4 M9.5 13h.01 M14.5 13h.01', '◉'],
  [/inventory|list|tray|output/, 'M9 6h11 M9 12h11 M9 18h11 M5 6h.01 M5 12h.01 M5 18h.01', '☰'],
  [/band|progress|bar|status/, 'M4 9h16v6H4z M4 12h9', '▭'],
  [/mod|manager|plugin|setting/, 'M6 4v16 M12 4v16 M18 4v16 M4 8h4 M10 15h4 M16 10h4', '≡'],
]
const PUZZLE = 'M5 8h3a2 2 0 1 1 4 0h3v3a2 2 0 1 1 0 4v3h-3a2 2 0 1 0-4 0H5v-3a2 2 0 1 0 0-4z'

const iconOf = (name: string) => ICONS.find(([re]) => re.test(name))

// Each mod keeps one colour, picked from its name: mid tones that read on light and dark.
const TINTS = ['#1d9e75', '#7f77dd', '#d85a30', '#d4537e', '#378add', '#ba7517', '#639922']
const OFF_TINT = '#888780'

export function tintOf(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return TINTS[h % TINTS.length]!
}

// The icon on a soft tile of the mod's colour; grey while it is off.
export function iconSvg(name: string, isOn: boolean): string {
  const path = iconOf(name)?.[1] ?? PUZZLE
  const color = isOn ? tintOf(name) : OFF_TINT
  return `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><rect width="28" height="28" rx="7" fill="${color}" fill-opacity="0.18"/><g transform="translate(5 5) scale(0.75)"><path d="${path}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`
}

export const iconGlyph = (name: string) => iconOf(name)?.[2] ?? '◇'

const ATTENTION_BANNER = '#ba7517'
const OTHER_BANNER = '#5f5e5a'
const ON_BANNER = '#ffffff'
// At most this many command buttons on a card.
const MAX_CMDS = 3

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sid = await $.session.id()
    await $.command.register({ name: 'mods', description: 'Open the Mods pane: every mod you have, with on/off switches', immediate: true })
    $.clock.every(RESCAN_MS, () => {
      void (async () => {
        if (await isPaneOpen($)) await rescan($)
      })()
    })
    return next(e)
  })

  on('command.run', { command: 'mods' }, async $ => {
    await openPane($)
    return { text: 'Opened the Mods pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const cols = Math.max(30, e.props.bodyColumns)
    const all = await read($, mods)
    const start = await read($, atStart)
    const running = await read($, busy)
    const msg = await read($, note)
    const withPlugins = await read($, showPlugins)
    const isReady = await read($, scanned)
    if (!isReady) void rescan($)

    const modRows = all.filter(r => r.kind === 'mod')
    const others = all.filter(r => r.kind === 'plugin')
    const onCount = modRows.filter(r => r.isEnabled).length

    const isSwitchable = (r: ModRow) => r.where === 'installed'
    // Switched since this chat started: the change lands in the next chat.
    const isPending = (r: ModRow) => isSwitchable(r) && start[r.id] !== undefined && start[r.id] !== r.isEnabled
    const hasUpdate = (r: ModRow) => Boolean(r.latest) && isSwitchable(r)
    const attention = all.filter(r => hasUpdate(r) || isPending(r))
    const updates = all.filter(hasUpdate).length

    const icon = (r: ModRow) =>
      Svg ? (
        <Svg source={iconSvg(r.name, r.isEnabled)} alt={`${r.title} icon`} width={28} height={28} />
      ) : (
        <Text color={r.isEnabled ? tintOf(r.name) : undefined} dimColor={!r.isEnabled || undefined}>
          {iconGlyph(r.name)}
        </Text>
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

    // One line in "Needs a look": what changed and the button that settles it.
    const attentionRow = (r: ModRow) => {
      const isBusy = running === r.id
      const wasOn = start[r.id]
      const why = hasUpdate(r) ? `v${r.latest} ready` : r.isEnabled ? 'On from your next chat' : 'Off from your next chat'
      const room = Math.max(10, cols - 12 - r.title.length)
      return (
        <Box key={`att-${r.id}`} flexDirection="row" gap={1} marginTop={1} paddingX={1} alignItems="center">
          <Box flexDirection="row" gap={1} flexGrow={1}>
            <Text bold>{clip(r.title, Math.max(8, cols - 22))}</Text>
            <Text color={hasUpdate(r) ? ACCENT : WARN} wrap="truncate-end">
              {clip(why, room)}
            </Text>
          </Box>
          {isBusy ? (
            <Text color={WARN}>…</Text>
          ) : hasUpdate(r) ? (
            <Button key={`up-${r.id}`} label="Update" onPress={() => act($, r, 'update')} />
          ) : (
            <Button key={`undo-${r.id}`} label="Undo" onPress={() => act($, r, wasOn ? 'enable' : 'disable')} />
          )}
        </Box>
      )
    }

    // One mod as a card: icon tile | title, version, what it does | the switch; its commands below.
    const card = (r: ModRow) => {
      const isBusy = running === r.id
      const wasOn = start[r.id]
      // Its commands run only where it is loaded: on now and on when this chat started.
      const cmds = r.isEnabled && wasOn !== false ? r.commands.slice(0, MAX_CMDS) : []
      // The card's border and padding, the icon and the switch.
      const left = Math.max(10, cols - 4 - (Svg ? 5 : 2) - (isSwitchable(r) ? 7 : 0))
      const version = r.version ? ` v${r.version}` : ''
      const origin = r.where === 'chat' ? 'This chat only' : r.where === 'folder' ? 'From a plugin folder' : ''
      const flip = () => act($, r, r.isEnabled ? 'disable' : 'enable')
      return (
        <Box
          key={`card-${r.id}`}
          flexDirection="column"
          marginTop={1}
          borderStyle="round"
          borderColor={hasUpdate(r) ? ACCENT : undefined}
          borderDimColor={hasUpdate(r) ? undefined : true}
          paddingX={1}
        >
          <Box flexDirection="row" gap={1} alignItems="flex-start">
            {icon(r)}
            <Box flexDirection="column" flexGrow={1} width={left}>
              <Box flexDirection="row">
                <Text bold dimColor={!r.isEnabled || undefined} wrap="truncate-end">
                  {clip(r.title, left)}
                </Text>
                {version && r.title.length + version.length <= left ? <Text dimColor>{version}</Text> : null}
              </Box>
              {r.description ? (
                <Text dimColor wrap="truncate-end">
                  {clip(r.description, left)}
                </Text>
              ) : null}
              {isPending(r) ? (
                <Text color={WARN} wrap="truncate-end">
                  {clip(r.isEnabled ? 'On from your next chat' : 'Off from your next chat', left)}
                </Text>
              ) : hasUpdate(r) ? (
                <Text color={ACCENT} wrap="truncate-end">
                  {clip(`v${r.latest} available`, left)}
                </Text>
              ) : origin ? (
                <Text dimColor italic wrap="truncate-end">
                  {clip(origin, left)}
                </Text>
              ) : null}
            </Box>
            {isSwitchable(r) ? (
              isBusy ? (
                <Text color={WARN}>…</Text>
              ) : Svg ? (
                <Button key={`sw-${r.id}`} dimColor={!r.isEnabled} label={r.isEnabled ? 'On' : 'Off'} onPress={flip} />
              ) : (
                <Button key={`sw-${r.id}`} plain label={r.isEnabled ? '● On' : '○ Off'} onPress={flip} />
              )
            ) : null}
          </Box>
          {cmds.length ? (
            <Box flexDirection="row" gap={1} marginTop={Svg ? 1 : 0} paddingLeft={Svg ? 5 : 2}>
              {cmds.map(c =>
                // A desktop Button takes `plain` only as true; there it stays a full button.
                Svg ? (
                  <Button key={`cmd-${r.id}-${c}`} label={clip(`▶ /${short(c)}`, left)} onPress={() => runCommand($, c)} />
                ) : (
                  <Button key={`cmd-${r.id}-${c}`} plain label={clip(`▶ /${short(c)}`, left)} onPress={() => runCommand($, c)} />
                ),
              )}
            </Box>
          ) : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={cols}>
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text bold>{isReady ? 'Mods' : 'Looking for mods…'}</Text>
          <Button key="refresh" plain dimColor label="↻ Refresh" onPress={() => rescan($)} />
        </Box>
        {isReady ? (
          <Box flexDirection="row" gap={1} marginTop={1}>
            {tile('t-mods', 'Mods', String(modRows.length))}
            {tile('t-on', 'On', String(onCount))}
            {tile('t-up', 'Updates', String(updates), updates ? ACCENT : undefined)}
          </Box>
        ) : null}
        {attention.length ? (
          <Box flexDirection="column">
            {banner('h-attention', ATTENTION_BANNER, 'Needs a look', <Text color={ON_BANNER}>{String(attention.length)}</Text>)}
            {attention.map(attentionRow)}
          </Box>
        ) : null}
        {isReady && !modRows.length ? <Text dimColor>No mods found.</Text> : null}
        {modRows.map(card)}
        {others.length ? (
          <Box flexDirection="column">
            {banner(
              'h-plugins',
              OTHER_BANNER,
              `Other plugins (${others.length})`,
              <Button key="plugins" plain label={withPlugins ? '▾ Hide' : '▸ Show'} onPress={() => update($, showPlugins, v => !v)} />,
            )}
            {withPlugins ? others.map(card) : null}
          </Box>
        ) : null}
        <Box flexDirection="column" marginTop={1}>
          {msg ? (
            <Text color={OK} wrap="wrap">
              {msg}
            </Text>
          ) : null}
          <Text dimColor wrap="wrap">
            On and Off take effect in new chats. This chat keeps what it started with.
          </Text>
        </Box>
      </Box>
    )
  })
}
