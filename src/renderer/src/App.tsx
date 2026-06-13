import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import type {
  GlobalSearchGroup,
  GlobalSearchMatch,
  GlobalSearchResponse,
  SearchIndexProgress,
  SearchScopeFilter,
  SessionMeta,
  TranscriptPayload,
  ViewNode
} from '../../shared/ipc'
import { FilterBar } from './components/FilterBar'
import { GlobalSearch, type FlatSearchRow, type SearchScope } from './components/GlobalSearch'
import { MacIcon } from './components/MacIcons'
import { displayNodeText } from './components/NodeBubble'
import { SessionList } from './components/SessionList'
import { Viewer } from './components/Viewer'
import { accentForeground, buildRows, type GroupMode, metaKey } from './util'

type RowMenuAction = 'copy-resume' | 'copy-id' | 'copy-path' | 'reveal' | 'open-cwd' | 'filter-project'

interface RowMenuState {
  session: SessionMeta
  x: number
  y: number
}

interface SessionSearchMatch {
  nodeIndex: number
  ordinalInNode: number
}

// Snippet highlight markers — the same pair GlobalSearch splits on. Built from
// char codes so no literal control bytes land in the source file.
const MARK_START = String.fromCharCode(2)
const MARK_END = String.fromCharCode(3)
const SNIPPET_RADIUS = 48
const LOCAL_MATCHES_SHOWN = 50

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

function searchRegex(query: string, wholeWord: boolean, matchCase: boolean): RegExp | null {
  const q = query.trim()
  if (!q) return null
  const esc = q.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  try {
    return new RegExp(wholeWord ? `\\b${esc}\\b` : esc, matchCase ? 'gu' : 'giu')
  } catch {
    return null
  }
}

function makeSnippet(text: string, start: number, len: number): string {
  const from = Math.max(0, start - SNIPPET_RADIUS)
  const to = Math.min(text.length, start + len + SNIPPET_RADIUS)
  const pre = (from > 0 ? '… ' : '') + text.slice(from, start)
  const hit = text.slice(start, start + len)
  const post = text.slice(start + len, to) + (to < text.length ? ' …' : '')
  return pre + MARK_START + hit + MARK_END + post
}

/**
 * Build a search-result response for the currently open transcript. Runs over
 * every node (so it covers tool output too, unlike the user/assistant-only FTS
 * index) and produces one result row per matching node.
 */
function buildLocalResponse(
  session: SessionMeta,
  nodes: ViewNode[],
  query: string,
  wholeWord: boolean,
  matchCase: boolean
): GlobalSearchResponse {
  const re = searchRegex(query, wholeWord, matchCase)
  if (!re) return { available: true, indexing: false, groups: [], totalSessions: 0 }

  const matches: GlobalSearchMatch[] = []
  nodes.forEach((node, nodeIndex) => {
    const body = displayNodeText(node.text)
    if (!body) return
    re.lastIndex = 0
    let firstSnippet: string | null = null
    let m: RegExpExecArray | null
    while ((m = re.exec(body)) !== null) {
      if (!firstSnippet) firstSnippet = makeSnippet(body, m.index, m[0].length)
      if (m.index === re.lastIndex) re.lastIndex++ // guard against zero-length matches
      if (firstSnippet) break // one row per node is enough for the list
    }
    if (firstSnippet) {
      matches.push({ nodeIndex, kind: node.kind === 'user' ? 'user' : 'assistant', snippet: firstSnippet })
    }
  })

  if (matches.length === 0) return { available: true, indexing: false, groups: [], totalSessions: 0 }
  const group: GlobalSearchGroup = {
    session,
    matches: matches.slice(0, LOCAL_MATCHES_SHOWN),
    totalMatches: matches.length
  }
  return { available: true, indexing: false, groups: [group], totalSessions: 1 }
}

