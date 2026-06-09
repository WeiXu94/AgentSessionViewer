import { memo, type ReactNode } from 'react'
import type { ViewNode } from '../../../shared/ipc'
import { fmtBytes } from '../util'
import { Tri } from './MacIcons'
import { marked } from 'marked'

const MAX_DISPLAY = 200_000

export function displayNodeText(text: string): string {
  if (text.length <= MAX_DISPLAY) return text
  return `${text.slice(0, MAX_DISPLAY)}\n…(${fmtBytes(text.length - MAX_DISPLAY)} more — open JSON view for full content)`
}

function mdBody(text: string): ReactNode {
  const html = marked.parse(text, { async: false }) as string
  return (
    <span
      className="msg--md"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const link = (e.target as HTMLElement).closest('a')
        if (!link || !link.href) return
        e.preventDefault()
        const url = link.href
        if (url.startsWith('http://') || url.startsWith('https://')) {
          window.api.openExternal(url)
        } else {
          window.api.openPath(url)
        }
      }}
    />
  )
}

function highlightedText(text: string, query: string, startOrdinal: number, activeOrdinal?: number): [ReactNode, number] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [text, startOrdinal]

  const lower = text.toLowerCase()
  const parts: ReactNode[] = []
  let from = 0
  let ordinal = startOrdinal

  for (;;) {
    const index = lower.indexOf(needle, from)
    if (index === -1) break
    if (index > from) parts.push(text.slice(from, index))

    const next = index + needle.length
    parts.push(
      <mark
        key={`${index}-${ordinal}`}
        className={`searchMark${ordinal === activeOrdinal ? ' searchMark--active' : ''}`}
      >
        {text.slice(index, next)}
      </mark>
    )
    ordinal++
    from = next
  }

  if (from < text.length) parts.push(text.slice(from))
  return [parts.length ? parts : text, ordinal]
}

interface NodeBubbleProps {
  node: ViewNode
  searchQuery?: string
  hasSearchMatch?: boolean
  activeMatchOrdinal?: number
  blockOpenMode?: 'default' | 'collapsed' | 'expanded'
}

export const NodeBubble = memo(function NodeBubble({
  node,
  searchQuery = '',
  hasSearchMatch = false,
  activeMatchOrdinal,
  blockOpenMode = 'default'
}: NodeBubbleProps): JSX.Element {
  const text = displayNodeText(node.text)
  // Only user messages and assistant responses (rendered below as
  // non-collapsible bubbles) are shown by default. Every collapsible block —
  // system, meta, thinking, tool calls and results — stays collapsed unless it
  // holds a search hit (or the user unfolds everything via blockOpenMode).
  const defaultOpen = blockOpenMode === 'expanded' || (blockOpenMode === 'default' && hasSearchMatch)
  const bubbleClass = [
    'bubble',
    `bubble--${node.kind}`,
    node.inherited ? 'bubble--inherited' : '',
    hasSearchMatch ? 'bubble--search-hit' : '',
    activeMatchOrdinal !== undefined ? 'bubble--search-active' : ''
  ]
    .filter(Boolean)
    .join(' ')

  if (node.kind === 'user' || node.kind === 'assistant') {
    const [title, nextOrdinal] = highlightedText(node.title ?? '', searchQuery, 0, activeMatchOrdinal)
    const body = searchQuery ? highlightedText(text, searchQuery, nextOrdinal, activeMatchOrdinal)[0] : mdBody(text)

    return (
      <div className={bubbleClass}>
        <div className="bubble__head">
          {node.inherited ? <span className="bubble__inherit">Inherited</span> : null}
          <span className="bubble__role">{node.kind === 'user' ? 'You' : title || 'Assistant'}</span>
        </div>
        <div className="bubble__text msg">{body}</div>
      </div>
    )
  }

  // meta / system / thinking / tool_call / tool_result — collapsible
  const displayTitle = node.title || node.toolName || ''
  const [title, nextOrdinal] = highlightedText(displayTitle, searchQuery, 0, activeMatchOrdinal)
  const [body] = highlightedText(text, searchQuery, nextOrdinal, activeMatchOrdinal)

  return (
    <div className={bubbleClass}>
      <details className={`block block--${node.kind}`} open={defaultOpen}>
        <summary className="bubble__summary block__summary">
          <span className="block__tri">
            <Tri />
          </span>
          <span className="bubble__title block__title">{title}</span>
          {node.inherited ? <span className="bubble__inherit">Inherited</span> : null}
          <span className="bubble__size block__size">{fmtBytes(node.bytes)}</span>
        </summary>
        <pre className="bubble__pre block__body">{body}</pre>
      </details>
    </div>
  )
})
