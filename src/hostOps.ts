// The real machine side of stopping a session: the session database, `ps`, and SIGTERM.
// Everything here is macOS-shaped on purpose — the plugin only runs on an Orca desktop host.
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ChatTitleOps } from './botChats'
import type { SignalOps } from './sessionProcess'

const DB_PATH = join(homedir(), 'Library', 'Application Support', 'orca', 'agent-session-domain.db')

/** A session id is interpolated into SQL, so it must look like one. */
const SESSION_ID = /^[0-9a-zA-Z-]{8,64}$/

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
    },
    async sessionPairs() {
      const output = await run('sqlite3', [
        '-readonly',
        `file:${DB_PATH}?mode=ro`,
        'select session_id, adopted_native_id from agent_session_records where adopted_native_id is not null;'
      ])
      const pairs: { sessionId: string; nativeId: string }[] = []
      for (const line of output.split('\n')) {
        const [sessionId, nativeId] = line.split('|')
        if (sessionId && nativeId) pairs.push({ sessionId, nativeId })
      }
      return pairs
    }
  }
}

export function createSignalOps(): SignalOps {
  return {
    async readHandleChain(sessionId) {
      if (!SESSION_ID.test(sessionId)) throw new Error(`会话 id 形态不对：${sessionId}`)
      // Only the chain is selected: a record can be over a megabyte, and the chain is the part
      // that names the provider's own conversation id.
      const sql = `select json_extract(record_json,'$.providerHandleChain') from agent_session_records where session_id='${sessionId}';`
      const output = await run('sqlite3', ['-readonly', `file:${DB_PATH}?mode=ro`, sql])
      const line = output.trim().split('\n')[0] ?? ''
      return line.length > 0 && line !== 'null' ? line : null
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