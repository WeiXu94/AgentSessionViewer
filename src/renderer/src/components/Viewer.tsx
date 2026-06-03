import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { SessionMeta, TranscriptPayload, ViewNode } from '../../../shared/ipc'
import { fmtBytes, fmtTime, sessionTitle, sourceColor, sourceName } from '../util'
import { JsonView } from './JsonView'
import { displayNodeText } from './NodeBubble'
import { SessionView, type SessionSearchMatch } from './SessionView'

interface Props {
  session: SessionMeta | null
  transcript: TranscriptPayload | null
  loading: boolean
  tab: 'session' | 'json'
  setTab: (t: 'session' | 'json') => void
  onReveal: () => void
}

function countPartMatches(
  text: string,
  query: string,
  startOrdinal: number,
  nodeIndex: number,
  matches: SessionSearchMatch[]
): number {
  if (!query) return startOrdinal

  const lower = text.toLowerCase()
  let from = 0
  let ordinal = startOrdinal

  for (;;) {
    const index = lower.indexOf(query, from)
    if (index === -1) break
    matches.push({ nodeIndex, ordinalInNode: ordinal })
    ordinal++
    from = index + query.length
  }

  return ordinal
}

function buildSearchMatches(nodes: ViewNode[], rawQuery: string): SessionSearchMatch[] {
  const query = rawQuery.trim().toLowerCase()
  if (!query) return []

  const matches: SessionSearchMatch[] = []
  nodes.forEach((node, nodeIndex) => {
    const displayTitle = node.title || node.toolName || ''
    const bodyStartOrdinal = countPartMatches(displayTitle, query, 0, nodeIndex, matches)
    countPartMatches(displayNodeText(node.text), query, bodyStartOrdinal, nodeIndex, matches)
  })
  return matches
}

function SearchIcon(): JSX.Element {
  return (
    <svg className="viewerSearch__icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.25 10.25 3 3" />
    </svg>
  )
}

function ChevronUpIcon(): JSX.Element {
  return (
    <svg className="viewerSearch__btnIcon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m4.5 9.5 3.5-3.5 3.5 3.5" />
    </svg>
  )
}

function ChevronDownIcon(): JSX.Element {
  return (
    <svg className="viewerSearch__btnIcon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
    </svg>
  )
}

function CloseIcon(): JSX.Element {
  return (
    <svg className="viewerSearch__btnIcon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m5 5 6 6" />
      <path d="m11 5-6 6" />
    </svg>
  )
}

