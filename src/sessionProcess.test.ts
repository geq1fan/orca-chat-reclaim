import { assert, test } from 'orca/testing'
import type { SessionRecord } from './sessionRecord'
import {
  parseMemorySnapshot,
  stopSessionByLease,
  stopSessionWithSignal,
  TERM_WAIT_MS,
  type SignalOps
} from './sessionProcess'

const CLAUDE = '/Users/me/.local/bin/claude'
const PI = '/Users/me/.local/bin/pi'
const PROVIDER = '/Applications/Orca.app/Contents/MacOS/orca-provider-exec'
const SESSION_ID = '39e65ad8-b388-4e57-8d80-e3ad8dc791e8'
const ORCA_ID = 'orcasession-0000-1111'
const START_STR = 'Thu Nov 26 16:29:56 2026'
const START_MS = Date.parse(START_STR)

function line(pid: number, ppid: number, pgid: number, command: string, lstart = START_STR): string {
  return `${pid} ${ppid} ${pgid} ${lstart} ${command}\n`
}

function processTable(
  providerId: string,
  options: {
    pid?: number
    pgid?: number
    parentExec?: boolean
    duplicates?: boolean
    flag?: 'resume' | 'session-id'
    binary?: string
    args?: string
    lstart?: string
  } = {}
): string {
  const pid = options.pid ?? 900
  const pgid = options.pgid ?? pid
  const flag = options.flag ?? 'resume'
  const binary = options.binary ?? CLAUDE
  const args = options.args ?? `--setting-sources user --${flag}=${providerId} --verbose`
  const parent = options.parentExec === false ? '/usr/bin/python3' : PROVIDER
  const row = line(pid, 800, pgid, `${binary} ${args}`, options.lstart)
  const parentRow = line(800, 700, 800, `${parent} --cli-input-fd7 1000 3000 -- ${binary}`, options.lstart)
  const table = `  PID  PPID  PGID STARTED                      COMMAND\n${parentRow}${row}`
  return options.duplicates
    ? table + line(pid + 1, 800, pid + 1, `${binary} --${flag}=${providerId}`, options.lstart)
    : table
}

function liveRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: ORCA_ID,
    nativeId: SESSION_ID,
    chainIds: [SESSION_ID],
    provider: 'claude',
    workspaceId: 'w1',
    hostId: 'local',
    conversationName: '会话标题',
    claimStatus: 'live',
    unreconciled: false,
    ownerProcess: {
      hostId: 'local',
      pid: 900,
      processStartTimeMs: START_MS,
      spawnToken: 'tok-1',
      runtime: 'rt-1'
    },
    deathKind: null,
    ...overrides
  }
}

function fakeOps(options: {
  table?: string
  records?: SessionRecord[]
  recordsError?: string
  neverDies?: boolean
  ownPgid?: number | null
}): { ops: SignalOps; signalled: number[]; recordReads: () => number } {
  const signalled: number[] = []
  const neverDies = options.neverDies === true
  let clock = 0
  let recordReads = 0
  const ops: SignalOps = {
    listSessionRecords: async () => {
      recordReads += 1
      if (options.recordsError) throw new Error(options.recordsError)
      return options.records ?? []
    },
    listProcesses: async () => options.table ?? '',
    readMemorySnapshot: async () => null,
    signalGroup: (pgid) => {
      signalled.push(pgid)
    },
    isAlive: (pid) => neverDies || !signalled.includes(pid),
    ownPgid: async () => options.ownPgid ?? 1,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    }
  }
  return { ops, signalled, recordReads: () => recordReads }
}

