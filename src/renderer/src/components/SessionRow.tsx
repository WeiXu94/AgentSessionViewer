import { memo, type MouseEvent } from 'react'
import type { SessionMeta } from '../../../shared/ipc'
import { fmtTime, sessionTitle, sourceColor, sourceName } from '../util'

interface Props {
  session: SessionMeta
  selected: boolean
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
      className={`row${selected ? ' row--selected' : ''}${isSub ? ' row--sub' : ''}`}
      style={{ paddingLeft: 6 + depth * 18 }}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu(e)
      }}
      title={session.cwd || session.originalPath}
    >
      {hasChildren ? (
        <button
          className={`row__caret${expanded ? ' row__caret--open' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
          title={expanded ? 'Collapse subagents' : 'Expand subagents'}
        >
          ▶
        </button>
      ) : (
        <span className="row__caret row__caret--spacer" />
      )}
      <span className="row__bar" style={{ background: sourceColor(session.source) }} />
      <div className="row__main">
        <div className="row__title">{sessionTitle(session)}</div>
        <div className="row__meta">
          {isSub ? (
            <span className="vchip vchip--sub">{session.variantLabel || 'subagent'}</span>
          ) : (
            <>
              <span className="badge" style={{ color: sourceColor(session.source) }}>
                {sourceName(session.source)}
              </span>
              {session.variantLabel ? <span className="vchip">{session.variantLabel}</span> : null}
              {session.forkParentId ? <span className="vchip">fork</span> : null}
            </>
          )}
          {session.repo ? <span className="row__repo">{session.repo}</span> : null}
          <span className="row__spacer" />
          <span className="row__time">{fmtTime(session.updatedAt)}</span>
        </div>
      </div>
    </div>
  )
})
