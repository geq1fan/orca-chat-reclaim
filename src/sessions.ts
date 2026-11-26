import type { SessionRow, SessionSnapshot, WorkspaceRow } from './protocol'

/** Sessions in `workspaceId` that finished, whatever runs them. */
export function selectDone(sessions: readonly SessionRow[], workspaceId: string): SessionRow[] {
  return sessions.filter(
    (session) => session.workspaceId === workspaceId && session.state === 'done'
  )
}

/**
 * What 「回收空闲」 closes in one workspace: finished sessions this plugin can address, by a
 * terminal or by their provider session id. A finished chat whose process already exited has
 * nothing to close, and an unknown process state (`null`) is still attempted. `excludedSessionId`
 * is the chat the panel's user is in, which must never be reclaimed.
 */
export function selectIdle(
  sessions: readonly SessionRow[],
  workspaceId: string,
  excludedSessionId: string | null = null
): SessionRow[] {
  return selectDone(sessions, workspaceId).filter(
    (session) =>
      (excludedSessionId === null || session.sessionId !== excludedSessionId) &&
      (session.terminalId !== null ||
        (session.sessionId !== null && session.hasProcess !== false))
  )
}

/**
 * The chat the panel's user is most likely in: the one that went idle most recently in this
 * workspace. The host API never says which chat a panel belongs to, so this is the proxy that
 * keeps 「回收空闲」 from stopping the conversation the owner is having.
 */
export function mostRecentIdle(
  sessions: readonly SessionRow[],
  workspaceId: string
): SessionRow | null {
  let newest: SessionRow | null = null
  for (const session of selectDone(sessions, workspaceId)) {
    // A chat, not a terminal pane, and one that still has a process to stop.
    if (session.terminalId !== null || session.hasProcess === false) continue
    if (!newest || session.stateStartedAt > newest.stateStartedAt) newest = session
  }
  return newest
}

export type SessionGroup = { workspace: WorkspaceRow; sessions: SessionRow[] }

/**
 * Sessions grouped by workspace: focused workspace first, then workspaces with at least one running
 * session (`hasProcess !== false`), then stopped-only workspaces, preserving `workspace.list` order
 * within each bucket; empty ones drop out.
 */
export function groupSessions(snapshot: SessionSnapshot): SessionGroup[] {
  const byWorkspace = new Map<string, SessionRow[]>()
  for (const session of snapshot.sessions) {
    const rows = byWorkspace.get(session.workspaceId)
    if (rows) rows.push(session)
    else byWorkspace.set(session.workspaceId, [session])
  }
  let focused: SessionGroup | null = null
  const active: SessionGroup[] = []
  const stoppedOnly: SessionGroup[] = []
  for (const workspace of snapshot.workspaces) {
    const sessions = byWorkspace.get(workspace.id)
    if (!sessions) continue
    const group: SessionGroup = { workspace, sessions }
    if (workspace.id === snapshot.currentWorkspaceId) {
      focused = group
    } else if (sessions.some((session) => session.hasProcess !== false)) {
      active.push(group)
    } else {
      stoppedOnly.push(group)
    }
  }
  return focused ? [focused, ...active, ...stoppedOnly] : [...active, ...stoppedOnly]
}