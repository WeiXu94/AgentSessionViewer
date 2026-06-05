import { useEffect, useRef, useState } from 'react'
import type { GroupMode } from '../util'
import { MacIcon } from './MacIcons'

interface SourceOption {
  value: string
  label: string
  count: number
}

const GROUP_OPTIONS: Array<{ value: GroupMode; label: string }> = [
  { value: 'chronological', label: 'Chronological' },
  { value: 'date', label: 'Date' },
  { value: 'project-recent', label: 'Project · Recent' },
  { value: 'project-alpha', label: 'Project · A-Z' }
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
    <div className="filterbar sb-controls">
      <label className="sb-search">
        <MacIcon name="search" />
        <input
          className="search"
          type="search"
          placeholder="Search"
          value={text}
          onChange={(e) => onText(e.target.value)}
        />
      </label>
      <div className="filterbar__row sb-filterrow" ref={controlsRef}>
        <div className="menuWrap menuWrap--source popup">
          <button
            className={`selectButton popup__btn${openMenu === 'source' ? ' selectButton--active' : ''}`}
            type="button"
            aria-label={`Agent: ${sourceLabel}`}
            aria-haspopup="menu"
            aria-expanded={openMenu === 'source'}
            onClick={() => setOpenMenu((open) => (open === 'source' ? null : 'source'))}
          >
            <span className="selectButton__label lbl">{sourceLabel}</span>
            <span className="popup__chev">
              <MacIcon name="popChev" viewBox="0 0 9 12" />
            </span>
          </button>
          {openMenu === 'source' ? (
            <div className="dropdownMenu dropdownMenu--source menu menu--under" role="menu">
              <button
                className="dropdownMenu__item menu__item"
                type="button"
                role="menuitemradio"
                aria-checked={!source}
                onClick={() => {
                  onSource('')
                  setOpenMenu(null)
                }}
              >
                <span className="dropdownMenu__check menu__check">{!source ? <MacIcon name="check" /> : null}</span>
                <span className="menu__txt">All Agents</span>
              </button>
              {sources.map((option) => (
                <button
                  key={option.value}
                  className="dropdownMenu__item menu__item"
                  type="button"
                  role="menuitemradio"
                  aria-checked={source === option.value}
                  onClick={() => {
                    onSource(option.value)
                    setOpenMenu(null)
                  }}
                >
                  <span className="dropdownMenu__check menu__check">
                    {source === option.value ? <MacIcon name="check" /> : null}
                  </span>
                  <span className="dropdownMenu__itemText menu__txt">{option.label}</span>
                  <span className="dropdownMenu__count menu__count">{option.count}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="menuWrap">
          <button
            className={`filterIconBtn icon-btn${openMenu === 'group' ? ' filterIconBtn--active icon-btn--on' : ''}`}
            type="button"
            title={`Group by: ${groupLabel}`}
            aria-label={`Group by: ${groupLabel}`}
            aria-haspopup="menu"
            aria-expanded={openMenu === 'group'}
            onClick={() => setOpenMenu((open) => (open === 'group' ? null : 'group'))}
          >
            <MacIcon name="group" className="filterIconBtn__icon" />
          </button>
          {openMenu === 'group' ? (
            <div className="dropdownMenu dropdownMenu--right menu menu--right" role="menu">
              <div className="dropdownMenu__label menu__label">Group By</div>
              {GROUP_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className="dropdownMenu__item menu__item"
                  type="button"
                  role="menuitemradio"
                  aria-checked={groupMode === option.value}
                  onClick={() => {
                    onGroupMode(option.value)
                    setOpenMenu(null)
                  }}
                >
                  <span className="dropdownMenu__check menu__check">
                    {groupMode === option.value ? <MacIcon name="check" /> : null}
                  </span>
                  <span className="menu__txt">{option.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {project ? (
          <button className="chip chip-clear" onClick={() => onProject('')} title="Clear project filter">
            <span>{project}</span>
            <MacIcon name="close" />
          </button>
        ) : null}
      </div>
    </div>
  )
}
