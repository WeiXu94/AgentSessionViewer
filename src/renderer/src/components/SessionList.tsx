import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef } from 'react'
import type { SessionMeta } from '../../../shared/ipc'
import { type DisplayRow, metaKey } from '../util'
import { SessionRow } from './SessionRow'

interface Props {
  rows: DisplayRow[]
  selectedKey: string | null
  onSelect: (s: SessionMeta) => void
  onContextMenu: (s: SessionMeta) => void
  onToggle: (id: string) => void
}

export function SessionList({ rows, selectedKey, onSelect, onContextMenu, onToggle }: Props): JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 62,
    overscan: 12
  })

  if (rows.length === 0) {
    return <div className="list list--empty">No sessions match.</div>
  }

  return (
    <div className="list" ref={parentRef}>
      <div style={{ height: virt.getTotalSize(), position: 'relative', width: '100%' }}>
        {virt.getVirtualItems().map((item) => {
          const row = rows[item.index]
          const s = row.session
          return (
            <div
              key={`${metaKey(s)}:${row.depth}`}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: item.size,
                transform: `translateY(${item.start}px)`
              }}
            >
              <SessionRow
                session={s}
                selected={metaKey(s) === selectedKey}
                depth={row.depth}
                hasChildren={row.hasChildren}
                expanded={row.expanded}
                onClick={() => onSelect(s)}
                onContextMenu={() => onContextMenu(s)}
                onToggle={() => onToggle(s.id)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
