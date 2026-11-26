import { messageOf } from './errors'
import type { CloseOutcome } from './protocol'
import { findClaudeTargetAmong, parseProcessTable } from './processTable'
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

/**
 * Stops a chat session by SIGTERM-ing the claude process group that runs it. The session's own id
 * and every id in its stored handle chain are candidates, so a rewind that moved the process to
 * a new conversation id still reaches it. Nothing is signalled unless the process is the
 * `.local/bin/claude` started by `orca-provider-exec`, is its own process group, and (with
 * `dryRun`) nothing is signalled at all — it only reports what it found. A TERM that does not
 * take the process down in five seconds is reported as a failure; this never escalates to SIGKILL.
 */
export async function stopSessionWithSignal(options: {
  workspaceId: string
  sessionId: string
  dryRun: boolean
  ops: SignalOps
}): Promise<CloseOutcome> {
  const { workspaceId, sessionId, dryRun, ops } = options
  const base = { workspaceId, sessionId, how: 'signal' as const, dryRun }

  const notes: string[] = []

  let table
  try {
    table = parseProcessTable(await ops.listProcesses())
  } catch (error) {
    return { ...base, ok: false, code: 'ps_failed', message: `读进程表失败：${messageOf(error)}` }
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
  const found = findClaudeTargetAmong(table, candidates.length > 0 ? candidates : [sessionId], ownPgid)

  if (!found.ok) {
    const notesText = notes.length > 0 ? `；${notes.join('；')}` : ''
    return { ...base, ok: false, code: found.code, message: `${found.message}${notesText}` }
  }

  const { target, providerId } = found
  const detail = {
    sessionUuid: providerId,
    pid: target.pid,
    pgid: target.pgid,
    parentArgs: target.parentCommand
  }

  if (dryRun) return { ...base, ok: true, ...detail }

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