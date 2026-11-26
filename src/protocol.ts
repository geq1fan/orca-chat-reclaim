// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export {}

export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'

/** What Orca's session lease and `ps` say about a chat session's process; see `SessionRow.process`. */
export type ProcessState = 'running' | 'unknown' | 'stopped'

/** One agent session as `agents.list` / `diagnostics.memory` reports it, tagged with its workspace. */
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
  /**
   * True when `agents.list` reported the session's live state; false when the session appeared
   * only in `orca diagnostics memory` (e.g. `agents.list` omitted or failed for its workspace),
   * in which case close actions stay disabled to avoid killing an active session blindly.
   */
  stateKnown: boolean
  stateStartedAt: number
  sessionId: string | null
  /** Canonical Orca `session_id` UUID when known; never a filesystem path. */
  orcaSessionId: string | null
  /** Memory usage in bytes reported by `orca diagnostics memory`, or null when unavailable. */
  memoryBytes: number | null
  /**
   * The process side of a chat session: `running` when verified via `agent_session_records.lease`
   * (with `ps` `lstart` anti-PID-reuse check) or via a CLI `--session-id=` / `--resume=` flag;
   * `stopped` when its lease is released and no live process exists; `unknown` when the lease/db/`ps`
   * cannot confirm either way. Null for terminal-backed sessions, addressed by their terminal instead.
   */
  process: ProcessState | null
  /**
   * The provider conversation id the live process carried on its CLI (`--resume=` / `--session-id=`),
   * when present; null for agents whose CLI carries no id (e.g. `pi`, `antigravity`).
   */
  matchedId: string | null
  /** How the process was verified: `lease` via `lease.ownerProcess` + `lstart`, `id` via CLI flag; null when unmatched. */
  pairing: 'lease' | 'id' | null
  /** The verified agent pid/pgid when matched via `lease` (also carried into `sessions.close` against TOCTOU). */
  matchedPid: number | null
  matchedPgid: number | null
  /** Why the process could not be judged, or how it was verified / exited; null when nothing is to say. */
  processNote: string | null
}

export type WorkspaceRow = {
  id: string
  name: string
  kind: 'worktree' | 'folder'
  /** The directory `workspace.list` (or worktree id suffix) gives. */
  path: string | null
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
  /** The conversation id the process answered to, when the agent CLI carries one. */
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
    /**
     * Stops one session; only a `done` session with known state is accepted. When `pid` is
     * provided, the worker re-reads the session's live lease and verifies `ownerProcess.pid`
     * and `ps` `lstart` before signalling it.
     */
    'sessions.close': {
      input: {
        workspaceId: string
        sessionId?: string | null
        terminalId?: string | null
        pid?: number | null
        dryRun?: boolean
      }
      output: CloseOutcome
    }
    /** Closes every session in `workspaceId` whose state is `done`, one at a time. */
    'sessions.reclaim': {
      input: { workspaceId: string; dryRun?: boolean }
      output: ReclaimResult
    }
  }
}
