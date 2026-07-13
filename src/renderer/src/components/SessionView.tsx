import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ViewNode } from '../../../shared/ipc'
import { m } from '../styles/cx'
import { displayNodeText, NodeBubble, ToolGroupBubble, bubbleStyles } from './NodeBubble'
import styles from './SessionView.module.css'

export interface SessionSearchMatch {
  nodeIndex: number
  ordinalInNode: number
}

interface UserOutlineEntry {
  /** Index into `displayItems`. */
  itemIndex: number
  /** Original node index (for search/scroll targets). */
  nodeIndex: number
  label: string
}

interface Props {
  nodes: ViewNode[]
  searchQuery: string
  searchHitsByNode: Map<number, Set<number>>
  activeMatch: SessionSearchMatch | null
  scrollTarget?: { index: number; token: number; query: string } | null
}

type BlockOpenMode = 'default' | 'collapsed' | 'expanded'

type DisplayItem =
  | { kind: 'node'; node: ViewNode; nodeIndex: number; showHead: boolean }
  | { kind: 'group'; nodes: ViewNode[]; indexes: number[] }

function isToolish(kind: ViewNode['kind']): boolean {
  return kind === 'tool_call' || kind === 'tool_result' || kind === 'thinking' || kind === 'system' || kind === 'meta'
}

/**
 * Collapse consecutive tool/thinking/system nodes into "N tool events" rows.
 * Assistant role header is shown only once per turn (until the next user message).
 */
function buildDisplayItems(nodes: ViewNode[]): DisplayItem[] {
  const items: DisplayItem[] = []
  let i = 0
  let assistantHeadShown = false
  while (i < nodes.length) {
    const node = nodes[i]
    if (isToolish(node.kind)) {
      const groupNodes: ViewNode[] = []
      const indexes: number[] = []
      while (i < nodes.length && isToolish(nodes[i].kind)) {
        groupNodes.push(nodes[i])
        indexes.push(i)
        i++
      }
      if (groupNodes.length === 1 && groupNodes[0].kind !== 'tool_call' && groupNodes[0].kind !== 'tool_result') {
        items.push({ kind: 'node', node: groupNodes[0], nodeIndex: indexes[0], showHead: true })
      } else {
        items.push({ kind: 'group', nodes: groupNodes, indexes })
      }
    } else if (node.kind === 'user') {
      assistantHeadShown = false
      items.push({ kind: 'node', node, nodeIndex: i, showHead: true })
      i++
    } else if (node.kind === 'assistant') {
      const showHead = !assistantHeadShown
      assistantHeadShown = true
      items.push({ kind: 'node', node, nodeIndex: i, showHead })
      i++
    } else {
      items.push({ kind: 'node', node, nodeIndex: i, showHead: true })
      i++
    }
  }
  return items
}

function compactStickyText(node: ViewNode): string {
  const text = displayNodeText(node.text).replace(/\s+/g, ' ').trim() || node.title || 'User'
  return node.inherited ? `[parent] ${text}` : text
}

