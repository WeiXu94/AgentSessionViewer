import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ViewNode } from '../../../shared/ipc'
import { displayNodeText, NodeBubble } from './NodeBubble'

export interface SessionSearchMatch {
  nodeIndex: number
  ordinalInNode: number
}

interface UserOutlineEntry {
  index: number
  label: string
}

interface Props {
  nodes: ViewNode[]
  searchQuery: string
  searchHitsByNode: Map<number, Set<number>>
  activeMatch: SessionSearchMatch | null
}

type BlockOpenMode = 'default' | 'collapsed' | 'expanded'

function compactStickyText(node: ViewNode): string {
  return displayNodeText(node.text).replace(/\s+/g, ' ').trim() || node.title || 'User'
}

function currentUserAt(userIndexes: number[], topIndex: number): number {
  if (userIndexes.length === 0) return -1

  let current = userIndexes[0]
  for (const index of userIndexes) {
    if (index <= topIndex) current = index
    else break
  }
  return current
}

function topVisibleIndex(items: Array<{ index: number; start: number }>, scrollTop: number): number {
  if (items.length === 0) return 0

  let topIndex = items[0].index
  for (const item of items) {
    if (item.start <= scrollTop + 1) topIndex = item.index
    else break
  }
  return topIndex
}

function OutlineIcon(): JSX.Element {
  return (
    <svg className="userOutline__svg" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.75 4.25h8" />
      <path d="M5.75 8h8" />
      <path d="M5.75 11.75h8" />
      <circle cx="2.5" cy="4.25" r="0.75" />
      <circle cx="2.5" cy="8" r="0.75" />
      <circle cx="2.5" cy="11.75" r="0.75" />
    </svg>
  )
}

function CollapseBlocksIcon(): JSX.Element {
  return (
    <svg className="blockToggle__icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5.5 5.75h9" />
      <path d="M4.75 10h10.5" />
      <path d="M5.5 14.25h9" />
    </svg>
  )
}

function ExpandBlocksIcon(): JSX.Element {
  return (
    <svg className="blockToggle__icon" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="4.25" y="3.75" width="11.5" height="12.5" rx="2" />
      <path d="M7 7.5h6" />
      <path d="M7 10h6" />
      <path d="M7 12.5h3.75" />
    </svg>
  )
}

