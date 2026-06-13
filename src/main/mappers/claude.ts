import type { ViewNode } from '../../shared/ipc.js'
import { cap, formatArgs, NodeBuilder, roleToKind, stripLocalCommandMarkup, toolResultText } from './shared.js'

function recordSessionId(record: unknown): string | undefined {
  if (!record || typeof record !== 'object') return undefined
  const value = (record as Record<string, unknown>).sessionId
  return typeof value === 'string' && value ? value : undefined
}

function inheritedParentIds(prefixRecords: unknown[], sessionId: string): string[] {
  const inheritedIds = new Set<string>()
  for (const record of prefixRecords) {
    const id = recordSessionId(record)
    if (id && id !== sessionId) inheritedIds.add(id)
  }

  return [...inheritedIds]
}

function forkBoundaryNode(prefixRecords: unknown[], sessionId: string): ViewNode {
  const parents = inheritedParentIds(prefixRecords, sessionId).join(', ') || 'unknown parent session'
  const text = [
    `Fork starts here from ${parents}.`,
    `${prefixRecords.length} raw parent records above are inherited context; records below belong to this fork.`
  ].join('\n')

  return {
    id: 'claude-fork-boundary',
    seq: 0,
    kind: 'meta',
    title: 'Fork boundary',
    text,
    rawIndex: prefixRecords.length,
    bytes: Buffer.byteLength(text, 'utf8')
  }
}

function isTaskNotificationText(text: string): boolean {
  return /<task-notification>[\s\S]*?<\/task-notification>/iu.test(text)
}

function tagValue(text: string, tag: string): string {
  const match = text.match(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'iu'))
  if (!match) return ''
  return match[0]
    .replace(new RegExp(`^<${tag}>`, 'iu'), '')
    .replace(new RegExp(`<\\/${tag}>$`, 'iu'), '')
    .trim()
}

function taskNotificationText(text: string): string {
  const summary = tagValue(text, 'summary')
  const status = tagValue(text, 'status')
  const taskId = tagValue(text, 'task-id')
  const outputFile = tagValue(text, 'output-file')
  return [
    summary || 'Background task notification',
    status ? `Status: ${status}` : '',
    taskId ? `Task: ${taskId}` : '',
    outputFile ? `Output: ${outputFile}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Map raw Claude Code JSONL records to display nodes.
 * Record shape: { type, message: { role, content }, timestamp, isMeta, summary, ... }
 * Content blocks: text | thinking | redacted_thinking | tool_use | tool_result | image.
 */
export function claudeNodes(
  records: unknown[],
  rawIndexFor: (recordIndex: number, record: unknown) => number = (recordIndex) => recordIndex
): ViewNode[] {
  const b = new NodeBuilder()

  records.forEach((rec, i) => {
    const rawIndex = rawIndexFor(i, rec)
    const r = rec as Record<string, any>
    if (!r || typeof r !== 'object') return

    if (r.type === 'summary' && typeof r.summary === 'string') {
      b.add(rawIndex, 'meta', r.summary, { title: 'Summary' })
      return
    }

    const msg = r.message
    if (!msg && r.type !== 'system') return

    const role: string = msg?.role || (r.type === 'assistant' ? 'assistant' : r.type === 'system' ? 'system' : 'user')
    const content = msg?.content ?? r.content

    if (content == null) return

    if (typeof content === 'string') {
      if (isTaskNotificationText(content)) {
        b.add(rawIndex, 'meta', taskNotificationText(content), { title: 'Task notification' })
        return
      }
      const text = stripLocalCommandMarkup(content)
      if (text) {
        b.add(rawIndex, roleToKind(role), text, {
          role: roleToKind(role) === 'system' ? 'system' : (role as any),
          title: cap(role)
        })
      }
      return
    }

    if (!Array.isArray(content)) return

    for (const block of content) {
      const blk = block as Record<string, any>
      switch (blk?.type) {
        case 'text': {
          const rawText = blk.text || ''
          if (isTaskNotificationText(rawText)) {
            b.add(rawIndex, 'meta', taskNotificationText(rawText), { title: 'Task notification' })
            break
          }
          const text = stripLocalCommandMarkup(rawText)
          if (text) b.add(rawIndex, roleToKind(role), text, { role: role as any, title: cap(role) })
          break
        }
        case 'thinking':
        case 'redacted_thinking':
          b.add(rawIndex, 'thinking', blk.thinking || blk.text || '[redacted thinking]', {
            role: 'assistant',
            title: 'Thinking'
          })
          break
        case 'tool_use':
          b.add(rawIndex, 'tool_call', formatArgs(blk.input), {
            role: 'assistant',
            toolName: blk.name,
            title: blk.name || 'tool',
            toolUseId: typeof blk.id === 'string' ? blk.id : undefined
          })
          break
        case 'tool_result': {
          const text = toolResultText(blk.content)
          b.add(rawIndex, 'tool_result', text || '(no output)', {
            role: 'user',
            title: blk.is_error ? 'Tool error' : 'Tool result',
            toolUseId: typeof blk.tool_use_id === 'string' ? blk.tool_use_id : undefined
          })
          break
        }
        case 'image':
          b.add(rawIndex, 'tool_result', '[image]', { title: 'Image' })
          break
        default:
          break
      }
    }
  })

  return b.result()
}

export function claudeTranscriptNodes(records: unknown[], sessionId: string): ViewNode[] {
  if (!sessionId) return claudeNodes(records)

  const firstOwnIndex = records.findIndex((record) => recordSessionId(record) === sessionId)
  if (firstOwnIndex <= 0) return claudeNodes(records)

  const prefixRecords = records.slice(0, firstOwnIndex)
  const ownRecords = records.slice(firstOwnIndex)
  const inheritedFromId = inheritedParentIds(prefixRecords, sessionId)[0]
  const inheritedNodes = claudeNodes(prefixRecords).map((node) => ({
    ...node,
    id: `inherited:${node.id}`,
    inherited: true,
    inheritedFromId,
  }))
  const ownNodes = claudeNodes(ownRecords, (recordIndex) => firstOwnIndex + recordIndex).map((node) => ({
    ...node,
    id: `own:${node.id}`,
    seq: node.seq + inheritedNodes.length + 1
  }))
  const boundary = {
    ...forkBoundaryNode(prefixRecords, sessionId),
    seq: inheritedNodes.length,
    inheritedFromId
  }

  return [...inheritedNodes, boundary, ...ownNodes]
}
