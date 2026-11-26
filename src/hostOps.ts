// The real machine side of stopping a session: the session database, `ps`, and SIGTERM.
// Everything here is macOS-shaped on purpose — the plugin only runs on an Orca desktop host.
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ChatTitleOps } from './botChats'
import type { SessionRecord } from './sessionRecord'
import { chainSessionIds } from './sessionRecord'
import type { SignalOps } from './sessionProcess'

const DB_PATH = join(homedir(), 'Library', 'Application Support', 'orca', 'agent-session-domain.db')

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/** The worker's PATH may not carry the CLI, so the app's own copy is the fallback. */
async function runOrca(args: string[]): Promise<string> {
  try {
    return await run('orca', args)
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') throw error
    return run('/usr/local/bin/orca', args)
  }
}

function parseJson<T>(output: string): T | null {
  try {
    return JSON.parse(output) as T
  } catch {
    return null
  }
}

/** Chat titles for the panel; every bot is asked, because a workspace's chat can belong to any. */
export function createChatTitleOps(): ChatTitleOps {
  return {
    async bots() {
      const parsed = parseJson<{ result?: { bots?: { name?: unknown }[] } }>(
        await runOrca(['bot', 'list', '--json'])
      )
      return (parsed?.result?.bots ?? []).flatMap((bot) =>
        typeof bot.name === 'string' && bot.name.length > 0 ? [bot.name] : []
      )
    },
    async chats(bot) {
      const parsed = parseJson<{ result?: { chats?: { id?: unknown; title?: unknown }[] } }>(
        await runOrca(['bot', 'chats', '--json', '--bot', bot])
      )
      return (parsed?.result?.chats ?? []).flatMap((chat) =>
        typeof chat.id === 'string' && typeof chat.title === 'string' && chat.title.length > 0
          ? [{ id: chat.id, title: chat.title }]
          : []
      )
    }
  }
}

export function createSignalOps(): SignalOps {
  return {
    async listSessionRecords() {
      // One read for the whole snapshot: every stored session's Orca id, the native id it
      // adopted, and the ids in its handle chain. Only these columns are selected; a record can
      // be over a megabyte. `adopted_native_id` is a generated column, so the record JSON is never
      // parsed here.
      const output = await run('sqlite3', [
        '-readonly',
        '-json',
        `file:${DB_PATH}?mode=ro`,
        'select session_id, adopted_native_id, ' +
          "json_extract(record_json,'$.providerHandleChain') as chain from agent_session_records;"
      ])
      const rows = parseJson<{ session_id?: unknown; adopted_native_id?: unknown; chain?: unknown }[]>(
        output
      )
      if (!Array.isArray(rows)) return []
      const records: SessionRecord[] = []
      for (const row of rows) {
        if (typeof row.session_id !== 'string' || row.session_id.length === 0) continue
        const chain = typeof row.chain === 'string' ? row.chain : null
        records.push({
          sessionId: row.session_id,
          nativeId:
            typeof row.adopted_native_id === 'string' && row.adopted_native_id.length > 0
              ? row.adopted_native_id
              : null,
          chainIds: chainSessionIds(chain)
        })
      }
      return records
    },
    listProcesses: () => run('ps', ['-Ao', 'pid,ppid,pgid,command']),
    signalGroup: (pgid) => {
      process.kill(-pgid, 'SIGTERM')
    },
    isAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    },
    ownPgid: async () => {
      // Our own group is the desktop app's; a session group can never be it, but refuse if it is.
      try {
        const output = await run('ps', ['-o', 'pgid=', '-p', String(process.pid)])
        const pgid = Number(output.trim())
        return Number.isFinite(pgid) ? pgid : null
      } catch {
        return null
      }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  }
}