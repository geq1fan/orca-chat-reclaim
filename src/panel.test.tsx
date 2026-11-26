// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import {
  afterEach,
  assert,
  hostError,
  mockHost,
  mount,
  test,
  type TestPanel,
  type TreeSnapshot
} from 'orca/testing'
import type { CloseOutcome, SessionRow, SessionSnapshot } from './protocol'
import * as panel from './panel'

let view: TestPanel | undefined
afterEach(() => view?.unmount())

function row(overrides: Partial<SessionRow>): SessionRow {
  return {
    workspaceId: 'w1',
    workspaceName: '工作区一',
    workspaceKind: 'worktree',
    terminalId: 't1',
    title: 'Claude 一',
    agent: 'claude',
    state: 'done',
    stateStartedAt: Date.now() - 60_000,
    sessionId: 'session-t1',
    process: null,
    matchedId: null,
    pairing: null,
    matchedPid: null,
    matchedPgid: null,
    processNote: null,
    ...overrides
  }
}

function ok(input: {
  workspaceId: string
  sessionId?: string | null
  terminalId?: string | null
}): CloseOutcome {
  const outcome: CloseOutcome = {
    ok: true,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId ?? null,
    how: input.terminalId ? 'terminal' : 'signal',
    dryRun: false
  }
  // Request answers are JSON: never include a field that would be undefined.
  if (input.terminalId) {
    outcome.terminalId = input.terminalId
  } else {
    outcome.pid = 900
    outcome.pgid = 900
  }
  return outcome
}

/** Storage the panel reads at mount: groups unfolded, and optionally the stopped rows shown. */
function stored(
  workspaces: string[],
  showStoppedRows = false
): { expandedGroups: Record<string, boolean>; showStopped?: boolean } {
  const expanded: Record<string, boolean> = {}
  for (const id of workspaces) expanded[id] = true
  return showStoppedRows ? { expandedGroups: expanded, showStopped: true } : { expandedGroups: expanded }
}

const snapshot: SessionSnapshot = {
  workspaces: [
    { id: 'w1', name: '工作区一', kind: 'worktree', terminalCount: 2 },
    { id: 'w2', name: '工作区二', kind: 'folder', terminalCount: 0 }
  ],
  sessions: [
    row({ terminalId: 't1', title: 'Claude 一', state: 'done' }),
    row({ terminalId: 't2', title: 'Claude 二', state: 'working' }),
    row({
      terminalId: 't3',
      title: 'Claude 三',
      workspaceId: 'w2',
      workspaceName: '工作区二',
      workspaceKind: 'folder',
      state: 'done'
    })
  ],
  currentWorkspaceId: 'w1',
  workspacesTruncated: false,
  failedWorkspaces: 0,
  recentOps: [],
}

test('groups sessions by workspace and counts the idle ones of the focused workspace', async () => {
  view = await mount(panel, {
    host: mockHost({ storage: stored(['w1', 'w2']), requests: { 'sessions.list': () => snapshot } })
  })

  assert.ok(view.find({ text: '工作区一' }))
  assert.ok(view.find({ text: '工作区二' }))
  assert.ok(view.find({ text: 'Claude 三' }))
  assert.ok(view.find({ text: /空闲 1 个 · 可回收 1 个/ }))
  assert.ok(view.find({ role: 'button', text: '回收空闲 (1)' }))
  // Only the finished session's close button is enabled; the working one is disabled.
  assert.deepEqual(
    view.findAll({ role: 'button', text: '关闭' }).map((button) => button.disabled),
    [false, true, false]
  )
  assert.deepEqual(view.errors, [])
})

