// `orca plugin check` renders the panel once per scenario. `real` is a snapshot taken from the
// live host (sessions over its workspaces, with only the chats that still run having a process),
// with the focused workspace set to 小小 so the row the owner is in — Home — is the skipped one.
import { defineCheck, hostError } from 'orca/testing'
import type { SessionSnapshot } from './protocol'

const real: SessionSnapshot = {
  "workspaces": [
    {
      "id": "identity:wt2:local:5953f7e5-02c4-4fba-98dd-d8fb02b0a240",
      "name": "dsl-hub:main",
      "kind": "worktree",
      "terminalCount": 1
    },
    {
      "id": "identity:wt2:local:6ed392eb-3d8f-46f6-9cbe-f2d9141c33cd",
      "name": "Feat session resources close",
      "kind": "worktree",
      "terminalCount": 0
    },
    {
      "id": "folder:f8168b9e-ba71-4fbf-9b41-2b152abde888",
      "name": "钉钉沟通助手",
      "kind": "folder",
      "terminalCount": 0
    },
    {
      "id": "folder:cf9721a4-3ce2-410f-87d5-55da80cefb6e",
      "name": "数据核查助手",
      "kind": "folder",
      "terminalCount": 0
    },
    {
      "id": "folder:52cc4ad7-ad59-4592-bf32-e6e3fe0734d5",
      "name": "方舟规则助手",
      "kind": "folder",
      "terminalCount": 0
    },
    {
      "id": "folder:7b3ccc56-eecd-478c-b440-0cf4e5c31d61",
      "name": "上线助手",
      "kind": "folder",
      "terminalCount": 0
    },
    {
      "id": "folder:9d5ad5ae-bcb1-483e-9d22-290c80b7ce8a",
      "name": "trace追踪助手",
      "kind": "folder",
      "terminalCount": 0
    },
    {
      "id": "folder:a151ba26-a0a2-4e84-bf64-fcfe9b155cd0",
      "name": "工单助手",
      "kind": "folder",
      "terminalCount": 0
    },
    {
      "id": "folder:637d87aa-162f-41f8-ba04-b7313fbcd372",
      "name": "小小",
      "kind": "folder",
      "terminalCount": 0
    }
  ],
  "sessions": [
    {
      "workspaceId": "identity:wt2:local:5953f7e5-02c4-4fba-98dd-d8fb02b0a240",
      "workspaceName": "dsl-hub:main",
      "workspaceKind": "worktree",
      "terminalId": "term_2125095c-de61-480d-9195-4ac046fbd48a",
      "title": "⠋ π - dsl-hub",
      "agent": "pi",
      "state": "working",
      "stateStartedAt": 1795662300871,
      "sessionId": "01a215cc-f3d5-730c-9847-130b1c4dfc96",
      "hasProcess": null
    },
    {
      "workspaceId": "identity:wt2:local:6ed392eb-3d8f-46f6-9cbe-f2d9141c33cd",
      "workspaceName": "Feat session resources close",
      "workspaceKind": "worktree",
      "terminalId": null,
      "title": "重启后面板全「无法关闭」，且回收会把当前会话算进去",
      "agent": "claude",
      "state": "working",
      "stateStartedAt": 1795661806040,
      "sessionId": "5a522e69-9ed2-44e6-abfc-7390be7c5174",
      "hasProcess": true
    },
    {
      "workspaceId": "folder:f8168b9e-ba71-4fbf-9b41-2b152abde888",
      "workspaceName": "钉钉沟通助手",
      "workspaceKind": "folder",
      "terminalId": null,
      "title": "未命名会话",
      "agent": "claude",
      "state": "done",
      "stateStartedAt": 1795617250268,
      "sessionId": null,
      "hasProcess": false
    },
    {
      "workspaceId": "folder:cf9721a4-3ce2-410f-87d5-55da80cefb6e",
      "workspaceName": "数据核查助手",
      "workspaceKind": "folder",
      "terminalId": null,
      "title": "未命名会话",
      "agent": "claude",
      "state": "done",
      "stateStartedAt": 1795593041702,
      "sessionId": null,
      "hasProcess": false
    },
    {
      "workspaceId": "folder:52cc4ad7-ad59-4592-bf32-e6e3fe0734d5",
      "workspaceName": "方舟规则助手",
      "workspaceKind": "folder",
      "terminalId": null,
      "title": "未命名会话",
      "agent": "claude",
      "state": "done",
      "stateStartedAt": 1795593035676,
      "sessionId": null,
      "hasProcess": false
    },
    {
      "workspaceId": "folder:7b3ccc56-eecd-478c-b440-0cf4e5c31d61",
      "workspaceName": "上线助手",
      "workspaceKind": "folder",
      "terminalId": null,
      "title": "未命名会话",
      "agent": "claude",
      "state": "done",
      "stateStartedAt": 1795660209720,
      "sessionId": null,
      "hasProcess": false
    },
    {
      "workspaceId": "folder:9d5ad5ae-bcb1-483e-9d22-290c80b7ce8a",
      "workspaceName": "trace追踪助手",
      "workspaceKind": "folder",
      "terminalId": null,
      "title": "未命名会话",
      "agent": "claude",
      "state": "done",
      "stateStartedAt": 1795573554610,
      "sessionId": null,
      "hasProcess": false
    },
    {
      "workspaceId": "folder:a151ba26-a0a2-4e84-bf64-fcfe9b155cd0",
      "workspaceName": "工单助手",
      "workspaceKind": "folder",
      "terminalId": null,
      "title": "未命名会话",
      "agent": "claude",
      "state": "done",
      "stateStartedAt": 1795573491428,
      "sessionId": null,
      "hasProcess": false
    },
    {
      "workspaceId": "folder:637d87aa-162f-41f8-ba04-b7313fbcd372",
      "workspaceName": "小小",
      "workspaceKind": "folder",
      "terminalId": null,
      "title": "Home",
      "agent": "claude",
      "state": "done",
      "stateStartedAt": 1795661847163,
      "sessionId": "82092408-37fb-4ae5-bf44-83d986eb1e14",
      "hasProcess": true
    },
    {
      "workspaceId": "folder:637d87aa-162f-41f8-ba04-b7313fbcd372",
      "workspaceName": "小小",
      "workspaceKind": "folder",
      "terminalId": null,
      "title": "FWYY-36 产物存放规范与截图字体修复",
      "agent": "claude",
      "state": "done",
      "stateStartedAt": 1795661844911,
      "sessionId": "1d5698f7-3890-4fa9-be15-b096359f32d9",
      "hasProcess": true
    },
    {
      "workspaceId": "folder:637d87aa-162f-41f8-ba04-b7313fbcd372",
      "workspaceName": "小小",
      "workspaceKind": "folder",
      "terminalId": null,
      "title": "未命名会话",
      "agent": "claude",
      "state": "done",
      "stateStartedAt": 1795615758879,
      "sessionId": null,
      "hasProcess": false
    },
    {
      "workspaceId": "folder:637d87aa-162f-41f8-ba04-b7313fbcd372",
      "workspaceName": "小小",
      "workspaceKind": "folder",
      "terminalId": null,
      "title": "未命名会话",
      "agent": "claude",
      "state": "done",
      "stateStartedAt": 1795605719948,
      "sessionId": null,
      "hasProcess": false
    },
    {
      "workspaceId": "folder:637d87aa-162f-41f8-ba04-b7313fbcd372",
      "workspaceName": "小小",
      "workspaceKind": "folder",
      "terminalId": null,
      "title": "未命名会话",
      "agent": "claude",
      "state": "done",
      "stateStartedAt": 1795599121303,
      "sessionId": null,
      "hasProcess": false
    }
  ],
  "currentWorkspaceId": "folder:637d87aa-162f-41f8-ba04-b7313fbcd372",
  "workspacesTruncated": false,
  "failedWorkspaces": 0,
  "recentOps": [],
  "currentSessionId": "82092408-37fb-4ae5-bf44-83d986eb1e14"
}

export default defineCheck({
  real: { requests: { 'sessions.list': real } },
  realOpen: {
    storage: { showStopped: true, expandedGroups: {"identity:wt2:local:5953f7e5-02c4-4fba-98dd-d8fb02b0a240": true, "identity:wt2:local:6ed392eb-3d8f-46f6-9cbe-f2d9141c33cd": true, "folder:f8168b9e-ba71-4fbf-9b41-2b152abde888": true, "folder:cf9721a4-3ce2-410f-87d5-55da80cefb6e": true, "folder:52cc4ad7-ad59-4592-bf32-e6e3fe0734d5": true, "folder:7b3ccc56-eecd-478c-b440-0cf4e5c31d61": true, "folder:9d5ad5ae-bcb1-483e-9d22-290c80b7ce8a": true, "folder:a151ba26-a0a2-4e84-bf64-fcfe9b155cd0": true, "folder:637d87aa-162f-41f8-ba04-b7313fbcd372": true} },
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
        recentOps: [],
        currentSessionId: null
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
