/**
 * Chat titles live only in Orca's own CLI (`orca bot chats`), keyed by the Orca session id. A row
 * may carry a provider id instead, so the caller aliases each title onto that record's chain ids
 * before looking rows up (`aliasTitles` in `sessionRecord`).
 */
export type ChatTitleOps = {
  /** Every bot on this machine; a chat can belong to any of them. */
  bots(): Promise<string[]>
  chats(bot: string): Promise<{ id: string; title: string }[]>
}

/** The title table, keyed by Orca session id. Never by agent name. */
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

  return titles
}