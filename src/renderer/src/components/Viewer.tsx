import type { SessionMeta, TranscriptPayload } from '../../../shared/ipc'
import { fmtBytes, fmtTime, sessionTitle, sourceColor, sourceName } from '../util'
import { JsonView } from './JsonView'
import { SessionView } from './SessionView'

interface Props {
  session: SessionMeta | null
  transcript: TranscriptPayload | null
  loading: boolean
  tab: 'session' | 'json'
  setTab: (t: 'session' | 'json') => void
  onReveal: () => void
}

export function Viewer({ session, transcript, loading, tab, setTab, onReveal }: Props): JSX.Element {
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
      </div>

      <div className="viewer__body">
        {loading ? (
          <div className="loading">Loading transcript…</div>
        ) : transcript?.error ? (
          <div className="error">Failed to load: {transcript.error}</div>
        ) : !transcript ? null : tab === 'session' ? (
          <SessionView nodes={transcript.nodes} />
        ) : (
          <JsonView records={transcript.records} reconstructed={transcript.reconstructed} />
        )}
      </div>
    </div>
  )
}
