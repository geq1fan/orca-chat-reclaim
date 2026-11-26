import type { AgentState } from './protocol'

/** One wording for agent states across the panel and the worker's refusal messages. */
export const AGENT_STATE_LABEL: Record<AgentState, string> = {
  working: '运行中',
  blocked: '待确认',
  waiting: '等待中',
  done: '已结束'
}

/** Chat titles can be long sentences; the row shows the first 40 characters. */
export function truncateTitle(title: string, limit = 40): string {
  return title.length > limit ? `${title.slice(0, limit)}…` : title
}

/** Whether a string looks like a filesystem path (e.g. pi's adopted `.jsonl` path) rather than an id. */
export function isFilePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('~') || value.includes('/') || value.includes('\\')
}

/** Formats memory bytes compactly for row display, matching Orca Resource Manager units. */
export function formatMemory(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  if (mb >= 1) return `${Math.round(mb)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}
