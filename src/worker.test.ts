// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
import { afterEach, assert, beforeEach, hostError, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { useSignalOps, useTitleOps } from './worker'
import type { ChatTitleOps } from './botChats'
import type { SessionRecord } from './sessionRecord'
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
    chats: async () => []
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

function processTable(
  entries: { pid: number; resume: string; pgid?: number; flag?: 'resume' | 'session-id' }[]
): string {
  const rows = entries.map(
    ({ pid, resume, pgid, flag }) =>
      `${pid} 800 ${pgid ?? pid} ${CLAUDE} --${flag ?? 'resume'}=${resume}\n`
  )
  return `  PID  PPID  PGID COMMAND\n800 700 800 ${PROVIDER} --cli-input-fd7 1000 3000 -- ${CLAUDE}\n${rows.join('')}`
}

const AGY = '/Users/me/.local/bin/agy'

/**
 * The live host's shape for any agent: a wrapper starts the CLI, and the CLI starts a second
 * wrapper for itself (the stdin-end reporter), which must never count as an agent process.
 */
function agentChain(pid: number, binary: string, args: string): string {
  const wrapper = `${PROVIDER} --cli-input-fd7 1000 3000 session stdin-end -- ${binary} ${args}`
  return (
    `${pid} 700 ${pid} ${wrapper}\n` +
    `${pid + 2} ${pid} ${pid + 2} ${binary} ${args}\n` +
    `${pid + 3} ${pid + 2} ${pid + 3} ${wrapper}\n`
  )
}

function agentProcessTable(entries: { pid: number; binary: string; args: string }[]): string {
  return `  PID  PPID  PGID COMMAND\n${entries.map((entry) => agentChain(entry.pid, entry.binary, entry.args)).join('')}`
}

/** Installs fake process side effects; returns the pgids they were signalled with. */
function fakeOps(table: string, psError?: string, records: SessionRecord[] = []): number[] {
  const signalled: number[] = []
  let clock = 0
  const ops: SignalOps = {
    listSessionRecords: async () => records,
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
  // A chat with no title falls back to its session id, and the list says which id its process
  // answered to.
  assert.equal(snapshot.sessions[2]?.title, '会话 39e65ad8')
  assert.equal(snapshot.sessions[2]?.sessionId, S1)
  assert.equal(snapshot.sessions[2]?.matchedId, S1)
  assert.equal(snapshot.sessions[2]?.process, 'running')
  // Terminal-backed sessions are addressed by their terminal, not by a provider process.
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

test('sessions.reclaim closes every finished session with a matched process, and no working one', async () => {
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
  // S2 exists but is not its own group leader, so it is refused and the rest is left alone.
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
test('a chat whose ids matched no process is 无法判定, not 未运行', async () => {
  const host = hostWith([chat(S1), chat(S2)])
  fakeOps(processTable([{ pid: 900, resume: S1 }]))
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list')

  assert.equal(snapshot.sessions[0]?.process, 'running')
  assert.equal(snapshot.sessions[1]?.process, 'unknown')
  await worker.deactivate()
})

test('a chat with no candidate id is confirmed 未运行', async () => {
  const host = hostWith([agent(null, { title: null, sessionId: null })])
  fakeOps(processTable([]))
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list')

  assert.equal(snapshot.sessions[0]?.process, 'stopped')
  await worker.deactivate()
})

test('sessions.list leaves the process unknown when ps cannot be read', async () => {
  const host = hostWith([chat(S1)])
  fakeOps('', 'ps: operation not permitted')
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list')

  assert.equal(snapshot.sessions[0]?.process, 'unknown')
  assert.equal(snapshot.sessions[0]?.matchedId, null)
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
  fakeOps(processTable([{ pid: 900, resume: S1 }]), undefined, [
    { sessionId: 'orca-session-1', nativeId: S1, chainIds: [S1] }
  ])
  fakeTitles({ 'orca-session-1': '上线单 13703928' })
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list', {})

  // The row shows the id the process answered to, and that same id found the title.
  assert.equal(snapshot.sessions[0]?.matchedId, S1)
  assert.equal(snapshot.sessions[0]?.title, '上线单 13703928')
  await worker.deactivate()
})

test('an antigravity chat whose only native id is adopted shows its title', async () => {
  // The real "小小" case: Orca session 7980aac2 owns the chat, its record adopted b9388fd5 as
  // the native id, and the chain names only that native id — there is no claude-style chain
  // sessionId to alias from. The row shows b9388fd5, so its title must come from the adopted id.
  const ORCA = '7980aac2-bf09-406f-9627-8294f76955b4'
  const title = '我想开发一个orca插件，用于展示我创建的MR列表，点击后可以在浏览器打开。先画下原型'
  const host = hostWith([chat(ANTI, { agent: 'antigravity' })])
  fakeOps(agentProcessTable([{ pid: 8991, binary: AGY, args: ANTI_ARGS }]), undefined, [
    { sessionId: ORCA, nativeId: ANTI, chainIds: [ANTI] }
  ])
  fakeTitles({ [ORCA]: title })
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list', {})

  assert.equal(snapshot.sessions[0]?.sessionId, ANTI)
  assert.equal(snapshot.sessions[0]?.title, title)
  await worker.deactivate()
})

test('an unreadable title source keeps the id prefix and does not break the list', async () => {
  const host = hostWith([chat(S1)])
  useTitleOps({
    bots: async () => {
      throw new Error('orca: command not found')
    },
    chats: async () => []
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
  assert.equal(snapshot.sessions[0]?.process, 'stopped')
  await worker.deactivate()
})

test('maps four live sessions one to one, even when Orca reports an older id', async () => {
  // The real ids from the host: Home's row carries the provider id; the coordinator's row carries
  // the Orca session id; 未匹配到题目问题排查's row still carries the pre-rewind provider id.
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
    undefined,
    [
      { sessionId: HOME_ORCA, nativeId: HOME_NATIVE, chainIds: [HOME_NATIVE] },
      {
        sessionId: COORD_ORCA,
        nativeId: COORD_NATIVE,
        chainIds: ['39e65ad8-b388-4e57-8d80-e3ad8dc791e8', COORD_NATIVE]
      },
      { sessionId: SEARCH_ORCA, nativeId: SEARCH_NATIVE, chainIds: [SEARCH_OLD, SEARCH_NATIVE] },
      { sessionId: DEPLOY_ORCA, nativeId: DEPLOY_NATIVE, chainIds: [DEPLOY_NATIVE] }
    ]
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
    matchedId: session.matchedId,
    title: session.title,
    process: session.process
  }))

  assert.deepEqual(rows, [
    { rowId: HOME_NATIVE, matchedId: HOME_NATIVE, title: 'Home', process: 'running' },
    { rowId: COORD_ORCA, matchedId: COORD_NATIVE, title: '分析当前 Mac 内存占用', process: 'running' },
    { rowId: SEARCH_OLD, matchedId: SEARCH_NATIVE, title: '未匹配到题目问题排查', process: 'running' },
    { rowId: DEPLOY_NATIVE, matchedId: DEPLOY_NATIVE, title: '上线 dsl-hub 的 engine 与 controller 更新', process: 'running' }
  ])
  // No title crossed onto a process it does not belong to.
  assert.equal(rows.filter((row) => row.title === 'Home').length, 1)
  assert.equal(rows.filter((row) => row.title === '分析当前 Mac 内存占用').length, 1)
  await worker.deactivate()
})

const ANTI = 'b9388fd5-6cae-42ad-9627-0aad35007921'
const ANTI_ARGS = 'acp --dangerously-skip-permissions'

test('an agent that carries no session id is paired one to one with its only process', async () => {
  // antigravity: the argv has no --resume=/--session-id=, and its cwd is shared with every other
  // chat, so neither id nor directory can tell it apart. One session and one process is the
  // only evidence there is.
  const host = hostWith([chat(ANTI, { agent: 'antigravity' })])
  fakeOps(agentProcessTable([{ pid: 8991, binary: AGY, args: ANTI_ARGS }]))
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list')

  assert.equal(snapshot.sessions[0]?.process, 'running')
  assert.equal(snapshot.sessions[0]?.pairing, 'agent')
  assert.equal(snapshot.sessions[0]?.matchedId, null)
  assert.equal(snapshot.sessions[0]?.matchedPid, 8993)
  assert.equal(snapshot.sessions[0]?.matchedPgid, 8993)
  assert.match(snapshot.sessions[0]?.processNote ?? '', /1:1/)
  await worker.deactivate()
})

test('two sessions and one id-less process are 无法判定, never paired', async () => {
  const host = hostWith([
    chat(ANTI, { agent: 'antigravity' }),
    chat('7980aac2-0000-4000-8000-000000000000', { agent: 'antigravity' })
  ])
  fakeOps(agentProcessTable([{ pid: 8991, binary: AGY, args: ANTI_ARGS }]))
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list')

  assert.deepEqual(
    snapshot.sessions.map((session) => [session.process, session.pairing, session.matchedPid]),
    [
      ['unknown', null, null],
      ['unknown', null, null]
    ]
  )
  assert.match(snapshot.sessions[0]?.processNote ?? '', /会话 2 个 \/ 进程 1 个/)
  assert.match(snapshot.sessions[0]?.processNote ?? '', /不猜/)
  await worker.deactivate()
})

test('an agent whose CLI carries an id still matches exactly next to an id-less one', async () => {
  const host = hostWith([chat(S1), chat(ANTI, { agent: 'antigravity' })])
  fakeOps(
    agentProcessTable([
      { pid: 800, binary: CLAUDE, args: `--resume=${S1}` },
      { pid: 8991, binary: AGY, args: ANTI_ARGS }
    ])
  )
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list')

  assert.deepEqual(
    snapshot.sessions.map((session) => [session.process, session.pairing, session.matchedId, session.matchedPid]),
    [
      ['running', 'id', S1, null],
      ['running', 'agent', null, 8993]
    ]
  )
  await worker.deactivate()
})

test('closes a paired id-less session by the pid its kind was paired to', async () => {
  const host = hostWith([chat(ANTI, { agent: 'antigravity' })])
  const signalled = fakeOps(agentProcessTable([{ pid: 8991, binary: AGY, args: ANTI_ARGS }]))
  const worker = await mountWorker(main, { host })

  const outcome = await worker.request('sessions.close', { workspaceId: 'w1', sessionId: ANTI, pid: 8993 })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.how, 'signal')
  assert.equal(outcome.pid, 8993)
  assert.equal(outcome.pgid, 8993)
  assert.deepEqual(signalled, [8993])
  await worker.deactivate()
})

test('a paired close refuses a pid the fresh pairing no longer names', async () => {
  const host = hostWith([chat(ANTI, { agent: 'antigravity' })])
  const signalled = fakeOps(agentProcessTable([{ pid: 8991, binary: AGY, args: ANTI_ARGS }]))
  const worker = await mountWorker(main, { host })

  const outcome = await worker.request('sessions.close', { workspaceId: 'w1', sessionId: ANTI, pid: 9000 })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'pairing_changed')
  assert.deepEqual(signalled, [])
  await worker.deactivate()
})

test('a chat never takes the host agent title as its title', async () => {
  // `agents.list.title` may carry the bot's name for chats; it is not the conversation title.
  const host = hostWith([agent(null, { title: '小小', sessionId: S1 })])
  fakeOps('')
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('sessions.list', {})

  assert.equal(snapshot.sessions[0]?.title, '会话 39e65ad8')
  await worker.deactivate()
})