test('a done chat with a session id can be closed', async () => {
  const closed: string[] = []
  const chats: SessionSnapshot = {
    workspaces: [{ id: 'folder:1', name: '小小', kind: 'folder', terminalCount: 0 }],
    sessions: [
      row({
        workspaceId: 'folder:1',
        workspaceName: '小小',
        workspaceKind: 'folder',
        terminalId: null,
        title: '会话 39e65ad8',
        sessionId: '39e65ad8-b388-4e57-8d80-e3ad8dc791e8',
        process: 'running'
      })
    ],
    currentWorkspaceId: 'folder:1',
    workspacesTruncated: false,
    failedWorkspaces: 0,
    recentOps: [],
  }
  view = await mount(panel, {
    host: mockHost({
      storage: stored(['folder:1']),
      requests: {
        'sessions.list': () => chats,
        'sessions.close': (input) => {
          closed.push(input.sessionId ?? '')
          return ok(input)
        }
      }
    })
  })

  assert.ok(view.find({ text: '会话 39e65ad8' }))
  assert.ok(view.find({ role: 'button', text: '关闭' }))
  assert.equal(view.find({ text: '无法关闭' }), null)
  assert.ok(view.find({ text: /空闲 1 个 · 可回收 1 个/ }))

  await view.press({ role: 'button', text: '关闭' })
  assert.deepEqual(closed, [])
  await view.press({ role: 'button', text: '确认关闭' })

  assert.deepEqual(closed, ['39e65ad8-b388-4e57-8d80-e3ad8dc791e8'])
  assert.ok(view.find({ text: '已关闭「会话 39e65ad8」。' }))
  assert.deepEqual(view.errors, [])
})

test('a done session with no terminal and no session id cannot be closed', async () => {
  const orphan: SessionSnapshot = {
    workspaces: [{ id: 'w1', name: '工作区一', kind: 'worktree', terminalCount: 0 }],
    sessions: [row({ terminalId: null, sessionId: null, title: '无句柄会话', process: 'stopped' })],
    currentWorkspaceId: 'w1',
    workspacesTruncated: false,
    failedWorkspaces: 0,
    recentOps: [],
  }
  view = await mount(panel, {
    host: mockHost({ storage: stored(['w1'], true), requests: { 'sessions.list': () => orphan } })
  })

  assert.equal(view.find({ role: 'button', text: '未运行' })?.disabled, true)
  assert.ok(view.find({ text: /空闲 1 个 · 可回收 0 个/ }))
  assert.deepEqual(view.errors, [])
})

test('closes a session only after the second press', async () => {
  const closed: string[] = []
  view = await mount(panel, {
    host: mockHost({
      storage: stored(['w1', 'w2']),
      requests: {
        'sessions.list': () => snapshot,
        'sessions.close': (input) => {
          closed.push(input.terminalId ?? '')
          return ok(input)
        }
      }
    })
  })

  const closeButtons = view.findAll({ role: 'button', text: '关闭' })
  assert.equal(closeButtons.length, 3)

  await view.press(closeButtons[0])
  assert.deepEqual(closed, [])
  assert.ok(view.find({ role: 'button', text: '确认关闭' }))

  await view.press({ role: 'button', text: '确认关闭' })
  assert.deepEqual(closed, ['t1'])
  assert.ok(view.find({ text: '已关闭「Claude 一」。' }))
  assert.deepEqual(view.refusals, [])
})

test('reclaim asks for the focused workspace and reports the count before closing', async () => {
  const reclaimed: string[] = []
  view = await mount(panel, {
    host: mockHost({
      storage: stored(['w1', 'w2']),
      requests: {
        'sessions.list': () => snapshot,
        'sessions.reclaim': ({ workspaceId }) => {
          reclaimed.push(workspaceId)
          return {
            outcomes: [ok({ workspaceId, terminalId: 't1' })],
            stoppedAtFailure: false
          }
        }
      }
    })
  })

  await view.press({ role: 'button', text: '回收空闲 (1)' })
  assert.deepEqual(reclaimed, [])
  assert.ok(view.find({ text: /将关闭当前工作区「工作区一」里 1 个会话/ }))

  await view.press({ role: 'button', text: '确认关闭 1 个' })
  assert.deepEqual(reclaimed, ['w1'])
  assert.ok(view.find({ text: '回收完成：已关闭 1 个空闲会话。' }))
})

