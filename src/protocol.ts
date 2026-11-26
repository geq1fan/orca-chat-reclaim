// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export {}

export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'

/** What `ps` says about a chat session's process; see `SessionRow.process`. */
export type ProcessState = 'running' | 'unknown' | 'stopped'

/** One agent session as `agents.list` reports it, tagged with the workspace it lives in. */
export type SessionRow = {
  workspaceId: string
  workspaceName: string
  workspaceKind: 'worktree' | 'folder'
  /**
   * The terminal that runs the session. Chat sessions are structured agent sessions, not
   * terminals: Orca reports `null` for them, and `terminal.close` cannot address them.
   */
  terminalId: string | null
  title: string
  agent: string
  state: AgentState
  stateStartedAt: number
  sessionId: string | null
  /**
   * The process side of a chat session: `running` when a live claude carries one of its candidate
   * ids (both `--session-id=` and `--resume=` count), `unknown` when it has ids but none of them
   * matched (or `ps` could not be read), `stopped` only when it has no id a process could carry.
   * Null for terminal-backed sessions, which are addressed by their terminal instead.
   */
  process: ProcessState | null
  /**
   * The candidate id whose claude process matched. The row shows this id, and looks its title up
   * by the same id, so a rewind cannot pair one conversation's title with another's process.
   */
  matchedId: string | null
}

export type WorkspaceRow = {
  id: string
  name: string
  kind: 'worktree' | 'folder'
  terminalCount: number | null
}

export type SessionSnapshot = {
  workspaces: WorkspaceRow[]
  sessions: SessionRow[]
  currentWorkspaceId: string | null
  /** True when Orca cut the workspace list short, so the counts below are a floor. */
  workspacesTruncated: boolean
  /** Workspaces whose `agents.list` was refused or failed; their sessions are missing. */
  failedWorkspaces: number
  /** The newest first: what this plugin last tried to close, and how it went. */
  recentOps: OpRecord[]
}

export type CloseOutcome = {
  ok: boolean
  workspaceId: string
  sessionId: string | null
  /** `terminal` closed the terminal; `signal` sent SIGTERM to the provider's process group. */
  how: 'terminal' | 'signal' | null
  dryRun: boolean
  /** Why it was refused, when `ok` is false. */
  code?: string
  message?: string
  terminalId?: string
  /** The `--resume=` id of the process that was found. */
  sessionUuid?: string
  pid?: number
  pgid?: number
  /** What started the process; the dry run reports it so the chain is verifiable. */
  parentArgs?: string
}

/** One entry in the plugin's recent-operations log, kept in `orca.storage`. */
export type OpRecord = {
  at: number
  ok: boolean
  dryRun: boolean
  kind: 'terminal' | 'signal'
  title: string
  sessionId: string | null
  terminalId: string | null
  sessionUuid: string | null
  pid: number | null
  pgid: number | null
  message: string | null
}

export type ReclaimResult = {
  outcomes: CloseOutcome[]
  /** True when a close failed and the remaining idle sessions were left alone. */
  stoppedAtFailure: boolean
}

declare module 'orca' {
  interface PluginRequests {
    /**
     * Every workspace and the agent sessions running in them, plus the recent-operations log.
     * `refreshTitles` rebuilds the chat-title map from Orca's CLI instead of using a cached one.
     */
    'sessions.list': {
      input: { refreshTitles?: boolean }
      output: SessionSnapshot
    }
    /** Stops one session; only a `done` session is accepted. */
    'sessions.close': {
      input: { workspaceId: string; sessionId?: string | null; terminalId?: string | null; dryRun?: boolean }
      output: CloseOutcome
    }
    /** Closes every session in `workspaceId` whose state is `done`, one at a time. */
    'sessions.reclaim': {
      input: { workspaceId: string; dryRun?: boolean }
      output: ReclaimResult
    }
  }
}