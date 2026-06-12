import { Fragment, useEffect, useRef, type ReactNode } from 'react'
import type { GlobalSearchGroup, GlobalSearchMatch, GlobalSearchResponse, SearchIndexProgress } from '../../../shared/ipc'
import { fmtTime, sessionTitle, sourceColor, sourceName } from '../util'

export interface FlatSearchRow {
  group: GlobalSearchGroup
  match: GlobalSearchMatch
}

interface Props {
  response: GlobalSearchResponse | null
  loading: boolean
  query: string
  scopeLabel: string
  activeIndex: number
  progress: SearchIndexProgress
  onHover: (index: number) => void
  onOpen: (row: FlatSearchRow) => void
}

/** Render an FTS5 snippet, turning the \x02…\x03 marker pairs into <mark>. */
function renderSnippet(snippet: string): ReactNode[] {
  const clean = snippet.replace(/\s+/gu, ' ')
  const parts: ReactNode[] = []
  const segments = clean.split('\x02')
  parts.push(segments[0])
  for (let i = 1; i < segments.length; i++) {
    const end = segments[i].indexOf('\x03')
    if (end === -1) {
      parts.push(segments[i])
      continue
    }
    parts.push(<mark key={i}>{segments[i].slice(0, end)}</mark>)
    parts.push(segments[i].slice(end + 1))
  }
  return parts
}

export function GlobalSearch({
  response,
  loading,
  query,
  scopeLabel,
  activeIndex,
  progress,
  onHover,
  onOpen
}: Props): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const active = listRef.current?.querySelector('[data-active="true"]')
    active?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const tooShort = query.trim().length < 2
  const groups = response?.groups ?? []
  const totalMatches = groups.reduce((n, g) => n + g.totalMatches, 0)
  const indexing = !progress.done || !!response?.indexing

  let body: ReactNode
  if (response && !response.available) {
    body = <div className="globalSearch__empty">Full-text index unavailable (node:sqlite missing).</div>
  } else if (tooShort) {
    body = <div className="globalSearch__empty">Type at least 2 characters to search {scopeLabel}.</div>
  } else if (groups.length === 0) {
    body = (
      <div className="globalSearch__empty">
        {loading ? 'Searching…' : `No matches in ${scopeLabel}.`}
      </div>
    )
  } else {
    let rowIndex = -1
    body = (
      <div className="globalSearch__list" ref={listRef}>
        {groups.map((group) => (
          <Fragment key={`${group.session.source}:${group.session.id}`}>
            <div className="globalSearch__session">
              <span className="globalSearch__badge" style={{ color: sourceColor(group.session.source) }}>
                {sourceName(group.session.source)}
              </span>
              <span className="globalSearch__title" title={sessionTitle(group.session)}>
                {sessionTitle(group.session)}
              </span>
              {group.session.variantLabel ? <span className="vchip">{group.session.variantLabel}</span> : null}
              {group.session.repo ? <span className="globalSearch__repo">{group.session.repo}</span> : null}
              <span className="globalSearch__time">{fmtTime(group.session.updatedAt)}</span>
            </div>
            {group.matches.map((match, i) => {
              rowIndex++
              const index = rowIndex
              return (
                <button
                  key={`${match.nodeIndex}:${i}`}
                  type="button"
                  className={`globalSearch__row${index === activeIndex ? ' globalSearch__row--active' : ''}`}
                  data-active={index === activeIndex || undefined}
                  onMouseMove={() => onHover(index)}
                  onClick={() => onOpen({ group, match })}
                >
                  <span className={`globalSearch__kind globalSearch__kind--${match.kind}`}>
                    {match.kind === 'user' ? 'You' : 'AI'}
                  </span>
                  <span className="globalSearch__snippet">{renderSnippet(match.snippet)}</span>
                </button>
              )
            })}
            {group.totalMatches > group.matches.length ? (
              <div className="globalSearch__more">
                +{group.totalMatches - group.matches.length} more in this session
              </div>
            ) : null}
          </Fragment>
        ))}
      </div>
    )
  }

  return (
    <div className="globalSearch" role="listbox" onMouseDown={(e) => e.preventDefault() /* keep input focus */}>
      {body}
      <div className="globalSearch__foot">
        <span>
          {groups.length > 0 ? `${totalMatches} matches in ${groups.length} sessions · ${scopeLabel}` : scopeLabel}
        </span>
        {indexing ? (
          <span className="globalSearch__indexing">
            Indexing {progress.indexed}/{progress.total}…
          </span>
        ) : loading ? (
          <span className="globalSearch__indexing">Searching…</span>
        ) : null}
      </div>
    </div>
  )
}
