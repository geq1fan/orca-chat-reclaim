import { messageOf } from './errors'
import type { CloseOutcome } from './protocol'
import {
  findAgentTargetAmong,
  findAgentTargetByPid,
  parseProcessTable,
  type AgentTarget,
  type PsRow
} from './processTable'
import { sessionCandidates, type SessionRecord } from './sessionRecord'

/** Everything `stopSessionWithSignal` needs from the machine; tests pass fakes. */
export type SignalOps = {
  /** Every stored Orca session with the conversation ids in its handle chain. */
  listSessionRecords(): Promise<SessionRecord[]>
  /** `ps -Ao pid,ppid,pgid,command` output. */
  listProcesses(): Promise<string>
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
 * Stops a chat session by SIGTERM-ing the agent process group that runs it. The session's own id
 * and every id in its stored handle chain are candidates, so a rewind that moved the process to
 * a new conversation id still reaches it. Nothing is signalled unless the process was started by
 * `orca-provider-exec`, is its own process group, and (with `dryRun`) nothing is signalled at
 * all — it only reports what it found. A TERM that does not take the process down in five
 * seconds is reported as a failure; this never escalates to SIGKILL.
 */
export async function stopSessionWithSignal(options: {
  workspaceId: string
  sessionId: string
  dryRun: boolean
  ops: SignalOps
}): Promise<CloseOutcome> {
  const { workspaceId, sessionId, dryRun, ops } = options
  const base: SignalBase = { workspaceId, sessionId, how: 'signal', dryRun }

  const notes: string[] = []

  const table = await readTable(ops)
  if ('error' in table) {
    return { ...base, ok: false, code: 'ps_failed', message: `读进程表失败：${messageOf(table.error)}` }
  }

  let records: SessionRecord[] = []
  try {
    records = await ops.listSessionRecords()
  } catch (error) {
    // Without the chain only the id the row carries can be matched; the refusal names why.
    notes.push(`读会话数据库失败：${messageOf(error)}`)
  }
  const candidates = sessionCandidates(records, sessionId)

  const ownPgid = await ops.ownPgid().catch(() => null)
  const found = findAgentTargetAmong(table, candidates.length > 0 ? candidates : [sessionId], ownPgid)

  if (!found.ok) {
    const notesText = notes.length > 0 ? `；${notes.join('；')}` : ''
    return { ...base, ok: false, code: found.code, message: `${found.message}${notesText}` }
  }

  const detail = { sessionUuid: found.providerId, pid: found.target.pid, pgid: found.target.pgid, parentArgs: found.target.parentCommand }
  if (dryRun) return { ...base, ok: true, ...detail }

  const outcome = await signalAndWait(base, found.target, ops)
  return { ...detail, ...outcome }
}

/**
 * Stops a chat session of an agent that puts no session id on its command line. The target is
 * the pid its kind was paired to at read time; `findAgentTargetByPid` still refuses anything
 * that is no longer an agent process of exactly that kind, so a stale or mixed-up pairing cannot
 * reach a different agent's process.
 */
export async function stopPairedSession(options: {
  workspaceId: string
  sessionId: string
  /** The agent kind the pairing was made for. */
  agent: string
  pid: number
  dryRun: boolean
  ops: SignalOps
}): Promise<CloseOutcome> {
  const { workspaceId, sessionId, agent, pid, dryRun, ops } = options
  const base: SignalBase = { workspaceId, sessionId, how: 'signal', dryRun }

  const table = await readTable(ops)
  if ('error' in table) {
    return { ...base, ok: false, code: 'ps_failed', message: `读进程表失败：${messageOf(table.error)}` }
  }

  const ownPgid = await ops.ownPgid().catch(() => null)
  const found = findAgentTargetByPid(table, pid, agent, ownPgid)
  if (!found.ok) return { ...base, ok: false, code: found.code, message: found.message }

  const detail = { pid: found.target.pid, pgid: found.target.pgid, parentArgs: found.target.parentCommand }
  if (dryRun) return { ...base, ok: true, ...detail }

  const outcome = await signalAndWait(base, found.target, ops)
  return { ...detail, ...outcome }
}