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
