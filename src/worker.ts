// The plugin's own worker: aligns active sessions with `orca diagnostics memory` (the Resource
// Manager source), resolves chat processes authoritatively via `agent_session_records.lease` +
// `ps lstart` anti-PID-reuse verification, and closes sessions via terminal API or SIGTERM.
import type { OrcaWorkerApi } from 'orca/worker'
import { buildTitleMap, type ChatTitleOps } from './botChats'
import { messageOf } from './errors'
import { createChatTitleOps, createSignalOps } from './hostOps'
import { AGENT_STATE_LABEL, isFilePath } from './labels'
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
  findAgentTargetByLease,
  findRunningProcessId,
  parseProcessTable,
  parseProviderId,
  type PsRow
} from './processTable'
import {
  aliasTitles,
  extractWorktreePath,
  findSessionRecord,
  sessionCandidates,
  type SessionRecord,
  type SessionRecordLookup
} from './sessionRecord'
import {
  stopSessionByLease,
  type MemoryChat,
  type MemoryTerminalSession,
  type MemoryWorktree,
  type SignalOps
} from './sessionProcess'
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

function safeIdLabel(id: string | null): string {
  if (id && !isFilePath(id)) return `会话 ${id.slice(0, 8)}`
  return '未命名会话'
}

/** Terminal panes carry their own title; a chat's title comes from Resource Manager / CLI / DB. */
function terminalLabel(agent: {
  title?: string | null
  task?: { title: string } | null
  sessionId?: string | null
}): string {
  if (agent.title) return agent.title
  if (agent.task?.title) return agent.task.title
  return safeIdLabel(agent.sessionId ?? null)
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

/**
 * Matches a worktree entry from `orca diagnostics memory` (`folder:<uuid>` or `<repoId>::/abs/path`)
 * to a `WorkspaceRow` from `workspace.list` (`folder:<uuid>` or `identity:wt2:local:<uuid>` + `path`).
 */
export function resolveMemoryWorkspace(
  memWt: Pick<MemoryWorktree, 'worktreeId' | 'worktreeName'>,
  workspaces: readonly WorkspaceRow[]
): WorkspaceRow | null {
  const exact = workspaces.find((workspace) => workspace.id === memWt.worktreeId)
  if (exact) return exact
  const memPath = extractWorktreePath(memWt.worktreeId)
  if (!memPath) return null
  const byPath = workspaces.filter((workspace) => workspace.path === memPath)
  if (byPath.length === 0) return null
  if (byPath.length === 1) return byPath[0]
  const worktreesOnly = byPath.filter((workspace) => workspace.kind === 'worktree')
  const pool = worktreesOnly.length > 0 ? worktreesOnly : byPath
  if (pool.length === 1) return pool[0]
  const byName = pool.find(
    (workspace) =>
      workspace.name === memWt.worktreeName || memWt.worktreeName.endsWith(`:${workspace.name}`)
  )
  return byName ?? pool[0]
}

type ChatProcessResolution = {
  process: ProcessState
  matchedId: string | null
  pairing: 'lease' | 'id' | null
  matchedPid: number | null
  matchedPgid: number | null
  processNote: string | null
}

function resolveChatProcess(options: {
  kind: string
  rowId: string | null
  candidates: readonly string[]
  recordLookup: SessionRecordLookup
  recordsLoaded: boolean
  recordsError: string | null
  processTable: readonly PsRow[] | null
  psError: string | null
  ownPgid: number | null
  inMemorySnapshot: boolean
}): ChatProcessResolution {
  const {
    kind,
    rowId,
    candidates,
    recordLookup,
    recordsLoaded,
    recordsError,
    processTable,
    psError,
    ownPgid,
    inMemorySnapshot
  } = options

  if (processTable === null) {
    return {
      process: 'unknown',
      matchedId: null,
      pairing: null,
      matchedPid: null,
      matchedPgid: null,
      processNote: `ps 读不到：${psError ?? '未知错误'}`
    }
  }

  if (recordLookup.status === 'ambiguous') {
    return {
      process: 'unknown',
      matchedId: null,
      pairing: null,
      matchedPid: null,
      matchedPgid: null,
      processNote: `会话数据库里 ${rowId ?? '当前会话'} 命中 ${recordLookup.records.length} 条记录，无法唯一判定`
    }
  }

  if (recordLookup.status === 'found') {
    const { record } = recordLookup
    if (record.unreconciled) {
      return {
        process: 'unknown',
        matchedId: null,
        pairing: null,
        matchedPid: null,
        matchedPgid: null,
        processNote: '会话租约处于未对账状态（unreconciled），等待 Orca 对账'
      }
    }

    if (record.claimStatus === 'live' && record.ownerProcess !== null) {
      const expectedKind = kind !== 'unknown' ? kind : record.provider
      const leaseTarget = findAgentTargetByLease(processTable, record.ownerProcess, expectedKind, ownPgid)
      if (leaseTarget.ok) {
        const cliId = parseProviderId(leaseTarget.target.command)
        const startNote =
          leaseTarget.target.startTimeMs !== null ? ` · startTime ${leaseTarget.target.startTimeMs}` : ''
        return {
          process: 'running',
          matchedId: cliId,
          pairing: 'lease',
          matchedPid: leaseTarget.target.pid,
          matchedPgid: leaseTarget.target.pgid,
          processNote: `租约精确匹配 pid ${leaseTarget.target.pid}（pgid ${leaseTarget.target.pgid}${startNote}）`
        }
      }
      return {
        process: 'unknown',
        matchedId: null,
        pairing: null,
        matchedPid: null,
        matchedPgid: null,
        processNote: leaseTarget.message
      }
    }

    if (record.claimStatus === 'released' && record.ownerProcess === null) {
      const runningId = findRunningProcessId(processTable, candidates)
      if (runningId) {
        return {
          process: 'running',
          matchedId: runningId,
          pairing: 'id',
          matchedPid: null,
          matchedPgid: null,
          processNote: `租约标记 released，但 ps 检测到命令行 id ${runningId} 仍在运行`
        }
      }
      if (inMemorySnapshot) {
        return {
          process: 'unknown',
          matchedId: null,
          pairing: null,
          matchedPid: null,
          matchedPgid: null,
          processNote: '会话仍在 Orca 资源管理器中，但租约已标记 released，无法判定进程归属'
        }
      }
      return {
        process: 'stopped',
        matchedId: null,
        pairing: null,
        matchedPid: null,
        matchedPgid: null,
        processNote: record.deathKind ? `租约已释放（${record.deathKind}），确认未运行` : '租约已释放，确认未运行'
      }
    }

    if (record.claimStatus === null && record.ownerProcess === null) {
      const runningId = findRunningProcessId(processTable, candidates)
      if (runningId) {
        return {
          process: 'running',
          matchedId: runningId,
          pairing: 'id',
          matchedPid: null,
          matchedPgid: null,
          processNote: null
        }
      }
      if (candidates.length === 0 && !inMemorySnapshot) {
        return {
          process: 'stopped',
          matchedId: null,
          pairing: null,
          matchedPid: null,
          matchedPgid: null,
          processNote: null
        }
      }
      return {
        process: 'unknown',
        matchedId: null,
        pairing: null,
        matchedPid: null,
        matchedPgid: null,
        processNote: '会话缺少租约字段且未匹配到命令行进程'
      }
    }

    return {
      process: 'unknown',
      matchedId: null,
      pairing: null,
      matchedPid: null,
      matchedPgid: null,
      processNote: `会话租约状态为 ${record.claimStatus ?? '未知'}${record.ownerProcess ? '' : '（缺少 ownerProcess）'}，无法确认进程状态`
    }
  }

  // Fallback when DB is unreadable or has no record for this row.
  const runningId = findRunningProcessId(processTable, candidates)
  if (runningId) {
    return {
      process: 'running',
      matchedId: runningId,
      pairing: 'id',
      matchedPid: null,
      matchedPgid: null,
      processNote: null
    }
  }
  if (candidates.length === 0 && !inMemorySnapshot) {
    return {
      process: 'stopped',
      matchedId: null,
      pairing: null,
      matchedPid: null,
      matchedPgid: null,
      processNote: null
    }
  }
  const dbHint = !recordsLoaded
    ? `（读会话数据库失败：${recordsError ?? '未知错误'}）`
    : '（会话数据库无此记录）'
  return {
    process: 'unknown',
    matchedId: null,
    pairing: null,
    matchedPid: null,
    matchedPgid: null,
    processNote: `没有匹配到进程${dbHint}`
  }
}

/**
 * Chat title resolution priority:
 * 1. `diagnostics.memory` `chat.name` (identical to Resource Manager),
 * 2. `orca bot chats` title table (via canonical/matched/native/chain aliases),
 * 3. `agent_session_records.conversationName`,
 * 4. `会话 <orcaSessionId 前 8 位>` (or non-path `matchedId` / `rowId`),
 * 5. `未命名会话` (never slices filesystem paths such as pi's `.jsonl` path).
 */
function resolveChatTitle(options: {
  memoryName: string | null
  titles: Record<string, string>
  record: SessionRecord | null
  orcaSessionId: string | null
  matchedId: string | null
  rowId: string | null
}): string {
  const { memoryName, titles, record, orcaSessionId, matchedId, rowId } = options
  const memTrimmed = memoryName?.trim() ?? ''
  if (memTrimmed.length > 0) return memTrimmed

  const titleKeys = [
    orcaSessionId,
    matchedId,
    rowId,
    record?.sessionId ?? null,
    record?.nativeId ?? null,
    ...(record?.chainIds ?? [])
  ]
  for (const key of titleKeys) {
    if (key && titles[key]) return titles[key]
  }

  const convName = record?.conversationName?.trim() ?? ''
  if (convName.length > 0) return convName

  for (const id of [orcaSessionId, matchedId, rowId]) {
    if (id && !isFilePath(id)) return `会话 ${id.slice(0, 8)}`
  }
  return '未命名会话'
}

function matchTerminalMemory(
  agent: ListedAgent,
  memSessions: readonly MemoryTerminalSession[] | undefined,
  workspaceTerminalTotal: number
): number | null {
  if (!memSessions || memSessions.length === 0) return null
  const direct = memSessions.find(
    (session) =>
      session.sessionId === agent.sessionId ||
      session.sessionId === agent.terminalId ||
      session.paneKey === agent.terminalId ||
      session.paneKey === agent.sessionId
  )
  if (direct) return direct.memory
  if (memSessions.length === 1 && workspaceTerminalTotal === 1) return memSessions[0].memory
  return null
}

/** Reads every workspace, merges `orca diagnostics memory`, and resolves processes via leases. */
async function readSnapshot(orca: OrcaWorkerApi, refreshTitles: boolean): Promise<SessionSnapshot> {
  const listed = await orca.host.call('workspace.list', { includeStatus: true })
  const context = await orca.host.call('workspace.readContext')

  let records: SessionRecord[] = []
  let recordsLoaded = false
  let recordsError: string | null = null
  try {
    records = await signalOperations().listSessionRecords()
    recordsLoaded = true
  } catch (error) {
    records = []
    recordsError = messageOf(error)
  }

  let processTable: PsRow[] | null = null
  let psError: string | null = null
  try {
    processTable = parseProcessTable(await signalOperations().listProcesses())
  } catch (error) {
    processTable = null
    psError = messageOf(error)
  }

  const [memorySnapshot, ownPgid, rawTitles] = await Promise.all([
    signalOperations()
      .readMemorySnapshot()
      .catch(() => null),
    signalOperations()
      .ownPgid()
      .catch(() => null),
    loadTitles(orca, refreshTitles)
  ])
  const titles = aliasTitles(rawTitles, records)

  const workspaces: WorkspaceRow[] = listed.workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    kind: workspace.kind,
    path: workspace.path || null,
    terminalCount: workspace.status?.terminalCount ?? null
  }))
  const syntheticWorkspaceIds = new Set<string>()
  const memoryChatsById = new Map<string, { chat: MemoryChat; workspace: WorkspaceRow }>()
  const memoryTerminalsByWorkspace = new Map<string, MemoryTerminalSession[]>()

  if (memorySnapshot) {
    for (const memWt of memorySnapshot.worktrees) {
      let resolved = resolveMemoryWorkspace(memWt, workspaces)
      if (!resolved && (memWt.chats.length > 0 || memWt.sessions.length > 0)) {
        resolved = {
          id: memWt.worktreeId,
          name: memWt.worktreeName || memWt.worktreeId,
          kind: memWt.worktreeId.startsWith('folder:') ? 'folder' : 'worktree',
          path: extractWorktreePath(memWt.worktreeId),
          terminalCount: memWt.sessions.length
        }
        workspaces.push(resolved)
        syntheticWorkspaceIds.add(resolved.id)
      }
      if (!resolved) continue
      for (const chat of memWt.chats) {
        memoryChatsById.set(chat.agentSessionId, { chat, workspace: resolved })
      }
      if (memWt.sessions.length > 0) {
        const existing = memoryTerminalsByWorkspace.get(resolved.id)
        if (existing) existing.push(...memWt.sessions)
        else memoryTerminalsByWorkspace.set(resolved.id, [...memWt.sessions])
      }
    }
  }

  const scanned: { workspace: WorkspaceRow; agent: ListedAgent; workspaceTerminalTotal: number }[] = []
  let failedWorkspaces = 0

  for (let start = 0; start < workspaces.length; start += BATCH) {
    const batch = workspaces.slice(start, start + BATCH)
    const answers = await Promise.all(
      batch.map(async (workspace) => {
        try {
          const { agents } = await orca.host.call('agents.list', { workspaceId: workspace.id })
          return { workspace, agents }
        } catch {
          return { workspace, agents: null }
        }
      })
    )
    for (const { workspace, agents } of answers) {
      if (agents === null) {
        if (!syntheticWorkspaceIds.has(workspace.id)) failedWorkspaces += 1
        continue
      }
      const terminalTotal = agents.filter((agent) => agent.terminalId !== null).length
      for (const agent of agents) {
        scanned.push({ workspace, agent, workspaceTerminalTotal: terminalTotal })
      }
    }
  }

  const seenCanonicalChatIds = new Set<string>()
  const sessions: SessionRow[] = scanned.map(({ workspace, agent, workspaceTerminalTotal }) => {
    const rowId = agent.sessionId ?? null
    const recordLookup = recordsLoaded
      ? findSessionRecord(records, rowId, workspace.id, workspace.path)
      : ({ status: 'not_found' } as const)
    const record = recordLookup.status === 'found' ? recordLookup.record : null

    if (agent.terminalId !== null) {
      const memoryBytes = matchTerminalMemory(
        agent,
        memoryTerminalsByWorkspace.get(workspace.id),
        workspaceTerminalTotal
      )
      return {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceKind: workspace.kind,
        terminalId: agent.terminalId,
        title: terminalLabel(agent),
        agent: agent.agent ?? 'unknown',
        state: agent.state,
        stateKnown: true,
        stateStartedAt: agent.stateStartedAt,
        sessionId: rowId,
        orcaSessionId: record?.sessionId ?? null,
        memoryBytes,
        process: null,
        matchedId: null,
        pairing: null,
        matchedPid: null,
        matchedPgid: null,
        processNote: null
      }
    }

    const canonicalId =
      record?.sessionId ?? (rowId && memoryChatsById.has(rowId) ? rowId : null)
    if (canonicalId) seenCanonicalChatIds.add(canonicalId)

    const memEntry =
      (canonicalId ? memoryChatsById.get(canonicalId) : undefined) ??
      (rowId ? memoryChatsById.get(rowId) : undefined) ??
      null
    if (memEntry) seenCanonicalChatIds.add(memEntry.chat.agentSessionId)

    const kind =
      agent.agent && agent.agent.length > 0
        ? agent.agent
        : memEntry?.chat.agent || record?.provider || 'unknown'
    const candidates = recordsLoaded
      ? sessionCandidates(records, rowId, workspace.id, workspace.path)
      : rowId
        ? [rowId]
        : []
    const resolvedProcess = resolveChatProcess({
      kind,
      rowId,
      candidates,
      recordLookup,
      recordsLoaded,
      recordsError,
      processTable,
      psError,
      ownPgid,
      inMemorySnapshot: memEntry !== null
    })

    const orcaSessionId =
      canonicalId ?? (rowId && !isFilePath(rowId) ? rowId : null)
    const title = resolveChatTitle({
      memoryName: memEntry?.chat.name ?? null,
      titles,
      record,
      orcaSessionId,
      matchedId: resolvedProcess.matchedId,
      rowId
    })

    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceKind: workspace.kind,
      terminalId: null,
      title,
      agent: kind,
      state: agent.state,
      stateKnown: true,
      stateStartedAt: agent.stateStartedAt,
      sessionId: rowId,
      orcaSessionId,
      memoryBytes: memEntry?.chat.memory ?? null,
      process: resolvedProcess.process,
      matchedId: resolvedProcess.matchedId,
      pairing: resolvedProcess.pairing,
      matchedPid: resolvedProcess.matchedPid,
      matchedPgid: resolvedProcess.matchedPgid,
      processNote: resolvedProcess.processNote
    }
  })

  // Any active chat reported by `orca diagnostics memory` that `agents.list` omitted (e.g.
  // workspace truncated, hidden, or `agents.list` failed/capped) is appended so the list matches
  // Orca's Resource Manager 1:1. Close stays disabled because its idle state is unknown.
  for (const [agentSessionId, { chat, workspace }] of memoryChatsById) {
    if (seenCanonicalChatIds.has(agentSessionId)) continue
    const recordLookup = recordsLoaded
      ? findSessionRecord(records, agentSessionId, workspace.id, workspace.path)
      : ({ status: 'not_found' } as const)
    const record = recordLookup.status === 'found' ? recordLookup.record : null
    const kind =
      chat.agent && chat.agent !== 'unknown' ? chat.agent : (record?.provider ?? 'unknown')
    const candidates = recordsLoaded
      ? sessionCandidates(records, agentSessionId, workspace.id, workspace.path)
      : [agentSessionId]
    const resolvedProcess = resolveChatProcess({
      kind,
      rowId: agentSessionId,
      candidates,
      recordLookup,
      recordsLoaded,
      recordsError,
      processTable,
      psError,
      ownPgid,
      inMemorySnapshot: true
    })
    const stateHint = '未从 Orca 获取到会话空闲状态，暂不可关闭'
    const processNote = resolvedProcess.processNote
      ? `${resolvedProcess.processNote}；${stateHint}`
      : stateHint

    sessions.push({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceKind: workspace.kind,
      terminalId: null,
      title: resolveChatTitle({
        memoryName: chat.name,
        titles,
        record,
        orcaSessionId: agentSessionId,
        matchedId: resolvedProcess.matchedId,
        rowId: agentSessionId
      }),
      agent: kind,
      state: 'working',
      stateKnown: false,
      stateStartedAt: 0,
      sessionId: agentSessionId,
      orcaSessionId: agentSessionId,
      memoryBytes: chat.memory,
      process: resolvedProcess.process,
      matchedId: resolvedProcess.matchedId,
      pairing: resolvedProcess.pairing,
      matchedPid: resolvedProcess.matchedPid,
      matchedPgid: resolvedProcess.matchedPgid,
      processNote
    })
  }

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
  /** Expected lease pid from the row; re-verified against `agent_session_records` and `ps lstart`. */
  pid?: number | null
  dryRun?: boolean
}

