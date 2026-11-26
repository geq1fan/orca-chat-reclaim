# 会话资源（chat-reclaim）

Orca 的「资源管理器」能看清每个 bot/工作区占了多少内存，却没有关闭会话的按钮；关掉页签也不会结束会话进程。这个本地插件在右侧栏与 Orca 资源管理器保持 1:1 同步，列出全部工作区的活跃与历史 agent 会话，并精确关闭空闲（`done`）会话：带终端的走终端 API，chat 会话直接读取 Orca 会话数据库的权威租约（`lease`）并在 `ps` 中核验启动时间（`lstart`）后向进程组发 SIGTERM。官方补上这个能力后可以直接停用。

## 面板做什么

- **与 Orca 资源管理器 1:1 对齐**：读取 `orca diagnostics memory --json`（资源管理器的官方同源数据源）并与 `workspace.list` + `agents.list` 做 Union + Merge。即使某个工作区被 `workspace.list` 截断、隐藏或 `agents.list` 未回报，资源管理器里正在运行的全部 chat（`claude`、`pi`、`antigravity`、`codex`、`omp` 等）和终端会话也都会出现在列表里，并附带对应内存占用（如 `226 MB`）。
- 按工作区（目录）分组，当前工作区排最前，其后是有匹配到进程的会话的工作区，其余排在最后；**组默认折叠**，点组标题展开/收起，组标题右侧分别列出 `在运行 N · 无法判定 M · 未运行 K` 里非零的项（类型与总会话数见组标题悬浮提示）。
- 列表默认**只显示匹配到进程的会话**（没有运行会话的工作区组也一并隐藏）。顶部一行对账：`Orca 会话 N 条 · 匹配到进程 M 条`；M<N 时说明其余行里多少条确认未运行、多少条无法判定。右侧「显示无进程 (n)」开关打开后才出现这些组与行。开关状态和每个工作区的展开状态都存在 `orca.storage`，刷新、重开面板、插件重载后沿用。
- 不管哪种 agent，每行结构一致、固定两行：第一行是会话标题（过长截到 40 字加省略号），第二行依次是 `状态徽章 · <agent> · 已空闲/状态持续 <时长> · <标识>`；右侧是「关闭」按钮。标识优先显示 Orca 规范 `sessionId` 前 8 位（如 `会话 3bfdeb92 · 226 MB`），绝不截取 `pi` 等采用的文件系统路径（不会再出现 `会话 /Users/z`）。解释性长文案不占行，收在「关闭」按钮的悬浮提示里。
- **基于租约（`lease`）的精确进程判定**：读取 `~/Library/Application Support/orca/agent-session-domain.db` 的 `agent_session_records`：
  - `claimStatus === 'live'` 且 `!unreconciled` 且存在 `ownerProcess`：通过 `LC_ALL=C ps -Ao pid,ppid,pgid,lstart,command` 核验 `ownerProcess.pid` 为 `orca-provider-exec` 的直接子进程、agent 种类一致、自成进程组、且 `lstart` 与 `ownerProcess.processStartTimeMs` 差值在 ±2000ms 以内（防 PID 复用）→ 标为 `running`（`pairing: 'lease'`）。
  - `claimStatus === 'released'` 且 `ownerProcess === null` 且 `!unreconciled`：再交叉核验命令行 `--resume=`/`--session-id=` 与 `diagnostics.memory`；均无活跃进程 → 确认标为 **未运行**（`stopped`），并附带退出原因（如 `exit-observed`）；不再把已退出会话误判为「无法判定」。
  - `reserved` / `conflicted` / `unreconciled` / 远端宿主机 / 数据库不可读或未命中时才标 **无法判定**（`unknown`），并在「关闭」按钮悬浮提示写明具体原因。
  - 若某活跃会话仅出现在 `diagnostics.memory` 而 `agents.list` 未回报其状态，则标记 `stateKnown: false`（显示「状态未知」），禁用关闭按钮并提示「未从 Orca 获取到会话空闲状态，暂不可关闭」，也不会进入「回收空闲」队列。
- 每行一个「关闭」按钮，两步确认：点「关闭」后变成「确认关闭」，再点才真的关。**只有 `stateKnown && state === 'done'` 且匹配到进程（或带终端）的会话能点**；运行中 / 待确认 / 等待中、状态未知、无法判定、未运行都置灰，并通过悬浮提示说明原因。
- 每次点击的结果都落在那一行里：成功显示「已关闭」，失败显示「关闭失败：<原因>」，同时顶部还有一条带错误码的提示，最近的记录进「最近操作」。
- 顶部「刷新」重新读取全部工作区；「回收空闲 (n)」一次关闭**当前工作区**里状态为 `done`（且 `stateKnown`）、带终端或已核验进程的会话，先列出将关闭哪几条，确认后才逐条执行。正在跑的（`working`）或状态未知的永远不会被回收。
- 底部「最近操作」可展开：每次关闭的目标 pid / pgid / uuid / 标题、成功或失败和原因，最多 50 条（存在 `orca.storage`）。
- 关闭失败会显示 Orca 或系统返回的原始错误码和消息，不会静默跳过。

