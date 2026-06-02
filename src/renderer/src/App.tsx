import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionMeta, TranscriptPayload } from '../../shared/ipc'
import { FilterBar } from './components/FilterBar'
import { SessionList } from './components/SessionList'
import { Viewer } from './components/Viewer'
import { buildRows, type GroupMode, metaKey } from './util'

type RowMenuAction = 'copy-resume' | 'copy-id' | 'copy-path' | 'reveal' | 'open-cwd' | 'filter-project'

interface RowMenuState {
  session: SessionMeta
  x: number
  y: number
}

export function App(): JSX.Element {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [selected, setSelected] = useState<SessionMeta | null>(null)
  const [transcript, setTranscript] = useState<TranscriptPayload | null>(null)
  const [loadingTx, setLoadingTx] = useState(false)
  const [tab, setTab] = useState<'session' | 'json'>('session')

  const [text, setText] = useState('')
  const [source, setSource] = useState('')
  const [project, setProject] = useState('')
  const [sidebarW, setSidebarW] = useState(380)
  const [groupMode, setGroupMode] = useState<GroupMode>('chronological')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null)

  const reqRef = useRef(0)
  const rowMenuRef = useRef<HTMLDivElement>(null)

  async function refresh(force = false): Promise<void> {
    setLoadingList(true)
    const list = await window.api.list(force)
    setSessions(list)
    setLoadingList(false)
  }

  useEffect(() => {
    void refresh(false)
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
      return
    }
    const reqId = ++reqRef.current
    setLoadingTx(true)
    setTranscript(null)
    window.api.loadTranscript(selected.originalPath, selected.source, selected.id).then((tx) => {
      if (reqRef.current === reqId) {
        setTranscript(tx)
        setLoadingTx(false)
      }
    })
  }, [selected?.source, selected?.id, selected?.originalPath])

  const sources = useMemo(() => {
    const m = new Map<string, { label: string; count: number }>()
    for (const s of sessions) {
      const e = m.get(s.source) ?? { label: s.sourceLabel, count: 0 }
      e.count++
      m.set(s.source, e)
    }
    return [...m.entries()]
      .map(([value, { label, count }]) => ({ value, label, count }))
      .sort((a, b) => b.count - a.count)
  }, [sessions])

  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase()
    return sessions.filter((s) => {
      if (source && s.source !== source) return false
      if (project && s.repo !== project) return false
      if (q) {
        const hay = `${s.summary ?? ''} ${s.repo ?? ''} ${s.cwd} ${s.id} ${s.sourceLabel} ${s.source}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [sessions, text, source, project])

  const rows = useMemo(
    () => buildRows(filtered, sessions, 'tree', expanded, groupMode, collapsedGroups),
    [filtered, sessions, expanded, groupMode, collapsedGroups]
  )

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

  return (
    <div className="app">
      <div className="titlebar">
        <span className="titlebar__title">AgentSessionViewer</span>
        <span className="titlebar__count">
          {filtered.length}
          {filtered.length !== sessions.length ? ` / ${sessions.length}` : ''}
        </span>
        <span className="titlebar__spacer" />
        <button className="iconbtn" onClick={() => void refresh(true)} title="Reload sessions">
          ⟳
        </button>
      </div>

      <div className="body">
        <aside className="sidebar" style={{ width: sidebarW }}>
          <FilterBar
            text={text}
            source={source}
            project={project}
            groupMode={groupMode}
            sources={sources}
            onText={setText}
            onSource={setSource}
            onProject={setProject}
            onGroupMode={setGroupMode}
          />
          {loadingList ? (
            <div className="list list--empty">Scanning agent histories…</div>
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

        <div className="divider" onMouseDown={startDrag} />

        <main className="main">
          <Viewer
            session={selected}
            transcript={transcript}
            loading={loadingTx}
            tab={tab}
            setTab={setTab}
            onReveal={() => {
              if (selected) void window.api.reveal(selected.originalPath)
            }}
          />
        </main>
      </div>

      {rowMenu ? (
        <div
          ref={rowMenuRef}
          className="dropdownMenu contextMenu"
          role="menu"
          style={{ left: rowMenu.x, top: rowMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            className="dropdownMenu__item"
            type="button"
            role="menuitem"
            disabled={!rowMenu.session.resumeCommand}
            onClick={() => void runRowMenuAction('copy-resume')}
          >
            Copy Resume Command
          </button>
          <div className="dropdownMenu__separator" />
          <button
            className="dropdownMenu__item"
            type="button"
            role="menuitem"
            onClick={() => void runRowMenuAction('copy-id')}
          >
            Copy Session ID
          </button>
          <button
            className="dropdownMenu__item"
            type="button"
            role="menuitem"
            onClick={() => void runRowMenuAction('copy-path')}
          >
            Copy Path
          </button>
          <div className="dropdownMenu__separator" />
          <button
            className="dropdownMenu__item"
            type="button"
            role="menuitem"
            onClick={() => void runRowMenuAction('reveal')}
          >
            Reveal Session Log in Finder
          </button>
          <button
            className="dropdownMenu__item"
            type="button"
            role="menuitem"
            disabled={!rowMenu.session.cwd}
            onClick={() => void runRowMenuAction('open-cwd')}
          >
            Open Working Directory
          </button>
          <div className="dropdownMenu__separator" />
          <button
            className="dropdownMenu__item"
            type="button"
            role="menuitem"
            disabled={!rowMenu.session.repo}
            onClick={() => void runRowMenuAction('filter-project')}
          >
            {rowMenu.session.repo ? `Filter by Project: ${rowMenu.session.repo}` : 'Filter by Project'}
          </button>
        </div>
      ) : null}
    </div>
  )
}
