/** One row of `ps -Ao pid,ppid,pgid,command`. */
export type PsRow = { pid: number; ppid: number; pgid: number; command: string }

/** Args are not quoted, so the command is everything after the third number. */
export function parseProcessTable(output: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*)$/.exec(line)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4]
    })
  }
  return rows
}

/** The wrapper Orca puts between itself and an agent CLI; the CLI's parent is this. */
export const PROVIDER_EXEC = 'orca-provider-exec'

/**
 * Executables Orca runs under `orca-provider-exec`, named the way `agents.list` names the agent.
 * An executable not listed here is its own kind (the binary name), so a new agent shows up
 * without a code change.
 */
const KIND_BY_BINARY: Record<string, string> = {
  claude: 'claude',
  agy: 'antigravity',
  pi: 'pi',
  codex: 'codex'
}

/**
 * Agent kinds whose CLI takes a conversation id (`--resume=` / `--session-id=`). A live process
 * of the kind is evidence enough; this list covers the case where none is running, so a plain
 * miss is not described as "this agent has no ids".
 */
const ID_KINDS = new Set(['claude', 'pi', 'codex'])

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * How Orca names a chat session on the CLI: a new conversation starts with `--session-id=`,
 * a resumed one carries `--resume=`. Both carry the session's provider id.
 */
function providerFlag(providerId: string): RegExp {
  return new RegExp(`(?:^|\\s)--(?:resume|session-id)=${escapeRegExp(providerId)}(?=\\s|$)`)
}

/** The id an agent CLI's arguments carry, or null when the CLI is given none. */
export function parseProviderId(command: string): string | null {
  return /(?:^|\s)--(?:resume|session-id)=(\S+)(?=\s|$)/.exec(command)?.[1] ?? null
}

/** The executable a wrapper runs: the first argument after its standalone ` -- `. */
function wrapperBinary(command: string): string | null {
  return /(?:^|\s)--\s+(\S+)/.exec(command)?.[1] ?? null
}

function binaryName(path: string): string {
  return path.split('/').pop() ?? path
}

function binaryKind(binary: string): string {
  const name = binaryName(binary)
  return KIND_BY_BINARY[name] ?? name
}

/** One process Orca runs for a chat session. */
export type AgentProcess = {
  row: PsRow
  /** The executable that runs the agent, e.g. `/Users/me/.local/bin/agy`. */
  binary: string
  /** The `agents.list` agent kind, e.g. `antigravity` for `agy`. */
  kind: string
  /** The conversation id its arguments carry; null for agents that take none. */
  providerId: string | null
}

/**
 * Every process Orca runs for a chat session: a direct child of an `orca-provider-exec` wrapper
 * that runs the executable the wrapper was given. Wrappers themselves are skipped, so the second
 * provider-exec a CLI starts for itself never counts as an agent.
 */
export function agentProcesses(rows: readonly PsRow[]): AgentProcess[] {
  const wrappers = new Map<number, string>()
  for (const row of rows) {
    if (!row.command.includes(PROVIDER_EXEC)) continue
    const binary = wrapperBinary(row.command)
    if (binary) wrappers.set(row.pid, binary)
  }

  const processes: AgentProcess[] = []
  for (const row of rows) {
    const binary = wrappers.get(row.ppid)
    if (!binary) continue
    const [ownBinary] = row.command.split(/\s+/)
    // The wrapper's tail and the child's argv[0] name the same program; a path spelling
    // difference (symlink, relative path) must not hide the session.
    if (binaryName(ownBinary) !== binaryName(binary)) continue
    processes.push({ row, binary, kind: binaryKind(binary), providerId: parseProviderId(row.command) })
  }
  return processes
}

/** Whether this agent kind is known to put a conversation id on its command line. */
export function providesSessionId(kind: string, processes: readonly AgentProcess[]): boolean {
  return ID_KINDS.has(kind) || processes.some((process) => process.kind === kind && process.providerId !== null)
}

/**
 * Rows that carry `providerId` but were not started by a wrapper: a CLI resumed outside Orca,
 * or a wrapper whose child runs a different executable. They still name the session, and the
 * target gates below refuse anything unsafe, so keeping them lets a miss be explained instead
 * of only reported as absent.
 */
function unwrappedFlags(rows: readonly PsRow[], providerId: string): AgentProcess[] {
  const flag = providerFlag(providerId)
  return rows.flatMap((row) => {
    if (row.command.includes(PROVIDER_EXEC) || !flag.test(row.command)) return []
    const [binary] = row.command.split(/\s+/)
    return [{ row, binary, kind: binaryKind(binary), providerId }]
  })
}

/**
 * The first candidate id a live agent process carries, or null when none of them does. A row's
 * candidates are every id its session may run under, so a stale id does not hide a live one.
 */
export function findRunningProcessId(rows: readonly PsRow[], candidates: readonly string[]): string | null {
  const processes = agentProcesses(rows)
  for (const id of candidates) {
    if (processes.some((process) => process.providerId === id)) return id
    if (unwrappedFlags(rows, id).length > 0) return id
  }
  return null
}

export type AgentTarget = {
  pid: number
  ppid: number
  pgid: number
  command: string
  parentCommand: string
}