test('parseMemorySnapshot parses worktrees, chats, and terminal sessions', () => {
  const snap = parseMemorySnapshot(
    JSON.stringify({
      ok: true,
      result: {
        worktrees: [
          {
            worktreeId: 'folder:w1',
            worktreeName: '小小',
            repoId: 'r1',
            repoName: 'Bots',
            cpu: 1.5,
            memory: 1024,
            chats: [
              {
                agentSessionId: 'orca-1',
                agent: 'pi',
                name: '测试会话',
                cpu: 0,
                memory: 237373592
              }
            ],
            sessions: []
          },
          {
            worktreeId: 'repo::/tmp/wt',
            worktreeName: 'wt',
            cpu: 2,
            memory: 2048,
            sessions: [
              {
                sessionId: 'repo::/tmp/wt@@e1',
                paneKey: 'p1',
                pid: 123,
                cpu: 2,
                memory: 2048
              }
            ]
          }
        ]
      }
    })
  )
  assert.ok(snap)
  assert.equal(snap.worktrees.length, 2)
  assert.equal(snap.worktrees[0]?.chats[0]?.agent, 'pi')
  assert.equal(snap.worktrees[1]?.chats.length, 0)
  assert.equal(snap.worktrees[1]?.sessions[0]?.pid, 123)

  assert.equal(parseMemorySnapshot('not json'), null)
  assert.equal(parseMemorySnapshot(JSON.stringify({ ok: false })), null)
  assert.equal(parseMemorySnapshot(JSON.stringify({ ok: true, result: {} })), null)
})

test('signals the process group of the claude that resumes the session', async () => {
  const { ops, signalled } = fakeOps({ table: processTable(SESSION_ID) })

  const outcome = await stopSessionWithSignal({
    workspaceId: 'w1',
    sessionId: SESSION_ID,
    dryRun: false,
    ops
  })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.how, 'signal')
  assert.equal(outcome.sessionUuid, SESSION_ID)
  assert.equal(outcome.pid, 900)
  assert.equal(outcome.pgid, 900)
  assert.deepEqual(signalled, [900])
})

test('matches a claude started with --session-id, the flag new conversations use', async () => {
  const { ops, signalled } = fakeOps({ table: processTable(SESSION_ID, { flag: 'session-id' }) })

  const outcome = await stopSessionWithSignal({
    workspaceId: 'w1',
    sessionId: SESSION_ID,
    dryRun: false,
    ops
  })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.pid, 900)
  assert.equal(outcome.pgid, 900)
  assert.deepEqual(signalled, [900])
})

test('does not signal when no claude process carries the session id', async () => {
  const { ops, signalled, recordReads } = fakeOps({ table: processTable('another-session') })

  const outcome = await stopSessionWithSignal({
    workspaceId: 'w1',
    sessionId: SESSION_ID,
    dryRun: false,
    ops
  })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'no_process')
  assert.match(outcome.message ?? '', /--resume= 和 --session-id=/)
  assert.deepEqual(signalled, [])
  // The chain is part of every lookup: the row id alone may be stale.
  assert.equal(recordReads(), 1)
})

test('refuses a claude process that is not its own process group', async () => {
  const { ops, signalled } = fakeOps({ table: processTable(SESSION_ID, { pgid: 800 }) })

  const outcome = await stopSessionWithSignal({
    workspaceId: 'w1',
    sessionId: SESSION_ID,
    dryRun: false,
    ops
  })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'not_group_leader')
  assert.deepEqual(signalled, [])
})

test('refuses a parent that is not orca-provider-exec', async () => {
  const { ops, signalled } = fakeOps({ table: processTable(SESSION_ID, { parentExec: false }) })

  const outcome = await stopSessionWithSignal({
    workspaceId: 'w1',
    sessionId: SESSION_ID,
    dryRun: false,
    ops
  })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'no_parent')
  assert.deepEqual(signalled, [])
})

test('refuses when two processes resume the same session', async () => {
  const { ops, signalled } = fakeOps({ table: processTable(SESSION_ID, { duplicates: true }) })

  const outcome = await stopSessionWithSignal({
    workspaceId: 'w1',
    sessionId: SESSION_ID,
    dryRun: false,
    ops
  })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'ambiguous')
  assert.deepEqual(signalled, [])
})

