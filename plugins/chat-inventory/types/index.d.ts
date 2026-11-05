// One call a connector made.
export type Call = {
  // The tool in words: "search threads".
  tool: string
  // Its main argument, short: a query, an id, a file name.
  arg: string
  // Milliseconds since the epoch; 0 when it came from before the mod loaded.
  at: number
}

// One connector (an MCP server), with its calls, newest last.
export type Connector = {
  // The server as it appears in tool names, so two unnamed servers stay apart.
  server: string
  name: string
  count: number
  // Order of last use: higher is newer.
  seq: number
  calls: Call[]
}

export type FileRow = {
  path: string
  // A memory file the chat loaded at start (CLAUDE.md, MEMORY.md).
  isAuto: boolean
  seq: number
}

export type SkillRow = {
  name: string
  count: number
  seq: number
}

export type Inventory = {
  connectors: Connector[]
  files: FileRow[]
  skills: SkillRow[]
}

export type Step = {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
  // TaskCreate's id, so TaskUpdate finds the step.
  id?: string
}

declare module 'claude-code' {
  interface PluginState {
    'chat-inventory': {
      inv: Shaped<Inventory>
      plan: Shaped<Step[]>
      // The connector server whose calls are shown; '' for none.
      open: string
      // Sections closed with their header arrow.
      folded: string[]
      // Sections showing every row instead of the first few.
      expanded: string[]
    }
  }
}
