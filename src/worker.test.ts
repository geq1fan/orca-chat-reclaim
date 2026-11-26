// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
import { afterEach, assert, beforeEach, hostError, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { useSignalOps, useTitleOps } from './worker'
import type { ChatTitleOps } from './botChats'
import type { SignalOps } from './sessionProcess'

afterEach(() => {
  useSignalOps(null)
  useTitleOps(null)
})

beforeEach(() => {
  // `sessions.list` probes the real `ps` and asks the Orca CLI for titles; tests must not touch
  // the machine, so both seams start as harmless fakes.
  fakeOps('')
  useTitleOps({
    bots: async () => [],
    chats: async () => [],
    sessionPairs: async () => []
  })
})

const CLAUDE = '/Users/me/.local/bin/claude'
const PROVIDER = '/Applications/Orca.app/Contents/MacOS/orca-provider-exec'
const S1 = '39e65ad8-b388-4e57-8d80-e3ad8dc791e8'
const S2 = '1d5698f7-3890-4fa9-be15-b096359f32d9'
const S3 = '912da5da-78df-42bb-a5eb-a9427a2d3a67'

const context = { workspaceId: 'w1', branch: 'main', displayName: '工作区一', terminals: [] }

function workspace(id: string, name: string, terminalCount: number) {
  return {
    id,
    kind: 'worktree' as const,
    name,
    path: `/tmp/${id}`,
    branch: 'main',
    hostId: 'local',
    status: { state: 'done' as const, unread: false, terminalCount, lastActivityAt: 1 }
  }
}

function agent(terminalId: string | null, overrides: Record<string, unknown> = {}) {
  return {
    terminalId,
    title: `title-${terminalId ?? 'none'}`,
    agent: 'claude',
    state: 'done' as const,
    stateStartedAt: 1000,
    sessionId: `session-${terminalId ?? 'none'}`,
    ...overrides
  }
}

/** A real chat session: no terminal, no title, only the claude conversation id. */
function chat(sessionId: string, overrides: Record<string, unknown> = {}) {
  return agent(null, { title: null, sessionId, ...overrides })
}

function processTable(entries: { pid: number; resume: string; pgid?: number }[]): string {
  const rows = entries.map(
    ({ pid, resume, pgid }) => `${pid} 800 ${pgid ?? pid} ${CLAUDE} --resume=${resume}\n`
  )
  return `  PID  PPID  PGID COMMAND\n800 700 800 ${PROVIDER} --cli-input-fd7 1000 3000 -- ${CLAUDE}\n${rows.join('')}`
}

/** Installs fake process side effects; returns the pgids they were signalled with. */
function fakeOps(table: string, psError?: string): number[] {
  const signalled: number[] = []
  let clock = 0
  const ops: SignalOps = {
    readHandleChain: async () => null,
    listProcesses: async () => {
      if (psError) throw new Error(psError)
      return table
    },
    signalGroup: (pgid) => {
      signalled.push(pgid)
    },
    isAlive: (pid) => !signalled.includes(pid),
    ownPgid: async () => 1,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    }
  }
  useSignalOps(ops)
  return signalled
}

/** Chat titles that the fake CLI hands back, plus how often each bot was asked. */
function fakeTitles(titles: Record<string, string>, pairs: { sessionId: string; nativeId: string }[] = []) {
  const asked: string[] = []
  const ops: ChatTitleOps = {
    bots: async () => ['小小'],
    chats: async (bot) => {
      asked.push(bot)
      return Object.entries(titles).map(([id, title]) => ({ id, title }))
    },
    sessionPairs: async () => pairs
  }
  useTitleOps(ops)
  return asked
}

function hostWith(agents: unknown[], extra: Record<string, unknown> = {}) {
  return mockHost({
    results: {
      'workspace.list': { workspaces: [workspace('w1', '工作区一', 0)], truncated: false },
      'workspace.readContext': context,
      'agents.list': { agents },
      ...extra
    }
  })
}

