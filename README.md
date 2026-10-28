# claude-mods

My own Claude Code mods, kept apart from mods installed from other people's
marketplaces. This folder is a local marketplace named `claude-mods`; each mod
is installed from it for my user, so every new session loads them.

| Mod | What it does | How to use it |
| --- | --- | --- |
| `activity-band` | One line above the prompt: the current step's title, a solid progress bar fed by Claude's task list (`Tasks 2/4`, %; green `Done` at the end; `No task list` when there is none) at a fixed size and place, then turn, speed (tok/s), turn and session cost, and the 1-hour prompt cache countdown (amber at 20 min, red at 10, `00:00` when expired), each in a fixed slot. Under it a context card (tokens by category, % used, where auto-compaction starts). | Always on. `×` hides it until the next message. |
| `my-agents` | Pane with tiles (running, finished, time), cards for this session's running and finished subagents (with their answers), and my agents from `~\.claude\agents` and the project's `.claude\agents`. Each agent has a pixel critter (shape and hat from its name, colour from its model) that hops while it runs. | `/my-agents` opens or closes it. ▶ beside an agent sends "Run the <agent> agent…" as your message, and Claude starts it with its defaults. |

## Layout

```
.claude-plugin/marketplace.json   the marketplace: lists the mods
plugins/<mod>/
  .claude-plugin/plugin.json      name, version, description
  hooks/hooks.json                points at register.tsx
  hooks/register.tsx              the mod itself (my-agents also has critters.ts)
  hooks/register.test.tsx         its test
  types/index.d.ts                the $.state values it keeps
```

`.claude-plugin/types/` inside a mod is written by Claude Code (the API types
for the editor). It is ignored by git; don't edit it.

## Changing a mod

Installed mods run from a copy in `~\.claude\plugins\cache\claude-mods\`, so
an edit here does nothing until it is updated:

1. Edit `plugins/<mod>/hooks/register.tsx`.
2. Check it:
   ```
   claude plugin validate plugins/<mod>
   claude plugin test plugins/<mod>
   ```
3. Raise `version` in `plugins/<mod>/.claude-plugin/plugin.json` (0.1.0 → 0.1.1).
4. Update the install:
   ```
   claude plugin marketplace update claude-mods
   claude plugin update <mod>@claude-mods
   ```
5. Start a new session: mods load when a session starts.

The easy way: open a Claude Code session in this folder and ask Claude to change
the mod (it uses the `plugin-authoring` skill and can hot-reload while it works).
To try an edit without installing it, start a terminal session with
`claude --plugin-dir D:\Projects\claude-mods\plugins\<mod>`.

## Turning a mod off or removing it

```
claude plugin disable <mod>@claude-mods
claude plugin enable <mod>@claude-mods
claude plugin uninstall <mod>@claude-mods
```

Removing the whole marketplace: `claude plugin marketplace remove claude-mods`.

## Things learned the hard way

- **Never put `color` and `dimColor` on the same `<Text>` in the band.** The
  desktop app silently drops the whole band; no error is shown anywhere. Use one
  or the other.
- A mod that hot-reloads (while Claude edits it) is not drawn again until the
  next message, so the band vanishes after such a turn. Installed mods don't
  reload, so this doesn't happen in normal use.
- **A mod can't size the desktop's buttons**, and wrapping one in a fixed-size
  box made it vanish. Keep buttons plain `<Button label="…">`.
- **Cut long text to the pane's width yourself** (`e.props.bodyColumns`): the
  desktop lets a row grow past the pane and hides whatever is past the edge,
  buttons included.
- **In auto mode a mod can't start an agent itself** (`$.agent.spawn`): the
  safety check only lets an agent start when one of your messages asked for it.
  So ▶ sends the request with `$.prompt.submit({ text, asUser: true })` and
  Claude spawns the agent. Give every agent defaults, since ▶ passes no values.
- ▶ is a real run: it uses tokens, and an agent like commit-helper really commits.
- **An `<Svg>` is a still image on the desktop** unless it has `isInteractive`;
  only then do its CSS animations play (the running critters use it).
- **Elements side by side above the prompt go on lines of their own** on the
  desktop. To keep one line, draw it as one `<Svg>` (the band's bar and stats
  are one drawing) with at most a Button beside it.
- The band is laid out from the right in fixed slots (stats, percent, bar at
  22% of the width, up to 260px) so nothing jumps as text changes; the title
  gets what's left. Tune `STAT_SLOTS` and the `barW` line in `progressSvg`.
- The band reads the task list from the tool calls that carry it
  (`mcp__ccd_turn__update_plan` in the desktop, `TodoWrite` in the terminal).
  The desktop ticks off the last step inside `mcp__ccd_turn__wrap_up` with no
  plan call, so the band treats that call as "all done".
- The feedback survey ("How is Claude doing…") takes the band's place while it
  shows; mods must give way to it (`e.props.hasSurvey`).
- A mod can't delete files: `$.fs` reads, writes and lists only.
