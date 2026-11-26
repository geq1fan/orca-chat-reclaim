/**
 * One stored Orca agent session: the Orca session id (the key) and every claude conversation id
 * its `providerHandleChain` ever carried. A resumed conversation keeps the old ids in the chain
 * after a rewind forks it, so the row Orca reports may name an id the live process no longer uses.
 */
export type SessionRecord = {
  sessionId: string
  /** Every `handle.sessionId` in the chain, oldest first, without repeats. */
  chainIds: string[]
}

/** Every `handle.sessionId` in a stored `providerHandleChain` JSON. */
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
    const sessionId = (entry as { handle?: { sessionId?: unknown } } | null)?.handle?.sessionId
    if (typeof sessionId === 'string' && sessionId.length > 0 && !ids.includes(sessionId)) {
      ids.push(sessionId)
    }
  }
  return ids
}

/**
 * The ids a session may run under: the id Orca reported for the row, the record's own Orca id,
 * and every conversation id in that record's chain. The record is found by either id, so a row
 * that carries a stale provider id still reaches the process its current chain names.
 */
export function sessionCandidates(records: readonly SessionRecord[], rowId: string | null): string[] {
  if (!rowId) return []
  const ids = new Set<string>([rowId])
  for (const record of records) {
    if (record.sessionId === rowId || record.chainIds.includes(rowId)) {
      ids.add(record.sessionId)
      for (const id of record.chainIds) ids.add(id)
    }
  }
  return [...ids]
}

/**
 * Answers short conversation ids under every alias of the record they belong to, so a row that
 * shows a provider id can look its title up with that same id.
 */
export function aliasTitles(
  titles: Record<string, string>,
  records: readonly SessionRecord[]
): Record<string, string> {
  const aliased: Record<string, string> = { ...titles }
  for (const record of records) {
    const title = aliased[record.sessionId]
    if (!title) continue
    for (const id of record.chainIds) {
      if (!aliased[id]) aliased[id] = title
    }
  }
  return aliased
}