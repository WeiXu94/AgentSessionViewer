import type { NodeKind, ViewNode } from '../../shared/ipc.js'

/** Incrementally builds a node list with stable ids and sequence numbers. */
export class NodeBuilder {
  private nodes: ViewNode[] = []
  private seq = 0

  add(
    rawIndex: number,
    kind: NodeKind,
    text: string,
    extra: Partial<Pick<ViewNode, 'role' | 'title' | 'toolName' | 'toolUseId' | 'inherited' | 'inheritedFromId'>> = {}
  ): void {
    const t = text ?? ''
    this.nodes.push({
      id: `${rawIndex}.${this.nodes.length}`,
      seq: this.seq++,
      kind,
      text: t,
      rawIndex,
      bytes: Buffer.byteLength(t, 'utf8'),
      ...extra
    })
  }

  result(): ViewNode[] {
    return this.nodes
  }
}

export function cap(role: string): string {
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : role
}

/** Strip Claude's local-command / caveat XML wrappers that aren't human conversation. */
export function stripLocalCommandMarkup(text: string): string {
  return text
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/giu, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/giu, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/giu, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/giu, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/giu, '')
    .trim()
}

/** Best-effort text extraction from a tool_result `content` field (string | block[]). */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item
        const b = item as Record<string, unknown>
        if (typeof b?.text === 'string') return b.text
        if (b?.type === 'image') return '[image]'
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content === 'object') return JSON.stringify(content, null, 2)
  return ''
}

/** Pretty-print tool input arguments (object or JSON string). */
export function formatArgs(input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') {
    try {
      return JSON.stringify(JSON.parse(input), null, 2)
    } catch {
      return input
    }
  }
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

export function roleToKind(role: string): NodeKind {
  if (role === 'assistant') return 'assistant'
  if (role === 'system' || role === 'developer') return 'system'
  return 'user'
}
