import type { SessionMeta, TranscriptPayload } from '../../../shared/ipc'
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
          />
        ) : (
          <JsonView records={transcript.records} reconstructed={transcript.reconstructed} />
        )}
      </div>
    </div>
  )
}
