// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
import { afterEach, assert, beforeEach, hostError, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { useSignalOps, useTitleOps } from './worker'
import type { ChatTitleOps } from './botChats'
import type { SessionRecord } from './sessionRecord'
import type { MemorySnapshot, SignalOps } from './sessionProcess'

afterEach(() => {
  useSignalOps(null)
  useTitleOps(null)
})

beforeEach(() => {
  // `sessions.list` probes `ps`, SQLite, `orca diagnostics memory`, and bot CLI titles;
  // tests swap both seams to harmless fakes so they never touch the host machine.
  fakeOps('')
  useTitleOps({
    bots: async () => [],
    chats: async () => []
  })
})

const CLAUDE = '/Users/me/.local/bin/claude'
const AGY = '/Users/me/.local/bin/agy'
const PI = '/Users/me/.local/bin/pi'
const PROVIDER = '/Applications/Orca.app/Contents/MacOS/orca-provider-exec'
const START_STR = 'Thu Nov 26 16:29:56 2026'
const START_MS = Date.parse(START_STR)
const S1 = '39e65ad8-b388-4e57-8d80-e3ad8dc791e8'
const S2 = '1d5698f7-3890-4fa9-be15-b096359f32d9'
const S3 = '912da5da-78df-42bb-a5eb-a9427a2d3a67'
const ANTI = 'b9388fd5-6cae-42ad-9627-0aad35007921'
const ANTI_ARGS = 'acp --dangerously-skip-permissions'

const context = { workspaceId: 'w1', branch: 'main', displayName: '工作区一', terminals: [] }

function workspace(id: string, name: string, terminalCount: number, kind: 'worktree' | 'folder' = 'worktree') {
  return {
    id,
    kind,
    name,
    path: `/tmp/${id}`,
    branch: kind === 'worktree' ? 'main' : null,
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

/** A real chat session: no terminal, no title, only the conversation/native id. */
function chat(sessionId: string | null, overrides: Record<string, unknown> = {}) {
  return agent(null, { title: null, sessionId, ...overrides })
}

function record(overrides: Partial<SessionRecord> & { sessionId: string }): SessionRecord {
  return {
    nativeId: null,
    chainIds: [],
    provider: 'claude',
    workspaceId: 'w1',
    hostId: 'local',
    conversationName: null,
    claimStatus: 'released',
    unreconciled: false,
    ownerProcess: null,
    deathKind: null,
    ...overrides
  }
}

function liveRecord(
  sessionId: string,
  pid: number,
  overrides: Partial<SessionRecord> = {}
): SessionRecord {
  return record({
    sessionId,
    claimStatus: 'live',
    unreconciled: false,
    ownerProcess: {
      hostId: 'local',
      pid,
      processStartTimeMs: START_MS,
      spawnToken: `tok-${pid}`,
      runtime: 'rt-1'
    },
    ...overrides
  })
}

function processTable(
  entries: { pid: number; resume: string; pgid?: number; flag?: 'resume' | 'session-id'; lstart?: string }[]
): string {
  const rows = entries.map(
    ({ pid, resume, pgid, flag, lstart }) =>
      `${pid} 800 ${pgid ?? pid} ${lstart ?? START_STR} ${CLAUDE} --${flag ?? 'resume'}=${resume}\n`
  )
  return `  PID  PPID  PGID STARTED                      COMMAND\n800 700 800 ${START_STR} ${PROVIDER} --cli-input-fd7 1000 3000 -- ${CLAUDE}\n${rows.join('')}`
}

/**
 * The live host's shape for any agent: a wrapper starts the CLI, and the CLI starts a second
 * wrapper for itself (the stdin-end reporter), which must never count as an agent process.
 */
function agentChain(pid: number, binary: string, args: string, lstart = START_STR): string {
  const wrapper = `${PROVIDER} --cli-input-fd7 1000 3000 session stdin-end -- ${binary}${args ? ` ${args}` : ''}`
  const childCmd = binary.endsWith('/pi') && !args ? 'pi' : `${binary}${args ? ` ${args}` : ''}`
  return (
    `${pid} 700 ${pid} ${lstart} ${wrapper}\n` +
    `${pid + 2} ${pid} ${pid + 2} ${lstart} ${childCmd}\n` +
    `${pid + 3} ${pid + 2} ${pid + 3} ${lstart} ${wrapper}\n`
  )
}

function agentProcessTable(
  entries: { pid: number; binary: string; args: string; lstart?: string }[]
): string {
  return `  PID  PPID  PGID STARTED                      COMMAND\n${entries
    .map((entry) => agentChain(entry.pid, entry.binary, entry.args, entry.lstart))
    .join('')}`
}

/** Installs fake process/DB/memory side effects; returns the pgids they were signalled with. */
function fakeOps(
  table: string | (() => string),
  options: {
    psError?: string
    records?: SessionRecord[]
    recordsError?: string
    memory?: MemorySnapshot | null
  } = {}
): number[] {
  const signalled: number[] = []
  let clock = 0
  const ops: SignalOps = {
    listSessionRecords: async () => {
      if (options.recordsError) throw new Error(options.recordsError)
      return options.records ?? []
    },
    listProcesses: async () => {
      if (options.psError) throw new Error(options.psError)
      return typeof table === 'function' ? table() : table
    },
    readMemorySnapshot: async () => options.memory ?? null,
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
function fakeTitles(titles: Record<string, string>) {
  const asked: string[] = []
  const ops: ChatTitleOps = {
    bots: async () => ['小小'],
    chats: async (bot) => {
      asked.push(bot)
      return Object.entries(titles).map(([id, title]) => ({ id, title }))
    }
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
      'workspace.list': {
        workspaces: [workspace('w1', '工作区一', 0), workspace('w2', '工作区二', 0), workspace('w3', '工作区三', 2)],
        truncated: false
      },
      'workspace.readContext': context,
      'agents.list': ({ workspaceId }: { workspaceId: string }) => ({
        agents:
          workspaceId === 'w1'
            ? [agent('t1'), agent('t2', { state: 'working' }), chat(S1)]
            : workspaceId === 'w3'
              ? [agent('t3')]
              : []
      })
    }
  })
  fakeOps(processTable([{ pid: 900, resume: S1 }]), {
    records: [liveRecord('orca-s1', 900, { nativeId: S1, chainIds: [S1] })]
  })
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list')

  assert.equal(host.callsOf('agents.list').length, 3)
  assert.equal(snapshot.currentWorkspaceId, 'w1')
  assert.equal(snapshot.workspacesTruncated, false)
  assert.equal(snapshot.failedWorkspaces, 0)
  assert.equal(snapshot.recentOps.length, 1)
  assert.equal(snapshot.sessions[2]?.title, '会话 orca-s1')
  assert.deepEqual(
    snapshot.sessions.map((session) => [session.workspaceId, session.terminalId, session.state, session.stateKnown]),
    [
      ['w1', 't1', 'done', true],
      ['w1', 't2', 'working', true],
      ['w1', null, 'done', true],
      ['w3', 't3', 'done', true]
    ]
  )
  assert.equal(snapshot.sessions[2]?.sessionId, S1)
  assert.equal(snapshot.sessions[2]?.orcaSessionId, 'orca-s1')
  assert.equal(snapshot.sessions[2]?.matchedId, S1)
  assert.equal(snapshot.sessions[2]?.pairing, 'lease')
  assert.equal(snapshot.sessions[2]?.matchedPid, 900)
  assert.equal(snapshot.sessions[2]?.process, 'running')
  assert.equal(snapshot.sessions[0]?.process, null)
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

test('closes a done chat via lease and logs it', async () => {
  const host = hostWith([chat(S1)])
  const signalled = fakeOps(processTable([{ pid: 900, resume: S1 }]), {
    records: [liveRecord('orca-s1', 900, { nativeId: S1, chainIds: [S1] })]
  })
  const worker = await mountWorker(main, { host })

  const outcome = await worker.request('sessions.close', {
    workspaceId: 'w1',
    sessionId: S1,
    pid: 900
  })

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
  assert.equal(stored[0]?.ok, true)
  await worker.deactivate()
})

test('refuses a session that is not done without touching its process', async () => {
  const host = hostWith([chat(S1, { state: 'working' })])
  const signalled = fakeOps(processTable([{ pid: 900, resume: S1 }]), {
    records: [liveRecord('orca-s1', 900, { nativeId: S1 })]
  })
  const worker = await mountWorker(main, { host })

  const outcome = await worker.request('sessions.close', { workspaceId: 'w1', sessionId: S1, pid: 900 })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'not_idle')
  assert.match(outcome.message ?? '', /运行中/)
  assert.deepEqual(signalled, [])
  assert.equal(host.callsOf('terminal.close').length, 0)
  await worker.deactivate()
})

test('reports a refusal when no process matches the session', async () => {
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

test('sessions.reclaim closes every finished session with known state and a live process, skipping working and memory-only rows', async () => {
  const S4 = '44444444-4444-4444-8444-444444444444'
  const host = hostWith([
    chat(S1, { stateStartedAt: 3000 }),
    chat(S2, { state: 'working', stateStartedAt: 4000 }),
    chat(S3, { stateStartedAt: 1000 })
  ])
  const signalled = fakeOps(
    processTable([
      { pid: 900, resume: S1 },
      { pid: 902, resume: S3 },
      { pid: 904, resume: S4 }
    ]),
    {
      records: [
        liveRecord('orca-1', 900, { nativeId: S1, chainIds: [S1] }),
        liveRecord('orca-2', 901, { nativeId: S2, chainIds: [S2] }),
        liveRecord('orca-3', 902, { nativeId: S3, chainIds: [S3] }),
        liveRecord('orca-4', 904, { nativeId: S4, chainIds: [S4] })
      ],
      memory: {
        worktrees: [
          {
            worktreeId: 'w1',
            worktreeName: '工作区一',
            repoId: null,
            repoName: null,
            cpu: 1,
            memory: 1000,
            chats: [{ agentSessionId: 'orca-4', agent: 'claude', name: '未上报状态会话', cpu: 0, memory: 500 }],
            sessions: []
          }
        ]
      }
    }
  )
  const worker = await mountWorker(main, { host })

  const result = await worker.request('sessions.reclaim', { workspaceId: 'w1' })

  assert.deepEqual(
    result.outcomes.map((outcome) => [outcome.sessionId, outcome.ok]),
    [
      [S1, true],
      [S3, true]
    ]
  )
  assert.equal(result.stoppedAtFailure, false)
  assert.deepEqual(signalled, [900, 902])
  await worker.deactivate()
})

test('sessions.reclaim stops at the first refusal', async () => {
  const host = hostWith([
    chat(S1, { stateStartedAt: 3000 }),
    chat(S2, { stateStartedAt: 1000 }),
    chat(S3, { stateStartedAt: 2000 })
  ])
  // S2 is running during readSnapshot, then loses group leadership before closeOne re-reads `ps`.
  let psReads = 0
  const signalled = fakeOps(
    () => {
      psReads += 1
      return processTable([
        { pid: 900, resume: S1 },
        { pid: 901, resume: S2, pgid: psReads <= 2 ? 901 : 800 },
        { pid: 903, resume: S3 }
      ])
    },
    {
      records: [
        liveRecord('orca-1', 900, { nativeId: S1, chainIds: [S1] }),
        liveRecord('orca-2', 901, { nativeId: S2, chainIds: [S2] }),
        liveRecord('orca-3', 903, { nativeId: S3, chainIds: [S3] })
      ]
    }
  )
  const worker = await mountWorker(main, { host })

  const result = await worker.request('sessions.reclaim', { workspaceId: 'w1' })

  assert.deepEqual(
    result.outcomes.map((outcome) => [outcome.sessionId, outcome.ok]),
    [
      [S1, true],
      [S2, false]
    ]
  )
  assert.equal(result.outcomes[1]?.code, 'not_group_leader')
  assert.equal(result.stoppedAtFailure, true)
  assert.deepEqual(signalled, [900])
  await worker.deactivate()
})

test('released lease with no running process is confirmed 未运行 (stopped), eliminating 无法判定', async () => {
  const host = hostWith([chat(S1), chat(S2)])
  fakeOps(processTable([{ pid: 900, resume: S1 }]), {
    records: [
      liveRecord('orca-1', 900, { nativeId: S1, chainIds: [S1] }),
      record({
        sessionId: 'orca-2',
        nativeId: S2,
        chainIds: [S2],
        claimStatus: 'released',
        ownerProcess: null,
        deathKind: 'exit-observed'
      })
    ]
  })
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list')

  assert.equal(snapshot.sessions[0]?.process, 'running')
  assert.equal(snapshot.sessions[0]?.pairing, 'lease')
  assert.equal(snapshot.sessions[1]?.process, 'stopped')
  assert.match(snapshot.sessions[1]?.processNote ?? '', /exit-observed/)
  await worker.deactivate()
})

test('released lease still running on CLI --resume= is still marked running rather than hidden', async () => {
  const host = hostWith([chat(S1)])
  fakeOps(processTable([{ pid: 900, resume: S1 }]), {
    records: [
      record({
        sessionId: 'orca-1',
        nativeId: S1,
        chainIds: [S1],
        claimStatus: 'released',
        ownerProcess: null
      })
    ]
  })
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list')

  assert.equal(snapshot.sessions[0]?.process, 'running')
  assert.equal(snapshot.sessions[0]?.pairing, 'id')
  assert.equal(snapshot.sessions[0]?.matchedId, S1)
  await worker.deactivate()
})

test('reserved, conflicted, unreconciled, remote host, and PID-reused leases are marked 无法判定 with clear reasons', async () => {
  const S4 = '44444444-4444-4444-8444-444444444444'
  const S5 = '55555555-5555-4555-8555-555555555555'
  const host = hostWith([chat(S1), chat(S2), chat(S3), chat(S4), chat(S5)])
  fakeOps(
    processTable([
      { pid: 900, resume: S1 },
      { pid: 904, resume: S5, lstart: 'Thu Nov 26 17:10:00 2026' }
    ]),
    {
      records: [
        record({ sessionId: 'orca-1', nativeId: S1, claimStatus: 'reserved', ownerProcess: null }),
        record({ sessionId: 'orca-2', nativeId: S2, claimStatus: 'conflicted', ownerProcess: null }),
        liveRecord('orca-3', 902, { nativeId: S3, unreconciled: true }),
        liveRecord('orca-4', 903, {
          nativeId: S4,
          ownerProcess: { hostId: 'ssh:remote', pid: 903, processStartTimeMs: START_MS, spawnToken: 't', runtime: 'r' }
        }),
        liveRecord('orca-5', 904, { nativeId: S5 })
      ]
    }
  )
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list')

  assert.deepEqual(
    snapshot.sessions.map((s) => s.process),
    ['unknown', 'unknown', 'unknown', 'unknown', 'unknown']
  )
  assert.match(snapshot.sessions[0]?.processNote ?? '', /reserved/)
  assert.match(snapshot.sessions[1]?.processNote ?? '', /conflicted/)
  assert.match(snapshot.sessions[2]?.processNote ?? '', /unreconciled/)
  assert.match(snapshot.sessions[3]?.processNote ?? '', /ssh:remote/)
  assert.match(snapshot.sessions[4]?.processNote ?? '', /PID 已被复用/)
  await worker.deactivate()
})

test('sessions.list leaves the process unknown when ps cannot be read', async () => {
  const host = hostWith([chat(S1)])
  fakeOps('', { psError: 'ps: operation not permitted' })
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list')

  assert.equal(snapshot.sessions[0]?.process, 'unknown')
  assert.equal(snapshot.sessions[0]?.matchedId, null)
  assert.deepEqual(snapshot.sessions.map((session) => session.sessionId), [S1])
  await worker.deactivate()
})

test('sessions.list aligns 1:1 with diagnostics.memory across git worktrees, fills memoryBytes, and surfaces omitted active chats as stateKnown=false', async () => {
  const ORCA_WT = 'orca-wt-1'
  const ORCA_MISSING = 'orca-missing-1'
  const ORCA_HIDDEN = 'orca-hidden-1'
  const wt1 = workspace('identity:wt2:local:abc', 'fix-sync', 1, 'worktree')
  wt1.path = '/Users/me/wt1'
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [wt1, workspace('folder:bot', '小小', 0, 'folder')], truncated: false },
      'workspace.readContext': { ...context, workspaceId: wt1.id },
      'agents.list': ({ workspaceId }: { workspaceId: string }) => {
        if (workspaceId === wt1.id) {
          return {
            agents: [
              agent('t1', { sessionId: 'term-sess', agent: 'pi', state: 'working' }),
              chat(ORCA_WT, { agent: 'antigravity', state: 'done' })
            ]
          }
        }
        if (workspaceId === 'folder:bot') {
          return { agents: [] } // agents.list omitted ORCA_MISSING
        }
        throw hostError('action_failed', 'unknown synthetic workspace')
      }
    }
  })
  fakeOps(
    agentProcessTable([
      { pid: 900, binary: AGY, args: ANTI_ARGS },
      { pid: 910, binary: CLAUDE, args: `--session-id=${ORCA_MISSING}` },
      { pid: 920, binary: PI, args: '' }
    ]),
    {
      records: [
        liveRecord(ORCA_WT, 902, {
          provider: 'antigravity',
          workspaceId: 'repo1::/Users/me/wt1'
        }),
        liveRecord(ORCA_MISSING, 912, {
          provider: 'claude',
          workspaceId: 'folder:bot'
        }),
        liveRecord(ORCA_HIDDEN, 922, {
          provider: 'pi',
          nativeId: '/Users/zyb/.pi/agent/sessions/hidden.jsonl',
          workspaceId: 'repo2::/Users/me/truncated-wt'
        })
      ],
      memory: {
        worktrees: [
          {
            worktreeId: 'repo1::/Users/me/wt1',
            worktreeName: 'fix-sync',
            repoId: 'repo1',
            repoName: 'orca-chat-reclaim',
            cpu: 10,
            memory: 400_000_000,
            chats: [
              { agentSessionId: ORCA_WT, agent: 'antigravity', name: '资源管理器工作区标题', cpu: 5, memory: 278_000_000 }
            ],
            sessions: [
              { sessionId: 'repo1::/Users/me/wt1@@t1', paneKey: 'pk-1', pid: 888, cpu: 5, memory: 122_000_000 }
            ]
          },
          {
            worktreeId: 'folder:bot',
            worktreeName: '小小',
            repoId: 'bots',
            repoName: 'Bots',
            cpu: 2,
            memory: 500_000_000,
            chats: [
              { agentSessionId: ORCA_MISSING, agent: 'claude', name: '被截断漏报的活跃对话', cpu: 2, memory: 500_000_000 }
            ],
            sessions: []
          },
          {
            worktreeId: 'repo2::/Users/me/truncated-wt',
            worktreeName: 'truncated-wt',
            repoId: 'repo2',
            repoName: 'other',
            cpu: 3,
            memory: 200_000_000,
            chats: [
              { agentSessionId: ORCA_HIDDEN, agent: 'pi', name: '截断工作区里的 pi', cpu: 3, memory: 200_000_000 }
            ],
            sessions: []
          }
        ]
      }
    }
  )
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list')

  // Synthetic truncated-wt failure on agents.list must not pollute failedWorkspaces.
  assert.equal(snapshot.failedWorkspaces, 0)
  assert.equal(snapshot.workspaces.some((w) => w.id === 'repo2::/Users/me/truncated-wt'), true)

  const term = snapshot.sessions.find((s) => s.terminalId === 't1')
  assert.equal(term?.memoryBytes, 122_000_000)
  assert.equal(term?.stateKnown, true)

  const wtChat = snapshot.sessions.find((s) => s.orcaSessionId === ORCA_WT)
  assert.equal(wtChat?.title, '资源管理器工作区标题')
  assert.equal(wtChat?.memoryBytes, 278_000_000)
  assert.equal(wtChat?.process, 'running')
  assert.equal(wtChat?.pairing, 'lease')
  assert.equal(wtChat?.matchedPid, 902)
  assert.equal(wtChat?.stateKnown, true)

  const omitted = snapshot.sessions.find((s) => s.orcaSessionId === ORCA_MISSING)
  assert.equal(omitted?.workspaceId, 'folder:bot')
  assert.equal(omitted?.title, '被截断漏报的活跃对话')
  assert.equal(omitted?.process, 'running')
  assert.equal(omitted?.memoryBytes, 500_000_000)
  assert.equal(omitted?.stateKnown, false)
  assert.match(omitted?.processNote ?? '', /未从 Orca 获取到会话空闲状态，暂不可关闭/)

  const hidden = snapshot.sessions.find((s) => s.orcaSessionId === ORCA_HIDDEN)
  assert.equal(hidden?.workspaceId, 'repo2::/Users/me/truncated-wt')
  assert.equal(hidden?.title, '截断工作区里的 pi')
  assert.equal(hidden?.process, 'running')
  assert.equal(hidden?.stateKnown, false)
  await worker.deactivate()
})

test('title resolution follows memory.name > botTitles > conversationName > orcaSessionId prefix and never slices file paths', async () => {
  const PI_PATH = '/Users/zyb/.pi/agent/sessions/--Users-zyb-.orca-bots-bot--/2026-11-26_01a216f3.jsonl'
  const PI_ORCA_1 = '3bfdeb92-fe24-4ebb-8bc2-4a73334cf2e3'
  const PI_ORCA_2 = 'bb0d11e8-e515-4b62-8841-8473140fcda2'
  const PI_PATH_2 = '/Users/zyb/.pi/agent/sessions/--Users-zyb--/2026-11-26_deadbeef.jsonl'

  const host = hostWith([
    chat(PI_PATH, { agent: 'pi' }),
    chat(PI_PATH_2, { agent: 'pi' }),
    chat('/Users/zyb/untracked/pi.jsonl', { agent: 'pi' })
  ])
  fakeOps(agentProcessTable([{ pid: 900, binary: PI, args: '' }]), {
    records: [
      liveRecord(PI_ORCA_1, 902, {
        provider: 'pi',
        nativeId: PI_PATH,
        chainIds: [PI_PATH],
        conversationName: '来自 DB conversationName'
      }),
      record({
        sessionId: PI_ORCA_2,
        provider: 'pi',
        nativeId: PI_PATH_2,
        chainIds: [PI_PATH_2],
        conversationName: null,
        claimStatus: 'released',
        ownerProcess: null
      })
    ]
  })
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list')

  assert.equal(snapshot.sessions[0]?.title, '来自 DB conversationName')
  assert.equal(snapshot.sessions[1]?.title, '会话 bb0d11e8')
  assert.equal(snapshot.sessions[1]?.process, 'stopped')
  // Untracked path id never gets sliced into `会话 /Users/z`.
  assert.equal(snapshot.sessions[2]?.title, '未命名会话')
  await worker.deactivate()
})

test('sessions.list shows the chat title from the bot list and caches it for a minute', async () => {
  const host = hostWith([chat(S1)])
  fakeOps(processTable([]))
  const asked = fakeTitles({ [S1]: 'Took over 错题本三期' })
  const worker = await mountWorker(main, { host })

  const first = await worker.request('sessions.list', {})
  assert.equal(first.sessions[0]?.title, 'Took over 错题本三期')
  assert.deepEqual(asked, ['小小'])

  await worker.request('sessions.list', {})
  assert.deepEqual(asked, ['小小'])
  await worker.request('sessions.list', { refreshTitles: true })
  assert.deepEqual(asked, ['小小', '小小'])
  await worker.deactivate()
})

test('maps four live sessions one to one, even when Orca reports an older id', async () => {
  const HOME_ORCA = '87cea74d-887c-465a-a052-1040892904bb'
  const HOME_NATIVE = 'dd411755-4b8d-4ebc-b89f-9ef38d089774'
  const COORD_ORCA = '69af17fc-fe61-4578-a2b4-f37f364c31cd'
  const COORD_NATIVE = '82092408-37fb-4ae5-bf44-83d986eb1e14'
  const SEARCH_ORCA = 'fb001612-9c34-463e-9dd2-2dcb6441a2d1'
  const SEARCH_OLD = '9b127c4f-5f06-4157-8d86-c8fe4793719e'
  const SEARCH_NATIVE = '600d75f6-dbf4-44e5-bb55-9c35e614370b'
  const DEPLOY_ORCA = '793c26bb-2854-41a0-a0ef-1ae2346c7218'
  const DEPLOY_NATIVE = '13d8d80f-16b4-4ba3-b3a3-89df1d3e8bc4'

  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [workspace('w1', '小小', 0)], truncated: false },
      'workspace.readContext': context,
      'agents.list': {
        agents: [
          chat(HOME_NATIVE, { stateStartedAt: 3000 }),
          chat(COORD_ORCA, { stateStartedAt: 2000 }),
          chat(SEARCH_OLD, { stateStartedAt: 1000 }),
          chat(DEPLOY_NATIVE, { stateStartedAt: 500 })
        ]
      }
    }
  })
  fakeOps(
    processTable([
      { pid: 900, resume: COORD_NATIVE },
      { pid: 901, resume: SEARCH_NATIVE },
      { pid: 902, resume: HOME_NATIVE },
      { pid: 903, resume: DEPLOY_NATIVE, flag: 'session-id' }
    ]),
    {
      records: [
        liveRecord(HOME_ORCA, 902, { nativeId: HOME_NATIVE, chainIds: [HOME_NATIVE] }),
        liveRecord(COORD_ORCA, 900, {
          nativeId: COORD_NATIVE,
          chainIds: ['39e65ad8-b388-4e57-8d80-e3ad8dc791e8', COORD_NATIVE]
        }),
        liveRecord(SEARCH_ORCA, 901, { nativeId: SEARCH_NATIVE, chainIds: [SEARCH_OLD, SEARCH_NATIVE] }),
        liveRecord(DEPLOY_ORCA, 903, { nativeId: DEPLOY_NATIVE, chainIds: [DEPLOY_NATIVE] })
      ]
    }
  )
  fakeTitles({
    [HOME_ORCA]: 'Home',
    [COORD_ORCA]: '分析当前 Mac 内存占用',
    [SEARCH_ORCA]: '未匹配到题目问题排查',
    [DEPLOY_ORCA]: '上线 dsl-hub 的 engine 与 controller 更新'
  })
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list', {})
  const rows = snapshot.sessions.map((session) => ({
    rowId: session.sessionId,
    orcaSessionId: session.orcaSessionId,
    matchedId: session.matchedId,
    matchedPid: session.matchedPid,
    title: session.title,
    process: session.process
  }))

  assert.deepEqual(rows, [
    { rowId: HOME_NATIVE, orcaSessionId: HOME_ORCA, matchedId: HOME_NATIVE, matchedPid: 902, title: 'Home', process: 'running' },
    { rowId: COORD_ORCA, orcaSessionId: COORD_ORCA, matchedId: COORD_NATIVE, matchedPid: 900, title: '分析当前 Mac 内存占用', process: 'running' },
    { rowId: SEARCH_OLD, orcaSessionId: SEARCH_ORCA, matchedId: SEARCH_NATIVE, matchedPid: 901, title: '未匹配到题目问题排查', process: 'running' },
    { rowId: DEPLOY_NATIVE, orcaSessionId: DEPLOY_ORCA, matchedId: DEPLOY_NATIVE, matchedPid: 903, title: '上线 dsl-hub 的 engine 与 controller 更新', process: 'running' }
  ])
  await worker.deactivate()
})