export function SessionView({ nodes, searchQuery, searchHitsByNode, activeMatch }: Props): JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null)
  const outlineRef = useRef<HTMLDivElement>(null)
  const outlineWrapRef = useRef<HTMLDivElement>(null)
  const topIndexRef = useRef(0)
  const [topIndex, setTopIndex] = useState(0)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [blockOpenMode, setBlockOpenMode] = useState<BlockOpenMode>('default')
  const toggleBlockOpenMode = useCallback((mode: Exclude<BlockOpenMode, 'default'>): void => {
    setBlockOpenMode((current) => (current === mode ? 'default' : mode))
  }, [])
  const updateTopIndex = useCallback((nextIndex: number): void => {
    if (topIndexRef.current === nextIndex) return
    topIndexRef.current = nextIndex
    setTopIndex(nextIndex)
  }, [])
  const virt = useVirtualizer({
    count: nodes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 140,
    overscan: 6,
    measureElement: (el) => el?.getBoundingClientRect().height ?? 140
  })
  const virtualItems = virt.getVirtualItems()
  const readTopIndex = useCallback((): void => {
    const scrollTop = parentRef.current?.scrollTop ?? 0
    updateTopIndex(virt.getVirtualItemForOffset(scrollTop + 1)?.index ?? 0)
  }, [updateTopIndex, virt])
  const jumpToIndex = useCallback(
    (index: number, align: 'start' | 'center' = 'start'): void => {
      const offset = virt.getOffsetForIndex(index, align)?.[0]
      updateTopIndex(index)
      if (offset === undefined) {
        virt.scrollToIndex(index, { align })
        return
      }

      const scrollToOffset = (): void => {
        if (parentRef.current) {
          parentRef.current.scrollTop = offset
          parentRef.current.dispatchEvent(new Event('scroll', { bubbles: true }))
        }
      }

      scrollToOffset()
      requestAnimationFrame(() => {
        scrollToOffset()
        virt.measure()
        readTopIndex()
      })
    },
    [readTopIndex, updateTopIndex, virt]
  )
  const userEntries = useMemo<UserOutlineEntry[]>(
    () => nodes.flatMap((node, index) => (node.kind === 'user' ? [{ index, label: compactStickyText(node) }] : [])),
    [nodes]
  )
  const userIndexes = useMemo(() => userEntries.map((entry) => entry.index), [userEntries])
  const scrollTop = parentRef.current?.scrollTop ?? 0
  const lastVirtualEnd = virtualItems.at(-1)?.end ?? 0
  const renderedTopIndex = topVisibleIndex(virtualItems, scrollTop)
  const effectiveTopIndex = lastVirtualEnd > 0 && lastVirtualEnd < scrollTop ? topIndex : renderedTopIndex
  const currentUserIndex = currentUserAt(userIndexes, effectiveTopIndex)
  const currentUserOrdinal = userEntries.findIndex((entry) => entry.index === currentUserIndex)
  const currentUserEntry = currentUserOrdinal >= 0 ? userEntries[currentUserOrdinal] : (userEntries[0] ?? null)

  useEffect(() => {
    if (!activeMatch || !searchQuery) return
    jumpToIndex(activeMatch.nodeIndex, 'center')
  }, [activeMatch?.nodeIndex, jumpToIndex, searchQuery])

  useEffect(() => {
    topIndexRef.current = 0
    setTopIndex(0)
    setBlockOpenMode('default')
    requestAnimationFrame(readTopIndex)
  }, [nodes, readTopIndex])

  useEffect(() => {
    const scroller = parentRef.current
    if (!scroller) return

    let frame = 0
    const onScroll = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        readTopIndex()
      })
    }

    scroller.addEventListener('scroll', onScroll, { passive: true })
    readTopIndex()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', onScroll)
    }
  }, [readTopIndex])

  useEffect(() => {
    if (!outlineOpen || currentUserIndex < 0) return
    const current = outlineRef.current?.querySelector(`[data-user-index="${currentUserIndex}"]`)
    current?.scrollIntoView({ block: 'nearest' })
  }, [currentUserIndex, outlineOpen])

  useEffect(() => {
    if (!outlineOpen) return

    const onPointerDown = (event: PointerEvent): void => {
      if (!outlineWrapRef.current?.contains(event.target as Node)) setOutlineOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOutlineOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [outlineOpen])

  if (nodes.length === 0) {
    return <div className="transcript transcript--empty">No renderable messages in this session.</div>
  }

  return (
    <div className="sessionView">
      <div className="userOutlineWrap" ref={outlineWrapRef}>
        <div className="userOutlineBar" aria-label="User message outline">
          <button
            className={`userOutline__iconBtn${outlineOpen ? ' userOutline__iconBtn--active' : ''}`}
            type="button"
            disabled={userEntries.length === 0}
            title="Show user message outline"
            aria-label="Show user message outline"
            aria-expanded={outlineOpen}
            onClick={() => setOutlineOpen((open) => !open)}
          >
            <OutlineIcon />
          </button>
          <div className="userOutline__summary">
            <span className="userOutline__summaryLabel">
              {currentUserOrdinal >= 0 ? `User message · ${currentUserOrdinal + 1}` : 'User message'}
            </span>
            <span className="userOutline__summaryText">
              {currentUserEntry ? currentUserEntry.label : 'No user messages'}
            </span>
          </div>
          <div className="blockToggle" aria-label="Transcript block display">
            <button
              className={`blockToggle__btn${blockOpenMode === 'collapsed' ? ' blockToggle__btn--active' : ''}`}
              type="button"
              title={blockOpenMode === 'collapsed' ? 'Restore default blocks' : 'Collapse all blocks'}
              aria-label={blockOpenMode === 'collapsed' ? 'Restore default blocks' : 'Collapse all blocks'}
              aria-pressed={blockOpenMode === 'collapsed'}
              onClick={() => toggleBlockOpenMode('collapsed')}
            >
              <CollapseBlocksIcon />
            </button>
            <button
              className={`blockToggle__btn${blockOpenMode === 'expanded' ? ' blockToggle__btn--active' : ''}`}
              type="button"
              title={blockOpenMode === 'expanded' ? 'Restore default blocks' : 'Unfold all blocks'}
              aria-label={blockOpenMode === 'expanded' ? 'Restore default blocks' : 'Unfold all blocks'}
              aria-pressed={blockOpenMode === 'expanded'}
              onClick={() => toggleBlockOpenMode('expanded')}
            >
              <ExpandBlocksIcon />
            </button>
          </div>
        </div>

        {outlineOpen ? (
          <div className="userOutlinePopover" ref={outlineRef} role="menu" aria-label="User messages">
            {userEntries.map((entry, ordinal) => (
              <button
                key={entry.index}
                className={`userOutline__item${entry.index === currentUserIndex ? ' userOutline__item--active' : ''}`}
                type="button"
                role="menuitem"
                data-user-index={entry.index}
                title={entry.label}
                onClick={() => {
                  jumpToIndex(entry.index)
                  setOutlineOpen(false)
                }}
              >
                <span className="userOutline__number">{ordinal + 1}</span>
                <span className="userOutline__text">{entry.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="transcript" ref={parentRef}>
        <div style={{ height: virt.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualItems.map((item) => {
            const hitOrdinals = searchHitsByNode.get(item.index)
            const activeOrdinal = activeMatch?.nodeIndex === item.index ? activeMatch.ordinalInNode : undefined

            return (
              <div
                key={item.key}
                data-index={item.index}
                data-kind={nodes[item.index].kind}
                ref={virt.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${item.start}px)`
                }}
              >
                <NodeBubble
                  node={nodes[item.index]}
                  searchQuery={searchQuery}
                  hasSearchMatch={!!hitOrdinals}
                  activeMatchOrdinal={activeOrdinal}
                  blockOpenMode={blockOpenMode}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
