// The plugin's own worker: it reads Orca's host API, and stops a session either through the
// terminal API or, for a chat session with no terminal, by SIGTERM-ing the claude process group
// that Orca started for it. Nothing is killed without resolving the process first.
import type { OrcaWorkerApi } from 'orca/worker'
import { buildTitleMap, type ChatTitleOps } from './botChats'
import { messageOf } from './errors'
import { createChatTitleOps, createSignalOps } from './hostOps'
import { AGENT_STATE_LABEL } from './labels'
import type {
  AgentState,
  CloseOutcome,
  OpRecord,
  ProcessState,
  ReclaimResult,
  SessionRow,
  SessionSnapshot,
  WorkspaceRow
} from './protocol'
import {
  agentProcesses,
  findRunningProcessId,
  parseProcessTable,
  providesSessionId,
  type PsRow
} from './processTable'
import { aliasTitles, sessionCandidates, type SessionRecord } from './sessionRecord'
import { stopPairedSession, stopSessionWithSignal, type SignalOps } from './sessionProcess'
import { selectIdle } from './sessions'

/** How many `agents.list` calls are in flight at once. 127 workspaces one by one is slow. */
const BATCH = 8

const OPS_KEY = 'recentOps'
const MAX_OPS = 50

const TITLES_KEY = 'botTitles'
/** Titles change slowly; a list older than this rebuilds them, and so does a manual refresh. */
const TITLE_TTL_MS = 60_000

/**
 * The process side of a close. Orca calls `activate(orca)` with nothing else, so tests swap this
 * through `useSignalOps` instead of touching real processes.
 */
let signalOps: SignalOps | null = null

function signalOperations(): SignalOps {
  return (signalOps ??= createSignalOps())
}

export function useSignalOps(replaced: SignalOps | null): void {
  signalOps = replaced
}

/**
 * Where chat titles come from. Tests swap this through `useTitleOps` so they never run the CLI.
 */
let chatTitleOps: ChatTitleOps | null = null

function titleOperations(): ChatTitleOps {
  return (chatTitleOps ??= createChatTitleOps())
}

export function useTitleOps(replaced: ChatTitleOps | null): void {
  chatTitleOps = replaced
}

type TitleCache = { at: number; titles: Record<string, string> }

/**
 * Chat titles keyed by Orca session id. `refresh` rebuilds from the CLI (the 刷新 button and every
 * refresh after a close); otherwise a cache younger than a minute is enough, since a full rebuild
 * asks every bot and takes about a second. Record aliases are applied per snapshot, because a
 * rewind can add a new conversation id at any time.
 */
async function loadTitles(orca: OrcaWorkerApi, refresh: boolean): Promise<Record<string, string>> {
  let cached: TitleCache | null = null
  try {
    const stored = await orca.storage.get(TITLES_KEY)
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      const value = stored as { at?: unknown; titles?: unknown }
      const titles = value.titles
      if (
        typeof value.at === 'number' &&
        titles &&
        typeof titles === 'object' &&
        !Array.isArray(titles)
      ) {
        cached = { at: value.at, titles: titles as Record<string, string> }
      }
    }
  } catch {
    // No usable cache; a rebuild may still work.
  }

  if (!refresh && cached && Date.now() - cached.at < TITLE_TTL_MS) return cached.titles

  let fresh: Record<string, string>
  try {
    fresh = await buildTitleMap(titleOperations())
  } catch {
    return cached?.titles ?? {}
  }
  // An empty map means the CLI answered nothing; keep the last good titles instead of losing them.
  if (Object.keys(fresh).length === 0 && cached) return cached.titles
  try {
    await orca.storage.set(TITLES_KEY, { at: Date.now(), titles: fresh })
  } catch {
    // The cache is an optimisation; the titles still show this time.
  }
  return fresh
}

/** Terminal panes carry their own title; a chat's title comes only from the chat-title table. */
function terminalLabel(agent: {
  title?: string | null
  task?: { title: string } | null
  sessionId?: string | null
}): string {
  if (agent.title) return agent.title
  if (agent.task?.title) return agent.task.title
  if (agent.sessionId) return `会话 ${agent.sessionId.slice(0, 8)}`
  return '未命名会话'
}

function idLabel(id: string | null): string {
  return id ? `会话 ${id.slice(0, 8)}` : '未命名会话'
}