## 标题从哪来

chat 标题按如下优先级解析，保证与 Orca 资源管理器一致，且绝不拿 agent 名或文件路径充数：

1. `orca diagnostics memory --json` 返回的 `chat.name`（资源管理器当前显示的标题）；
2. `orca bot list --json` + `orca bot chats --json --bot <名字>` 收集的标题表，再通过 `agent_session_records` 的 `session_id`、`adopted_native_id` 与 `providerHandleChain` 双向别名对齐（缓存于 `orca.storage`，60 秒有效）；
3. `agent_session_records` 的 `conversationName`；
4. 规范 Orca `sessionId`（或非路径的 `matchedId` / `rowId`）前 8 位：`会话 <id8>`；
5. 若无非路径 id，则显示 **未命名会话**。

## 关闭是怎么实现的

任何一次关闭都先重新读一次该工作区的 `agents.list`：会话不在了（通过 `sessionId` 与 `SessionRecord` 别名匹配）就报「已经不在了」，状态不是 `done` 就拒绝，然后再按会话形态选路径。

**带终端的会话**（`terminalId` 不为空）走 Orca 自己的路径：

1. `terminal.focus` 把这个终端所在的工作区显示出来并聚焦（`terminal.close` 只接受「当前聚焦工作区」的终端）；
2. `terminal.close` 关闭终端，里面跑的进程随之结束。

**chat 会话**（`terminalId` 为空）在发信号前做二次核验（防 TOCTOU 与 PID 复用）：

1. **重读租约数据库**：从 `agent-session-domain.db` 查出唯一匹配记录（`session_id` → `adopted_native_id` → `providerHandleChain`），确认 `!unreconciled`、`claimStatus === 'live'`、`ownerProcess !== null`、`ownerProcess.hostId === 'local'`；若调用传入期望 `pid`，必须与 `ownerProcess.pid` 一致（不一致报 `process_changed` 拒绝）。
2. **重读进程表**：以 `LC_ALL=C ps -Ao pid,ppid,pgid,lstart,command` 解析全部进程及其启动时间，确认目标 pid 仍在运行且满足所有安全门禁：
   - 父进程必须是 `orca-provider-exec`；
   - 若已知 agent 种类，进程可执行文件归类必须一致（`claude`、`agy` → `antigravity`、`pi`、`codex`、`omp`）；
   - `pgid === pid`（自成进程组）且不与插件 worker 同组；
   - `ps` `lstart` 毫秒时间戳与 `ownerProcess.processStartTimeMs` 差值 `<= 2000ms`，防止 PID 复用误杀。
3. **命令行 id 兜底**：仅当数据库不可读或无此记录且会话 id 为非路径标识时，退回到 `--resume=<id>` / `--session-id=<id>` 精确匹配并同样过安全门禁。
4. **关闭**：`process.kill(-pgid, 'SIGTERM')`，杀掉整个进程组（agent 的 MCP 子进程同组）；最多轮询 5 秒确认进程消失。**不升级 SIGKILL**，5 秒后还在就报失败。

杀之前/后把目标 pid / pgid / uuid / 标题写进 `orca.storage` 的 `recentOps`（最多 50 条），写入失败只记日志，不会把一个已经完成的关闭变成错误。

## 需要的权限

| capability | 用途 |
| --- | --- |
| `storage:own` | `recentOps` 最近操作记录与面板持久化状态 |
| `workspace:read` | `workspace.list`、`workspace.readContext`，以及接收工作区事件 |
| `workspace:write` | `terminal.focus`（先聚焦才能关终端） |
| `agent:read` | `agents.list`，以及接收 agent 状态事件 |
| `terminal:send` | `terminal.close` |

`execution` 是 `trusted-worker`：插件有自己的 Node worker，代码在你本机、你的账号下运行；SIGTERM 由这个 worker 发出。调用 `orca diagnostics memory --json` 复用已有 worker CLI 权限，不新增任何 capability。

## 启用

插件是**开发目录**，没有发布到插件市场。它运行代码并操作进程，首次加载、改权限或换版本都要批准一次（批准绑定当前文件内容和权限清单）：

```sh
cd ~/Documents/github/orca-chat-reclaim
orca plugin dev load . --json    # 输出会给出 --approve ap1-…
orca plugin dev watch . --check --json --approve <fingerprint>
```

