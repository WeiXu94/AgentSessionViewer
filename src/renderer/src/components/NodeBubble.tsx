import { memo } from 'react'
import type { ViewNode } from '../../../shared/ipc'
import { fmtBytes } from '../util'

const MAX_DISPLAY = 200_000

function clamp(text: string): string {
  if (text.length <= MAX_DISPLAY) return text
  return `${text.slice(0, MAX_DISPLAY)}\n…(${fmtBytes(text.length - MAX_DISPLAY)} more — open JSON view for full content)`
}

const ICON: Record<string, string> = {
  system: '#',
  tool_call: '⚙',
  tool_result: '↳',
  thinking: '✦'
}

export const NodeBubble = memo(function NodeBubble({ node }: { node: ViewNode }): JSX.Element {
  const text = clamp(node.text)

  if (node.kind === 'user' || node.kind === 'assistant' || node.kind === 'meta') {
    return (
      <div className={`bubble bubble--${node.kind}`}>
        <div className="bubble__head">{node.title}</div>
        <div className="bubble__text">{text}</div>
      </div>
    )
  }

  // system / thinking / tool_call / tool_result — collapsible
  const defaultOpen = node.bytes <= 12_000
  return (
    <div className={`bubble bubble--${node.kind}`}>
      <details open={defaultOpen}>
        <summary className="bubble__summary">
          <span className="bubble__icon">{ICON[node.kind] ?? '•'}</span>
          <span className="bubble__title">{node.title || node.toolName}</span>
          <span className="bubble__size">{fmtBytes(node.bytes)}</span>
        </summary>
        <pre className="bubble__pre">{text}</pre>
      </details>
    </div>
  )
})