async function readOps(orca: OrcaWorkerApi): Promise<OpRecord[]> {
  const stored = await orca.storage.get(OPS_KEY)
  return Array.isArray(stored) ? (stored as OpRecord[]) : []
}

/** Best effort: a log that cannot be written must not turn a finished close into an error. */
async function recordOp(orca: OrcaWorkerApi, entry: OpRecord): Promise<void> {
  try {
    const list = await readOps(orca)
    list.unshift(entry)
    await orca.storage.set(OPS_KEY, list.slice(0, MAX_OPS))
  } catch (error) {
    orca.log(`recentOps 写入失败：${messageOf(error)}`)
  }
}

/** The `agents.list` fields this plugin reads; host-only fields are ignored. */
type ListedAgent = {
  terminalId: string | null
  title?: string | null
  task?: { title: string } | null
  sessionId?: string | null
  agent?: string | null
  state: AgentState
  stateStartedAt: number
}

/** A chat session matched to a process without ever seeing its id. */
type KindPairing = {
  pid: number
  pgid: number
  /** The workspace's session count, equal to its cwd-matching process count — the basis. */
  count: number
}

/** Reads every workspace and the agent sessions inside them. */
async function readSnapshot(orca: OrcaWorkerApi, refreshTitles: boolean): Promise<SessionSnapshot> {
  const listed = await orca.host.call('workspace.list', { includeStatus: true })
  const context = await orca.host.call('workspace.readContext')

  // One read of the session database and one `ps` for the whole list. The database tells a row
  // every id its process may carry; `ps` says which of them is actually running. Either source
  // failing leaves the rows it would have answered for unjudged, never "not running".
  let records: SessionRecord[] = []
  try {
    records = await signalOperations().listSessionRecords()
  } catch {
    // Without the chain a row can still match on the id it carries; nothing else is claimed.
    records = []
  }
  let processTable: PsRow[] | null = null
  let psError: string | null = null
  try {
    processTable = parseProcessTable(await signalOperations().listProcesses())
  } catch (error) {
    processTable = null
    psError = messageOf(error)
  }

  const titles = aliasTitles(await loadTitles(orca, refreshTitles), records)

  const workspaces = listed.workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    kind: workspace.kind,
    path: workspace.path || null,
    terminalCount: workspace.status?.terminalCount ?? null
  }))
  const workspacePaths = new Map(workspaces.map((workspace) => [workspace.id, workspace.path]))

  const scanned: { workspace: WorkspaceRow; agent: ListedAgent }[] = []
  let failedWorkspaces = 0

  for (let start = 0; start < listed.workspaces.length; start += BATCH) {
    const batch = listed.workspaces.slice(start, start + BATCH)
    const answers = await Promise.all(
      batch.map(async (workspace) => {
        try {
          const { agents } = await orca.host.call('agents.list', { workspaceId: workspace.id })
          return { workspace, agents }
        } catch {
          // A workspace that vanished mid-scan must not cost the whole list, but the panel says
          // how many were skipped instead of quietly showing fewer sessions.
          return { workspace, agents: null }
        }
      })
    )
    for (const { workspace, agents } of answers) {
      if (agents === null) {
        failedWorkspaces += 1
        continue
      }
      for (const agent of agents) {
        scanned.push({
          workspace: {
            id: workspace.id,
            name: workspace.name,
            kind: workspace.kind,
            path: workspace.path || null,
            terminalCount: workspace.status?.terminalCount ?? null
          },
          agent
        })
      }
    }
  }

  const processes = processTable ? agentProcesses(processTable) : []

  // Exact matches first: an agent whose CLI carries a conversation id is reached by that id.
  const candidatesAt = new Map<number, string[]>()
  const matchedAt = new Map<number, string>()
  scanned.forEach((entry, index) => {
    if (entry.agent.terminalId !== null || processTable === null) return
    const candidates = sessionCandidates(records, entry.agent.sessionId ?? null)
    candidatesAt.set(index, candidates)
    const matchedId = findRunningProcessId(processTable, candidates)
    if (matchedId) matchedAt.set(index, matchedId)
  })

  // Ids that matched nothing may belong to an agent kind that never puts an id on its command
  // line. Pair them inside their own workspace: only processes whose cwd is that workspace
  // directory count, and only an exact per-workspace 1:1 count is evidence. Any other count is
  // left unjudged — the machine-wide counts are not comparable, because other workspaces run the
  // same kind too.
  const pending = new Map<string, { workspaceId: string; kind: string; indexes: number[] }>()
  scanned.forEach((entry, index) => {
    if (entry.agent.terminalId !== null || processTable === null || matchedAt.has(index)) return
    const kind = entry.agent.agent ?? 'unknown'
    if (providesSessionId(kind, processes)) return
    const key = `${entry.workspace.id}\u0000${kind}`
    const group = pending.get(key)
    if (group) group.indexes.push(index)
    else pending.set(key, { workspaceId: entry.workspace.id, kind, indexes: [index] })
  })

  // One `lsof` per pid, shared by every workspace: a pid can only have one cwd.
  const cwdCache = new Map<number, string | null>()
  const cwdOf = async (pid: number): Promise<string | null> => {
    if (!cwdCache.has(pid)) {
      cwdCache.set(pid, await signalOperations().processCwd(pid).catch(() => null))
    }
    return cwdCache.get(pid) ?? null
  }

  const pairs = new Map<number, KindPairing>()
  const pairingNotes = new Map<number, string>()
  for (const { workspaceId, kind, indexes } of pending.values()) {
    const workspacePath = workspacePaths.get(workspaceId) ?? null
    if (!workspacePath) {
      const note = `${kind} 不提供会话 id；读不到工作区 ${workspaceId} 的目录路径，无法按目录配对`
      for (const index of indexes) pairingNotes.set(index, note)
      continue
    }
    const kindProcesses = processes
      .filter((process) => process.kind === kind && process.providerId === null)
      .sort((left, right) => left.row.pid - right.row.pid)
    const inWorkspace = []
    for (const process of kindProcesses) {
      if ((await cwdOf(process.row.pid)) === workspacePath) inWorkspace.push(process)
    }
    if (inWorkspace.length !== indexes.length) {
      const note = `${kind} 不提供会话 id；该工作区 ${indexes.length} 条会话 / ${inWorkspace.length} 个进程，数量不等，不猜`
      for (const index of indexes) pairingNotes.set(index, note)
      continue
    }
    // Deterministic order, so the same machine state always yields the same pairings.
    const ordered = [...indexes].sort((left, right) => {
      const leftSession = scanned[left]
      const rightSession = scanned[right]
      const byStart = leftSession.agent.stateStartedAt - rightSession.agent.stateStartedAt
      if (byStart !== 0) return byStart
      return (leftSession.agent.sessionId ?? '').localeCompare(rightSession.agent.sessionId ?? '')
    })
    for (let position = 0; position < ordered.length; position += 1) {
      const index = ordered[position]
      const process = inWorkspace[position]
      if (index === undefined || !process) continue
      pairs.set(index, { pid: process.row.pid, pgid: process.row.pgid, count: ordered.length })
    }
  }

  const sessions: SessionRow[] = scanned.map(({ workspace, agent }, index) => {
    const rowId = agent.sessionId ?? null
    const candidates = candidatesAt.get(index) ?? []
    const matchedId = matchedAt.get(index) ?? null
    const pair = pairs.get(index) ?? null
    const kind = agent.agent ?? 'unknown'

    let process: ProcessState | null
    let processNote: string | null = null
    if (agent.terminalId !== null) {
      process = null
    } else if (processTable === null) {
      process = 'unknown'
      processNote = `ps 读不到：${psError ?? '未知错误'}`
    } else if (matchedId) {
      process = 'running'
    } else if (pair) {
      process = 'running'
      processNote = `${kind} 不提供会话 id；该工作区 ${pair.count} 条会话 / ${pair.count} 个进程 cwd 一致，1:1 配到 pid ${pair.pid}（pgid ${pair.pgid}）`
    } else if (candidates.length === 0) {
      // No id any process could carry, and no pairing to stand on: nothing here to run.
      process = 'stopped'
    } else {
      // Ids exist but none matched, or the id-less pairing refused: unjudged, never "not running".
      process = 'unknown'
      processNote =
        pairingNotes.get(index) ?? '会话 id 没有命中任何进程（进程可能已退出，或 ps 里看不到）'
    }

    // The row shows the id its process answered to, and looks the title up by that same id.
    const displayId = agent.terminalId !== null ? rowId ?? agent.terminalId : matchedId ?? rowId
    const title =
      agent.terminalId !== null
        ? terminalLabel(agent)
        : displayId
          ? (titles[displayId] ?? idLabel(displayId))
          : '未命名会话'

    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceKind: workspace.kind,
      terminalId: agent.terminalId,
      title,
      agent: kind,
      state: agent.state,
      stateStartedAt: agent.stateStartedAt,
      sessionId: rowId,
      process,
      matchedId,
      pairing: matchedId ? ('id' as const) : pair ? ('agent' as const) : null,
      matchedPid: pair?.pid ?? null,
      matchedPgid: pair?.pgid ?? null,
      processNote
    }
  })

  let recentOps: OpRecord[] = []
  try {
    recentOps = await readOps(orca)
  } catch {
    // The panel simply shows no history when the store cannot be read.
  }

  return {
    workspaces,
    sessions,
    currentWorkspaceId: context?.workspaceId ?? null,
    workspacesTruncated: listed.truncated,
    failedWorkspaces,
    recentOps
  }
}