test('sessions.list reads every workspace and returns the recent ops', async () => {
  const host = mockHost({
    storage: { recentOps: [{ at: 1, ok: true, dryRun: false, kind: 'signal', title: 't' }] },
    results: {
      // Orca reports terminalCount 0 for a workspace that still holds chat sessions.
      'workspace.list': {
        workspaces: [workspace('w1', '工作区一', 0), workspace('w2', '工作区二', 0), workspace('w3', '工作区三', 2)],
        truncated: false
      },
      'workspace.readContext': context,
      'agents.list': ({ workspaceId }: { workspaceId: string }) => ({
        agents:
          workspaceId === 'w1'
            ? [agent('t1'), agent('t2', { state: 'working' }), agent(null, { title: null, sessionId: S1 })]
            : workspaceId === 'w3'
              ? [agent('t3')]
              : []
      })
    }
  })
  fakeOps(processTable([{ pid: 900, resume: S1 }]))
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list')

  assert.equal(host.callsOf('agents.list').length, 3)
  assert.equal(snapshot.currentWorkspaceId, 'w1')
  assert.equal(snapshot.workspacesTruncated, false)
  assert.equal(snapshot.failedWorkspaces, 0)
  assert.equal(snapshot.recentOps.length, 1)
  // No CLI titles here, so the chat falls back to its id prefix.
  assert.equal(snapshot.sessions[2]?.title, '会话 39e65ad8')
  assert.deepEqual(
    snapshot.sessions.map((session) => [session.workspaceId, session.terminalId, session.state]),
    [
      ['w1', 't1', 'done'],
      ['w1', 't2', 'working'],
      ['w1', null, 'done'],
      ['w3', 't3', 'done']
    ]
  )
  // A chat with no title falls back to its session id, and the list says whether its process
  // is still alive so a history leftover can be greyed before anyone clicks it.
  assert.equal(snapshot.sessions[2]?.title, '会话 39e65ad8')
  assert.equal(snapshot.sessions[2]?.sessionId, S1)
  assert.equal(snapshot.sessions[2]?.hasProcess, true)
  // Terminal-backed sessions do not need a provider process to be closed.
  assert.equal(snapshot.sessions[0]?.hasProcess, null)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('sessions.list counts a refused workspace instead of dropping it silently', async () => {
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [workspace('w1', '工作区一', 0)], truncated: true },
      'workspace.readContext': null,
      'agents.list': () => {
        throw hostError('action_failed', 'no workspace w1')
      }
    }
  })
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list')

  assert.deepEqual(snapshot.sessions, [])
  assert.equal(snapshot.currentWorkspaceId, null)
  assert.equal(snapshot.workspacesTruncated, true)
  assert.equal(snapshot.failedWorkspaces, 1)
  await worker.deactivate()
})

test('closes a done chat by signalling its process group and logs it', async () => {
  const host = hostWith([chat(S1)])
  const signalled = fakeOps(processTable([{ pid: 900, resume: S1 }]))
  const worker = await mountWorker(main, { host })

  const outcome = await worker.request('sessions.close', { workspaceId: 'w1', sessionId: S1 })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.how, 'signal')
  assert.equal(outcome.sessionUuid, S1)
  assert.equal(outcome.pid, 900)
  assert.equal(outcome.pgid, 900)
  assert.deepEqual(signalled, [900])

  const stored = host.data().storage.recentOps as Record<string, unknown>[]
  assert.equal(stored.length, 1)
  assert.equal(stored[0]?.pid, 900)
  assert.equal(stored[0]?.pgid, 900)
  assert.equal(stored[0]?.sessionUuid, S1)
  assert.equal(stored[0]?.title, '会话 39e65ad8')
  assert.equal(stored[0]?.ok, true)
  await worker.deactivate()
})

test('refuses a session that is not done without touching its process', async () => {
  const host = hostWith([chat(S1, { state: 'working' })])
  const signalled = fakeOps(processTable([{ pid: 900, resume: S1 }]))
  const worker = await mountWorker(main, { host })

  const outcome = await worker.request('sessions.close', { workspaceId: 'w1', sessionId: S1 })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'not_idle')
  assert.match(outcome.message ?? '', /运行中/)
  assert.deepEqual(signalled, [])
  assert.equal(host.callsOf('terminal.close').length, 0)
  // A refusal is still an attempt: it lands in the log so the panel can show it.
  const stored = host.data().storage.recentOps as Record<string, unknown>[]
  assert.equal(stored.length, 1)
  assert.equal(stored[0]?.ok, false)
  assert.match(String(stored[0]?.message), /运行中/)
  await worker.deactivate()
})

test('reports a refusal when no claude process matches the session', async () => {
  const host = hostWith([chat(S1)])
  const signalled = fakeOps(processTable([]))
  const worker = await mountWorker(main, { host })

  const outcome = await worker.request('sessions.close', { workspaceId: 'w1', sessionId: S1 })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'no_process')
  assert.deepEqual(signalled, [])
  await worker.deactivate()
})

test('closes a terminal-backed session through the terminal API', async () => {
  const host = hostWith([agent('t1', { title: '终端会话' })], {
    'terminal.focus': { focused: true },
    'terminal.close': { closed: true }
  })
  const signalled = fakeOps('')
  const worker = await mountWorker(main, { host })

  const outcome = await worker.request('sessions.close', {
    workspaceId: 'w1',
    sessionId: 'session-t1',
    terminalId: 't1'
  })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.how, 'terminal')
  assert.deepEqual(signalled, [])
  assert.deepEqual(
    host.calls
      .filter((call) => call.method.startsWith('terminal.'))
      .map((call) => [call.method, call.params]),
    [
      ['terminal.focus', { terminalId: 't1' }],
      ['terminal.close', { terminalId: 't1' }]
    ]
  )
  await worker.deactivate()
})

