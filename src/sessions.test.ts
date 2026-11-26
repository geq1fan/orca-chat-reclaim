import { assert, test } from 'orca/testing'
import type { SessionRow, SessionSnapshot } from './protocol'
import { groupSessions, selectDone, selectIdle } from './sessions'

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    workspaceId: 'w1',
    workspaceName: '工作区一',
    workspaceKind: 'worktree',
    terminalId: 't1',
    title: 'Claude',
    agent: 'claude',
    state: 'done',
    stateStartedAt: 1000,
    sessionId: 'session-1',
    process: null,
    matchedId: null,
    pairing: null,
    matchedPid: null,
    matchedPgid: null,
    processNote: null,
    ...overrides
  }
}

test('selectIdle keeps finished sessions that have a terminal or a matched process', () => {
  const sessions = [
    row({ terminalId: 'done-1', sessionId: null }),
    row({ terminalId: null, sessionId: 'chat-1', process: 'running', matchedId: 'chat-1' }),
    // Ids exist but none matched: not a licence to guess, and nothing to signal.
    row({ terminalId: null, sessionId: 'chat-unknown', process: 'unknown' }),
    row({ terminalId: null, sessionId: null, process: 'stopped' }),
    row({ terminalId: 'working-1', state: 'working' }),
    row({ terminalId: null, sessionId: 'working-chat', process: 'running', state: 'working' }),
    row({ terminalId: 'other-workspace', workspaceId: 'w2' })
  ]
  assert.deepEqual(
    selectIdle(sessions, 'w1').map((session) => `${session.terminalId}/${session.sessionId}`),
    ['done-1/null', 'null/chat-1']
  )
  assert.deepEqual(selectIdle(sessions, 'w3'), [])
})

test('selectDone counts finished chats that have no terminal too', () => {
  const sessions = [
    row({ terminalId: null, sessionId: 'chat-1', process: 'running' }),
    row({ terminalId: null, sessionId: 'chat-2', process: 'running', state: 'working' }),
    row({ terminalId: 'done-1' })
  ]
  assert.deepEqual(
    selectDone(sessions, 'w1').map((session) => session.sessionId),
    ['chat-1', 'session-1']
  )
  assert.deepEqual(
    selectIdle(sessions, 'w1').map((session) => session.sessionId),
    ['chat-1', 'session-1']
  )
})

test('groupSessions puts the focused workspace first and drops empty ones', () => {
  const snapshot: SessionSnapshot = {
    workspaces: [
      { id: 'w1', name: '工作区一', kind: 'worktree', path: null, terminalCount: 2 },
      { id: 'w2', name: '工作区二', kind: 'folder', path: null, terminalCount: 1 },
      { id: 'w3', name: '工作区三', kind: 'folder', path: null, terminalCount: 0 }
    ],
    sessions: [
      row({ terminalId: 'a' }),
      row({ terminalId: 'b' }),
      row({ terminalId: null, workspaceId: 'w2', workspaceName: '工作区二' })
    ],
    currentWorkspaceId: 'w2',
    workspacesTruncated: false,
    failedWorkspaces: 0,
    recentOps: []
  }
  const groups = groupSessions(snapshot)
  assert.deepEqual(
    groups.map((group) => group.workspace.id),
    ['w2', 'w1']
  )
  assert.deepEqual(
    groups.map((group) => group.sessions.length),
    [1, 2]
  )
})

test('groupSessions puts focused first, then active, then workspaces with no running session', () => {
  const snapshot: SessionSnapshot = {
    workspaces: [
      { id: 'stopped-1', name: '已停一', kind: 'folder', path: null, terminalCount: 0 },
      { id: 'active-1', name: '运行一', kind: 'worktree', path: null, terminalCount: 1 },
      { id: 'stopped-2', name: '已停二', kind: 'folder', path: null, terminalCount: 0 },
      { id: 'focused-stopped', name: '当前停', kind: 'folder', path: null, terminalCount: 0 },
      { id: 'active-2', name: '运行二', kind: 'folder', path: null, terminalCount: 0 }
    ],
    sessions: [
      row({ workspaceId: 'stopped-1', terminalId: null, process: 'unknown' }),
      row({ workspaceId: 'active-1', terminalId: 't1', process: null }),
      row({ workspaceId: 'stopped-2', terminalId: null, process: 'stopped' }),
      row({ workspaceId: 'focused-stopped', terminalId: null, process: 'unknown' }),
      row({ workspaceId: 'active-2', terminalId: null, process: 'running' })
    ],
    currentWorkspaceId: 'focused-stopped',
    workspacesTruncated: false,
    failedWorkspaces: 0,
    recentOps: []
  }

  assert.deepEqual(
    groupSessions(snapshot).map((group) => group.workspace.id),
    ['focused-stopped', 'active-1', 'active-2', 'stopped-1', 'stopped-2']
  )
})