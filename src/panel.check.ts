// `orca plugin check` renders the panel once per scenario. `real` reflects the v0.1.8 host
// model: active chats come from `orca diagnostics memory` + `agent_session_records.lease` +
// `ps lstart` verification (covering claude, pi, and antigravity, with pi's `.jsonl` native path
// normalized to canonical Orca `sessionId`), and exited sessions carry released leases (`stopped`)
// so the `无法判定` count is zero.
import { defineCheck, hostError } from 'orca/testing'
import type { SessionSnapshot } from './protocol'

const real: SessionSnapshot = {
  workspaces: [
    {
      id: 'identity:wt2:local:7072fb48-0d5c-413a-9d3e-f6a4830ae582',
      name: '错题本三期',
      kind: 'worktree',
      path: '/Users/zyb/orca/workspaces/mistake-book/错题本三期',
      terminalCount: 1
    },
    {
      id: 'identity:wt2:local:e0c4dee5-4607-4413-bc75-80e622164c1c',
      name: 'fix-resource-manager-sync',
      kind: 'worktree',
      path: '/Users/zyb/orca/workspaces/orca-chat-reclaim/fix-resource-manager-sync',
      terminalCount: 0
    },
    {
      id: 'folder:f8168b9e-ba71-4fbf-9b41-2b152abde888',
      name: '钉钉沟通助手',
      kind: 'folder',
      path: '/Users/zyb/.orca/bots/dingtalk',
      terminalCount: 0
    },
    {
      id: 'folder:cf9721a4-3ce2-410f-87d5-55da80cefb6e',
      name: '数据核查助手',
      kind: 'folder',
      path: '/Users/zyb/.orca/bots/data',
      terminalCount: 0
    },
    {
      id: 'folder:9d5ad5ae-bcb1-483e-9d22-290c80b7ce8a',
      name: 'trace追踪助手',
      kind: 'folder',
      path: '/Users/zyb/.orca/bots/trace',
      terminalCount: 0
    },
    {
      id: 'folder:637d87aa-162f-41f8-ba04-b7313fbcd372',
      name: '小小',
      kind: 'folder',
      path: '/Users/zyb/.orca/bots/bot',
      terminalCount: 0
    }
  ],
  sessions: [
    {
      workspaceId: 'identity:wt2:local:7072fb48-0d5c-413a-9d3e-f6a4830ae582',
      workspaceName: '错题本三期',
      workspaceKind: 'worktree',
      terminalId: 'term_f09ea47c-cb39-4ec1-9b44-15782461077a',
      title: 'Users zyb orca workspaces mistake book',
      agent: 'pi',
      state: 'working',
      stateKnown: true,
      stateStartedAt: 1795683233214,
      sessionId: '099d8e1b-b98a-4e4b-8d97-ed67f51ddae9',
      orcaSessionId: '099d8e1b-b98a-4e4b-8d97-ed67f51ddae9',
      memoryBytes: 507397944,
      process: null,
      matchedId: null,
      pairing: null,
      matchedPid: null,
      matchedPgid: null,
      processNote: null
    },
    {
      workspaceId: 'identity:wt2:local:e0c4dee5-4607-4413-bc75-80e622164c1c',
      workspaceName: 'fix-resource-manager-sync',
      workspaceKind: 'worktree',
      terminalId: null,
      title: '插件 0.1.8：对齐资源管理器与 lease 精确判定',
      agent: 'antigravity',
      state: 'working',
      stateKnown: true,
      stateStartedAt: 1795685996105,
      sessionId: 'b113bd23-8e6e-4402-96b4-40865388c443',
      orcaSessionId: 'b113bd23-8e6e-4402-96b4-40865388c443',
      memoryBytes: 278249096,
      process: 'running',
      matchedId: null,
      pairing: 'lease',
      matchedPid: 69170,
      matchedPgid: 69170,
      processNote: '租约精确匹配 pid 69170（pgid 69170 · startTime 1795685994000）'
    },
    {
      workspaceId: 'folder:f8168b9e-ba71-4fbf-9b41-2b152abde888',
      workspaceName: '钉钉沟通助手',
      workspaceKind: 'folder',
      terminalId: null,
      title: 'Home',
      agent: 'claude',
      state: 'done',
      stateKnown: true,
      stateStartedAt: 1795617250268,
      sessionId: '74dcaf3e-af5e-4555-b116-bb7752e3250b',
      orcaSessionId: '74dcaf3e-af5e-4555-b116-bb7752e3250b',
      memoryBytes: null,
      process: 'stopped',
      matchedId: null,
      pairing: null,
      matchedPid: null,
      matchedPgid: null,
      processNote: '租约已释放（exit-observed），确认未运行'
    },
    {
      workspaceId: 'folder:cf9721a4-3ce2-410f-87d5-55da80cefb6e',
      workspaceName: '数据核查助手',
      workspaceKind: 'folder',
      terminalId: null,
      title: 'Home',
      agent: 'claude',
      state: 'done',
      stateKnown: true,
      stateStartedAt: 1795593041702,
      sessionId: 'ca77ffdb-0432-421e-8283-dc92cdde4b8a',
      orcaSessionId: 'ca77ffdb-0432-421e-8283-dc92cdde4b8a',
      memoryBytes: null,
      process: 'stopped',
      matchedId: null,
      pairing: null,
      matchedPid: null,
      matchedPgid: null,
      processNote: '租约已释放（exit-observed），确认未运行'
    },
    {
      workspaceId: 'folder:9d5ad5ae-bcb1-483e-9d22-290c80b7ce8a',
      workspaceName: 'trace追踪助手',
      workspaceKind: 'folder',
      terminalId: null,
      title: 'Home',
      agent: 'claude',
      state: 'done',
      stateKnown: true,
      stateStartedAt: 1795573554610,
      sessionId: '9fd6a76e-cb7e-453a-aca3-f56f2cab4310',
      orcaSessionId: '9fd6a76e-cb7e-453a-aca3-f56f2cab4310',
      memoryBytes: null,
      process: 'stopped',
      matchedId: null,
      pairing: null,
      matchedPid: null,
      matchedPgid: null,
      processNote: '租约已释放（exit-observed），确认未运行'
    },
    {
      workspaceId: 'folder:637d87aa-162f-41f8-ba04-b7313fbcd372',
      workspaceName: '小小',
      workspaceKind: 'folder',
      terminalId: null,
      title: '分析当前 Mac 内存占用',
      agent: 'claude',
      state: 'done',
      stateKnown: true,
      stateStartedAt: 1795679096906,
      sessionId: '69af17fc-fe61-4578-a2b4-f37f364c31cd',
      orcaSessionId: '69af17fc-fe61-4578-a2b4-f37f364c31cd',
      memoryBytes: 583727216,
      process: 'running',
      matchedId: '82092408-37fb-4ae5-bf44-83d986eb1e14',
      pairing: 'lease',
      matchedPid: 20822,
      matchedPgid: 20822,
      processNote: '租约精确匹配 pid 20822（pgid 20822 · startTime 1795676723000）'
    },
    {
      workspaceId: 'folder:637d87aa-162f-41f8-ba04-b7313fbcd372',
      workspaceName: '小小',
      workspaceKind: 'folder',
      terminalId: null,
      title: 'Orca 聊天窗打开 pi 不加载插件解法',
      agent: 'pi',
      state: 'done',
      stateKnown: true,
      stateStartedAt: 1795681796000,
      sessionId: '/Users/zyb/.pi/agent/sessions/--Users-zyb-.orca-bots-bot--/2026-11-26T08-23-29-852Z_01a216f3-db3c-71e3-acb1-486e12204542.jsonl',
      orcaSessionId: '3bfdeb92-fe24-4ebb-8bc2-4a73334cf2e3',
      memoryBytes: 237373592,
      process: 'running',
      matchedId: null,
      pairing: 'lease',
      matchedPid: 87863,
      matchedPgid: 87863,
      processNote: '租约精确匹配 pid 87863（pgid 87863 · startTime 1795681796000）'
    },
    {
      workspaceId: 'folder:637d87aa-162f-41f8-ba04-b7313fbcd372',
      workspaceName: '小小',
      workspaceKind: 'folder',
      terminalId: null,
      title: '未匹配到题目问题排查',
      agent: 'claude',
      state: 'done',
      stateKnown: true,
      stateStartedAt: 1795678718413,
      sessionId: 'fb001612-9c34-463e-9dd2-2dcb6441a2d1',
      orcaSessionId: 'fb001612-9c34-463e-9dd2-2dcb6441a2d1',
      memoryBytes: 652668376,
      process: 'running',
      matchedId: '600d75f6-dbf4-44e5-bb55-9c35e614370b',
      pairing: 'lease',
      matchedPid: 23646,
      matchedPgid: 23646,
      processNote: '租约精确匹配 pid 23646（pgid 23646 · startTime 1795683828000）'
    },
    {
      workspaceId: 'folder:637d87aa-162f-41f8-ba04-b7313fbcd372',
      workspaceName: '小小',
      workspaceKind: 'folder',
      terminalId: null,
      title: '会话资源这个插件目前存在5个无法判定的对话，要怎么彻底解决这个问题？',
      agent: 'antigravity',
      state: 'done',
      stateKnown: true,
      stateStartedAt: 1795685245000,
      sessionId: 'de053e0e-d00b-4686-bb88-39bea11d4a8f',
      orcaSessionId: 'de053e0e-d00b-4686-bb88-39bea11d4a8f',
      memoryBytes: 303012416,
      process: 'running',
      matchedId: null,
      pairing: 'lease',
      matchedPid: 56876,
      matchedPgid: 56876,
      processNote: '租约精确匹配 pid 56876（pgid 56876 · startTime 1795685245000）'
    },
    {
      workspaceId: 'folder:637d87aa-162f-41f8-ba04-b7313fbcd372',
      workspaceName: '小小',
      workspaceKind: 'folder',
      terminalId: null,
      title: '已退出 pi 会话',
      agent: 'pi',
      state: 'done',
      stateKnown: true,
      stateStartedAt: 1795661844911,
      sessionId: '/Users/zyb/.pi/agent/sessions/--Users-zyb-.orca-bots-bot--/2026-11-26T07-00-00-000Z_deadbeef.jsonl',
      orcaSessionId: 'bb0d11e8-e515-4b62-8841-8473140fcda2',
      memoryBytes: null,
      process: 'stopped',
      matchedId: null,
      pairing: null,
      matchedPid: null,
      matchedPgid: null,
      processNote: '租约已释放（exit-observed），确认未运行'
    }
  ],
  currentWorkspaceId: 'folder:637d87aa-162f-41f8-ba04-b7313fbcd372',
  workspacesTruncated: false,
  failedWorkspaces: 0,
  recentOps: [
    {
      at: 1795663235900,
      ok: true,
      dryRun: false,
      kind: 'signal',
      title: '会话 1d5698f7',
      sessionId: '1d5698f7-3890-4fa9-be15-b096359f32d9',
      terminalId: null,
      sessionUuid: '1d5698f7-3890-4fa9-be15-b096359f32d9',
      pid: 80838,
      pgid: 80838,
      message: null
    }
  ]
}

