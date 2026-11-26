// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Collapsible,
  EmptyState,
  Heading,
  IconButton,
  on,
  plugin,
  read,
  RelativeTime,
  Row,
  Separator,
  set,
  Skeleton,
  Stack,
  Switch,
  Text,
  update,
  type OrcaNode,
  type PanelContext,
  type Tone
} from 'orca'
import { AGENT_STATE_LABEL, truncateTitle } from './labels'
import type { OpRecord, SessionRow, SessionSnapshot } from './protocol'
import { groupSessions, isRunning, selectDone, selectIdle, type SessionGroup } from './sessions'

/** What the worker last reported; null until the first answer arrives. */
const snapshot = atom<SessionSnapshot | null>('snapshot', null)
const loading = atom<boolean>('loading', false)
const loadError = atom<string | null>('loadError', null)
/** The row a close request is running on (its session id); only one at a time. */
const busyKey = atom<string | null>('busyKey', null)
/** The row showing 「确认关闭」. */
const confirming = atom<string | null>('confirming', null)
const askingReclaim = atom<boolean>('askingReclaim', false)
const reclaiming = atom<boolean>('reclaiming', false)
const actionError = atom<string | null>('actionError', null)
const notice = atom<string | null>('notice', null)
/** An agent changed state since the last read; the rows below may be older than Orca. */
const stale = atom<boolean>('stale', false)
/** The last close outcome per row, shown inside the row: a click must always answer visibly. */
const rowResults = atom<Record<string, { ok: boolean; text: string }>>('rowResults', {})
/** Hidden by default: a row with no matched process only makes the list long. */
const showStopped = atom<boolean>('showStopped', false, { persist: 'storage' })
/** Which workspaces are unfolded, by workspace id; a group with no entry starts folded. */
const expandedGroups = atom<Record<string, boolean>>('expandedGroups', {}, { persist: 'storage' })

function toggleGroup(workspaceId: string): void {
  update(expandedGroups, (current) => ({ ...current, [workspaceId]: !current[workspaceId] }))
}

type DisplayState = { label: string; tone: Tone }

/**
 * The badge follows the process, not the agent's last reported state. A chat whose ids matched no
 * process is 「无法判定」, not 「未运行」: Orca can report a stale id, and only a session with no
 * candidate id at all is confirmed not to have a process.
 */
function displayState(row: SessionRow): DisplayState {
  if (row.process === 'stopped') return { label: '未运行', tone: 'neutral' }
  if (row.process === 'unknown') return { label: '无法判定', tone: 'warning' }
  if (row.state === 'working') return { label: '运行中', tone: 'accent' }
  if (row.state === 'blocked') return { label: '待确认', tone: 'warning' }
  if (row.state === 'waiting') return { label: '等待中', tone: 'neutral' }
  return { label: '空闲', tone: 'success' }
}

/**
 * The row's handle, always in the same slot after the duration: the id its process answered to,
 * or 「无会话 id · pid N」 for an agent whose CLI carries no id and was paired 1:1 with a process.
 * A terminal row with no session id falls back to the terminal it addresses.
 */
function identityLabel(row: SessionRow): string {
  if (row.pairing !== 'agent') {
    const id = row.matchedId ?? row.sessionId
    if (id !== null) return `会话 ${id.slice(0, 8)}`
  }
  if (row.matchedPid !== null) return `无会话 id · pid ${row.matchedPid}`
  if (row.terminalId !== null) return `终端 ${row.terminalId.slice(0, 8)}`
  return '无会话 id'
}

function describe(error: unknown): string {
  const failure = error as { code?: unknown; message?: unknown }
  const message = typeof failure.message === 'string' ? failure.message : String(error)
  return typeof failure.code === 'string' ? `${message}（${failure.code}）` : message
}

/** `refreshTitles` rebuilds the chat-title map; the first draw is happy with the cached one. */
async function refresh(refreshTitles = false): Promise<void> {
  set(loading, true)
  set(loadError, null)
  try {
    const next = await plugin.request('sessions.list', { refreshTitles }, { timeoutMs: 60000 })
    set(snapshot, next)
    set(stale, false)
  } catch (error) {
    set(loadError, describe(error))
  } finally {
    set(loading, false)
  }
}

