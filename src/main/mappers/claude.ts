import type { ViewNode } from '../../shared/ipc.js'
import { cap, formatArgs, NodeBuilder, roleToKind, stripLocalCommandMarkup, toolResultText } from './shared.js'

/**
 * Map raw Claude Code JSONL records to display nodes.
 * Record shape: { type, message: { role, content }, timestamp, isMeta, summary, ... }
 * Content blocks: text | thinking | redacted_thinking | tool_use | tool_result | image.
 */
export function claudeNodes(records: unknown[]): ViewNode[] {
  const b = new NodeBuilder()

  records.forEach((rec, i) => {
    const r = rec as Record<string, any>
    if (!r || typeof r !== 'object') return

    if (r.type === 'summary' && typeof r.summary === 'string') {
      b.add(i, 'meta', r.summary, { title: 'Summary' })
      return
    }

    const msg = r.message
    const role: string = msg?.role || (r.type === 'assistant' ? 'assistant' : r.type === 'system' ? 'system' : 'user')
    const content = msg?.content ?? r.content

    if (content == null) return

    if (typeof content === 'string') {
      const text = stripLocalCommandMarkup(content)
      if (text) b.add(i, roleToKind(role), text, { role: roleToKind(role) === 'system' ? 'system' : (role as any), title: cap(role) })
      return
    }

    if (!Array.isArray(content)) return

    for (const block of content) {
      const blk = block as Record<string, any>
      switch (blk?.type) {
        case 'text': {
          const text = stripLocalCommandMarkup(blk.text || '')
          if (text) b.add(i, roleToKind(role), text, { role: role as any, title: cap(role) })
          break
        }
        case 'thinking':
        case 'redacted_thinking':
          b.add(i, 'thinking', blk.thinking || blk.text || '[redacted thinking]', {
            role: 'assistant',
            title: 'Thinking'
          })
          break
        case 'tool_use':
          b.add(i, 'tool_call', formatArgs(blk.input), {
            role: 'assistant',
            toolName: blk.name,
            title: blk.name || 'tool'
          })
          break
        case 'tool_result': {
          const text = toolResultText(blk.content)
          b.add(i, 'tool_result', text || '(no output)', {
            role: 'user',
            title: blk.is_error ? 'Tool error' : 'Tool result'
          })
          break
        }
        case 'image':
          b.add(i, 'tool_result', '[image]', { title: 'Image' })
          break
        default:
          break
      }
    }
  })

  return b.result()
}
