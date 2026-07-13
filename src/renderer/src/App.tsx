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
import { accentForeground, buildRows, loadGroupMode, saveGroupMode, type GroupMode, metaKey } from './util'
import { m } from './styles/cx'
import layout from './styles/layout.module.css'
import menu from './styles/menus.module.css'
import listStyles from './components/SessionList.module.css'

type RowMenuAction =
  | 'copy-resume'
  | 'copy-id'
  | 'copy-path'
  | 'reveal'
  | 'open-cwd'
  | 'filter-project'
  | 'delete'

interface RowMenuState {
  session: SessionMeta
  x: number
  y: number
}

interface SessionSearchMatch {
  nodeIndex: number
  ordinalInNode: number
}

interface PendingSearchJump {
  key: string
  nodeIndex: number
  query: string
}

// Snippet highlight markers — the same pair GlobalSearch splits on. Built from
// char codes so no literal control bytes land in the source file.
const MARK_START = String.fromCharCode(2)
const MARK_END = String.fromCharCode(3)
const SNIPPET_RADIUS = 48
const LOCAL_MATCHES_SHOWN = 50
// Matches shown per session before the "+N more" expander.
const COLLAPSED_MATCHES = 5

/**
 * Keys of the session itself plus its subagent descendants (same source,
 * parentId chain). All get swept out together when a parent is deleted.
 */