test('shows the host error when a close is refused', async () => {
  view = await mount(panel, {
    host: mockHost({
      storage: stored(['w1', 'w2']),
      requests: {
        'sessions.list': () => snapshot,
        'sessions.close': () => {
          throw hostError('action_failed', 'terminal is not in the focused workspace')
        }
      }
    })
  })

  await view.press(view.findAll({ role: 'button', text: '关闭' })[0])
  await view.press({ role: 'button', text: '确认关闭' })

  assert.ok(
    view.find({ text: '关闭失败：terminal is not in the focused workspace（action_failed）' })
  )
  assert.deepEqual(view.errors, [])
})

test('shows the recent operations log', async () => {
  const withOps: SessionSnapshot = {
    ...snapshot,
    recentOps: [
      {
        at: Date.now() - 60_000,
        ok: true,
        dryRun: false,
        kind: 'signal',
        title: '会话 39e65ad8',
        sessionId: '39e65ad8-b388-4e57-8d80-e3ad8dc791e8',
        terminalId: null,
        sessionUuid: '39e65ad8-b388-4e57-8d80-e3ad8dc791e8',
        pid: 900,
        pgid: 900,
        message: null
      }
    ]
  }
  view = await mount(panel, {
    host: mockHost({ storage: stored(['w1', 'w2']), requests: { 'sessions.list': () => withOps } })
  })

  assert.ok(view.find({ text: /最近操作 \(1\)/ }))
  assert.deepEqual(view.errors, [])
})
test('a done chat whose ids matched no process is 无法判定 and greyed', async () => {
  const exited: SessionSnapshot = {
    workspaces: [{ id: 'folder:1', name: '小小', kind: 'folder', terminalCount: 0 }],
    sessions: [
      row({
        workspaceId: 'folder:1',
        workspaceName: '小小',
        workspaceKind: 'folder',
        terminalId: null,
        title: '会话 1d5698f7',
        sessionId: '1d5698f7-3890-4fa9-be15-b096359f32d9',
        process: 'unknown'
      })
    ],
    currentWorkspaceId: 'folder:1',
    workspacesTruncated: false,
    failedWorkspaces: 0,
    recentOps: [],
  }
  view = await mount(panel, {
    host: mockHost({ storage: stored(['folder:1'], true), requests: { 'sessions.list': () => exited } })
  })

  assert.equal(view.find({ role: 'button', text: '无法判定' })?.disabled, true)
  assert.ok(view.find({ text: '无法判定' }))
  assert.ok(view.find({ text: /可回收 0 个/ }))
  assert.deepEqual(view.errors, [])
})

test('an id-less pairing shows 无会话 id · pid N, and its note stays in the close tooltip', async () => {
  const idless: SessionSnapshot = {
    workspaces: [{ id: 'folder:1', name: '小小', kind: 'folder', terminalCount: 0 }],
    sessions: [
      row({
        workspaceId: 'folder:1',
        workspaceName: '小小',
        workspaceKind: 'folder',
        terminalId: null,
        title: '我想开发一个 orca 插件…',
        agent: 'antigravity',
        sessionId: 'b9388fd5-6cae-42ad-9627-0aad35007921',
        process: 'running',
        pairing: 'agent',
        matchedPid: 8993,
        matchedPgid: 8993,
        processNote:
          'antigravity 不提供会话 id；本机这种会话 1 个、进程 1 个，1:1 配到 pid 8993（pgid 8993）'
      }),
      row({
        workspaceId: 'folder:1',
        workspaceName: '小小',
        workspaceKind: 'folder',
        terminalId: null,
        title: '会话 1d5698f7',
        sessionId: '1d5698f7-3890-4fa9-be15-b096359f32d9',
        process: 'unknown',
        processNote: '有 1 个工作区没读到，无法确认本机 claude 的会话总数，不配对'
      })
    ],
    currentWorkspaceId: 'folder:1',
    workspacesTruncated: false,
    failedWorkspaces: 0,
    recentOps: [],
  }
  view = await mount(panel, {
    host: mockHost({ storage: stored(['folder:1'], true), requests: { 'sessions.list': () => idless } })
  })

  assert.equal(view.find({ text: '运行中（无会话 id）' }), null)
  assert.ok(view.find({ text: '无会话 id · pid 8993' }))
  // Explanations moved into the close button's tooltip: the row keeps two lines for every agent.
  assert.equal(view.find({ text: /antigravity 不提供会话 id/ }), null)
  assert.equal(view.find({ text: /无法判定：有 1 个工作区没读到/ }), null)
  assert.ok(
    String(view.find({ role: 'button', text: '关闭' })?.props.tooltip).includes(
      'antigravity 不提供会话 id'
    )
  )
  // The paired row is closeable; the unjudged one is not.
  assert.equal(view.find({ role: 'button', text: '关闭' })?.disabled, false)
  assert.equal(view.find({ role: 'button', text: '无法判定' })?.disabled, true)
  assert.deepEqual(view.errors, [])
})

