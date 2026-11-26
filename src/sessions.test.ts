import { assert, test } from 'orca/testing'
import type { SessionRow, SessionSnapshot } from './protocol'
import { groupSessions, mostRecentIdle, selectDone, selectIdle } from './sessions'

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
    hasProcess: null,
    ...overrides
  }
}

test('selectIdle keeps finished sessions this plugin can address', () => {
  const sessions = [
    row({ terminalId: 'done-1', sessionId: null }),
    row({ terminalId: null, sessionId: 'chat-1' }),
    row({ terminalId: null, sessionId: 'chat-exited', hasProcess: false }),
    row({ terminalId: null, sessionId: null }),
    row({ terminalId: 'working-1', state: 'working' }),
    row({ terminalId: 'blocked-1', state: 'blocked' }),
    row({ terminalId: 'waiting-1', state: 'waiting' }),
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
    row({ terminalId: null, sessionId: 'chat-1' }),
    row({ terminalId: null, sessionId: 'chat-2', state: 'working' }),
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
      { id: 'w1', name: '工作区一', kind: 'worktree', terminalCount: 2 },
      { id: 'w2', name: '工作区二', kind: 'folder', terminalCount: 1 },
      { id: 'w3', name: '工作区三', kind: 'folder', terminalCount: 0 }
    ],
    sessions: [
      row({ terminalId: 'a' }),
      row({ terminalId: 'b' }),
      row({ terminalId: null, workspaceId: 'w2', workspaceName: '工作区二' })
    ],
    currentWorkspaceId: 'w2',
    workspacesTruncated: false,
    failedWorkspaces: 0,
    recentOps: [],
    currentSessionId: null
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
test('selectIdle never takes the chat the panel is in, nor a working one', () => {
  const sessions = [
    row({ terminalId: 'current', sessionId: 'provider-current' }),
    row({ terminalId: 'other' }),
    row({ terminalId: 'busy', state: 'working' })
  ]

  assert.deepEqual(
    selectIdle(sessions, 'w1', 'provider-current').map((session) => session.terminalId),
    ['other']
  )
})

test('mostRecentIdle is the newest finished chat that still has a process', () => {
  const sessions = [
    row({ terminalId: null, sessionId: 'old', stateStartedAt: 100, hasProcess: true }),
    row({ terminalId: null, sessionId: 'new', stateStartedAt: 300, hasProcess: true }),
    row({ terminalId: null, sessionId: 'busy', state: 'working', stateStartedAt: 400 }),
    row({ terminalId: null, sessionId: 'dead', stateStartedAt: 500, hasProcess: false }),
    row({ terminalId: 'terminal', stateStartedAt: 600 })
  ]

  assert.equal(mostRecentIdle(sessions, 'w1')?.sessionId, 'new')
  assert.equal(mostRecentIdle(sessions, 'w2'), null)
})

test('groupSessions puts focused workspace first, then active workspaces, then stopped-only', () => {
  const snapshot: SessionSnapshot = {
    workspaces: [
      { id: 'stopped-1', name: '已停一', kind: 'folder', terminalCount: 0 },
      { id: 'active-1', name: '运行一', kind: 'worktree', terminalCount: 1 },
      { id: 'stopped-2', name: '已停二', kind: 'folder', terminalCount: 0 },
      { id: 'focused-stopped', name: '当前停', kind: 'folder', terminalCount: 0 },
      { id: 'active-2', name: '运行二', kind: 'folder', terminalCount: 0 }
    ],
    sessions: [
      row({ workspaceId: 'stopped-1', terminalId: null, hasProcess: false }),
      row({ workspaceId: 'active-1', terminalId: 't1', hasProcess: null }),
      row({ workspaceId: 'stopped-2', terminalId: null, hasProcess: false }),
      row({ workspaceId: 'focused-stopped', terminalId: null, hasProcess: false }),
      row({ workspaceId: 'active-2', terminalId: null, hasProcess: true })
    ],
    currentWorkspaceId: 'focused-stopped',
    workspacesTruncated: false,
    failedWorkspaces: 0,
    recentOps: [],
    currentSessionId: null
  }

  assert.deepEqual(
    groupSessions(snapshot).map((group) => group.workspace.id),
    ['focused-stopped', 'active-1', 'active-2', 'stopped-1', 'stopped-2']
  )
})
