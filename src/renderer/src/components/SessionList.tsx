import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef, type MouseEvent } from 'react'
import type { SessionMeta } from '../../../shared/ipc'
import { type DisplayRow, metaKey } from '../util'
import { Tri } from './MacIcons'
import { SessionRow } from './SessionRow'

interface Props {
  rows: DisplayRow[]
  selectedKey: string | null
  removingKeys: Set<string>
  onSelect: (s: SessionMeta) => void
  onContextMenu: (s: SessionMeta, point: { x: number; y: number }) => void
  onToggle: (id: string) => void
  onToggleGroup: (id: string) => void
}

export function SessionList({
  rows,
  selectedKey,
  removingKeys,
  onSelect,
  onContextMenu,
  onToggle,
  onToggleGroup
}: Props): JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (rows[index]?.kind === 'group' ? 34 : 54),
    overscan: 12
  })

  if (rows.length === 0) {
    return <div className="list list--empty">No sessions match.</div>
  }

  function openContextMenu(session: SessionMeta, event: MouseEvent<HTMLDivElement>): void {
    onContextMenu(session, { x: event.clientX, y: event.clientY })
  }

  return (
    <div className="list" ref={parentRef}>
      <div style={{ height: virt.getTotalSize(), position: 'relative', width: '100%' }}>
        {virt.getVirtualItems().map((item) => {
          const row = rows[item.index]
          const key =
            row.kind === 'group'
              ? row.id
              : `${metaKey(row.session)}:${row.depth}`

          return (
            <div
              key={key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: item.size,
                transform: `translateY(${item.start}px)`
              }}
            >
              {row.kind === 'group' ? (
                <div className={`group-row grouphdr${row.collapsed ? ' grouphdr--closed' : ''}`}>
                  <button
                    className={`group-row__caret grouphdr__tri${row.collapsed ? '' : ' group-row__caret--open'}`}
                    type="button"
                    onClick={() => onToggleGroup(row.id)}
                    title={row.collapsed ? 'Expand group' : 'Collapse group'}
                  >
                    <Tri />
                  </button>
                  <span className="group-row__title grouphdr__title">{row.title}</span>
                  <span className="group-row__count grouphdr__count">{row.count}</span>
                </div>
              ) : (
                <SessionRow
                  session={row.session}
                  selected={metaKey(row.session) === selectedKey}
                  removing={removingKeys.has(metaKey(row.session))}
                  depth={row.depth}
                  hasChildren={row.hasChildren}
                  expanded={row.expanded}
                  onClick={() => onSelect(row.session)}
                  onContextMenu={(event) => openContextMenu(row.session, event)}
                  onToggle={() => onToggle(row.session.id)}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
