interface SourceOption {
  value: string
  label: string
  count: number
}

interface Props {
  text: string
  source: string
  project: string
  sources: SourceOption[]
  onText: (v: string) => void
  onSource: (v: string) => void
  onProject: (v: string) => void
}

export function FilterBar({ text, source, project, sources, onText, onSource, onProject }: Props): JSX.Element {
  return (
    <div className="filterbar">
      <input
        className="search"
        type="search"
        placeholder="Search title, project, path…"
        value={text}
        onChange={(e) => onText(e.target.value)}
      />
      <div className="filterbar__row">
        <select className="select" value={source} onChange={(e) => onSource(e.target.value)}>
          <option value="">All agents</option>
          {sources.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label} ({s.count})
            </option>
          ))}
        </select>
        {project ? (
          <button className="chip" onClick={() => onProject('')} title="Clear project filter">
            {project} ✕
          </button>
        ) : null}
      </div>
    </div>
  )
}
