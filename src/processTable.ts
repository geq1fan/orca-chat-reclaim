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

/** The CLI Orca runs for a chat session. */
export const CLAUDE_PATH_SUFFIX = '/.local/bin/claude'
/** The wrapper Orca puts between the CLI and the daemon; the CLI's parent must be this. */
export const PROVIDER_EXEC = 'orca-provider-exec'

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

function isClaudeRow(row: PsRow, flag: RegExp): boolean {
  const [binary] = row.command.split(/\s+/)
  return binary.endsWith(CLAUDE_PATH_SUFFIX) && flag.test(row.command)
}

/** Whether any claude process runs this provider id, both flag forms included. */
export function hasClaudeProcess(rows: readonly PsRow[], providerId: string): boolean {
  const flag = providerFlag(providerId)
  return rows.some((row) => isClaudeRow(row, flag))
}

/**
 * The first candidate id a live claude process carries, or null when none of them does. A row's
 * candidates are every id its session may run under, so a stale id does not hide a live one.
 */
export function findRunningProcessId(rows: readonly PsRow[], candidates: readonly string[]): string | null {
  for (const id of candidates) {
    if (hasClaudeProcess(rows, id)) return id
  }
  return null
}

export type ClaudeTarget = {
  pid: number
  ppid: number
  pgid: number
  command: string
  parentCommand: string
}

export type TargetLookup =
  | { ok: true; target: ClaudeTarget }
  | {
      ok: false
      code: 'no_process' | 'ambiguous' | 'no_parent' | 'not_group_leader' | 'own_group'
      message: string
    }

/**
 * The claude process that runs `providerId`: a `.local/bin/claude` whose args carry
 * `--resume=<id>` or `--session-id=<id>`, started by `orca-provider-exec`, and its own
 * process-group leader so `kill(-pgid)` reaches exactly this session and its children.
 */
export function findClaudeTarget(
  rows: readonly PsRow[],
  providerId: string,
  ownPgid: number | null = null
): TargetLookup {
  const flag = providerFlag(providerId)
  const candidates = rows.filter((row) => isClaudeRow(row, flag))

  if (candidates.length === 0) {
    return {
      ok: false,
      code: 'no_process',
      message: `没有找到运行中的进程：--resume= 和 --session-id= 都没有匹配到 ${providerId}`
    }
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      code: 'ambiguous',
      message: `有 ${candidates.length} 个进程都在跑 ${providerId}（pid ${candidates.map((row) => row.pid).join(', ')}），不敢猜要杀哪一个`
    }
  }

  const target = candidates[0]
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

type TargetRefusal = Extract<TargetLookup, { ok: false }>

export type CandidateTarget =
  | { ok: true; target: ClaudeTarget; providerId: string }
  | { ok: false; code: TargetRefusal['code']; message: string }

/**
 * The one claude process that runs any of a session's candidate ids. Safety checks are the same
 * as `findClaudeTarget`; when two candidates each name a live process, either one would be a
 * guess, so the lookup refuses instead of picking.
 */
export function findClaudeTargetAmong(
  rows: readonly PsRow[],
  candidates: readonly string[],
  ownPgid: number | null = null
): CandidateTarget {
  const refusals: Extract<TargetLookup, { ok: false }>[] = []
  let matched: { target: ClaudeTarget; providerId: string } | null = null

  for (const id of candidates) {
    const found = findClaudeTarget(rows, id, ownPgid)
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