/** Text leaves of a drawn subtree, in reading order; blank leaves are not fields. */
function treeLeaves(node: TreeSnapshot | string, out: string[] = []): string[] {
  if (typeof node === 'string') {
    if (node.trim() !== '') out.push(node.trim())
    return out
  }
  for (const child of node.children ?? []) treeLeaves(child, out)
  return out
}

/** The innermost drawn box that holds both the row's title and its close button. */
function rowLeaves(view: TestPanel, title: string): string[] {
  const tree = view.tree()
  if (tree === null || typeof tree === 'string') return []
  let found: TreeSnapshot | null = null
  const visit = (node: TreeSnapshot): void => {
    const text = treeLeaves(node).join(' ')
    if (text.includes(title) && text.includes('关闭')) found = node
    for (const child of node.children ?? []) {
      if (typeof child !== 'string') visit(child)
    }
  }
  visit(tree)
  return found === null ? [] : treeLeaves(found)
}

test('an id row and an id-less row draw the same fields in the same order', async () => {
  const both: SessionSnapshot = {
    workspaces: [{ id: 'folder:1', name: '小小', kind: 'folder', terminalCount: 0 }],
    sessions: [
      row({
        workspaceId: 'folder:1',
        workspaceName: '小小',
        workspaceKind: 'folder',
        terminalId: null,
        title: '有 id 的 claude 行',
        sessionId: '39e65ad8-b388-4e57-8d80-e3ad8dc791e8',
        matchedId: '39e65ad8-b388-4e57-8d80-e3ad8dc791e8',
        pairing: 'id',
        process: 'running'
      }),
      row({
        workspaceId: 'folder:1',
        workspaceName: '小小',
        workspaceKind: 'folder',
        terminalId: null,
        title: '无 id 的 antigravity 行',
        agent: 'antigravity',
        sessionId: 'b9388fd5-6cae-42ad-9627-0aad35007921',
        pairing: 'agent',
        matchedPid: 8993,
        matchedPgid: 8993,
        process: 'running',
        processNote:
          'antigravity 不提供会话 id；本机这种会话 1 个、进程 1 个，1:1 配到 pid 8993（pgid 8993）'
      })
    ],
    currentWorkspaceId: 'folder:1',
    workspacesTruncated: false,
    failedWorkspaces: 0,
    recentOps: []
  }
  view = await mount(panel, {
    host: mockHost({ storage: stored(['folder:1'], true), requests: { 'sessions.list': () => both } })
  })

  const withId = rowLeaves(view, '有 id 的 claude 行')
  const withoutId = rowLeaves(view, '无 id 的 antigravity 行')
  // Title / badge / agent / · / duration / · / handle / close button: the same slots, in the same
  // order. A row that explained its 1:1 pairing inline would carry a ninth leaf.
  const slots = (leaves: string[]): string[] =>
    leaves.map((text, index) => {
      if (index === 0) return 'title'
      if (index === 1) return 'badge'
      if (index === 2) return 'agent'
      if (index === leaves.length - 1) return 'close'
      if (text === '·') return 'separator'
      if (text === '已空闲' || text === '状态持续') return 'duration'
      return 'handle'
    })
  assert.equal(withId.length, 8)
  assert.equal(withoutId.length, 8)
  assert.deepEqual(slots(withId), slots(withoutId))
  assert.equal(withId[6], '会话 39e65ad8')
  assert.equal(withoutId[6], '无会话 id · pid 8993')
  // The explanation moved into the close button's tooltip, not into another row line.
  assert.equal(withoutId.some((text) => text.includes('1:1 配到')), false)
  assert.ok(
    String(view.findAll({ role: 'button', text: '关闭' })[1]?.props.tooltip).includes(
      '1:1 配到 pid 8993'
    )
  )
  assert.deepEqual(view.errors, [])
})

