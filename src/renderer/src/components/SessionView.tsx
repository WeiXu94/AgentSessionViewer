import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ViewNode } from '../../../shared/ipc'
import { MacIcon } from './MacIcons'
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
  const text = displayNodeText(node.text).replace(/\s+/g, ' ').trim() || node.title || 'User'
  return node.inherited ? `[parent] ${text}` : text
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
  return <MacIcon name="outline" className="userOutline__svg" />
}

function CollapseBlocksIcon(): JSX.Element {
  return <MacIcon name="collapse" className="blockToggle__icon" />
}

function ExpandBlocksIcon(): JSX.Element {
  return <MacIcon name="expand" className="blockToggle__icon" />
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
    <div className="sessionView detail__body">
      <div className="userOutlineWrap" ref={outlineWrapRef}>
        <div className="userOutlineBar inspbar" aria-label="User message outline">
          <button
            className={`userOutline__iconBtn inspbar__btn${outlineOpen ? ' userOutline__iconBtn--active inspbar__btn--on' : ''}`}
            type="button"
            disabled={userEntries.length === 0}
            title="Show user message outline"
            aria-label="Show user message outline"
            aria-expanded={outlineOpen}
            onClick={() => setOutlineOpen((open) => !open)}
          >
            <OutlineIcon />
          </button>
          <div className="userOutline__summary inspbar__sum">
            <span className="userOutline__summaryLabel inspbar__label">
              {currentUserOrdinal >= 0
                ? `User message · ${currentUserOrdinal + 1} / ${userEntries.length}`
                : 'User message'}
            </span>
            <span className="userOutline__summaryText inspbar__text">
              {currentUserEntry ? currentUserEntry.label : 'No user messages'}
            </span>
          </div>
          <div className="blockToggle segmented segmented--blocks" aria-label="Transcript block display">
            <button
              className={`blockToggle__btn seg seg--icon${blockOpenMode === 'collapsed' ? ' blockToggle__btn--active seg--on' : ''}`}
              type="button"
              title={blockOpenMode === 'collapsed' ? 'Restore default blocks' : 'Collapse all blocks'}
              aria-label={blockOpenMode === 'collapsed' ? 'Restore default blocks' : 'Collapse all blocks'}
              aria-pressed={blockOpenMode === 'collapsed'}
              onClick={() => toggleBlockOpenMode('collapsed')}
            >
              <CollapseBlocksIcon />
            </button>
            <button
              className={`blockToggle__btn seg seg--icon${blockOpenMode === 'expanded' ? ' blockToggle__btn--active seg--on' : ''}`}
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
          <div className="userOutlinePopover outlinepop" ref={outlineRef} role="menu" aria-label="User messages">
            {userEntries.map((entry, ordinal) => (
              <button
                key={entry.index}
                className={`userOutline__item outline-item${
                  entry.index === currentUserIndex ? ' userOutline__item--active outline-item--active' : ''
                }`}
                type="button"
                role="menuitem"
                data-user-index={entry.index}
                title={entry.label}
                onClick={() => {
                  jumpToIndex(entry.index)
                  setOutlineOpen(false)
                }}
              >
                <span className="userOutline__number outline-item__num">{ordinal + 1}</span>
                <span className="userOutline__text outline-item__txt">{entry.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="transcript" ref={parentRef}>
        <div className="transcript__inner" style={{ height: virt.getTotalSize(), position: 'relative', width: '100%' }}>
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