/** The row's identity for the close state: chats have no terminal, terminal agents have both. */
function rowKey(row: SessionRow): string {
  return row.sessionId ?? row.terminalId ?? `${row.workspaceId}:${row.title}`
}

function canClose(row: SessionRow): boolean {
  if (row.state !== 'done') return false
  if (row.terminalId !== null) return true
  if (row.sessionId === null) return false
  // Only a matched process can be signalled; `unknown` must not make the button promise a close.
  return row.process === 'running'
}

function setRowResult(key: string, result: { ok: boolean; text: string }): void {
  set(rowResults, { ...read(rowResults), [key]: result })
}

function clearRowResult(key: string): void {
  const current = read(rowResults)
  if (!(key in current)) return
  const next = { ...current }
  delete next[key]
  set(rowResults, next)
}

async function closeSession(row: SessionRow): Promise<void> {
  const key = rowKey(row)
  if (read(busyKey) !== null) return
  set(busyKey, key)
  clearRowResult(key)
  set(actionError, null)
  set(notice, null)
  try {
    const outcome = await plugin.request(
      'sessions.close',
      {
        workspaceId: row.workspaceId,
        sessionId: row.sessionId,
        terminalId: row.terminalId,
        pid: row.pairing === 'agent' ? row.matchedPid : null
      },
      { timeoutMs: 30000 }
    )
    if (outcome.ok) {
      set(notice, `已关闭「${row.title}」。`)
      setRowResult(key, { ok: true, text: '已关闭' })
    } else {
      // The row keeps the short reason; the top callout adds the code for a copy-paste.
      set(actionError, `关闭失败：${outcome.message}（${outcome.code}）`)
      setRowResult(key, { ok: false, text: `关闭失败：${outcome.message}` })
    }
  } catch (error) {
    const text = `关闭失败：${describe(error)}`
    set(actionError, text)
    setRowResult(key, { ok: false, text })
  } finally {
    set(busyKey, null)
    set(confirming, null)
    await refresh(true)
  }
}

async function reclaimIdle(workspaceId: string): Promise<void> {
  set(reclaiming, true)
  set(actionError, null)
  set(notice, null)
  try {
    const result = await plugin.request('sessions.reclaim', { workspaceId }, { timeoutMs: 120000 })
    const closed = result.outcomes.filter((outcome) => outcome.ok).length
    const failed = result.outcomes.find((outcome) => !outcome.ok)
    for (const outcome of result.outcomes) {
      if (!outcome.ok && outcome.sessionId) {
        setRowResult(outcome.sessionId, { ok: false, text: `关闭失败：${outcome.message}` })
      }
    }
    if (failed && !failed.ok) {
      set(
        actionError,
        `回收中断：已关闭 ${closed} 个，其余未动 —— ${failed.message}（${failed.code}）。`
      )
    } else {
      set(notice, `回收完成：已关闭 ${closed} 个空闲会话。`)
    }
  } catch (error) {
    set(actionError, `回收失败：${describe(error)}`)
  } finally {
    set(reclaiming, false)
    set(askingReclaim, false)
    await refresh(true)
  }
}

/**
 * Runs once before the first render; what it pushes to `subscriptions` ends with the panel.
 * Focus changes only move the 「当前工作区」 marker: re-reading every workspace on each focus
 * change would be a hundred host calls for nothing.
 */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    on('workspace.changed', ({ context }) => {
      const workspaceId = context?.workspaceId ?? null
      const current = read(snapshot)
      if (!current || current.currentWorkspaceId === workspaceId) return
      set(snapshot, { ...current, currentWorkspaceId: workspaceId })
    }),
    on('agent.status.changed', () => {
      if (!read(stale)) set(stale, true)
    })
  )
  void refresh(false)
}