test('reports a process that survives SIGTERM instead of escalating', async () => {
  const { ops, signalled } = fakeOps({ table: processTable(SESSION_ID), neverDies: true })

  const outcome = await stopSessionWithSignal({
    workspaceId: 'w1',
    sessionId: SESSION_ID,
    dryRun: false,
    ops
  })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'still_alive')
  assert.match(outcome.message ?? '', new RegExp(`${TERM_WAIT_MS / 1000} 秒`))
  assert.deepEqual(signalled, [900])
})

test('a dry run reports the process and signals nothing', async () => {
  const { ops, signalled } = fakeOps({ table: processTable(SESSION_ID) })

  const outcome = await stopSessionWithSignal({
    workspaceId: 'w1',
    sessionId: SESSION_ID,
    dryRun: true,
    ops
  })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.dryRun, true)
  assert.equal(outcome.pid, 900)
  assert.equal(outcome.pgid, 900)
  assert.match(outcome.parentArgs ?? '', /orca-provider-exec/)
  assert.deepEqual(signalled, [])
})

test('stopSessionByLease closes a live pi or claude session via lease and lstart', async () => {
  const piPath = '/Users/zyb/.pi/agent/sessions/--Users-zyb--/2026-11-26_pi.jsonl'
  const { ops, signalled } = fakeOps({
    table: processTable('', { binary: PI, args: '' }),
    records: [
      liveRecord({
        provider: 'pi',
        nativeId: piPath,
        chainIds: [piPath]
      })
    ]
  })

  const outcome = await stopSessionByLease({
    workspaceId: 'w1',
    sessionId: piPath,
    expectedAgent: 'pi',
    expectedPid: 900,
    dryRun: false,
    ops
  })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.pid, 900)
  assert.equal(outcome.pgid, 900)
  assert.equal('sessionUuid' in outcome, false)
  assert.deepEqual(signalled, [900])
})

