import type { TranscriptPayload, ViewNode } from '../../shared/ipc.js'
import { getPreset } from '../sessions/config/index.js'
import { adapters } from '../sessions/parsers/registry.js'
import type { SessionSource, UnifiedSession } from '../sessions/types/index.js'
import { cap, formatArgs, NodeBuilder, roleToKind } from './shared.js'

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function textFromContent(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item
        const b = item as Record<string, any>
        if (typeof b?.text === 'string') return b.text
        if (typeof b?.content === 'string') return b.content
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (typeof content === 'object') {
    const o = content as Record<string, any>
    if (typeof o.text === 'string') return o.text
  }
  return ''
}

/** Best-effort mapping for file-based sources without a dedicated mapper. */
export function genericNodes(records: unknown[]): ViewNode[] {
  const b = new NodeBuilder()
  records.forEach((rec, i) => {
    const r = rec as Record<string, any>
    if (!r || typeof r !== 'object') return

    const role = r.role || r.message?.role || r.sender || r.author || (typeof r.type === 'string' ? r.type : '') || 'user'
    let text = ''
    if (r.message?.content != null) text = textFromContent(r.message.content)
    if (!text && r.content != null) text = textFromContent(r.content)
    if (!text && Array.isArray(r.parts)) text = r.parts.map((p: any) => p?.text || '').filter(Boolean).join('\n')
    if (!text && typeof r.text === 'string') text = r.text

    if (text) {
      const kind = roleToKind(String(role))
      b.add(i, kind, text, { role: kind === 'system' ? 'system' : (kind as any), title: cap(String(role)) })
    } else {
      b.add(i, 'meta', safeJson(r), { title: typeof r.type === 'string' ? r.type : 'record' })
    }
  })
  return b.result()
}

/**
 * Reconstruct a transcript for SQLite/DB-backed sources (opencode, crush, …) that
 * have no raw text file. Uses the adapter's extractContext with the `full` preset.
 */
export async function reconstructPayload(
  source: string,
  originalPath: string,
  existing?: UnifiedSession
): Promise<TranscriptPayload> {
  const adapter = adapters[source as SessionSource]
  if (!adapter) {
    return { source, originalPath, reconstructed: true, records: [], nodes: [], error: `No adapter for source "${source}"` }
  }

  const session: UnifiedSession =
    existing ?? {
      id: originalPath,
      source: source as SessionSource,
      cwd: '',
      lines: 0,
      bytes: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      originalPath
    }

  const ctx = await adapter.extractContext(session, getPreset('full'))
  const items = (ctx.timeline && ctx.timeline.length ? ctx.timeline : ctx.recentMessages) as any[]

  const b = new NodeBuilder()
  items.forEach((it, i) => {
    const role = it.role || (it.kind === 'tool_call' ? 'assistant' : 'user')
    if (it.kind === 'tool_call' || it.toolName) {
      b.add(i, 'tool_call', it.arguments ? formatArgs(it.arguments) : it.content || '', {
        role: 'assistant',
        toolName: it.toolName,
        title: it.toolName || 'tool'
      })
      return
    }
    if (it.kind === 'tool_result') {
      b.add(i, 'tool_result', it.result || it.content || '', { title: 'Tool result' })
      return
    }
    if (it.kind === 'reasoning') {
      b.add(i, 'thinking', it.content || '', { role: 'assistant', title: 'Thinking' })
      return
    }
    const text = it.content || it.text || ''
    const kind = roleToKind(String(role))
    b.add(i, text ? kind : 'meta', text || safeJson(it), {
      role: kind === 'system' ? 'system' : (kind as any),
      title: cap(String(role))
    })
  })

  return { source, originalPath, reconstructed: true, records: items, nodes: b.result() }
}