const rowWorkspace = {
  id: 'folder:1',
  name: '小小',
  kind: 'folder' as const,
  path: '/Users/zyb/.orca/bots/bot',
  terminalCount: 0
}

const withId: SessionSnapshot = {
  workspaces: [rowWorkspace],
  sessions: [
    {
      workspaceId: 'folder:1',
      workspaceName: '小小',
      workspaceKind: 'folder',
      terminalId: null,
      title: 'Took over 错题本三期',
      agent: 'claude',
      state: 'done',
      stateKnown: true,
      stateStartedAt: Date.now() - 3_600_000,
      sessionId: '82092408-37fb-4ae5-bf44-83d986eb1e14',
      orcaSessionId: '69af17fc-fe61-4578-a2b4-f37f364c31cd',
      memoryBytes: 583727216,
      process: 'running',
      matchedId: '82092408-37fb-4ae5-bf44-83d986eb1e14',
      pairing: 'lease',
      matchedPid: 20822,
      matchedPgid: 20822,
      processNote: '租约精确匹配 pid 20822（pgid 20822 · startTime 1795676723000）'
    }
  ],
  currentWorkspaceId: 'folder:1',
  workspacesTruncated: false,
  failedWorkspaces: 0,
  recentOps: []
}

const piLease: SessionSnapshot = {
  workspaces: [rowWorkspace],
  sessions: [
    {
      workspaceId: 'folder:1',
      workspaceName: '小小',
      workspaceKind: 'folder',
      terminalId: null,
      title: 'Orca 聊天窗打开 pi 不加载插件解法',
      agent: 'pi',
      state: 'done',
      stateKnown: true,
      stateStartedAt: Date.now() - 3_600_000,
      sessionId: '/Users/zyb/.pi/agent/sessions/--Users-zyb-.orca-bots-bot--/2026-11-26T08-23-29-852Z_01a216f3.jsonl',
      orcaSessionId: '3bfdeb92-fe24-4ebb-8bc2-4a73334cf2e3',
      memoryBytes: 237373592,
      process: 'running',
      matchedId: null,
      pairing: 'lease',
      matchedPid: 87863,
      matchedPgid: 87863,
      processNote: '租约精确匹配 pid 87863（pgid 87863 · startTime 1795681796000）'
    }
  ],
  currentWorkspaceId: 'folder:1',
  workspacesTruncated: false,
  failedWorkspaces: 0,
  recentOps: []
}

