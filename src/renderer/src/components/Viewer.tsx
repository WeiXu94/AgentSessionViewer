import { useEffect, useRef, useState } from 'react'
import type { ExportFormat, SessionMeta, TranscriptPayload } from '../../../shared/ipc'
import { isSessionStarred, sessionTitle, setSessionStarred, sourceName } from '../util'
import { m } from '../styles/cx'
import menu from '../styles/menus.module.css'
import styles from './Viewer.module.css'
import { MacIcon } from './MacIcons'
import { JsonView } from './JsonView'
import { SessionView, type SessionSearchMatch } from './SessionView'

interface Props {
  session: SessionMeta | null
  transcript: TranscriptPayload | null
  loading: boolean
  tab: 'session' | 'json'
  onTab: (tab: 'session' | 'json') => void
  parentSession?: SessionMeta | null
  onJumpToParent?: () => void
  searchQuery: string
  searchHitsByNode: Map<number, Set<number>>
  activeMatch: SessionSearchMatch | null
  scrollTarget?: { index: number; token: number; query: string } | null
  onReveal: () => void
  onOpenSearch: () => void
}

function JumpToParentIcon(): JSX.Element {
  return (
    <svg className={styles['viewerFork__jumpIcon']} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.5 4.5h6v6" />
      <path d="m11.25 4.75-7 7" />
    </svg>
  )
}

function StarIcon({ filled }: { filled: boolean }): JSX.Element {
  return (
    <svg className={styles['viewerStar__icon']} viewBox="0 0 16 16" aria-hidden="true">
      {filled ? (
        <path
          fill="currentColor"
          stroke="none"
          d="M8 1.6 9.9 5.5l4.3.6-3.1 3 0.7 4.3L8 11.4l-3.8 2 0.7-4.3-3.1-3 4.3-.6L8 1.6z"
        />
      ) : (
        <path d="M8 2.2 9.6 5.6l3.8.5-2.7 2.7.7 3.8L8 10.7l-3.4 1.9.7-3.8L2.6 6.1l3.8-.5L8 2.2z" />
      )}
    </svg>
  )
}

function MoreIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  )
}

function HeaderMenu({
  session,
  canExport,
  onReveal
}: {
  session: SessionMeta
  canExport: boolean
  onReveal: () => void
}): JSX.Element {
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
    <div className={styles.exportWrap} ref={wrapRef}>
      {error ? <span className={styles.exportError} title={error}>{error}</span> : null}
      <button
        className={m(styles, 'export__btn', busy && 'export__btn--spin')}
        type="button"
        disabled={busy}
        title="More"
        aria-label="More actions"
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
      >
        {busy ? <MacIcon name="reload" /> : <MoreIcon />}
      </button>
      {open ? (
        <div className={m(menu, 'dropdownMenu', 'menu', 'export__menu')} role="menu">
          <button
            className={m(menu, 'dropdownMenu__item', 'menu__item')}
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onReveal()
            }}
          >
            <span className={menu['menu__txt']}>Reveal in Finder</span>
          </button>
          <div className={m(menu, 'dropdownMenu__separator', 'menu__sep')} />
          <button
            className={m(menu, 'dropdownMenu__item', 'menu__item')}
            type="button"
            role="menuitem"
            disabled={!canExport}
            onClick={() => void runExport('markdown')}
          >
            <span className={menu['menu__txt']}>Export as Markdown…</span>
          </button>
          <button
            className={m(menu, 'dropdownMenu__item', 'menu__item')}
            type="button"
            role="menuitem"
            disabled={!canExport}
            onClick={() => void runExport('html')}
          >
            <span className={menu['menu__txt']}>Export as HTML…</span>
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
  onReveal,
  onOpenSearch
}: Props): JSX.Element {
  const [starred, setStarred] = useState(false)

  useEffect(() => {
    setStarred(session ? isSessionStarred(session) : false)
  }, [session?.id, session?.source])

  if (!session) {
    return (
      <div className={m(styles, 'viewer', 'viewer--empty', 'detail', 'detail--empty')}>
        <div className={styles['empty-mark']}>
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
  const metaBits = [sourceName(session.source), session.variantLabel].filter(Boolean)

  return (
    <div className={m(styles, 'viewer', 'detail')}>
      <header className={m(styles, 'viewer__header', 'dheader')}>
        <div className={styles['dheader__titleRow']}>
          <div className={styles['dheader__titleGroup']}>
            <div className={m(styles, 'viewer__title', 'dheader__title')}>{sessionTitle(session)}</div>
            <button
              className={m(styles, 'viewerStar', starred && 'viewerStar--on')}
              type="button"
              title={starred ? 'Unstar' : 'Star'}
              aria-label={starred ? 'Unstar session' : 'Star session'}
              aria-pressed={starred}
              onClick={() => {
                setStarred((prev) => {
                  const next = !prev
                  setSessionStarred(session, next)
                  return next
                })
              }}
            >
              <StarIcon filled={starred} />
            </button>
          </div>
          <div className={styles['dheader__actions']}>
            <button
              className={styles.viewerSearchBtn}
              type="button"
              onClick={onOpenSearch}
              title="Search in session (⌘F)"
              aria-label="Search in session"
            >
              <MacIcon name="search" />
              <span>Search in session</span>
              <kbd>⌘F</kbd>
            </button>
            <HeaderMenu session={session} canExport={canExport} onReveal={onReveal} />
          </div>
        </div>
        <div className={m(styles, 'viewer__sub', 'dheader__meta')}>
          <span className={styles['dheader__sourceLine']}>{metaBits.join(' · ')}</span>
          {session.forkParentId ? (
            <span className={styles.viewerForkInline}>
              <span className={m(styles, 'vchip', 'viewerForkChip')} data-tooltip={forkTooltip} aria-label={forkTooltip}>
                fork
              </span>
              <button
                className={styles['viewerFork__jump']}
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
        </div>
      </header>

      <div className={m(styles, 'viewer__body', 'detail__body')}>
        {loading ? (
          <div className={styles.loading}>Loading transcript...</div>
        ) : transcript?.error ? (
          <div className={styles.error}>Failed to load: {transcript.error}</div>
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
