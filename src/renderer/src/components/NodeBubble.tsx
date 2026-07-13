import { memo, type ReactNode } from 'react'
import type { ViewNode } from '../../../shared/ipc'
import { fmtBytes } from '../util'
import { m } from '../styles/cx'
import { Chevron } from './MacIcons'
import styles from './NodeBubble.module.css'
import { marked, type Tokens } from 'marked'
import katex from 'katex'
import DOMPurify from 'dompurify'

const MAX_DISPLAY = 200_000

export function displayNodeText(text: string): string {
  if (text.length <= MAX_DISPLAY) return text
  return `${text.slice(0, MAX_DISPLAY)}\n…(${fmtBytes(text.length - MAX_DISPLAY)} more — open JSON view for full content)`
}

function katexHtml(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex.trim(), {
      displayMode,
      throwOnError: false,
      strict: 'ignore',
      output: 'html'
    })
  } catch {
    const esc = tex.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    return displayMode ? `<pre class="math-fallback">${esc}</pre>` : `<code class="math-fallback">${esc}</code>`
  }
}

/** marked extensions for $...$, $$...$$, \\(...\\), \\[...\\] */
const mathExtension = {
  extensions: [
    {
      name: 'blockMath',
      level: 'block' as const,
      start(src: string) {
        const a = src.indexOf('$$')
        const b = src.indexOf('\\[')
        if (a === -1) return b === -1 ? undefined : b
        if (b === -1) return a
        return Math.min(a, b)
      },
      tokenizer(src: string) {
        let match = /^\$\$([\s\S]+?)\$\$/.exec(src)
        if (match) {
          return { type: 'blockMath', raw: match[0], text: match[1], tokens: [] as Tokens.Generic[] }
        }
        match = /^\\\[([\s\S]+?)\\\]/.exec(src)
        if (match) {
          return { type: 'blockMath', raw: match[0], text: match[1], tokens: [] as Tokens.Generic[] }
        }
        return undefined
      },
      renderer(token: Tokens.Generic) {
        return katexHtml(String(token.text ?? ''), true) + '\n'
      }
    },
    {
      name: 'inlineMath',
      level: 'inline' as const,
      start(src: string) {
        const a = src.indexOf('$')
        const b = src.indexOf('\\(')
        if (a === -1) return b === -1 ? undefined : b
        if (b === -1) return a
        return Math.min(a, b)
      },
      tokenizer(src: string) {
        if (src.startsWith('$$')) return undefined
        let match = /^\$([^$\n]+?)\$/.exec(src)
        if (match) {
          return { type: 'inlineMath', raw: match[0], text: match[1], tokens: [] as Tokens.Generic[] }
        }
        match = /^\\\(([\s\S]+?)\\\)/.exec(src)
        if (match) {
          return { type: 'inlineMath', raw: match[0], text: match[1], tokens: [] as Tokens.Generic[] }
        }
        return undefined
      },
      renderer(token: Tokens.Generic) {
        return katexHtml(String(token.text ?? ''), false)
      }
    }
  ]
}

marked.use(mathExtension)

