// One changed file, as `git status` reports it.
export type FileRow = {
  // Relative to the repo's top folder, with forward slashes.
  path: string
  // The old path of a rename or copy; '' otherwise.
  from: string
  // The status letter shown: M, A, D, R, C, T, U (conflict) or ? (untracked).
  status: string
  where: 'staged' | 'unstaged' | 'untracked' | 'conflict'
  // Lines added and removed; -1 for a binary file or when unknown.
  added: number
  removed: number
}

export type Commit = {
  hash: string
  parents: string[]
  author: string
  // ISO 8601, from the author date.
  date: string
  // Branch and tag names on it, as `git log %D` lists them.
  refs: string[]
  subject: string
  body: string
}

// What one scan of a repo found.
export type Snapshot = {
  // The repo's top folder, forward slashes; '' when the folder is no repo.
  root: string
  // The branch checked out; '' when HEAD is detached.
  branch: string
  // The upstream branch (origin/main); '' when none.
  upstream: string
  ahead: number
  behind: number
  files: FileRow[]
  // The branch compared against (main or master); '' when none or it is the one checked out.
  base: string
  baseAhead: number
  baseBehind: number
  // The commits on this branch that the base does not have, newest first (at most 10).
  baseCommits: Commit[]
  // Files changed, lines added and removed since the branch left the base.
  baseFiles: number
  baseAdded: number
  baseRemoved: number
  // The newest commits from HEAD, newest first.
  commits: Commit[]
  // Every commit reachable from HEAD.
  total: number
  // Local branch names.
  branches: string[]
  // What went wrong, when the scan failed.
  error: string
}

// One repo the switcher lists.
export type RepoRow = {
  // The repo's top folder, forward slashes.
  path: string
  // session: the session folder's. worktree: another worktree of it. inside: a repo in a
  // subfolder of a session folder that is no repo itself. added: by /git add.
  kind: 'session' | 'worktree' | 'inside' | 'added'
  // An added repo that is gone or no longer a repo.
  isMissing: boolean
}

// One repo's card in the overview of a folder holding several repos.
export type RepoSummary = {
  path: string
  branch: string
  upstream: string
  ahead: number
  behind: number
  // Files with any change, and files with staged changes.
  changed: number
  staged: number
  // The newest commit's author date, ISO 8601; '' when none.
  last: string
  // What went wrong reading it; '' when nothing.
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    'git-pane': {
      snap: Shaped<Snapshot | null>
      // The repo the pane shows; '' for the session folder's.
      repo: string
      // The repos the switcher lists: the session folder's, its worktrees, then the added ones.
      repos: Shaped<RepoRow[]>
      // True when the session folder is no repo but holds repos (or repos were added):
      // the pane then opens on the overview.
      isMulti: boolean
      // The overview's cards, one per listed repo.
      overview: Shaped<RepoSummary[]>
      // Files Claude's Edit, Write and NotebookEdit calls touched in this chat, absolute, forward slashes.
      edits: Shaped<string[]>
      // What is running ('pull', 'stage:<path>'…); '' for nothing.
      busy: string
      note: string
      // An action waiting for Yes: 'discard:<path>', 'delete:<path>' or 'switch:<branch>'; '' for none.
      confirm: string
      // The commit whose description is open; '' for none.
      open: string
      // How many commits the history shows.
      limit: number
      showRepos: boolean
      showBranches: boolean
    }
  }
}
