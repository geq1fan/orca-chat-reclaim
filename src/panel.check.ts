// `orca plugin check` renders the panel once per scenario. `real` is a snapshot taken from the
// live host after the id-mapping fix: the four live 小小 chats are matched by the ids their claude
// processes carry, even where `agents.list` still reports an older id.
import { defineCheck, hostError } from 'orca/testing'
import type { SessionSnapshot } from './protocol'

const real: SessionSnapshot = {
  "workspaces": [
    {
      "id": "identity:wt2:local:7072fb48-0d5c-413a-9d3e-f6a4830ae582",
      "name": "错题本三期",
      "kind": "worktree",
      "terminalCount": 1
    },
    {
      "id": "identity:wt2:local:9f2b4863-0493-45a7-8fda-abc10514292f",
      "name": "Fix session process title",
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
      "workspaceId": "identity:wt2:local:7072fb48-0d5c-413a-9d3e-f6a4830ae582",
      "workspaceName": "错题本三期",
      "workspaceKind": "worktree",
      "terminalId": "term_f09ea47c-cb39-4ec1-9b44-15782461077a",
      "title": "⠋ π - 错题本三期",
      "agent": "pi",
      "state": "working",
      "stateStartedAt": 1795676106597,
      "sessionId": "01a21695-96fe-76b1-8521-e4ba75d3213d",
      "process": null,
      "matchedId": null
    },
    {
      "workspaceId": "identity:wt2:local:9f2b4863-0493-45a7-8fda-abc10514292f",
      "workspaceName": "Fix session process title",
      "workspaceKind": "worktree",
      "terminalId": null,
      "title": "会话 77b4a752",
      "agent": "claude",
      "state": "working",
      "stateStartedAt": 1795677059794,
      "sessionId": "77b4a752-9be7-4dfb-8ac1-3776a1c30e36",
      "process": "running",
      "matchedId": "77b4a752-9be7-4dfb-8ac1-3776a1c30e36"
    },
    {
      "workspaceId": "folder:f8168b9e-ba71-4fbf-9b41-2b152abde888",
      "workspaceName": "钉钉沟通助手",
      "workspaceKind": "folder",
      "terminalId": null,
      "title": "Home",
      "agent": "claude",
      "state": "done",
      "stateStartedAt": 1795617250268,
      "sessionId": "5a51a82b-9f4b-47eb-9763-52f5e4e38a4d",
      "process": "unknown",
      "matchedId": null
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
      "process": "stopped",
      "matchedId": null
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
      "process": "stopped",
      "matchedId": null
    },
    {
      "workspaceId": "folder:7b3ccc56-eecd-478c-b440-0cf4e5c31d61",
      "workspaceName": "上线助手",
      "workspaceKind": "folder",
      "terminalId": null,
      "title": "Home",
      "agent": "claude",
      "state": "done",
      "stateStartedAt": 1795677648300,
      "sessionId": "028a62e6-3577-47c2-a77e-bcfda06a2096",
      "process": "running",
      "matchedId": "028a62e6-3577-47c2-a77e-bcfda06a2096"
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
      "process": "stopped",
      "matchedId": null
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
      "process": "stopped",
      "matchedId": null
    },
    {
      "workspaceId": "folder:637d87aa-162f-41f8-ba04-b7313fbcd372",
      "workspaceName": "小小",
      "workspaceKind": "folder",
      "terminalId": null,
      "title": "未匹配到题目问题排查",
      "agent": "claude",
      "state": "working",
      "stateStartedAt": 1795677936261,
      "sessionId": "600d75f6-dbf4-44e5-bb55-9c35e614370b",
      "process": "running",
      "matchedId": "600d75f6-dbf4-44e5-bb55-9c35e614370b"
    },
    {
      "workspaceId": "folder:637d87aa-162f-41f8-ba04-b7313fbcd372",
      "workspaceName": "小小",
      "workspaceKind": "folder",
      "terminalId": null,
      "title": "上线 dsl-hub 的 engine 与 controller 更新",
      "agent": "claude",
      "state": "done",
      "stateStartedAt": 1795677643466,
      "sessionId": "13d8d80f-16b4-4ba3-b3a3-89df1d3e8bc4",
      "process": "running",
      "matchedId": "13d8d80f-16b4-4ba3-b3a3-89df1d3e8bc4"
    },
    {
      "workspaceId": "folder:637d87aa-162f-41f8-ba04-b7313fbcd372",
      "workspaceName": "小小",
      "workspaceKind": "folder",
      "terminalId": null,
      "title": "Home",
      "agent": "claude",
      "state": "done",
      "stateStartedAt": 1795677349425,
      "sessionId": "dd411755-4b8d-4ebc-b89f-9ef38d089774",
      "process": "running",
      "matchedId": "dd411755-4b8d-4ebc-b89f-9ef38d089774"
    },
    {
      "workspaceId": "folder:637d87aa-162f-41f8-ba04-b7313fbcd372",
      "workspaceName": "小小",
      "workspaceKind": "folder",
      "terminalId": null,
      "title": "分析当前 Mac 内存占用",
      "agent": "claude",
      "state": "done",
      "stateStartedAt": 1795677094812,
      "sessionId": "82092408-37fb-4ae5-bf44-83d986eb1e14",
      "process": "running",
      "matchedId": "82092408-37fb-4ae5-bf44-83d986eb1e14"
    },
    {
      "workspaceId": "folder:637d87aa-162f-41f8-ba04-b7313fbcd372",
      "workspaceName": "小小",
      "workspaceKind": "folder",
      "terminalId": null,
      "title": "会话 b9388fd5",
      "agent": "antigravity",
      "state": "done",
      "stateStartedAt": 1795676181727,
      "sessionId": "b9388fd5-6cae-42ad-9627-0aad35007921",
      "process": "unknown",
      "matchedId": null
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
      "process": "unknown",
      "matchedId": null
    }
  ],
  "currentWorkspaceId": "folder:637d87aa-162f-41f8-ba04-b7313fbcd372",
  "workspacesTruncated": false,
  "failedWorkspaces": 0,
  "recentOps": [
    {
      "at": 1795663235900,
      "ok": true,
      "dryRun": false,
      "kind": "signal",
      "title": "会话 1d5698f7",
      "sessionId": "1d5698f7-3890-4fa9-be15-b096359f32d9",
      "terminalId": null,
      "sessionUuid": "1d5698f7-3890-4fa9-be15-b096359f32d9",
      "pid": 80838,
      "pgid": 80838,
      "message": null
    },
    {
      "at": 1795661099376,
      "ok": true,
      "dryRun": true,
      "kind": "signal",
      "title": "会话 322ffe18",
      "sessionId": "322ffe18-a5a7-458b-b45b-2bb276e486b7",
      "terminalId": null,
      "sessionUuid": "322ffe18-a5a7-458b-b45b-2bb276e486b7",
      "pid": 20821,
      "pgid": 20821,
      "message": null
    },
    {
      "at": 1795660582945,
      "ok": true,
      "dryRun": true,
      "kind": "signal",
      "title": "会话 322ffe18",
      "sessionId": "322ffe18-a5a7-458b-b45b-2bb276e486b7",
      "terminalId": null,
      "sessionUuid": "322ffe18-a5a7-458b-b45b-2bb276e486b7",
      "pid": 20821,
      "pgid": 20821,
      "message": null
    },
    {
      "at": 1795660088175,
      "ok": false,
      "dryRun": true,
      "kind": "signal",
      "title": "会话 322ffe18",
      "sessionId": "322ffe18-a5a7-458b-b45b-2bb276e486b7",
      "terminalId": null,
      "sessionUuid": null,
      "pid": null,
      "pgid": null,
      "message": "找不到 --resume=322ffe18-a5a7-458b-b45b-2bb276e486b7 的 claude 进程（会话可能已经退出）（试过 322ffe18-a5a7-458b-b45b-2bb276e486b7）"
    },
    {
      "at": 1795659929312,
      "ok": false,
      "dryRun": false,
      "kind": "signal",
      "title": "会话 322ffe18",
      "sessionId": "322ffe18-a5a7-458b-b45b-2bb276e486b7",
      "terminalId": null,
      "sessionUuid": null,
      "pid": null,
      "pgid": null,
      "message": "找不到 --resume=322ffe18-a5a7-458b-b45b-2bb276e486b7 的 claude 进程（会话可能已经退出）（试过 322ffe18-a5a7-458b-b45b-2bb276e486b7）"
    },
    {
      "at": 1795659918359,
      "ok": false,
      "dryRun": false,
      "kind": "signal",
      "title": "会话 322ffe18",
      "sessionId": "322ffe18-a5a7-458b-b45b-2bb276e486b7",
      "terminalId": null,
      "sessionUuid": null,
      "pid": null,
      "pgid": null,
      "message": "找不到 --resume=322ffe18-a5a7-458b-b45b-2bb276e486b7 的 claude 进程（会话可能已经退出）（试过 322ffe18-a5a7-458b-b45b-2bb276e486b7）"
    }
  ]
}

export default defineCheck({
  real: { requests: { 'sessions.list': real } },
  realOpen: {
    storage: { showStopped: true, expandedGroups: {"identity:wt2:local:7072fb48-0d5c-413a-9d3e-f6a4830ae582": true, "identity:wt2:local:9f2b4863-0493-45a7-8fda-abc10514292f": true, "folder:f8168b9e-ba71-4fbf-9b41-2b152abde888": true, "folder:cf9721a4-3ce2-410f-87d5-55da80cefb6e": true, "folder:52cc4ad7-ad59-4592-bf32-e6e3fe0734d5": true, "folder:7b3ccc56-eecd-478c-b440-0cf4e5c31d61": true, "folder:9d5ad5ae-bcb1-483e-9d22-290c80b7ce8a": true, "folder:a151ba26-a0a2-4e84-bf64-fcfe9b155cd0": true, "folder:637d87aa-162f-41f8-ba04-b7313fbcd372": true} },
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