export type TargetLookup =
  | { ok: true; target: AgentTarget }
  | {
      ok: false
      code: 'no_process' | 'ambiguous' | 'no_parent' | 'not_group_leader' | 'own_group' | 'kind_mismatch'
      message: string
    }

/**
 * The safety gates every kill target passes: started by `orca-provider-exec`, its own process
 * group (so `kill(-pgid)` reaches exactly this session and its children), and not the worker's.
 */
function validateTarget(
  rows: readonly PsRow[],
  process: AgentProcess,
  ownPgid: number | null
): TargetLookup {
  const target = process.row
  const parent = rows.find((row) => row.pid === target.ppid)
  const parentName = parent?.command.split(/\s+/)[0] ?? '未知进程'
  if (!parent || !parent.command.includes(PROVIDER_EXEC)) {
    return {
      ok: false,
      code: 'no_parent',
      message: `pid ${target.pid} 的父进程是 ${parentName}（ppid ${target.ppid}），不是 ${PROVIDER_EXEC}`
    }
  }
  if (target.pgid !== target.pid) {
    return {
      ok: false,
      code: 'not_group_leader',
      message: `pid ${target.pid} 的 pgid 是 ${target.pgid}，不是自成进程组，杀组会误伤别的进程`
    }
  }
  if (ownPgid !== null && target.pgid === ownPgid) {
    return {
      ok: false,
      code: 'own_group',
      message: `pid ${target.pid} 和插件 worker 同属进程组 ${ownPgid}，拒绝`
    }
  }

  return {
    ok: true,
    target: {
      pid: target.pid,
      ppid: target.ppid,
      pgid: target.pgid,
      command: target.command,
      parentCommand: parent.command
    }
  }
}

/**
 * The agent process that runs `providerId`, whatever agent kind it is: its args carry
 * `--resume=<id>` or `--session-id=<id>`, it was started by `orca-provider-exec`, and it is its
 * own process-group leader.
 */
export function findAgentTarget(
  rows: readonly PsRow[],
  providerId: string,
  ownPgid: number | null = null
): TargetLookup {
  const candidates = agentProcesses(rows).filter((process) => process.providerId === providerId)
  const found = candidates.length > 0 ? candidates : unwrappedFlags(rows, providerId)

  if (found.length === 0) {
    return {
      ok: false,
      code: 'no_process',
      message: `没有找到运行中的进程：--resume= 和 --session-id= 都没有匹配到 ${providerId}`
    }
  }
  if (found.length > 1) {
    return {
      ok: false,
      code: 'ambiguous',
      message: `有 ${found.length} 个进程都在跑 ${providerId}（pid ${found.map((process) => process.row.pid).join(', ')}），不敢猜要杀哪一个`
    }
  }
  return validateTarget(rows, found[0], ownPgid)
}

type TargetRefusal = Extract<TargetLookup, { ok: false }>

export type CandidateTarget =
  | { ok: true; target: AgentTarget; providerId: string }
  | { ok: false; code: TargetRefusal['code']; message: string }

/**
 * The one agent process that runs any of a session's candidate ids. Safety checks are the same
 * as `findAgentTarget`; when two candidates each name a live process, either one would be a
 * guess, so the lookup refuses instead of picking.
 */
export function findAgentTargetAmong(
  rows: readonly PsRow[],
  candidates: readonly string[],
  ownPgid: number | null = null
): CandidateTarget {
  const refusals: TargetRefusal[] = []
  let matched: { target: AgentTarget; providerId: string } | null = null

  for (const id of candidates) {
    const found = findAgentTarget(rows, id, ownPgid)
    if (!found.ok) {
      refusals.push(found)
      continue
    }
    if (matched && matched.target.pid !== found.target.pid) {
      return {
        ok: false,
        code: 'ambiguous',
        message: `两个候选 id 各命中一个进程（pid ${matched.target.pid}、${found.target.pid}），不敢猜要杀哪一个`
      }
    }
    matched ??= { target: found.target, providerId: id }
  }

  if (matched) return { ok: true, ...matched }
  // A safety refusal says more than "no process": surface it before the plain miss.
  const informative = refusals.find((refusal) => refusal.code !== 'no_process')
  const refusal = informative ?? refusals[0]
  if (refusal) return { ok: false, code: refusal.code, message: refusal.message }
  return { ok: false, code: 'no_process', message: '没有找到运行中的进程' }
}

/**
 * The agent process a session was paired to by kind, for agents whose CLI takes no session id.
 * Only structurally safe targets pass: the pid must be an agent process of exactly this kind
 * (so a mixed-up pairing can never kill another kind's process), its own group, not ours.
 */
export function findAgentTargetByPid(
  rows: readonly PsRow[],
  pid: number,
  kind: string,
  ownPgid: number | null = null
): TargetLookup {
  const found = agentProcesses(rows).find((process) => process.row.pid === pid)
  if (!found) {
    return {
      ok: false,
      code: 'no_process',
      message: `pid ${pid} 不是 ${PROVIDER_EXEC} 拉起的 agent 进程，可能已经退出`
    }
  }
  if (found.kind !== kind) {
    return {
      ok: false,
      code: 'kind_mismatch',
      message: `pid ${pid} 跑的是 ${found.kind}，不是这个会话的 agent（${kind}），拒绝`
    }
  }
  return validateTarget(rows, found, ownPgid)
}