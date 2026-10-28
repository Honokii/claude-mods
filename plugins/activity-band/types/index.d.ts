export type RunningAgent = {
  id: string
  type: string
  description: string
  startedAt: number
}

// One step of the task list Claude keeps while it works.
export type PlanStep = { title: string; status: 'pending' | 'in_progress' | 'completed' }

export type Live = {
  isBusy: boolean
  turnStartedAt: number
  // The main loop's tool running now, if any.
  tool: string | null
  detail: string
  toolSince: number
  toolCount: number
  agents: RunningAgent[]
  last: { seconds: number; tools: number } | null
  plan: PlanStep[]
}

export type Stats = {
  turn: number
  // Output tokens a second of the last response; null before one is measured.
  speed: number | null
  // Session cost at the start of the turn, and now.
  costAtStart: number
  total: number
  // When the prompt cache from the last answer runs out; null before one.
  cacheExpiresAt: number | null
}

// The context window as /context breaks it down, kept small for drawing.
export type ContextRow = { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }

export type Ctx = {
  total: number
  max: number
  percent: number
  compactAt: number | null
  rows: ContextRow[]
}

declare module 'claude-code' {
  interface PluginState {
    'activity-band': {
      live: Shaped<Live>
      stats: Shaped<Stats>
      isHidden: boolean
      now: number
      ctx: Shaped<Ctx | null>
    }
  }
}