const stateUnknown: SessionSnapshot = {
  workspaces: [rowWorkspace],
  sessions: [
    {
      workspaceId: 'folder:1',
      workspaceName: '小小',
      workspaceKind: 'folder',
      terminalId: null,
      title: '仅在资源管理器出现的工作区会话',
      agent: 'antigravity',
      state: 'working',
      stateKnown: false,
      stateStartedAt: 0,
      sessionId: 'de053e0e-d00b-4686-bb88-39bea11d4a8f',
      orcaSessionId: 'de053e0e-d00b-4686-bb88-39bea11d4a8f',
      memoryBytes: 303012416,
      process: 'running',
      matchedId: null,
      pairing: 'lease',
      matchedPid: 56876,
      matchedPgid: 56876,
      processNote: '租约精确匹配 pid 56876（pgid 56876）；未从 Orca 获取到会话空闲状态，暂不可关闭'
    }
  ],
  currentWorkspaceId: 'folder:1',
  workspacesTruncated: false,
  failedWorkspaces: 0,
  recentOps: []
}

const rowStorage = { expandedGroups: { 'folder:1': true } }

export default defineCheck({
  real: { requests: { 'sessions.list': real } },
  withId: { storage: rowStorage, requests: { 'sessions.list': withId } },
  piLease: { storage: rowStorage, requests: { 'sessions.list': piLease } },
  stateUnknown: { storage: rowStorage, requests: { 'sessions.list': stateUnknown } },
  realOpen: {
    storage: {
      showStopped: true,
      expandedGroups: {
        'identity:wt2:local:7072fb48-0d5c-413a-9d3e-f6a4830ae582': true,
        'identity:wt2:local:e0c4dee5-4607-4413-bc75-80e622164c1c': true,
        'folder:f8168b9e-ba71-4fbf-9b41-2b152abde888': true,
        'folder:cf9721a4-3ce2-410f-87d5-55da80cefb6e': true,
        'folder:9d5ad5ae-bcb1-483e-9d22-290c80b7ce8a': true,
        'folder:637d87aa-162f-41f8-ba04-b7313fbcd372': true
      }
    },
    requests: { 'sessions.list': real }
  },
  empty: {
    requests: {
      'sessions.list': {
        workspaces: [],
        sessions: [],
        currentWorkspaceId: null,
        workspacesTruncated: false,
        failedWorkspaces: 0,
        recentOps: []
      }
    }
  },
  failed: {
    requests: {
      'sessions.list': () => {
        throw hostError('unavailable', 'Orca host did not answer')
      }
    }
  }
})
