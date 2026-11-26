/**
 * Stored Orca agent session metadata and authoritative lease read from `agent_session_records`.
 * `claimStatus === 'live'` records carry `ownerProcess` (the direct child pid under
 * `orca-provider-exec` and its start time in ms), eliminating heuristic directory guessing.
 */
export type LeaseClaimStatus = 'live' | 'released' | 'reserved' | 'conflicted'

export type OwnerProcess = {
  hostId: string
  pid: number
  processStartTimeMs: number | null
  spawnToken: string | null
  runtime: string | null
}

export type SessionRecord = {
  sessionId: string
  /** The native id or file path the record adopted (`adopted_native_id`). */
  nativeId: string | null
  /** Every conversation id in `providerHandleChain`, oldest first, without repeats. */
  chainIds: string[]
  provider: string | null
  workspaceId: string | null
  hostId: string | null
  conversationName: string | null
  claimStatus: LeaseClaimStatus | null
  unreconciled: boolean
  ownerProcess: OwnerProcess | null
  deathKind: string | null
}

export type SessionRecordLookup =
  | { status: 'found'; record: SessionRecord }
  | { status: 'not_found' }
  | { status: 'ambiguous'; records: SessionRecord[] }

const VALID_CLAIM_STATUSES = new Set<LeaseClaimStatus>(['live', 'released', 'reserved', 'conflicted'])

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function parseClaimStatus(raw: unknown): LeaseClaimStatus | null {
  return typeof raw === 'string' && VALID_CLAIM_STATUSES.has(raw as LeaseClaimStatus)
    ? (raw as LeaseClaimStatus)
    : null
}

export function parseSqliteBool(raw: unknown): boolean {
  return raw === true || raw === 1 || raw === '1' || raw === 'true'
}

