import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef } from 'react'
import type { ViewNode } from '../../../shared/ipc'
import { NodeBubble } from './NodeBubble'

export function SessionView({ nodes }: { nodes: ViewNode[] }): JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({
    count: nodes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 140,
    overscan: 6,
    measureElement: (el) => el?.getBoundingClientRect().height ?? 140
  })

  if (nodes.length === 0) {
    return <div className="transcript transcript--empty">No renderable messages in this session.</div>
  }

  return (
    <div className="transcript" ref={parentRef}>
      <div style={{ height: virt.getTotalSize(), position: 'relative', width: '100%' }}>
        {virt.getVirtualItems().map((item) => (
          <div
            key={item.key}
            data-index={item.index}
            ref={virt.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${item.start}px)`
            }}
          >
            <NodeBubble node={nodes[item.index]} />
          </div>
        ))}
      </div>
    </div>
  )
}