/** `terminal.close` only accepts a terminal of the focused workspace, so focus it first. */
async function closeTerminal(
  orca: OrcaWorkerApi,
  terminalId: string
): Promise<{ ok: boolean; code?: string; message?: string }> {
  try {
    const focus = await orca.host.call('terminal.focus', { terminalId })
    if (!focus.focused) {
      return {
        ok: false,
        code: 'not_focused',
        message: 'Orca 没能把焦点移到这里（窗口未激活，或另一个聚焦请求紧接着发生），已放弃关闭'
      }
    }
    await orca.host.call('terminal.close', { terminalId })
    return { ok: true }
  } catch (error) {
    const failure = error as { code?: unknown }
    return {
      ok: false,
      code: typeof failure.code === 'string' ? failure.code : 'action_failed',
      message: messageOf(error)
    }
  }
}

type CloseInput = {
  workspaceId: string
  sessionId?: string | null
  terminalId?: string | null
  /** The pid an id-less agent's row was paired to; absent for id matches. */
  pid?: number | null
  dryRun?: boolean
}

/**
 * Closes one session after checking, against a fresh `agents.list`, that it still exists and is
 * `done`. A session that started working again is refused here, not just in the panel.
 */
async function closeOne(orca: OrcaWorkerApi, input: CloseInput): Promise<CloseOutcome> {
  const dryRun = input.dryRun === true
  const base: CloseOutcome = {
    ok: false,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId ?? null,
    how: null,
    dryRun
  }
  const fallbackTitle = input.sessionId
    ? idLabel(input.sessionId)
    : (input.terminalId ?? '会话')
  const fallbackKind: 'terminal' | 'signal' = input.terminalId ? 'terminal' : 'signal'

  /** Every attempt lands in the log, refusals included: a click must never look like nothing. */
  const finish = async (outcome: CloseOutcome, title: string): Promise<CloseOutcome> => {
    await recordOp(orca, {
      at: Date.now(),
      ok: outcome.ok,
      dryRun,
      kind: outcome.how ?? fallbackKind,
      title,
      sessionId: outcome.sessionId,
      terminalId: outcome.terminalId ?? input.terminalId ?? null,
      sessionUuid: outcome.sessionUuid ?? null,
      pid: outcome.pid ?? null,
      pgid: outcome.pgid ?? null,
      message: outcome.ok ? null : (outcome.message ?? null)
    })
    return outcome
  }

  let agents
  try {
    ;({ agents } = await orca.host.call('agents.list', { workspaceId: input.workspaceId }))
  } catch (error) {
    return finish(
      { ...base, code: 'list_failed', message: `读工作区会话失败：${messageOf(error)}` },
      fallbackTitle
    )
  }

  const match = agents.find(
    (agent) =>
      (input.sessionId != null && agent.sessionId === input.sessionId) ||
      (input.terminalId != null && agent.terminalId === input.terminalId)
  )
  if (!match) {
    return finish({ ...base, code: 'not_found', message: '这个会话已经不在了，刷新看看' }, fallbackTitle)
  }

  const sessionId = match.sessionId ?? base.sessionId
  const title = match.terminalId !== null ? terminalLabel(match) : idLabel(sessionId)
  if (match.state !== 'done') {
    return finish(
      {
        ...base,
        sessionId,
        code: 'not_idle',
        message: `会话现在是「${AGENT_STATE_LABEL[match.state]}」，只有 done 才能关闭`
      },
      title
    )
  }

  if (match.terminalId) {
    const closed: { ok: boolean; code?: string; message?: string } = dryRun
      ? { ok: true }
      : await closeTerminal(orca, match.terminalId)
    return finish(
      {
        ...base,
        sessionId,
        ok: closed.ok,
        how: 'terminal',
        terminalId: match.terminalId,
        // Request answers are JSON: an `undefined` field fails the host's shape check.
        ...(closed.code ? { code: closed.code } : {}),
        ...(closed.message ? { message: closed.message } : {})
      },
      title
    )
  }

  if (!sessionId) {
    return finish({ ...base, code: 'no_handle', message: '这个会话既没有终端也没有 sessionId，没法关' }, title)
  }

  const pid = typeof input.pid === 'number' ? input.pid : null
  if (pid !== null) {
    // The panel offers a pid only for an agent that carries no session id. Re-read the same
    // pairing it drew before signalling: a changed per-workspace count, a different pid, or a
    // process whose cwd left the workspace is refused, because an id-less pairing is a
    // directory-and-count inference and may not outlive the snapshot that made it.
    const snapshot = await readSnapshot(orca, false)
    const row = snapshot.sessions.find(
      (session) =>
        session.workspaceId === input.workspaceId &&
        session.terminalId === null &&
        session.sessionId === sessionId
    )
    if (!row || row.pairing !== 'agent' || row.matchedPid !== pid) {
      return finish(
        {
          ...base,
          sessionId,
          code: 'pairing_changed',
          message: '这个会话和进程的配对已经变了（数量不再一一对应，或进程 cwd 已不在这个工作区），刷新确认后再关，不盲杀'
        },
        title
      )
    }
    if (row.state !== 'done') {
      return finish(
        {
          ...base,
          sessionId,
          code: 'not_idle',
          message: `会话现在是「${AGENT_STATE_LABEL[row.state]}」，只有 done 才能关闭`
        },
        title
      )
    }
    const workspacePath =
      snapshot.workspaces.find((workspace) => workspace.id === input.workspaceId)?.path ?? null
    const outcome = await stopPairedSession({
      workspaceId: input.workspaceId,
      sessionId,
      agent: row.agent,
      pid,
      workspacePath,
      dryRun,
      ops: signalOperations()
    })
    return finish(outcome, title)
  }

  const outcome = await stopSessionWithSignal({
    workspaceId: input.workspaceId,
    sessionId,
    dryRun,
    ops: signalOperations()
  })
  return finish(outcome, title)
}

