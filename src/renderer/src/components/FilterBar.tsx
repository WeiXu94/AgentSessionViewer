import { useEffect, useRef, useState } from 'react'
import type { GroupMode } from '../util'
import { m } from '../styles/cx'
import menu from '../styles/menus.module.css'
import { MacIcon } from './MacIcons'
import styles from './FilterBar.module.css'

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
  source: string
  project: string
  groupMode: GroupMode
  sources: SourceOption[]
  onSource: (v: string) => void
  onProject: (v: string) => void
  onGroupMode: (v: GroupMode) => void
  listQuery: string
  onListQuery: (v: string) => void
}

export function FilterBar({
  source,
  project,
  groupMode,
  sources,
  onSource,
  onProject,
  onGroupMode,
  listQuery,
  onListQuery
}: Props): JSX.Element {
  const [openMenu, setOpenMenu] = useState<'filter' | null>(null)
  const controlsRef = useRef<HTMLDivElement>(null)
  const groupLabel = GROUP_OPTIONS.find((option) => option.value === groupMode)?.label ?? 'Chronological'
  const sourceLabel = source ? sources.find((option) => option.value === source)?.label ?? source : 'All agents'
  const filterActive = !!(source || project || groupMode !== 'chronological')

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
    <div className={m(styles, 'filterbar', 'sb-controls')}>
      <div className={styles['sb-searchrow']} ref={controlsRef}>
        <div className={styles['sb-search']}>
          <MacIcon name="search" />
          <input
            className={styles.search}
            type="search"
            value={listQuery}
            onChange={(e) => onListQuery(e.target.value)}
            placeholder="Search sessions"
            aria-label="Search sessions"
          />
        </div>
        <div className={styles.menuWrap}>
          <button
            className={m(
              styles,
              'filterIconBtn',
              'icon-btn',
              (openMenu === 'filter' || filterActive) && 'filterIconBtn--active',
              (openMenu === 'filter' || filterActive) && 'icon-btn--on'
            )}
            type="button"
            title="Filter & group"
            aria-label="Filter and group sessions"
            aria-haspopup="menu"
            aria-expanded={openMenu === 'filter'}
            onClick={() => setOpenMenu((open) => (open === 'filter' ? null : 'filter'))}
          >
            <MacIcon name="group" className={styles['filterIconBtn__icon']} />
          </button>
          {openMenu === 'filter' ? (
            <div className={m(menu, 'dropdownMenu', 'dropdownMenu--right', 'menu', 'menu--right')} role="menu">
              <div className={m(menu, 'dropdownMenu__label', 'menu__label')}>Agent</div>
              <button
                className={m(menu, 'dropdownMenu__item', 'menu__item')}
                type="button"
                role="menuitemradio"
                aria-checked={!source}
                onClick={() => {
                  onSource('')
                }}
              >
                <span className={m(menu, 'dropdownMenu__check', 'menu__check')}>
                  {!source ? <MacIcon name="check" /> : null}
                </span>
                <span className={menu['menu__txt']}>All Agents</span>
              </button>
              {sources.map((option) => (
                <button
                  key={option.value}
                  className={m(menu, 'dropdownMenu__item', 'menu__item')}
                  type="button"
                  role="menuitemradio"
                  aria-checked={source === option.value}
                  onClick={() => {
                    onSource(option.value)
                  }}
                >
                  <span className={m(menu, 'dropdownMenu__check', 'menu__check')}>
                    {source === option.value ? <MacIcon name="check" /> : null}
                  </span>
                  <span className={m(menu, 'dropdownMenu__itemText', 'menu__txt')}>{option.label}</span>
                  <span className={m(menu, 'dropdownMenu__count', 'menu__count')}>{option.count}</span>
                </button>
              ))}
              <div className={m(menu, 'dropdownMenu__separator', 'menu__sep')} />
              <div className={m(menu, 'dropdownMenu__label', 'menu__label')}>Group By</div>
              {GROUP_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className={m(menu, 'dropdownMenu__item', 'menu__item')}
                  type="button"
                  role="menuitemradio"
                  aria-checked={groupMode === option.value}
                  onClick={() => {
                    onGroupMode(option.value)
                  }}
                >
                  <span className={m(menu, 'dropdownMenu__check', 'menu__check')}>
                    {groupMode === option.value ? <MacIcon name="check" /> : null}
                  </span>
                  <span className={menu['menu__txt']}>{option.label}</span>
                </button>
              ))}
              {project ? (
                <>
                  <div className={m(menu, 'dropdownMenu__separator', 'menu__sep')} />
                  <button
                    className={m(menu, 'dropdownMenu__item', 'menu__item')}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onProject('')
                      setOpenMenu(null)
                    }}
                  >
                    <span className={menu['menu__txt']}>Clear project: {project}</span>
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {project ? (
        <button type="button" className={m(styles, 'chip', 'chip-clear')} onClick={() => onProject('')} title="Clear project filter">
          <span>{project}</span>
          <MacIcon name="close" />
        </button>
      ) : null}
      {source ? (
        <div className={styles['sb-activeFilters']}>
          <span className={styles['sb-activeFilters__label']}>{sourceLabel}</span>
          <span className={styles['sb-activeFilters__hint']}>· {groupLabel}</span>
        </div>
      ) : null}
    </div>
  )
}