function renderRow(row: SessionRow): OrcaNode {
  const key = rowKey(row)
  const confirmingThis = read(confirming) === key
  const busyThis = read(busyKey) === key
  const otherBusy = read(busyKey) !== null && !busyThis
  const closeable = canClose(row)
  /** Why the process is not a close target, when it is not. */
  const unavailable = row.process === 'stopped' ? '未运行' : row.process === 'unknown' ? '无法判定' : null
  // Every row draws the same slots, in the same order: title / badge, agent, duration, handle.
  const identity = identityLabel(row)
  const lastResult = read(rowResults)[key]
  const state = displayState(row)
  // Explanations live in the close button's tooltip; keeping them out of the row makes every row
  // the same height. A paired agent's 1:1 note and a 无法判定 reason both read here.
  const closeAction = row.terminalId !== null ? '将关闭关联终端，无法撤销' : '将向进程组发 SIGTERM，无法撤销'
  const closeTooltip = row.processNote !== null ? `${closeAction}；${row.processNote}` : closeAction
  const disabledTooltip =
    row.state !== 'done'
      ? row.processNote !== null
        ? `只有 done 的会话能关，现在是「${AGENT_STATE_LABEL[row.state]}」；${row.processNote}`
        : `只有 done 的会话能关，现在是「${AGENT_STATE_LABEL[row.state]}」`
      : row.process === 'unknown'
        ? (row.processNote ?? '没有进程命中这个会话的候选 id，无法判定它是否还在跑；先刷新确认')
        : row.process === 'stopped'
          ? '这个会话没有任何可用 id，也没有进程在跑（未运行）'
          : '这个会话没有终端也没有 sessionId，没法定位进程'

  return (
    <Box direction="column" gap="xs" padding="sm">
      <Row justify="between" align="center" gap="sm">
        <Box direction="column" gap="xs" grow>
          <Text size="sm" weight="medium" muted={!isRunning(row)} truncate>
            {truncateTitle(row.title)}
          </Text>
          <Row gap="xs" align="center">
            <Badge tone={state.tone}>{state.label}</Badge>
            <Text muted size="xs" truncate>
              {row.agent}
            </Text>
            <Text muted size="xs">
              ·
            </Text>
            <Text muted size="xs">
              {row.state === 'done' ? '已空闲' : '状态持续'}{' '}
              <RelativeTime at={row.stateStartedAt} format="duration" muted />
            </Text>
            <Text muted size="xs">
              ·
            </Text>
            <Text muted size="xs" truncate>
              {identity}
            </Text>
          </Row>
        </Box>
        {!confirmingThis ? (
          <Box shrink={false}>
            {!closeable ? (
              <Button size="xs" variant="ghost" disabled tooltip={disabledTooltip}>
                {unavailable ?? (row.state === 'done' ? '无法关闭' : '关闭')}
              </Button>
            ) : (
              <Button
                size="xs"
                variant="outline"
                tone="neutral"
                tooltip={closeTooltip}
                disabled={otherBusy}
                onPress={() => {
                  set(actionError, null)
                  set(notice, null)
                  set(confirming, key)
                }}
              >
                关闭
              </Button>
            )}
          </Box>
        ) : null}
      </Row>
      {closeable && confirmingThis ? (
        <Box
          background="danger"
          border="danger"
          radius="sm"
          paddingX="sm"
          paddingY="xs"
          direction="row"
          justify="between"
          align="center"
          gap="sm"
        >
          <Text size="xs" tone="danger">
            {row.terminalId ? '将关闭关联终端，无法撤销' : '将向进程组发 SIGTERM，无法撤销'}
          </Text>
          <Row gap="xs" align="center">
            <Button
              size="xs"
              variant="solid"
              tone="danger"
              disabled={busyThis}
              tooltip="向这个会话的 agent 进程组发 SIGTERM；若它带终端，则关闭终端"
              onPress={() => void closeSession(row)}
            >
              {busyThis ? '关闭中…' : '确认关闭'}
            </Button>
            <Button size="xs" variant="ghost" disabled={busyThis} onPress={() => set(confirming, null)}>
              取消
            </Button>
          </Row>
        </Box>
      ) : null}
      {lastResult ? (
        <Text size="xs" tone={lastResult.ok ? 'success' : 'danger'}>
          {lastResult.text}
        </Text>
      ) : null}
    </Box>
  )
}

