export type AgentDef = {
  name: string
  description: string
  tools: string
  model: string
  // 'user' for ~/.claude/agents, 'project' for <cwd>/.claude/agents.
  scope: 'user' | 'project'
  file: string
}

// One subagent run in this session, any agent type, the pane's own included.
export type Run = {
  id: string
  type: string
  description: string
  model: string
  startedAt: number
  endedAt: number | null
  status: 'running' | 'done' | 'failed'
  tools: number
  // Model requests it has made so far.
  steps: number
  // The size of its last request, input and output tokens together.
  tokens: number
  // The tool it is running now, or ran last, in a few words.
  lastTool: string
  // Its last few tool calls in a few words each, newest last.
  recent: string[]
  // The start of its final answer once done.
  answer: string
  // Started from the pane's run button.
  isFromPane: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'my-agents': {
      defs: Shaped<AgentDef[]>
      runs: Shaped<Run[]>
      // The finished run whose answer is shown; '' for none.
      expanded: string
      isRunningCollapsed: boolean
      isFinishedCollapsed: boolean
      // Bumped once a second while a run is going, so timers redraw.
      now: number
    }
  }
}