test('a refused close leaves its reason in the row itself', async () => {
  view = await mount(panel, {
    host: mockHost({
      storage: stored(['w1', 'w2']),
      requests: {
        'sessions.list': () => snapshot,
        'sessions.close': () => {
          throw hostError('action_failed', '没有找到运行中的进程')
        }
      }
    })
  })

  await view.press(view.findAll({ role: 'button', text: '关闭' })[0])
  await view.press({ role: 'button', text: '确认关闭' })

  // Exact text match, so this is the row's own line and not the top callout (which adds a code).
  assert.ok(view.find({ text: '关闭失败：没有找到运行中的进程（action_failed）' }))
  assert.ok(view.find({ text: /关闭失败：没有找到运行中的进程/ }))
  assert.deepEqual(view.errors, [])
})

test('shows the chat title above the session id, truncating a long one', async () => {
  const longTitle = '关闭没反应：进程是 --session-id 启动的，插件只认 --resume 所以要改匹配逻辑'
  const titled: SessionSnapshot = {
    workspaces: [{ id: 'folder:1', name: '小小', kind: 'folder', terminalCount: 0 }],
    sessions: [
      row({
        workspaceId: 'folder:1',
        workspaceName: '小小',
        workspaceKind: 'folder',
        terminalId: null,
        title: 'Took over 错题本三期',
        sessionId: '39e65ad8-b388-4e57-8d80-e3ad8dc791e8',
        process: 'running'
      }),
      row({
        workspaceId: 'folder:1',
        workspaceName: '小小',
        workspaceKind: 'folder',
        terminalId: null,
        title: longTitle,
        sessionId: '1d5698f7-3890-4fa9-be15-b096359f32d9',
        process: 'unknown'
      })
    ],
    currentWorkspaceId: 'folder:1',
    workspacesTruncated: false,
    failedWorkspaces: 0,
    recentOps: [],
  }
  view = await mount(panel, {
    host: mockHost({ storage: stored(['folder:1'], true), requests: { 'sessions.list': () => titled } })
  })

  assert.ok(view.find({ text: 'Took over 错题本三期' }))
  assert.ok(view.find({ text: '会话 39e65ad8' }))
  assert.ok(view.find({ text: `${longTitle.slice(0, 40)}…` }))
  assert.deepEqual(view.errors, [])
})