test('stopSessionByLease enforces expectedPid, lease state, host, and lstart anti-PID-reuse', async () => {
  // process_changed when DB lease pid moved
  {
    const { ops, signalled } = fakeOps({
      table: processTable(SESSION_ID, { pid: 901 }),
      records: [
        liveRecord({
          ownerProcess: { hostId: 'local', pid: 901, processStartTimeMs: START_MS, spawnToken: 't', runtime: 'r' }
        })
      ]
    })
    const out = await stopSessionByLease({
      workspaceId: 'w1',
      sessionId: ORCA_ID,
      expectedAgent: 'claude',
      expectedPid: 900,
      dryRun: false,
      ops
    })
    assert.equal(out.ok, false)
    assert.equal(out.code, 'process_changed')
    assert.deepEqual(signalled, [])
  }

  // lease_not_live
  {
    const { ops } = fakeOps({
      table: processTable(SESSION_ID),
      records: [liveRecord({ claimStatus: 'released', ownerProcess: null })]
    })
    const out = await stopSessionByLease({
      workspaceId: 'w1',
      sessionId: ORCA_ID,
      expectedPid: 900,
      dryRun: false,
      ops
    })
    assert.equal(out.ok, false)
    assert.equal(out.code, 'lease_not_live')
  }

  // lease_unreconciled
  {
    const { ops } = fakeOps({
      table: processTable(SESSION_ID),
      records: [liveRecord({ unreconciled: true })]
    })
    const out = await stopSessionByLease({
      workspaceId: 'w1',
      sessionId: ORCA_ID,
      expectedPid: 900,
      dryRun: false,
      ops
    })
    assert.equal(out.ok, false)
    assert.equal(out.code, 'lease_unreconciled')
  }

  // remote_host
  {
    const { ops } = fakeOps({
      table: processTable(SESSION_ID),
      records: [
        liveRecord({
          ownerProcess: { hostId: 'ssh:box', pid: 900, processStartTimeMs: START_MS, spawnToken: 't', runtime: 'r' }
        })
      ]
    })
    const out = await stopSessionByLease({
      workspaceId: 'w1',
      sessionId: ORCA_ID,
      expectedPid: 900,
      dryRun: false,
      ops
    })
    assert.equal(out.ok, false)
    assert.equal(out.code, 'remote_host')
  }

  // start_time_mismatch (PID reused later)
  {
    const { ops, signalled } = fakeOps({
      table: processTable(SESSION_ID, { lstart: 'Thu Nov 26 17:00:00 2026' }),
      records: [liveRecord()]
    })
    const out = await stopSessionByLease({
      workspaceId: 'w1',
      sessionId: ORCA_ID,
      expectedAgent: 'claude',
      expectedPid: 900,
      dryRun: false,
      ops
    })
    assert.equal(out.ok, false)
    assert.equal(out.code, 'start_time_mismatch')
    assert.deepEqual(signalled, [])
  }

  // start_time_unknown when ps lacks lstart
  {
    const { ops } = fakeOps({
      table: '  PID PPID PGID COMMAND\n800 700 800 /Applications/Orca.app/Contents/MacOS/orca-provider-exec -- /Users/me/.local/bin/claude\n900 800 900 /Users/me/.local/bin/claude\n',
      records: [liveRecord()]
    })
    const out = await stopSessionByLease({
      workspaceId: 'w1',
      sessionId: ORCA_ID,
      expectedAgent: 'claude',
      expectedPid: 900,
      dryRun: false,
      ops
    })
    assert.equal(out.ok, false)
    assert.equal(out.code, 'start_time_unknown')
  }

  // kind_mismatch
  {
    const { ops } = fakeOps({
      table: processTable(SESSION_ID),
      records: [liveRecord({ provider: 'pi' })]
    })
    const out = await stopSessionByLease({
      workspaceId: 'w1',
      sessionId: ORCA_ID,
      expectedAgent: 'pi',
      expectedPid: 900,
      dryRun: false,
      ops
    })
    assert.equal(out.ok, false)
    assert.equal(out.code, 'kind_mismatch')
  }
})

test('stopSessionByLease falls back to CLI id when DB fails or lacks record without expectedPid, and reads DB once', async () => {
  const { ops, signalled, recordReads } = fakeOps({
    table: processTable(SESSION_ID),
    recordsError: 'database is locked'
  })

  const outcome = await stopSessionByLease({
    workspaceId: 'w1',
    sessionId: SESSION_ID,
    expectedAgent: 'claude',
    expectedPid: null,
    dryRun: false,
    ops
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.sessionUuid, SESSION_ID)
  assert.deepEqual(signalled, [900])
  assert.equal(recordReads(), 1)

  // Missing process + DB failure reports DB failure in message and still reads DB once.
  const missing = fakeOps({ table: '', recordsError: 'database is locked' })
  const missOut = await stopSessionByLease({
    workspaceId: 'w1',
    sessionId: SESSION_ID,
    expectedPid: null,
    dryRun: false,
    ops: missing.ops
  })
  assert.equal(missOut.ok, false)
  assert.equal(missOut.code, 'no_process')
  assert.match(missOut.message ?? '', /database is locked/)
  assert.equal(missing.recordReads(), 1)

  // Path sessionId with expectedPid == null must NOT fall back to CLI flags when DB has no record.
  const pathMiss = fakeOps({ table: processTable(SESSION_ID), records: [] })
  const pathOut = await stopSessionByLease({
    workspaceId: 'w1',
    sessionId: '/Users/zyb/.pi/sessions/abc.jsonl',
    expectedPid: null,
    dryRun: false,
    ops: pathMiss.ops
  })
  assert.equal(pathOut.ok, false)
  assert.equal(pathOut.code, 'no_record')
})