function currentUserAt(userItemIndexes: number[], topIndex: number): number {
  if (userItemIndexes.length === 0) return -1
  let current = userItemIndexes[0]
  for (const index of userItemIndexes) {
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

interface RowMetrics {
  collapsedH: number
  proseBaseH: number
  proseLineH: number
  proseCPL: number
  monoLineH: number
  monoCPL: number
}

const DEFAULT_ROW_METRICS: RowMetrics = {
  collapsedH: 44,
  proseBaseH: 72,
  proseLineH: 24,
  proseCPL: 90,
  monoLineH: 19,
  monoCPL: 110
}

const TRANSCRIPT_PAD_X = 80
const BODY_PAD_X = 28
const MAX_EXPANDED_BODY = 420
const EXPANDED_BODY_CHROME = 25
const MAX_ESTIMATE_TEXT = 200_000

function wrappedLines(text: string, cpl: number): number {
  const t = text.length > MAX_ESTIMATE_TEXT ? text.slice(0, MAX_ESTIMATE_TEXT) : text
  let lines = 0
  let start = 0
  for (let i = 0; i <= t.length; i++) {
    if (i === t.length || t.charCodeAt(i) === 10) {
      const len = i - start
      lines += len === 0 ? 1 : Math.ceil(len / cpl)
      start = i + 1
    }
  }
  return Math.max(1, lines)
}

function estimateItemHeight(item: DisplayItem, m: RowMetrics, expanded: boolean): number {
  if (item.kind === 'group') {
    if (!expanded) return m.collapsedH
    let h = m.collapsedH + 12
    for (const node of item.nodes) {
      h += m.collapsedH
      if (expanded) {
        const body = Math.min(MAX_EXPANDED_BODY, wrappedLines(node.text, m.monoCPL) * m.monoLineH)
        h += body + EXPANDED_BODY_CHROME
      }
    }
    return h
  }
  const node = item.node
  if (node.kind !== 'user' && node.kind !== 'assistant') {
    if (!expanded) return m.collapsedH
    const body = Math.min(MAX_EXPANDED_BODY, wrappedLines(node.text, m.monoCPL) * m.monoLineH)
    return m.collapsedH + body + EXPANDED_BODY_CHROME
  }
  return m.proseBaseH + wrappedLines(node.text, m.proseCPL) * m.proseLineH
}

function measureRowMetrics(scroller: HTMLElement): RowMetrics {
  const innerW = Math.max(120, scroller.clientWidth - TRANSCRIPT_PAD_X)
  const probe = document.createElement('div')
  probe.style.cssText = `position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;width:${innerW}px;`
  const b = bubbleStyles
  probe.innerHTML =
    `<div class="${b.bubble} ${b['bubble--toolgroup']}"><details class="${b.block} ${b['block--toolgroup']}"><summary class="${b['bubble__summary']} ${b['block__summary']}"><span class="${b['block__tri']}"></span><span class="${b['bubble__title']} ${b['block__title']}">8 tool events</span></summary></details></div>` +
    `<div class="${b.bubble} ${b['bubble--assistant']}"><div class="${b['bubble__head']}"><span class="${b['bubble__role']}">A</span></div><div class="${b['bubble__text']} ${b.msg}"><span class="${b['msg--md']}"><p>x</p></span></div></div>` +
    `<div class="${b.bubble} ${b['bubble--assistant']}"><div class="${b['bubble__head']}"><span class="${b['bubble__role']}">A</span></div><div class="${b['bubble__text']} ${b.msg}"><span class="${b['msg--md']}"><p>x<br>y</p></span></div></div>`
  scroller.appendChild(probe)
  try {
    const [collapsedEl, oneEl, twoEl] = Array.from(probe.children) as HTMLElement[]
    const collapsedH = Math.round(collapsedEl.getBoundingClientRect().height) || DEFAULT_ROW_METRICS.collapsedH
    const oneH = oneEl.getBoundingClientRect().height
    const twoH = twoEl.getBoundingClientRect().height
    const proseLineH = Math.max(14, Math.round(twoH - oneH)) || DEFAULT_ROW_METRICS.proseLineH
    const proseBaseH = Math.max(0, Math.round(oneH - proseLineH)) || DEFAULT_ROW_METRICS.proseBaseH
    const proseFont = parseFloat(getComputedStyle(oneEl.querySelector(`.${bubbleStyles['msg--md']}`) as Element).fontSize) || 15
    const contentW = innerW - BODY_PAD_X
    return {
      collapsedH,
      proseBaseH,
      proseLineH,
      proseCPL: Math.max(20, Math.floor(contentW / (proseFont * 0.5))),
      monoLineH: 19,
      monoCPL: Math.max(20, Math.floor(contentW / (12 * 0.6)))
    }
  } finally {
    scroller.removeChild(probe)
  }
}

function sameMetrics(a: RowMetrics, b: RowMetrics): boolean {
  return (
    a.collapsedH === b.collapsedH &&
    a.proseBaseH === b.proseBaseH &&
    a.proseLineH === b.proseLineH &&
    a.proseCPL === b.proseCPL &&
    a.monoLineH === b.monoLineH &&
    a.monoCPL === b.monoCPL
  )
}

export function SessionView({ nodes, searchQuery, searchHitsByNode, activeMatch, scrollTarget }: Props): JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null)
  const outlineRef = useRef<HTMLDivElement>(null)
  const outlineWrapRef = useRef<HTMLDivElement>(null)
  const outlineCloseTimer = useRef<ReturnType<typeof setTimeout>>()
  const topIndexRef = useRef(0)
  const [topIndex, setTopIndex] = useState(0)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const blockOpenMode: BlockOpenMode = 'default'
  const updateTopIndex = useCallback((nextIndex: number): void => {
    if (topIndexRef.current === nextIndex) return
    topIndexRef.current = nextIndex
    setTopIndex(nextIndex)
  }, [])
  const [rowMetrics, setRowMetrics] = useState<RowMetrics>(DEFAULT_ROW_METRICS)

  const displayItems = useMemo(() => buildDisplayItems(nodes), [nodes])

  /** Map original node index → display item index (for search jumps). */
  const nodeToItem = useMemo(() => {
    const map = new Map<number, number>()
    displayItems.forEach((item, itemIndex) => {
      if (item.kind === 'node') map.set(item.nodeIndex, itemIndex)
      else for (const ni of item.indexes) map.set(ni, itemIndex)
    })
    return map
  }, [displayItems])

  useLayoutEffect(() => {
    const scroller = parentRef.current
    if (!scroller) return
    const update = (): void => {
      const next = measureRowMetrics(scroller)
      setRowMetrics((prev) => (sameMetrics(prev, next) ? prev : next))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [nodes])

  const estimates = useMemo(() => {
    return displayItems.map((item) => estimateItemHeight(item, rowMetrics, false))
  }, [displayItems, rowMetrics])

  const estimateSize = useCallback(
    (index: number): number => estimates[index] ?? rowMetrics.proseBaseH,
    [estimates, rowMetrics.proseBaseH]
  )

  const virt = useVirtualizer({
    count: displayItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize,
    overscan: 6,
    measureElement: (el) => el?.getBoundingClientRect().height ?? rowMetrics.collapsedH
  })
  const virtualItems = virt.getVirtualItems()
  const readTopIndex = useCallback((): void => {
    const scrollTop = parentRef.current?.scrollTop ?? 0
    updateTopIndex(virt.getVirtualItemForOffset(scrollTop + 1)?.index ?? 0)
  }, [updateTopIndex, virt])

  const remeasureRendered = useCallback((): void => {
    parentRef.current?.querySelectorAll<HTMLElement>('[data-index]').forEach((el) => virt.measureElement(el))
  }, [virt])

  const jumpToItemIndex = useCallback(
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

  const jumpToNodeIndex = useCallback(
    (nodeIndex: number, align: 'start' | 'center' = 'start'): void => {
      const itemIndex = nodeToItem.get(nodeIndex)
      if (itemIndex === undefined) return
      jumpToItemIndex(itemIndex, align)
    },
    [jumpToItemIndex, nodeToItem]
  )

  const userEntries = useMemo<UserOutlineEntry[]>(
    () =>
      displayItems.flatMap((item, itemIndex) =>
        item.kind === 'node' && item.node.kind === 'user'
          ? [{ itemIndex, nodeIndex: item.nodeIndex, label: compactStickyText(item.node) }]
          : []
      ),
    [displayItems]
  )
  const userItemIndexes = useMemo(() => userEntries.map((e) => e.itemIndex), [userEntries])
  const scrollTop = parentRef.current?.scrollTop ?? 0
  const lastVirtualEnd = virtualItems.at(-1)?.end ?? 0
  const renderedTopIndex = topVisibleIndex(virtualItems, scrollTop)
  const effectiveTopIndex = lastVirtualEnd > 0 && lastVirtualEnd < scrollTop ? topIndex : renderedTopIndex
  const currentUserIndex = currentUserAt(userItemIndexes, effectiveTopIndex)

  useEffect(() => {
    if (!activeMatch || !searchQuery) return
    jumpToNodeIndex(activeMatch.nodeIndex, 'center')
  }, [activeMatch?.nodeIndex, jumpToNodeIndex, searchQuery])

  const [flashIndex, setFlashIndex] = useState<number | null>(null)
  const [flashQuery, setFlashQuery] = useState('')
  useEffect(() => {
    if (!scrollTarget || scrollTarget.index >= nodes.length) return
    jumpToNodeIndex(scrollTarget.index, 'center')
    setFlashIndex(scrollTarget.index)
    setFlashQuery(scrollTarget.query)
    const timer = window.setTimeout(() => {
      setFlashIndex(null)
      setFlashQuery('')
    }, 2400)
    return () => window.clearTimeout(timer)
  }, [scrollTarget?.token])

  useEffect(() => {
    const highlights = (CSS as unknown as { highlights?: { set(k: string, v: object): void; delete(k: string): void } })
      .highlights
    const HighlightCtor = (window as unknown as { Highlight?: new (...ranges: Range[]) => object }).Highlight
    if (!highlights || !HighlightCtor) return
    if (flashIndex === null || !flashQuery) {
      highlights.delete('jump-search')
      return
    }
    const needle = flashQuery.toLowerCase()
    let raf = 0
    let tries = 0
    const attempt = (): void => {
      const itemIndex = nodeToItem.get(flashIndex)
      const root =
        itemIndex === undefined
          ? null
          : parentRef.current?.querySelector(`[data-index="${itemIndex}"]`)
      const target = (root?.querySelector(`.${bubbleStyles['bubble__text']}`) as Element | null) ?? root
      if (target) {
        const ranges: Range[] = []
        const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
        let textNode: Node | null
        while ((textNode = walker.nextNode())) {
          const content = textNode.textContent ?? ''
          const lower = content.toLowerCase()
          let from = 0
          for (;;) {
            const idx = lower.indexOf(needle, from)
            if (idx === -1) break
            const range = document.createRange()
            range.setStart(textNode, idx)
            range.setEnd(textNode, idx + needle.length)
            ranges.push(range)
            from = idx + needle.length
          }
        }
        if (ranges.length) {
          highlights.set('jump-search', new HighlightCtor(...ranges))
          const scroller = parentRef.current
          if (scroller) {
            const rect = ranges[0].getBoundingClientRect()
            const sr = scroller.getBoundingClientRect()
            if (rect.height && (rect.top < sr.top + 60 || rect.bottom > sr.bottom - 60)) {
              scroller.scrollTop += rect.top - sr.top - scroller.clientHeight / 2 + rect.height / 2
            }
          }
          return
        }
      }
      if (tries++ < 36) raf = requestAnimationFrame(attempt)
    }
    raf = requestAnimationFrame(attempt)
    return () => {
      cancelAnimationFrame(raf)
      highlights.delete('jump-search')
    }
  }, [flashIndex, flashQuery, nodeToItem, nodes])

  useEffect(() => {
    topIndexRef.current = 0
    setTopIndex(0)
    const frame = requestAnimationFrame(readTopIndex)
    return () => cancelAnimationFrame(frame)
  }, [nodes, readTopIndex])

  useEffect(() => {
    const scroller = parentRef.current
    if (!scroller) return
    let frame = 0
    let settle = 0
    const onScroll = (): void => {
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
    return <div className={m(bubbleStyles, 'transcript', 'transcript--empty')}>No renderable messages in this session.</div>
  }

  return (
    <div className={m(styles, 'sessionView', 'detail__body')}>
      <div className={bubbleStyles.transcript} ref={parentRef}>
        <div className={bubbleStyles['transcript__inner']} style={{ height: virt.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualItems.map((item) => {
            const display = displayItems[item.index]
            const openKey = `${blockOpenMode}`

            return (
              <div
                key={`${item.key}:${openKey}`}
                data-index={item.index}
                data-kind={display.kind === 'group' ? 'toolgroup' : display.node.kind}
                ref={virt.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${item.start}px)`
                }}
              >
                {display.kind === 'group' ? (
                  <ToolGroupBubble
                    nodes={display.nodes}
                    indexes={display.indexes}
                    searchQuery={searchQuery}
                    searchHitsByNode={searchHitsByNode}
                    activeMatch={activeMatch}
                    blockOpenMode={blockOpenMode}
                    forceOpen={
                      !!activeMatch && display.indexes.includes(activeMatch.nodeIndex)
                    }
                  />
                ) : (
                  <NodeBubble
                    node={display.node}
                    searchQuery={searchQuery}
                    hasSearchMatch={!!searchHitsByNode.get(display.nodeIndex)}
                    activeMatchOrdinal={
                      activeMatch?.nodeIndex === display.nodeIndex ? activeMatch.ordinalInNode : undefined
                    }
                    blockOpenMode={blockOpenMode}
                    showHead={display.showHead}
                  />
                )}
              </div>
            )
          })}
        </div>
      </div>

      {userEntries.length >= 5 && (
        <div
          className={styles.chatgptOutline}
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
            className={m(styles, 'chatgptOutline__panel', outlineOpen && 'chatgptOutline__panel--open')}
            ref={outlineRef}
            onMouseEnter={() => {
              if (outlineCloseTimer.current) clearTimeout(outlineCloseTimer.current)
            }}
            onMouseLeave={() => {
              outlineCloseTimer.current = setTimeout(() => setOutlineOpen(false), 200)
            }}
          >
            <div className={styles['chatgptOutline__header']}>User Messages ({userEntries.length})</div>
            <div className={styles['chatgptOutline__list']}>
              {userEntries.map((entry, ordinal) => (
                <button
                  key={entry.nodeIndex}
                  className={m(styles, 'chatgptOutline__item', entry.itemIndex === currentUserIndex && 'chatgptOutline__item--active')}
                  type="button"
                  data-user-index={entry.itemIndex}
                  onClick={() => jumpToItemIndex(entry.itemIndex)}
                >
                  <span className={styles['chatgptOutline__num']}>{ordinal + 1}</span>
                  <span className={styles['chatgptOutline__text']}>{entry.label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className={styles['chatgptOutline__bridge']} />
          <div className={styles['chatgptOutline__lines']}>
            {userEntries.slice(0, 12).map((_, i) => (
              <div key={i} className={styles['chatgptOutline__line']} />
            ))}
          </div>
        </div>
      )}

    </div>
  )
}
