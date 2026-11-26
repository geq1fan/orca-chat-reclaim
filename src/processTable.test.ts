import { assert, test } from 'orca/testing'
import {
  agentProcesses,
  findAgentTargetByLease,
  parseLstartMs,
  parseProcessTable,
  PROVIDER_EXEC
} from './processTable'
import type { OwnerProcess } from './sessionRecord'

const START_STR = 'Thu Nov 26 16:29:56 2026'
const START_MS = Date.parse(START_STR)
const PROVIDER = `/Applications/Orca.app/Contents/MacOS/${PROVIDER_EXEC}`

function leaseOwner(overrides: Partial<OwnerProcess> = {}): OwnerProcess {
  return {
    hostId: 'local',
    pid: 87863,
    processStartTimeMs: START_MS,
    spawnToken: 'tok-1',
    runtime: 'rt-1',
    ...overrides
  }
}

test('parseProcessTable parses 5-column lstart rows (including single-digit days and trailing spaces) and legacy 4-column rows', () => {
  const output = [
    '  PID  PPID  PGID STARTED                      COMMAND',
    `87862 75346 87862 ${START_STR}     ${PROVIDER} --cli-input-fd7 1000 3000 session stdin-end -- /Users/zyb/.local/bin/pi --mode rpc`,
    `87863 87862 87863 ${START_STR}     pi           `,
    '  123   100   123 Thu Nov  5 09:05:23 2026     /Users/zyb/.local/bin/agy acp',
    '  900   800   900 /Users/me/.local/bin/claude --resume=abc'
  ].join('\n')

  const rows = parseProcessTable(output)
  assert.equal(rows.length, 4)
  assert.equal(rows[0]?.startTimeMs, START_MS)
  assert.equal(rows[1]?.command, 'pi')
  assert.equal(rows[1]?.startTimeMs, START_MS)
  assert.equal(rows[2]?.startTimeMs, parseLstartMs('Thu Nov  5 09:05:23 2026'))
  assert.equal(rows[3]?.startTimeMs, null)
  assert.equal(rows[3]?.command, '/Users/me/.local/bin/claude --resume=abc')
})

test('agentProcesses identifies direct children for pi, antigravity, claude, and interpreter-hosted omp while ignoring nested wrappers', () => {
  const output = [
    `100 1 100 ${START_STR} ${PROVIDER} -- /Users/zyb/.local/bin/agy acp`,
    `101 100 101 ${START_STR} /Users/zyb/.local/bin/agy acp`,
    `102 101 102 ${START_STR} ${PROVIDER} -- /Users/zyb/.local/bin/agy acp`,
    `200 1 200 ${START_STR} ${PROVIDER} -- /Users/zyb/.local/bin/pi --mode rpc`,
    `201 200 201 ${START_STR} pi           `,
    `300 1 300 ${START_STR} ${PROVIDER} -- /Users/zyb/.local/bin/omp --mode rpc`,
    `301 300 301 ${START_STR} node /Users/zyb/.local/bin/omp --mode rpc`,
    `400 1 400 ${START_STR} ${PROVIDER} -- /Users/zyb/.local/bin/claude --session-id=sid-1`,
    `401 400 401 ${START_STR} /Users/zyb/.local/bin/claude --session-id=sid-1`
  ].join('\n')

  const procs = agentProcesses(parseProcessTable(output))
  assert.deepEqual(
    procs.map((p) => [p.row.pid, p.kind, p.providerId]),
    [
      [101, 'antigravity', null],
      [201, 'pi', null],
      [301, 'omp', null],
      [401, 'claude', 'sid-1']
    ]
  )
})

test('findAgentTargetByLease verifies host, wrapper parent, kind, group leader, own pgid, and lstart anti-PID-reuse tolerance', () => {
  const table = parseProcessTable(
    [
      `87862 75346 87862 ${START_STR} ${PROVIDER} -- /Users/zyb/.local/bin/pi --mode rpc`,
      `87863 87862 87863 ${START_STR} pi           `,
      `87864 87862 87862 ${START_STR} pi           `,
      `87865     1 87865 ${START_STR} pi           `,
      `87866 87862 87866 /Users/zyb/.local/bin/pi`
    ].join('\n')
  )

  const okExact = findAgentTargetByLease(table, leaseOwner(), 'pi', 1)
  assert.equal(okExact.ok, true)
  if (okExact.ok) {
    assert.equal(okExact.target.pid, 87863)
    assert.equal(okExact.target.startTimeMs, START_MS)
  }

  // Exactly ±2000ms passes.
  const okAtBoundary = findAgentTargetByLease(
    table,
    leaseOwner({ processStartTimeMs: START_MS + 2000 }),
    'pi',
    1
  )
  assert.equal(okAtBoundary.ok, true)

  // Missing expectedKind or 'unknown' allows match.
  assert.equal(findAgentTargetByLease(table, leaseOwner(), 'unknown', 1).ok, true)
  assert.equal(findAgentTargetByLease(table, leaseOwner(), null, 1).ok, true)

  // Remote host refused.
  const remote = findAgentTargetByLease(table, leaseOwner({ hostId: 'ssh:dev' }), 'pi', 1)
  assert.equal(remote.ok, false)
  if (!remote.ok) assert.equal(remote.code, 'remote_host')

  // Unwrapped process or absent pid -> no_process.
  const nonWrapper = findAgentTargetByLease(table, leaseOwner({ pid: 87865 }), 'pi', 1)
  assert.equal(nonWrapper.ok, false)
  if (!nonWrapper.ok) assert.equal(nonWrapper.code, 'no_process')

  const absent = findAgentTargetByLease(table, leaseOwner({ pid: 99999 }), 'pi', 1)
  assert.equal(absent.ok, false)
  if (!absent.ok) assert.equal(absent.code, 'no_process')

  // Kind mismatch refused.
  const kindMismatch = findAgentTargetByLease(table, leaseOwner(), 'claude', 1)
  assert.equal(kindMismatch.ok, false)
  if (!kindMismatch.ok) assert.equal(kindMismatch.code, 'kind_mismatch')

  // Non-group-leader refused.
  const notLeader = findAgentTargetByLease(table, leaseOwner({ pid: 87864 }), 'pi', 1)
  assert.equal(notLeader.ok, false)
  if (!notLeader.ok) assert.equal(notLeader.code, 'not_group_leader')

  // Same pgid as worker refused.
  const ownGroup = findAgentTargetByLease(table, leaseOwner(), 'pi', 87863)
  assert.equal(ownGroup.ok, false)
  if (!ownGroup.ok) assert.equal(ownGroup.code, 'own_group')

  // PID reuse (>2000ms) refused.
  const reused = findAgentTargetByLease(
    table,
    leaseOwner({ processStartTimeMs: START_MS + 2001 }),
    'pi',
    1
  )
  assert.equal(reused.ok, false)
  if (!reused.ok) assert.equal(reused.code, 'start_time_mismatch')

  // Missing lstart on ps row when lease expects start time -> start_time_unknown.
  const missingStart = findAgentTargetByLease(table, leaseOwner({ pid: 87866 }), 'pi', 1)
  assert.equal(missingStart.ok, false)
  if (!missingStart.ok) assert.equal(missingStart.code, 'start_time_unknown')

  // When lease itself has processStartTimeMs: null, missing lstart is tolerated.
  const nullLeaseStart = findAgentTargetByLease(
    table,
    leaseOwner({ pid: 87866, processStartTimeMs: null }),
    'pi',
    1
  )
  assert.equal(nullLeaseStart.ok, true)
})
