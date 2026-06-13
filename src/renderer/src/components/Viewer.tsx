import { useEffect, useRef, useState } from 'react'
import type { ExportFormat, SessionMeta, TranscriptPayload } from '../../../shared/ipc'
import { fmtBytes, fmtTime, sessionTitle, sourceColor, sourceName } from '../util'
import { MacIcon } from './MacIcons'
import { JsonView } from './JsonView'
import { SessionView, type SessionSearchMatch } from './SessionView'

interface Props {
  session: SessionMeta | null
  transcript: TranscriptPayload | null
  loading: boolean
  tab: 'session' | 'json'
  parentSession?: SessionMeta | null
  onJumpToParent?: () => void
  searchQuery: string
  searchHitsByNode: Map<number, Set<number>>
  activeMatch: SessionSearchMatch | null
  scrollTarget?: { index: number; token: number; query: string } | null
  onReveal: () => void
}

function JumpToParentIcon(): JSX.Element {
  return (
    <svg className="viewerFork__jumpIcon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.5 4.5h6v6" />
      <path d="m11.25 4.75-7 7" />
    </svg>
  )
}

function ExportIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2v7.5" />
      <path d="m5 6.5 3 3 3-3" />
      <path d="M3 10.5v2A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5v-2" />
    </svg>
  )
}

function ExportMenu({ session, disabled }: { session: SessionMeta; disabled: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (!error) return
    const timer = window.setTimeout(() => setError(''), 5000)
    return () => window.clearTimeout(timer)
  }, [error])

  async function runExport(format: ExportFormat): Promise<void> {
    setOpen(false)
    setBusy(true)
    setError('')
    try {
      const result = await window.api.exportSession(session.originalPath, session.source, session.id, format)
      if (!result.ok) setError(result.error ?? 'Export failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="exportWrap" ref={wrapRef}>
      {error ? <span className="exportError" title={error}>{error}</span> : null}
      <button
        className={`tbtn export__btn${busy ? ' tbtn--spin' : ''}`}
        type="button"
        disabled={disabled || busy}
        title="Export session"
        aria-label="Export session"
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
      >
        {busy ? <MacIcon name="reload" /> : <ExportIcon />}
      </button>
      {open ? (
        <div className="dropdownMenu menu export__menu" role="menu">
          <button
            className="dropdownMenu__item menu__item"
            type="button"
            role="menuitem"
            onClick={() => void runExport('markdown')}
          >
            <span className="menu__txt">Export as Markdown…</span>
          </button>
          <button
            className="dropdownMenu__item menu__item"
            type="button"
            role="menuitem"
            onClick={() => void runExport('html')}
          >
            <span className="menu__txt">Export as HTML…</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function Viewer({
  session,
  transcript,
  loading,
  tab,
  parentSession,
  onJumpToParent,
  searchQuery,
  searchHitsByNode,
  activeMatch,
  scrollTarget,
  onReveal
}: Props): JSX.Element {
  if (!session) {
    return (
      <div className="viewer viewer--empty detail detail--empty">
        <div className="empty-mark">
          <MacIcon name="tray" />
        </div>
        <div>Select a session to view its transcript.</div>
      </div>
    )
  }

  const forkTooltip = session.forkParentId
    ? [
        parentSession ? `Parent: ${sessionTitle(parentSession)}` : 'Parent: not indexed',
        `Parent ID: ${session.forkParentId}`
      ].join('\n')
    : ''

  const canExport = !!transcript && !transcript.error && transcript.nodes.length > 0 && !loading

  return (
    <div className="viewer detail">
      <header className="viewer__header dheader">
        <div className="dheader__top">
          <div className="dheader__copy">
            <div className="viewer__title dheader__title">{sessionTitle(session)}</div>
            <div className="viewer__sub dheader__meta">
              <span className="badge dheader__source" style={{ color: sourceColor(session.source) }}>
                {sourceName(session.source)}
              </span>
              {session.variantLabel ? <span className="vchip">{session.variantLabel}</span> : null}
              {session.forkParentId ? (
                <span className="viewerForkInline">
                  <span className="vchip viewerForkChip" data-tooltip={forkTooltip} aria-label={forkTooltip}>
                    fork
                  </span>
                  <button
                    className="viewerFork__jump"
                    type="button"
                    disabled={!parentSession || !onJumpToParent}
                    title={parentSession ? 'Jump to parent session' : 'Parent session not found'}
                    aria-label={parentSession ? 'Jump to parent session' : 'Parent session not found'}
                    onClick={onJumpToParent}
                  >
                    <JumpToParentIcon />
                  </button>
                </span>
              ) : null}
              {session.repo ? (
                <span className="mi">
                  <MacIcon name="repo" />
                  {session.repo}
                </span>
              ) : null}
              {session.branch ? (
                <span className="mi">
                  <MacIcon name="branch" />
                  {session.branch}
                </span>
              ) : null}
              {session.model ? (
                <span className="mi">
                  <MacIcon name="cpu" />
                  {session.model}
                </span>
              ) : null}
              <span className="sep-dot" />
              <span className="mi">
                <MacIcon name="clock" />
                {fmtTime(session.updatedAt)}
              </span>
              <span className="mi">
                <MacIcon name="weight" />
                {fmtBytes(session.bytes)}
              </span>
            </div>
          </div>
          <ExportMenu session={session} disabled={!canExport} />
        </div>
        <div className="viewer__path dheader__path" onClick={onReveal} title="Reveal in Finder">
          <MacIcon name="finder" />
          <span>{session.originalPath}</span>
        </div>
      </header>

      <div className="viewer__body detail__body">
        {loading ? (
          <div className="loading">Loading transcript...</div>
        ) : transcript?.error ? (
          <div className="error">Failed to load: {transcript.error}</div>
        ) : !transcript ? null : tab === 'session' ? (
          <SessionView
            nodes={transcript.nodes}
            searchQuery={searchQuery}
            searchHitsByNode={searchHitsByNode}
            activeMatch={activeMatch}
            scrollTarget={scrollTarget}
          />
        ) : (
          <JsonView records={transcript.records} reconstructed={transcript.reconstructed} />
        )}
      </div>
    </div>
  )
}
