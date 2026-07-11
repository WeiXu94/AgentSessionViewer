import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef, type MouseEvent } from 'react'
import type { SessionMeta } from '../../../shared/ipc'
import { type DisplayRow, metaKey } from '../util'
import { m } from '../styles/cx'
import { Tri } from './MacIcons'
import { SessionRow } from './SessionRow'
import styles from './SessionList.module.css'

interface Props {
  rows: DisplayRow[]
  selectedKey: string | null
  removingKeys: Set<string>
  /** When true, session rows sit indented under group headers. */
  grouped?: boolean
  onSelect: (s: SessionMeta) => void
  onContextMenu: (s: SessionMeta, point: { x: number; y: number }) => void
  onToggle: (id: string) => void
  onToggleGroup: (id: string) => void
}

export function SessionList({
  rows,
  selectedKey,
  removingKeys,
  grouped = false,
  onSelect,
  onContextMenu,
  onToggle,
  onToggleGroup
}: Props): JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (rows[index]?.kind === 'group' ? 30 : 40),
    overscan: 12
  })

  const virtRef = useRef(virt)
  virtRef.current = virt

  useEffect(() => {
    if (!selectedKey) return
    const index = rows.findIndex(
      (r) => r.kind === 'session' && metaKey(r.session) === selectedKey
    )
    if (index < 0) return
    const visible = virtRef.current.getVirtualItems().some((item) => item.index === index)
    if (!visible) {
      virtRef.current.scrollToIndex(index, { align: 'center' })
    }
  }, [selectedKey, rows])

  if (rows.length === 0) {
    return <div className={m(styles, 'list', 'list--empty')}>No sessions match.</div>
  }

  function openContextMenu(session: SessionMeta, event: MouseEvent<HTMLDivElement>): void {
    onContextMenu(session, { x: event.clientX, y: event.clientY })
  }

  return (
    <div className={styles.list} ref={parentRef}>
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
                <div className={m(styles, 'group-row', 'grouphdr', row.collapsed && 'grouphdr--closed')}>
                  <button
                    className={m(styles, 'group-row__caret', 'grouphdr__tri', !row.collapsed && 'group-row__caret--open')}
                    type="button"
                    onClick={() => onToggleGroup(row.id)}
                    title={row.collapsed ? 'Expand group' : 'Collapse group'}
                  >
                    <Tri />
                  </button>
                  <span className={m(styles, 'group-row__title', 'grouphdr__title')}>{row.title}</span>
                  <span className={m(styles, 'group-row__count', 'grouphdr__count')}>{row.count}</span>
                </div>
              ) : (
                <SessionRow
                  session={row.session}
                  selected={metaKey(row.session) === selectedKey}
                  removing={removingKeys.has(metaKey(row.session))}
                  depth={row.depth + (grouped ? 1 : 0)}
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
