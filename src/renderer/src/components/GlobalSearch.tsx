import { Fragment, useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { GlobalSearchGroup, GlobalSearchMatch, GlobalSearchResponse, SearchIndexProgress } from '../../../shared/ipc'
import { fmtTime, sessionTitle, sourceColor, sourceName } from '../util'
import { MacIcon } from './MacIcons'

export type SearchScope = 'all' | 'project' | 'session'

export interface FlatSearchRow {
  group: GlobalSearchGroup
  match: GlobalSearchMatch
}

const MARK_START = String.fromCharCode(2)
const MARK_END = String.fromCharCode(3)

interface Props {
  query: string
  onQuery: (value: string) => void
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  scope: SearchScope
  onScope: (scope: SearchScope) => void
  projectLabel: string | null
  hasSession: boolean
  wholeWord: boolean
  onWholeWord: (value: boolean) => void
  response: GlobalSearchResponse | null
  loading: boolean
  scopeLabel: string
  activeIndex: number
  progress: SearchIndexProgress
  inputRef: RefObject<HTMLInputElement>
  onHover: (index: number) => void
  onOpen: (row: FlatSearchRow) => void
  onClose: () => void
}

/** Render an FTS5 snippet, turning the char(2)…char(3) marker pairs into <mark>. */
function renderSnippet(snippet: string): ReactNode[] {
  const clean = snippet.replace(/\s+/gu, ' ')
  const parts: ReactNode[] = []
  const segments = clean.split(MARK_START)
  parts.push(segments[0])
  for (let i = 1; i < segments.length; i++) {
    const end = segments[i].indexOf(MARK_END)
    if (end === -1) {
      parts.push(segments[i])
      continue
    }
    parts.push(<mark key={i}>{segments[i].slice(0, end)}</mark>)
    parts.push(segments[i].slice(end + 1))
  }
  return parts
}

function matchLabel(kind: GlobalSearchMatch['kind']): string {
  if (kind === 'title') return 'Title'
  return kind === 'user' ? 'You' : 'AI'
}

export function GlobalSearch({
  query,
  onQuery,
  onKeyDown,
  scope,
  onScope,
  projectLabel,
  hasSession,
  wholeWord,
  onWholeWord,
  response,
  loading,
  scopeLabel,
  activeIndex,
  progress,
  inputRef,
  onHover,
  onOpen,
  onClose
}: Props): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const active = listRef.current?.querySelector('[data-active="true"]')
    active?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const trimmed = query.trim()
  const tooShort = trimmed.length < (scope === 'session' ? 1 : 2)
  const groups = response?.groups ?? []
  const totalMatches = groups.reduce((n, g) => n + g.totalMatches, 0)
  const indexing = scope !== 'session' && (!progress.done || !!response?.indexing)

  const SCOPES: Array<{ value: SearchScope; label: string; disabled?: boolean }> = [
    { value: 'all', label: 'All sessions' },
    { value: 'project', label: projectLabel ? `Project · ${projectLabel}` : 'This project', disabled: !projectLabel },
    { value: 'session', label: 'This session', disabled: !hasSession }
  ]

  let body: ReactNode
  if (response && !response.available) {
    body = <div className="globalSearch__empty">Full-text index unavailable (node:sqlite missing).</div>
  } else if (scope === 'session' && !hasSession) {
    body = <div className="globalSearch__empty">Open a session to search inside it.</div>
  } else if (!trimmed) {
    body = <div className="globalSearch__empty">Search across {scopeLabel}.</div>
  } else if (tooShort) {
    body = <div className="globalSearch__empty">Type at least 2 characters to search {scopeLabel}.</div>
  } else if (groups.length === 0) {
    body = <div className="globalSearch__empty">{loading ? 'Searching…' : `No matches in ${scopeLabel}.`}</div>
  } else {
    let rowIndex = -1
    body = (
      <div className="globalSearch__list" ref={listRef}>
        {groups.map((group) => (
          <Fragment key={`${group.session.source}:${group.session.id}:${group.session.originalPath}`}>
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
                  key={`${match.kind}:${match.nodeIndex}:${i}`}
                  type="button"
                  className={`globalSearch__row${index === activeIndex ? ' globalSearch__row--active' : ''}`}
                  data-active={index === activeIndex || undefined}
                  onMouseMove={() => onHover(index)}
                  onClick={() => onOpen({ group, match })}
                >
                  <span className={`globalSearch__kind globalSearch__kind--${match.kind}`}>{matchLabel(match.kind)}</span>
                  <span className="globalSearch__snippet">{renderSnippet(match.snippet)}</span>
                </button>
              )
            })}
            {group.totalMatches > group.matches.length ? (
              <div className="globalSearch__more">+{group.totalMatches - group.matches.length} more in this session</div>
            ) : null}
          </Fragment>
        ))}
      </div>
    )
  }

  return (
    <div className="searchModal__backdrop" onMouseDown={onClose}>
      <div
        className="searchModal"
        role="dialog"
        aria-modal="true"
        aria-label="Search sessions"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="searchModal__head">
          <MacIcon name="search" className="searchModal__icon" />
          <input
            ref={inputRef}
            className="searchModal__input"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              scope === 'session' ? 'Find in this session' : scope === 'project' ? 'Search this project' : 'Search all sessions'
            }
            spellCheck={false}
            autoFocus
          />
          <button className="searchModal__close" type="button" onClick={onClose} title="Close" aria-label="Close search">
            <MacIcon name="close" />
          </button>
        </div>

        <div className="searchModal__controls">
          <div className="searchModal__scopes" role="tablist" aria-label="Search scope">
            {SCOPES.map((s) => (
              <button
                key={s.value}
                type="button"
                role="tab"
                aria-selected={scope === s.value}
                disabled={s.disabled}
                className={`searchModal__scope${scope === s.value ? ' searchModal__scope--on' : ''}`}
                onClick={() => onScope(s.value)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`searchModal__opt${wholeWord ? ' searchModal__opt--on' : ''}`}
            aria-pressed={wholeWord}
            title="Match whole word"
            onClick={() => onWholeWord(!wholeWord)}
          >
            <span className="searchModal__optCheck">{wholeWord ? <MacIcon name="check" /> : null}</span>
            Whole word
          </button>
        </div>

        {body}

        <div className="globalSearch__foot">
          <span>{groups.length > 0 ? `${totalMatches} matches in ${groups.length} sessions · ${scopeLabel}` : scopeLabel}</span>
          {indexing ? (
            <span className="globalSearch__indexing">
              Indexing {progress.indexed}/{progress.total}…
            </span>
          ) : loading ? (
            <span className="globalSearch__indexing">Searching…</span>
          ) : null}
        </div>
      </div>
    </div>
  )
}
