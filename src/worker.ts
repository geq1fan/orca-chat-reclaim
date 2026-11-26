// The plugin's own worker: it reads Orca's host API, and stops a session either through the
// terminal API or, for a chat session with no terminal, by SIGTERM-ing the claude process group
// that Orca started for it. Nothing is killed without resolving the process first.
import type { OrcaWorkerApi } from 'orca/worker'
import { buildTitleMap, type ChatTitleOps } from './botChats'
import { messageOf } from './errors'
import { createChatTitleOps, createSignalOps } from './hostOps'
import { AGENT_STATE_LABEL } from './labels'
import type { CloseOutcome, OpRecord, ReclaimResult, SessionRow, SessionSnapshot } from './protocol'
import { hasClaudeProcess, parseProcessTable, type PsRow } from './processTable'
import { stopSessionWithSignal, type SignalOps } from './sessionProcess'
import { mostRecentIdle, selectIdle } from './sessions'

/** How many `agents.list` calls are in flight at once. 127 workspaces one by one is slow. */
const BATCH = 8

const OPS_KEY = 'recentOps'
const MAX_OPS = 50

const TITLES_KEY = 'botTitles'
/** Titles change slowly; a list older than this rebuilds them, and so does a manual refresh. */
const TITLE_TTL_MS = 60_000

/**
 * The process side of a close. Orca calls `activate(orca)` with nothing else, so tests swap this
 * through `useSignalOps` instead of touching real processes.
 */
let signalOps: SignalOps | null = null

function signalOperations(): SignalOps {
  return (signalOps ??= createSignalOps())
}

export function useSignalOps(replaced: SignalOps | null): void {
  signalOps = replaced
}

/**
 * Where chat titles come from. Tests swap this through `useTitleOps` so they never run the CLI.
 */
let chatTitleOps: ChatTitleOps | null = null

function titleOperations(): ChatTitleOps {
  return (chatTitleOps ??= createChatTitleOps())
}

export function useTitleOps(replaced: ChatTitleOps | null): void {
  chatTitleOps = replaced
}

type TitleCache = { at: number; titles: Record<string, string> }

/**
 * Titles for chat sessions, keyed by either id a row may carry. `refresh` rebuilds from the CLI
 * (the 刷新 button and every refresh after a close); otherwise a cache younger than a minute is
 * enough, since a full rebuild asks every bot and takes about a second.
 */
async function loadTitles(orca: OrcaWorkerApi, refresh: boolean): Promise<Record<string, string>> {
  let cached: TitleCache | null = null
  try {
    const stored = await orca.storage.get(TITLES_KEY)
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      const value = stored as { at?: unknown; titles?: unknown }
      const titles = value.titles
      if (
        typeof value.at === 'number' &&
        titles &&
        typeof titles === 'object' &&
        !Array.isArray(titles)
      ) {
        cached = { at: value.at, titles: titles as Record<string, string> }
      }
    }
  } catch {
    // No usable cache; a rebuild may still work.
  }

  if (!refresh && cached && Date.now() - cached.at < TITLE_TTL_MS) return cached.titles

  let fresh: Record<string, string>
  try {
    fresh = await buildTitleMap(titleOperations())
  } catch {
    return cached?.titles ?? {}
  }
  // An empty map means the CLI answered nothing; keep the last good titles instead of losing them.
  if (Object.keys(fresh).length === 0 && cached) return cached.titles
  try {
    await orca.storage.set(TITLES_KEY, { at: Date.now(), titles: fresh })
  } catch {
    // The cache is an optimisation; the titles still show this time.
  }
  return fresh
}

function sessionLabel(agent: {
  title?: string | null
  task?: { title: string } | null
  agent?: string | null
  sessionId?: string | null
}): string {
  if (agent.title) return agent.title
  if (agent.task?.title) return agent.task.title
  if (agent.sessionId) return `会话 ${agent.sessionId.slice(0, 8)}`
  // The agent's own name says nothing about which conversation this is, and Orca gave no id.
  return '未命名会话'
}

async function readOps(orca: OrcaWorkerApi): Promise<OpRecord[]> {
  const stored = await orca.storage.get(OPS_KEY)
  return Array.isArray(stored) ? (stored as OpRecord[]) : []
}

/** Best effort: a log that cannot be written must not turn a finished close into an error. */
async function recordOp(orca: OrcaWorkerApi, entry: OpRecord): Promise<void> {
  try {
    const list = await readOps(orca)
    list.unshift(entry)
    await orca.storage.set(OPS_KEY, list.slice(0, MAX_OPS))
  } catch (error) {
    orca.log(`recentOps 写入失败：${messageOf(error)}`)
  }
}

