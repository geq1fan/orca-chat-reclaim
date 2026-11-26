import { messageOf } from './errors'
import { isFilePath } from './labels'
import type { CloseOutcome } from './protocol'
import {
  findAgentTargetAmong,
  findAgentTargetByLease,
  parseProcessTable,
  parseProviderId,
  type AgentTarget,
  type PsRow
} from './processTable'
import { findSessionRecord, sessionCandidates, type SessionRecord } from './sessionRecord'

export type MemoryChat = {
  agentSessionId: string
  agent: string
  name: string
  cpu: number
  memory: number
}

export type MemoryTerminalSession = {
  sessionId: string
  paneKey: string | null
  pid: number
  cpu: number
  memory: number
}

export type MemoryWorktree = {
  worktreeId: string
  worktreeName: string
  repoId: string | null
  repoName: string | null
  cpu: number
  memory: number
  chats: MemoryChat[]
  sessions: MemoryTerminalSession[]
}

export type MemorySnapshot = {
  worktrees: MemoryWorktree[]
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Parses `orca diagnostics memory --json` output into a typed snapshot, or null when invalid. */
export function parseMemorySnapshot(output: string): MemorySnapshot | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const envelope = parsed as { ok?: unknown; result?: { worktrees?: unknown } }
  if (envelope.ok === false) return null
  const rawWorktrees = envelope.result?.worktrees
  if (!Array.isArray(rawWorktrees)) return null

  const worktrees: MemoryWorktree[] = []
  for (const item of rawWorktrees) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const wt = item as Record<string, unknown>
    const worktreeId = nonEmptyString(wt.worktreeId)
    if (!worktreeId) continue

    const chats: MemoryChat[] = []
    if (Array.isArray(wt.chats)) {
      for (const rawChat of wt.chats) {
        if (!rawChat || typeof rawChat !== 'object' || Array.isArray(rawChat)) continue
        const chat = rawChat as Record<string, unknown>
        const agentSessionId = nonEmptyString(chat.agentSessionId)
        if (!agentSessionId) continue
        chats.push({
          agentSessionId,
          agent: nonEmptyString(chat.agent) ?? 'unknown',
          name: typeof chat.name === 'string' ? chat.name : '',
          cpu: finiteNumber(chat.cpu),
          memory: finiteNumber(chat.memory)
        })
      }
    }

    const sessions: MemoryTerminalSession[] = []
    if (Array.isArray(wt.sessions)) {
      for (const rawSession of wt.sessions) {
        if (!rawSession || typeof rawSession !== 'object' || Array.isArray(rawSession)) continue
        const session = rawSession as Record<string, unknown>
        const sessionId = nonEmptyString(session.sessionId)
        if (!sessionId) continue
        sessions.push({
          sessionId,
          paneKey: nonEmptyString(session.paneKey),
          pid: finiteNumber(session.pid),
          cpu: finiteNumber(session.cpu),
          memory: finiteNumber(session.memory)
        })
      }
    }

    worktrees.push({
      worktreeId,
      worktreeName: typeof wt.worktreeName === 'string' ? wt.worktreeName : '',
      repoId: nonEmptyString(wt.repoId),
      repoName: nonEmptyString(wt.repoName),
      cpu: finiteNumber(wt.cpu),
      memory: finiteNumber(wt.memory),
      chats,
      sessions
    })
  }

  return { worktrees }
}

/** Everything `stopSessionByLease` / `stopSessionWithSignal` and `readSnapshot` need from the host; tests pass fakes. */
export type SignalOps = {
  /** Every stored Orca session with its ids and authoritative lease metadata. */
  listSessionRecords(): Promise<SessionRecord[]>
  /** `LC_ALL=C ps -Ao pid,ppid,pgid,lstart,command` output. */
  listProcesses(): Promise<string>
  /** `orca diagnostics memory --json` snapshot, or null if unavailable. */
  readMemorySnapshot(): Promise<MemorySnapshot | null>
  /** SIGTERM to the whole process group. */
  signalGroup(pgid: number): void
  isAlive(pid: number): boolean
  ownPgid(): Promise<number | null>
  now(): number
  sleep(ms: number): Promise<void>
}