export function App(): JSX.Element {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [selected, setSelected] = useState<SessionMeta | null>(null)
  const [transcript, setTranscript] = useState<TranscriptPayload | null>(null)
  const [loadingTx, setLoadingTx] = useState(false)
  const [tab, setTab] = useState<'session' | 'json'>('session')

  const [source, setSource] = useState('')
  const [project, setProject] = useState('')
  const [sidebarW, setSidebarW] = useState(380)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [groupMode, setGroupMode] = useState<GroupMode>('chronological')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null)
  const [activeMatchIndex, setActiveMatchIndex] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  // Unified search (modal). One query drives all three scopes.
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [searchScope, setSearchScope] = useState<SearchScope>('all')
  const [wholeWord, setWholeWord] = useState(false)
  const [matchCase, setMatchCase] = useState(false)
  const [globalResults, setGlobalResults] = useState<GlobalSearchResponse | null>(null)
  const [globalLoading, setGlobalLoading] = useState(false)
  const [activeResultIndex, setActiveResultIndex] = useState(0)
  const [indexProgress, setIndexProgress] = useState<SearchIndexProgress>({ indexed: 0, total: 0, done: true })
  const [pendingJump, setPendingJump] = useState<{ key: string; nodeIndex: number } | null>(null)
  const [scrollTarget, setScrollTarget] = useState<{ index: number; token: number; query: string } | null>(null)
  // Identity (metaKey) of the session whose transcript is currently in `transcript`.
  // null while loading — a queued jump waits for this to match its target.
  const [transcriptKey, setTranscriptKey] = useState<string | null>(null)

  const reqRef = useRef(0)
  const globalReqRef = useRef(0)
  const scrollTokenRef = useRef(0)
  const pendingJumpRef = useRef<{ key: string; nodeIndex: number } | null>(null)
  pendingJumpRef.current = pendingJump
  const rowMenuRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  async function refresh(force = false): Promise<void> {
    setLoadingList(true)
    setRefreshing(true)
    const list = await window.api.list(force)
    setSessions(list)
    setLoadingList(false)
    window.setTimeout(() => setRefreshing(false), 260)
  }

  useEffect(() => {
    void refresh(false)
  }, [])

  useEffect(() => {
    let disposed = false
    const applyAccent = (accent: string): void => {
      if (!/^#[\da-f]{6}$/iu.test(accent)) return
      document.documentElement.style.setProperty('--accent', accent)
      document.documentElement.style.setProperty('--accent-fg', accentForeground(accent))
    }

    window.api.getAccentColor().then((accent) => {
      if (!disposed) applyAccent(accent)
    })
    const removeListener = window.api.onAccentColorChanged(applyAccent)
    return () => {
      disposed = true
      removeListener()
    }
  }, [])

  useEffect(() => {
    if (!rowMenu) return

    const onPointerDown = (event: PointerEvent): void => {
      if (!rowMenuRef.current?.contains(event.target as Node)) setRowMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setRowMenu(null)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [rowMenu])

  // Load the transcript whenever the selected session changes (stale loads ignored).
  // Keyed on source+id+path: DB-backed sources share one originalPath across sessions.
  useEffect(() => {
    if (!selected) {
      setTranscript(null)
      setTranscriptKey(null)
      return
    }
    const reqId = ++reqRef.current
    setLoadingTx(true)
    setTranscript(null)
    // The previous session's transcript lingers in state for one render after
    // `selected` changes; clear the identity stamp now so a queued jump can't be
    // applied against it (the pendingJump effect gates on transcriptKey).
    setTranscriptKey(null)
    const key = metaKey(selected)
    window.api.loadTranscript(selected.originalPath, selected.source, selected.id).then((tx) => {
      if (reqRef.current === reqId) {
        setTranscript(tx)
        setTranscriptKey(key)
        setLoadingTx(false)
      }
    })
  }, [selected?.source, selected?.id, selected?.originalPath])

  useEffect(() => {
    setTab('session')
    setScrollTarget(null)
    // Arriving via a search jump keeps the query so highlights survive.
    if (selected && pendingJumpRef.current?.key === metaKey(selected)) return
    setPendingJump(null) // navigating elsewhere voids any queued jump
    setActiveMatchIndex(0)
  }, [selected?.source, selected?.id])

  useEffect(() => window.api.onSearchIndexProgress(setIndexProgress), [])

  const sources = useMemo(() => {
    const m = new Map<string, { label: string; count: number }>()
    for (const s of sessions) {
      if (s.variant === 'subagent') continue
      const e = m.get(s.source) ?? { label: s.sourceLabel, count: 0 }
      e.count++
      m.set(s.source, e)
    }
    return [...m.entries()]
      .map(([value, { label, count }]) => ({ value, label, count }))
      .sort((a, b) => b.count - a.count)
  }, [sessions])

  const filtered = useMemo(() => {
    return sessions.filter((s) => {
      if (source && s.source !== source) return false
      if (project && s.repo !== project) return false
      return true
    })
  }, [sessions, source, project])

  const rows = useMemo(
    () => buildRows(filtered, sessions, 'tree', expanded, groupMode, collapsedGroups),
    [filtered, sessions, expanded, groupMode, collapsedGroups]
  )
  const selectedForkParent = useMemo(() => {
    if (!selected?.forkParentId) return null
    return sessions.find((session) => session.source === selected.source && session.id === selected.forkParentId) ?? null
  }, [selected?.source, selected?.forkParentId, sessions])

  function jumpToSession(session: SessionMeta): void {
    setSelected(session)
    setTab('session')
    setRowMenu(null)
  }

  const visibleCount = filtered.filter((s) => s.variant !== 'subagent').length
  const totalCount = sessions.filter((s) => s.variant !== 'subagent').length

  // Inline transcript highlight only reflects the query when scoped to this
  // session — searching "all" shouldn't randomly light up the open transcript.
  const inlineQuery = searchScope === 'session' ? searchText.trim() : ''
  const searchMatches = useMemo(
    () => (transcript && !transcript.error ? buildSearchMatches(transcript.nodes, inlineQuery) : []),
    [transcript?.nodes, transcript?.error, inlineQuery]
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

  const canSearchTranscript = !!transcript && !transcript.error && transcript.nodes.length > 0

  useEffect(() => {
    setActiveMatchIndex(0)
  }, [transcript?.nodes, inlineQuery])

  // Apply a queued search jump once the TARGET transcript is in. Gating on
  // `transcriptKey` (not just `selected`) is essential: when jumping to another
  // session, `selected` updates immediately but the previous session's transcript
  // lingers in state for a render — firing then would resolve node indexes against
  // the wrong transcript and clear the jump before the real one loads.
  useEffect(() => {
    if (!pendingJump || !transcript || loadingTx) return
    if (transcriptKey !== pendingJump.key) return
    if (transcript.error) {
      setPendingJump(null) // target failed to load; don't fire on a later retry
      return
    }
    const matchIdx = searchMatches.findIndex((m) => m.nodeIndex === pendingJump.nodeIndex)
    if (matchIdx >= 0) setActiveMatchIndex(matchIdx)
    // Cross-session jump: inline highlighting is off for non-session scope, so
    // carry the query along to briefly mark the matched text on the landed node.
    else setScrollTarget({ index: pendingJump.nodeIndex, token: ++scrollTokenRef.current, query: searchText.trim() })
    setPendingJump(null)
  }, [pendingJump, transcript, transcriptKey, loadingTx, searchMatches])

  // ── Search scope plumbing ──────────────────────────────────────────
  const projectContext = useMemo(() => {
    if (project) return { filter: { repo: project } as SearchScopeFilter, label: project }
    if (selected?.repo) return { filter: { repo: selected.repo } as SearchScopeFilter, label: selected.repo }
    if (selected?.cwd) {
      const cwd = selected.cwd
      const label = cwd.replace(/\/+$/u, '').split('/').filter(Boolean).at(-1) ?? cwd
      return { filter: { cwd } as SearchScopeFilter, label }
    }
    return null
  }, [project, selected?.repo, selected?.cwd])

  const effectiveScope: SearchScope =
    searchScope === 'project' && !projectContext
      ? 'all'
      : searchScope === 'session' && !canSearchTranscript
        ? 'all'
        : searchScope
  const scopeFilter = effectiveScope === 'project' ? projectContext?.filter : undefined
  const scopeDisplay =
    effectiveScope === 'project'
      ? `project “${projectContext?.label}”`
      : effectiveScope === 'session'
        ? 'this session'
        : 'all sessions'

  // Debounced FTS query for project/all scopes. Session scope is computed locally.
  useEffect(() => {
    if (effectiveScope === 'session') {
      setGlobalResults(null)
      setGlobalLoading(false)
      return
    }
    const q = searchText.trim()
    if (q.length < 2) {
      setGlobalResults(null)
      setGlobalLoading(false)
      return
    }
    setGlobalLoading(true)
    const reqId = ++globalReqRef.current
    const timer = window.setTimeout(() => {
      void window.api.searchSessions(q, { scope: scopeFilter, wholeWord, matchCase }).then((res) => {
        if (globalReqRef.current !== reqId) return
        setGlobalResults(res)
        setGlobalLoading(false)
        setActiveResultIndex(0)
      })
    }, 250)
    return () => window.clearTimeout(timer)
    // indexProgress.done re-runs the query once a background index pass lands.
  }, [searchText, effectiveScope, scopeFilter?.repo, scopeFilter?.cwd, wholeWord, matchCase, indexProgress.done])

  const localResponse = useMemo(
    () =>
      effectiveScope === 'session' && selected && transcript && !transcript.error
        ? buildLocalResponse(selected, transcript.nodes, searchText.trim(), wholeWord, matchCase)
        : null,
    [effectiveScope, selected, transcript, searchText, wholeWord, matchCase]
  )

  const searchResponse = effectiveScope === 'session' ? localResponse : globalResults
  const searchLoading = effectiveScope === 'session' ? false : globalLoading

  const flatRows = useMemo<FlatSearchRow[]>(
    () => (searchResponse?.groups ?? []).flatMap((group) => group.matches.map((match) => ({ group, match }))),
    [searchResponse]
  )

  useEffect(() => {
    setActiveResultIndex(0)
  }, [searchText, effectiveScope, wholeWord, matchCase])

  const openSearchResult = useCallback(
    (row: FlatSearchRow): void => {
      const key = metaKey(row.group.session)
      setSearchOpen(false)
      setTab('session')
      setPendingJump({ key, nodeIndex: row.match.nodeIndex })
      if (!selected || metaKey(selected) !== key) setSelected(row.group.session)
    },
    [selected]
  )

  const openSearch = useCallback((): void => {
    setSearchOpen(true)
    requestAnimationFrame(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    })
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase()
      if ((event.metaKey || event.ctrlKey) && (key === 'f' || key === 'k')) {
        event.preventDefault()
        if (event.shiftKey && key === 'f') setSearchScope('all')
        openSearch()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openSearch])

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (flatRows.length === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActiveResultIndex((prev) => (prev + delta + flatRows.length) % flatRows.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const row = flatRows[Math.min(activeResultIndex, Math.max(0, flatRows.length - 1))]
      if (row) openSearchResult(row)
    }
    // Escape is handled at the window level (below) so it works even when focus
    // has moved off the input to a scope tab or the whole-word toggle.
  }

  // Esc clears the query, then closes — regardless of which modal control holds focus.
  useEffect(() => {
    if (!searchOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (searchText) setSearchText('')
      else setSearchOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [searchOpen, searchText])

  function toggleExpand(id: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleGroup(id: string): void {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function onContextMenu(session: SessionMeta, point: { x: number; y: number }): void {
    const menuWidth = 260
    const menuHeight = session.repo ? 238 : 200
    setRowMenu({
      session,
      x: Math.max(8, Math.min(point.x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(point.y, window.innerHeight - menuHeight - 8))
    })
  }

  async function runRowMenuAction(action: RowMenuAction): Promise<void> {
    if (!rowMenu) return
    const s = rowMenu.session
    setRowMenu(null)

    switch (action) {
      case 'copy-resume':
        await window.api.copy(s.resumeCommand)
        break
      case 'copy-id':
        await window.api.copy(s.id)
        break
      case 'copy-path':
        await window.api.copy(s.originalPath)
        break
      case 'reveal':
        await window.api.reveal(s.originalPath)
        break
      case 'open-cwd':
        await window.api.openPath(s.cwd)
        break
      case 'filter-project':
        setProject(s.repo || '')
        break
    }
  }

  function startDrag(e: { clientX: number; preventDefault: () => void }): void {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarW
    const move = (ev: MouseEvent): void => setSidebarW(Math.min(680, Math.max(260, startW + ev.clientX - startX)))
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // Search + collapse controls, left-aligned in the toolbar header (search left
  // of collapse), next to the window controls. They stay put whether or not the
  // sidebar is collapsed.
  const searchBtn = (
    <button className="tbtn" type="button" onClick={openSearch} title="Search sessions (⌘F)" aria-label="Search sessions">
      <MacIcon name="search" />
    </button>
  )
  const collapseBtn = (
    <button
      className="tbtn toolbar__toggle"
      type="button"
      onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
      title={sidebarCollapsed ? 'Show sessions' : 'Hide sessions'}
      aria-label={sidebarCollapsed ? 'Show sessions' : 'Hide sessions'}
      aria-pressed={!sidebarCollapsed}
    >
      <MacIcon name="sidebar" />
    </button>
  )

  return (
    <div
      className={`app${sidebarCollapsed ? ' app--sidebar-collapsed' : ''}`}
      data-density="cozy"
      style={{ '--sidebar-w': `${sidebarW}px` } as CSSProperties}
    >
      <div className="toolbar">
        <div className="toolbar__lead">
          {searchBtn}
          {collapseBtn}
        </div>
        <div className="toolbar__sep" />
        <div className="toolbar__main">
          <span className="count-pill">
            <b>{visibleCount}</b>
            {visibleCount !== totalCount ? ` of ${totalCount}` : ''} sessions
          </span>
          <span className="toolbar__spacer" />
          <div className="segmented" aria-label="Viewer tab">
            <button className={`seg${tab === 'session' ? ' seg--on' : ''}`} onClick={() => setTab('session')}>
              Session
              <span className="seg__num">{transcript ? transcript.nodes.length : 0}</span>
            </button>
            <button className={`seg${tab === 'json' ? ' seg--on' : ''}`} onClick={() => setTab('json')}>
              JSON
              <span className="seg__num">{transcript ? transcript.records.length : 0}</span>
            </button>
          </div>
          <button
            className={`tbtn${refreshing ? ' tbtn--spin' : ''}`}
            onClick={() => void refresh(true)}
            title="Reload sessions"
            aria-label="Reload sessions"
          >
            <MacIcon name="reload" />
          </button>
        </div>
      </div>

      <div className="body mac-body">
        {sidebarCollapsed ? null : (
          <aside className="sidebar mac-sidebar" style={{ width: sidebarW }}>
            <FilterBar
              source={source}
              project={project}
              groupMode={groupMode}
              sources={sources}
              onSource={setSource}
              onProject={setProject}
              onGroupMode={setGroupMode}
            />
            {loadingList ? (
              <div className="list list--empty">Scanning agent histories...</div>
            ) : (
              <SessionList
                rows={rows}
                selectedKey={selected ? metaKey(selected) : null}
                onSelect={setSelected}
                onContextMenu={onContextMenu}
                onToggle={toggleExpand}
                onToggleGroup={toggleGroup}
              />
            )}
          </aside>
        )}

        {sidebarCollapsed ? null : <div className="divider mac-divider" onMouseDown={startDrag} />}

        <main className="main mac-detail">
          <Viewer
            session={selected}
            transcript={transcript}
            loading={loadingTx}
            tab={tab}
            parentSession={selectedForkParent}
            onJumpToParent={selectedForkParent ? () => jumpToSession(selectedForkParent) : undefined}
            searchQuery={inlineQuery}
            searchHitsByNode={searchHitsByNode}
            activeMatch={activeMatch}
            scrollTarget={scrollTarget}
            onReveal={() => {
              if (selected) void window.api.reveal(selected.originalPath)
            }}
          />
        </main>
      </div>

      {searchOpen ? (
        <GlobalSearch
          query={searchText}
          onQuery={setSearchText}
          onKeyDown={onSearchKeyDown}
          scope={effectiveScope}
          onScope={setSearchScope}
          projectLabel={projectContext?.label ?? null}
          hasSession={canSearchTranscript}
          wholeWord={wholeWord}
          onWholeWord={setWholeWord}
          matchCase={matchCase}
          onMatchCase={setMatchCase}
          response={searchResponse}
          loading={searchLoading}
          scopeLabel={scopeDisplay}
          activeIndex={activeResultIndex}
          progress={indexProgress}
          inputRef={searchInputRef}
          onHover={setActiveResultIndex}
          onOpen={openSearchResult}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}

      {rowMenu ? (
        <div
          ref={rowMenuRef}
          className="dropdownMenu contextMenu menu ctxmenu"
          role="menu"
          style={{ left: rowMenu.x, top: rowMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            className="dropdownMenu__item menu__item"
            type="button"
            role="menuitem"
            disabled={!rowMenu.session.resumeCommand}
            onClick={() => void runRowMenuAction('copy-resume')}
          >
            <span className="menu__txt">Copy Resume Command</span>
          </button>
          <div className="dropdownMenu__separator menu__sep" />
          <button
            className="dropdownMenu__item menu__item"
            type="button"
            role="menuitem"
            onClick={() => void runRowMenuAction('copy-id')}
          >
            <span className="menu__txt">Copy Session ID</span>
          </button>
          <button
            className="dropdownMenu__item menu__item"
            type="button"
            role="menuitem"
            onClick={() => void runRowMenuAction('copy-path')}
          >
            <span className="menu__txt">Copy Path</span>
          </button>
          <div className="dropdownMenu__separator menu__sep" />
          <button
            className="dropdownMenu__item menu__item"
            type="button"
            role="menuitem"
            onClick={() => void runRowMenuAction('reveal')}
          >
            <span className="menu__txt">Reveal Session Log in Finder</span>
          </button>
          <button
            className="dropdownMenu__item menu__item"
            type="button"
            role="menuitem"
            disabled={!rowMenu.session.cwd}
            onClick={() => void runRowMenuAction('open-cwd')}
          >
            <span className="menu__txt">Open Working Directory</span>
          </button>
          <div className="dropdownMenu__separator menu__sep" />
          <button
            className="dropdownMenu__item menu__item"
            type="button"
            role="menuitem"
            disabled={!rowMenu.session.repo}
            onClick={() => void runRowMenuAction('filter-project')}
          >
            <span className="menu__txt">
              {rowMenu.session.repo ? `Filter by Project: ${rowMenu.session.repo}` : 'Filter by Project'}
            </span>
          </button>
        </div>
      ) : null}
    </div>
  )
}
