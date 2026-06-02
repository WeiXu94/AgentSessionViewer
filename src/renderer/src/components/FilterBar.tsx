import { useEffect, useRef, useState } from 'react'
import type { GroupMode } from '../util'

interface SourceOption {
  value: string
  label: string
  count: number
}

const GROUP_OPTIONS: Array<{ value: GroupMode; label: string }> = [
  { value: 'chronological', label: 'Chronological' },
  { value: 'date', label: 'Date' },
  { value: 'project-recent', label: 'Project: Recent' },
  { value: 'project-alpha', label: 'Project: A-Z' }
]

interface Props {
  text: string
  source: string
  project: string
  groupMode: GroupMode
  sources: SourceOption[]
  onText: (v: string) => void
  onSource: (v: string) => void
  onProject: (v: string) => void
  onGroupMode: (v: GroupMode) => void
}

export function FilterBar({
  text,
  source,
  project,
  groupMode,
  sources,
  onText,
  onSource,
  onProject,
  onGroupMode
}: Props): JSX.Element {
  const [openMenu, setOpenMenu] = useState<'source' | 'group' | null>(null)
  const controlsRef = useRef<HTMLDivElement>(null)
  const groupLabel = GROUP_OPTIONS.find((option) => option.value === groupMode)?.label ?? 'Chronological'
  const sourceLabel = source ? sources.find((option) => option.value === source)?.label ?? source : 'All agents'

  useEffect(() => {
    if (!openMenu) return

    const onPointerDown = (event: PointerEvent): void => {
      if (!controlsRef.current?.contains(event.target as Node)) setOpenMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpenMenu(null)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [openMenu])

  return (
    <div className="filterbar">
      <input
        className="search"
        type="search"
        placeholder="Search title, project, path…"
        value={text}
        onChange={(e) => onText(e.target.value)}
      />
      <div className="filterbar__row" ref={controlsRef}>
        <div className="menuWrap menuWrap--source">
          <button
            className={`selectButton${openMenu === 'source' ? ' selectButton--active' : ''}`}
            type="button"
            aria-label={`Agent: ${sourceLabel}`}
            aria-haspopup="menu"
            aria-expanded={openMenu === 'source'}
            onClick={() => setOpenMenu((open) => (open === 'source' ? null : 'source'))}
          >
            <span className="selectButton__label">{sourceLabel}</span>
            <svg className="selectButton__chevron" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
          {openMenu === 'source' ? (
            <div className="dropdownMenu dropdownMenu--source" role="menu">
              <button
                className="dropdownMenu__item"
                type="button"
                role="menuitemradio"
                aria-checked={!source}
                onClick={() => {
                  onSource('')
                  setOpenMenu(null)
                }}
              >
                <span className="dropdownMenu__check">{!source ? '✓' : ''}</span>
                <span>All agents</span>
              </button>
              {sources.map((option) => (
                <button
                  key={option.value}
                  className="dropdownMenu__item"
                  type="button"
                  role="menuitemradio"
                  aria-checked={source === option.value}
                  onClick={() => {
                    onSource(option.value)
                    setOpenMenu(null)
                  }}
                >
                  <span className="dropdownMenu__check">{source === option.value ? '✓' : ''}</span>
                  <span className="dropdownMenu__itemText">{option.label}</span>
                  <span className="dropdownMenu__count">{option.count}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="menuWrap">
          <button
            className={`filterIconBtn${openMenu === 'group' ? ' filterIconBtn--active' : ''}`}
            type="button"
            title={`Group by: ${groupLabel}`}
            aria-label={`Group by: ${groupLabel}`}
            aria-haspopup="menu"
            aria-expanded={openMenu === 'group'}
            onClick={() => setOpenMenu((open) => (open === 'group' ? null : 'group'))}
          >
            <svg className="filterIconBtn__icon" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5 3v14M15 3v14M3 7h4M13 13h4" />
              <circle cx="5" cy="7" r="2" />
              <circle cx="15" cy="13" r="2" />
            </svg>
          </button>
          {openMenu === 'group' ? (
            <div className="dropdownMenu dropdownMenu--right" role="menu">
              <div className="dropdownMenu__label">Group by</div>
              {GROUP_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className="dropdownMenu__item"
                  type="button"
                  role="menuitemradio"
                  aria-checked={groupMode === option.value}
                  onClick={() => {
                    onGroupMode(option.value)
                    setOpenMenu(null)
                  }}
                >
                  <span className="dropdownMenu__check">{groupMode === option.value ? '✓' : ''}</span>
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {project ? (
          <button className="chip" onClick={() => onProject('')} title="Clear project filter">
            {project} ✕
          </button>
        ) : null}
      </div>
    </div>
  )
}