export function Viewer({ session, transcript, loading, tab, setTab, onReveal }: Props): JSX.Element {
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [searchText, setSearchText] = useState('')
  const [activeMatchIndex, setActiveMatchIndex] = useState(0)
  const searchQuery = searchText.trim()
  const searchMatches = useMemo(
    () => (transcript ? buildSearchMatches(transcript.nodes, searchQuery) : []),
    [transcript?.nodes, searchQuery]
  )
  const activeSearchIndex = searchMatches.length ? Math.min(activeMatchIndex, searchMatches.length - 1) : -1
  const activeMatch = activeSearchIndex >= 0 ? searchMatches[activeSearchIndex] : null
  const searchHitsByNode = useMemo(() => {
    const hits = new Map<number, Set<number>>()
    for (const match of searchMatches) {
      const ordinals = hits.get(match.nodeIndex) ?? new Set<number>()
      ordinals.add(match.ordinalInNode)
      hits.set(match.nodeIndex, ordinals)
    }
    return hits
  }, [searchMatches])

  const moveSearch = useCallback(
    (delta: number): void => {
      if (searchMatches.length === 0) return
      setTab('session')
      setActiveMatchIndex((prev) => (prev + delta + searchMatches.length) % searchMatches.length)
    },
    [searchMatches.length, setTab]
  )

  useEffect(() => {
    setSearchText('')
    setActiveMatchIndex(0)
  }, [session?.source, session?.id])

  useEffect(() => {
    setActiveMatchIndex(0)
  }, [transcript?.nodes, searchQuery])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setTab('session')
        requestAnimationFrame(() => {
          searchInputRef.current?.focus()
          searchInputRef.current?.select()
        })
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setTab])

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      moveSearch(event.shiftKey ? -1 : 1)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      if (searchText) setSearchText('')
      else event.currentTarget.blur()
    }
  }

  if (!session) {
    return <div className="viewer viewer--empty">Select a session to view its transcript.</div>
  }

  return (
    <div className="viewer">
      <header className="viewer__header">
        <div className="viewer__title">{sessionTitle(session)}</div>
        <div className="viewer__sub">
          <span className="badge" style={{ color: sourceColor(session.source) }}>
            {sourceName(session.source)}
          </span>
          {session.variantLabel ? <span className="vchip">{session.variantLabel}</span> : null}
          {session.repo ? <span>{session.repo}</span> : null}
          {session.branch ? <span>⎇ {session.branch}</span> : null}
          {session.model ? <span>{session.model}</span> : null}
          <span>{fmtTime(session.updatedAt)}</span>
          <span>{fmtBytes(session.bytes)}</span>
        </div>
        <div className="viewer__path" onClick={onReveal} title="Reveal in Finder">
          {session.originalPath}
        </div>
      </header>

      <div className="tabs">
        <button className={`tab${tab === 'session' ? ' tab--active' : ''}`} onClick={() => setTab('session')}>
          Session{transcript ? ` · ${transcript.nodes.length}` : ''}
        </button>
        <button className={`tab${tab === 'json' ? ' tab--active' : ''}`} onClick={() => setTab('json')}>
          JSON{transcript ? ` · ${transcript.records.length}` : ''}
        </button>
        {transcript?.truncated ? <span className="warn">file truncated</span> : null}
        <span className="tabs__spacer" />
        {transcript && !transcript.error ? (
          <div className="viewerSearch">
            <SearchIcon />
            <input
              ref={searchInputRef}
              className="viewerSearch__input"
              value={searchText}
              onFocus={() => setTab('session')}
              onChange={(event) => {
                setTab('session')
                setSearchText(event.target.value)
              }}
              onKeyDown={onSearchKeyDown}
              placeholder="Find in session"
              spellCheck={false}
            />
            <span className="viewerSearch__count">
              {searchQuery ? (searchMatches.length ? `${activeSearchIndex + 1}/${searchMatches.length}` : '0/0') : ''}
            </span>
            <button
              className="viewerSearch__btn"
              type="button"
              disabled={searchMatches.length === 0}
              title="Previous match"
              aria-label="Previous match"
              onClick={() => moveSearch(-1)}
            >
              <ChevronUpIcon />
            </button>
            <button
              className="viewerSearch__btn"
              type="button"
              disabled={searchMatches.length === 0}
              title="Next match"
              aria-label="Next match"
              onClick={() => moveSearch(1)}
            >
              <ChevronDownIcon />
            </button>
            <button
              className="viewerSearch__btn"
              type="button"
              disabled={!searchText}
              title="Clear search"
              aria-label="Clear search"
              onClick={() => {
                setSearchText('')
                searchInputRef.current?.focus()
              }}
            >
              <CloseIcon />
            </button>
          </div>
        ) : null}
      </div>

      <div className="viewer__body">
        {loading ? (
          <div className="loading">Loading transcript…</div>
        ) : transcript?.error ? (
          <div className="error">Failed to load: {transcript.error}</div>
        ) : !transcript ? null : tab === 'session' ? (
          <SessionView
            nodes={transcript.nodes}
            searchQuery={searchQuery}
            searchHitsByNode={searchHitsByNode}
            activeMatch={activeMatch}
          />
        ) : (
          <JsonView records={transcript.records} reconstructed={transcript.reconstructed} />
        )}
      </div>
    </div>
  )
}