之后在这个目录里每次保存代码都会自动重载，按 Ctrl-C 卸载。批准过一次以后，只加载不盯着也可以：

```sh
orca plugin dev load .
orca plugin open local.chat-reclaim --panel chat-reclaim   # 在右侧栏打开面板
```

如果在 **Settings → Plugins** 里启用，命令是 `orca plugin enable local.chat-reclaim --approve <fingerprint>`。改动代码或新增权限都会产生新的 fingerprint。

## 官方修复后怎么退场

Orca 自带「关闭会话」之后，这个插件就没有存在意义了：

- 在 **Settings → Plugins** 里关掉「会话资源」；或
- `orca plugin disable local.chat-reclaim`；开发目录再用 `orca plugin dev unload .` 移除。

停用后 worker 和面板都不再运行，不会启动或结束任何进程。目录可以直接删掉；`recentOps` 也随之失效。

## 开发与验证

```sh
orca plugin types .             # 生成类型声明到 .orca/types
npx tsc -p .                    # TypeScript 严格类型检查
orca plugin validate . --json   # 清单与 host 方法校验
orca plugin check . --json      # 多场景渲染校验（real、withId、piLease、stateUnknown、realOpen、empty、failed）
orca plugin test . --json       # node:test：租约/lstart 解析、筛选、状态闸门、worker 合并与关闭、面板交互
orca plugin shot . --scenario realOpen --panel chat-reclaim --json   # 用真实快照渲染一张 PNG（需隐藏 Orca 窗口）
```

干跑一次（只解析不杀，`dev request` 需要插件已批准）：

```sh
orca plugin dev request . sessions.close --data '{"workspaceId":"<id>","sessionId":"<uuid>","dryRun":true}' --json
```

返回里带 `pid` / `pgid` / `parentArgs`（及命令行 id 时的 `sessionUuid`），可以核对父进程确实是 `orca-provider-exec`。

文件：

- `orca-plugin.json` 清单
- `src/protocol.ts` 面板 ↔ worker 的请求契约
- `src/worker.ts` 合并 `diagnostics.memory` 与工作区列表、基于租约解析状态、选择关闭路径、写操作记录
- `src/sessions.ts` 纯函数：`selectDone`（空闲统计）、`selectIdle`（仅包含 `stateKnown` 的可回收筛选）、`groupSessions`（分组，当前工作区最前）
- `src/sessionProcess.ts` `diagnostics.memory` 解析、`stopSessionByLease` 与命令行 id 兜底关闭编排（注入 `SignalOps`）
- `src/processTable.ts` 解析 `LC_ALL=C ps ... lstart`、按 `orca-provider-exec` 归类、租约 pid + 启动时间容差核验与安全门禁
- `src/sessionRecord.ts` 解析 `agent_session_records` 租约与链字段、优先级查找与工作区收窄、标题别名
- `src/botChats.ts` 遍历 bot 的 `orca bot chats` 拼标题表（按 Orca 会话 id）
- `src/hostOps.ts` 真实机器侧：`sqlite3`、`LC_ALL=C ps`、`process.kill`、`orca` CLI（含 `diagnostics memory`）
- `src/labels.ts` 状态文案、标题截断、路径识别与内存格式化
- `src/node.d.ts` worker 用到的三个 Node 模块的最小类型声明（插件无依赖）
- `src/panel.tsx` 组件面板
- `src/*.test.ts(x)`、`src/panel.check.ts` 测试与 check 场景

## 已知限制

- 只对 macOS 成立：会话数据库路径与 `LC_ALL=C ps ... lstart` 输出格式按 macOS 写。
- 仅支持本地宿主机进程关闭：租约 `ownerProcess.hostId !== 'local'`（如 SSH/远端容器会话）会标为 `无法判定` 或在关闭时拒绝，绝不向本地同名 PID 误发信号。
- 租约处于 `reserved`、`conflicted`、`unreconciled` 或启动时间超过 ±2000ms 容差时，统一标为 `无法判定` 并在按钮悬浮提示写出原因，不会盲杀。
- 仅在 `orca diagnostics memory` 出现而 `agents.list` 未回报状态的活跃会话，会保留在列表以与资源管理器对齐，但标为「状态未知」并禁止关闭或批量回收。
- SIGTERM 后 5 秒仍在就报失败，不自动升级 SIGKILL。
- 只关 `stateKnown && state === 'done'` 的会话，没有自动关闭；任何关闭都来自你点两次按钮。
- `terminal.focus` 是 desktop-only，浏览器客户端里带终端的会话会失败并显示 `not_focused` / `not_permitted`。
- 面板每次读取都会问一遍全部工作区；某个工作区被拒绝或读取失败时，面板顶部会给出数量提示。