/** Reads every workspace and the agent sessions inside them. */
async function readSnapshot(orca: OrcaWorkerApi, refreshTitles: boolean): Promise<SessionSnapshot> {
  const listed = await orca.host.call('workspace.list', { includeStatus: true })
  const context = await orca.host.call('workspace.readContext')
  const titles = await loadTitles(orca, refreshTitles)

  const workspaces = listed.workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    kind: workspace.kind,
    terminalCount: workspace.status?.terminalCount ?? null
  }))

  // One `ps` for the whole list: it tells the panel which chats still have a live process, so a
  // history leftover is greyed out before anyone clicks it. A failed read leaves it unknown.
  let processTable: PsRow[] | null = null
  try {
    processTable = parseProcessTable(await signalOperations().listProcesses())
  } catch {
    processTable = null
  }

  const sessions: SessionRow[] = []
  let failedWorkspaces = 0

  for (let start = 0; start < listed.workspaces.length; start += BATCH) {
    const batch = listed.workspaces.slice(start, start + BATCH)
    const answers = await Promise.all(
      batch.map(async (workspace) => {
        try {
          const { agents } = await orca.host.call('agents.list', { workspaceId: workspace.id })
          return { workspace, agents }
        } catch {
          // A workspace that vanished mid-scan must not cost the whole list, but the panel says
          // how many were skipped instead of quietly showing fewer sessions.
          return { workspace, agents: null }
        }
      })
    )
    for (const { workspace, agents } of answers) {
      if (agents === null) {
        failedWorkspaces += 1
        continue
      }
      for (const agent of agents) {
        const providerSessionId = agent.sessionId ?? null
        sessions.push({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspaceKind: workspace.kind,
          terminalId: agent.terminalId,
          title: (agent.sessionId && titles[agent.sessionId]) || sessionLabel(agent),
          agent: agent.agent ?? 'unknown',
          state: agent.state,
          stateStartedAt: agent.stateStartedAt,
          sessionId: providerSessionId,
          hasProcess:
            agent.terminalId !== null
              ? null
              : providerSessionId === null
                ? // A chat pane Orca restored without a provider handle has nothing running.
                  false
                : processTable === null
                  ? null
                  : hasClaudeProcess(processTable, providerSessionId)
        })
      }
    }
  }

  let recentOps: OpRecord[] = []
  try {
    recentOps = await readOps(orca)
  } catch {
    // The panel simply shows no history when the store cannot be read.
  }

  const focusedWorkspaceId = context?.workspaceId ?? null
  const current = focusedWorkspaceId ? mostRecentIdle(sessions, focusedWorkspaceId) : null

  return {
    workspaces,
    sessions,
    currentWorkspaceId: focusedWorkspaceId,
    workspacesTruncated: listed.truncated,
    failedWorkspaces,
    recentOps,
    currentSessionId: current?.sessionId ?? null
  }
}

/** `terminal.close` only accepts a terminal of the focused workspace, so focus it first. */
async function closeTerminal(
  orca: OrcaWorkerApi,
  terminalId: string
): Promise<{ ok: boolean; code?: string; message?: string }> {
  try {
    const focus = await orca.host.call('terminal.focus', { terminalId })
    if (!focus.focused) {
      return {
        ok: false,
        code: 'not_focused',
        message: 'Orca 没能把焦点移到这里（窗口未激活，或另一个聚焦请求紧接着发生），已放弃关闭'
      }
    }
    await orca.host.call('terminal.close', { terminalId })
    return { ok: true }
  } catch (error) {
    const failure = error as { code?: unknown }
    return {
      ok: false,
      code: typeof failure.code === 'string' ? failure.code : 'action_failed',
      message: messageOf(error)
    }
  }
}

type CloseInput = {
  workspaceId: string
  sessionId?: string | null
  terminalId?: string | null
  dryRun?: boolean
}

/**
 * Closes one session after checking, against a fresh `agents.list`, that it still exists and is
 * `done`. A session that started working again is refused here, not just in the panel.
 */
