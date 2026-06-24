import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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

// Row-height estimation for the virtualizer. The virtualizer only knows a row's
// true height once it has rendered it; for every off-screen row it relies on
// these estimates to place offsets and the scrollbar. A flat guess (the old
// `140`) is wildly wrong because ~80% of rows are collapsed one-line headers
// while a few prose rows are 1000px+ — so jumping to a late message landed at a
// bogus offset and scrolling back forced tens of thousands of px of reconciliation
// (the "rollback then crawl" lag). Instead we estimate per row from its content,
// using metrics probed from the live DOM so the numbers stay correct across
// theme/font/zoom changes. The estimate array is precomputed once per
// (nodes, metrics, blockOpenMode) and indexed in O(1) — the per-row text scan
// never runs inside the hot `estimateSize` path.
interface RowMetrics {
  /** Height of a collapsed block (single-line summary + bubble padding). */
  collapsedH: number
  /** Height of a user/assistant bubble with a single line of text. */
  proseBaseH: number
  /** Added height per extra wrapped line of prose. */
  proseLineH: number
  /** Approx. characters that fit on one prose line at the current width. */
  proseCPL: number
  /** Height per line of an expanded block's monospace body. */
  monoLineH: number
  /** Approx. characters per line in the monospace body. */
  monoCPL: number
}

const DEFAULT_ROW_METRICS: RowMetrics = {
  collapsedH: 53,
  proseBaseH: 62,
  proseLineH: 21,
  proseCPL: 90,
  monoLineH: 19,
  monoCPL: 110
}

// Mirror of `.transcript` horizontal padding (22+22) and `.bubble__text` /
// `.block__body` horizontal padding (14+14), and the `.block__body`
// `max-height` plus its border+padding chrome. Kept in sync with styles.css.
const TRANSCRIPT_PAD_X = 44
const BODY_PAD_X = 28
const MAX_EXPANDED_BODY = 420
const EXPANDED_BODY_CHROME = 25
const MAX_ESTIMATE_TEXT = 200_000

function isCollapsibleKind(kind: ViewNode['kind']): boolean {
  return kind !== 'user' && kind !== 'assistant'
}

/** Count wrapped display lines for `text` at `cpl` chars/line, capped for huge nodes. */
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

function estimateNodeHeight(node: ViewNode, m: RowMetrics, expanded: boolean): number {
  if (isCollapsibleKind(node.kind)) {
    if (!expanded) return m.collapsedH
    const body = Math.min(MAX_EXPANDED_BODY, wrappedLines(node.text, m.monoCPL) * m.monoLineH)
    return m.collapsedH + body + EXPANDED_BODY_CHROME
  }
  return m.proseBaseH + wrappedLines(node.text, m.proseCPL) * m.proseLineH
}