test('closes pi and antigravity sessions via lease and matches canonical sessionId to nativeId rows', async () => {
  const PI_ORCA = '3bfdeb92-fe24-4ebb-8bc2-4a73334cf2e3'
  const PI_PATH = '/Users/zyb/.pi/agent/sessions/--Users-zyb--/pi.jsonl'
  const ANTI_ORCA = '7980aac2-bf09-406f-9627-8294f76955b4'

  const host = hostWith([
    chat(PI_PATH, { agent: 'pi' }),
    chat(ANTI, { agent: 'antigravity' })
  ])
  const signalled = fakeOps(
    agentProcessTable([
      { pid: 87861, binary: PI, args: '' },
      { pid: 8991, binary: AGY, args: ANTI_ARGS }
    ]),
    {
      records: [
        liveRecord(PI_ORCA, 87863, { provider: 'pi', nativeId: PI_PATH, chainIds: [PI_PATH] }),
        liveRecord(ANTI_ORCA, 8993, { provider: 'antigravity', nativeId: ANTI, chainIds: [ANTI] })
      ]
    }
  )
  const worker = await mountWorker(main, { host })

  // Closing by canonical ORCA id still locates the agents.list row holding PI_PATH.
  const outPi = await worker.request('sessions.close', {
    workspaceId: 'w1',
    sessionId: PI_ORCA,
    pid: 87863
  })
  assert.equal(outPi.ok, true)
  assert.equal(outPi.pid, 87863)

  // Stale pid refused with process_changed.
  const outChanged = await worker.request('sessions.close', {
    workspaceId: 'w1',
    sessionId: ANTI,
    pid: 9000
  })
  assert.equal(outChanged.ok, false)
  assert.equal(outChanged.code, 'process_changed')

  const outAnti = await worker.request('sessions.close', {
    workspaceId: 'w1',
    sessionId: ANTI,
    pid: 8993
  })
  assert.equal(outAnti.ok, true)
  assert.equal(outAnti.pid, 8993)
  assert.deepEqual(signalled, [87863, 8993])
  await worker.deactivate()
})

test('a chat never takes the host agent title as its title', async () => {
  const host = hostWith([agent(null, { title: '小小', sessionId: S1 })])
  fakeOps('')
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list', {})

  assert.equal(snapshot.sessions[0]?.title, '会话 39e65ad8')
  await worker.deactivate()
})
