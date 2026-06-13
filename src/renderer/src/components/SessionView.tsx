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
  /** One-shot jump request (global search). `token` retriggers same-index jumps.
   *  `query` briefly highlights the matched text on the landed node. */
  scrollTarget?: { index: number; token: number; query: string } | null
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

function CollapseBlocksIcon(): JSX.Element {
  return <MacIcon name="collapseAll" className="blockModeButton__icon" />
}

function ExpandBlocksIcon(): JSX.Element {
  return <MacIcon name="expandAll" className="blockModeButton__icon" />
}

export function SessionView({ nodes, searchQuery, searchHitsByNode, activeMatch, scrollTarget }: Props): JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null)
  const outlineRef = useRef<HTMLDivElement>(null)
  const outlineWrapRef = useRef<HTMLDivElement>(null)
  const outlineCloseTimer = useRef<ReturnType<typeof setTimeout>>()
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
  // react-virtual skips its ref-callback measurement while the list is
  // scrolling and never revisits a row that mounted at the estimated height.
  // Auto-opened blocks (bash/read tool calls, search-hit expansions) are much
  // taller than the estimate, so after a fast scroll the following rows overlap
  // them. Re-measure the rendered rows on demand (callers invoke this once
  // scrolling has settled, when the measurement gate is open again).
  const remeasureRendered = useCallback((): void => {
    parentRef.current?.querySelectorAll<HTMLElement>('[data-index]').forEach((el) => virt.measureElement(el))
  }, [virt])
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
  const blocksExpanded = blockOpenMode === 'expanded'

  useEffect(() => {
    if (!activeMatch || !searchQuery) return
    jumpToIndex(activeMatch.nodeIndex, 'center')
  }, [activeMatch?.nodeIndex, jumpToIndex, searchQuery])

  const [flashIndex, setFlashIndex] = useState<number | null>(null)
  const [flashQuery, setFlashQuery] = useState('')
  useEffect(() => {
    if (!scrollTarget || scrollTarget.index >= nodes.length) return
    jumpToIndex(scrollTarget.index, 'center')
    setFlashIndex(scrollTarget.index)
    setFlashQuery(scrollTarget.query)
    const timer = window.setTimeout(() => {
      setFlashIndex(null)
      setFlashQuery('')
    }, 2400)
    return () => window.clearTimeout(timer)
  }, [scrollTarget?.token])

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
    let settle = 0
    const onScroll = (): void => {
      // Debounced trailing re-measure: react-virtual resets its `isScrolling`
      // flag 150ms after the last scroll, reopening the measurement gate.
      if (settle) clearTimeout(settle)
      settle = window.setTimeout(remeasureRendered, 200)
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
      if (settle) clearTimeout(settle)
      scroller.removeEventListener('scroll', onScroll)
    }
  }, [readTopIndex, remeasureRendered])

  useEffect(() => {
    if (!outlineOpen || currentUserIndex < 0) return
    const current = outlineRef.current?.querySelector(`[data-user-index="${currentUserIndex}"]`)
    current?.scrollIntoView({ block: 'nearest' })
  }, [currentUserIndex, outlineOpen])

  useEffect(() => {
    return () => {
      if (outlineCloseTimer.current) clearTimeout(outlineCloseTimer.current)
    }
  }, [])

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
      <div className="transcript" ref={parentRef}>
        <div className="transcript__inner" style={{ height: virt.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualItems.map((item) => {
            const hitOrdinals = searchHitsByNode.get(item.index)
            // On a cross-session jump the landed row briefly highlights the query
            // text itself (the inline search highlight is off for that scope).
            const isFlashTarget = item.index === flashIndex && !!flashQuery
            const nodeQuery = isFlashTarget ? flashQuery : searchQuery
            const hasMatch = !!hitOrdinals || isFlashTarget
            const activeOrdinal =
              activeMatch?.nodeIndex === item.index ? activeMatch.ordinalInNode : isFlashTarget ? 0 : undefined

            // A collapsible block auto-opens when it has a search hit or when
            // block-open mode changes, growing in place. react-virtual only
            // measures via the ref callback on (re)mount and doesn't reliably
            // re-measure that in-place growth, so following rows overlap the
            // expanded block. Fold the open-affecting state into the React key
            // to force a remount — and thus a fresh measurement — on change.
            const openKey = `${hasMatch ? 'h' : ''}${isFlashTarget ? 'f' : ''}${blockOpenMode}`

            return (
              <div
                key={`${item.key}:${openKey}`}
                data-index={item.index}
                data-kind={nodes[item.index].kind}
                className={item.index === flashIndex ? 'transcriptRow--flash' : undefined}
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
                  searchQuery={nodeQuery}
                  hasSearchMatch={hasMatch}
                  activeMatchOrdinal={activeOrdinal}
                  blockOpenMode={blockOpenMode}
                />
              </div>
            )
          })}
        </div>
      </div>

      {userEntries.length > 1 && (
        <div
          className="chatgptOutline"
          ref={outlineWrapRef}
          onMouseEnter={() => {
            if (outlineCloseTimer.current) clearTimeout(outlineCloseTimer.current)
            setOutlineOpen(true)
          }}
          onMouseLeave={() => {
            outlineCloseTimer.current = setTimeout(() => setOutlineOpen(false), 200)
          }}
        >
          <div
            className={`chatgptOutline__panel${outlineOpen ? ' chatgptOutline__panel--open' : ''}`}
            ref={outlineRef}
            onMouseEnter={() => {
              if (outlineCloseTimer.current) clearTimeout(outlineCloseTimer.current)
            }}
            onMouseLeave={() => {
              outlineCloseTimer.current = setTimeout(() => setOutlineOpen(false), 200)
            }}
          >
            <div className="chatgptOutline__header">
              User Messages ({userEntries.length})
            </div>
            <div className="chatgptOutline__list">
              {userEntries.map((entry, ordinal) => (
                <button
                  key={entry.index}
                  className={`chatgptOutline__item${
                    entry.index === currentUserIndex ? ' chatgptOutline__item--active' : ''
                  }`}
                  type="button"
                  data-user-index={entry.index}
                  onClick={() => jumpToIndex(entry.index)}
                >
                  <span className="chatgptOutline__num">{ordinal + 1}</span>
                  <span className="chatgptOutline__text">{entry.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="chatgptOutline__bridge" />

          <div className="chatgptOutline__lines">
            {userEntries.slice(0, 12).map((_, i) => (
              <div key={i} className="chatgptOutline__line" />
            ))}
          </div>
        </div>
      )}

      <button
        className={`blockModeButton${blocksExpanded ? ' blockModeButton--active' : ''}`}
        type="button"
        data-tooltip={blocksExpanded ? 'Collapse all blocks' : 'Expand all blocks'}
        aria-label={blocksExpanded ? 'Collapse all blocks' : 'Expand all blocks'}
        aria-pressed={blocksExpanded}
        onClick={() => toggleBlockOpenMode('expanded')}
      >
        {blocksExpanded ? <CollapseBlocksIcon /> : <ExpandBlocksIcon />}
      </button>
    </div>
  )
}
