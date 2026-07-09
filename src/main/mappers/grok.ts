import type { ViewNode } from '../../shared/ipc.js'
import { extractUserFacingText } from '../sessions/parsers/grok.js'
import { formatArgs, NodeBuilder, toolResultText } from './shared.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function reasoningText(record: Record<string, unknown>): string {
  const summary = record.summary
  if (Array.isArray(summary)) {
    return summary
      .map((part) => {
        if (!isRecord(part)) return ''
        if (part.type === 'summary_text' && typeof part.text === 'string') return part.text
        if (typeof part.text === 'string') return part.text
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (typeof record.content === 'string') return record.content
  return toolResultText(record.content)
}

/**
 * Map raw Grok Build chat_history.jsonl records to display nodes.
 * Record types: system | user | assistant | reasoning | tool_result | backend_tool_call.
 */
export function grokNodes(records: unknown[]): ViewNode[] {
  const b = new NodeBuilder()

  records.forEach((rec, i) => {
    const r = rec as Record<string, any>
    if (!r || typeof r !== 'object') return

    switch (r.type) {
      case 'system':
        // Full system prompt is noise in the Session tab.
        return

      case 'user': {
        const text = extractUserFacingText(r)
        if (text) b.add(i, 'user', text, { role: 'user', title: 'User' })
        return
      }

      case 'reasoning': {
        const text = reasoningText(r)
        if (text) b.add(i, 'thinking', text, { role: 'assistant', title: 'Thinking' })
        return
      }

      case 'assistant': {
        const text = typeof r.content === 'string' ? r.content : toolResultText(r.content)
        if (text) b.add(i, 'assistant', text, { role: 'assistant', title: 'Assistant' })

        if (Array.isArray(r.tool_calls)) {
          for (const call of r.tool_calls as Array<Record<string, any>>) {
            if (!call || typeof call !== 'object') continue
            b.add(i, 'tool_call', formatArgs(call.arguments), {
              role: 'assistant',
              toolName: call.name,
              title: call.name || 'tool',
              toolUseId: typeof call.id === 'string' ? call.id : undefined
            })
          }
        }
        return
      }

      case 'tool_result': {
        const text = toolResultText(r.content)
        b.add(i, 'tool_result', text || '(no output)', {
          title: 'Tool result',
          toolUseId: typeof r.tool_call_id === 'string' ? r.tool_call_id : undefined
        })
        return
      }

      case 'backend_tool_call': {
        const kind = isRecord(r.kind) ? r.kind : undefined
        const toolType =
          (kind && typeof kind.tool_type === 'string' && kind.tool_type) || 'backend_tool'
        const action = kind && isRecord(kind.action) ? kind.action : kind
        b.add(i, 'tool_call', formatArgs(action), {
          role: 'assistant',
          toolName: toolType,
          title: toolType,
          toolUseId:
            (kind && typeof kind.id === 'string' && kind.id) ||
            (typeof r.id === 'string' ? r.id : undefined)
        })
        return
      }

      default:
        break
    }
  })

  return b.result()
}