test('a chat with a live process reads 空闲, and every finished one is reclaimable', async () => {
  const live: SessionSnapshot = {
    workspaces: [{ id: 'folder:1', name: '小小', kind: 'folder', terminalCount: 0 }],
    sessions: [
      row({
        workspaceId: 'folder:1',
        workspaceName: '小小',
        workspaceKind: 'folder',
        terminalId: null,
        title: 'Took over 错题本三期',
        sessionId: '39e65ad8-b388-4e57-8d80-e3ad8dc791e8',
        stateStartedAt: Date.now() - 60_000,
        process: 'running'
      }),
      row({
        workspaceId: 'folder:1',
        workspaceName: '小小',
        workspaceKind: 'folder',
        terminalId: null,
        title: '每日记忆维护 run 5',
        sessionId: '1d5698f7-3890-4fa9-be15-b096359f32d9',
        stateStartedAt: Date.now() - 3_600_000,
        process: 'running'
      })
    ],
    currentWorkspaceId: 'folder:1',
    workspacesTruncated: false,
    failedWorkspaces: 0,
    recentOps: [],
  }
  view = await mount(panel, {
    host: mockHost({ storage: stored(['folder:1']), requests: { 'sessions.list': () => live } })
  })

  // Both rows have a live process, so both read 空闲 rather than 已结束, and both can be reclaimed.
  assert.equal(view.findAll({ text: '空闲' }).length >= 2, true)
  assert.ok(view.find({ role: 'button', text: '回收空闲 (2)' }))

  await view.press({ role: 'button', text: '回收空闲 (2)' })
  assert.ok(
    view.find({ text: /将关闭当前工作区「小小」里 2 个会话：「Took over 错题本三期」「每日记忆维护 run 5」/ })
  )
  assert.deepEqual(view.errors, [])
})

const mixed: SessionSnapshot = {
  workspaces: [{ id: 'folder:9', name: '小小', kind: 'folder', terminalCount: 0 }],
  sessions: [
    row({
      workspaceId: 'folder:9',
      workspaceName: '小小',
      workspaceKind: 'folder',
      terminalId: null,
      title: 'Home',
      sessionId: 'home-provider',
      process: 'running'
    }),
    row({
      workspaceId: 'folder:9',
      workspaceName: '小小',
      workspaceKind: 'folder',
      terminalId: null,
      title: '正在跑的另一条',
      sessionId: 'busy-provider',
      state: 'working',
      process: 'running'
    }),
    row({
      workspaceId: 'folder:9',
      workspaceName: '小小',
      workspaceKind: 'folder',
      terminalId: null,
      title: '未运行的那条',
      sessionId: null,
      process: 'stopped'
    })
  ],
  currentWorkspaceId: 'folder:9',
  workspacesTruncated: false,
  failedWorkspaces: 0,
  recentOps: [],
}

test('groups start folded, and unfolding one is remembered', async () => {
  view = await mount(panel, {
    host: mockHost({ requests: { 'sessions.list': () => mixed } })
  })

  // Folded: no session rows, but the group header still carries the counts.
  assert.equal(view.find({ text: 'Home' }), null)
  assert.ok(view.find({ text: /在运行 2 · 未运行 1/ }))
  assert.ok(view.find({ text: 'Orca 会话 3 条 · 匹配到进程 2 条' }))
  assert.ok(view.find({ text: /其余 1 条已确认未运行已隐藏/ }))

  await view.press({ role: 'button', text: '小小' })
  assert.ok(view.find({ text: 'Home' }))
  // Unfolding does not show the stopped rows; the toggle does.
  assert.equal(view.find({ text: '未运行的那条' }), null)
  assert.deepEqual(view.persisted.storage.expandedGroups, { 'folder:9': true })
  assert.deepEqual(view.errors, [])
})

test('the 显示无进程 switch shows unjudged rows and remembers its state', async () => {
  view = await mount(panel, {
    host: mockHost({
      storage: stored(['folder:9']),
      requests: { 'sessions.list': () => mixed }
    })
  })

  // The unfolded group is remembered, but stopped rows stay hidden until the switch is on.
  assert.ok(view.find({ text: 'Home' }))
  assert.equal(view.find({ text: '未运行的那条' }), null)
  assert.ok(view.find({ text: /其余 1 条已确认未运行已隐藏/ }))

  await view.toggle({ label: '显示无进程 (1)' })

  assert.ok(view.find({ text: '未运行的那条' }))
  assert.equal(view.persisted.storage.showStopped, true)
  assert.ok(view.find({ text: /其余 1 条已确认未运行（已显示）/ }))
  assert.deepEqual(view.errors, [])
})

