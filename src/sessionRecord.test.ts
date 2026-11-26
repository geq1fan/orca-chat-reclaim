import { assert, test } from 'orca/testing'
import {
  aliasTitles,
  chainSessionIds,
  extractWorktreePath,
  findSessionRecord,
  parseOwnerProcess,
  parseSessionRecordRow,
  parseSqliteBool,
  sessionCandidates,
  type SessionRecord
} from './sessionRecord'

function makeRecord(overrides: Partial<SessionRecord> & { sessionId: string }): SessionRecord {
  return {
    nativeId: null,
    chainIds: [],
    provider: 'claude',
    workspaceId: 'folder:w1',
    hostId: 'local',
    conversationName: null,
    claimStatus: 'released',
    unreconciled: false,
    ownerProcess: null,
    deathKind: null,
    ...overrides
  }
}

test('parseSessionRecordRow parses live lease, boolean variants, and missing fields', () => {
  const live = parseSessionRecordRow({
    session_id: 'orca-1',
    adopted_native_id: 'native-1',
    provider: 'pi',
    workspace_id: 'repo::/tmp/wt',
    host_id: 'local',
    conversation_name: '修复插件',
    chain: JSON.stringify([{ handle: { agent: 'pi', nativeId: '/tmp/session.jsonl' } }]),
    claim_status: 'live',
    unreconciled: 0,
    owner_process: JSON.stringify({
      hostId: 'local',
      pid: 87863,
      processStartTimeMs: 1795681796000,
      spawnToken: 'tok-1',
      runtime: 'rt-1'
    }),
    death_kind: null
  })
  assert.ok(live)
  assert.equal(live.sessionId, 'orca-1')
  assert.equal(live.nativeId, 'native-1')
  assert.deepEqual(live.chainIds, ['/tmp/session.jsonl'])
  assert.equal(live.provider, 'pi')
  assert.equal(live.workspaceId, 'repo::/tmp/wt')
  assert.equal(live.hostId, 'local')
  assert.equal(live.conversationName, '修复插件')
  assert.equal(live.claimStatus, 'live')
  assert.equal(live.unreconciled, false)
  assert.deepEqual(live.ownerProcess, {
    hostId: 'local',
    pid: 87863,
    processStartTimeMs: 1795681796000,
    spawnToken: 'tok-1',
    runtime: 'rt-1'
  })
  assert.equal(live.deathKind, null)

  const unreconciled = parseSessionRecordRow({
    session_id: 'orca-2',
    unreconciled: 1,
    claim_status: 'conflicted',
    owner_process: '{bad json',
    death_kind: 'exit-observed'
  })
  assert.ok(unreconciled)
  assert.equal(unreconciled.unreconciled, true)
  assert.equal(unreconciled.claimStatus, 'conflicted')
  assert.equal(unreconciled.ownerProcess, null)
  assert.equal(unreconciled.deathKind, 'exit-observed')

  assert.equal(parseSessionRecordRow({ session_id: '' }), null)
  assert.equal(parseSessionRecordRow({}), null)
  assert.equal(parseSqliteBool(true), true)
  assert.equal(parseSqliteBool('1'), true)
  assert.equal(parseSqliteBool(0), false)
  assert.equal(parseOwnerProcess({ hostId: 'local', pid: -1 }), null)
  assert.equal(parseOwnerProcess({ hostId: '', pid: 123 }), null)
})

test('extractWorktreePath parses repo::path ids and ignores folder ids', () => {
  assert.equal(extractWorktreePath('dd72a732::/Users/zyb/orca/worktree'), '/Users/zyb/orca/worktree')
  assert.equal(extractWorktreePath('folder:637d87aa-162f-41f8-ba04-b7313fbcd372'), null)
  assert.equal(extractWorktreePath('repo::'), null)
  assert.equal(extractWorktreePath(null), null)
})

test('findSessionRecord obeys priority sessionId > nativeId > chainIds and narrows ambiguity', () => {
  const r1 = makeRecord({
    sessionId: 'id-a',
    nativeId: 'id-b',
    chainIds: ['shared'],
    workspaceId: 'folder:w1'
  })
  const r2 = makeRecord({
    sessionId: 'id-b',
    nativeId: 'shared',
    chainIds: ['shared'],
    workspaceId: 'repo::/tmp/w2'
  })
  const r3 = makeRecord({
    sessionId: 'id-c',
    nativeId: 'dup-native',
    chainIds: ['shared'],
    workspaceId: 'repo::/tmp/w3'
  })
  const r4 = makeRecord({
    sessionId: 'id-d',
    nativeId: 'dup-native',
    chainIds: [],
    workspaceId: 'folder:w4'
  })

  // Exact primary key beats nativeId match on r1.
  const pkHit = findSessionRecord([r1, r2], 'id-b')
  assert.equal(pkHit.status, 'found')
  if (pkHit.status === 'found') assert.equal(pkHit.record.sessionId, 'id-b')

  // Ambiguous nativeId narrowed by workspaceId.
  const byWs = findSessionRecord([r3, r4], 'dup-native', 'folder:w4')
  assert.equal(byWs.status, 'found')
  if (byWs.status === 'found') assert.equal(byWs.record.sessionId, 'id-d')

  // Ambiguous nativeId narrowed by worktree path when workspaceId uses identity:wt2:...
  const byPath = findSessionRecord([r3, r4], 'dup-native', 'identity:wt2:local:123', '/tmp/w3')
  assert.equal(byPath.status, 'found')
  if (byPath.status === 'found') assert.equal(byPath.record.sessionId, 'id-c')

  // Unresolvable ambiguity stays ambiguous and does not guess.
  const ambig = findSessionRecord([r3, r4], 'dup-native', 'folder:other')
  assert.equal(ambig.status, 'ambiguous')

  assert.equal(findSessionRecord([r1], 'missing').status, 'not_found')
  assert.equal(findSessionRecord([r1], null).status, 'not_found')
})

test('sessionCandidates and aliasTitles work with canonical, native, and chain ids', () => {
  const records = [
    makeRecord({
      sessionId: 'orca-1',
      nativeId: 'native-1',
      chainIds: ['old-1', 'native-1']
    })
  ]
  assert.deepEqual(sessionCandidates(records, 'old-1'), ['old-1', 'orca-1', 'native-1'])
  assert.deepEqual(sessionCandidates(records, null), [])

  const aliased = aliasTitles({ 'old-1': '历史标题' }, records)
  assert.equal(aliased['orca-1'], '历史标题')
  assert.equal(aliased['native-1'], '历史标题')
  assert.deepEqual(chainSessionIds('invalid'), [])
})