async function reclaimIdle(orca: OrcaWorkerApi, workspaceId: string, dryRun: boolean): Promise<ReclaimResult> {
  // Re-read first: the panel's list may be older than what Orca has now, and closing a session
  // that started working again would be the one thing this must never do.
  const snapshot = await readSnapshot(orca, false)
  const idle = selectIdle(snapshot.sessions, workspaceId)
  const outcomes: CloseOutcome[] = []

  for (const session of idle) {
    const outcome = await closeOne(orca, {
      workspaceId,
      sessionId: session.sessionId,
      terminalId: session.terminalId,
      pid: session.pairing === 'agent' ? session.matchedPid : null,
      dryRun
    })
    outcomes.push(outcome)
    // One refusal usually means the machine cannot be driven right now; stop rather than firing
    // the same failed action at every remaining session.
    if (!outcome.ok) return { outcomes, stoppedAtFailure: true }
  }
  return { outcomes, stoppedAtFailure: false }
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('sessions.list', async (input) => readSnapshot(orca, input?.refreshTitles === true))

  orca.panels.handle('sessions.close', async (input) => {
    const outcome = await closeOne(orca, input)
    orca.log(`close ${input.workspaceId} ${input.sessionId ?? input.terminalId}: ${outcome.ok ? 'ok' : outcome.code}`)
    return outcome
  })

  orca.panels.handle('sessions.reclaim', async ({ workspaceId, dryRun }) => {
    const result = await reclaimIdle(orca, workspaceId, dryRun === true)
    const closed = result.outcomes.filter((outcome) => outcome.ok).length
    orca.log(`reclaimed ${closed}/${result.outcomes.length} in ${workspaceId}`)
    return result
  })
}