export const TERM_WAIT_MS = 5000
export const TERM_POLL_MS = 250

type SignalBase = {
  workspaceId: string
  sessionId: string
  how: 'signal'
  dryRun: boolean
}

/** SIGTERM the target group and wait for it to go: no escalation, success only when it died. */
async function signalAndWait(
  base: SignalBase,
  target: AgentTarget,
  ops: SignalOps
): Promise<CloseOutcome> {
  const detail = {
    pid: target.pid,
    pgid: target.pgid,
    parentArgs: target.parentCommand
  }

  try {
    ops.signalGroup(target.pgid)
  } catch (error) {
    return { ...base, ok: false, code: 'signal_failed', message: `SIGTERM 失败：${messageOf(error)}`, ...detail }
  }

  const deadline = ops.now() + TERM_WAIT_MS
  for (;;) {
    if (!ops.isAlive(target.pid)) return { ...base, ok: true, ...detail }
    if (ops.now() >= deadline) break
    await ops.sleep(TERM_POLL_MS)
  }
  if (!ops.isAlive(target.pid)) return { ...base, ok: true, ...detail }
  return {
    ...base,
    ok: false,
    code: 'still_alive',
    message: `SIGTERM 后 ${TERM_WAIT_MS / 1000} 秒 pid ${target.pid} 仍在，按约定不升级 SIGKILL`,
    ...detail
  }
}

async function readTable(ops: SignalOps): Promise<PsRow[] | { error: Error }> {
  try {
    return parseProcessTable(await ops.listProcesses())
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(messageOf(error)) }
  }
}

/**
 * Fallback close by CLI `--resume=` / `--session-id=` flags when `agent_session_records`
 * is unreadable or has no record for a CLI-id-carrying session.
 */
export async function stopSessionWithSignal(options: {
  workspaceId: string
  workspacePath?: string | null
  sessionId: string
  dryRun: boolean
  ops: SignalOps
  preloadedRecords?: readonly SessionRecord[]
  preloadedDbError?: string | null
}): Promise<CloseOutcome> {
  const { workspaceId, workspacePath, sessionId, dryRun, ops } = options
  const base: SignalBase = { workspaceId, sessionId, how: 'signal', dryRun }

  const notes: string[] = []

  const table = await readTable(ops)
  if ('error' in table) {
    return { ...base, ok: false, code: 'ps_failed', message: `读进程表失败：${messageOf(table.error)}` }
  }

  let records: readonly SessionRecord[] = []
  if (options.preloadedRecords !== undefined) {
    records = options.preloadedRecords
  } else if (options.preloadedDbError !== undefined) {
    if (options.preloadedDbError) notes.push(`读会话数据库失败：${options.preloadedDbError}`)
  } else {
    try {
      records = await ops.listSessionRecords()
    } catch (error) {
      // Without the chain only the id the row carries can be matched; the refusal names why.
      notes.push(`读会话数据库失败：${messageOf(error)}`)
    }
  }
  const candidates = sessionCandidates(records, sessionId, workspaceId, workspacePath ?? null)

  const ownPgid = await ops.ownPgid().catch(() => null)
  const found = findAgentTargetAmong(table, candidates.length > 0 ? candidates : [sessionId], ownPgid)

  if (!found.ok) {
    const notesText = notes.length > 0 ? `；${notes.join('；')}` : ''
    return { ...base, ok: false, code: found.code, message: `${found.message}${notesText}` }
  }

  const detail = {
    sessionUuid: found.providerId,
    pid: found.target.pid,
    pgid: found.target.pgid,
    parentArgs: found.target.parentCommand
  }
  if (dryRun) return { ...base, ok: true, ...detail }

  const outcome = await signalAndWait(base, found.target, ops)
  return { ...detail, ...outcome }
}

/**
 * Stops a chat session after re-reading `agent_session_records` and `ps -Ao pid,ppid,pgid,lstart,command`
 * to defeat TOCTOU races and PID reuse. Verifies:
 * - unique record lookup (canonical id -> nativeId -> chainIds, narrowed by workspace),
 * - `claimStatus === 'live'`, `!unreconciled`, `ownerProcess.hostId === 'local'`,
 * - `ownerProcess.pid === expectedPid` when `expectedPid` was supplied,
 * - `findAgentTargetByLease` (orca-provider-exec parent, matching kind, pgid === pid,
 *   not worker pgid, and `lstart` within ±2000ms of `ownerProcess.processStartTimeMs`).
 * Falls back to `stopSessionWithSignal` only when the DB is unreadable or has no record and the
 * session identifier is a non-path id that a CLI flag could carry.
 */
