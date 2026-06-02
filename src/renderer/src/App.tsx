import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionMeta, TranscriptPayload } from '../../shared/ipc'
import { FilterBar } from './components/FilterBar'
import { SessionList } from './components/SessionList'
import { Viewer } from './components/Viewer'
import { buildRows, type ListMode, metaKey } from './util'

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
  const [listMode, setListMode] = useState<ListMode>('tree')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const reqRef = useRef(0)

  async function refresh(force = false): Promise<void> {
    setLoadingList(true)
    const list = await window.api.list(force)
    setSessions(list)
    setLoadingList(false)
  }

  useEffect(() => {
    void refresh(false)
  }, [])

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
    () => buildRows(filtered, sessions, listMode, expanded),
    [filtered, sessions, listMode, expanded]
  )

  function toggleExpand(id: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function onContextMenu(s: SessionMeta): Promise<void> {
    const res = await window.api.showRowMenu(s)
    if (!res) return
    switch (res.action) {
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
        <div className="seg">
          <button
            className={`seg__btn${listMode === 'flat' ? ' seg__btn--active' : ''}`}
            onClick={() => setListMode('flat')}
            title="Flat list"
          >
            Flat
          </button>
          <button
            className={`seg__btn${listMode === 'tree' ? ' seg__btn--active' : ''}`}
            onClick={() => setListMode('tree')}
            title="Tree list — nests subagents under their parent session"
          >
            Tree
          </button>
        </div>
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
            sources={sources}
            onText={setText}
            onSource={setSource}
            onProject={setProject}
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
    </div>
  )
}
