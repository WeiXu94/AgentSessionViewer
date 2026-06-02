import type { ViewNode } from '../../shared/ipc.js'
import { formatArgs, NodeBuilder } from './shared.js'

function partsText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => {
      const part = c as Record<string, any>
      if (typeof part?.text === 'string') return part.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function isSystemInjected(text: string): boolean {
  return (
    text.startsWith('<environment_context>') ||
    text.startsWith('<permissions') ||
    text.startsWith('# AGENTS.md') ||
    text.startsWith('<user_instructions>')
  )
}

/**
 * Map raw Codex rollout JSONL records to display nodes.
 * Mirrors the Codex parser's dedup: prefer `response_item` messages; fall back to
 * `event_msg` only when no response_item messages exist. Tool calls/outputs and
 * reasoning come from `response_item`.
 */
export function codexNodes(records: unknown[]): ViewNode[] {
  const b = new NodeBuilder()

  const hasResponseItemMessages = records.some((rec) => {
    const r = rec as Record<string, any>
    return r?.type === 'response_item' && r?.payload?.type === 'message' && (r.payload.role === 'user' || r.payload.role === 'assistant')
  })

  // Map call_id -> output for inline tool results.
  const outputs = new Map<string, string>()
  for (const rec of records) {
    const r = rec as Record<string, any>
    const p = r?.payload
    if (r?.type === 'response_item' && (p?.type === 'function_call_output' || p?.type === 'custom_tool_call_output') && p.call_id) {
      outputs.set(p.call_id, typeof p.output === 'string' ? p.output : JSON.stringify(p.output, null, 2))
    }
  }

  records.forEach((rec, i) => {
    const r = rec as Record<string, any>
    if (!r || typeof r !== 'object') return
    const p = r.payload as Record<string, any> | undefined

    if (r.type === 'session_meta') {
      const cwd = p?.cwd || p?.payload?.cwd
      b.add(i, 'meta', cwd ? `Session started · ${cwd}` : 'Session started', { title: 'Session' })
      return
    }

    if (r.type === 'event_msg') {
      if (!p) return
      if (p.type === 'user_message' && !hasResponseItemMessages) {
        const text = p.message || r.message || ''
        if (text) b.add(i, 'user', text, { role: 'user', title: 'User' })
      } else if ((p.type === 'agent_message' || p.type === 'assistant_message') && !hasResponseItemMessages) {
        if (p.message) b.add(i, 'assistant', p.message, { role: 'assistant', title: 'Assistant' })
      } else if (p.type === 'agent_reasoning' && !hasResponseItemMessages) {
        if (p.text) b.add(i, 'thinking', p.text, { role: 'assistant', title: 'Thinking' })
      }
      return
    }

    if (r.type === 'response_item') {
      if (!p) return
      switch (p.type) {
        case 'message': {
          const text = partsText(p.content)
          if (!text) break
          if (p.role === 'user') {
            if (!isSystemInjected(text)) b.add(i, 'user', text, { role: 'user', title: 'User' })
            else b.add(i, 'system', text, { role: 'system', title: 'System context' })
          } else if (p.role === 'assistant') {
            b.add(i, 'assistant', text, { role: 'assistant', title: 'Assistant' })
          } else {
            b.add(i, 'system', text, { role: 'system', title: 'System' })
          }
          break
        }
        case 'reasoning': {
          const text = partsText(p.summary) || partsText(p.content) || ''
          if (text) b.add(i, 'thinking', text, { role: 'assistant', title: 'Thinking' })
          break
        }
        case 'function_call': {
          const out = p.call_id ? outputs.get(p.call_id) : undefined
          b.add(i, 'tool_call', formatArgs(p.arguments), { role: 'assistant', toolName: p.name, title: p.name || 'tool' })
          if (out !== undefined) b.add(i, 'tool_result', out || '(no output)', { title: 'Tool result' })
          break
        }
        case 'custom_tool_call': {
          const out = p.call_id ? outputs.get(p.call_id) : undefined
          b.add(i, 'tool_call', typeof p.input === 'string' ? p.input : formatArgs(p.input), {
            role: 'assistant',
            toolName: p.name,
            title: p.name || 'tool'
          })
          if (out !== undefined) b.add(i, 'tool_result', out || '(no output)', { title: 'Tool result' })
          break
        }
        case 'web_search_call': {
          const query = String(p.action?.query || p.action?.queries?.[0] || '')
          b.add(i, 'tool_call', query, { role: 'assistant', toolName: 'web_search', title: 'web_search' })
          break
        }
        case 'function_call_output':
        case 'custom_tool_call_output':
          // Rendered inline with their call above.
          break
        default:
          break
      }
    }
  })

  return b.result()
}