async function closeOne(orca: OrcaWorkerApi, input: CloseInput): Promise<CloseOutcome> {
  const dryRun = input.dryRun === true
  const base: CloseOutcome = {
    ok: false,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId ?? null,
    how: null,
    dryRun
  }
  const fallbackTitle = input.sessionId
    ? `会话 ${input.sessionId.slice(0, 8)}`
    : (input.terminalId ?? '会话')
  const fallbackKind: 'terminal' | 'signal' = input.terminalId ? 'terminal' : 'signal'

  /** Every attempt lands in the log, refusals included: a click must never look like nothing. */
  const finish = async (outcome: CloseOutcome, title: string): Promise<CloseOutcome> => {
    await recordOp(orca, {
      at: Date.now(),
      ok: outcome.ok,
      dryRun,
      kind: outcome.how ?? fallbackKind,
      title,
      sessionId: outcome.sessionId,
      terminalId: outcome.terminalId ?? input.terminalId ?? null,
      sessionUuid: outcome.sessionUuid ?? null,
      pid: outcome.pid ?? null,
      pgid: outcome.pgid ?? null,
      message: outcome.ok ? null : (outcome.message ?? null)
    })
    return outcome
  }

  let agents
  try {
    ;({ agents } = await orca.host.call('agents.list', { workspaceId: input.workspaceId }))
  } catch (error) {
    return finish(
      { ...base, code: 'list_failed', message: `读工作区会话失败：${messageOf(error)}` },
      fallbackTitle
    )
  }

  const match = agents.find(
    (agent) =>
      (input.sessionId != null && agent.sessionId === input.sessionId) ||
      (input.terminalId != null && agent.terminalId === input.terminalId)
  )
  if (!match) {
    return finish({ ...base, code: 'not_found', message: '这个会话已经不在了，刷新看看' }, fallbackTitle)
  }

  const sessionId = match.sessionId ?? base.sessionId
  const title = sessionLabel(match)
  if (match.state !== 'done') {
    return finish(
      {
        ...base,
        sessionId,
        code: 'not_idle',
        message: `会话现在是「${AGENT_STATE_LABEL[match.state]}」，只有 done 才能关闭`
      },
      title
    )
  }

  if (match.terminalId) {
    const closed: { ok: boolean; code?: string; message?: string } = dryRun
      ? { ok: true }
      : await closeTerminal(orca, match.terminalId)
    return finish(
      {
        ...base,
        sessionId,
        ok: closed.ok,
        how: 'terminal',
        terminalId: match.terminalId,
        // Request answers are JSON: an `undefined` field fails the host's shape check.
        ...(closed.code ? { code: closed.code } : {}),
        ...(closed.message ? { message: closed.message } : {})
      },
      title
    )
  }

  if (!sessionId) {
    return finish({ ...base, code: 'no_handle', message: '这个会话既没有终端也没有 sessionId，没法关' }, title)
  }

  const outcome = await stopSessionWithSignal({
    workspaceId: input.workspaceId,
    sessionId,
    dryRun,
    ops: signalOperations()
  })
  return finish(outcome, title)
}

async function reclaimIdle(orca: OrcaWorkerApi, workspaceId: string, dryRun: boolean): Promise<ReclaimResult> {
  // Re-read first: the panel's list may be older than what Orca has now, and closing a session
  // that started working again would be the one thing this must never do.
  const snapshot = await readSnapshot(orca, false)
  // The chat the owner is talking in is never part of a bulk reclaim.
  const current = mostRecentIdle(snapshot.sessions, workspaceId)
  const excludedSessionId = current?.sessionId ?? null
  const idle = selectIdle(snapshot.sessions, workspaceId, excludedSessionId)
  const skipped: ReclaimResult['skipped'] =
    current && current.sessionId ? { sessionId: current.sessionId, title: current.title } : null
  const outcomes: CloseOutcome[] = []

  for (const session of idle) {
    const outcome = await closeOne(orca, {
      workspaceId,
      sessionId: session.sessionId,
      terminalId: session.terminalId,
      dryRun
    })
    outcomes.push(outcome)
    // One refusal usually means the machine cannot be driven right now; stop rather than firing
    // the same failed action at every remaining session.
    if (!outcome.ok) return { outcomes, stoppedAtFailure: true, skipped }
  }
  return { outcomes, stoppedAtFailure: false, skipped }
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('sessions.list', async (input) => readSnapshot(orca, input?.refreshTitles === true))

  orca.panels.handle('sessions.close', async (input) => {
    const outcome = await closeOne(orca, input)
    orca.log(`close ${input.workspaceId} ${input.sessionId ?? input.terminalId}: ${outcome.ok ? 'ok' : outcome.code}`)
    return outcome
  })

  orca.panels.handle('sessions.reclaim', async ({ workspaceId, dryRun }) => {
    const result = await reclaimIdle(orca, workspaceId, dryRun === true)
    const closed = result.outcomes.filter((outcome) => outcome.ok).length
    orca.log(`reclaimed ${closed}/${result.outcomes.length} in ${workspaceId}`)
    return result
  })
}