// Probe real heights/metrics from a hidden sample appended to the scroller, so
// estimates track the actual theme/font instead of hardcoded pixel guesses.
function measureRowMetrics(scroller: HTMLElement): RowMetrics {
  const innerW = Math.max(120, scroller.clientWidth - TRANSCRIPT_PAD_X)
  const probe = document.createElement('div')
  probe.style.cssText = `position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;width:${innerW}px;`
  probe.innerHTML =
    '<div class="bubble bubble--tool_call"><details class="block block--tool_call"><summary class="bubble__summary block__summary"><span class="block__tri"></span><span class="bubble__title block__title">probe</span><span class="bubble__size block__size">1 B</span></summary><pre class="bubble__pre block__body">x</pre></details></div>' +
    '<div class="bubble bubble--assistant"><div class="bubble__head"><span class="bubble__role">A</span></div><div class="bubble__text msg"><span class="msg--md"><p>x</p></span></div></div>' +
    '<div class="bubble bubble--assistant"><div class="bubble__head"><span class="bubble__role">A</span></div><div class="bubble__text msg"><span class="msg--md"><p>x<br>y</p></span></div></div>'
  scroller.appendChild(probe)
  try {
    const [collapsedEl, oneEl, twoEl] = Array.from(probe.children) as HTMLElement[]
    const collapsedH = Math.round(collapsedEl.getBoundingClientRect().height) || DEFAULT_ROW_METRICS.collapsedH
    const oneH = oneEl.getBoundingClientRect().height
    const twoH = twoEl.getBoundingClientRect().height
    const proseLineH = Math.max(14, Math.round(twoH - oneH)) || DEFAULT_ROW_METRICS.proseLineH
    const proseBaseH = Math.max(0, Math.round(oneH - proseLineH)) || DEFAULT_ROW_METRICS.proseBaseH
    const proseFont = parseFloat(getComputedStyle(oneEl.querySelector('.msg--md') as Element).fontSize) || 13.5
    const monoBody = collapsedEl.querySelector('.block__body') as Element
    const monoFont = parseFloat(getComputedStyle(monoBody).fontSize) || 12
    const monoLine = parseFloat(getComputedStyle(monoBody).lineHeight)
    const contentW = innerW - BODY_PAD_X
    return {
      collapsedH,
      proseBaseH,
      proseLineH,
      // Proportional fonts average ~0.5em/char, monospace ~0.6em.
      proseCPL: Math.max(20, Math.floor(contentW / (proseFont * 0.5))),
      monoLineH: Number.isFinite(monoLine) ? Math.round(monoLine) : Math.round(monoFont * 1.6),
      monoCPL: Math.max(20, Math.floor(contentW / (monoFont * 0.6)))
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
  const [rowMetrics, setRowMetrics] = useState<RowMetrics>(DEFAULT_ROW_METRICS)
  // Probe the live DOM for real row metrics on mount, on session change, and on
  // resize, so estimates track the actual theme/font/width rather than constants.
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

  // Precompute each row's estimated height once per (nodes, metrics, mode); the
  // hot `estimateSize` path is then an O(1) array lookup, never a text scan.
  const estimates = useMemo(() => {
    const expanded = blockOpenMode === 'expanded'
    return nodes.map((node) => estimateNodeHeight(node, rowMetrics, expanded))
  }, [nodes, rowMetrics, blockOpenMode])
  const estimateSize = useCallback(
    (index: number): number => estimates[index] ?? rowMetrics.proseBaseH,
    [estimates, rowMetrics.proseBaseH]
  )
  const virt = useVirtualizer({
    count: nodes.length,
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

  // Briefly highlight the matched text on the jumped-to node WITHOUT swapping its
  // rendered markdown for raw text — the CSS Custom Highlight API paints over the
  // live DOM via Ranges, so the node stays fully rendered the whole time.
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
    // The target node may be far from the current window, so it isn't in the DOM
    // until the jump scroll renders it. Poll across frames until it mounts, then
    // build the ranges, highlight, and pull the first match into view (a tall node
    // can be centered while the match itself sits off-screen).
    const attempt = (): void => {
      const root = parentRef.current?.querySelector(`[data-index="${flashIndex}"]`)
      const target = (root?.querySelector('.bubble__text') as Element | null) ?? root
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
      // Keep trying for ~0.6s while the virtualizer mounts/measures the node.
      if (tries++ < 36) raf = requestAnimationFrame(attempt)
    }
    raf = requestAnimationFrame(attempt)
    return () => {
      cancelAnimationFrame(raf)
      highlights.delete('jump-search')
    }
  }, [flashIndex, flashQuery, nodes])

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
            const activeOrdinal = activeMatch?.nodeIndex === item.index ? activeMatch.ordinalInNode : undefined

            // A collapsible block auto-opens when it has a search hit or when
            // block-open mode changes, growing in place. react-virtual only
            // measures via the ref callback on (re)mount and doesn't reliably
            // re-measure that in-place growth, so following rows overlap the
            // expanded block. Fold the open-affecting state into the React key
            // to force a remount — and thus a fresh measurement — on change.
            const openKey = `${hitOrdinals ? 'h' : ''}${blockOpenMode}`

            return (
              <div
                key={`${item.key}:${openKey}`}
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
