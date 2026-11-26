import type { SessionRow, SessionSnapshot, WorkspaceRow } from './protocol'

/** Sessions in `workspaceId` known to have finished, whatever runs them. */
export function selectDone(sessions: readonly SessionRow[], workspaceId: string): SessionRow[] {
  return sessions.filter(
    (session) => session.workspaceId === workspaceId && session.stateKnown && session.state === 'done'
  )
}

/** Whether this row has a live thing to close: a terminal, or a matched agent process. */
export function isRunning(session: SessionRow): boolean {
  return session.terminalId !== null || session.process === 'running'
}

/**
 * What 「回收空闲」 closes in one workspace: finished sessions with known `done` state and a live
 * process this plugin can address — a terminal, or a chat verified via lease / CLI id. Working
 * sessions or `stateKnown: false` memory-only rows are never selected.
 */
export function selectIdle(sessions: readonly SessionRow[], workspaceId: string): SessionRow[] {
  return selectDone(sessions, workspaceId).filter(
    (session) =>
      isRunning(session) &&
      (session.terminalId !== null || session.sessionId !== null || session.orcaSessionId !== null)
  )
}

export type SessionGroup = { workspace: WorkspaceRow; sessions: SessionRow[] }

/**
 * Sessions grouped by workspace: focused workspace first, then workspaces with at least one
 * running session, then stopped-only workspaces, preserving `workspace.list` order within each
 * bucket; empty ones drop out.
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
    } else if (sessions.some(isRunning)) {
      active.push(group)
    } else {
      stoppedOnly.push(group)
    }
  }
  return focused ? [focused, ...active, ...stoppedOnly] : [...active, ...stoppedOnly]
}