function collectRemovableKeys(sessions: SessionMeta[], root: SessionMeta): Set<string> {
  const doomed = new Set<string>([metaKey(root)])
  // Iterate to fixed point: a child's parentId matches any already-doomed key.
  let grew = true
  while (grew) {
    grew = false
    for (const s of sessions) {
      if (s.source !== root.source || !s.parentId) continue
      if (doomed.has(metaKey(s))) continue
      const parentKey = `${s.source}\u0000${s.parentId}`
      if (doomed.has(parentKey)) {
        doomed.add(metaKey(s))
        grew = true
      }
    }
  }
  return doomed
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
  const [listQuery, setListQuery] = useState('')
  const [sidebarW, setSidebarW] = useState(300)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [groupMode, setGroupMode] = useState<GroupMode>(loadGroupMode)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null)
  // Session keys being animated out after a delete; removed from `sessions`
  // once the CSS sweep finishes so the virtualizer recomputes positions.
  const [removingKeys, setRemovingKeys] = useState<Set<string>>(new Set())
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
  // Session keys whose result list is expanded past the collapsed preview.
  const [expandedResults, setExpandedResults] = useState<Set<string>>(new Set())
  const [indexProgress, setIndexProgress] = useState<SearchIndexProgress>({ indexed: 0, total: 0, done: true })
  const [pendingJump, setPendingJump] = useState<PendingSearchJump | null>(null)
  const [scrollTarget, setScrollTarget] = useState<{ index: number; token: number; query: string } | null>(null)
  // Identity (metaKey) of the session whose transcript is currently in `transcript`.
  // null while loading — a queued jump waits for this to match its target.
  const [transcriptKey, setTranscriptKey] = useState<string | null>(null)

  const reqRef = useRef(0)
  const listReqRef = useRef(0)
  const globalReqRef = useRef(0)
  const scrollTokenRef = useRef(0)
  const refreshTimerRef = useRef<number | null>(null)
  const rowMenuRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async (force = false): Promise<void> => {
    const reqId = ++listReqRef.current
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = null
    }
    setLoadingList(true)
    setRefreshing(true)
    try {
      const list = await window.api.list(force)
      if (listReqRef.current === reqId) setSessions(list)
    } catch {
      // Keep the last successful list; the current request still settles below.
    } finally {
      if (listReqRef.current !== reqId) return
      setLoadingList(false)
      refreshTimerRef.current = window.setTimeout(() => {
        setRefreshing(false)
        refreshTimerRef.current = null
      }, 260)
    }
  }, [])

  useEffect(() => {
    void refresh(false)
    return () => {
      listReqRef.current++
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
    }
  }, [refresh])

  // Persist the group-by choice so the same grouping survives relaunch.
  useEffect(() => {
    saveGroupMode(groupMode)
  }, [groupMode])

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
    const reqId = ++reqRef.current
    if (!selected) {
      setTranscript(null)
      setTranscriptKey(null)
      setLoadingTx(false)
      return
    }
    setLoadingTx(true)
    setTranscript(null)
    // The previous session's transcript lingers in state for one render after
    // `selected` changes; clear the identity stamp now so a queued jump can't be
    // applied against it (the pendingJump effect gates on transcriptKey).
    setTranscriptKey(null)
    const key = metaKey(selected)
    void window.api
      .loadTranscript(selected.originalPath, selected.source, selected.id)
      .then((tx) => {
        if (reqRef.current !== reqId) return
        setTranscript(tx)
        setTranscriptKey(key)
        setLoadingTx(false)
      })
      .catch((error: unknown) => {
        if (reqRef.current !== reqId) return
        setTranscript({
          source: selected.source,
          originalPath: selected.originalPath,
          reconstructed: false,
          records: [],
          nodes: [],
          error: error instanceof Error ? error.message : String(error)
        })
        setTranscriptKey(key)
        setLoadingTx(false)
      })
    return () => {
      if (reqRef.current === reqId) reqRef.current++
    }
  }, [selected?.source, selected?.id, selected?.originalPath])

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
    const q = listQuery.trim().toLowerCase()
    return sessions.filter((s) => {
      if (source && s.source !== source) return false
      if (project && s.repo !== project) return false
      if (q) {
        const title = (s.summary || s.id).toLowerCase()
        const hay = `${title} ${s.repo ?? ''} ${s.cwd ?? ''} ${s.sourceLabel}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [sessions, source, project, listQuery])

  const rows = useMemo(
    () => buildRows(filtered, sessions, 'tree', expanded, groupMode, collapsedGroups),
    [filtered, sessions, expanded, groupMode, collapsedGroups]
  )
  const selectedForkParent = useMemo(() => {
    if (!selected?.forkParentId) return null
    return sessions.find((session) => session.source === selected.source && session.id === selected.forkParentId) ?? null
  }, [selected?.source, selected?.forkParentId, sessions])

  function selectSession(session: SessionMeta | null, preservePendingJump = false): void {
    setSelected(session)
    setTab('session')
    setScrollTarget(null)
    setActiveMatchIndex(0)
    if (!preservePendingJump) setPendingJump(null)
  }

  function jumpToSession(session: SessionMeta): void {
    selectSession(session)
    setRowMenu(null)
  }

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
    else setScrollTarget({ index: pendingJump.nodeIndex, token: ++scrollTokenRef.current, query: pendingJump.query })
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
    const reqId = ++globalReqRef.current
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
    const timer = window.setTimeout(() => {
      void window.api
        .searchSessions(q, { scope: scopeFilter, wholeWord, matchCase })
        .then((res) => {
          if (globalReqRef.current !== reqId) return
          setGlobalResults(res)
          setGlobalLoading(false)
          setActiveResultIndex(0)
        })
        .catch(() => {
          if (globalReqRef.current !== reqId) return
          setGlobalResults({ available: false, indexing: false, groups: [], totalSessions: 0 })
          setGlobalLoading(false)
        })
    }, 250)
    return () => {
      window.clearTimeout(timer)
      if (globalReqRef.current === reqId) globalReqRef.current++
    }
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
    () =>
      (searchResponse?.groups ?? []).flatMap((group) => {
        const shown = expandedResults.has(metaKey(group.session))
          ? group.matches
          : group.matches.slice(0, COLLAPSED_MATCHES)
        return shown.map((match) => ({ group, match }))
      }),
    [searchResponse, expandedResults]
  )

  const toggleResultExpand = useCallback((key: string): void => {
    setExpandedResults((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  function resetSearchResultView(): void {
    setActiveResultIndex(0)
    setExpandedResults(new Set())
  }

  function changeSearchText(value: string): void {
    setSearchText(value)
    setActiveMatchIndex(0)
    resetSearchResultView()
  }

  function changeSearchScope(scope: SearchScope): void {
    setSearchScope(scope)
    setActiveMatchIndex(0)
    resetSearchResultView()
  }

  function changeWholeWord(value: boolean): void {
    setWholeWord(value)
    resetSearchResultView()
  }

  function changeMatchCase(value: boolean): void {
    setMatchCase(value)
    resetSearchResultView()
  }

  function openSearchResult(row: FlatSearchRow): void {
    const key = metaKey(row.group.session)
    setSearchOpen(false)
    setPendingJump({ key, nodeIndex: row.match.nodeIndex, query: searchText.trim() })
    selectSession(row.group.session, true)
  }

  const openSearch = useCallback((scope?: SearchScope): void => {
    if (scope) {
      setSearchScope(scope)
      setActiveMatchIndex(0)
      setActiveResultIndex(0)
      setExpandedResults(new Set())
    }
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
        if (event.shiftKey && key === 'f') openSearch('all')
        else if (key === 'f' && canSearchTranscript) openSearch('session')
        else openSearch()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openSearch, canSearchTranscript])

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
      if (searchText) {
        setSearchText('')
        setActiveMatchIndex(0)
        setActiveResultIndex(0)
        setExpandedResults(new Set())
      } else {
        setSearchOpen(false)
      }
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
    // delete separator + item add ~40px over the repo variant.
    const menuHeight = session.repo ? 278 : 240
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
      case 'delete': {
        const isDb = s.originalPath.toLowerCase().endsWith('.db')
        const verb = isDb ? 'delete' : 'move to Trash'
        const detail = isDb
          ? `This permanently removes the session's rows from the shared ${s.sourceLabel} database. This cannot be undone.`
          : `This moves the session file to the macOS Trash.`
        const ok = await window.api.confirm(
          `${verb.charAt(0).toUpperCase() + verb.slice(1)} this ${s.sourceLabel} session?`,
          detail
        )
        if (!ok) break
        const res = await window.api.deleteSession(s.originalPath, s.source, s.id)
        if (!res.ok) {
          await window.api.confirm(`Failed to delete session: ${res.error ?? 'unknown error'}`)
          break
        }
        // Sweep the row out via CSS, then drop it from local state. No full
        // rescan — the deleted session is gone from storage, so it won't
        // reappear on the next manual reload.
        if (selected && metaKey(selected) === metaKey(s)) selectSession(null)
        const doomed = collectRemovableKeys(sessions, s)
        setRemovingKeys((prev) => {
          const next = new Set(prev)
          for (const k of doomed) next.add(k)
          return next
        })
        window.setTimeout(() => {
          setSessions((prev) => prev.filter((x) => !doomed.has(metaKey(x))))
          setRemovingKeys((prev) => {
            const next = new Set(prev)
            for (const k of doomed) next.delete(k)
            return next
          })
        }, 460)
        break
      }
    }
  }

  function startDrag(e: { clientX: number; preventDefault: () => void }): void {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarW
    const move = (ev: MouseEvent): void => setSidebarW(Math.min(520, Math.max(240, startW + ev.clientX - startX)))
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const refreshBtn = (
    <button
      className={m(layout, 'tbtn', refreshing && 'tbtn--spin')}
      type="button"
      onClick={() => void refresh(true)}
      title="Reload sessions"
      aria-label="Reload sessions"
    >
      <MacIcon name="reload" />
    </button>
  )
  const collapseBtn = (
    <button
      className={m(layout, 'tbtn', 'toolbar__toggle')}
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
      className={m(layout, 'app', sidebarCollapsed && 'app--sidebar-collapsed')}
      data-density="cozy"
      data-del-anim="slide"
      style={{ '--sidebar-w': `${sidebarW}px` } as CSSProperties}
    >
      <div className={layout.toolbar}>
        <div className={layout['toolbar__lead']}>
          {collapseBtn}
          {refreshBtn}
        </div>
        <div className={layout['toolbar__main']} />
      </div>

      <div className={m(layout, 'body', 'mac-body')}>
        {sidebarCollapsed ? null : (
          <aside className={m(layout, 'sidebar', 'mac-sidebar')} style={{ width: sidebarW }}>
            <FilterBar
              source={source}
              project={project}
              groupMode={groupMode}
              sources={sources}
              onSource={setSource}
              onProject={setProject}
              onGroupMode={setGroupMode}
              listQuery={listQuery}
              onListQuery={setListQuery}
            />
            {loadingList ? (
              <div className={m(listStyles, 'list', 'list--empty')}>Scanning agent histories...</div>
            ) : (
              <SessionList
                rows={rows}
                selectedKey={selected ? metaKey(selected) : null}
                removingKeys={removingKeys}
                grouped={groupMode !== 'chronological'}
                onSelect={selectSession}
                onContextMenu={onContextMenu}
                onToggle={toggleExpand}
                onToggleGroup={toggleGroup}
              />
            )}
          </aside>
        )}

        {sidebarCollapsed ? null : (
          <div
            className={m(layout, 'divider', 'mac-divider')}
            role="separator"
            aria-label="Resize session sidebar"
            aria-orientation="vertical"
            aria-valuemin={240}
            aria-valuemax={520}
            aria-valuenow={sidebarW}
            tabIndex={0}
            onMouseDown={startDrag}
            onKeyDown={(event) => {
              const delta = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0
              if (!delta) return
              event.preventDefault()
              setSidebarW((width) => Math.min(520, Math.max(240, width + delta)))
            }}
          />
        )}

        <main className={m(layout, 'main', 'mac-detail')}>
          <Viewer
            key={selected ? metaKey(selected) : 'no-session'}
            session={selected}
            transcript={transcript}
            loading={loadingTx}
            tab={tab}
            onTab={setTab}
            parentSession={selectedForkParent}
            onJumpToParent={selectedForkParent ? () => jumpToSession(selectedForkParent) : undefined}
            searchQuery={inlineQuery}
            searchHitsByNode={searchHitsByNode}
            activeMatch={activeMatch}
            scrollTarget={scrollTarget}
            onOpenSearch={() => openSearch('session')}
            onReveal={() => {
              if (selected) void window.api.reveal(selected.originalPath)
            }}
          />
        </main>
      </div>

      {searchOpen ? (
        <GlobalSearch
          query={searchText}
          onQuery={changeSearchText}
          onKeyDown={onSearchKeyDown}
          scope={effectiveScope}
          onScope={changeSearchScope}
          projectLabel={projectContext?.label ?? null}
          hasSession={canSearchTranscript}
          wholeWord={wholeWord}
          onWholeWord={changeWholeWord}
          matchCase={matchCase}
          onMatchCase={changeMatchCase}
          response={searchResponse}
          loading={searchLoading}
          scopeLabel={scopeDisplay}
          activeIndex={activeResultIndex}
          progress={indexProgress}
          inputRef={searchInputRef}
          collapsedCount={COLLAPSED_MATCHES}
          expanded={expandedResults}
          onToggleExpand={toggleResultExpand}
          onHover={setActiveResultIndex}
          onOpen={openSearchResult}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}

      {rowMenu ? (
        <div
          ref={rowMenuRef}
          className={m(menu, 'dropdownMenu', 'contextMenu', 'menu', 'ctxmenu')}
          role="menu"
          style={{ left: rowMenu.x, top: rowMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            className={m(menu, 'dropdownMenu__item', 'menu__item')}
            type="button"
            role="menuitem"
            disabled={!rowMenu.session.resumeCommand}
            onClick={() => void runRowMenuAction('copy-resume')}
          >
            <span className={menu['menu__txt']}>Copy Resume Command</span>
          </button>
          <div className={m(menu, 'dropdownMenu__separator', 'menu__sep')} />
          <button
            className={m(menu, 'dropdownMenu__item', 'menu__item')}
            type="button"
            role="menuitem"
            onClick={() => void runRowMenuAction('copy-id')}
          >
            <span className={menu['menu__txt']}>Copy Session ID</span>
          </button>
          <button
            className={m(menu, 'dropdownMenu__item', 'menu__item')}
            type="button"
            role="menuitem"
            onClick={() => void runRowMenuAction('copy-path')}
          >
            <span className={menu['menu__txt']}>Copy Path</span>
          </button>
          <div className={m(menu, 'dropdownMenu__separator', 'menu__sep')} />
          <button
            className={m(menu, 'dropdownMenu__item', 'menu__item')}
            type="button"
            role="menuitem"
            onClick={() => void runRowMenuAction('reveal')}
          >
            <span className={menu['menu__txt']}>Reveal Session Log in Finder</span>
          </button>
          <button
            className={m(menu, 'dropdownMenu__item', 'menu__item')}
            type="button"
            role="menuitem"
            disabled={!rowMenu.session.cwd}
            onClick={() => void runRowMenuAction('open-cwd')}
          >
            <span className={menu['menu__txt']}>Open Working Directory</span>
          </button>
          <div className={m(menu, 'dropdownMenu__separator', 'menu__sep')} />
          <button
            className={m(menu, 'dropdownMenu__item', 'menu__item')}
            type="button"
            role="menuitem"
            disabled={!rowMenu.session.repo}
            onClick={() => void runRowMenuAction('filter-project')}
          >
            <span className={menu['menu__txt']}>
              {rowMenu.session.repo ? `Filter by Project: ${rowMenu.session.repo}` : 'Filter by Project'}
            </span>
          </button>
          <div className={m(menu, 'dropdownMenu__separator', 'menu__sep')} />
          <button
            className={m(menu, 'dropdownMenu__item', 'menu__item', 'menu__item--danger')}
            type="button"
            role="menuitem"
            onClick={() => void runRowMenuAction('delete')}
          >
            <span className={menu['menu__txt']}>
              {rowMenu.session.originalPath.toLowerCase().endsWith('.db')
                ? 'Delete Session'
                : 'Move to Trash'}
            </span>
          </button>
        </div>
      ) : null}
    </div>
  )
}
