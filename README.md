# 会话资源（chat-reclaim）

Orca 的「资源管理器」能看清每个 bot/工作区占了多少内存，却没有关闭会话的按钮；关掉页签也不会结束会话进程。这个本地插件在右侧栏集中列出所有工作区的 agent 会话，并真正把它们关掉：带终端的走终端 API，chat 会话向它的 claude 进程组发 SIGTERM。官方补上这个能力后可以直接停用。

## 面板做什么

- 按工作区（目录）分组，当前工作区排最前，其后是有在运行会话的工作区，纯未运行工作区排在最后；**组默认折叠**，点组标题展开/收起，组标题右侧简明列出 `在运行 2 · 未运行 3`（类型与总会话数见组标题悬浮提示）。
- 列表默认**只显示还在运行的会话**（没有在运行会话的工作区组也一并隐藏）。顶部一行汇总 `在运行 4 条 · 未运行 9 条已隐藏`，右侧「显示未运行 (9)」开关打开后才出现未运行的组与行。开关状态和每个工作区的展开状态都存在 `orca.storage`，刷新、重开面板、插件重载后沿用。
- 每行第一行是会话标题（过长截到 40 字加省略号），第二行是 `会话 <id 前 8 位> · <agent> · 已空闲 <时长>`，再加状态徽章。
- 徽章按**进程**判定，不按 Orca 报的 state：有进程且在跑 → 运行中；有进程但空闲 → 空闲；进程不在 → **未运行**（会话并没有结束，下次发消息会重新拉起）；进程状态未知（`ps` 读不到）才退回 Orca 的状态。
- 每行一个「关闭」按钮，两步确认：点「关闭」后变成「确认关闭」，再点才真的关。**只有 `done` 的会话能点**，运行中 / 待确认 / 等待中置灰；未运行的会话没有进程可杀，按钮显示「未运行」且不可点。
- 每次点击的结果都落在那一行里：成功显示「已关闭」，失败显示「关闭失败：<原因>」，同时顶部还有一条带错误码的提示，最近的记录进「最近操作」。
- 顶部「刷新」重新读取全部工作区；「回收空闲 (n)」一次关闭**当前工作区**里状态为 `done` 的会话，先列出将关闭哪几条和会跳过哪条，确认后才逐条执行。
- 回收永远跳过两类会话：正在跑的（`working`），以及**你正在用的那条**——当前工作区里最近才空闲下来的会话。宿主没有告诉插件「这个面板属于哪个会话」的接口，所以用「最近空闲」作代理；跳过的会话会在标题行注明「已跳过当前使用的会话『Home』」。
- 底部「最近操作」可展开：每次关闭的目标 pid / pgid / uuid / 标题、成功或失败和原因，最多 50 条（存在 `orca.storage`）。
- 关闭失败会显示 Orca 或系统返回的原始错误码和消息，不会静默跳过。

面板不显示内存数字：Orca 没有提供按会话读内存的接口，硬算出来的数字没有意义。

## 标题从哪来

`agents.list` 对 chat 会话的 `title` 是 `null`，Orca 的会话数据库里也没有标题字段，真实标题只在 Orca 自己的 CLI 里：

1. `orca bot list --json` 拿到本机所有 bot（面板会显示别的 bot 的会话，必须全查）；
2. 对每个 bot 跑 `orca bot chats --json --bot <名字>`，收集 `id → title`；单个 bot 失败就跳过，不影响其它 bot；
3. `orca bot chats` 的 id 是 Orca 的会话 id，而 `agents.list` 报的是 provider id，所以再查一次 `agent_session_records` 的 `session_id ↔ adopted_native_id`，让同一张表对两种 id 都能回答。

整张表缓存在 `orca.storage`（60 秒有效）：打开面板用缓存，点「刷新」、关闭完成后的刷新、回收完成后的刷新都会重建。重建要问 7 个 bot，约 1.3 秒；缓存命中时整个列表约 0.3 秒。只用本机 `orca` CLI 和 `sqlite3`，不读任何 token 或环境变量，也不联网。

标题查不到时退回 `会话 <id 前 8 位>`，不会拿 agent 名冒充当标题。Orca 重启后，没在跑的 chat 会话 `agents.list` 会返回 `sessionId: null`，既没有 id 也没有 provider id：这类行显示 **未命名会话**（并标「未运行」），在 Orca 重新给出 id 之前无法查询标题，也无法关闭。

## 关闭是怎么实现的

任何一次关闭都先重新读一次该工作区的 `agents.list`：会话不在了就报「已经不在了」，状态不是 `done` 就拒绝，然后再按会话形态选路径。

**带终端的会话**（`terminalId` 不为空）走 Orca 自己的路径：

1. `terminal.focus` 把这个终端所在的工作区显示出来并聚焦（`terminal.close` 只接受「当前聚焦工作区」的终端）；
2. `terminal.close` 关闭终端，里面跑的进程随之结束。

**chat 会话**（`terminalId` 为空）走进程兜底，只用系统自带命令，不引入依赖：