export async function stopSessionByLease(options: {
  workspaceId: string
  workspacePath?: string | null
  sessionId: string
  expectedAgent?: string | null
  expectedPid?: number | null
  dryRun: boolean
  ops: SignalOps
}): Promise<CloseOutcome> {
  const { workspaceId, workspacePath, sessionId, expectedAgent, expectedPid, dryRun, ops } = options
  const base: SignalBase = { workspaceId, sessionId, how: 'signal', dryRun }

  let records: SessionRecord[]
  try {
    records = await ops.listSessionRecords()
  } catch (error) {
    const dbError = messageOf(error)
    if (expectedPid == null && !isFilePath(sessionId)) {
      return stopSessionWithSignal({
        workspaceId,
        workspacePath,
        sessionId,
        dryRun,
        ops,
        preloadedDbError: dbError
      })
    }
    return { ...base, ok: false, code: 'db_failed', message: `读会话数据库失败：${dbError}` }
  }

  const lookup = findSessionRecord(records, sessionId, workspaceId, workspacePath ?? null)
  if (lookup.status === 'ambiguous') {
    return {
      ...base,
      ok: false,
      code: 'ambiguous',
      message: `会话数据库里 ${sessionId} 命中 ${lookup.records.length} 条记录，不敢猜要关哪一个`
    }
  }
  if (lookup.status === 'not_found') {
    if (expectedPid == null && !isFilePath(sessionId)) {
      return stopSessionWithSignal({
        workspaceId,
        workspacePath,
        sessionId,
        dryRun,
        ops,
        preloadedRecords: records
      })
    }
    return {
      ...base,
      ok: false,
      code: 'no_record',
      message: '会话数据库里找不到这条会话的租约记录，拒绝盲杀'
    }
  }

  const { record } = lookup
  if (record.unreconciled) {
    return {
      ...base,
      ok: false,
      code: 'lease_unreconciled',
      message: '这条会话的租约处于未对账状态（unreconciled），拒绝关闭'
    }
  }
  if (record.claimStatus !== 'live' || record.ownerProcess === null) {
    return {
      ...base,
      ok: false,
      code: 'lease_not_live',
      message: `会话租约状态为 ${record.claimStatus ?? '未知'}，没有活跃进程可关`
    }
  }
  if (record.ownerProcess.hostId !== 'local') {
    return {
      ...base,
      ok: false,
      code: 'remote_host',
      message: `该会话运行在远端宿主机（${record.ownerProcess.hostId}），不支持本地发信号`
    }
  }
  if (expectedPid !== null && expectedPid !== undefined && record.ownerProcess.pid !== expectedPid) {
    return {
      ...base,
      ok: false,
      code: 'process_changed',
      message: `会话进程已变化（期望 pid ${expectedPid}，当前租约是 pid ${record.ownerProcess.pid}），刷新确认后再关`
    }
  }

  const table = await readTable(ops)
  if ('error' in table) {
    return { ...base, ok: false, code: 'ps_failed', message: `读进程表失败：${messageOf(table.error)}` }
  }

  const ownPgid = await ops.ownPgid().catch(() => null)
  const expectedKind = expectedAgent && expectedAgent !== 'unknown' ? expectedAgent : record.provider
  const found = findAgentTargetByLease(table, record.ownerProcess, expectedKind, ownPgid)
  if (!found.ok) {
    return { ...base, ok: false, code: found.code, message: found.message }
  }

  const sessionUuid = parseProviderId(found.target.command)
  const detail = {
    ...(sessionUuid ? { sessionUuid } : {}),
    pid: found.target.pid,
    pgid: found.target.pgid,
    parentArgs: found.target.parentCommand
  }
  if (dryRun) return { ...base, ok: true, ...detail }

  const outcome = await signalAndWait(base, found.target, ops)
  return { ...detail, ...outcome }
}