test('sessions.reclaim skips the chat the panel is in and closes the rest', async () => {
  // S1 went idle most recently, so it is the chat the owner is in and must survive.
  const host = hostWith([
    chat(S1, { stateStartedAt: 3000 }),
    chat(S2, { state: 'working', stateStartedAt: 4000 }),
    chat(S3, { stateStartedAt: 1000 })
  ])
  const signalled = fakeOps(
    processTable([
      { pid: 900, resume: S1 },
      { pid: 902, resume: S3 }
    ])
  )
  const worker = await mountWorker(main, { host })

  const result = await worker.request('sessions.reclaim', { workspaceId: 'w1' })

  assert.deepEqual(
    result.outcomes.map((outcome) => [outcome.sessionId, outcome.ok]),
    [[S3, true]]
  )
  assert.deepEqual(result.skipped, { sessionId: S1, title: '会话 39e65ad8' })
  assert.equal(result.stoppedAtFailure, false)
  assert.deepEqual(signalled, [902])
  await worker.deactivate()
})

test('sessions.reclaim stops at the first refusal', async () => {
  // S1 is the owner's chat (newest); S2 exists but is not its own group leader.
  const host = hostWith([
    chat(S1, { stateStartedAt: 3000 }),
    chat(S2, { stateStartedAt: 1000 }),
    chat(S3, { stateStartedAt: 2000 })
  ])
  const signalled = fakeOps(
    processTable([
      { pid: 900, resume: S1 },
      { pid: 901, resume: S2, pgid: 800 },
      { pid: 903, resume: S3 }
    ])
  )
  const worker = await mountWorker(main, { host })

  const result = await worker.request('sessions.reclaim', { workspaceId: 'w1' })

  assert.equal(result.outcomes.length, 1)
  assert.equal(result.outcomes[0]?.ok, false)
  assert.equal(result.outcomes[0]?.code, 'not_group_leader')
  assert.equal(result.stoppedAtFailure, true)
  assert.deepEqual(result.skipped, { sessionId: S1, title: '会话 39e65ad8' })
  assert.deepEqual(signalled, [])
  await worker.deactivate()
})
test('sessions.list marks a chat whose process already exited', async () => {
  const host = hostWith([chat(S1), chat(S2)])
  fakeOps(processTable([{ pid: 900, resume: S1 }]))
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list')

  assert.equal(snapshot.sessions[0]?.hasProcess, true)
  assert.equal(snapshot.sessions[1]?.hasProcess, false)
  await worker.deactivate()
})

test('sessions.list leaves hasProcess unknown when ps cannot be read', async () => {
  const host = hostWith([chat(S1)])
  fakeOps('', 'ps: operation not permitted')
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list')

  assert.equal(snapshot.sessions[0]?.hasProcess, null)
  assert.deepEqual(snapshot.sessions.map((session) => session.sessionId), [S1])
  await worker.deactivate()
})

test('sessions.list shows the chat title from the bot list and caches it for a minute', async () => {
  const host = hostWith([chat(S1)])
  fakeOps('')
  fakeOps(processTable([]))
  const asked = fakeTitles({ [S1]: 'Took over 错题本三期' })
  const worker = await mountWorker(main, { host })

  const first = await worker.request('sessions.list', {})
  assert.equal(first.sessions[0]?.title, 'Took over 错题本三期')
  assert.deepEqual(asked, ['小小'])

  // A second draw inside the minute reuses the cache; a forced refresh asks the CLI again.
  await worker.request('sessions.list', {})
  assert.deepEqual(asked, ['小小'])
  await worker.request('sessions.list', { refreshTitles: true })
  assert.deepEqual(asked, ['小小', '小小'])
  await worker.deactivate()
})

test('a title found under the Orca session id lands on the provider id row', async () => {
  const host = hostWith([chat(S1)])
  fakeTitles({ 'orca-session-1': '上线单 13703928' }, [{ sessionId: 'orca-session-1', nativeId: S1 }])
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list', {})

  assert.equal(snapshot.sessions[0]?.title, '上线单 13703928')
  await worker.deactivate()
})

test('an unreadable title source keeps the id prefix and does not break the list', async () => {
  const host = hostWith([chat(S1)])
  useTitleOps({
    bots: async () => {
      throw new Error('orca: command not found')
    },
    chats: async () => [],
    sessionPairs: async () => []
  })
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list', {})

  assert.equal(snapshot.sessions[0]?.title, '会话 39e65ad8')
  assert.equal(snapshot.failedWorkspaces, 0)
  await worker.deactivate()
})

test('a chat Orca restored without a provider id is 未运行 and never named after its agent', async () => {
  const host = hostWith([agent(null, { title: null, sessionId: null })])
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list', {})

  assert.equal(snapshot.sessions[0]?.title, '未命名会话')
  assert.equal(snapshot.sessions[0]?.sessionId, null)
  assert.equal(snapshot.sessions[0]?.hasProcess, false)
  assert.equal(snapshot.currentSessionId, null)
  await worker.deactivate()
})
