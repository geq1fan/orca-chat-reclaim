/**
 * Chat titles live only in Orca's own CLI (`orca bot chats`), and its ids are Orca session ids
 * while `agents.list` reports the provider's. The session database ties the two together, so the
 * map answers for whichever id a row carries.
 */
export type ChatTitleOps = {
  /** Every bot on this machine; a chat can belong to any of them. */
  bots(): Promise<string[]>
  chats(bot: string): Promise<{ id: string; title: string }[]>
  /** Orca session id ↔ provider session id, from `agent_session_records`. */
  sessionPairs(): Promise<{ sessionId: string; nativeId: string }[]>
}

export async function buildTitleMap(ops: ChatTitleOps): Promise<Record<string, string>> {
  const titles: Record<string, string> = {}

  let bots: string[] = []
  try {
    bots = await ops.bots()
  } catch {
    return titles
  }

  for (const bot of bots) {
    let chats: { id: string; title: string }[]
    try {
      chats = await ops.chats(bot)
    } catch {
      // One bot being unreachable must not cost the others their titles.
      continue
    }
    for (const chat of chats) {
      if (chat.id && chat.title) titles[chat.id] = chat.title
    }
  }

  let pairs: { sessionId: string; nativeId: string }[] = []
  try {
    pairs = await ops.sessionPairs()
  } catch {
    // Without the pairs the map still answers for Orca session ids.
  }
  for (const pair of pairs) {
    const title = titles[pair.sessionId]
    if (title && pair.nativeId) titles[pair.nativeId] = title
  }

  return titles
}