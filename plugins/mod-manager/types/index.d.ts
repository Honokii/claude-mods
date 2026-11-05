// One plugin the pane lists.
export type ModRow = {
  // name@marketplace for an installed one; the folder for the others.
  id: string
  name: string
  title: string
  version: string
  description: string
  // installed: from a marketplace, switchable. chat: this chat's dev-mods. folder: CLAUDE_CODE_PLUGIN_DIRS.
  where: 'installed' | 'chat' | 'folder'
  // mod: has a hooks module. plugin: skills, commands, agents only.
  kind: 'mod' | 'plugin'
  // user, project, local or synced.
  scope: string
  isEnabled: boolean
  // A newer version in its marketplace; '' when none is known.
  latest: string
  // Its slash commands, without the slash.
  commands: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'mod-manager': {
      mods: Shaped<ModRow[]>
      // Enabled or not when this session started, by id: what is loaded now.
      atStart: Shaped<Record<string, boolean>>
      // The id an action is running for; '' for none.
      busy: string
      note: string
      // True once a scan finished.
      scanned: boolean
      showPlugins: boolean
    }
  }
}
