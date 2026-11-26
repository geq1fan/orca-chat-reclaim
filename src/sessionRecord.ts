/**
 * The claude conversation id inside a stored session record: the last `providerHandleChain`
 * entry that carries `handle.sessionId`. `chainJson` is the JSON `json_extract` returns for that
 * array, or null when the session has no record.
 */
export function nativeSessionId(chainJson: string | null): string | null {
  if (!chainJson) return null
  let chain: unknown
  try {
    chain = JSON.parse(chainJson)
  } catch {
    return null
  }
  if (!Array.isArray(chain)) return null
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const entry = chain[index] as { handle?: { sessionId?: unknown } } | null
    const sessionId = entry?.handle?.sessionId
    if (typeof sessionId === 'string' && sessionId.length > 0) return sessionId
  }
  return null
}