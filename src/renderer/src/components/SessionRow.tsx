import { memo, type KeyboardEvent, type MouseEvent } from 'react'
import type { SessionMeta } from '../../../shared/ipc'
import { fmtTimeShort, sessionTitle } from '../util'
import { cx, m } from '../styles/cx'
import { Tri } from './MacIcons'
import styles from './SessionList.module.css'

interface Props {
  session: SessionMeta
  selected: boolean
  removing: boolean
  depth: number
  hasChildren: boolean
  expanded: boolean
  onClick: () => void
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void
  onToggle: () => void
}

export const SessionRow = memo(function SessionRow({
  session,
  selected,
  removing,
  depth,
  hasChildren,
  expanded,
  onClick,
  onContextMenu,
  onToggle
}: Props) {
  const isSub = session.variant === 'subagent'
  return (
    <div
      className={m(
        styles,
        'row',
        selected && 'row--selected',
        isSub && 'row--sub',
        removing && 'row--removing'
      )}
      style={{ paddingLeft: 12 + depth * 16 }}
      role="button"
      tabIndex={0}
      aria-current={selected || undefined}
      onClick={onClick}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault()
        onClick()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu(e)
      }}
      title={session.cwd || session.originalPath}
    >
      {hasChildren ? (
        <button
          type="button"
          className={m(styles, 'row__caret', expanded && 'row__caret--open')}
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
          title={expanded ? 'Collapse subagents' : 'Expand subagents'}
        >
          <Tri />
        </button>
      ) : null}
      <div className={styles['row__main']}>
        <div className={styles['row__line1']}>
          <span className={styles['row__title']}>{sessionTitle(session)}</span>
          <span className={styles['row__time']}>{fmtTimeShort(session.updatedAt)}</span>
        </div>
        {isSub && session.variantLabel ? (
          <div className={cx(styles['row__meta'], styles['row__line2'])}>
            <span className={cx(styles.vchip, styles['vchip--sub'])}>{session.variantLabel}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
})
