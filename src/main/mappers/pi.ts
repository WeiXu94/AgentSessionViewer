import type { ViewNode } from '../../shared/ipc.js'
import { formatArgs, NodeBuilder, toolResultText } from './shared.js'

/**
 * Map raw Pi session JSONL records to display nodes.
 * Records: session | model_change | thinking_level_change | message | custom.
 * message.message = { role: user|assistant|toolResult, content: block[] }.
 * Blocks: text | thinking | toolCall. toolResult carries toolName/content/isError.
 */
export function piNodes(records: unknown[]): ViewNode[] {
  const b = new NodeBuilder()

  records.forEach((rec, i) => {
    const r = rec as Record<string, any>
    if (!r || typeof r !== 'object') return

    if (r.type === 'session') {
      b.add(i, 'meta', r.cwd ? `Session started · ${r.cwd}` : 'Session started', { title: 'Session' })
      return
    }
    if (r.type === 'model_change') {
      const label = [r.provider, r.modelId].filter(Boolean).join(' / ')
      if (label) b.add(i, 'meta', label, { title: 'Model' })
      return
    }
    if (r.type === 'custom') {
      let text = ''
      try {
        text = JSON.stringify(r.data, null, 2)
      } catch {
        text = String(r.data)
      }
      b.add(i, 'tool_result', text, { title: String(r.customType ?? 'custom') })
      return
    }
    if (r.type !== 'message') return

    const msg = r.message as Record<string, any> | undefined
    if (!msg) return
    const role = msg.role

    if (role === 'toolResult') {
      const text = toolResultText(msg.content)
      b.add(i, 'tool_result', text || '(no output)', {
        title: msg.isError ? 'Tool error' : msg.toolName || 'Tool result',
        toolName: msg.toolName
      })
      return
    }

    const kind = role === 'assistant' ? 'assistant' : 'user'
    const title = role === 'assistant' ? 'Assistant' : 'User'

    if (!Array.isArray(msg.content)) {
      const text = typeof msg.content === 'string' ? msg.content : ''
      if (text) b.add(i, kind, text, { role: kind, title })
      return
    }

    for (const block of msg.content) {
      const blk = block as Record<string, any>
      switch (blk?.type) {
        case 'text':
          if (blk.text) b.add(i, kind, blk.text, { role: kind, title })
          break
        case 'thinking':
          if (blk.thinking) b.add(i, 'thinking', blk.thinking, { role: 'assistant', title: 'Thinking' })
          break
        case 'toolCall':
          b.add(i, 'tool_call', formatArgs(blk.arguments), {
            role: 'assistant',
            toolName: blk.name,
            title: blk.name || 'tool'
          })
          break
        default:
          break
      }
    }
  })

  return b.result()
}