1. **id → 进程**：`ps -Ao pid,ppid,pgid,command`，找 argv[0] 以 `/.local/bin/claude` 结尾、参数含 `--session-id=<id>` **或** `--resume=<id>` 的那条。新建会话用前者、恢复的会话用后者，两种都要认。
2. **兜底取 id**：`agents.list` 的 `sessionId` 通常就是 provider id，直接匹配 ps；匹配不到才读 `~/Library/Application Support/orca/agent-session-domain.db`（`sqlite3 -readonly`，只取 `json_extract(record_json,'$.providerHandleChain')`），取最后一个带 `handle.sessionId` 的再匹配一次。
3. **安全闸门**，任一不满足就不动手并返回原因：
   - 父进程必须是 `orca-provider-exec`；
   - `pgid == pid`（该 claude 自成进程组）；
   - 不能和插件 worker 同属一个进程组；
   - 同一个 id 命中多于一个进程（多 pane 复用了同一会话）直接拒绝，不猜。
4. **关闭**：`process.kill(-pid, 'SIGTERM')`，杀掉整个进程组（claude 的 MCP 子进程同组）；最多轮询 5 秒确认进程消失。**不升级 SIGKILL**，5 秒后还在就报失败。

杀之前把目标 pid / pgid / uuid / 标题写进 `orca.storage` 的 `recentOps`（最多 50 条），写入失败只记日志，不会把一个已经完成的关闭变成错误。

## 需要的权限

| capability | 用途 |
| --- | --- |
| `storage:own` | `recentOps` 最近操作记录 |
| `workspace:read` | `workspace.list`、`workspace.readContext`，以及接收工作区事件 |
| `workspace:write` | `terminal.focus`（先聚焦才能关终端） |
| `agent:read` | `agents.list`，以及接收 agent 状态事件 |
| `terminal:send` | `terminal.close` |

`execution` 是 `trusted-worker`：插件有自己的 Node worker，代码在你本机、你的账号下运行；SIGTERM 由这个 worker 发出。

## 启用

插件是**开发目录**，没有发布到插件市场。加进程兜底后多了一条 `storage:own` 权限，指纹变了，需要重新批准一次（批准绑定当前文件内容和这份权限清单）：

```sh
cd ~/Documents/zyb/code/tools/orca-chat-reclaim
orca plugin dev watch . --check --shot ./.orca/shots --json --approve ap1-270dffd426d8d1ab6605815a042bf96b
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
orca plugin validate . --json   # 清单与 host 方法校验
orca plugin check . --json      # 四个场景渲染面板（real、realOpen 用真实快照 / empty / failed）
orca plugin test . --json       # node:test：筛选、状态闸门、进程解析、TERM 超时
npx tsc -p .
orca plugin shot . --scenario chats --panel chat-reclaim --json   # 离屏渲染一张 PNG（需隐藏 Orca 窗口）
```

干跑一次（只解析不杀，`dev request` 需要插件已批准）：

```sh
orca plugin dev request . sessions.close --data '{"workspaceId":"<id>","sessionId":"<uuid>","dryRun":true}' --json
```

返回里带 `pid` / `pgid` / `sessionUuid` / `parentArgs`，可以核对父进程确实是 `orca-provider-exec`。

文件：

- `orca-plugin.json` 清单
- `src/protocol.ts` 面板 ↔ worker 的请求契约
- `src/worker.ts` 扫描会话、判断可否关闭、选择关闭路径、写操作记录
- `src/sessions.ts` 纯函数：`selectDone`（空闲统计）、`selectIdle`（可关闭的回收筛选）、`groupSessions`（分组，当前工作区最前）
- `src/sessionProcess.ts` 进程兜底的编排（注入 `SignalOps`，测试用假实现）
- `src/processTable.ts` 解析 `ps` 与目标判定
- `src/sessionRecord.ts` 从 `providerHandleChain` 取对话 id
- `src/botChats.ts` 拼标题表：遍历 bot 的 `orca bot chats` + 会话库的 id 映射
- `src/hostOps.ts` 真实机器侧：`sqlite3`、`ps`、`process.kill`、`orca` CLI
- `src/node.d.ts` worker 用到的三个 Node 模块的最小类型声明（插件无依赖）
- `src/panel.tsx` 组件面板
- `src/*.test.ts(x)`、`src/panel.check.ts` 测试与 check 场景

## 已知限制

- 只对 macOS 成立：会话数据库路径和 `ps` 的输出格式按 macOS 写。
- 「当前使用的会话」是代理判断（当前工作区里最近空闲的那条）。如果之后别的会话先空闲，它保护的就不是你正在用的那条；想看某一行到底关不关，直接点行内「关闭」（会显示标题和两次确认）。
- Orca 重启后，没在跑的 chat 会话会丢掉 provider id（`sessionId: null`），标题和关闭都无从下手，直到它在 Orca 里重新跑起来。
- 进程链是 Orca 的内部实现（`.local/bin/claude` + `orca-provider-exec`），启动参数是 `--session-id=` 还是 `--resume=` 也随版本变；两种都认，仍对不上就在面板上显示原因，不会乱杀进程。
- 「进程已退出」按读取那一刻的 `ps` 判断；点刷新会重新判断，真去关闭时 worker 还会再判一次（不在就直接返回原因）。
- 标题来自 `orca bot chats`：某个 bot 调用失败时，它名下的会话这一轮只有 id 前缀；刚建的会话要等 CLI 认识它之后才有标题。
- SIGTERM 后 5 秒仍在就报失败，不自动升级 SIGKILL。
- 只关 `done` 的会话，没有自动关闭；任何关闭都来自你点两次按钮。
- `terminal.focus` 是 desktop-only，浏览器客户端里带终端的会话会失败并显示 `not_focused` / `not_permitted`。
- 面板每次读取都会问一遍全部工作区（127 个约 150ms）；某个工作区被拒绝或读取失败时，面板顶部会给出数量提示。