export function parseOwnerProcess(raw: unknown): OwnerProcess | null {
  if (raw === null || raw === undefined) return null
  let value: unknown = raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return null
    try {
      value = JSON.parse(trimmed)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  const hostId = nonEmptyString(obj.hostId)
  const pid = obj.pid
  if (!hostId || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  const processStartTimeMs =
    typeof obj.processStartTimeMs === 'number' && Number.isFinite(obj.processStartTimeMs)
      ? obj.processStartTimeMs
      : null
  return {
    hostId,
    pid,
    processStartTimeMs,
    spawnToken: nonEmptyString(obj.spawnToken),
    runtime: nonEmptyString(obj.runtime)
  }
}

export function parseSessionRecordRow(row: Record<string, unknown>): SessionRecord | null {
  const sessionId = nonEmptyString(row.session_id)
  if (!sessionId) return null
  const chain = typeof row.chain === 'string' ? row.chain : null
  return {
    sessionId,
    nativeId: nonEmptyString(row.adopted_native_id),
    chainIds: chainSessionIds(chain),
    provider: nonEmptyString(row.provider),
    workspaceId: nonEmptyString(row.workspace_id),
    hostId: nonEmptyString(row.host_id),
    conversationName: nonEmptyString(row.conversation_name),
    claimStatus: parseClaimStatus(row.claim_status),
    unreconciled: parseSqliteBool(row.unreconciled),
    ownerProcess: parseOwnerProcess(row.owner_process),
    deathKind: nonEmptyString(row.death_kind)
  }
}

/**
 * Extracts the filesystem path suffix from Orca's `<repoId>::/abs/path` worktree id format,
 * or returns null for folder/identity workspace ids without `::`.
 */
export function extractWorktreePath(workspaceId: string | null): string | null {
  if (!workspaceId) return null
  const idx = workspaceId.indexOf('::')
  if (idx === -1) return null
  const path = workspaceId.slice(idx + 2)
  return path.length > 0 ? path : null
}

/**
 * Every conversation id a stored `providerHandleChain` JSON names. Claude-style handles carry
 * `sessionId`; acp and jsonl-rpc handles carry `nativeId` (antigravity, pi).
 */
export function chainSessionIds(chainJson: string | null): string[] {
  if (!chainJson) return []
  let chain: unknown
  try {
    chain = JSON.parse(chainJson)
  } catch {
    return []
  }
  if (!Array.isArray(chain)) return []
  const ids: string[] = []
  for (const entry of chain) {
    const handle = (entry as { handle?: Record<string, unknown> } | null)?.handle
    for (const key of ['sessionId', 'nativeId', 'threadId']) {
      const sessionId = handle?.[key]
      if (typeof sessionId === 'string' && sessionId.length > 0 && !ids.includes(sessionId)) {
        ids.push(sessionId)
      }
    }
  }
  return ids
}

function narrowMatches(
  matches: readonly SessionRecord[],
  workspaceId: string | null,
  workspacePath: string | null
): SessionRecordLookup {
  if (matches.length === 1) return { status: 'found', record: matches[0] }
  if (workspaceId) {
    const byId = matches.filter((record) => record.workspaceId === workspaceId)
    if (byId.length === 1) return { status: 'found', record: byId[0] }
    if (byId.length === 0 && workspacePath) {
      const byPath = matches.filter((record) => extractWorktreePath(record.workspaceId) === workspacePath)
      if (byPath.length === 1) return { status: 'found', record: byPath[0] }
    }
  } else if (workspacePath) {
    const byPath = matches.filter((record) => extractWorktreePath(record.workspaceId) === workspacePath)
    if (byPath.length === 1) return { status: 'found', record: byPath[0] }
  }
  return { status: 'ambiguous', records: [...matches] }
}

/**
 * Looks up a `SessionRecord` by strict priority:
 * 1. exact `sessionId` (Orca primary key),
 * 2. exact `nativeId` (`adopted_native_id`),
 * 3. `chainIds.includes(id)`.
 * If the matched tier hits multiple records, narrows by `workspaceId` (or `workspacePath` for
 * `<repoId>::<path>` worktrees); if still non-unique, returns `ambiguous` instead of guessing.
 */
export function findSessionRecord(
  records: readonly SessionRecord[],
  id: string | null,
  workspaceId: string | null = null,
  workspacePath: string | null = null
): SessionRecordLookup {
  if (!id) return { status: 'not_found' }
  const tiers: SessionRecord[][] = [
    records.filter((record) => record.sessionId === id),
    records.filter((record) => record.nativeId === id),
    records.filter((record) => record.chainIds.includes(id))
  ]
  for (const matches of tiers) {
    if (matches.length > 0) return narrowMatches(matches, workspaceId, workspacePath)
  }
  return { status: 'not_found' }
}

/**
 * The candidate ids a session may carry on its CLI (`--resume=` / `--session-id=`): `rowId` plus
 * all ids of the uniquely matched `SessionRecord`.
 */
export function sessionCandidates(
  records: readonly SessionRecord[],
  rowId: string | null,
  workspaceId: string | null = null,
  workspacePath: string | null = null
): string[] {
  if (!rowId) return []
  const ids = new Set<string>([rowId])
  const lookup = findSessionRecord(records, rowId, workspaceId, workspacePath)
  if (lookup.status === 'found') {
    const { record } = lookup
    ids.add(record.sessionId)
    if (record.nativeId) ids.add(record.nativeId)
    for (const id of record.chainIds) ids.add(id)
  }
  return [...ids]
}

/**
 * Answers conversation ids under every alias of the record they belong to, so a row that shows
 * a provider id can look its title up with that same id.
 */
export function aliasTitles(
  titles: Record<string, string>,
  records: readonly Pick<SessionRecord, 'sessionId' | 'nativeId' | 'chainIds'>[]
): Record<string, string> {
  const aliased: Record<string, string> = { ...titles }
  for (const record of records) {
    const title =
      aliased[record.sessionId] ??
      (record.nativeId ? aliased[record.nativeId] : undefined) ??
      record.chainIds.map((id) => aliased[id]).find((value) => value !== undefined)
    if (!title) continue
    const ids = [record.sessionId, ...(record.nativeId ? [record.nativeId] : []), ...record.chainIds]
    for (const id of ids) {
      if (!aliased[id]) aliased[id] = title
    }
  }
  return aliased
}
