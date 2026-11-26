import { assert, test } from 'orca/testing'
import type { SessionRecord } from './sessionRecord'
import { stopPairedSession, stopSessionWithSignal, TERM_WAIT_MS, type SignalOps } from './sessionProcess'

const CLAUDE = '/Users/me/.local/bin/claude'
const PROVIDER = '/Applications/Orca.app/Contents/MacOS/orca-provider-exec'
const SESSION_ID = '39e65ad8-b388-4e57-8d80-e3ad8dc791e8'

function line(pid: number, ppid: number, pgid: number, command: string): string {
  return `${pid} ${ppid} ${pgid} ${command}\n`
}

function processTable(
  providerId: string,
  options: {
    pid?: number
    pgid?: number
    parentExec?: boolean
    duplicates?: boolean
    flag?: 'resume' | 'session-id'
  } = {}
): string {
  const pid = options.pid ?? 900
  const pgid = options.pgid ?? pid
  const flag = options.flag ?? 'resume'
  const parent = options.parentExec === false ? '/usr/bin/python3' : PROVIDER
  const row = line(pid, 800, pgid, `${CLAUDE} --setting-sources user --${flag}=${providerId} --verbose`)
  const parentRow = line(800, 700, 800, `${parent} --cli-input-fd7 1000 3000 -- ${CLAUDE}`)
  const table = `  PID  PPID  PGID COMMAND\n${parentRow}${row}`
  return options.duplicates
    ? table + line(pid + 1, 800, pid + 1, `${CLAUDE} --${flag}=${providerId}`)
    : table
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

test('reads the handle chain once even when the row id already matches a process', async () => {
  const { ops, recordReads } = fakeOps({
    table: processTable(SESSION_ID),
    records: [{ sessionId: 'orcasession-0000-1111', nativeId: SESSION_ID, chainIds: [SESSION_ID] }]
  })

  await stopSessionWithSignal({ workspaceId: 'w1', sessionId: SESSION_ID, dryRun: true, ops })

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

test('falls back to the stored handle chain when the row id is Orca’s own', async () => {
  const { ops, signalled } = fakeOps({
    table: processTable(SESSION_ID),
    records: [
      {
        sessionId: 'orcasession-0000-1111',
        nativeId: SESSION_ID,
        chainIds: ['older-session', SESSION_ID]
      }
    ]
  })

  const outcome = await stopSessionWithSignal({
    workspaceId: 'w1',
    sessionId: 'orcasession-0000-1111',
    dryRun: false,
    ops
  })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.sessionUuid, SESSION_ID)
  assert.deepEqual(signalled, [900])
})

test('refuses a paired pid that runs another agent kind', async () => {
  // A count-based pairing must never reach a process of a different agent: pid 900 is claude.
  const { ops, signalled } = fakeOps({ table: processTable(SESSION_ID) })

  const outcome = await stopPairedSession({
    workspaceId: 'w1',
    sessionId: 'orcasession-0000-1111',
    agent: 'antigravity',
    pid: 900,
    dryRun: false,
    ops
  })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'kind_mismatch')
  assert.deepEqual(signalled, [])
})

test('an unreadable session database is named in the refusal', async () => {
  const { ops } = fakeOps({ table: '', recordsError: 'database is locked' })

  const outcome = await stopSessionWithSignal({
    workspaceId: 'w1',
    sessionId: SESSION_ID,
    dryRun: false,
    ops
  })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'no_process')
  assert.match(outcome.message ?? '', /database is locked/)
})