function renderRecentOps(records: OpRecord[]): OrcaNode {
  return (
    <>
      <Separator />
      <Collapsible title={`最近操作 (${records.length})`} defaultOpen={false}>
        <Box background="card" border radius="md" direction="column" gap="none">
          {records.map((record, index) => (
            <Box key={index} direction="column" gap="none">
              {index > 0 ? <Separator /> : null}
              <Box paddingX="sm" paddingY="xs" direction="column" gap="xs">
                <Row justify="between" align="center" gap="sm">
                  <Box direction="row" gap="xs" align="center" grow>
                    <Badge tone={record.ok ? (record.dryRun ? 'neutral' : 'success') : 'danger'}>
                      {record.ok ? (record.dryRun ? '干跑' : '成功') : '失败'}
                    </Badge>
                    <Text size="xs" weight="medium" truncate>
                      {truncateTitle(record.title, 28)}
                    </Text>
                  </Box>
                  <Box shrink={false}>
                    <Text muted size="xs">
                      <RelativeTime at={record.at} format="short" muted />
                    </Text>
                  </Box>
                </Row>
                <Text size="xs" muted={record.ok} tone={record.ok ? undefined : 'danger'}>
                  {`${record.kind === 'signal' ? 'SIGTERM' : 'terminal.close'}${
                    record.pid !== null ? ` · pid ${record.pid}` : ''
                  }${record.message ? ` · ${record.message}` : ''}`}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>
      </Collapsible>
    </>
  )
}

function formatGroupCount(running: number, unknown: number, stopped: number): string {
  const parts: string[] = []
  if (running > 0) parts.push(`在运行 ${running}`)
  if (unknown > 0) parts.push(`无法判定 ${unknown}`)
  if (stopped > 0) parts.push(`未运行 ${stopped}`)
  return parts.join(' · ')
}

function renderGroup(
  group: SessionGroup,
  currentWorkspaceId: string | null,
  showStoppedRows: boolean,
  expanded: boolean
): OrcaNode {
  const running = group.sessions.filter(isRunning).length
  const unknown = group.sessions.filter((session) => session.process === 'unknown').length
  const stopped = group.sessions.filter((session) => session.process === 'stopped').length
  const visible = showStoppedRows ? group.sessions : group.sessions.filter(isRunning)
  const countText = formatGroupCount(running, unknown, stopped)

  return (
    <Box
      key={group.workspace.id}
      background={running > 0 || expanded ? 'card' : 'muted'}
      border
      radius="md"
      direction="column"
      gap="none"
    >
      <Box direction="row" justify="between" align="center" gap="sm" paddingX="sm" paddingY="xs">
        <Box direction="row" gap="xs" align="center" grow>
          <Button
            size="sm"
            variant="ghost"
            icon={expanded ? 'collapse' : 'expand'}
            tooltip={`${group.workspace.name}（${group.workspace.kind} · 共 ${group.sessions.length} 个会话）· 点击${expanded ? '收起' : '展开'}`}
            onPress={() => toggleGroup(group.workspace.id)}
          >
            {truncateTitle(group.workspace.name, 28)}
          </Button>
          {group.workspace.id === currentWorkspaceId ? <Badge tone="accent">当前</Badge> : null}
        </Box>
        <Box direction="row" gap="xs" align="center" shrink={false}>
          <Text muted={running === 0} size="xs" weight={running > 0 ? 'medium' : 'regular'}>
            {countText}
          </Text>
        </Box>
      </Box>
      {expanded ? (
        <>
          <Separator />
          {visible.length > 0 ? (
            <Box direction="column" gap="none">
              {visible.map((session, index) => (
                <Box key={`${rowKey(session)}:${index}`} direction="column" gap="none">
                  {index > 0 ? <Separator /> : null}
                  {renderRow(session)}
                </Box>
              ))}
            </Box>
          ) : (
            <Box padding="sm">
              <Text muted size="xs">
                这个工作区没有匹配到进程的会话，打开「显示无进程」开关查看。
              </Text>
            </Box>
          )}
        </>
      ) : null}
    </Box>
  )
}

export default function Panel(): OrcaNode {
  const view = read(snapshot)
  const isLoading = read(loading)
  const isStale = read(stale)
  const currentWorkspaceId = view?.currentWorkspaceId ?? null
  const currentWorkspace = view?.workspaces.find((workspace) => workspace.id === currentWorkspaceId)
  const idle =
    view && currentWorkspaceId ? selectIdle(view.sessions, currentWorkspaceId) : []
  const idleAll = view && currentWorkspaceId ? selectDone(view.sessions, currentWorkspaceId) : []
  const showStoppedRows = read(showStopped)
  const expandedByWorkspace = read(expandedGroups)
  const runningCount = view ? view.sessions.filter(isRunning).length : 0
  const unknownCount = view
    ? view.sessions.filter((session) => session.process === 'unknown').length
    : 0
  const stoppedCount = view
    ? view.sessions.filter((session) => session.process === 'stopped').length
    : 0
  const unmatchedCount = view ? view.sessions.length - runningCount : 0
  const totalCount = view ? view.sessions.length : 0
  const isAsking = read(askingReclaim)
  const isReclaiming = read(reclaiming)
  const allGroups = view ? groupSessions(view) : []
  const visibleGroups = showStoppedRows
    ? allGroups
    : allGroups.filter((group) => group.sessions.some(isRunning))

  return (
    <Stack gap="md">
      <Row justify="between" align="center" gap="sm">
        <Row gap="xs" align="center">
          <Heading level={2}>会话资源</Heading>
          {isStale ? <Badge tone="warning">待刷新</Badge> : null}
        </Row>
        <Row gap="xs" align="center">
          <IconButton
            icon="refresh"
            label="刷新"
            size="sm"
            variant="ghost"
            tone={isStale ? 'warning' : 'neutral'}
            tooltip={isStale ? '有会话状态变化，点这里重新读取' : '重新读取所有工作区的会话'}
            disabled={isLoading}
            onPress={() => void refresh(true)}
          />
          <Button
            size="sm"
            variant="outline"
            tone={idle.length > 0 ? 'danger' : 'neutral'}
            disabled={isReclaiming || idle.length === 0}
            onPress={() => {
              set(actionError, null)
              set(notice, null)
              set(askingReclaim, true)
            }}
          >
            {`回收空闲${idle.length > 0 ? ` (${idle.length})` : ''}`}
          </Button>
        </Row>
      </Row>

      {view !== null ? (
        <Box background="card" border radius="md" padding="sm" direction="column" gap="xs">
          <Row justify="between" align="center" gap="sm">
            <Text muted size="xs">
              当前工作区
            </Text>
            <Box shrink={false}>
              <Text size="xs" muted={idle.length === 0} weight={idle.length > 0 ? 'medium' : 'regular'}>
                {`空闲 ${idleAll.length} 个 · 可回收 ${idle.length} 个`}
              </Text>
            </Box>
          </Row>
          <Text size="sm" weight="semibold" truncate>
            {currentWorkspace?.name ?? '未选中'}
          </Text>
          {isStale ? (
            <Text tone="warning" size="xs">
              有新状态变化，刷新后再回收
            </Text>
          ) : null}
        </Box>
      ) : null}

      {isAsking ? (
        <Callout tone="warning" title="确认回收空闲会话">
          <Stack gap="sm">
            <Text size="sm">
              {idle.length === 0 || currentWorkspaceId === null
                ? idleAll.length > 0
                  ? `当前工作区有 ${idleAll.length} 个 done 会话，但它们都没有可关闭的进程（没有终端，也没有命中进程）。`
                  : '当前工作区没有状态为 done 的会话，无需回收。'
                : `将关闭当前工作区「${currentWorkspace?.name ?? currentWorkspaceId}」里 ${idle.length} 个会话：${idle
                    .slice(0, 3)
                    .map((session) => `「${truncateTitle(session.title, 20)}」`)
                    .join('')}${idle.length > 3 ? ` 等 ${idle.length} 个` : ''}。带终端的走 terminal.close，chat 会话按会话 id（或没有 id 的 agent 的种类配对）定位进程组后发 SIGTERM，进程会随之结束，无法撤销。`}
            </Text>
            {isStale ? (
              <Text muted size="xs">
                之后又有会话状态变化，实际关闭数量以执行结果为准。
              </Text>
            ) : null}
            <Row gap="xs">
              <Button
                size="sm"
                variant="solid"
                tone="danger"
                disabled={isReclaiming || idle.length === 0 || currentWorkspaceId === null}
                onPress={() => {
                  if (currentWorkspaceId !== null) void reclaimIdle(currentWorkspaceId)
                }}
              >
                {isReclaiming ? '正在关闭…' : `确认关闭 ${idle.length} 个`}
              </Button>
              <Button size="sm" variant="ghost" disabled={isReclaiming} onPress={() => set(askingReclaim, false)}>
                取消
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}

      {read(loadError) ? (
        <Callout tone="danger" title="读取失败">
          <Text size="sm">{read(loadError)}</Text>
        </Callout>
      ) : null}
      {read(actionError) ? (
        <Callout tone="danger" title="操作失败">
          <Text size="sm">{read(actionError)}</Text>
        </Callout>
      ) : null}
      {read(notice) ? (
        <Callout tone="success" title="完成">
          <Text size="sm">{read(notice)}</Text>
        </Callout>
      ) : null}
      {view !== null && view.failedWorkspaces > 0 ? (
        <Callout tone="warning" title="有工作区没读到">
          <Text size="sm">
            {view.failedWorkspaces} 个工作区的 agents.list 被拒绝或读取失败，它们的会话不在下面。点刷新重试。
          </Text>
        </Callout>
      ) : null}

      {view === null ? (
        isLoading ? (
          <Stack gap="sm">
            <Box background="card" border radius="md" padding="sm">
              <Skeleton shape="text" lines={2} label="正在读取会话…" />
            </Box>
            <Box background="card" border radius="md" padding="sm">
              <Skeleton shape="text" lines={1} />
            </Box>
            <Box background="card" border radius="md" padding="sm">
              <Skeleton shape="text" lines={1} />
            </Box>
          </Stack>
        ) : (
          <EmptyState
            title="还没有读取会话"
            description="点下方按钮重新读取所有工作区的 agent 会话。"
            icon="refresh"
          >
            <Button size="sm" variant="outline" icon="refresh" onPress={() => void refresh(true)}>
              重新读取
            </Button>
          </EmptyState>
        )
      ) : view.sessions.length === 0 ? (
        <EmptyState
          title="没有正在运行的 agent 会话"
          description="所有工作区当前都没有活跃的 chat 或 terminal agent。"
          icon="agent"
        >
          <Button size="sm" variant="outline" icon="refresh" onPress={() => void refresh(true)}>
            刷新
          </Button>
        </EmptyState>
      ) : (
        <Stack gap="sm">
          <Row justify="between" align="center" gap="xs" wrap>
            <Text muted size="xs">
              {`Orca 会话 ${totalCount} 条 · 匹配到进程 ${runningCount} 条`}
            </Text>
            {unmatchedCount > 0 ? (
              <Box shrink={false}>
                <Switch
                  label={`显示无进程 (${unmatchedCount})`}
                  checked={showStoppedRows}
                  onChange={(checked) => set(showStopped, checked)}
                />
              </Box>
            ) : null}
          </Row>
          {unmatchedCount > 0 ? (
            <Text muted size="xs">
              {`其余 ${unmatchedCount} 条${
                unknownCount > 0 ? `中 ${unknownCount} 条无法判定` : '已确认未运行'
              }${unknownCount > 0 && stoppedCount > 0 ? `，${stoppedCount} 条确认未运行` : ''}${
                showStoppedRows ? '（已显示）' : '已隐藏'
              }。`}
            </Text>
          ) : null}

          {visibleGroups.length === 0 ? (
            <EmptyState
              title="没有正在运行的会话"
              description={`还有 ${unmatchedCount} 条没有匹配到进程的会话已隐藏，打开上方开关或点击下方按钮查看。`}
              icon="agent"
            >
              <Button size="sm" variant="outline" onPress={() => set(showStopped, true)}>
                {`显示无进程 (${unmatchedCount})`}
              </Button>
            </EmptyState>
          ) : (
            <Stack gap="sm">
              {visibleGroups.map((group) =>
                renderGroup(
                  group,
                  currentWorkspaceId,
                  showStoppedRows,
                  expandedByWorkspace[group.workspace.id] === true
                )
              )}
              {view.workspacesTruncated ? (
                <Text muted size="xs">
                  Orca 截断了工作区列表，这里只覆盖其中一部分。
                </Text>
              ) : null}
            </Stack>
          )}
        </Stack>
      )}
      {view !== null && view.recentOps.length > 0 ? renderRecentOps(view.recentOps) : null}
    </Stack>
  )
}