function findAgentMatch(
  agents: readonly ListedAgent[],
  input: CloseInput,
  records: readonly SessionRecord[]
): ListedAgent | undefined {
  const direct = agents.find(
    (agent) =>
      (input.sessionId != null && agent.sessionId === input.sessionId) ||
      (input.terminalId != null && agent.terminalId === input.terminalId)
  )
  if (direct || input.sessionId == null) return direct
  const candidates = new Set(sessionCandidates(records, input.sessionId, input.workspaceId))
  return agents.find((agent) => agent.sessionId != null && candidates.has(agent.sessionId))
}

/**
 * Closes one session after checking, against a fresh `agents.list`, that it still exists and is
 * `done`, then verifying its live lease and `ps` `lstart` before signalling.
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
    ? safeIdLabel(input.sessionId)
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

  let agents: ListedAgent[]
  try {
    ;({ agents } = await orca.host.call('agents.list', { workspaceId: input.workspaceId }))
  } catch (error) {
    return finish(
      { ...base, code: 'list_failed', message: `读工作区会话失败：${messageOf(error)}` },
      fallbackTitle
    )
  }

  let match = findAgentMatch(agents, input, [])
  let preloadedRecord: SessionRecord | null = null
  if (!match && input.sessionId != null) {
    const records = await signalOperations()
      .listSessionRecords()
      .catch(() => [] as SessionRecord[])
    match = findAgentMatch(agents, input, records)
    const lookup = findSessionRecord(records, input.sessionId, input.workspaceId)
    if (lookup.status === 'found') preloadedRecord = lookup.record
  }

  if (!match) {
    return finish({ ...base, code: 'not_found', message: '这个会话已经不在了，刷新看看' }, fallbackTitle)
  }

  const sessionId = match.sessionId ?? base.sessionId
  const title =
    match.terminalId !== null
      ? terminalLabel(match)
      : preloadedRecord?.conversationName ?? safeIdLabel(preloadedRecord?.sessionId ?? sessionId)

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

  const lookupId = sessionId ?? input.sessionId ?? null
  if (!lookupId) {
    return finish({ ...base, code: 'no_handle', message: '这个会话既没有终端也没有 sessionId，没法关' }, title)
  }

  const expectedPid = typeof input.pid === 'number' ? input.pid : null
  const outcome = await stopSessionByLease({
    workspaceId: input.workspaceId,
    sessionId: lookupId,
    expectedAgent: match.agent ?? null,
    expectedPid,
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
      sessionId: session.sessionId ?? session.orcaSessionId,
      terminalId: session.terminalId,
      pid: session.pairing === 'lease' ? session.matchedPid : null,
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
