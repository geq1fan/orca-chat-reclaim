import { messageOf } from './errors'
import type { CloseOutcome } from './protocol'
import { findClaudeTarget, parseProcessTable, type ClaudeTarget } from './processTable'
import { nativeSessionId } from './sessionRecord'

/** Everything `stopSessionWithSignal` needs from the machine; tests pass fakes. */
export type SignalOps = {
  /** The stored `providerHandleChain` JSON for an Orca session id, or null when there is none. */
  readHandleChain(sessionId: string): Promise<string | null>
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
 * Stops a chat session by SIGTERM-ing the claude process group that runs it. Nothing is signalled
 * unless the process is the `.local/bin/claude` started by `orca-provider-exec`, is its own
 * process group, and (with `dryRun`) nothing is signalled at all — it only reports what it found.
 * A TERM that does not take the process down in five seconds is reported as a failure; this never
 * escalates to SIGKILL.
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

  const ownPgid = await ops.ownPgid().catch(() => null)

  // The id `agents.list` reports is already the provider id, so try it against `ps` first;
  // only when nothing carries it is the stored session record worth a sqlite read.
  let matched: { target: ClaudeTarget; providerId: string } | null = null
  let refusal: { code: string; message: string } | null = null

  const direct = findClaudeTarget(table, sessionId, ownPgid)
  if (direct.ok) {
    matched = { target: direct.target, providerId: sessionId }
  } else {
    refusal = { code: direct.code, message: direct.message }
  }

  if (!direct.ok && direct.code === 'no_process') {
    let fromRecord: string | null = null
    try {
      fromRecord = nativeSessionId(await ops.readHandleChain(sessionId))
    } catch (error) {
      notes.push(`读会话数据库失败：${messageOf(error)}`)
    }
    if (fromRecord && fromRecord !== sessionId) {
      const fallback = findClaudeTarget(table, fromRecord, ownPgid)
      if (fallback.ok) matched = { target: fallback.target, providerId: fromRecord }
      else refusal = { code: fallback.code, message: fallback.message }
    }
  }

  if (!matched) {
    const notesText = notes.length > 0 ? `；${notes.join('；')}` : ''
    return {
      ...base,
      ok: false,
      code: refusal?.code ?? 'no_process',
      message: `${refusal?.message ?? '没有找到运行中的进程'}${notesText}`
    }
  }

  const { target, providerId } = matched
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