test('workspaces with only unmatched sessions stay hidden until 显示无进程 is toggled on', async () => {
  const withStoppedGroup: SessionSnapshot = {
    workspaces: [
      { id: 'w-active', name: '运行工作区', kind: 'worktree', terminalCount: 1 },
      { id: 'w-stopped', name: '纯休眠工作区', kind: 'folder', terminalCount: 0 }
    ],
    sessions: [
      row({ workspaceId: 'w-active', workspaceName: '运行工作区', terminalId: 't1', title: 'Live' }),
      row({
        workspaceId: 'w-stopped',
        workspaceName: '纯休眠工作区',
        workspaceKind: 'folder',
        terminalId: null,
        sessionId: null,
        title: 'Stopped only',
        process: 'stopped'
      })
    ],
    currentWorkspaceId: 'w-active',
    workspacesTruncated: false,
    failedWorkspaces: 0,
    recentOps: [],
  }
  view = await mount(panel, {
    host: mockHost({ requests: { 'sessions.list': () => withStoppedGroup } })
  })

  assert.ok(view.find({ text: '运行工作区' }))
  assert.equal(view.find({ text: '纯休眠工作区' }), null)

  await view.toggle({ label: '显示无进程 (1)' })

  assert.ok(view.find({ text: '纯休眠工作区' }))
  assert.deepEqual(view.errors, [])
})

test('shows an actionable empty state when all sessions are stopped and hidden', async () => {
  const allStopped: SessionSnapshot = {
    workspaces: [{ id: 'w-stopped', name: '纯休眠工作区', kind: 'folder', terminalCount: 0 }],
    sessions: [
      row({
        workspaceId: 'w-stopped',
        workspaceName: '纯休眠工作区',
        workspaceKind: 'folder',
        terminalId: null,
        sessionId: null,
        title: '休眠会话',
        process: 'stopped'
      })
    ],
    currentWorkspaceId: 'w-stopped',
    workspacesTruncated: false,
    failedWorkspaces: 0,
    recentOps: [],
  }
  view = await mount(panel, {
    host: mockHost({ requests: { 'sessions.list': () => allStopped } })
  })

  assert.ok(view.find({ label: '没有正在运行的会话' }))
  await view.press({ role: 'button', text: '显示无进程 (1)' })

  assert.ok(view.find({ text: '纯休眠工作区' }))
  assert.equal(view.persisted.storage.showStopped, true)
  assert.deepEqual(view.errors, [])
})

test('the reconciliation line says how many sessions matched a process', async () => {
  view = await mount(panel, {
    host: mockHost({
      storage: stored(['folder:9']),
      requests: { 'sessions.list': () => mixed }
    })
  })

  assert.ok(view.find({ text: 'Orca 会话 3 条 · 匹配到进程 2 条' }))
  assert.ok(view.find({ text: /其余 1 条已确认未运行/ }))
  assert.equal(view.find({ text: '当前会话' }), null)
  assert.deepEqual(view.errors, [])
})

test('cancelling inline close confirmation dismisses it without closing', async () => {
  const closed: string[] = []
  view = await mount(panel, {
    host: mockHost({
      storage: stored(['w1']),
      requests: {
        'sessions.list': () => snapshot,
        'sessions.close': (input) => {
          closed.push(input.terminalId ?? '')
          return ok(input)
        }
      }
    })
  })

  await view.press(view.findAll({ role: 'button', text: '关闭' })[0])
  assert.ok(view.find({ role: 'button', text: '确认关闭' }))
  assert.ok(view.find({ role: 'button', text: '取消' }))

  await view.press({ role: 'button', text: '取消' })
  assert.equal(view.find({ role: 'button', text: '确认关闭' }), null)
  assert.deepEqual(closed, [])
  assert.deepEqual(view.errors, [])
})