function mdBody(text: string): ReactNode {
  const html = DOMPurify.sanitize(marked.parse(text, { async: false }) as string)
  return (
    <span
      className={styles["msg--md"]}
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
        className={m(styles, 'searchMark', ordinal === activeOrdinal && 'searchMark--active')}
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
  /** Role header (You / Assistant). False for follow-up assistant chunks in the same turn. */
  showHead?: boolean
}

export const NodeBubble = memo(function NodeBubble({
  node,
  searchQuery = '',
  hasSearchMatch = false,
  activeMatchOrdinal,
  blockOpenMode = 'default',
  showHead = true
}: NodeBubbleProps): JSX.Element {
  const text = displayNodeText(node.text)
  const defaultOpen = blockOpenMode === 'expanded' || (blockOpenMode === 'default' && hasSearchMatch)
  const bubbleClass = m(
    styles,
    'bubble',
    `bubble--${node.kind}`,
    node.inherited && 'bubble--inherited',
    hasSearchMatch && 'bubble--search-hit',
    activeMatchOrdinal !== undefined && 'bubble--search-active',
    !showHead && (node.kind === 'user' || node.kind === 'assistant') && 'bubble--cont'
  )

  if (node.kind === 'user' || node.kind === 'assistant') {
    const [title, nextOrdinal] = highlightedText(node.title ?? '', searchQuery, 0, activeMatchOrdinal)
    const body = searchQuery ? highlightedText(text, searchQuery, nextOrdinal, activeMatchOrdinal)[0] : mdBody(text)

    return (
      <div className={bubbleClass}>
        {showHead ? (
          <div className={styles['bubble__head']}>
            {node.inherited ? <span className={styles['bubble__inherit']}>Inherited</span> : null}
            <span className={styles['bubble__role']}>{node.kind === 'user' ? 'You' : title || 'Assistant'}</span>
          </div>
        ) : null}
        <div className={m(styles, 'bubble__text', 'msg')}>{body}</div>
      </div>
    )
  }

  const displayTitle = node.title || node.toolName || ''
  const [title, nextOrdinal] = highlightedText(displayTitle, searchQuery, 0, activeMatchOrdinal)
  const [body] = highlightedText(text, searchQuery, nextOrdinal, activeMatchOrdinal)

  return (
    <div className={bubbleClass}>
      <details className={m(styles, 'block', `block--${node.kind}`)} open={defaultOpen}>
        <summary className={m(styles, 'bubble__summary', 'block__summary')}>
          <span className={styles['block__tri']}>
            <Chevron />
          </span>
          <span className={m(styles, 'bubble__title', 'block__title')}>{title}</span>
          {node.inherited ? <span className={styles['bubble__inherit']}>Inherited</span> : null}
          <span className={m(styles, 'bubble__size', 'block__size')}>{fmtBytes(node.bytes)}</span>
        </summary>
        <pre className={m(styles, 'bubble__pre', 'block__body')}>{body}</pre>
      </details>
    </div>
  )
})

interface ToolGroupBubbleProps {
  nodes: ViewNode[]
  indexes: number[]
  searchQuery?: string
  searchHitsByNode: Map<number, Set<number>>
  activeMatch?: { nodeIndex: number; ordinalInNode: number } | null
  blockOpenMode?: 'default' | 'collapsed' | 'expanded'
  forceOpen?: boolean
}

/** Collapsed run of tool/thinking/system nodes — "N tool events". */
export const ToolGroupBubble = memo(function ToolGroupBubble({
  nodes,
  indexes,
  searchQuery = '',
  searchHitsByNode,
  activeMatch,
  blockOpenMode = 'default',
  forceOpen = false
}: ToolGroupBubbleProps): JSX.Element {
  const hasHit = indexes.some((i) => searchHitsByNode.has(i))
  const open =
    forceOpen ||
    blockOpenMode === 'expanded' ||
    (blockOpenMode === 'default' && hasHit) ||
    (activeMatch != null && indexes.includes(activeMatch.nodeIndex))

  return (
    <div className={m(styles, 'bubble', 'bubble--toolgroup', hasHit && 'bubble--search-hit')}>
      <details className={m(styles, 'block', 'block--toolgroup')} open={open}>
        <summary className={m(styles, 'bubble__summary', 'block__summary')}>
          <span className={styles['block__tri']}>
            <Chevron />
          </span>
          <span className={m(styles, 'bubble__title', 'block__title', 'block__title--group')}>
            {nodes.length} tool event{nodes.length === 1 ? '' : 's'}
          </span>
        </summary>
        <div className={styles['toolgroup__body']}>
          {nodes.map((node, i) => {
            const nodeIndex = indexes[i]
            const hitOrdinals = searchHitsByNode.get(nodeIndex)
            const activeOrdinal = activeMatch?.nodeIndex === nodeIndex ? activeMatch.ordinalInNode : undefined
            return (
              <NodeBubble
                key={node.id}
                node={node}
                searchQuery={searchQuery}
                hasSearchMatch={!!hitOrdinals}
                activeMatchOrdinal={activeOrdinal}
                blockOpenMode={blockOpenMode === 'expanded' || hasHit ? 'expanded' : 'default'}
              />
            )
          })}
        </div>
      </details>
    </div>
  )
})

export { styles as bubbleStyles }
